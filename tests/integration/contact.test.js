import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createFakeMailer } from '../../src/mail/fakeTransport.js';
import { createContactMessageStore } from '../../src/db/repos/contactMessages.js';

const config = loadConfig({
  NODE_ENV: 'test',
  MAIL_ENABLED: 'true',
  SMTP_HOST: 'smtp.example.test',
  SMTP_USER: 'hello@example.test',
  SMTP_PASS: 'not-a-real-password',
  OWNER_EMAIL: 'owner@example.test',
});

// Fresh app (and so a fresh rate-limit counter) per test.
function setup({ mailer = createFakeMailer() } = {}) {
  const store = createContactMessageStore();
  const app = createApp(config, { contacts: store, mailer });
  return { app, store, mailer };
}

const valid = { name: 'Asha Rao', email: 'asha@example.test', message: 'Do you cater for 40 people?' };

test('TC-CON-01 valid POST: 200, saved, one email to owner with Reply-To = visitor', async () => {
  const { app, store, mailer } = setup();
  const res = await request(app).post('/api/contact').send(valid);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });

  const rows = await store.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].emailStatus, 'accepted');

  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'owner@example.test');
  assert.equal(mailer.sent[0].replyTo, 'asha@example.test');
  assert.equal(mailer.sent[0].subject, 'Website message from Asha Rao');
});

test('TC-CON-01 form-urlencoded POST is accepted too', async () => {
  const { app, mailer } = setup();
  const res = await request(app).post('/api/contact').type('form').send(valid);
  assert.equal(res.status, 200);
  assert.equal(mailer.sent.length, 1);
});

test('TC-CON-02 empty name, bad email, over-long message: 400 with field errors, nothing saved or sent', async () => {
  const { app, store, mailer } = setup();
  const res = await request(app)
    .post('/api/contact')
    .send({ name: '', email: 'not-an-email', message: 'x'.repeat(2001) });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'validation_error');
  assert.deepEqual(Object.keys(res.body.error.fields).sort(), ['email', 'message', 'name']);
  assert.equal((await store.list()).length, 0);
  assert.equal(mailer.sent.length, 0);
});

test('TC-CON-02 a message of exactly 2,000 characters is accepted', async () => {
  const { app } = setup();
  const res = await request(app)
    .post('/api/contact')
    .send({ ...valid, message: 'x'.repeat(2000) });
  assert.equal(res.status, 200);
});

test('TC-CON-03 honeypot filled: looks successful, nothing saved, no email', async () => {
  const { app, store, mailer } = setup();
  const res = await request(app)
    .post('/api/contact')
    .send({ ...valid, website: 'http://spam.example' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal((await store.list()).length, 0);
  assert.equal(mailer.sent.length, 0);
});

test('TC-CON-04 SMTP failure: still 200, message saved with email_status=failed', async () => {
  const { app, store } = setup({ mailer: createFakeMailer({ fail: true }) });
  const res = await request(app).post('/api/contact').send(valid);
  assert.equal(res.status, 200);
  const rows = await store.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].emailStatus, 'failed');
});

test('M3 mail disabled: saved with email_status=skipped, nothing sent', async () => {
  const { app, store } = setup({ mailer: null });
  const res = await request(app).post('/api/contact').send(valid);
  assert.equal(res.status, 200);
  assert.equal((await store.list())[0].emailStatus, 'skipped');
});

test('TC-CON-05 6th POST from one IP within an hour gets 429 with Retry-After', async () => {
  const { app } = setup();
  for (let i = 0; i < 5; i++) {
    const ok = await request(app).post('/api/contact').send(valid);
    assert.equal(ok.status, 200);
  }
  const res = await request(app).post('/api/contact').send(valid);
  assert.equal(res.status, 429);
  assert.equal(res.body.error.code, 'rate_limited');
  assert.ok(Number(res.headers['retry-after']) > 0);
});

test('TC-CON-05 invalid POSTs also count toward the limit', async () => {
  const { app } = setup();
  for (let i = 0; i < 5; i++) await request(app).post('/api/contact').send({});
  const res = await request(app).post('/api/contact').send(valid);
  assert.equal(res.status, 429);
});

test('no-JS fallback: success redirects 303 to /?contact=sent#contact', async () => {
  const { app } = setup();
  const res = await request(app).post('/api/contact').set('Accept', 'text/html').type('form').send(valid);
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/?contact=sent#contact');
});

test('no-JS fallback: validation error redirects 303 to /?contact=error#contact, nothing saved', async () => {
  const { app, store } = setup();
  const res = await request(app)
    .post('/api/contact')
    .set('Accept', 'text/html')
    .type('form')
    .send({ name: '', email: 'x', message: '' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/?contact=error#contact');
  assert.equal((await store.list()).length, 0);
});

test('no-JS fallback: honeypot redirects as if sent, nothing saved', async () => {
  const { app, store } = setup();
  const res = await request(app)
    .post('/api/contact')
    .set('Accept', 'text/html')
    .type('form')
    .send({ ...valid, website: 'x' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/?contact=sent#contact');
  assert.equal((await store.list()).length, 0);
});

test('home page: renders the form with a hidden honeypot and no notice by default', async () => {
  const { app } = setup();
  const res = await request(app).get('/');
  assert.equal(res.status, 200);
  assert.match(res.text, /<form id="contact-form" method="post" action="\/api\/contact"/);
  assert.match(res.text, /name="website"/);
  assert.doesNotMatch(res.text, /notice-ok|notice-error/);
});

test('home page: ?contact=sent and ?contact=error show a one-line message; unknown values show none', async () => {
  const { app } = setup();
  const sent = await request(app).get('/?contact=sent');
  assert.match(sent.text, /Thanks for writing/);
  const err = await request(app).get('/?contact=error');
  assert.match(err.text, /Check your name, email and message/);
  const junk = await request(app).get('/?contact=%3Cscript%3E');
  assert.doesNotMatch(junk.text, /notice-ok|notice-error|<script>/);
});

test('malformed JSON body returns 400 validation_error with no stack trace', async () => {
  const { app } = setup();
  const res = await request(app).post('/api/contact').set('Content-Type', 'application/json').send('{bad');
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'validation_error');
  assert.doesNotMatch(res.text, /at .*\.js/);
});
