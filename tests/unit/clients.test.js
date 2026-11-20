import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepos } from '../../src/container.js';
import { seed } from '../../src/seed.js';
import { createEstimate } from '../../src/services/estimates/createEstimate.js';
import { reconnectRows, leadRows, eventTypeOf, identityOf, blockOf } from '../../src/services/clients/people.js';

const DAY = 86400000;
const NOW = new Date('2026-12-01T10:00:00Z');
const ago = (days) => new Date(NOW.getTime() - days * DAY);
const iso = (days) => new Date(NOW.getTime() + days * DAY).toISOString().slice(0, 10);

/** Empty-ish world: seeded business + config, then only the enquiries each test adds. */
function world() {
  const repos = createRepos();
  seed(repos, { now: NOW });
  for (const e of repos.enquiries.list()) repos.enquiries.update(e.id, { status: 'declined' }); // park the seeded ones (owner-declined: never reconnected)
  return repos;
}
let n = 0;
/** One enquiry with a sent quote. opts: status, quoteAge (days), validDays (from now), eventDays (from now), text, email. */
function enquiry(repos, opts = {}) {
  n += 1;
  const e = repos.enquiries.create({
    customerName: opts.name ?? `Customer ${n}`, customerEmail: opts.email ?? `c${n}@example.test`, preferredChannel: 'email',
    rawText: opts.text ?? 'Veg lunch', status: opts.status ?? 'quoted', doNotContact: opts.doNotContact ?? false,
    requirementsJson: { service_id: 'veg_buffet', quantity: 40, event_date: iso(opts.eventDays ?? 30), location: 'Koramangala', ...(opts.notes ? { notes: opts.notes } : {}) },
  }, ago(opts.quoteAge ?? 10));
  if (opts.quote !== false) {
    const est = createEstimate(repos, e.id, { now: ago(opts.quoteAge ?? 10) });
    repos.estimates.update(est.id, { status: 'sent', approvedAt: ago(opts.quoteAge ?? 10), quoteToken: `t${n}`.padEnd(43, 'x'), validUntil: iso(opts.validDays ?? 7) });
  }
  for (const r of opts.responses ?? []) repos.customerResponses.create({ enquiryId: e.id, ...r }, ago(1));
  return repos.enquiries.get(e.id);
}
const rows = (repos) => reconnectRows({ repos }, NOW);
const byName = (repos, name) => rows(repos).find((r) => r.name === name);

test('selection: accepted, declined, expired and quiet customers are listed with a plain outcome', () => {
  const repos = world();
  enquiry(repos, { name: 'Won One', status: 'won', responses: [{ type: 'accept' }] });
  enquiry(repos, { name: 'Said No', status: 'lost', responses: [{ type: 'decline', message: 'Went elsewhere' }] });
  enquiry(repos, { name: 'Expired', status: 'quoted', validDays: -3, quoteAge: 12 });
  enquiry(repos, { name: 'Gone Quiet', status: 'followed_up', validDays: 5, quoteAge: 6 });
  enquiry(repos, { name: 'Lost No Reply', status: 'lost' });
  const got = Object.fromEntries(rows(repos).map((r) => [r.name, r.outcome.label]));
  assert.deepEqual(got, { 'Won One': 'Accepted', 'Said No': 'Declined', Expired: 'Quote expired', 'Gone Quiet': 'No reply', 'Lost No Reply': 'No reply' });
  const r = byName(repos, 'Won One');
  assert.deepEqual([r.service, r.channel, r.eventDate], ['Veg buffet', 'email', iso(30)]);
});

test('selection: active enquiries, owner declines, open questions and fresh quotes are not listed', () => {
  const repos = world();
  for (const status of ['collecting', 'needs_owner', 'awaiting_approval', 'declined', 'out_of_scope']) enquiry(repos, { name: `S ${status}`, status, quote: false });
  enquiry(repos, { name: 'Fresh quote', status: 'quoted', quoteAge: 1 });
  enquiry(repos, { name: 'Asking', status: 'quoted', quoteAge: 9, responses: [{ type: 'question', message: 'Jain food?' }] });
  enquiry(repos, { name: 'Replied', status: 'quoted', quoteAge: 9, responses: [{ type: 'question', message: 'x' }, { type: 'question', message: 'y' }] });
  assert.deepEqual(rows(repos), []);
});

test('one row per person: the latest enquiry decides, even across channels of the same email', () => {
  const repos = world();
  enquiry(repos, { name: 'Same Person', email: 'same@example.test', status: 'lost', quoteAge: 40 });
  enquiry(repos, { name: 'Same Person', email: 'SAME@example.test', status: 'won', quoteAge: 3, responses: [{ type: 'accept' }] });
  const list = rows(repos).filter((r) => r.name === 'Same Person');
  assert.equal(list.length, 1);
  assert.equal(list[0].outcome.code, 'accepted');
  // If the latest enquiry is still active, they are not listed even though an older one is closed.
  enquiry(repos, { name: 'Same Person', email: 'same@example.test', status: 'awaiting_approval', quote: false, quoteAge: 0 });
  assert.equal(rows(repos).filter((r) => r.name === 'Same Person').length, 0);
});

test('reasons: rule-based strings, in priority order', () => {
  const repos = world();
  enquiry(repos, { name: 'Soon Two Weeks', status: 'won', eventDays: 14, responses: [{ type: 'accept' }] });
  enquiry(repos, { name: 'Soon Three Days', status: 'won', eventDays: 3, responses: [{ type: 'accept' }] });
  enquiry(repos, { name: 'Soon One Week', status: 'won', eventDays: 7, responses: [{ type: 'accept' }] });
  enquiry(repos, { name: 'Long Ago', status: 'won', eventDays: -60, responses: [{ type: 'accept' }] });
  enquiry(repos, { name: 'Recent Won', status: 'won', eventDays: -5, responses: [{ type: 'accept' }] });
  enquiry(repos, { name: 'Discount Ask', status: 'lost', eventDays: 40, text: 'Can you give a discount? Veg lunch', responses: [{ type: 'decline' }] });
  enquiry(repos, { name: 'Discount But Won', status: 'won', eventDays: 40, text: 'any discount on a big order?', responses: [{ type: 'accept' }] });
  enquiry(repos, { name: 'Declined Plain', status: 'lost', eventDays: 40, responses: [{ type: 'decline' }] });
  enquiry(repos, { name: 'Expired Plain', status: 'quoted', eventDays: 40, validDays: -1, quoteAge: 9 });
  enquiry(repos, { name: 'Quiet Plain', status: 'quoted', eventDays: 40, validDays: 5, quoteAge: 6 });
  const reason = (name) => byName(repos, name).reason.text;
  assert.equal(reason('Soon Two Weeks'), 'event in 2 weeks');
  assert.equal(reason('Soon Three Days'), 'event in 3 days');
  assert.equal(reason('Soon One Week'), 'event in 1 week');
  assert.equal(reason('Long Ago'), 'last event was 8 weeks ago');
  assert.equal(reason('Recent Won'), 'recent customer');
  assert.equal(reason('Discount Ask'), 'asked about a discount');
  assert.equal(reason('Discount But Won'), 'recent customer', 'a discount mention only matters when they did not accept');
  assert.equal(reason('Declined Plain'), 'declined the last quote');
  assert.equal(reason('Expired Plain'), 'quote expired');
  assert.equal(reason('Quiet Plain'), 'no reply to the quote');
});

test('event type comes only from the customer’s own words', () => {
  assert.equal(eventTypeOf('We are planning a housewarming for 40'), 'housewarming');
  assert.equal(eventTypeOf("my daughter's engagement"), 'engagement');
  assert.equal(eventTypeOf('Office lunch for 15'), 'office event');
  assert.equal(eventTypeOf('Veg buffet for 40 people'), null);
  const repos = world();
  enquiry(repos, { name: 'Has Type', status: 'won', text: 'Birthday lunch', responses: [{ type: 'accept' }] });
  enquiry(repos, { name: 'No Type', status: 'won', text: 'Veg lunch', responses: [{ type: 'accept' }] });
  assert.equal(byName(repos, 'Has Type').eventType, 'birthday');
  assert.equal(byName(repos, 'No Type').eventType, null);
});

test('do not contact: the flag on any of a person’s enquiries blocks them; leads too', () => {
  const repos = world();
  enquiry(repos, { name: 'Flagged', email: 'dnc@example.test', status: 'lost', responses: [{ type: 'decline' }], doNotContact: true });
  enquiry(repos, { name: 'Other Enquiry Flagged', email: 'dnc2@example.test', status: 'lost', quoteAge: 50, doNotContact: true });
  enquiry(repos, { name: 'Other Enquiry Flagged', email: 'dnc2@example.test', status: 'won', quoteAge: 5, responses: [{ type: 'accept' }] });
  enquiry(repos, { name: 'Fine', status: 'won', responses: [{ type: 'accept' }] });
  assert.equal(byName(repos, 'Flagged').block.code, 'do_not_contact');
  assert.equal(byName(repos, 'Other Enquiry Flagged').block.code, 'do_not_contact');
  assert.equal(byName(repos, 'Fine').block, null);
  repos.leads.create({ name: 'Lead Flag', email: 'dnc@example.test', note: 'x' }, NOW);
  repos.leads.create({ name: 'Lead Own Flag', phone: '919845012345', note: 'x', doNotContact: true }, NOW);
  repos.leads.create({ name: 'Lead Ok', email: 'ok@example.test', note: 'x' }, NOW);
  const leads = Object.fromEntries(leadRows({ repos }, NOW).map((l) => [l.name, l.block?.code ?? null]));
  assert.deepEqual(leads, { 'Lead Flag': 'do_not_contact', 'Lead Own Flag': 'do_not_contact', 'Lead Ok': null });
});

test('7-day rule: sent or opened messages and sent reminders block; older ones and failures do not', () => {
  const repos = world();
  const person = enquiry(repos, { name: 'Contacted', email: 'contacted@example.test', status: 'won', responses: [{ type: 'accept' }] });
  const key = identityOf({ email: 'contacted@example.test', channel: 'email' });
  const out = (status, days) => repos.outreach.create({ subjectType: 'customer', key, channel: 'email', status, message: 'x', sentAt: ago(days) }, ago(days));
  assert.equal(byName(repos, 'Contacted').block, null);
  out('failed', 1);
  assert.equal(byName(repos, 'Contacted').block, null, 'a failed send is not a contact');
  out('sent', 8);
  assert.equal(byName(repos, 'Contacted').block, null, '8 days ago is fine');
  const recent = out('sent', 3);
  const b = byName(repos, 'Contacted').block;
  assert.equal(b.code, 'recent');
  assert.equal(b.until.getTime(), ago(3).getTime() + 7 * DAY);
  assert.match(b.text, /^Contacted recently\. Wait until \w{3} \d+ \w{3}\.$/);
  repos.outreach.update(recent.id, { status: 'opened' });
  assert.equal(byName(repos, 'Contacted').block.code, 'recent', 'opened in WhatsApp counts');
  repos.outreach.update(recent.id, { status: 'failed' });
  assert.equal(byName(repos, 'Contacted').block, null);
  // A follow-up reminder that went out counts too.
  repos.followups.create({ enquiryId: person.id, step: 1, dueAt: ago(2), channel: 'email', status: 'sent', sentAt: ago(2) }, ago(2));
  assert.equal(byName(repos, 'Contacted').block.code, 'recent');
  assert.equal(blockOf(repos, 'e:nobody@example.test', [], NOW), null);
});

test('a lead is blocked by the same 7-day rule, including contact made as a customer', () => {
  const repos = world();
  repos.leads.create({ name: 'New Lead', email: 'lead@example.test', note: 'HR manager' }, ago(1));
  const key = identityOf({ email: 'lead@example.test', channel: 'email' });
  assert.equal(leadRows({ repos }, NOW)[0].block, null);
  repos.outreach.create({ subjectType: 'lead', key, channel: 'email', status: 'sent', message: 'x', sentAt: ago(2) }, ago(2));
  assert.equal(leadRows({ repos }, NOW)[0].block.code, 'recent');
});
