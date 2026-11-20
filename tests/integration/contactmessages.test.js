// Contact form: the message is always saved first, email is best effort, the owner sees every message.
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createRegistry } from '../../src/db/registry.js';
import { submitContact } from '../../src/services/contact/submitContact.js';
import { createContactMessageStore } from '../../src/db/repos/contactMessages.js';
import { setupOwner, login, addBusiness, MAIL_FROM, OWNER_EMAIL } from '../helpers/ownerApp.js';

const valid = { name: 'Asha Rao', email: 'asha@example.test', message: 'Do you cater for 40 people? Call me on 98450 12345.' };
const failing = (code = 'EAUTH') => ({
  sent: [],
  send: async () => { throw Object.assign(new Error('535 5.7.8 Error: authentication failed for asha@example.test: secret-pass'), { code, command: 'AUTH PLAIN' }); },
});
const msgs = (ctx) => ctx.repos.contactMessages.all();

test('success path: saved, emailed, statused accepted, customer sees the thanks text', async () => {
  const ctx = setupOwner();
  const res = await request(ctx.app).post('/api/contact').send(valid);
  assert.deepEqual([res.status, res.body], [200, { ok: true }]);
  assert.equal(msgs(ctx).length, 1);
  assert.equal(msgs(ctx)[0].emailStatus, 'accepted');
  assert.equal(ctx.mailer.sent.length, 1);
  const page = await request(ctx.app).get('/?contact=sent');
  assert.match(page.text, /Thanks, we got your message/);
});

test('validation errors: 400 with field messages and nothing saved or sent', async () => {
  const ctx = setupOwner();
  const res = await request(ctx.app).post('/api/contact').send({ name: '', email: 'nope', message: '' });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.fields.email && res.body.error.fields.name);
  assert.equal(msgs(ctx).length, 0);
  assert.equal(ctx.mailer.sent.length, 0);
  const html = await request(ctx.app).post('/api/contact').set('Accept', 'text/html').type('form').send({ name: '', email: 'x', message: '' });
  assert.equal(html.headers.location, '/?contact=error#contact');
});

test('honeypot: looks successful, saves and sends nothing', async () => {
  const ctx = setupOwner();
  const res = await request(ctx.app).post('/api/contact').send({ ...valid, website: 'http://spam.example' });
  assert.deepEqual([res.status, res.body], [200, { ok: true }]);
  assert.equal(msgs(ctx).length, 0);
  assert.equal(ctx.mailer.sent.length, 0);
});

test('rate limit: the sixth message in an hour gets a 429 and is not saved', async () => {
  const ctx = setupOwner();
  for (let i = 0; i < 5; i++) assert.equal((await request(ctx.app).post('/api/contact').send(valid)).status, 200);
  const res = await request(ctx.app).post('/api/contact').send(valid);
  assert.equal(res.status, 429);
  assert.equal(msgs(ctx).length, 5);
});

test('email failure still saves, still thanks the customer, records failed, and logs only a code and a short reason', async () => {
  const lines = [];
  const store = createContactMessageStore();
  const record = await submitContact(valid, { store, mailer: failing('EAUTH'), config: { mailFrom: MAIL_FROM, ownerEmail: OWNER_EMAIL }, log: { error: (l) => lines.push(l) } });
  assert.equal(record.emailStatus, 'failed');
  assert.equal(record.emailError, 'EAUTH: login rejected');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^Contact email not sent \(message 1\): EAUTH \(login rejected\)$/);
  for (const secret of ['secret-pass', 'asha@example.test', '98450', 'AUTH PLAIN', 'authentication failed']) assert.ok(!lines[0].includes(secret), secret);

  // Through the HTTP route: the customer still gets a 200 and the success text.
  const config = loadConfig({ NODE_ENV: 'test', MAIL_ENABLED: 'true', SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p', OWNER_EMAIL });
  const registry = createRegistry({ maxBusinesses: 5 });
  const repos = registry.addDemo(config);
  const app = createApp(config, { registry, mailer: failing('ETIMEDOUT') });
  const res = await request(app).post('/api/contact').send(valid);
  assert.deepEqual([res.status, res.body], [200, { ok: true }]);
  assert.equal(repos.contactMessages.all()[0].emailStatus, 'failed');
  assert.equal((await request(app).post('/api/contact').set('Accept', 'text/html').type('form').send(valid)).headers.location, '/?contact=sent#contact');
});

test('a slow mail server does not hold the reply; the status is set when the send ends', async () => {
  let release;
  const mailer = { send: () => new Promise((resolve) => { release = resolve; }) };
  const store = createContactMessageStore();
  const started = Date.now();
  const record = await submitContact(valid, { store, mailer, config: { mailFrom: MAIL_FROM, ownerEmail: OWNER_EMAIL }, waitMs: 30 });
  assert.ok(Date.now() - started < 1000);
  assert.equal(record.emailStatus, 'pending');
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(store.get(record.id).emailStatus, 'accepted');
});

test('status recorded: accepted, failed, or skipped when email is off', async () => {
  const off = setupOwner({ mail: 'off' });
  assert.equal((await request(off.app).post('/api/contact').send(valid)).status, 200);
  assert.equal(msgs(off)[0].emailStatus, 'skipped');
  const bad = setupOwner({ mail: 'fail' });
  assert.equal((await request(bad.app).post('/api/contact').send(valid)).status, 200);
  assert.equal(msgs(bad)[0].emailStatus, 'failed');
});

test('owner sees the messages with unread count, email status, and can mark them read', async () => {
  const ctx = setupOwner({ mail: 'fail' });
  await request(ctx.app).post('/api/contact').send(valid);
  await request(ctx.app).post('/api/contact').send({ ...valid, name: 'Ben <b>Bold</b>' });
  const o = await login(ctx.app);
  const page = await o.get('/owner/messages');
  assert.equal(page.status, 200);
  assert.match(page.text, /Asha Rao/);
  assert.match(page.text, /Email not delivered/);
  assert.ok(page.text.includes('Do you cater for 40 people?'));
  assert.ok(!page.text.includes('<b>Bold</b>'), 'names are escaped');
  assert.match(page.text, /aria-label="2 unread"/);
  const home = await o.get('/owner');
  assert.match(home.text, /href="\/owner\/messages"/);
  assert.match(home.text, /aria-label="2 unread messages"/);

  assert.equal((await o.postForm('/owner/messages/1/read')).status, 303);
  assert.equal(ctx.repos.contactMessages.unreadCount(), 1);
  assert.equal((await request(ctx.app).post('/owner/messages/2/read').type('form').send({})).status, 302, 'no session: sent to login');
  assert.equal((await request(ctx.app).post('/owner/messages/2/read').set('Cookie', o.cookie).type('form').send({})).status, 403, 'no CSRF token');
  await o.postForm('/owner/messages/read-all');
  assert.equal(ctx.repos.contactMessages.unreadCount(), 0);
  assert.ok(!(await o.get('/owner/messages')).text.includes('unread'));
});

test('empty state, and signed-out visitors cannot see the page', async () => {
  const ctx = setupOwner();
  const o = await login(ctx.app);
  assert.match((await o.get('/owner/messages')).text, /No messages yet/);
  const anon = await request(ctx.app).get('/owner/messages');
  assert.equal(anon.status, 302);
});

test('tenant isolation: another business has no Messages page or link, and never sees the demo messages', async () => {
  const ctx = setupOwner();
  await request(ctx.app).post('/api/contact').send(valid);
  const other = addBusiness(ctx.registry);
  const o = await login(ctx.app, { email: other.email, password: other.password });
  assert.equal((await o.get('/owner/messages')).status, 404);
  assert.equal((await o.postForm('/owner/messages/read-all')).status, 404);
  const home = await o.get('/owner');
  assert.ok(!home.text.includes('/owner/messages'));
  assert.ok(!home.text.includes('Asha Rao'));
  assert.equal(other.repos.contactMessages.all().length, 0);
  assert.equal(ctx.repos.contactMessages.unreadCount(), 1, 'the demo messages are untouched');
});
