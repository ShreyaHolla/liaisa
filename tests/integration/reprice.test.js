// "Reprice with current prices" on open drafts.
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupOwner, login, byName, estimateOf } from '../helpers/ownerApp.js';
import { makeSetupSchema } from '../../src/services/setup/schema.js';
import { currentSetup, saveSetup } from '../../src/services/setup/businessSetup.js';
import { calculateEstimate } from '../../src/services/pricing/calculateEstimate.js';

const schema = makeSetupSchema('91');
/** The owner changes prices on Business setup (a new published config). */
function raisePrices(repos, { veg = '500', tax = '5' } = {}) {
  const cur = currentSetup(repos);
  saveSetup(repos, schema.parse({
    ...cur, taxPct: tax,
    services: cur.services.map((s) => (s.id === 'veg_buffet' ? { ...s, price: veg } : s)),
  }), '91');
}
async function world(opts) {
  const ctx = setupOwner(opts);
  return { ...ctx, o: await login(ctx.app), kavita: byName(ctx.repos, 'Kavita Reddy') };
}
const reprice = (ctx, e = ctx.kavita) => ctx.o.postJson(`/owner/enquiries/${e.id}/reprice`);

test('a draft reprices with the latest published config: a new version linked to it, the old one superseded', async () => {
  const ctx = await world();
  const before = estimateOf(ctx.repos, ctx.kavita);
  raisePrices(ctx.repos, { veg: '500' });
  const latest = ctx.repos.pricingConfigs.latestApproved();
  assert.notEqual(before.pricingConfigId, latest.id);
  const res = await reprice(ctx);
  assert.equal(res.status, 200);
  const expected = calculateEstimate(latest.configJson, ctx.kavita.requirementsJson);
  assert.equal(res.body.total, expected.total);
  assert.notEqual(expected.total, before.total, 'the prices really changed');
  assert.deepEqual([res.body.before, res.body.after, res.body.version, res.body.status], [before.total, expected.total, 2, 'draft']);
  assert.equal(res.body.revisionReason, 'Repriced with current prices');
  const all = ctx.repos.estimates.listByEnquiry(ctx.kavita.id);
  assert.deepEqual(all.map((e) => e.status), ['superseded', 'draft']);
  assert.equal(all[1].pricingConfigId, latest.id);
  assert.equal(all[0].total, before.total, 'the old version keeps its numbers');
  assert.equal(ctx.repos.enquiries.get(ctx.kavita.id).status, 'awaiting_approval');
  assert.equal(ctx.mailer.sent.length, 0, 'repricing sends nothing');
});

test('it is logged in Activity and the page confirms the before and after totals', async () => {
  const ctx = await world();
  const before = estimateOf(ctx.repos, ctx.kavita).total;
  raisePrices(ctx.repos);
  const res = await ctx.o.postForm(`/owner/enquiries/${ctx.kavita.id}/reprice`);
  assert.equal(res.status, 303);
  const after = estimateOf(ctx.repos, ctx.kavita).total;
  assert.equal(res.headers.location, `/owner/enquiries/${ctx.kavita.id}?n=repriced&b=${before}&a=${after}`);
  const page = await ctx.o.get(res.headers.location);
  assert.match(page.text, new RegExp(`Repriced with current prices: ₹${before.toLocaleString('en-IN')} to ₹${after.toLocaleString('en-IN')}\\.`));
  assert.match(page.text, /<li>Repriced with current prices \(₹[\d,]+ to ₹[\d,]+\) · just now<\/li>/);
  assert.match(page.text, /Quote \(draft v2\)/);
  assert.match(page.text, /Changed because: Repriced with current prices/);
  assert.equal(ctx.repos.activity.listByEnquiry(ctx.kavita.id).length, 1);
  // The notice only shows numbers, never free text from the URL.
  const spoof = await ctx.o.get(`/owner/enquiries/${ctx.kavita.id}?n=repriced&b=<script>&a=9`);
  assert.ok(!spoof.text.includes('<script>'));
  assert.match(spoof.text, /Repriced with current prices\./);
});

test('the owner’s discount and note are kept, and the total is the engine’s number with them', async () => {
  const ctx = await world();
  await ctx.o.postJson(`/owner/enquiries/${ctx.kavita.id}/edit`, {
    requirements: ctx.kavita.requirementsJson, discount: { amount: 500, reason: 'Repeat customer' }, note: 'Includes setup time', revisionReason: 'Loyalty',
  });
  raisePrices(ctx.repos);
  const res = await reprice(ctx);
  assert.equal(res.status, 200);
  const line = res.body.lineItems.find((l) => l.kind === 'discount');
  assert.deepEqual([line.amount, line.reason], [-500, 'Repeat customer']);
  const latest = ctx.repos.pricingConfigs.latestApproved().configJson;
  assert.equal(res.body.total, calculateEstimate(latest, ctx.kavita.requirementsJson, { discount: { amount: 500, reason: 'Repeat customer' } }).total);
  assert.equal(estimateOf(ctx.repos, ctx.kavita).noteForCustomer, 'Includes setup time');
  assert.equal(estimateOf(ctx.repos, ctx.kavita).version, 3);
});

test('a quote that already uses the current prices is not repriced again', async () => {
  const ctx = await world();
  const none = await reprice(ctx);
  assert.deepEqual([none.status, none.body.error.code], [409, 'already_current']);
  assert.equal(ctx.repos.estimates.listByEnquiry(ctx.kavita.id).length, 1);
  raisePrices(ctx.repos);
  assert.equal((await reprice(ctx)).status, 200);
  assert.equal((await reprice(ctx)).status, 409, 'the second press finds nothing to change');
  assert.equal(ctx.repos.estimates.listByEnquiry(ctx.kavita.id).length, 2);
  const html = await ctx.o.postForm(`/owner/enquiries/${ctx.kavita.id}/reprice`);
  assert.equal(html.headers.location, `/owner/enquiries/${ctx.kavita.id}?n=already_current`);
  assert.match((await ctx.o.get(html.headers.location)).text, /This quote already uses your current prices\./);
});

test('sent, approved, accepted, declined and lost quotes are never repriced', async () => {
  const ctx = await world();
  raisePrices(ctx.repos);
  const rohan = byName(ctx.repos, 'Rohan Iyer'); // quoted, sent
  const sanjay = byName(ctx.repos, 'Sanjay Kulkarni'); // accepted
  const neha = byName(ctx.repos, 'Neha Banerjee'); // lost
  const sentTotal = estimateOf(ctx.repos, rohan).total;
  for (const e of [rohan, sanjay, neha]) {
    const res = await reprice(ctx, e);
    assert.equal(res.status, 409, e.customerName);
    assert.equal(ctx.repos.estimates.listByEnquiry(e.id).every((x) => x.status !== 'draft'), true);
  }
  assert.equal(estimateOf(ctx.repos, rohan).total, sentTotal);
  assert.equal(ctx.repos.estimates.listByEnquiry(rohan.id).length, 1);

  // Approve one in Liaisa (sent), then try; and an approved-but-not-sent quote (email off style).
  await ctx.o.postJson(`/owner/enquiries/${ctx.kavita.id}/approve`, { estimateVersion: 1 });
  const sentRes = await reprice(ctx);
  assert.equal(sentRes.status, 409);
  assert.match(sentRes.body.error.message, /hasn’t been sent yet/);
  assert.equal(ctx.repos.estimates.listByEnquiry(ctx.kavita.id).length, 1);

  const off = await world({ mail: 'off' });
  raisePrices(off.repos);
  await off.o.postJson(`/owner/enquiries/${off.kavita.id}/approve`, { estimateVersion: 1 });
  assert.equal(estimateOf(off.repos, off.kavita).status, 'approved');
  assert.equal((await reprice(off)).status, 409, 'approved quotes have a token and may already be shared');

  const declined = await world();
  raisePrices(declined.repos);
  await declined.o.postJson(`/owner/enquiries/${declined.kavita.id}/decline`);
  assert.equal((await reprice(declined)).status, 409);
});

test('the button shows on open drafts only; the reprice route needs the owner session and a CSRF token', async () => {
  const ctx = await world();
  const draft = await ctx.o.get(`/owner/enquiries/${ctx.kavita.id}`);
  assert.match(draft.text, /<button class="btn secondary" type="submit">Reprice with current prices<\/button>/);
  assert.match(draft.text, /action="\/owner\/enquiries\/\d+\/reprice"/);
  const sent = await ctx.o.get(`/owner/enquiries/${byName(ctx.repos, 'Rohan Iyer').id}`);
  assert.ok(!sent.text.includes('Reprice with current prices'));
  const url = `/owner/enquiries/${ctx.kavita.id}/reprice`;
  raisePrices(ctx.repos);
  assert.equal((await request(ctx.app).post(url).type('form').send({})).status, 302);
  assert.equal((await request(ctx.app).post(url).set('Cookie', ctx.o.cookie).type('form').send({})).status, 403);
  assert.equal((await request(ctx.app).get(url).set('Cookie', ctx.o.cookie)).status, 404, 'POST only');
  assert.equal(estimateOf(ctx.repos, ctx.kavita).version, 1, 'nothing changed');
  assert.equal((await ctx.o.postJson('/owner/enquiries/9999/reprice')).status, 404);
});

test('if the new prices cannot price the quote (service removed), the quote is left unchanged with a clear message', async () => {
  const ctx = await world();
  const cur = currentSetup(ctx.repos);
  saveSetup(ctx.repos, schema.parse({ ...cur, services: cur.services.filter((s) => s.id !== 'veg_buffet') }), '91');
  const res = await reprice(ctx);
  assert.equal(res.status, 400);
  assert.equal(ctx.repos.estimates.listByEnquiry(ctx.kavita.id).length, 1);
  assert.equal(estimateOf(ctx.repos, ctx.kavita).status, 'draft');
  assert.equal(ctx.repos.activity.listByEnquiry(ctx.kavita.id).length, 0);
  const html = await ctx.o.postForm(`/owner/enquiries/${ctx.kavita.id}/reprice`);
  assert.equal(html.headers.location, `/owner/enquiries/${ctx.kavita.id}?n=reprice_failed`);
  assert.match((await ctx.o.get(html.headers.location)).text, /couldn’t be repriced with the current prices/);
});
