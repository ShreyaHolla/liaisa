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

// --- OWNER_PASSWORD_HASH_B64: when set, the plain hash is not read at all ---
const B64 = Buffer.from(HASH).toString('base64');

test('a garbage OWNER_PASSWORD_HASH plus a valid OWNER_PASSWORD_HASH_B64 starts normally, using only the decoded value', () => {
  for (const garbage of ['not-a-hash', '$2b$ broken', 'plaintext-password-oops', '   ', '$2b$04$short', 'x'.repeat(500)]) {
    const c = loadConfig({ OWNER_PASSWORD_HASH: garbage, OWNER_PASSWORD_HASH_B64: B64, SESSION_SECRET: SECRET });
    assert.equal(c.ownerEnabled, true, garbage);
    assert.equal(c.ownerPasswordHash, HASH, 'the decoded value, never the garbage');
    assert.deepEqual(c.warnings, []);
  }
});

test('OWNER_PASSWORD_HASH_B64 works on its own, in standard or URL-safe base64, with stray whitespace', () => {
  assert.equal(loadConfig({ OWNER_PASSWORD_HASH_B64: B64, SESSION_SECRET: SECRET }).ownerPasswordHash, HASH);
  const urlSafe = B64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(loadConfig({ OWNER_PASSWORD_HASH_B64: urlSafe, SESSION_SECRET: SECRET }).ownerPasswordHash, HASH);
  assert.equal(loadConfig({ OWNER_PASSWORD_HASH_B64: `  ${B64}\n`, SESSION_SECRET: SECRET }).ownerPasswordHash, HASH);
  const real = '$2b$12$' + 'Ab./1'.repeat(10) + 'Ab.'; // 53 chars after the prefix
  assert.equal(loadConfig({ OWNER_PASSWORD_HASH_B64: Buffer.from(real).toString('base64'), SESSION_SECRET: SECRET }).ownerPasswordHash, real);
});

test('a malformed OWNER_PASSWORD_HASH_B64 refuses to start, naming only itself, and a valid plain hash does not rescue it', () => {
  const notBase64 = '!!! not base64 !!!';
  const wrongContent = Buffer.from('plaintext-password-oops').toString('base64');
  throwsNaming({ OWNER_PASSWORD_HASH_B64: notBase64, SESSION_SECRET: SECRET }, 'OWNER_PASSWORD_HASH_B64', notBase64);
  throwsNaming({ OWNER_PASSWORD_HASH_B64: wrongContent, SESSION_SECRET: SECRET }, 'OWNER_PASSWORD_HASH_B64', wrongContent);
  // Only the decoded B64 value is checked: the (valid) plain hash is ignored, so this still fails.
  throwsNaming({ OWNER_PASSWORD_HASH: HASH, OWNER_PASSWORD_HASH_B64: wrongContent, SESSION_SECRET: SECRET }, 'OWNER_PASSWORD_HASH_B64', wrongContent);
  try {
    loadConfig({ OWNER_PASSWORD_HASH: 'garbage-plain', OWNER_PASSWORD_HASH_B64: wrongContent, SESSION_SECRET: SECRET });
    assert.fail('should have thrown');
  } catch (err) {
    assert.match(err.message, /OWNER_PASSWORD_HASH_B64/);
    assert.ok(!/OWNER_PASSWORD_HASH:/.test(err.message.replace(/OWNER_PASSWORD_HASH_B64/g, '')), 'the plain variable is not mentioned at all');
    assert.ok(!err.message.includes('garbage-plain') && !err.message.includes(wrongContent));
  }
});

test('an empty OWNER_PASSWORD_HASH_B64 counts as unset, so the plain hash is used and still validated', () => {
  assert.equal(loadConfig({ OWNER_PASSWORD_HASH: HASH, OWNER_PASSWORD_HASH_B64: '', SESSION_SECRET: SECRET }).ownerPasswordHash, HASH);
  throwsNaming({ OWNER_PASSWORD_HASH: 'plaintext-password-oops', OWNER_PASSWORD_HASH_B64: '', SESSION_SECRET: SECRET }, 'OWNER_PASSWORD_HASH', 'plaintext-password-oops');
});

test('the hash and the secret still come as a pair, with either form of the hash', () => {
  throwsNaming({ OWNER_PASSWORD_HASH_B64: B64 }, 'SESSION_SECRET', B64);
  throwsNaming({ SESSION_SECRET: SECRET }, 'OWNER_PASSWORD_HASH', SECRET);
  assert.equal(loadConfig({ NODE_ENV: 'development' }).ownerEnabled, false);
});

test('production warning names both forms of the hash when the owner area is off', () => {
  const c = loadConfig({ NODE_ENV: 'production' });
  assert.match(c.warnings.join(' '), /OWNER_PASSWORD_HASH_B64 or OWNER_PASSWORD_HASH, and SESSION_SECRET/);
});
