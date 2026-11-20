import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';

const PASSWORD = 'correct horse battery';
const HASH = bcrypt.hashSync(PASSWORD, 4); // low cost: tests only
const SECRET = 'x'.repeat(48);
const owner = { OWNER_PASSWORD_HASH: HASH, SESSION_SECRET: SECRET };

// Fresh app (fresh session store and rate-limit counter) per test.
const appFor = (env = {}) => createApp(loadConfig({ NODE_ENV: 'test', ...owner, ...env }));

const cookieOf = (res) => /liaisa\.sid=[^;]+/.exec((res.headers['set-cookie'] ?? []).join(';'))?.[0];
const tokenOf = (res) => /name="_csrf" value="([^"]+)"/.exec(res.text)?.[1];

/** Open the login page, then POST the form. Returns the login page cookie/token and the POST response. */
async function attemptLogin(app, password, extra = {}) {
  const page = await request(app).get('/owner/login').set(extra);
  const cookie = cookieOf(page);
  const res = await request(app).post('/owner/login').set({ Cookie: cookie, ...extra })
    .type('form').send({ _csrf: tokenOf(page), password });
  return { page, cookie, res };
}

async function loggedIn(app) {
  const { res } = await attemptLogin(app, PASSWORD);
  assert.equal(res.status, 302);
  const cookie = cookieOf(res);
  const home = await request(app).get('/owner').set('Cookie', cookie);
  assert.equal(home.status, 200);
  return { cookie, csrf: tokenOf(home), home };
}

test('TC-DSH-01 any /owner/* route without a session: 302 to login (401 for JSON)', async () => {
  const app = appFor();
  for (const [method, path] of [['get', '/owner'], ['get', '/owner/enquiries/1'], ['post', '/owner/logout'], ['post', '/owner/enquiries/1/approve']]) {
    const res = await request(app)[method](path);
    assert.equal(res.status, 302, `${method} ${path}`);
    assert.equal(res.headers.location, '/owner/login');
  }
  const json = await request(app).get('/owner').set('Accept', 'application/json');
  assert.equal(json.status, 401);
  assert.equal(json.body.error.code, 'unauthenticated');
});

test('TC-DSH-02 wrong password: error, no session; the 6th try in 15 minutes is 429', async () => {
  const app = appFor();
  const { cookie, res } = await attemptLogin(app, 'not the password');
  assert.equal(res.status, 401);
  assert.match(res.text, /That password doesn&#39;t match\. Try again\./);
  const after = await request(app).get('/owner').set('Cookie', cookie);
  assert.equal(after.status, 302);

  for (let i = 0; i < 4; i += 1) assert.equal((await attemptLogin(app, 'nope')).res.status, 401);
  const sixth = await attemptLogin(app, PASSWORD); // even the right password is refused now
  assert.equal(sixth.res.status, 429);
  assert.ok(Number(sixth.res.headers['retry-after']) > 0);
  assert.match(sixth.res.text, /Too many tries\. Wait 15 minutes, then try again\./);
});

test('TC-DSH-02 a successful login does not use up the 5 tries', async () => {
  const app = appFor();
  for (let i = 0; i < 6; i += 1) assert.equal((await attemptLogin(app, PASSWORD)).res.status, 302);
});

test('TC-DSH-02 empty password is a 400, not a failed attempt against the hash', async () => {
  const app = appFor();
  const { res } = await attemptLogin(app, '');
  assert.equal(res.status, 400);
});

test('TC-DSH-03 login rotates the session ID; cookie is HttpOnly + SameSite=Lax', async () => {
  const app = appFor();
  const { cookie: before, res } = await attemptLogin(app, PASSWORD);
  const after = cookieOf(res);
  assert.ok(before && after);
  assert.notEqual(after, before);
  const raw = res.headers['set-cookie'].find((c) => c.startsWith('liaisa.sid='));
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Lax/);
  assert.doesNotMatch(raw, /Secure/); // not production
  // The old (pre-login) session ID no longer grants access.
  assert.equal((await request(app).get('/owner').set('Cookie', before)).status, 302);
});

test('TC-DSH-03 in production the cookie is also Secure', async () => {
  const app = appFor({ NODE_ENV: 'production' });
  const { res } = await attemptLogin(app, PASSWORD, { 'X-Forwarded-Proto': 'https' });
  assert.equal(res.status, 302);
  const raw = res.headers['set-cookie'].find((c) => c.startsWith('liaisa.sid='));
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /Secure/);
  assert.match(raw, /SameSite=Lax/);
});

test('TC-DSH-04 owner POSTs without a valid CSRF token: 403', async () => {
  const app = appFor();
  // Login form itself
  const page = await request(app).get('/owner/login');
  const noToken = await request(app).post('/owner/login').set('Cookie', cookieOf(page)).type('form').send({ password: PASSWORD });
  assert.equal(noToken.status, 403);
  const badToken = await request(app).post('/owner/login').set('Cookie', cookieOf(page)).type('form').send({ _csrf: 'forged', password: PASSWORD });
  assert.equal(badToken.status, 403);

  // Logged-in owner
  const { cookie, csrf } = await loggedIn(app);
  assert.equal((await request(app).post('/owner/logout').set('Cookie', cookie)).status, 403);
  assert.equal((await request(app).post('/owner/logout').set('Cookie', cookie).type('form').send({ _csrf: 'forged' })).status, 403);
  const json = await request(app).post('/owner/logout').set({ Cookie: cookie, Accept: 'application/json' });
  assert.equal(json.status, 403);
  assert.equal(json.body.error.code, 'csrf_failed');
  // Still logged in after the refusals
  assert.equal((await request(app).get('/owner').set('Cookie', cookie)).status, 200);

  // Valid token, as a form field or as a header, works
  const ok = await request(app).post('/owner/logout').set('Cookie', cookie).set('X-CSRF-Token', csrf);
  assert.equal(ok.status, 302);
  assert.equal((await request(app).get('/owner').set('Cookie', cookie)).status, 302);
});

test('logged-in /owner is the bare page with the business name; logout form carries the token', async () => {
  const app = appFor();
  const { home, csrf } = await loggedIn(app);
  assert.match(home.text, /Mehfil Kitchen/);
  assert.ok(csrf && csrf.length >= 32);
  assert.equal(home.headers['cache-control'], 'no-store');
});

test('without OWNER_PASSWORD_HASH and SESSION_SECRET every /owner/* path is 503', async () => {
  const app = createApp(loadConfig({ NODE_ENV: 'test' }));
  for (const path of ['/owner', '/owner/login', '/owner/anything']) {
    const res = await request(app).get(path);
    assert.equal(res.status, 503);
    assert.equal(res.text, "Owner area isn't set up yet.");
  }
  assert.equal((await request(app).post('/owner/login').type('form').send({ password: 'x' })).status, 503);
});

test('OWNER_PASSWORD_HASH_B64 wins outright: a garbage OWNER_PASSWORD_HASH next to it is ignored and login uses the decoded hash', async () => {
  const b64 = Buffer.from(HASH).toString('base64');
  const app = appFor({ OWNER_PASSWORD_HASH: 'garbage-not-a-hash', OWNER_PASSWORD_HASH_B64: b64 });
  const ok = await attemptLogin(app, PASSWORD);
  assert.equal(ok.res.status, 302);
  assert.equal(ok.res.headers.location, '/owner');
  const bad = await attemptLogin(appFor({ OWNER_PASSWORD_HASH: 'garbage-not-a-hash', OWNER_PASSWORD_HASH_B64: b64 }), 'wrong password');
  assert.equal(bad.res.status, 401);
  // A different valid hash in the plain variable is not used either.
  const other = bcrypt.hashSync('some other password', 4);
  const app2 = appFor({ OWNER_PASSWORD_HASH: other, OWNER_PASSWORD_HASH_B64: b64 });
  assert.equal((await attemptLogin(app2, PASSWORD)).res.status, 302);
  assert.equal((await attemptLogin(appFor({ OWNER_PASSWORD_HASH: other, OWNER_PASSWORD_HASH_B64: b64 }), 'some other password')).res.status, 401);
});
