import { z } from 'zod';

// Treat empty-string env vars (common on hosting panels) as unset.
const blankToUndefined = (v) => (v === '' ? undefined : v);
const opt = (type) => z.preprocess(blankToUndefined, type.optional());
const withDefault = (type, def) => z.preprocess(blankToUndefined, type.default(def));

const bool = (def) =>
  withDefault(z.enum(['true', 'false']), def).transform((v) => v === 'true');

const schema = z
  .object({
    NODE_ENV: withDefault(z.enum(['development', 'test', 'production']), 'development'),
    PORT: withDefault(z.coerce.number().int().min(1).max(65535), 3000),
    BASE_URL: withDefault(z.string().url(), 'http://localhost:3000'),
    AI_MODE: withDefault(z.enum(['mock', 'live']), 'mock'),
    AI_ENABLED: bool('true'),
    MAIL_ENABLED: bool('false'),
    ANTHROPIC_API_KEY: opt(z.string()),
    SMTP_HOST: opt(z.string()),
    SMTP_PORT: withDefault(z.coerce.number().int().min(1).max(65535), 465),
    SMTP_USER: opt(z.string()),
    SMTP_PASS: opt(z.string()),
    OWNER_EMAIL: opt(z.string().email()),
    MAIL_FROM: withDefault(z.string(), '"Liaisa" <hello@liaisa.co.in>'),
    // bcrypt hash only (from `npm run hash-password`), never the password itself.
    OWNER_PASSWORD_HASH: opt(z.string().regex(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/, 'must be a bcrypt hash (run npm run hash-password)')),
    SESSION_SECRET: opt(z.string().min(32, 'must be at least 32 characters')),
  })
  .superRefine((env, ctx) => {
    const need = (names) => {
      for (const name of names) {
        if (!env[name]) {
          ctx.addIssue({ code: 'custom', path: [name], message: 'is required when its feature is enabled' });
        }
      }
    };
    // A secret is required only when the feature that uses it is switched on.
    if (env.AI_ENABLED && env.AI_MODE === 'live') need(['ANTHROPIC_API_KEY']);
    if (env.MAIL_ENABLED) need(['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'OWNER_EMAIL']);
    // Owner area: on when both are set, off when neither is. Exactly one is a mistake.
    if (env.OWNER_PASSWORD_HASH || env.SESSION_SECRET) {
      for (const name of ['OWNER_PASSWORD_HASH', 'SESSION_SECRET']) {
        if (!env[name]) {
          ctx.addIssue({ code: 'custom', path: [name], message: 'is required because the other owner-login variable is set' });
        }
      }
    }
  });

/**
 * Validate env vars. Throws an Error naming the bad/missing variables.
 * Messages never include the values themselves.
 * Returns { ...config, warnings, notes }: warnings and notes are strings to log at boot.
 */
export function loadConfig(env = process.env) {
  const result = schema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const e = result.data;
  const aiLive = e.AI_ENABLED && e.AI_MODE === 'live';

  const ownerEnabled = Boolean(e.OWNER_PASSWORD_HASH && e.SESSION_SECRET);

  const warnings = [];
  if (e.NODE_ENV === 'production') {
    const off = [];
    if (!aiLive) off.push('live AI (set AI_ENABLED=true and AI_MODE=live)');
    if (!e.MAIL_ENABLED) off.push('email sending (set MAIL_ENABLED=true)');
    if (!ownerEnabled) off.push('owner area (set OWNER_PASSWORD_HASH and SESSION_SECRET)');
    if (off.length) warnings.push(`Disabled features in production: ${off.join('; ')}`);
  }

  const notes = [];
  // MemoryStore is used on purpose (see routes/owner.js), so say so once instead of
  // letting express-session print its generic production warning.
  if (ownerEnabled) notes.push('Sessions are in memory; owners log in again after a restart.');

  return {
    env: e.NODE_ENV,
    port: e.PORT,
    baseUrl: e.BASE_URL,
    aiMode: e.AI_MODE,
    aiEnabled: e.AI_ENABLED,
    aiLive,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    mailEnabled: e.MAIL_ENABLED,
    ownerEmail: e.OWNER_EMAIL,
    mailFrom: e.MAIL_FROM,
    ownerEnabled,
    ownerPasswordHash: e.OWNER_PASSWORD_HASH,
    sessionSecret: e.SESSION_SECRET,
    smtp: { host: e.SMTP_HOST, port: e.SMTP_PORT, user: e.SMTP_USER, pass: e.SMTP_PASS },
    warnings,
    notes,
  };
}
