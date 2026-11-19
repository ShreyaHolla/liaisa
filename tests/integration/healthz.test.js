import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';

const app = createApp(loadConfig({ NODE_ENV: 'test' }));

test('TC-REQ-01 GET /healthz returns 200 {ok:true, db, version}', async () => {
  const res = await request(app).get('/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(typeof res.body.db, 'boolean');
  assert.equal(typeof res.body.version, 'string');
});

test('TC-SEC-07 /healthz exposes only ok, db and version', async () => {
  const res = await request(app).get('/healthz');
  assert.deepEqual(Object.keys(res.body).sort(), ['db', 'ok', 'version']);
  assert.doesNotMatch(res.text, /sk-ant|password|express|zod|ejs/i);
});

test('M1 GET / renders the Liaisa home placeholder', async () => {
  const res = await request(app).get('/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /html/);
  assert.match(res.text, /Liaisa/);
});
