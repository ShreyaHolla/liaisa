import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config.js';

const SECRET_A = 'sk-ant-secret-value-123';
const SECRET_S = 'smtp-secret-value-456';
const prod = { NODE_ENV: 'production' };

function throwsNaming(env, name, secret) {
  assert.throws(
    () => loadConfig(env),
    (err) => {
      assert.match(err.message, new RegExp(name));
      if (secret) assert.doesNotMatch(err.message, new RegExp(secret));
      return true;
    },
  );
}

test('TC-REQ-07 production with AI live but no ANTHROPIC_API_KEY refuses to start, naming it', () => {
  throwsNaming({ ...prod, AI_MODE: 'live', AI_ENABLED: 'true', SMTP_PASS: SECRET_S }, 'ANTHROPIC_API_KEY', SECRET_S);
});

test('TC-REQ-07 production with mail enabled but no SMTP_PASS refuses to start, naming it', () => {
  throwsNaming(
    { ...prod, MAIL_ENABLED: 'true', SMTP_HOST: 'h', SMTP_USER: 'u', ANTHROPIC_API_KEY: SECRET_A },
    'SMTP_PASS',
    SECRET_A,
  );
});

test('TC-REQ-07 production with mail enabled but no SMTP_HOST/SMTP_USER names them', () => {
  throwsNaming({ ...prod, MAIL_ENABLED: 'true', SMTP_PASS: SECRET_S }, 'SMTP_HOST', SECRET_S);
  throwsNaming({ ...prod, MAIL_ENABLED: 'true', SMTP_PASS: SECRET_S }, 'SMTP_USER', SECRET_S);
});

test('TC-REQ-07 production with mail enabled but no OWNER_EMAIL names it', () => {
  throwsNaming(
    { ...prod, MAIL_ENABLED: 'true', SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: SECRET_S },
    'OWNER_EMAIL',
    SECRET_S,
  );
});

test('TC-REQ-07 production with features off starts without any secret and warns once, naming features', () => {
  const cfg = loadConfig(prod);
  assert.equal(cfg.aiMode, 'mock');
  assert.equal(cfg.mailEnabled, false);
  assert.equal(cfg.warnings.length, 1);
  assert.match(cfg.warnings[0], /live AI/);
  assert.match(cfg.warnings[0], /email/);
});

test('TC-REQ-07 AI_ENABLED=false in live mode needs no key', () => {
  const cfg = loadConfig({ ...prod, AI_MODE: 'live', AI_ENABLED: 'false' });
  assert.equal(cfg.aiLive, false);
});

test('TC-REQ-07 production with enabled features and their secrets starts with no warnings', () => {
  const cfg = loadConfig({
    ...prod,
    AI_MODE: 'live',
    ANTHROPIC_API_KEY: SECRET_A,
    MAIL_ENABLED: 'true',
    SMTP_HOST: 'smtp.example.test',
    SMTP_USER: 'hello@example.test',
    SMTP_PASS: SECRET_S,
    OWNER_EMAIL: 'owner@example.test',
    OWNER_PASSWORD_HASH: '$2b$04$' + 'a'.repeat(53),
    SESSION_SECRET: 's'.repeat(40),
  });
  assert.equal(cfg.aiLive, true);
  assert.equal(cfg.mailEnabled, true);
  assert.deepEqual(cfg.warnings, []);
  assert.doesNotMatch(JSON.stringify(cfg.warnings), new RegExp(`${SECRET_A}|${SECRET_S}`));
});

test('config: empty-string env vars are treated as unset', () => {
  const cfg = loadConfig({ ...prod, AI_MODE: '', MAIL_ENABLED: '', ANTHROPIC_API_KEY: '', SMTP_PASS: '' });
  assert.equal(cfg.aiMode, 'mock');
  assert.equal(cfg.mailEnabled, false);
});

test('config: development defaults to mock AI, no warnings', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.aiMode, 'mock');
  assert.equal(cfg.port, 3000);
  assert.deepEqual(cfg.warnings, []);
});

test('config: invalid value is rejected without echoing the value', () => {
  throwsNaming({ PORT: 'not-a-port' }, 'PORT', 'not-a-port');
});

// --- Owner login gating (M4) ---
const HASH = '$2b$04$' + 'a'.repeat(53);
const SECRET = 's'.repeat(40);

test('owner area is off when neither OWNER_PASSWORD_HASH nor SESSION_SECRET is set', () => {
  const c = loadConfig({ NODE_ENV: 'development' });
  assert.equal(c.ownerEnabled, false);
  assert.deepEqual(c.notes, []);
});

test('owner area is on when both are set, with the in-memory sessions note', () => {
  const c = loadConfig({ OWNER_PASSWORD_HASH: HASH, SESSION_SECRET: SECRET });
  assert.equal(c.ownerEnabled, true);
  assert.deepEqual(c.notes, ['Sessions are in memory; owners log in again after a restart.']);
});

test('only OWNER_PASSWORD_HASH set: refuses to start, naming SESSION_SECRET, never the hash', () => {
  throwsNaming({ OWNER_PASSWORD_HASH: HASH }, 'SESSION_SECRET', HASH);
});

test('only SESSION_SECRET set: refuses to start, naming OWNER_PASSWORD_HASH, never the secret', () => {
  throwsNaming({ SESSION_SECRET: SECRET }, 'OWNER_PASSWORD_HASH', SECRET);
});

test('a short SESSION_SECRET or a non-bcrypt hash is rejected without echoing the value', () => {
  throwsNaming({ OWNER_PASSWORD_HASH: HASH, SESSION_SECRET: 'too-short-secret' }, 'SESSION_SECRET', 'too-short-secret');
  throwsNaming({ OWNER_PASSWORD_HASH: 'plaintext-password-oops', SESSION_SECRET: SECRET }, 'OWNER_PASSWORD_HASH', 'plaintext-password-oops');
});

test('production without the owner variables warns instead of failing', () => {
  const c = loadConfig({ NODE_ENV: 'production' });
  assert.match(c.warnings.join('\n'), /owner area/);
});
