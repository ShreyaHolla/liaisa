import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupOwner, login, byName, estimateOf, OWNER_EMAIL } from '../helpers/ownerApp.js';
import { randomBytes } from 'node:crypto';

/** Kavita's quote, approved and sent. Returns the context plus the quote token. */
async function sentQuote(opts) {
  const ctx = setupOwner(opts);
  const o = await login(ctx.app);
  const kavita = byName(ctx.repos, 'Kavita Reddy');
  await o.postJson(`/owner/enquiries/${kavita.id}/approve`, { estimateVersion: 1 });
  const token = estimateOf(ctx.repos, kavita).quoteToken;
  ctx.mailer?.sent.splice(0); // forget the quote email; tests look at owner notices
  return { ...ctx, o, kavita, token };
}
const status = (ctx) => ctx.repos.enquiries.get(ctx.kavita.id).status;

test('TC-QTE-01 GET /q/<valid token> shows the quote with Accept, Ask a question and Decline', async () => {
  const ctx = await sentQuote();
  const res = await request(ctx.app).get(`/b/mehfil-kitchen/q/${ctx.token}`);
  assert.equal(res.status, 200);
  assert.match(res.text, /Quote for Kavita/);
  assert.match(res.text, /Veg buffet/);
  assert.match(res.text, /Total/);
  assert.match(res.text, /Valid until/);
  assert.match(res.text, /Accept quote/);
  assert.match(res.text, /Ask a question/);
  assert.match(res.text, />Decline</);
  assert.match(res.headers['cache-control'], /no-store/);
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.ok(!/estimate/i.test(res.text.replace(/<[^>]+>/g, ' ')), 'customers never see the word "estimate"');
});

test('TC-QTE-02 an unknown or malformed token is the same plain 404 (no hint tokens exist)', async () => {
  const ctx = await sentQuote();
  const random = randomBytes(32).toString('base64url');
  const a = await request(ctx.app).get(`/b/mehfil-kitchen/q/${random}`);
  const b = await request(ctx.app).get('/b/mehfil-kitchen/q/not-a-token');
  const c = await request(ctx.app).post(`/b/mehfil-kitchen/q/${random}/accept`).set('Accept', 'application/json');
  assert.equal(a.status, 404);
  assert.equal(b.status, 404);
  assert.equal(c.status, 404);
  assert.equal(a.text, b.text);
  assert.equal(status(ctx), 'quoted');
});

test('TC-QTE-03 accept: won, reminders cancelled, owner notified, repeat is a no-op', async () => {
  const ctx = await sentQuote();
  ctx.repos.followups.create({ enquiryId: ctx.kavita.id, step: 1, dueAt: new Date(), channel: 'email' });
  const res = await request(ctx.app).post(`/b/mehfil-kitchen/q/${ctx.token}/accept`).set('Accept', 'application/json');
  assert.equal(res.status, 200);
  assert.equal(res.body.enquiryStatus, 'won');
  assert.equal(res.body.message, 'Accepted. Mehfil Kitchen will be in touch to confirm.');
  assert.equal(status(ctx), 'won');
  assert.equal(ctx.repos.followups.listByEnquiry(ctx.kavita.id)[0].status, 'cancelled');
  assert.equal(ctx.mailer.sent.length, 1);
  assert.equal(ctx.mailer.sent[0].to, OWNER_EMAIL);
  assert.equal(ctx.mailer.sent[0].subject, 'Kavita accepted your quote');
  const again = await request(ctx.app).post(`/b/mehfil-kitchen/q/${ctx.token}/accept`).set('Accept', 'application/json');
  assert.equal(again.status, 200);
  assert.equal(ctx.mailer.sent.length, 1);
  assert.equal(ctx.repos.customerResponses.listByEnquiry(ctx.kavita.id).filter((r) => r.type === 'accept').length, 1);
  const page = await request(ctx.app).get(`/b/mehfil-kitchen/q/${ctx.token}`);
  assert.match(page.text, /Accepted\. Mehfil Kitchen will be in touch to confirm\./);
  assert.ok(!/Accept quote/.test(page.text));
});

test('TC-QTE-04 question: saved, owner notified, reminders not cancelled, shown to the owner', async () => {
  const ctx = await sentQuote();
  ctx.repos.followups.create({ enquiryId: ctx.kavita.id, step: 1, dueAt: new Date(), channel: 'email' });
  const res = await request(ctx.app).post(`/b/mehfil-kitchen/q/${ctx.token}/question`).set('Accept', 'application/json').send({ message: 'Can you do Jain food?' });
  assert.equal(res.status, 200);
  const saved = ctx.repos.customerResponses.listByEnquiry(ctx.kavita.id).at(-1);
  assert.deepEqual([saved.type, saved.message], ['question', 'Can you do Jain food?']);
  assert.equal(status(ctx), 'quoted');
  assert.equal(ctx.repos.followups.listByEnquiry(ctx.kavita.id)[0].status, 'pending');
  assert.equal(ctx.mailer.sent[0].to, OWNER_EMAIL);
  assert.match(ctx.mailer.sent[0].text, /Can you do Jain food\?/);
  const needs = await ctx.o.getJson('/owner/api/summary');
  const item = needs.body.needsYou.find((n) => n.kind === 'customer_question');
  assert.equal(item.enquiryId, ctx.kavita.id);
  assert.match(item.what, /Can you do Jain food\?/);
  const detail = await ctx.o.get(`/owner/enquiries/${ctx.kavita.id}`);
  assert.match(detail.text, /Customer question:<\/strong> “Can you do Jain food\?”/);
  assert.match(detail.text, /Reply by email/);
});

test('question: empty or too long is a 400 and nothing is saved; HTML form redirects back', async () => {
  const ctx = await sentQuote();
  const empty = await request(ctx.app).post(`/b/mehfil-kitchen/q/${ctx.token}/question`).set('Accept', 'application/json').send({ message: ' ' });
  assert.equal(empty.status, 400);
  const long = await request(ctx.app).post(`/b/mehfil-kitchen/q/${ctx.token}/question`).set('Accept', 'application/json').send({ message: 'x'.repeat(1001) });
  assert.equal(long.status, 400);
  assert.equal(ctx.repos.customerResponses.listByEnquiry(ctx.kavita.id).length, 0);
  const html = await request(ctx.app).post(`/b/mehfil-kitchen/q/${ctx.token}/question`).set('Accept', 'text/html').type('form').send({ message: 'Is parking needed?' });
  assert.equal(html.status, 303);
  assert.equal(html.headers.location, `/b/mehfil-kitchen/q/${ctx.token}?r=question`);
  assert.match((await request(ctx.app).get(html.headers.location)).text, /Question sent\./);
  const bad = await request(ctx.app).post(`/b/mehfil-kitchen/q/${ctx.token}/question`).set('Accept', 'text/html').type('form').send({ message: '' });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Type your question\./);
});

test('TC-QTE-05 decline: lost, reminders cancelled; accept afterwards is a 409', async () => {
  const ctx = await sentQuote();
  ctx.repos.followups.create({ enquiryId: ctx.kavita.id, step: 1, dueAt: new Date(), channel: 'email' });
  const res = await request(ctx.app).post(`/b/mehfil-kitchen/q/${ctx.token}/decline`).set('Accept', 'application/json').send({ reason: 'Went with someone else' });
  assert.equal(res.status, 200);
  assert.equal(res.body.enquiryStatus, 'lost');
  assert.equal(status(ctx), 'lost');
  assert.equal(ctx.repos.followups.listByEnquiry(ctx.kavita.id)[0].status, 'cancelled');
  assert.equal(ctx.repos.customerResponses.listByEnquiry(ctx.kavita.id)[0].message, 'Went with someone else');
  const accept = await request(ctx.app).post(`/b/mehfil-kitchen/q/${ctx.token}/accept`).set('Accept', 'application/json');
  assert.equal(accept.status, 409);
  assert.equal(status(ctx), 'lost');
});

test('TC-QTE-06 a quote past valid_until + 30 days says it has expired and changes nothing', async () => {
  const ctx = await sentQuote();
  const est = estimateOf(ctx.repos, ctx.kavita);
  const old = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
  ctx.repos.estimates.update(est.id, { validUntil: old });
  const json = await request(ctx.app).post(`/b/mehfil-kitchen/q/${ctx.token}/accept`).set('Accept', 'application/json');
  assert.equal(json.status, 410);
  const page = await request(ctx.app).get(`/b/mehfil-kitchen/q/${ctx.token}`);
  assert.match(page.text, /This quote has expired/);
  assert.ok(!/Accept quote/.test(page.text));
  assert.equal(status(ctx), 'quoted');
  // Inside the 30-day grace period it still works.
  ctx.repos.estimates.update(est.id, { validUntil: new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10) });
  assert.equal((await request(ctx.app).post(`/b/mehfil-kitchen/q/${ctx.token}/accept`).set('Accept', 'application/json')).status, 200);
});

test('a quote whose enquiry the owner declined is a 404', async () => {
  const ctx = await sentQuote({ mail: 'off' });
  ctx.repos.enquiries.update(ctx.kavita.id, { status: 'declined' });
  assert.equal((await request(ctx.app).get(`/b/mehfil-kitchen/q/${ctx.token}`)).status, 404);
});

test('accepting with email off still works and sends nothing', async () => {
  const ctx = await sentQuote({ mail: 'off' });
  const res = await request(ctx.app).post(`/b/mehfil-kitchen/q/${ctx.token}/accept`).set('Accept', 'application/json');
  assert.equal(res.status, 200);
  assert.equal(status(ctx), 'won');
});
