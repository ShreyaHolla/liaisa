import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, START, newest } from '../helpers/agentApp.js';
import { scenarios } from '../../src/ai/mockClient.js';
import { computeCostUsd } from '../../src/ai/cost.js';

const PRICES = { AI_PRICE_INPUT_PER_MTOK: '1', AI_PRICE_OUTPUT_PER_MTOK: '5' };

test('TC-LOG-01 each mock call writes one ai_calls row', async () => {
  const { app, repos } = setup({ env: PRICES, steps: scenarios.ready() });
  await request(app).post('/b/mehfil-kitchen/api/enquiries').send(START);
  const e = newest(repos);
  const rows = repos.aiCalls.listByEnquiry(e.id);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.purpose, 'intake');
    assert.equal(r.model, 'mock-intake');
    assert.equal(r.inputTokens, 1000);
    assert.equal(r.outputTokens, 200);
    assert.equal(r.cacheReadTokens, 0);
    assert.equal(r.cacheWriteTokens, 0);
    assert.equal(r.costUsd, 0.002); // (1000 x $1 + 200 x $5) / 1M
    assert.equal(typeof r.latencyMs, 'number');
    assert.equal(r.ok, true);
  }
});

test('TC-LOG-01b a failed call is logged with ok=false and a short error', async () => {
  const { app, repos } = setup({ steps: [scenarios.api_error(), scenarios.api_error()] });
  await request(app).post('/b/mehfil-kitchen/api/enquiries').send(START);
  const rows = repos.aiCalls.listByEnquiry(newest(repos).id);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.ok === false && r.error === '500'));
});

test('TC-LOG-02 cost: 12,000 in + 3,000 out matches the hand calculation', () => {
  // $3 and $15 per million: 12000 x 3 / 1e6 = 0.036 ; 3000 x 15 / 1e6 = 0.045 ; total 0.081
  const prices = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
  assert.equal(computeCostUsd({ input: 12000, output: 3000, cacheRead: 0, cacheWrite: 0 }, prices), 0.081);
  // cache tokens: 1000 x 0.3 / 1e6 = 0.0003 ; 2000 x 3.75 / 1e6 = 0.0075
  assert.equal(computeCostUsd({ input: 0, output: 0, cacheRead: 1000, cacheWrite: 2000 }, prices), 0.0078);
  assert.equal(computeCostUsd({ input: 1, output: 1 }, { input: 0.123456, output: 0 }), 0);
});

test('TC-LOG-03 ai_calls and console output never contain the API key, email or phone', async (t) => {
  const logged = [];
  for (const m of ['log', 'info', 'warn', 'error']) t.mock.method(console, m, (...a) => logged.push(a.join(' ')));
  const key = 'sk-ant-test-secret-123';
  const { app, repos } = setup({ env: { ANTHROPIC_API_KEY: key }, steps: [scenarios.api_error(), scenarios.ready()] });
  await request(app).post('/b/mehfil-kitchen/api/enquiries').send({ ...START, channel: 'whatsapp', phone: '98450 12345' });
  const dump = JSON.stringify(repos.aiCalls.all()) + logged.join('\n');
  for (const secret of [key, 'priya@example.test', '9845012345', 'Priya']) {
    assert.ok(!dump.includes(secret), `log leaks ${secret}`);
  }
});
