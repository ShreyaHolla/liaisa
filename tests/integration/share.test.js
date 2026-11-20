// "Share your enquiry link": URL from BASE_URL, QR generated here as inline SVG, WhatsApp link, copy script, escaping.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import request from 'supertest';
import QRCode from 'qrcode';
import bcrypt from 'bcryptjs';
import { setupOwner, login } from '../helpers/ownerApp.js';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createRepos } from '../../src/container.js';
import { seed } from '../../src/seed.js';
import { createMockClient } from '../../src/ai/mockClient.js';
import { createEnquiryStore } from '../../src/db/repos/enquiries.js';
import { createContactMessageStore } from '../../src/db/repos/contactMessages.js';
import { qrSvg, enquiryUrl, waShareLink } from '../../src/services/share.js';

const URL_OK = 'https://liaisa.co.in/b/mehfil-kitchen/enquire';
const WA_OK = `https://wa.me/?text=${encodeURIComponent(`Tell us about your event and get a quote: ${URL_OK}`)}`;
async function world(env = {}) {
  const ctx = setupOwner({ env });
  return { ...ctx, o: await login(ctx.app) };
}
/** An app with no enquiries at all (seeded business and prices, empty enquiry store). */
async function emptyWorld() {
  const hash = bcrypt.hashSync('correct horse battery', 4);
  const config = loadConfig({ NODE_ENV: 'test', OWNER_PASSWORD_HASH: hash, SESSION_SECRET: 'x'.repeat(48), BASE_URL: 'https://liaisa.co.in' });
  const repos = createRepos();
  seed(repos);
  repos.enquiries = createEnquiryStore();
  const app = createApp(config, { contacts: createContactMessageStore(), repos, mailer: null, ai: createMockClient() });
  const page = await request(app).get('/owner/login');
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)[1];
  const cookie = /liaisa\.sid=[^;]+/.exec((page.headers['set-cookie'] ?? []).join(';'))[0];
  const res = await request(app).post('/owner/login').set('Cookie', cookie).type('form').send({ _csrf: csrf, email: 'owner@mehfilkitchen.example', password: 'correct horse battery' });
  const cookie2 = /liaisa\.sid=[^;]+/.exec((res.headers['set-cookie'] ?? []).join(';'))[0];
  return { app, get: (p) => request(app).get(p).set('Cookie', cookie2) };
}

test('the card shows on Approvals and at the top of Setup, with the link built from BASE_URL', async () => {
  const ctx = await world();
  for (const path of ['/owner', '/owner/setup']) {
    const page = await ctx.o.get(path);
    assert.match(page.text, /<h2 id="share-h">Share your enquiry link<\/h2>/, path);
    assert.match(page.text, new RegExp(`<input id="share-url" class="share__url" type="text" readonly value="${URL_OK.replace(/\//g, '\\/')}">`), path);
    assert.match(page.text, /<button class="btn" type="button" data-copy="share-url">Copy link<\/button>/);
    assert.match(page.text, /<script src="\/js\/share\.js\?v=[0-9a-f]{10}" defer><\/script>/);
  }
  const setup = await ctx.o.get('/owner/setup');
  assert.ok(setup.text.indexOf('Share your enquiry link') < setup.text.indexOf('Your business'), 'it is at the top of Setup');
  assert.equal(enquiryUrl({ baseUrl: 'https://liaisa.co.in/' }, 'mehfil-kitchen'), URL_OK, 'a trailing slash is not doubled');
});

test('Share on WhatsApp is a wa.me link with the message and the link', async () => {
  const ctx = await world();
  const page = await ctx.o.get('/owner');
  const href = /<a class="btn secondary" href="([^"]+)" target="_blank" rel="noopener noreferrer">Share on WhatsApp<\/a>/.exec(page.text)[1];
  assert.equal(href.replace(/&amp;/g, '&'), WA_OK);
  assert.equal(decodeURIComponent(href.split('?text=')[1]), `Tell us about your event and get a quote: ${URL_OK}`);
  assert.equal(waShareLink(URL_OK), WA_OK);
});

test('the QR is generated here as inline SVG and encodes exactly the enquiry link; no external service', async () => {
  const ctx = await world();
  const page = await ctx.o.get('/owner');
  const svg = /<div class="qr" role="img" aria-label="[^"]*">(<svg[\s\S]*?<\/svg>)\s*<\/div>/.exec(page.text)[1];
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+"/);
  assert.ok((svg.match(/<path/g) ?? []).length >= 2);
  assert.equal(svg.trim(), (await qrSvg(URL_OK)).trim(), 'the embedded SVG is the generated one for this URL');
  assert.equal(QRCode.create(URL_OK).segments.map((s) => Buffer.from(s.data).toString('utf8')).join(''), URL_OK, 'the QR data is the link');
  assert.notEqual(await qrSvg('https://other.example/enquire'), svg, 'a different link gives a different code');
  assert.ok(!/<script|style=|href=|xlink|<image|onload/i.test(svg), 'plain shapes only');
  assert.ok(!/<img[^>]*(qr|chart\.googleapis|api\.qrserver)/i.test(page.text), 'no image from another site');
  assert.match(page.text, /aria-label="QR code for https:\/\/liaisa\.co\.in\/b\/mehfil-kitchen\/enquire"/);
});

test('Download QR is a plain link to an SVG file made by the server; it needs the owner login', async () => {
  const ctx = await world();
  const page = await ctx.o.get('/owner');
  assert.match(page.text, /<a class="btn secondary" href="\/owner\/enquiry-qr\.svg" download="enquiry-qr\.svg">Download QR<\/a>/);
  const asText = (res, cb) => { let d = ''; res.setEncoding('utf8'); res.on('data', (c) => { d += c; }); res.on('end', () => cb(null, d)); };
  const file = await request(ctx.app).get('/owner/enquiry-qr.svg').set('Cookie', ctx.o.cookie).buffer(true).parse(asText);
  file.text = file.body;
  assert.equal(file.status, 200);
  assert.match(file.headers['content-type'], /^image\/svg\+xml/);
  assert.match(file.headers['content-disposition'], /^attachment; filename="enquiry-qr\.svg"$/);
  assert.match(file.text, /^<svg width="512" height="512" xmlns=/);
  assert.ok(!/<script/i.test(file.text));
  assert.equal(file.text.replace('<svg width="512" height="512" ', '<svg '), await qrSvg(URL_OK));
  const anon = await request(ctx.app).get('/owner/enquiry-qr.svg');
  assert.equal(anon.status, 302);
});

test('with no enquiries the card is prominent and says what to do; with enquiries it is the quieter card', async () => {
  const empty = await emptyWorld();
  const page = await empty.get('/owner');
  assert.match(page.text, /<section class="card share share--hero"/);
  assert.match(page.text, /No enquiries yet\. Share your link to get the first one\./);
  assert.ok(page.text.indexOf('share--hero') < page.text.indexOf('Waiting for you'), 'it comes first');
  assert.match((await empty.get('/owner/setup')).text, /share--hero/);

  const ctx = await world();
  const busy = await ctx.o.get('/owner');
  assert.match(busy.text, /<section class="card share" /);
  assert.ok(!busy.text.includes('share--hero'));
  assert.ok(!busy.text.includes('Share your link to get the first one'));
  assert.match(busy.text, /Customers use this link to tell you what they need and get a quote\./);
});

test('output is escaped: a BASE_URL with quotes, angle brackets and ampersands cannot break out of the page', async () => {
  const nasty = 'https://shop.example/?a=1&b=<img src=x onerror=alert(1)>"\'';
  const ctx = await world({ BASE_URL: nasty });
  for (const path of ['/owner', '/owner/setup']) {
    const page = await ctx.o.get(path);
    assert.equal(page.status, 200, path);
    assert.ok(!page.text.includes('<img src=x onerror'), `${path}: raw tag`);
    assert.ok(!/value="https:\/\/shop\.example\/\?a=1&b=/.test(page.text), `${path}: raw ampersand and quote in the value`);
    assert.match(page.text, /value="https:\/\/shop\.example\/\?a=1&amp;b=&lt;img src=x onerror=alert\(1\)&gt;&#34;&#39;\/b\/mehfil-kitchen\/enquire"/, path);
    assert.match(page.text, /aria-label="QR code for https:\/\/shop\.example\/\?a=1&amp;b=&lt;img/, path);
  }
  const href = /<a class="btn secondary" href="([^"]+)" target="_blank"/.exec((await ctx.o.get('/owner')).text)[1];
  assert.ok(!/[<>"']/.test(href.replace(/&amp;/g, '&')), 'the share link is URL-encoded');
});

test('a link too long for a QR code still shows the card, just without the code', async () => {
  const ctx = await world({ BASE_URL: `https://long.example/${'a'.repeat(4000)}` });
  const page = await ctx.o.get('/owner');
  assert.equal(page.status, 200);
  assert.match(page.text, /Share your enquiry link/);
  assert.ok(!page.text.includes('class="qr"'));
  assert.ok(!page.text.includes('Download QR'));
  assert.equal((await ctx.o.get('/owner/enquiry-qr.svg')).status, 404);
});

test('nothing inline: the card adds no inline script or style, and the CSP still allows only our own scripts', async () => {
  const ctx = await world();
  for (const path of ['/owner', '/owner/setup']) {
    const page = await ctx.o.get(path);
    assert.ok(!/\sstyle="/.test(page.text), path);
    assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/.test(page.text), path);
    assert.match(page.headers['content-security-policy'], /script-src 'self'/);
    assert.ok(!/script-src[^;]*unsafe-inline/.test(page.headers['content-security-policy']));
  }
  assert.equal((await request(ctx.app).get('/js/share.js')).status, 200);
});

// ---- The copy script ---------------------------------------------------------------------------

const shareSource = fs.readFileSync(new URL('../../src/public/js/share.js', import.meta.url), 'utf8');
function fakePage({ clipboard, execCommand }) {
  const input = { value: URL_OK, calls: [], focus() { this.calls.push('focus'); }, select() { this.calls.push('select'); }, setSelectionRange() { this.calls.push('range'); } };
  const status = { hidden: true, textContent: '' };
  let click;
  const button = { getAttribute: () => 'share-url', addEventListener: (t, f) => { click = f; } };
  const doc = {
    querySelectorAll: () => [button], getElementById: () => input, querySelector: () => status,
    execCommand: execCommand ?? (() => false),
  };
  const win = { document: doc, navigator: clipboard === undefined ? {} : { clipboard } };
  vm.runInNewContext(shareSource, { window: win });
  return { input, status, click: () => click() };
}

test('Copy uses navigator.clipboard when it is there', async () => {
  const written = [];
  const page = fakePage({ clipboard: { writeText: (t) => { written.push(t); return Promise.resolve(); } } });
  page.click();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(written, [URL_OK]);
  assert.deepEqual([page.status.hidden, page.status.textContent], [false, 'Link copied.']);
});

test('Copy falls back to selecting the text when there is no clipboard API, or it refuses', async () => {
  const exec = [];
  const none = fakePage({ clipboard: undefined, execCommand: (c) => { exec.push(c); return true; } });
  none.click();
  assert.deepEqual(none.input.calls, ['focus', 'select', 'range']);
  assert.deepEqual(exec, ['copy']);
  assert.equal(none.status.textContent, 'Link copied.');

  const refused = fakePage({ clipboard: { writeText: () => Promise.reject(new Error('denied')) }, execCommand: () => false });
  refused.click();
  await new Promise((r) => setImmediate(r));
  assert.ok(refused.input.calls.includes('select'), 'the text is selected so the owner can copy it by hand');
  assert.match(refused.status.textContent, /The link is selected\. Press Ctrl\+C/);
  assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon/.test(shareSource), 'nothing is sent anywhere');
});
