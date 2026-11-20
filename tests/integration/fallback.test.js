import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, START, newest } from '../helpers/agentApp.js';
import { scenarios } from '../../src/ai/mockClient.js';
import { dailyCallCount } from '../../src/services/agent/guards.js';

const post = (app, body = START) => request(app).post('/b/mehfil-kitchen/api/enquiries').send(body);
const FULL = { service_id: 'veg_buffet', quantity: 40, event_date: '2026-12-13', location: 'Koramangala' };

test('TC-FBK-01 AI_ENABLED=false: no Claude call, structured form shown', async () => {
  const { app, ai } = setup({ env: { AI_ENABLED: 'false' }, steps: scenarios.ready() });
  const res = await post(app);
  assert.equal(res.status, 201);
  assert.equal(res.body.outcome, 'fallback');
  assert.equal(ai.calls.length, 0);
  const html = await request(app).post('/b/mehfil-kitchen/api/enquiries').set('Accept', 'text/html').type('form').send({ ...START, name: 'Meera' });
  assert.match(html.text, /Tell us a few details/);
  assert.ok(!/error|down|unavailable/i.test(html.text.replace(/field-error|aria-invalid/g, '')));
});

test('TC-FBK-02 fallback form with all required fields: needs_owner -> estimate -> awaiting_approval', async () => {
  const { app, repos } = setup({ env: { AI_ENABLED: 'false' } });
  const start = await post(app);
  const res = await request(app).post(`/b/mehfil-kitchen/api/enquiries/${start.body.publicId}/form`).send(FULL);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { publicId: start.body.publicId, outcome: 'ready' });
  const e = newest(repos);
  assert.equal(e.status, 'awaiting_approval');
  assert.equal(e.source, 'form');
  assert.equal(repos.estimates.listByEnquiry(e.id).length, 1);
});

test('TC-FBK-03 fallback form missing location: needs_owner, no estimate, owner sees it', async () => {
  const { app, repos } = setup({ env: { AI_ENABLED: 'false' } });
  const start = await post(app);
  const partial = { ...FULL };
  delete partial.location;
  const res = await request(app).post(`/b/mehfil-kitchen/api/enquiries/${start.body.publicId}/form`).send(partial);
  assert.equal(res.body.outcome, 'needs_owner');
  const e = newest(repos);
  assert.equal(e.status, 'needs_owner');
  assert.deepEqual(e.missingFieldsJson, ['location']);
  assert.equal(repos.estimates.listByEnquiry(e.id).length, 0);
  assert.ok(repos.enquiries.list().some((x) => x.publicId === start.body.publicId));
});

test('TC-FBK-04 daily cap reached: fallback form, no Claude call', async () => {
  const probe = setup();
  const used = dailyCallCount(probe.repos, new Date());
  const { app, ai } = setup({ env: { AI_DAILY_REQUEST_CAP: String(used) }, steps: scenarios.ready() });
  const res = await post(app);
  assert.equal(res.body.outcome, 'fallback');
  assert.equal(ai.calls.length, 0);
});

test('fallback form rejects an unknown service and a finished enquiry', async () => {
  const { app } = setup({ env: { AI_ENABLED: 'false' } });
  const start = await post(app);
  const url = `/b/mehfil-kitchen/api/enquiries/${start.body.publicId}/form`;
  const bad = await request(app).post(url).send({ ...FULL, service_id: 'moon_cake' });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.error.fields.service_id);
  await request(app).post(url).send(FULL);
  assert.equal((await request(app).post(url).send(FULL)).status, 409);
  assert.equal((await request(app).post('/b/mehfil-kitchen/api/enquiries/NOPE/form').send(FULL)).status, 404);
});
