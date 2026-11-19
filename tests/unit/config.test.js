import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config.js';

const SECRET_A = 'sk-ant-secret-value-123';
const SECRET_S = 'smtp-secret-value-456';

test('TC-REQ-07 production without ANTHROPIC_API_KEY fails, naming the variable only', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production', SMTP_PASS: SECRET_S }),
    (err) => {
      assert.match(err.message, /ANTHROPIC_API_KEY/);
      assert.doesNotMatch(err.message, new RegExp(SECRET_S));
      return true;
    },
  );
});

test('TC-REQ-07 production without SMTP_PASS fails, naming the variable only', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production', ANTHROPIC_API_KEY: SECRET_A }),
    (err) => {
      assert.match(err.message, /SMTP_PASS/);
      assert.doesNotMatch(err.message, new RegExp(SECRET_A));
      return true;
    },
  );
});

test('TC-REQ-07 production with both secrets set is accepted', () => {
  const cfg = loadConfig({ NODE_ENV: 'production', ANTHROPIC_API_KEY: SECRET_A, SMTP_PASS: SECRET_S });
  assert.equal(cfg.env, 'production');
});

test('config: development defaults to mock AI without secrets', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.aiMode, 'mock');
  assert.equal(cfg.port, 3000);
});

test('config: invalid value is rejected without echoing the value', () => {
  assert.throws(() => loadConfig({ PORT: 'not-a-port' }), (err) => {
    assert.match(err.message, /PORT/);
    assert.doesNotMatch(err.message, /not-a-port/);
    return true;
  });
});
