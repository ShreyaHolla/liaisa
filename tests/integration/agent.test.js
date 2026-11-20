import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, START, newest } from '../helpers/agentApp.js';
import { scenarios, step, REQ_READY } from '../../src/ai/mockClient.js';
import { calculateEstimate } from '../../src/services/pricing/calculateEstimate.js';
import { DEMO_PRICING_CONFIG } from '../../src/seed.js';
import { runTurn } from '../../src/services/agent/runTurn.js';

const post = (app, body = START) => request(app).post('/api/enquiries').send(body);

test('TC-AGT-01 ready on first turn: server-priced draft, no price shown, 2 requests', async () => {
  const { app, repos, ai } = setup({ steps: scenarios.ready() });
  const res = await post(app);
  assert.equal(res.status, 201);
  assert.equal(res.body.outcome, 'ready');
  assert.equal(res.body.understood.serviceName, 'Veg buffet');

  const e = newest(repos);
  assert.equal(e.status, 'awaiting_approval');
  assert.equal(e.aiRequestsUsed, 2);
  assert.equal(ai.calls.length, 2);
  const [est] = repos.estimates.listByEnquiry(e.id);
  assert.equal(est.status, 'draft');
  const expected = calculateEstimate(DEMO_PRICING_CONFIG, REQ_READY);
  assert.equal(est.total, expected.total);
  assert.deepEqual(est.lineItemsJson, expected.lineItems);
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes(String(est.total)) && !/₹|total|price/i.test(text), 'no price in the response');
});

test('TC-AGT-02 needs_info: question shown, enquiry stays collecting, state saved', async () => {
  const { app, repos } = setup({ steps: scenarios.needs_info() });
  const res = await post(app);
  assert.equal(res.body.outcome, 'needs_info');
  assert.equal(res.body.question, 'Lovely! Which date is it, and which area?');
  const e = newest(repos);
  assert.equal(e.status, 'collecting');
  assert.equal(e.aiState.questionsAsked, 1);
  assert.deepEqual(e.aiState.history.map((h) => h.role), ['customer', 'agent']);
  assert.equal(repos.estimates.listByEnquiry(e.id).length, 0);
});

test('TC-AGT-03 reply after needs_info resumes from saved state and ends awaiting_approval', async () => {
  const { app, repos, ai } = setup({ steps: [scenarios.needs_info(), scenarios.ready()] });
  const first = await post(app);
  const res = await request(app).post(`/api/enquiries/${first.body.publicId}/reply`).send({ answer: '13 Dec, Koramangala' });
  assert.equal(res.status, 200);
  assert.equal(res.body.outcome, 'ready');
  assert.equal(newest(repos).status, 'awaiting_approval');
  // Request 2 carried the first message, the question and the answer.
  const resumed = ai.calls[1].messages;
  assert.equal(resumed.length, 3);
  assert.match(resumed[1].content, /Which date/);
  assert.match(resumed[2].content, /13 Dec, Koramangala/);
});

test('TC-AGT-04 out_of_scope: status set, friendly message, no estimate', async () => {
  const { app, repos } = setup({ steps: scenarios.out_of_scope() });
  const res = await post(app, { ...START, description: 'A wedding cake for 100 people' });
  assert.equal(res.body.outcome, 'out_of_scope');
  assert.match(res.body.message, /Mehfil Kitchen/);
  const e = newest(repos);
  assert.equal(e.status, 'out_of_scope');
  assert.equal(repos.estimates.listByEnquiry(e.id).length, 0);
});

test('TC-AGT-05 invalid finish_intake once, then valid: one retry, success', async () => {
  const { app, repos, ai } = setup({ steps: [scenarios.invalid_json(), scenarios.ready()] });
  const res = await post(app);
  assert.equal(res.body.outcome, 'ready');
  assert.equal(ai.calls.length, 3);
  assert.equal(newest(repos).status, 'awaiting_approval');
});

test('TC-AGT-06 invalid twice: fallback form pre-filled with anything valid', async () => {
  const bad = () => step.finish({ status: 'bogus', requirements: { service_id: 'veg_buffet', quantity: 40, event_date: 123 } });
  const { app, repos } = setup({ steps: [bad(), bad()] });
  const res = await post(app);
  assert.equal(res.body.outcome, 'fallback');
  assert.deepEqual(res.body.prefill, { service_id: 'veg_buffet', quantity: 40 });
  assert.equal(newest(repos).status, 'needs_owner');
});

test('TC-AGT-07 requests used reaches 4: no 5th call, fallback', async () => {
  const { repos, ai, config } = setup({ steps: scenarios.ready() });
  const e = repos.enquiries.create({
    customerName: 'T', customerEmail: 'a@example.test', preferredChannel: 'email', rawText: 'x', status: 'collecting', aiRequestsUsed: 3,
  });
  const out = await runTurn({ repos, ai, config }, e.id, 'Veg lunch for 40');
  assert.equal(out.outcome, 'fallback');
  assert.equal(ai.calls.length, 1); // the 4th request ran (calculate_estimate); the 5th never did
  assert.equal(repos.enquiries.get(e.id).aiRequestsUsed, 4);
});

test('TC-AGT-08 a third question is never asked: max 2, then fallback', async () => {
  const { app, repos } = setup({ steps: [scenarios.needs_info(), scenarios.needs_info(), scenarios.needs_info()] });
  const first = await post(app);
  const url = `/api/enquiries/${first.body.publicId}/reply`;
  assert.equal((await request(app).post(url).send({ answer: 'soon' })).body.outcome, 'needs_info');
  const third = await request(app).post(url).send({ answer: 'not sure' });
  assert.equal(third.body.outcome, 'fallback');
  assert.equal(newest(repos).status, 'needs_owner');
});

test('TC-AGT-09 API error: one retry then success; two errors then fallback, owner still sees it', async () => {
  const a = setup({ steps: [scenarios.api_error(), scenarios.ready()] });
  assert.equal((await post(a.app)).body.outcome, 'ready');

  const b = setup({ steps: [scenarios.api_error(), scenarios.api_error()] });
  const res = await post(b.app);
  assert.equal(res.status, 201);
  assert.equal(res.body.outcome, 'fallback');
  assert.equal(newest(b.repos).status, 'needs_owner');
  assert.equal(b.ai.calls.length, 2);
});

test('TC-AGT-10 model claims a wrong total: saved estimate uses the server total', async () => {
  const lie = step.finish({
    status: 'ready', requirements: REQ_READY, missing_fields: [], summary_for_owner: 'Total ₹100 for everything.', total: 100, estimate: { total: 100 },
  });
  const { app, repos } = setup({ steps: [step.calc(REQ_READY), lie] });
  await post(app);
  const [est] = repos.estimates.listByEnquiry(newest(repos).id);
  assert.equal(est.total, calculateEstimate(DEMO_PRICING_CONFIG, REQ_READY).total);
  assert.notEqual(est.total, 100);
});

test('TC-AGT-11 prompt has the text in <customer_message> and no name, email or phone', async () => {
  const { app, ai } = setup({ steps: scenarios.ready() });
  await post(app, { ...START, channel: 'whatsapp', phone: '98450 12345' });
  const sent = JSON.stringify(ai.calls[0]);
  assert.match(sent, /<customer_message>Veg lunch for 40 people on 13 Dec in Koramangala<\/customer_message>/);
  for (const secret of ['Priya', 'Nair', 'priya@example.test', '98450', '9845012345', '919845012345']) {
    assert.ok(!sent.includes(secret), `prompt leaks ${secret}`);
  }
});

test('TC-AGT-12 description over 1,000 chars: 400 before any Claude call', async () => {
  const { app, ai } = setup({ steps: scenarios.ready() });
  const res = await post(app, { ...START, description: 'a'.repeat(1001) });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'validation_error');
  assert.match(res.body.error.fields.description, /under 1,000 characters/);
  assert.equal(ai.calls.length, 0);
});

test('TC-AGT-13 channel needs its contact detail', async () => {
  const { app, ai, repos } = setup({ steps: scenarios.ready() });
  const before = repos.enquiries.list().length;
  const noEmail = await post(app, { name: 'A', channel: 'email', description: START.description });
  assert.equal(noEmail.status, 400);
  assert.ok(noEmail.body.error.fields.email);
  const noPhone = await post(app, { name: 'A', channel: 'whatsapp', description: START.description });
  assert.ok(noPhone.body.error.fields.phone);
  const badPhone = await post(app, { name: 'A', channel: 'whatsapp', phone: '12345', description: START.description });
  assert.equal(badPhone.body.error.fields.phone, 'Enter a 10-digit mobile number, like 98450 12345.');
  assert.equal(ai.calls.length, 0);
  assert.equal(repos.enquiries.list().length, before);
});

test('TC-AGT-15 requests_used is incremented before the call', async () => {
  let ctx;
  let seen = null;
  const probe = () => {
    seen = newest(ctx.repos).aiRequestsUsed;
    return step.error(500);
  };
  ctx = setup({ steps: [probe, probe] });
  await post(ctx.app);
  assert.equal(seen, 2); // read inside the second call: both attempts were counted first
});

test('form-encoded post from the page without JS renders HTML and never shows a price', async () => {
  const { app } = setup({ steps: scenarios.ready() });
  const res = await request(app).post('/api/enquiries').set('Accept', 'text/html').type('form').send(START);
  assert.equal(res.status, 201);
  assert.match(res.text, /Thanks, Priya\. Your enquiry is with Mehfil Kitchen\./);
  assert.match(res.text, /Veg buffet/);
  assert.ok(!/₹/.test(res.text));
});

test('GET /enquire renders step 1; home links to it', async () => {
  const { app } = setup();
  const page = await request(app).get('/enquire');
  assert.equal(page.status, 200);
  assert.match(page.text, /Tell us what you need/);
  assert.match(page.text, /Send enquiry/);
  const home = await request(app).get('/');
  assert.match(home.text, /href="\/enquire"[^>]*>Try the demo enquiry/);
});

test('auto mock (dev default) handles a complete message end to end', async () => {
  const { app, repos } = setup();
  const res = await post(app);
  assert.equal(res.body.outcome, 'ready');
  assert.equal(newest(repos).status, 'awaiting_approval');
});
