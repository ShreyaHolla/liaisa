// Cache-busting for static assets, cache headers, trust proxy and the package pre-flight.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import request from 'supertest';
import { setupOwner, login, byName, estimateOf } from '../helpers/ownerApp.js';
import { buildAssets, IMMUTABLE, REVALIDATE } from '../../src/assets.js';
import { checkPublicAssets, listPublicFiles } from '../../scripts/lib/checkAssets.js';

const PUBLIC = new URL('../../src/public/', import.meta.url).pathname;
const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'liaisa-assets-'));
const links = (html) => [...html.matchAll(/<(?:link|script)\b[^>]*?\b(?:href|src)="([^"]+)"/g)].map((m) => m[1]);

async function pages() {
  const ctx = setupOwner();
  const o = await login(ctx.app);
  const rohan = byName(ctx.repos, 'Rohan Iyer');
  const token = estimateOf(ctx.repos, rohan).quoteToken;
  const kavita = byName(ctx.repos, 'Kavita Reddy');
  const html = {};
  for (const [name, p, owner] of [['home', '/', false], ['enquire', '/b/mehfil-kitchen/enquire', false], ['login', '/owner/login', false], ['quote', `/b/mehfil-kitchen/q/${token}`, false],
    ['owner', '/owner', true], ['enquiry', `/owner/enquiries/${kavita.id}`, true], ['setup', '/owner/setup', true], ['clients', '/owner/clients?tab=find', true]]) {
    const res = owner ? await o.get(p) : await request(ctx.app).get(p);
    assert.equal(res.status, 200, p);
    html[name] = res;
  }
  return { ctx, html };
}

test('the layout links the stylesheet with a version taken from the file content, and the file exists', async () => {
  const { ctx, html } = await pages();
  for (const [name, res] of Object.entries(html)) {
    const css = links(res.text).find((u) => u.startsWith('/css/'));
    assert.match(css, /^\/css\/app\.css\?v=[0-9a-f]{10}$/, name);
    assert.ok(fs.existsSync(path.join(PUBLIC, 'css', 'app.css')), 'the file it points to exists on disk');
    const served = await request(ctx.app).get(css);
    assert.equal(served.status, 200, css);
    assert.match(served.headers['content-type'], /text\/css/);
    // The version is the hash of what is served (the stylesheet with its font URLs versioned too).
    assert.equal(css.split('?v=')[1], hash(served.text), `${name}: the version matches the served bytes`);
    assert.ok(served.text.includes('@font-face') && served.text.includes('--plum'));
  }
});

test('every script and font link carries a version, resolves, and matches its file', async () => {
  const { ctx, html } = await pages();
  const seen = new Set();
  for (const res of Object.values(html)) for (const u of links(res.text)) seen.add(u);
  const assets = [...seen].filter((u) => /^\/(?:css|js|fonts)\//.test(u));
  assert.ok(assets.length >= 8, 'css, fonts and the scripts are all linked');
  for (const u of assets) {
    const [p, v] = u.split('?v=');
    assert.match(v ?? '', /^[0-9a-f]{10}$/, `${u} has a version`);
    const res = await request(ctx.app).get(u);
    assert.equal(res.status, 200, u);
    if (!p.endsWith('.css')) assert.equal(v, hash(fs.readFileSync(path.join(PUBLIC, p))), `${u} is the hash of the file on disk`);
  }
  assert.ok(assets.some((u) => u.startsWith('/js/ui.js')) && assets.some((u) => u.startsWith('/js/briefing.js')) && assets.some((u) => u.startsWith('/fonts/figtree-400.woff2')));
});

test('the fonts inside the stylesheet are versioned too, so a changed font changes the stylesheet', async () => {
  const { ctx } = await pages();
  const css = (await request(ctx.app).get('/css/app.css')).text;
  const urls = [...css.matchAll(/url\('(\/fonts\/[^']+)'\)/g)].map((m) => m[1]);
  assert.equal(urls.length, 4);
  for (const u of urls) {
    const [p, v] = u.split('?v=');
    assert.equal(v, hash(fs.readFileSync(path.join(PUBLIC, p))), u);
    assert.ok(fs.existsSync(path.join(PUBLIC, p)));
    assert.equal((await request(ctx.app).get(u)).status, 200);
  }
  // The preloaded font is the same URL the stylesheet asks for, so the preload is reused.
  const { html } = await pages();
  const preload = /<link rel="preload" href="([^"]+)"/.exec(html.home.text)[1];
  assert.ok(urls.includes(preload), 'preload and @font-face use the same versioned URL');
});

test('asset URLs are relative paths: never absolute, and never built from the request host or protocol', async () => {
  const { ctx, html } = await pages();
  for (const [name, res] of Object.entries(html)) {
    for (const u of links(res.text)) {
      assert.ok(u.startsWith('/') && !u.startsWith('//') && !u.includes('://'), `${name}: ${u}`);
    }
    assert.ok(!/(?:href|src)="https?:\/\/[^"]*\.(?:css|js|woff2)/i.test(res.text), `${name}: absolute asset URL`);
  }
  const css = (await request(ctx.app).get('/css/app.css')).text;
  assert.ok(!/url\(['"]?https?:/.test(css) && !/@import/.test(css), 'no absolute URLs inside the stylesheet');
  // Spoofed Host and forwarding headers change nothing.
  const plain = await request(ctx.app).get('/');
  const spoof = await request(ctx.app).get('/').set('Host', 'evil.example').set('X-Forwarded-Host', 'evil.example').set('X-Forwarded-Proto', 'http');
  assert.deepEqual(links(spoof.text), links(plain.text));
  assert.ok(!spoof.text.includes('evil.example'));
  const src = fs.readFileSync(new URL('../../src/assets.js', import.meta.url), 'utf8') + fs.readFileSync(new URL('../../src/app.js', import.meta.url), 'utf8');
  assert.ok(!/req\.(?:protocol|hostname|host|get\('host'\))/.test(src), 'nothing is built from req.protocol or the host');
});

test('static cache headers: immutable for a year with ?v=, revalidate without it; a missing file is never cached as immutable', async () => {
  const { ctx, html } = await pages();
  const urls = links(html.home.text).filter((u) => /^\/(?:css|js|fonts)\//.test(u));
  for (const u of urls) {
    const versioned = await request(ctx.app).get(u);
    assert.equal(versioned.headers['cache-control'], 'public, max-age=31536000, immutable', u);
    assert.equal(versioned.headers['cache-control'], IMMUTABLE);
    const bare = await request(ctx.app).get(u.split('?')[0]);
    assert.equal(bare.status, 200, `${u} without a version still works`);
    assert.equal(bare.headers['cache-control'], 'no-cache', `${u} without ?v=`);
    assert.equal(bare.headers['cache-control'], REVALIDATE);
    assert.ok(bare.headers.etag, 'revalidation is cheap: there is an ETag');
  }
  const stale = await request(ctx.app).get('/js/ui.js?v=oldversion');
  assert.equal(stale.headers['cache-control'], IMMUTABLE, 'any version string is treated as a versioned URL');
  const missing = await request(ctx.app).get('/js/nope.js?v=abc');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers['cache-control'], 'no-cache', 'a 404 is not cached as immutable');
  assert.equal((await request(ctx.app).get('/css/missing.css?v=abc')).headers['cache-control'], 'no-cache');
});

test('HTML responses are no-cache; the owner area (login included) and quote pages keep the stricter no-store', async () => {
  const { html } = await pages();
  for (const name of ['home', 'enquire']) assert.equal(html[name].headers['cache-control'], 'no-cache', name);
  for (const name of ['login', 'quote', 'owner', 'enquiry', 'setup', 'clients']) assert.match(html[name].headers['cache-control'], /no-store/, name);
  assert.match(html.home.headers['content-type'], /text\/html/);
});

test('trust proxy is on (one hop), so client IPs and https come from the host’s proxy', async () => {
  const { ctx } = await pages();
  assert.equal(ctx.app.get('trust proxy'), 1);
  assert.match(fs.readFileSync(new URL('../../src/app.js', import.meta.url), 'utf8'), /app\.set\('trust proxy', 1\)/);
});

test('no view hard-codes an asset path: they all go through the asset helper', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(new URL('../../src/views', import.meta.url).pathname)) {
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!/(?:href|src)="\/(?:css|js|fonts)\//.test(text), `${f} links an asset without a version`);
  }
});

// ---- The hashing itself ------------------------------------------------------------------------

test('buildAssets: the hash follows the content, the CSS carries its fonts’ hashes, unknown files are left alone', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'css')); fs.mkdirSync(path.join(dir, 'fonts')); fs.mkdirSync(path.join(dir, 'js'));
  fs.writeFileSync(path.join(dir, 'fonts', 'a.woff2'), 'font-v1');
  fs.writeFileSync(path.join(dir, 'js', 'x.js'), 'console.log(1)');
  const css = (extra = '') => `@font-face { src: url('/fonts/a.woff2') format('woff2'); } body { color: red; }${extra}`;
  fs.writeFileSync(path.join(dir, 'css', 'app.css'), css());
  const one = buildAssets(dir);
  assert.match(one.asset('/css/app.css'), /^\/css\/app\.css\?v=[0-9a-f]{10}$/);
  assert.equal(one.asset('/nothing.css'), '/nothing.css');
  assert.ok(one.css.get('/css/app.css').includes(`url('/fonts/a.woff2?v=${one.hashes.get('/fonts/a.woff2')}')`));
  assert.equal(buildAssets(dir).asset('/css/app.css'), one.asset('/css/app.css'), 'same content, same URL');
  // Change the CSS: its version changes. Change only the font: the CSS version changes too.
  fs.writeFileSync(path.join(dir, 'css', 'app.css'), css(' a { color: blue; }'));
  const two = buildAssets(dir);
  assert.notEqual(two.asset('/css/app.css'), one.asset('/css/app.css'));
  fs.writeFileSync(path.join(dir, 'css', 'app.css'), css());
  fs.writeFileSync(path.join(dir, 'fonts', 'a.woff2'), 'font-v2');
  const three = buildAssets(dir);
  assert.notEqual(three.asset('/fonts/a.woff2'), one.asset('/fonts/a.woff2'));
  assert.notEqual(three.asset('/css/app.css'), one.asset('/css/app.css'), 'a new font means a new stylesheet URL');
  assert.equal(three.asset('/js/x.js'), one.asset('/js/x.js'), 'untouched files keep their URL');
  assert.deepEqual(three.files, ['/css/app.css', '/fonts/a.woff2', '/js/x.js']);
});

// ---- npm run package ---------------------------------------------------------------------------

test('package pre-flight: lists the files under src/public and fails without the stylesheet or a font', () => {
  const real = checkPublicAssets(PUBLIC);
  assert.ok(real.some((f) => f.rel === 'css/app.css') && real.some((f) => f.rel.endsWith('.woff2')));
  assert.deepEqual(real.map((f) => f.rel), listPublicFiles(PUBLIC).map((f) => f.rel));

  const dir = tmp();
  assert.throws(() => checkPublicAssets(dir), /Missing or empty css\/app\.css/);
  fs.mkdirSync(path.join(dir, 'css'));
  fs.writeFileSync(path.join(dir, 'css', 'app.css'), '');
  assert.throws(() => checkPublicAssets(dir), /Missing or empty css\/app\.css/, 'an empty stylesheet counts as missing');
  fs.writeFileSync(path.join(dir, 'css', 'app.css'), 'body{}');
  assert.throws(() => checkPublicAssets(dir), /No \.woff2 font file/);
  fs.mkdirSync(path.join(dir, 'fonts'));
  fs.writeFileSync(path.join(dir, 'fonts', 'notes.txt'), 'x');
  assert.throws(() => checkPublicAssets(dir), /No \.woff2 font file/, 'only a .woff2 counts');
  fs.writeFileSync(path.join(dir, 'fonts', 'f.woff2'), 'x');
  assert.deepEqual(checkPublicAssets(dir).map((f) => f.rel), ['css/app.css', 'fonts/f.woff2', 'fonts/notes.txt']);
});

test('`node scripts/package.js --check` prints the files and exits 0; with no stylesheet or font it exits 1 and builds nothing', () => {
  const script = new URL('../../scripts/package.js', import.meta.url).pathname;
  const out = execFileSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
  assert.match(out, /Files under src\/public included \(\d+\):/);
  assert.match(out, /css\/app\.css \(\d+ bytes\)/);
  assert.match(out, /fonts\/figtree-400\.woff2/);
  assert.match(out, /js\/ui\.js/);

  const empty = tmp();
  fs.mkdirSync(path.join(empty, 'src', 'public', 'js'), { recursive: true });
  fs.writeFileSync(path.join(empty, 'src', 'public', 'js', 'x.js'), 'x');
  const bad = spawnSync(process.execPath, [script, '--check'], { cwd: empty, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Package aborted: Missing or empty css\/app\.css/);
  assert.equal(fs.readdirSync(empty).filter((f) => f.endsWith('.zip')).length, 0, 'no zip is built');

  fs.mkdirSync(path.join(empty, 'src', 'public', 'css'));
  fs.writeFileSync(path.join(empty, 'src', 'public', 'css', 'app.css'), 'body{}');
  const noFont = spawnSync(process.execPath, [script, '--check'], { cwd: empty, encoding: 'utf8' });
  assert.equal(noFont.status, 1);
  assert.match(noFont.stderr, /No \.woff2 font file/);
});
