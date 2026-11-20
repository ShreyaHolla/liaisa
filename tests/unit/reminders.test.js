import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepos } from '../../src/container.js';
import { seed } from '../../src/seed.js';
import { loadConfig } from '../../src/config.js';
import { createFakeMailer } from '../../src/mail/fakeTransport.js';
import { createEstimate } from '../../src/services/estimates/createEstimate.js';
import { approveAndSend, shareOnWhatsapp, currentEstimate } from '../../src/services/quotes/approval.js';
import { acceptQuote, declineQuote, askQuestion } from '../../src/services/quotes/customer.js';
import { followupState, sendReminder, markFollowupDone, dueFollowUps, draftReminder } from '../../src/services/followups/reminders.js';
import { ConflictError } from '../../src/errors.js';

const DAY = 86400000;
const T0 = new Date('2026-12-01T10:00:00Z');
const at = (days) => new Date(T0.getTime() + days * DAY);

/** Seeded repos, a fake mailer and a clock the test moves. */
function world({ mail = 'fake', afterDays } = {}) {
  const repos = createRepos();
  seed(repos, { now: T0 });
  if (afterDays !== undefined) repos.businessSettings.save({ followupAfterDays: afterDays });
  const clock = { t: T0 };
  const mailer = mail === 'off' ? null : createFakeMailer({ fail: mail === 'fail' });
  const config = loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://liaisa.co.in', ...(mail === 'off' ? {} : { MAIL_ENABLED: 'true', SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p', OWNER_EMAIL: 'o@example.test' }) });
  const deps = { repos, config, mailer, now: () => clock.t };
  return { repos, mailer, deps, clock, at: (d) => { clock.t = at(d); } };
}

/** A new email-customer enquiry whose quote was approved and emailed at T0. */
async function sentQuote(w, opts = {}) {
  const e = w.repos.enquiries.create({
    customerName: opts.name ?? 'Meera Rao', customerEmail: 'meera@example.test', customerPhone: opts.phone ?? null,
    preferredChannel: opts.channel ?? 'email', rawText: 'Veg lunch', status: 'awaiting_approval',
    requirementsJson: { service_id: 'veg_buffet', quantity: 40, event_date: '2026-12-15', location: 'Indiranagar' },
  }, T0);
  createEstimate(w.repos, e.id, { now: T0 });
  w.at(0);
  await approveAndSend(w.deps, e.id, 1);
  if ((opts.channel ?? 'email') === 'whatsapp') shareOnWhatsapp(w.deps, e.id);
  return w.repos.enquiries.get(e.id);
}
const state = (w, e) => followupState(w.deps, w.repos.enquiries.get(e.id), w.clock.t);

test('due: a sent quote with no reply is due after N days (default 2), not before', async () => {
  const w = world();
  const e = await sentQuote(w);
  w.at(1.9);
  assert.deepEqual([state(w, e).due, state(w, e).reason], [false, 'waiting']);
  assert.equal(state(w, e).show, true);
  w.at(2);
  assert.deepEqual([state(w, e).due, state(w, e).reason], [true, 'ok']);
  assert.deepEqual(dueFollowUps(w.deps, w.clock.t).map((x) => x.enquiry.id).filter((id) => id === e.id), [e.id]);
});

test('N is configurable, and 0 means due straight away', async () => {
  const zero = world({ afterDays: 0 });
  const a = await sentQuote(zero);
  assert.equal(state(zero, a).due, true);
  const five = world({ afterDays: 5 });
  const b = await sentQuote(five);
  five.at(4.9);
  assert.equal(state(five, b).due, false);
  five.at(5);
  assert.equal(state(five, b).due, true);
});

test('not due: drafts, unsent quotes, and enquiries that are not in quoted/followed_up', async () => {
  const w = world({ afterDays: 0 });
  const draft = w.repos.enquiries.list().find((e) => e.customerName === 'Kavita Reddy'); // awaiting approval
  assert.equal(followupState(w.deps, draft, w.clock.t).reason, 'not_quoted');
  const won = w.repos.enquiries.list().find((e) => e.customerName === 'Sanjay Kulkarni');
  assert.equal(followupState(w.deps, won, w.clock.t).due, false);
});

test('cap: at most 2 reminders per quote, the second N days after the first', async () => {
  const w = world();
  const e = await sentQuote(w);
  w.at(2);
  assert.deepEqual(await sendReminder(w.deps, e.id), { channel: 'email', status: 'sent' });
  assert.equal(w.repos.enquiries.get(e.id).status, 'followed_up');
  assert.deepEqual([state(w, e).due, state(w, e).reason, state(w, e).sentCount], [false, 'waiting', 1]);
  await assert.rejects(() => sendReminder(w.deps, e.id), ConflictError);
  w.at(4);
  assert.equal((await sendReminder(w.deps, e.id)).status, 'sent');
  w.at(30);
  assert.deepEqual([state(w, e).due, state(w, e).reason, state(w, e).sentCount, state(w, e).show], [false, 'cap', 2, true]);
  await assert.rejects(() => sendReminder(w.deps, e.id), /Both reminders/);
  assert.equal(w.mailer.sent.filter((m) => m.to === 'meera@example.test').length, 3, 'quote + 2 reminders, never a third');
});

test('skipped when the customer accepted, declined, or has an open question', async () => {
  const w = world({ afterDays: 0 });
  const tokenOf = (e) => currentEstimate(w.repos, e.id).quoteToken;
  const accepted = await sentQuote(w, { name: 'Ann One' });
  const declined = await sentQuote(w, { name: 'Ben Two' });
  const asking = await sentQuote(w, { name: 'Cat Three' });
  assert.equal(state(w, accepted).due, true);
  await acceptQuote(w.deps, tokenOf(accepted));
  declineQuote(w.deps, tokenOf(declined), null);
  await askQuestion(w.deps, tokenOf(asking), 'Can you do Jain food?');
  assert.equal(state(w, accepted).due, false);
  assert.equal(state(w, declined).due, false);
  assert.deepEqual([state(w, asking).due, state(w, asking).reason, state(w, asking).show], [false, 'open_question', false]);
  for (const e of [accepted, declined, asking]) await assert.rejects(() => sendReminder(w.deps, e.id), ConflictError);
  const sentToCustomers = w.mailer.sent.filter((m) => /Ann|Ben|Cat/.test(m.html ?? '') && /Still planning|expires/.test(m.subject));
  assert.equal(sentToCustomers.length, 0);
});

test('a new quote version resets the reminder count', async () => {
  const w = world();
  const e = await sentQuote(w);
  w.at(2);
  await sendReminder(w.deps, e.id);
  w.at(4);
  await sendReminder(w.deps, e.id);
  w.at(10);
  assert.equal(state(w, e).reason, 'cap');
  // The owner replaces the quote: version 2, approved and sent.
  const v1 = currentEstimate(w.repos, e.id);
  w.repos.estimates.update(v1.id, { status: 'superseded' });
  createEstimate(w.repos, e.id, { now: w.clock.t, revisionReason: 'Guest count changed' });
  w.repos.enquiries.update(e.id, { status: 'awaiting_approval' });
  await approveAndSend(w.deps, e.id, 2);
  assert.deepEqual([state(w, e).reason, state(w, e).sentCount], ['waiting', 0]);
  w.at(12);
  assert.deepEqual([state(w, e).due, state(w, e).sentCount], [true, 0]);
  assert.equal((await sendReminder(w.deps, e.id)).status, 'sent');
  assert.equal(state(w, e).sentCount, 1);
});

test('mark as done hides the follow-up for that quote only', async () => {
  const w = world({ afterDays: 0 });
  const e = await sentQuote(w);
  assert.equal(state(w, e).due, true);
  markFollowupDone(w.deps, e.id);
  markFollowupDone(w.deps, e.id); // twice is fine
  assert.deepEqual([state(w, e).due, state(w, e).reason, state(w, e).show], [false, 'done', false]);
  assert.equal(dueFollowUps(w.deps, w.clock.t).some((x) => x.enquiry.id === e.id), false);
  await assert.rejects(() => sendReminder(w.deps, e.id), /marked as done/);
  // A new version is a fresh quote, so it comes back.
  w.repos.estimates.update(currentEstimate(w.repos, e.id).id, { status: 'superseded' });
  createEstimate(w.repos, e.id, { now: w.clock.t });
  w.repos.enquiries.update(e.id, { status: 'awaiting_approval' });
  await approveAndSend(w.deps, e.id, 2);
  assert.equal(state(w, e).due, true);
  const unsent = w.repos.enquiries.list().find((x) => x.customerName === 'Kavita Reddy');
  assert.throws(() => markFollowupDone(w.deps, unsent.id), ConflictError);
});

test('channel selection: email customers get an email; WhatsApp customers get a wa.me link and nothing is emailed', async () => {
  const w = world({ afterDays: 0 });
  const mailCustomer = await sentQuote(w, { name: 'Ila Rao' });
  const before = w.mailer.sent.length;
  const r = await sendReminder(w.deps, mailCustomer.id);
  assert.equal(r.channel, 'email');
  assert.equal(w.mailer.sent.length, before + 1);
  const mail = w.mailer.sent.at(-1);
  assert.equal(mail.to, 'meera@example.test');
  assert.equal(mail.subject, 'Still planning your Tue 15 Dec event?');
  assert.match(mail.text, /^Hi Ila,\n\nJust checking in on your veg buffet quote from Mehfil Kitchen for Tue 15 Dec\./);
  assert.ok(mail.text.includes(`https://liaisa.co.in/q/${currentEstimate(w.repos, mailCustomer.id).quoteToken}`));
  assert.match(mail.html, /View and accept your quote/);
  const emailRow = w.repos.emails.listByEnquiry(mailCustomer.id).find((m) => m.type === 'followup');
  assert.equal(emailRow.status, 'accepted');

  const wa = await sentQuote(w, { name: 'Dev Rao', channel: 'whatsapp', phone: '919845012345' });
  const sentBefore = w.mailer.sent.length;
  const res = await sendReminder(w.deps, wa.id);
  assert.equal(res.channel, 'whatsapp');
  assert.match(res.url, /^https:\/\/wa\.me\/919845012345\?text=Hi%20Dev%2C/);
  assert.equal(w.mailer.sent.length, sentBefore, 'nothing is emailed to a WhatsApp customer');
  const share = w.repos.whatsappShares.listByEnquiry(wa.id).find((s) => s.type === 'followup');
  const row = w.repos.followups.listByEnquiry(wa.id)[0];
  assert.deepEqual([row.status, row.channel, share.followupId], ['sent', 'whatsapp', row.id]);
  assert.equal(w.repos.enquiries.get(wa.id).status, 'followed_up');
});

test('the draft is a fixed template: name, service, date and quote link, no AI call, request cap untouched', async () => {
  const w = world();
  const e = await sentQuote(w);
  w.repos.enquiries.update(e.id, { aiRequestsUsed: 3 });
  w.at(2);
  const draft = draftReminder(w.deps, w.repos.enquiries.get(e.id), state(w, e));
  assert.match(draft.text, /^Hi Meera, just checking in on your veg buffet quote from Mehfil Kitchen for Tue 15 Dec\./);
  assert.ok(draft.text.includes('/q/'));
  assert.equal(w.deps.ai, undefined);
  await sendReminder(w.deps, e.id);
  assert.equal(w.repos.enquiries.get(e.id).aiRequestsUsed, 3);
  assert.equal(w.repos.aiCalls.listByEnquiry(e.id).length, 0);
  // The second reminder mentions validity.
  w.at(4);
  const second = draftReminder(w.deps, w.repos.enquiries.get(e.id), state(w, e));
  assert.match(second.subject, /^Your quote from Mehfil Kitchen expires on /);
  assert.match(second.text, /It’s valid until/);
});

test('email off or failing: the reminder is refused or recorded as failed, and does not count', async () => {
  const w = world({ afterDays: 0 });
  const e = await sentQuote(w);
  const mailer = w.deps.mailer;
  w.deps.mailer = null; // email switched off after the quote went out
  await assert.rejects(() => sendReminder(w.deps, e.id), /Email sending is switched off/);
  assert.equal(w.repos.followups.listByEnquiry(e.id).length, 0, 'nothing recorded');
  w.deps.mailer = mailer;
  w.mailer.fail = true;
  assert.deepEqual(await sendReminder(w.deps, e.id), { channel: 'email', status: 'failed' });
  assert.equal(w.repos.followups.listByEnquiry(e.id)[0].status, 'failed');
  assert.deepEqual([state(w, e).due, state(w, e).sentCount], [true, 0]);
  assert.equal(w.repos.enquiries.get(e.id).status, 'quoted');
  w.mailer.fail = false;
  assert.equal((await sendReminder(w.deps, e.id)).status, 'sent');
  assert.equal(state(w, e).sentCount, 1);
});

test('seeded demo quotes: with the default 2 days nobody is due yet; set to 0 and the sent quotes appear', () => {
  const w = world();
  assert.deepEqual(dueFollowUps(w.deps, T0), []);
  w.repos.businessSettings.save({ followupAfterDays: 0 });
  const names = dueFollowUps(w.deps, T0).map((x) => x.enquiry.customerName).sort();
  assert.deepEqual(names, ['Fatima Sheikh', 'Rohan Iyer']);
  const fatima = w.repos.enquiries.list().find((e) => e.customerName === 'Fatima Sheikh');
  assert.equal(followupState(w.deps, fatima, T0).sentCount, 1, 'the seeded reminder counts');
});
