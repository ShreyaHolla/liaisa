// M7b: what a business-setup edit changes for new enquiries (prompt, form, emails, quote page) and the past-date rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, START, newest } from '../helpers/agentApp.js';
import { setupOwner, login, byName } from '../helpers/ownerApp.js';
import { scenarios, step } from '../../src/ai/mockClient.js';
import { makeSetupSchema } from '../../src/services/setup/schema.js';
import { saveSetup, currentSetup } from '../../src/services/setup/businessSetup.js';

const schema = makeSetupSchema('91');
/** Apply an edit to a repos object the way the setup page does (validate, then save). */
function edit(repos, over = {}) {
  const cur = currentSetup(repos);
  const input = schema.parse({ ...cur, whatsappNumber: cur.whatsappNumber, ...over });
  saveSetup(repos, input, '91');
}
const systemText = (ai) => ai.calls[0].system[0].text;
const post = (app, body = START) => request(app).post('/b/mehfil-kitchen/api/enquiries').send(body);

test('the agent prompt includes the edited business name, services and areas, not the old ones', async () => {
  const { app, repos, ai } = setup({ steps: scenarios.needs_info() });
  edit(repos, {
    businessName: 'Spice Route',
    services: [{ id: '', name: 'Chaat counter', price: '3000', minQty: '2', maxQty: '', unitLabel: 'Hours' }],
    areas: [{ name: 'Hebbal', fee: '800' }],
  });
  await post(app);
  const text = systemText(ai);
  assert.match(text, /enquiry assistant for Spice Route/);
  assert.match(text, /"id":"chaat_counter","name":"Chaat counter"/);
  assert.match(text, /"quantity_is":"Hours"/);
  assert.match(text, /"areas":\["Hebbal"\]/);
  assert.ok(!/Veg buffet|Koramangala|Mehfil|veg_buffet/.test(text), 'no demo values leak into the prompt');
  assert.match(text, /means "Hebbal"/, 'worked examples use the edited area');
  assert.match(text, /Chaat counter for 140 hours in Hebbal, lovely!/);
});

test('with the demo business the prompt examples read as before', async () => {
  const { app, ai } = setup({ steps: scenarios.needs_info() });
  await post(app);
  const text = systemText(ai);
  assert.match(text, /Veg buffet for 140 guests in Koramangala, lovely!/);
  assert.match(text, /"Kormangala" or "5th Block Kormangala" means "Koramangala"/);
  assert.match(text, /for example veg buffet or non-veg buffet/);
});

test('the enquiry form label follows the selected service’s unit label (default: Number of guests)', async () => {
  const { app, repos } = setup({ env: { AI_ENABLED: 'false' } });
  const html = (res) => res.text;
  const start = await request(app).post('/b/mehfil-kitchen/api/enquiries').set('Accept', 'text/html').type('form').send({ ...START, name: 'Meera' });
  assert.match(html(start), /id="quantity-label">Number of guests</);
  assert.match(html(start), /<option value="live_counter" data-unit="Hours"/);
  assert.ok(!/hours for live counters/i.test(html(start)));
  assert.match((await request(app).get('/b/mehfil-kitchen/enquire')).text, /placeholder="e\.g\. Veg buffet for 40 guests on 13 Dec, in Koramangala"/);

  edit(repos, { services: [{ id: 'veg_buffet', name: 'Veg buffet', price: '450', minQty: '20', maxQty: '', unitLabel: 'Plates' }] });
  const again = await request(app).post('/b/mehfil-kitchen/api/enquiries').set('Accept', 'text/html').type('form').send({ ...START, name: 'Meera' });
  assert.match(html(again), /data-unit="Plates"/);
  assert.match((await request(app).get('/b/mehfil-kitchen/enquire')).text, /placeholder="e\.g\. Veg buffet for 40 plates on 13 Dec/);
});

test('a service with no unit label falls back to the pricing unit (per-hour services say Hours)', async () => {
  const { app, repos } = setup({ env: { AI_ENABLED: 'false' } });
  const cfg = structuredClone(repos.pricingConfigs.latestApproved().configJson);
  for (const s of cfg.services) delete s.unit_label;
  repos.pricingConfigs.publish(cfg);
  const res = await request(app).post('/b/mehfil-kitchen/api/enquiries').set('Accept', 'text/html').type('form').send({ ...START, name: 'Meera' });
  assert.match(res.text, /<option value="live_counter" data-unit="Hours"/);
  assert.match(res.text, /<option value="veg_buffet" data-unit="Number of guests"/);
});

test('a date in the past is not assumed to be next year: the customer is asked again, no quote yet', async () => {
  const past = { ...scenarios.ready()[0].content[0].input, event_date: '2020-03-05' };
  const { app, repos } = setup({ steps: scenarios.ready(past) });
  const res = await post(app);
  assert.equal(res.status, 201);
  assert.equal(res.body.outcome, 'needs_info');
  assert.match(res.body.question, /That date, Thu 5 Mar, has already passed\. Which date did you mean\?/);
  const e = newest(repos);
  assert.equal(e.status, 'collecting');
  assert.equal(e.requirementsJson.event_date, undefined);
  assert.deepEqual(e.missingFieldsJson, ['event_date']);
  assert.equal(repos.estimates.listByEnquiry(e.id).length, 0);
  assert.equal(e.aiState.questionsAsked, 1);
});

test('past date plus other missing details: the server question asks for those too', async () => {
  const steps = [step.finish({ status: 'needs_info', requirements: { service_id: 'veg_buffet', event_date: '2020-03-05' }, missing_fields: ['quantity', 'location'], question_to_customer: 'How many and where?', summary_for_owner: 'x' })];
  const { app } = setup({ steps });
  const res = await post(app);
  assert.equal(res.body.outcome, 'needs_info');
  assert.match(res.body.question, /has already passed.*Please also tell us how many, which area\./);
});

test('today or a later date is accepted; a past date answered with a future one completes the enquiry', async () => {
  const { app, repos } = setup({ steps: [...scenarios.ready({ service_id: 'veg_buffet', quantity: 40, event_date: '2020-03-05', location: 'Koramangala' }), ...scenarios.ready({ service_id: 'veg_buffet', quantity: 40, event_date: '2099-12-13', location: 'Koramangala' })] });
  const first = await post(app);
  assert.equal(first.body.outcome, 'needs_info');
  const reply = await request(app).post(`/b/mehfil-kitchen/api/enquiries/${first.body.publicId}/reply`).send({ answer: '13 Dec 2099' });
  assert.equal(reply.body.outcome, 'ready');
  assert.equal(newest(repos).requirementsJson.event_date, '2099-12-13');
});

test('the fallback form refuses a past date with a message on the date field', async () => {
  const { app } = setup({ env: { AI_ENABLED: 'false' } });
  const start = await post(app);
  const res = await request(app).post(`/b/mehfil-kitchen/api/enquiries/${start.body.publicId}/form`).send({ service_id: 'veg_buffet', quantity: 40, event_date: '2020-03-05', location: 'Koramangala' });
  assert.equal(res.status, 400);
  assert.match(res.body.error.fields.event_date, /already passed/);
});

test('the currency symbol is display only: emails, quote page and owner pages use it; stored amounts do not change', async () => {
  const ctx = setupOwner();
  const o = await login(ctx.app);
  const kavita = byName(ctx.repos, 'Kavita Reddy');
  const total = ctx.repos.estimates.listByEnquiry(kavita.id)[0].total;
  edit(ctx.repos, { currencySymbol: 'Rs.' });
  assert.equal(ctx.repos.estimates.listByEnquiry(kavita.id)[0].total, total);
  await o.postJson(`/owner/enquiries/${kavita.id}/approve`, { estimateVersion: 1 });
  const mail = ctx.mailer.sent[0];
  assert.match(mail.subject, /^Your quote from Mehfil Kitchen: Rs\.[\d,]+$/);
  assert.ok(!mail.text.includes('₹') && !mail.html.includes('₹'));
  const token = ctx.repos.estimates.listByEnquiry(kavita.id)[0].quoteToken;
  const page = await request(ctx.app).get(`/b/mehfil-kitchen/q/${token}`);
  assert.match(page.text, /Rs\.[\d,]+/);
  assert.ok(!page.text.includes('₹'));
  assert.match((await o.get(`/owner/enquiries/${kavita.id}`)).text, /Rs\.[\d,]+/);
});

test('the business WhatsApp number shows on the quote page only when set', async () => {
  const ctx = setupOwner();
  const o = await login(ctx.app);
  const kavita = byName(ctx.repos, 'Kavita Reddy');
  await o.postJson(`/owner/enquiries/${kavita.id}/approve`, { estimateVersion: 1 });
  const token = ctx.repos.estimates.listByEnquiry(kavita.id)[0].quoteToken;
  assert.ok(!(await request(ctx.app).get(`/b/mehfil-kitchen/q/${token}`)).text.includes('wa.me'));
  edit(ctx.repos, { whatsappNumber: '98450 12345' });
  const page = await request(ctx.app).get(`/b/mehfil-kitchen/q/${token}`);
  assert.match(page.text, /href="https:\/\/wa\.me\/919845012345">Message Mehfil Kitchen on WhatsApp</);
});

test('removing a service never breaks existing enquiries: pages render and a saved quote still approves', async () => {
  const ctx = setupOwner();
  const o = await login(ctx.app);
  const arjun = byName(ctx.repos, 'Arjun Mehta'); // non-veg buffet, draft quote
  edit(ctx.repos, { services: [{ id: 'veg_buffet', name: 'Veg buffet', price: '450', minQty: '20', maxQty: '200', unitLabel: 'Number of guests' }] });
  assert.equal((await o.get('/owner')).status, 200);
  const detail = await o.get(`/owner/enquiries/${arjun.id}`);
  assert.equal(detail.status, 200);
  assert.match(detail.text, /Fewer guests \(15\) than this service’s minimum \(20\)\./, 'warnings use the config the quote was priced with');
  const res = await o.postJson(`/owner/enquiries/${arjun.id}/approve`, { estimateVersion: 1 });
  assert.equal(res.status, 200);
  assert.equal(res.body.estimateStatus, 'sent');
  const ids = ctx.repos.pricingConfigs.latestApproved().configJson.addons.map((a) => a.id);
  assert.deepEqual(ids, ['dessert', 'staff'], 'add-ons are untouched by service edits');
});
