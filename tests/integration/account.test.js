// Log out on every owner page: the phone Account tab and sheet, the desktop sidebar, and the Account page.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import request from 'supertest';
import { setupOwner, login, addBusiness, byName, OWNER_EMAIL } from '../helpers/ownerApp.js';

const css = fs.readFileSync(new URL('../../src/public/css/app.css', import.meta.url), 'utf8');
async function world() {
  const ctx = setupOwner();
  return { ...ctx, o: await login(ctx.app) };
}
const ownerPaths = (ctx) => ['/owner', `/owner/enquiries/${byName(ctx.repos, 'Kavita Reddy').id}`, '/owner/clients?tab=reconnect', '/owner/clients?tab=find', '/owner/follow-ups', '/owner/setup', '/owner/approve-clean', '/owner/account'];
const part = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)));

test('every owner page has the Account tab in the phone tab bar and a sheet with the business, the owner’s email, Setup and Log out', async () => {
  const ctx = await world();
  for (const path of ownerPaths(ctx)) {
    const res = await ctx.o.get(path);
    assert.equal(res.status, 200, path);
    const bar = part(res.text, '<nav class="tabbar"', '</nav>');
    assert.equal((bar.match(/<a href=/g) ?? []).length, 5, `${path}: four tabs and Account`);
    assert.match(bar, /<a href="\/owner\/account"[^>]*data-sheet="account-sheet" class="tab-account">\s*<img src="\/img\/liaisa-mark\.svg\?v=[0-9a-f]{10}" alt="" width="28" height="28"><span>Account<\/span>/, path);
    const sheet = part(res.text, '<dialog class="sheet-dialog" id="account-sheet"', '</dialog>');
    assert.match(sheet, /<strong>Mehfil Kitchen<\/strong>/, path);
    assert.ok(sheet.includes(OWNER_EMAIL), `${path}: the owner's email`);
    assert.match(sheet, /<a class="btn secondary" href="\/owner\/setup">Setup<\/a>/, path);
    assert.match(sheet, new RegExp(`<form method="post" action="/owner/logout">\\s*<input type="hidden" name="_csrf" value="${ctx.o.csrf}">\\s*<button class="btn danger" type="submit" data-no-busy>Log out</button>`), `${path}: Log out is a POST with the CSRF token`);
  }
  assert.match(css, /\.tabbar \{ grid-template-columns: repeat\(5, 1fr\); \}/);
});

test('the desktop sidebar shows the owner’s email and Log out as a POST with the CSRF token', async () => {
  const ctx = await world();
  for (const path of ownerPaths(ctx)) {
    const side = part((await ctx.o.get(path)).text, '<aside class="sidebar"', '</aside>');
    assert.ok(side.includes(`<p class="biz-name sidebar__email">${OWNER_EMAIL}</p>`), path);
    assert.match(side, new RegExp(`<form method="post" action="/owner/logout">\\s*<input type="hidden" name="_csrf" value="${ctx.o.csrf}">\\s*<button class="btn text" type="submit" data-no-busy>Log out</button>`), path);
  }
});

test('the Account page works without JavaScript (the tab is a real link) and has the same details', async () => {
  const ctx = await world();
  const page = await ctx.o.get('/owner/account');
  assert.match(page.text, /<h1>Account<\/h1>/);
  const card = part(page.text, '<div class="card account">', '</div>\n<dialog');
  assert.ok(card.includes('Mehfil Kitchen') && card.includes(OWNER_EMAIL));
  assert.match(card, /action="\/owner\/logout"/);
  assert.match(page.text, /<a href="\/owner\/account" aria-current="page" data-sheet="account-sheet" class="tab-account">/);
  assert.equal((await request(ctx.app).get('/owner/account')).status, 302, 'needs the owner login');
  const ui = fs.readFileSync(new URL('../../src/public/js/ui.js', import.meta.url), 'utf8');
  assert.match(ui, /\[data-sheet\]/, 'with scripts, the tab opens the sheet instead');
});

test('Log out works: it ends the session, needs the CSRF token, and is POST only', async () => {
  const ctx = await world();
  const noToken = await request(ctx.app).post('/owner/logout').set('Cookie', ctx.o.cookie).type('form').send({});
  assert.equal(noToken.status, 403);
  assert.equal((await ctx.o.get('/owner')).status, 200, 'still logged in after a refused logout');
  assert.equal((await ctx.o.get('/owner/logout')).status, 404, 'a GET (a link, a prefetch) cannot log anyone out');
  assert.equal((await ctx.o.get('/owner')).status, 200);
  // The token in the sheet is the one the session accepts.
  const page = await ctx.o.get('/owner/clients');
  const token = /id="account-sheet"[\s\S]*?name="_csrf" value="([^"]+)"/.exec(page.text)[1];
  const out = await request(ctx.app).post('/owner/logout').set('Cookie', ctx.o.cookie).type('form').send({ _csrf: token });
  assert.equal(out.status, 302);
  assert.equal(out.headers.location, '/owner/login');
  assert.match((out.headers['set-cookie'] ?? []).join(';'), /liaisa\.sid=;/);
  const after = await ctx.o.get('/owner');
  assert.equal(after.status, 302);
  assert.equal(after.headers.location, '/owner/login');
  assert.equal((await ctx.o.postJson('/owner/clients/leads', { name: 'X', contact: 'x@example.test', note: 'abc' })).status, 401, 'the old session is dead');
});

test('each owner sees their own business and email in the sheet', async () => {
  const ctx = await world();
  const other = addBusiness(ctx.registry, { name: 'Spice Route', email: 'owner@spiceroute.example' });
  const o2 = await login(ctx.app, { email: other.email, password: other.password });
  const sheet = part((await o2.get('/owner/clients')).text, '<dialog class="sheet-dialog" id="account-sheet"', '</dialog>');
  assert.match(sheet, /<strong>Spice Route<\/strong>/);
  assert.ok(sheet.includes('owner@spiceroute.example') && !sheet.includes(OWNER_EMAIL) && !sheet.includes('Mehfil Kitchen'));
});

test('the old page-level Log out button on Setup is gone (the Account tab replaces it) and nothing is inline', async () => {
  const ctx = await world();
  const setup = await ctx.o.get('/owner/setup');
  const outside = setup.text.replace(/<aside class="sidebar"[\s\S]*?<\/aside>/, '').replace(/<dialog class="sheet-dialog" id="account-sheet"[\s\S]*?<\/dialog>/, '');
  assert.ok(!outside.includes('>Log out<'), 'one place per surface: sidebar, sheet');
  for (const path of ownerPaths(ctx)) {
    const res = await ctx.o.get(path);
    assert.ok(!/\sstyle="/.test(res.text) && !/<script(?![^>]*\ssrc=)[^>]*>/.test(res.text), path);
  }
});
