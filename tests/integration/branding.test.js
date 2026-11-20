// Logo, favicon and touch icon: where they appear, that they are versioned, and that the CSP did not change.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import request from 'supertest';
import { setupOwner, login, byName, estimateOf } from '../helpers/ownerApp.js';
import { buildAssets, IMMUTABLE } from '../../src/assets.js';

const PUBLIC = new URL('../../src/public/', import.meta.url).pathname;
async function world() {
  const ctx = setupOwner();
  return { ...ctx, o: await login(ctx.app) };
}
async function pages() {
  const ctx = await world();
  const rohan = byName(ctx.repos, 'Rohan Iyer');
  const html = {};
  for (const [name, p, owner] of [['home', '/', false], ['signup', '/signup', false], ['login', '/owner/login', false], ['enquire', '/b/mehfil-kitchen/enquire', false],
    ['quote', `/b/mehfil-kitchen/q/${estimateOf(ctx.repos, rohan).quoteToken}`, false], ['owner', '/owner', true], ['clients', '/owner/clients', true], ['setup', '/owner/setup', true]]) {
    const res = owner ? await ctx.o.get(p) : await request(ctx.app).get(p);
    assert.equal(res.status, 200, p);
    html[name] = res.text;
  }
  return { ctx, html };
}

test('every page links the SVG favicon, the Apple touch icon and the theme colour, through the asset-version helper', async () => {
  const { html } = await pages();
  for (const [name, text] of Object.entries(html)) {
    assert.match(text, /<link rel="icon" href="\/img\/favicon\.svg\?v=[0-9a-f]{10}" type="image\/svg\+xml">/, name);
    assert.match(text, /<link rel="apple-touch-icon" href="\/img\/apple-touch-icon\.png\?v=[0-9a-f]{10}">/, name);
    assert.match(text, /<meta name="theme-color" content="#3B2352">/, name);
  }
});

test('the logo files exist, are served with the right type, and are cached forever when versioned', async () => {
  const { ctx, html } = await pages();
  const assets = buildAssets(PUBLIC);
  for (const f of ['liaisa-logo.svg', 'liaisa-logo-white.svg', 'liaisa-mark.svg', 'favicon.svg', 'app-icon.svg', 'apple-touch-icon.png']) {
    assert.ok(assets.hashes.has(`/img/${f}`), `${f} is hashed with the other assets`);
    const bare = await request(ctx.app).get(`/img/${f}`);
    assert.equal(bare.status, 200, f);
    assert.match(bare.headers['content-type'], f.endsWith('.png') ? /image\/png/ : /image\/svg\+xml/);
    assert.equal(bare.headers['cache-control'], 'no-cache');
    assert.equal((await request(ctx.app).get(`/img/${f}?v=abc`)).headers['cache-control'], IMMUTABLE);
  }
  const png = fs.readFileSync(`${PUBLIC}img/apple-touch-icon.png`);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [180, 180], 'a 180 x 180 touch icon');
  // Links on the pages resolve to the exact versioned URL.
  const icon = /rel="icon" href="([^"]+)"/.exec(html.home)[1];
  assert.equal((await request(ctx.app).get(icon)).status, 200);
  const ico = await request(ctx.app).get('/favicon.ico');
  assert.equal(ico.status, 302);
  assert.match(ico.headers.location, /^\/img\/favicon\.svg\?v=[0-9a-f]{10}$/);
});

test('Liaisa’s own pages (landing, signup, login) show the logo, 32px high, alt "Liaisa", linking to /', async () => {
  const { html } = await pages();
  for (const name of ['home', 'signup', 'login']) {
    assert.match(html[name], /<header class="site-bar">[\s\S]*?<a class="brand brand--logo" href="\/"><img src="\/img\/liaisa-logo\.svg\?v=[0-9a-f]{10}" alt="Liaisa" width="85" height="32"><\/a>/, name);
  }
  const css = fs.readFileSync(`${PUBLIC}css/app.css`, 'utf8');
  assert.match(css, /\.brand--logo img \{ display: block; height: 32px; width: auto; \}/);
  // The logo SVG itself has the 297 x 112 shape the 85 x 32 size is taken from.
  assert.match(fs.readFileSync(`${PUBLIC}img/liaisa-logo.svg`, 'utf8'), /viewBox="0 0 297 112"/);
});

test('the owner area shows the mark with the Liaisa name in the sidebar and in the header on phones', async () => {
  const { html } = await pages();
  for (const name of ['owner', 'clients', 'setup']) {
    assert.match(html[name], /<aside class="sidebar"[^>]*>\s*<a class="brand brand--mark" href="\/owner"><img src="\/img\/liaisa-mark\.svg\?v=[0-9a-f]{10}" alt="" width="28" height="28"><span>Liaisa<\/span><\/a>\s*<p class="biz-name">Mehfil Kitchen<\/p>/, `${name}: sidebar`);
    assert.match(html[name], /<header class="owner-bar">\s*<a class="brand brand--mark" href="\/owner"><img src="\/img\/liaisa-mark\.svg\?v=[0-9a-f]{10}" alt="" width="28" height="28"><span>Liaisa<\/span><\/a>\s*<span class="owner-bar__biz">Mehfil Kitchen<\/span>/, `${name}: header`);
  }
  const css = fs.readFileSync(`${PUBLIC}css/app.css`, 'utf8');
  assert.match(css, /\.brand--mark img \{ display: block; width: 28px; height: 28px; \}/);
  assert.match(css, /@media \(min-width: 64rem\) \{ \.owner-bar \{ display: none; \} \}/, 'the header is for phones; desktop has the sidebar');
});

test('customer pages keep the business name in the bar, with "Powered by Liaisa" and the small mark', async () => {
  const { html } = await pages();
  for (const name of ['enquire', 'quote']) {
    assert.match(html[name], /<a class="brand" href="\/">Mehfil Kitchen<\/a>/, name);
    assert.ok(!html[name].includes('liaisa-logo.svg'), `${name}: the customer sees the business, not the Liaisa logo`);
    assert.match(html[name], /<footer class="powered"><img src="\/img\/liaisa-mark\.svg\?v=[0-9a-f]{10}" alt="" width="20" height="20"><span>Powered by Liaisa<\/span><\/footer>/, name);
  }
});

test('the CSP is unchanged by the logo: images only from our own host, no inline script or style', async () => {
  const { ctx, html } = await pages();
  const csp = (await request(ctx.app).get('/')).headers['content-security-policy'];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /img-src 'self' data:/);
  assert.match(csp, /script-src 'self'/);
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
  assert.ok(!/https?:\/\/(?!wa\.me|api\.whatsapp\.com|web\.whatsapp\.com)[^\s;]+/.test(csp), 'no new external hosts');
  for (const [name, text] of Object.entries(html)) {
    assert.ok(!/\sstyle="/.test(text), `${name}: inline style`);
    assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/.test(text), `${name}: inline script`);
    for (const m of text.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)) assert.ok(m[1].startsWith('/img/'), `${name}: ${m[1]}`);
  }
});
