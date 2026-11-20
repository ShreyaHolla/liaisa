import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupOwner, login, byName, estimateOf, makeEnquiry, MAIL_FROM, OWNER_EMAIL } from '../helpers/ownerApp.js';
import { approveAndSend, sendQuoteEmail } from '../../src/services/quotes/approval.js';
import { calculateEstimate } from '../../src/services/pricing/calculateEstimate.js';
import { DEMO_PRICING_CONFIG } from '../../src/seed.js';
import { ConflictError } from '../../src/errors.js';
import { dateAfter } from '../../src/util/format.js';

const approve = (o, e) => o.postJson(`/owner/enquiries/${e.id}/approve`, { estimateVersion: estimateOf(o.repos, e).version });

test('TC-APR-01 approve: approved, 43-char base64url token, valid for 7 days (email off: nothing sent)', async () => {
  const ctx = setupOwner({ mail: 'off' });
  const o = { ...(await login(ctx.app)), repos: ctx.repos };
  const kavita = byName(ctx.repos, 'Kavita Reddy');
  const res = await approve(o, kavita);
  assert.equal(res.status, 200);
  assert.equal(res.body.estimateStatus, 'approved');
  assert.equal(res.body.enquiryStatus, 'awaiting_approval');
  const est = estimateOf(ctx.repos, kavita);
  assert.match(est.quoteToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(est.validUntil, dateAfter(new Date(), 7));
  assert.ok(est.approvedAt);
  assert.equal(res.body.quoteUrl, `https://liaisa.co.in/q/${est.quoteToken}`);
  assert.equal(ctx.repos.emails.listByEnquiry(kavita.id).length, 0);
});

test('TC-APR-02 the send service refuses an unapproved estimate and sends nothing', async () => {
  const ctx = setupOwner();
  const kavita = byName(ctx.repos, 'Kavita Reddy');
  assert.equal(estimateOf(ctx.repos, kavita).status, 'draft');
  await assert.rejects(() => sendQuoteEmail(ctx, kavita.id), ConflictError);
  assert.equal(ctx.mailer.sent.length, 0);
  assert.equal(ctx.repos.emails.all().filter((m) => m.type === 'estimate' && m.enquiryId === kavita.id).length, 0);
});

test('TC-APR-03 edit: new version priced by the engine, old one superseded, reason saved', async () => {
  const ctx = setupOwner();
  const o = { ...(await login(ctx.app)), repos: ctx.repos };
  const kavita = byName(ctx.repos, 'Kavita Reddy');
  const res = await o.postJson(`/owner/enquiries/${kavita.id}/edit`, {
    requirements: { ...kavita.requirementsJson, quantity: 50 },
    discount: { amount: 500, reason: 'Repeat customer' },
    note: 'Includes setup time', revisionReason: 'Guest count went up',
  });
  assert.equal(res.status, 200);
  const expected = calculateEstimate(DEMO_PRICING_CONFIG, { ...kavita.requirementsJson, quantity: 50 }, { discount: { amount: 500, reason: 'Repeat customer' } });
  assert.equal(res.body.version, 2);
  assert.equal(res.body.total, expected.total);
  assert.equal(res.body.revisionReason, 'Guest count went up');
  assert.ok(res.body.lineItems.some((l) => l.kind === 'discount' && l.amount === -500 && l.reason === 'Repeat customer'));
  const all = ctx.repos.estimates.listByEnquiry(kavita.id);
  assert.deepEqual(all.map((e) => e.status), ['superseded', 'draft']);
  assert.equal(all[1].noteForCustomer, 'Includes setup time');
  assert.equal(ctx.repos.enquiries.get(kavita.id).requirementsJson.quantity, 50);
});

test('edit rejects a discount larger than the pre-tax amount and changes nothing', async () => {
  const ctx = setupOwner();
  const o = { ...(await login(ctx.app)), repos: ctx.repos };
  const kavita = byName(ctx.repos, 'Kavita Reddy');
  const res = await o.postJson(`/owner/enquiries/${kavita.id}/edit`, {
    requirements: kavita.requirementsJson, discount: { amount: 9_999_999, reason: 'Too generous' }, revisionReason: 'Test',
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'validation_error');
  assert.equal(ctx.repos.estimates.listByEnquiry(kavita.id).length, 1);
  assert.equal(estimateOf(ctx.repos, kavita).status, 'draft');
  // A discount without a reason is rejected by the schema too.
  const noReason = await o.postJson(`/owner/enquiries/${kavita.id}/edit`, {
    requirements: kavita.requirementsJson, discount: { amount: 100, reason: '' }, revisionReason: 'Test',
  });
  assert.equal(noReason.status, 400);
});

test('edit form (HTML): bad discount re-renders the page with the message; good edit redirects', async () => {
  const ctx = setupOwner();
  const o = await login(ctx.app);
  const kavita = byName(ctx.repos, 'Kavita Reddy');
  const bad = await o.postForm(`/owner/enquiries/${kavita.id}/edit`, { quantity: '60', discountAmount: '9999999', discountReason: 'Big', revisionReason: 'Test' });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Discount is more than the amount before tax/);
  const good = await o.postForm(`/owner/enquiries/${kavita.id}/edit`, { quantity: '70', discountAmount: '', discountReason: '', revisionReason: 'More guests' });
  assert.equal(good.status, 303);
  assert.equal(estimateOf(ctx.repos, kavita).version, 2);
});

test('TC-APR-04 owner declines: declined, nothing sent, reminders cancelled', async () => {
  const ctx = setupOwner();
  const o = { ...(await login(ctx.app)), repos: ctx.repos };
  const kavita = byName(ctx.repos, 'Kavita Reddy');
  ctx.repos.followups.create({ enquiryId: kavita.id, step: 1, dueAt: new Date(), channel: 'email' });
  const res = await o.postJson(`/owner/enquiries/${kavita.id}/decline`);
  assert.equal(res.status, 200);
  assert.equal(ctx.repos.enquiries.get(kavita.id).status, 'declined');
  assert.equal(ctx.mailer.sent.length, 0);
  assert.equal(ctx.repos.followups.listByEnquiry(kavita.id)[0].status, 'cancelled');
  assert.equal((await o.postJson(`/owner/enquiries/${kavita.id}/approve`, { estimateVersion: 1 })).status, 409, 'a declined enquiry cannot be approved');
  assert.equal((await o.postJson(`/owner/enquiries/${kavita.id}/decline`)).status, 409);
});

test('TC-APR-05 approve twice at once: one token, one email', async () => {
  const ctx = setupOwner();
  const o = { ...(await login(ctx.app)), repos: ctx.repos };
  const e = makeEnquiry(ctx.repos);
  const version = estimateOf(ctx.repos, e).version;
  const results = await Promise.all([1, 2].map(() => o.postJson(`/owner/enquiries/${e.id}/approve`, { estimateVersion: version })));
  assert.deepEqual(results.map((r) => r.status), [200, 200]);
  assert.equal(ctx.mailer.sent.length, 1);
  assert.equal(ctx.repos.emails.listByEnquiry(e.id).filter((m) => m.type === 'estimate').length, 1);
  const tokens = ctx.repos.estimates.listByEnquiry(e.id).map((x) => x.quoteToken).filter(Boolean);
  assert.equal(tokens.length, 1);
  const again = await approve(o, e);
  assert.equal(again.status, 200);
  assert.equal(ctx.mailer.sent.length, 1);
  assert.equal(estimateOf(ctx.repos, e).quoteToken, tokens[0]);
});

test('approving a stale draft version is a 409', async () => {
  const ctx = setupOwner();
  const o = await login(ctx.app);
  const kavita = byName(ctx.repos, 'Kavita Reddy');
  const res = await o.postJson(`/owner/enquiries/${kavita.id}/approve`, { estimateVersion: 7 });
  assert.equal(res.status, 409);
  assert.equal(ctx.mailer.sent.length, 0);
});

test('TC-APR-06 no session: 302 to login (401 JSON); no CSRF token: 403', async () => {
  const ctx = setupOwner();
  const kavita = byName(ctx.repos, 'Kavita Reddy');
  const url = `/owner/enquiries/${kavita.id}/approve`;
  const noSession = await request(ctx.app).post(url).type('form').send({ estimateVersion: 1 });
  assert.equal(noSession.status, 302);
  assert.equal(noSession.headers.location, '/owner/login');
  assert.equal((await request(ctx.app).post(url).set('Accept', 'application/json').send({})).status, 401);
  const o = await login(ctx.app);
  const noCsrf = await request(ctx.app).post(url).set('Cookie', o.cookie).type('form').send({ estimateVersion: 1 });
  assert.equal(noCsrf.status, 403);
  assert.equal(estimateOf(ctx.repos, kavita).status, 'draft');
});

// ---- Email (F7) -------------------------------------------------------------------------

test('TC-EML-01 approve for an email customer: one email with items, total, validity and link; quote sent', async () => {
  const ctx = setupOwner();
  const o = { ...(await login(ctx.app)), repos: ctx.repos };
  const kavita = byName(ctx.repos, 'Kavita Reddy');
  const res = await approve(o, kavita);
  assert.equal(res.body.estimateStatus, 'sent');
  assert.equal(res.body.enquiryStatus, 'quoted');
  assert.equal(ctx.mailer.sent.length, 1);
  const mail = ctx.mailer.sent[0];
  const est = estimateOf(ctx.repos, kavita);
  assert.equal(mail.from, MAIL_FROM);
  assert.equal(mail.to, 'kavita@example.test');
  assert.match(mail.subject, /^Your quote from Mehfil Kitchen: ₹\d/);
  assert.ok(mail.text.includes(`https://liaisa.co.in/q/${est.quoteToken}`));
  assert.ok(mail.html.includes(`https://liaisa.co.in/q/${est.quoteToken}`));
  assert.ok(mail.text.includes('Veg buffet') && mail.text.includes('Dessert counter'));
  assert.match(mail.text, /Total: ₹[\d,]+/);
  assert.match(mail.text, /Valid until/);
  assert.match(mail.html, /View and accept your quote/);
  const row = ctx.repos.emails.listByEnquiry(kavita.id).find((m) => m.type === 'estimate');
  assert.equal(row.status, 'accepted');
  assert.equal(est.status, 'sent');
});

test('quote email escapes customer-supplied text in HTML', async () => {
  const ctx = setupOwner();
  const o = { ...(await login(ctx.app)), repos: ctx.repos };
  const e = makeEnquiry(ctx.repos, { name: '<script>alert(1)</script> Bob' });
  await approve(o, e);
  assert.ok(!ctx.mailer.sent[0].html.includes('<script>'));
  assert.ok(ctx.mailer.sent[0].html.includes('&lt;script&gt;'));
});

test('TC-EML-02 SMTP failure: approved_send_failed, everything saved, Retry button shown', async () => {
  const ctx = setupOwner({ mail: 'fail' });
  const o = { ...(await login(ctx.app)), repos: ctx.repos };
  const kavita = byName(ctx.repos, 'Kavita Reddy');
  const res = await approve(o, kavita);
  assert.equal(res.status, 200);
  assert.equal(res.body.estimateStatus, 'approved_send_failed');
  const est = estimateOf(ctx.repos, kavita);
  assert.equal(est.status, 'approved_send_failed');
  assert.ok(est.quoteToken);
  assert.equal(ctx.repos.enquiries.get(kavita.id).status, 'awaiting_approval');
  assert.equal(ctx.repos.emails.listByEnquiry(kavita.id).find((m) => m.type === 'estimate').status, 'failed');
  const page = await o.get(`/owner/enquiries/${kavita.id}`);
  assert.match(page.text, /Retry sending/);
  assert.match(page.text, /The quote email didn’t send\. Your quote is saved\./);
  const summary = await o.getJson('/owner/api/summary');
  assert.ok(summary.body.needsYou.some((n) => n.enquiryId === kavita.id && n.kind === 'send_failed'));
});

test('TC-EML-03 retry after a failure sends once, then there is nothing left to retry', async () => {
  const ctx = setupOwner({ mail: 'fail' });
  const o = { ...(await login(ctx.app)), repos: ctx.repos };
  const kavita = byName(ctx.repos, 'Kavita Reddy');
  await approve(o, kavita);
  assert.equal((await o.postJson(`/owner/enquiries/${kavita.id}/retry-send`)).body.estimateStatus, 'approved_send_failed');
  ctx.mailer.fail = false;
  const ok = await o.postJson(`/owner/enquiries/${kavita.id}/retry-send`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.estimateStatus, 'sent');
  assert.equal(ctx.mailer.sent.length, 1);
  assert.equal(ctx.repos.enquiries.get(kavita.id).status, 'quoted');
  assert.equal((await o.postJson(`/owner/enquiries/${kavita.id}/retry-send`)).status, 409);
  assert.equal(ctx.mailer.sent.length, 1);
});

test('email off (MAIL_ENABLED=false): approving skips sending and the page offers the quote link', async () => {
  const ctx = setupOwner({ mail: 'off' });
  const o = await login(ctx.app);
  const kavita = byName(ctx.repos, 'Kavita Reddy');
  const res = await o.postForm(`/owner/enquiries/${kavita.id}/approve`, { estimateVersion: 1 });
  assert.equal(res.status, 303);
  const page = await o.get(res.headers.location);
  assert.match(page.text, /Email is switched off/);
  assert.match(page.text, /https:\/\/liaisa\.co\.in\/q\//);
  assert.equal((await o.postJson(`/owner/enquiries/${kavita.id}/retry-send`)).status, 409);
});

test('owner notice: an enquiry that becomes ready emails the owner; nothing is sent when mail is off', async () => {
  const FULL = { service_id: 'veg_buffet', quantity: 40, event_date: '2026-12-13', location: 'Koramangala' };
  for (const mail of ['fake', 'off']) {
    const ctx = setupOwner({ mail });
    const e = ctx.repos.enquiries.create({ customerName: 'Tara Sen', customerEmail: 't@example.test', preferredChannel: 'email', rawText: 'Veg lunch for 40', status: 'collecting' });
    const res = await request(ctx.app).post(`/api/enquiries/${e.publicId}/form`).send(FULL);
    assert.equal(res.body.outcome, 'ready');
    await new Promise((r) => setImmediate(r));
    if (mail === 'off') continue;
    assert.equal(ctx.mailer.sent.length, 1);
    assert.equal(ctx.mailer.sent[0].to, OWNER_EMAIL);
    assert.match(ctx.mailer.sent[0].subject, /^New enquiry: Tara, veg buffet for 40$/);
    assert.match(ctx.mailer.sent[0].text, /\/owner\/enquiries\/\d+/);
    assert.equal(ctx.repos.emails.listByEnquiry(e.id)[0].type, 'owner_notice');
  }
});

test('owner notice failing never breaks the customer request', async () => {
  const ctx = setupOwner({ mail: 'fail' });
  const e = ctx.repos.enquiries.create({ customerName: 'Tara Sen', customerEmail: 't@example.test', preferredChannel: 'email', rawText: 'Veg lunch for 40', status: 'collecting' });
  const res = await request(ctx.app).post(`/api/enquiries/${e.publicId}/form`).send({ service_id: 'veg_buffet', quantity: 40, event_date: '2026-12-13', location: 'Koramangala' });
  assert.equal(res.status, 200);
  assert.equal(res.body.outcome, 'ready');
});

// ---- Dashboard pages ---------------------------------------------------------------------

test('dashboard: Needs you lists approval and review rows; all enquiries use the DESIGN §7.2 labels', async () => {
  const ctx = setupOwner();
  const o = await login(ctx.app);
  const page = await o.get('/owner');
  assert.equal(page.status, 200);
  assert.match(page.text, /Needs you \(2\)/);
  assert.match(page.text, /Kavita Reddy/);
  assert.match(page.text, /Needs your approval/);
  assert.match(page.text, /Needs your review/);
  for (const label of ['Asking the customer', 'Quote sent', 'Reminder sent', 'Accepted', 'Closed: no reply / declined']) assert.ok(page.text.includes(label), label);
  const summary = await o.getJson('/owner/api/summary');
  assert.deepEqual(summary.body.needsYou.map((n) => n.kind).sort(), ['approval', 'review']);
  assert.equal(typeof summary.body.week.enquiries, 'number');
});

test('enquiry detail shows the conversation, what Liaisa understood, line items and warnings', async () => {
  const ctx = setupOwner();
  const o = await login(ctx.app);
  const arjun = byName(ctx.repos, 'Arjun Mehta');
  const page = await o.get(`/owner/enquiries/${arjun.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Office lunch for 15 people/);
  assert.match(page.text, /What Liaisa understood/);
  assert.match(page.text, /Fewer guests \(15\) than this service’s minimum \(20\)\./);
  assert.match(page.text, /Approve &amp; send/);
  assert.equal((await o.get('/owner/enquiries/99999')).status, 404);
  assert.equal((await o.get('/owner/enquiries/abc')).status, 404);
});

test('the confirm dialog names the amount, customer and channel', async () => {
  const ctx = setupOwner();
  const o = await login(ctx.app);
  const e = makeEnquiry(ctx.repos, { channel: 'whatsapp', name: 'Meera Rao' });
  const page = await o.get(`/owner/enquiries/${e.id}`);
  assert.match(page.text, /data-confirm="Send ₹18,900 quote to Meera on WhatsApp\?"/);
});

test('home page links to the owner login', async () => {
  const ctx = setupOwner();
  const res = await request(ctx.app).get('/');
  assert.match(res.text, /<a href="\/owner\/login">Owner login<\/a>/);
});
