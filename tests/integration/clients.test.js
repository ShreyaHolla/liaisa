// M10-lite Client Finder: reconnect list, leads, drafts, approval, limits, safety.
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupOwner, login, byName, MAIL_FROM } from '../helpers/ownerApp.js';
import { sendDraft } from '../../src/services/clients/outreach.js';
import { NotFoundError } from '../../src/errors.js';

const SANJAY = 'e:sanjay@example.test'; // seeded: accepted, event 20 Dec
const NEHA = 'e:neha@example.test'; // seeded: lost with no reply
const DAY = 86400000;

async function world(opts) {
  const ctx = setupOwner(opts);
  const o = await login(ctx.app);
  return { ...ctx, o };
}
const draft = (o, type, ref) => o.postJson('/owner/clients/draft', { type, ref });
const send = (o, id, message) => o.postJson(`/owner/clients/drafts/${id}/send`, { message });

/** A past customer who accepted, with the contact details we need. */
function pastCustomer(repos, { name, channel = 'email', email, phone, status = 'won' }) {
  const e = repos.enquiries.create({
    customerName: name, customerEmail: email ?? null, customerPhone: phone ?? null, preferredChannel: channel,
    rawText: 'Birthday lunch', status, requirementsJson: { service_id: 'veg_buffet', quantity: 30, event_date: '2026-10-01', location: 'Koramangala' },
  }, new Date(Date.now() - 60 * DAY));
  repos.customerResponses.create({ enquiryId: e.id, type: 'accept' }, new Date(Date.now() - 55 * DAY));
  return e;
}

test('the Client Finder needs the owner login, is linked from the dashboard, and has two tabs', async () => {
  const ctx = await world();
  assert.equal((await request(ctx.app).get('/owner/clients')).status, 302);
  assert.match((await ctx.o.get('/owner')).text, /<a href="\/owner\/clients">Client Finder<\/a>/);
  const page = await ctx.o.get('/owner/clients');
  assert.equal(page.status, 200);
  assert.match(page.text, /Reconnect<\/a>/);
  assert.match(page.text, /New leads<\/a>/);
  assert.match(page.text, /Drafts today: 0 of 20/);
});

test('Reconnect lists past customers with service, date, outcome and a rule-based reason', async () => {
  const ctx = await world();
  const page = await ctx.o.get('/owner/clients?tab=reconnect');
  for (const text of ['Sanjay Kulkarni', 'Veg buffet', 'Sun 20 Dec', 'Accepted', 'Neha Banerjee', 'No reply']) assert.ok(page.text.includes(text), text);
  assert.match(page.text, /Draft message<span class="sr"> for Sanjay Kulkarni/);
  for (const name of ['Kavita Reddy', 'Arjun Mehta', 'Priya Nair']) assert.ok(!page.text.includes(`<strong>${name}</strong>`), `${name} is still active`);
});

test('draft (mock AI): editable, from the facts only, no prices, with only the business’s own link', async () => {
  const ctx = await world();
  const res = await draft(ctx.o, 'customer', SANJAY);
  assert.equal(res.status, 201);
  assert.equal(res.body.channel, 'email');
  assert.equal(res.body.source, 'ai');
  assert.match(res.body.message, /^Hi Sanjay, this is Mehfil Kitchen\. We remember your veg buffet enquiry for your anniversary on Sun 20 Dec\./);
  assert.ok(res.body.message.endsWith('You can reach us any time: https://liaisa.co.in/enquire'));
  assert.ok(!/₹|\bRs\b|price|discount|\d{3,}/i.test(res.body.message.replace('https://liaisa.co.in/enquire', '')));
  assert.equal(ctx.mailer.sent.length, 0, 'drafting sends nothing');
  const [call] = ctx.ai.calls;
  assert.equal(call.purpose, 'outreach');
  assert.ok(!/sanjay@example|Kulkarni/.test(JSON.stringify(call)), 'no email or surname goes to the model');
  const rows = ctx.repos.aiCalls.all().filter((r) => r.purpose === 'outreach');
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes('Sanjay'), 'ai_calls holds no personal data');
  const html = await ctx.o.postForm('/owner/clients/draft', { type: 'customer', ref: NEHA });
  assert.equal(html.status, 303);
  const page = await ctx.o.get(html.headers.location);
  assert.match(page.text, /<textarea id="message" name="message"/);
  assert.match(page.text, /Hi Neha, this is Mehfil Kitchen/);
  assert.match(page.text, /Written by Liaisa from the facts we hold/);
  assert.match(page.text, />Approve &amp; send</);
});

test('asking again for the same person reuses the unsent draft: no new AI call, no new slot', async () => {
  const ctx = await world();
  const a = await draft(ctx.o, 'customer', SANJAY);
  const b = await draft(ctx.o, 'customer', SANJAY);
  assert.equal(a.body.draftId, b.body.draftId);
  assert.equal(ctx.ai.calls.length, 1);
  assert.equal(ctx.repos.outreach.all().length, 1);
});

test('approval is required: nothing is sent until the owner approves the text, and only once', async () => {
  const ctx = await world();
  const d = await draft(ctx.o, 'customer', SANJAY);
  assert.equal(ctx.mailer.sent.length, 0);
  assert.equal(ctx.repos.outreach.get(d.body.draftId).status, 'draft');
  await assert.rejects(() => sendDraft({ repos: ctx.repos, config: ctx.config, mailer: ctx.mailer }, 9999, 'Hello there friend'), NotFoundError);
  assert.equal((await send(ctx.o, 9999, 'Hello there friend')).status, 404);
  assert.equal((await send(ctx.o, d.body.draftId, '')).status, 400);
  assert.equal(ctx.mailer.sent.length, 0);
  const edited = 'Hi Sanjay, thank you for choosing us. Do reply if we can help with your next event. See https://liaisa.co.in/enquire';
  const ok = await send(ctx.o, d.body.draftId, edited);
  assert.deepEqual(ok.body, { channel: 'email', status: 'sent' });
  assert.equal(ctx.mailer.sent.length, 1);
  assert.equal((await send(ctx.o, d.body.draftId, edited)).status, 409);
  assert.equal(ctx.mailer.sent.length, 1);
});

test('email channel: the edited text goes through the mail service, saved first, logged in emails and Activity', async () => {
  const ctx = await world();
  const d = await draft(ctx.o, 'customer', SANJAY);
  const edited = 'Hi Sanjay, hope you enjoyed the party! If you ever plan another one, just reply here.';
  const res = await ctx.o.postForm(`/owner/clients/drafts/${d.body.draftId}/send`, { message: edited });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, `/owner/clients/drafts/${d.body.draftId}?n=sent`);
  const mail = ctx.mailer.sent[0];
  assert.deepEqual([mail.to, mail.from, mail.text], ['sanjay@example.test', MAIL_FROM, edited]);
  assert.equal(mail.subject, 'A note from Mehfil Kitchen');
  const row = ctx.repos.outreach.get(d.body.draftId);
  assert.deepEqual([row.status, row.message], ['sent', edited]);
  assert.equal(ctx.repos.emails.all().find((m) => m.type === 'outreach').status, 'accepted');
  const page = await ctx.o.get('/owner/clients');
  assert.match(page.text, /<li>Sanjay Kulkarni · email · Sent · just now<\/li>/);
  assert.match((await ctx.o.get(res.headers.location)).text, /<blockquote class="draft">Hi Sanjay, hope you enjoyed/);
});

test('WhatsApp channel: a wa.me link with the approved text; nothing is emailed', async () => {
  const ctx = await world();
  const e = pastCustomer(ctx.repos, { name: 'Tara Sen', channel: 'whatsapp', phone: '919845012345' });
  const d = await draft(ctx.o, 'customer', 'p:919845012345');
  assert.equal(d.body.channel, 'whatsapp');
  const res = await ctx.o.postForm(`/owner/clients/drafts/${d.body.draftId}/send`, { message: 'Hi Tara, thinking of you & your next party!' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `https://wa.me/919845012345?text=${encodeURIComponent('Hi Tara, thinking of you & your next party!')}`);
  assert.equal(ctx.mailer.sent.length, 0);
  assert.equal(ctx.repos.outreach.get(d.body.draftId).status, 'opened');
  assert.match((await ctx.o.get('/owner/clients')).text, /Tara Sen · WhatsApp · Opened in WhatsApp/);
  assert.ok(e);
});

test('email failure and email off: the message is saved, the owner can retry, nothing counts as contact', async () => {
  const bad = await world({ mail: 'fail' });
  const d = await draft(bad.o, 'customer', SANJAY);
  const res = await bad.o.postForm(`/owner/clients/drafts/${d.body.draftId}/send`, { message: 'Hi Sanjay, a quick hello from us.' });
  assert.equal(res.headers.location, `/owner/clients/drafts/${d.body.draftId}?n=send_failed`);
  assert.equal(bad.repos.outreach.get(d.body.draftId).status, 'failed');
  assert.match((await bad.o.get(res.headers.location)).text, /The email didn’t send\. Your message is saved\./);
  assert.match((await bad.o.get(res.headers.location)).text, /Approve &amp; send/, 'the owner can try again');
  bad.mailer.fail = false;
  assert.equal((await send(bad.o, d.body.draftId, 'Hi Sanjay, a quick hello from us.')).body.status, 'sent');

  const off = await world({ mail: 'off' });
  const d2 = await draft(off.o, 'customer', SANJAY);
  const refused = await send(off.o, d2.body.draftId, 'Hi Sanjay, a quick hello from us.');
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'mail_off');
});

test('7-day rule: nobody is contacted twice in 7 days, for drafts or sends', async () => {
  const ctx = await world();
  const d = await draft(ctx.o, 'customer', SANJAY);
  await send(ctx.o, d.body.draftId, 'Hi Sanjay, a quick hello from us.');
  const again = await draft(ctx.o, 'customer', SANJAY);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'recent');
  assert.match(again.body.error.message, /^Contacted recently\. Wait until /);
  const html = await ctx.o.postForm('/owner/clients/draft', { type: 'customer', ref: SANJAY });
  assert.equal(html.headers.location, '/owner/clients?tab=reconnect&n=recent');
  const page = await ctx.o.get('/owner/clients');
  assert.match(page.text, /Contacted recently\. Wait until/);
  assert.ok(!page.text.includes('Draft message<span class="sr"> for Sanjay'));
  // 8 days later it is allowed again.
  const sentRow = ctx.repos.outreach.get(d.body.draftId);
  ctx.repos.outreach.update(sentRow.id, { sentAt: new Date(Date.now() - 8 * DAY) });
  assert.equal((await draft(ctx.o, 'customer', SANJAY)).status, 201);
});

test('7-day rule: a draft written earlier cannot be sent after someone else already reached the person', async () => {
  const ctx = await world();
  const d = await draft(ctx.o, 'customer', SANJAY);
  ctx.repos.outreach.create({ subjectType: 'customer', key: SANJAY, channel: 'whatsapp', status: 'opened', message: 'x', sentAt: new Date() });
  const res = await send(ctx.o, d.body.draftId, 'Hi Sanjay, a quick hello from us.');
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'recent');
  assert.equal(ctx.mailer.sent.length, 0);
});

test('do not contact: a customer who declines with the box ticked is never drafted for', async () => {
  const ctx = await world();
  const rohan = byName(ctx.repos, 'Rohan Iyer');
  const token = ctx.repos.estimates.listByEnquiry(rohan.id)[0].quoteToken;
  assert.match((await request(ctx.app).get(`/q/${token}`)).text, /name="doNotContact"/);
  await request(ctx.app).post(`/q/${token}/decline`).type('form').send({ doNotContact: 'on' });
  assert.equal(ctx.repos.enquiries.get(rohan.id).doNotContact, true);
  const page = await ctx.o.get('/owner/clients');
  assert.match(page.text, /Rohan Iyer/);
  assert.match(page.text, /Asked not to be contacted/);
  const res = await draft(ctx.o, 'customer', 'e:rohan@example.test');
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'do_not_contact');
  assert.equal(ctx.repos.outreach.all().length, 0);
  assert.equal(ctx.ai.calls.length, 0, 'no AI call for them');
  // A plain decline (box not ticked) leaves the flag off.
  const fatima = byName(ctx.repos, 'Fatima Sheikh');
  const t2 = ctx.repos.estimates.listByEnquiry(fatima.id)[0].quoteToken;
  await request(ctx.app).post(`/q/${t2}/decline`).set('Accept', 'application/json').send({});
  assert.equal(ctx.repos.enquiries.get(fatima.id).doNotContact, false);
});

test('do not contact: the owner can flag a customer or a lead, which retires an unsent draft', async () => {
  const ctx = await world();
  const d = await draft(ctx.o, 'customer', SANJAY);
  const res = await ctx.o.postJson('/owner/clients/dnc', { type: 'customer', ref: SANJAY });
  assert.equal(res.status, 200);
  assert.equal(ctx.repos.outreach.get(d.body.draftId).status, 'discarded');
  assert.equal((await send(ctx.o, d.body.draftId, 'Hi Sanjay, a quick hello from us.')).status, 409);
  assert.equal((await draft(ctx.o, 'customer', SANJAY)).body.error.code, 'do_not_contact');
  assert.ok(!(await ctx.o.get('/owner/clients')).text.includes('Sent</li>'), 'a discarded draft is not in Activity');
  const lead = await ctx.o.postJson('/owner/clients/leads', { name: 'Lee Park', contact: 'lee@example.test', note: 'Runs a bakery' });
  await ctx.o.postJson('/owner/clients/dnc', { type: 'lead', ref: String(lead.body.id) });
  assert.equal((await draft(ctx.o, 'lead', String(lead.body.id))).body.error.code, 'do_not_contact');
});

test('daily draft limit: the next draft is refused with a clear message; reusing a draft does not use a slot', async () => {
  const ctx = await world({ env: { CLIENT_DRAFT_DAILY_CAP: '2' } });
  pastCustomer(ctx.repos, { name: 'Ann Lee', email: 'ann@example.test' });
  assert.equal((await draft(ctx.o, 'customer', SANJAY)).status, 201);
  assert.equal((await draft(ctx.o, 'customer', SANJAY)).status, 201, 'same draft again: free');
  assert.equal((await draft(ctx.o, 'customer', NEHA)).status, 201);
  const third = await draft(ctx.o, 'customer', 'e:ann@example.test');
  assert.equal(third.status, 409);
  assert.equal(third.body.error.code, 'draft_limit');
  assert.equal(third.body.error.message, 'You’ve reached today’s limit of 2 drafts. Try again tomorrow.');
  const html = await ctx.o.postForm('/owner/clients/draft', { type: 'customer', ref: 'e:ann@example.test' });
  assert.equal(html.headers.location, '/owner/clients?tab=reconnect&n=draft_limit');
  assert.match((await ctx.o.get(html.headers.location)).text, /limit of drafts/);
  assert.match((await ctx.o.get('/owner/clients')).text, /Drafts today: 2 of 2/);
  assert.equal(ctx.ai.calls.length, 2);
});

test('default limit is 20 drafts a day, counted per day', async () => {
  const ctx = await world();
  assert.equal(ctx.config.clientDraftDailyCap, 20);
  const slot = (when) => ctx.repos.outreach.create({ subjectType: 'customer', key: 'e:x@example.test', channel: 'email', status: 'discarded', message: '' }, when);
  for (let i = 0; i < 20; i += 1) slot(new Date(Date.now() - 2 * DAY));
  assert.equal((await draft(ctx.o, 'customer', SANJAY)).status, 201, 'drafts from earlier days do not count');
  for (let i = 0; i < 19; i += 1) slot(new Date());
  assert.equal((await draft(ctx.o, 'customer', NEHA)).body.error.code, 'draft_limit', '20 today: the 21st is refused');
});

test('leads: validation, one contact each, and drafts that use the owner’s one-line note', async () => {
  const ctx = await world();
  const bad = await ctx.o.postForm('/owner/clients/leads', { name: '', contact: 'not-a-contact', note: '' });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Enter a name\./);
  assert.match(bad.text, /Enter an email address or a 10-digit mobile number/);
  assert.match(bad.text, /Add a short note about who they are\./);
  assert.equal((await ctx.o.postJson('/owner/clients/leads', { name: 'A', contact: '12345', note: 'x y z' })).status, 400);
  assert.equal(ctx.repos.leads.all().length, 0);

  const ok = await ctx.o.postForm('/owner/clients/leads', { name: 'Dev Rao', contact: 'Dev@Example.test', note: 'HR manager at an IT firm' });
  assert.equal(ok.headers.location, '/owner/clients?tab=leads&n=lead_added');
  const wa = await ctx.o.postJson('/owner/clients/leads', { name: 'Mina Das', contact: '98450 12345', note: 'Runs a yoga studio' });
  assert.equal(wa.status, 201);
  assert.deepEqual([ctx.repos.leads.all()[0].email, ctx.repos.leads.all()[1].phone], ['dev@example.test', '919845012345']);
  assert.equal((await ctx.o.postJson('/owner/clients/leads', { name: 'Dev Again', contact: 'dev@example.test', note: 'same person' })).status, 409);

  const page = await ctx.o.get('/owner/clients?tab=leads');
  assert.match(page.text, /HR manager at an IT firm/);
  const lead = ctx.repos.leads.all()[0];
  const d = await draft(ctx.o, 'lead', String(lead.id));
  assert.equal(d.status, 201);
  assert.match(d.body.message, /^Hi Dev, this is Mehfil Kitchen\. We cater for events/);
  assert.ok(ctx.ai.calls[0].messages[0].content.includes('HR manager at an IT firm'), 'the note is given to the model as data');
  assert.ok(!JSON.stringify(ctx.ai.calls[0]).includes('dev@example.test'), 'never the contact detail');
  assert.equal((await send(ctx.o, d.body.draftId, 'Hi Dev, hope you are well. Happy to help with team lunches. https://liaisa.co.in/enquire')).body.status, 'sent');
  assert.equal(ctx.mailer.sent[0].to, 'dev@example.test');
  const waDraft = await draft(ctx.o, 'lead', String(ctx.repos.leads.all()[1].id));
  assert.equal(waDraft.body.channel, 'whatsapp');
  assert.match((await ctx.o.postForm(`/owner/clients/drafts/${waDraft.body.draftId}/send`, { message: 'Hi Mina, hello from us.' })).headers.location, /^https:\/\/wa\.me\/919845012345\?text=/);
});

test('links: only the business’s own link may be sent; output is escaped', async () => {
  const ctx = await world();
  const d = await draft(ctx.o, 'customer', SANJAY);
  const evil = await send(ctx.o, d.body.draftId, 'Hi Sanjay, look at https://evil.example/offer now please');
  assert.equal(evil.status, 400);
  assert.match(evil.body.error.message, /Only your own enquiry or quote link/);
  const html = await ctx.o.postForm(`/owner/clients/drafts/${d.body.draftId}/send`, { message: 'Hi Sanjay <b>see</b> www.evil.example/x today' });
  assert.equal(html.status, 400);
  assert.match(html.text, /Only your own enquiry or quote link can go in a message\./);
  assert.ok(html.text.includes('&lt;b&gt;see&lt;/b&gt;'), 'what the owner typed comes back escaped');
  assert.equal(ctx.mailer.sent.length, 0);
  assert.equal((await send(ctx.o, d.body.draftId, 'Hi Sanjay, see https://liaisa.co.in/q/abc for your quote')).status, 200);
  const lead = await ctx.o.postJson('/owner/clients/leads', { name: '<script>alert(1)</script>', contact: 'x@example.test', note: '<img src=x onerror=alert(1)>' });
  const page = await ctx.o.get('/owner/clients?tab=leads');
  assert.ok(!page.text.includes('<script>alert(1)') && !page.text.includes('<img src=x'));
  assert.ok(page.text.includes('&lt;script&gt;'));
  assert.ok(lead.body.id);
});

test('AI off: the standard template is used and no model is called', async () => {
  const ctx = await world({ env: { AI_ENABLED: 'false' } });
  const d = await draft(ctx.o, 'customer', SANJAY);
  assert.equal(d.body.source, 'template');
  assert.equal(ctx.ai.calls.length, 0);
  const page = await ctx.o.get(`/owner/clients/drafts/${d.body.draftId}`);
  assert.match(page.text, /This is the standard message\./);
});

test('all Client Finder routes need the owner session and a CSRF token', async () => {
  const ctx = await world();
  const posts = [['/owner/clients/leads', {}], ['/owner/clients/draft', { type: 'customer', ref: SANJAY }], ['/owner/clients/dnc', { type: 'customer', ref: SANJAY }], ['/owner/clients/drafts/1/send', { message: 'Hello there' }]];
  for (const [url, body] of posts) {
    assert.equal((await request(ctx.app).post(url).type('form').send(body)).status, 302, `${url} without a session`);
    assert.equal((await request(ctx.app).post(url).set('Cookie', ctx.o.cookie).type('form').send(body)).status, 403, `${url} without CSRF`);
  }
  assert.equal((await request(ctx.app).get('/owner/clients/drafts/1')).status, 302);
  assert.equal(ctx.repos.outreach.all().length, 0);
  assert.equal(ctx.mailer.sent.length, 0);
});

test('unknown draft or person: 404, and a malformed body is a 400', async () => {
  const ctx = await world();
  assert.equal((await ctx.o.get('/owner/clients/drafts/999')).status, 404);
  assert.equal((await ctx.o.get('/owner/clients/drafts/abc')).status, 404);
  assert.equal((await draft(ctx.o, 'customer', 'e:nobody@example.test')).status, 404);
  assert.equal((await ctx.o.postJson('/owner/clients/draft', { type: 'stranger', ref: 'x' })).status, 400);
});
