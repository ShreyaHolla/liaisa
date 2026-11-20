import { z } from 'zod';

// Treat empty-string env vars (common on hosting panels) as unset.
const blankToUndefined = (v) => (v === '' ? undefined : v);
const opt = (type) => z.preprocess(blankToUndefined, type.optional());
const withDefault = (type, def) => z.preprocess(blankToUndefined, type.default(def));

const BCRYPT = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

/** Base64 (or URL-safe base64) to text, or null when it isn't base64. Never throws, never echoes the value. */
function decodeB64(value) {
  const v = value.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) return null;
  return Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8').trim();
}

/**
 * The owner's bcrypt hash. When OWNER_PASSWORD_HASH_B64 is set, ONLY its decoded value counts and
 * OWNER_PASSWORD_HASH is not read, validated or used (even if it is malformed). The base64 form exists
 * because hosts often mangle the `$` characters in a raw bcrypt hash.
 */
const ownerHashOf = (env) => (env.OWNER_PASSWORD_HASH_B64 ? decodeB64(env.OWNER_PASSWORD_HASH_B64) : env.OWNER_PASSWORD_HASH);

const bool = (def) =>
  withDefault(z.enum(['true', 'false']), def).transform((v) => v === 'true');

const schema = z
  .object({
    NODE_ENV: withDefault(z.enum(['development', 'test', 'production']), 'development'),
    PORT: withDefault(z.coerce.number().int().min(1).max(65535), 3000),
    BASE_URL: withDefault(z.string().url(), 'http://localhost:3000'),
    AI_MODE: withDefault(z.enum(['mock', 'live']), 'mock'),
    AI_ENABLED: bool('true'),
    AI_MODEL_INTAKE: withDefault(z.string(), 'claude-haiku-5-5'),
    AI_MODEL_OUTREACH: withDefault(z.string(), 'claude-haiku-5-5'),
    // Chosen by checking the Models API: claude-haiku-5-5 reports capabilities.server_tools.web_search.supported.
    AI_MODEL_DISCOVERY: withDefault(z.string(), 'claude-haiku-5-5'),
    CLIENT_DISCOVERY_DAILY_CAP: withDefault(z.coerce.number().int().min(0), 10),
    AI_PRICE_WEB_SEARCH: withDefault(z.coerce.number().min(0), 0.01),
    CLIENT_DRAFT_DAILY_CAP: withDefault(z.coerce.number().int().min(0), 20),
    AI_DAILY_REQUEST_CAP: withDefault(z.coerce.number().int().min(0), 200),
    // Across ALL businesses: one switch for the whole platform's AI spend. New businesses get lower caps than the demo.
    AI_GLOBAL_DAILY_CAP: withDefault(z.coerce.number().int().min(0), 300),
    NEW_BUSINESS_AI_DAILY_CAP: withDefault(z.coerce.number().int().min(0), 40),
    NEW_BUSINESS_DRAFT_DAILY_CAP: withDefault(z.coerce.number().int().min(0), 5),
    NEW_BUSINESS_DISCOVERY_DAILY_CAP: withDefault(z.coerce.number().int().min(0), 3),
    MAX_BUSINESSES: withDefault(z.coerce.number().int().min(1), 50),
    AI_PRICE_INPUT_PER_MTOK: withDefault(z.coerce.number().min(0), 0),
    AI_PRICE_OUTPUT_PER_MTOK: withDefault(z.coerce.number().min(0), 0),
    AI_PRICE_CACHE_READ_PER_MTOK: withDefault(z.coerce.number().min(0), 0),
    AI_PRICE_CACHE_WRITE_PER_MTOK: withDefault(z.coerce.number().min(0), 0),
    WHATSAPP_DEFAULT_COUNTRY_CODE: withDefault(z.string().regex(/^\d{1,3}$/), '91'),
    MAIL_ENABLED: bool('false'),
    ANTHROPIC_API_KEY: opt(z.string()),
    SMTP_HOST: opt(z.string()),
    SMTP_PORT: withDefault(z.coerce.number().int().min(1).max(65535), 465),
    SMTP_USER: opt(z.string()),
    SMTP_PASS: opt(z.string()),
    OWNER_EMAIL: opt(z.string().email()),
    MAIL_FROM: withDefault(z.string(), '"Liaisa" <hello@liaisa.co.in>'),
    // bcrypt hash only (from `npm run hash-password`), never the password itself.
    // bcrypt hash only (from `npm run hash-password`), never the password itself. Checked in superRefine below,
    // and only when OWNER_PASSWORD_HASH_B64 is not set.
    OWNER_PASSWORD_HASH: opt(z.string()),
    OWNER_PASSWORD_HASH_B64: opt(z.string()),
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
    // The hash: the base64 form wins outright; the plain form is only looked at when it is absent.
    if (env.OWNER_PASSWORD_HASH_B64) {
      if (!BCRYPT.test(ownerHashOf(env) ?? '')) {
        ctx.addIssue({ code: 'custom', path: ['OWNER_PASSWORD_HASH_B64'], message: 'must be the base64 of a bcrypt hash (run npm run hash-password)' });
      }
    } else if (env.OWNER_PASSWORD_HASH && !BCRYPT.test(env.OWNER_PASSWORD_HASH)) {
      ctx.addIssue({ code: 'custom', path: ['OWNER_PASSWORD_HASH'], message: 'must be a bcrypt hash (run npm run hash-password)' });
    }
    // Owner area: on when both are set, off when neither is. Exactly one is a mistake.
    const hashGiven = Boolean(env.OWNER_PASSWORD_HASH_B64 || env.OWNER_PASSWORD_HASH);
    if (hashGiven || env.SESSION_SECRET) {
      if (!hashGiven) ctx.addIssue({ code: 'custom', path: ['OWNER_PASSWORD_HASH'], message: 'is required because the other owner-login variable is set' });
      if (!env.SESSION_SECRET) ctx.addIssue({ code: 'custom', path: ['SESSION_SECRET'], message: 'is required because the other owner-login variable is set' });
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

  const ownerHash = ownerHashOf(e);
  const ownerEnabled = Boolean(ownerHash && e.SESSION_SECRET);

  const warnings = [];
  if (e.NODE_ENV === 'production') {
    const off = [];
    if (!aiLive) off.push('live AI (set AI_ENABLED=true and AI_MODE=live)');
    if (!e.MAIL_ENABLED) off.push('email sending (set MAIL_ENABLED=true)');
    if (!ownerEnabled) off.push('owner area (set OWNER_PASSWORD_HASH_B64 or OWNER_PASSWORD_HASH, and SESSION_SECRET)');
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
    ai: {
      modelIntake: e.AI_MODEL_INTAKE,
      modelOutreach: e.AI_MODEL_OUTREACH,
      modelDiscovery: e.AI_MODEL_DISCOVERY,
      webSearchPrice: e.AI_PRICE_WEB_SEARCH, // USD per search
      dailyCap: e.AI_DAILY_REQUEST_CAP,
      globalDailyCap: e.AI_GLOBAL_DAILY_CAP,
      prices: {
        input: e.AI_PRICE_INPUT_PER_MTOK,
        output: e.AI_PRICE_OUTPUT_PER_MTOK,
        cacheRead: e.AI_PRICE_CACHE_READ_PER_MTOK,
        cacheWrite: e.AI_PRICE_CACHE_WRITE_PER_MTOK,
      },
    },
    newBusiness: { aiRequests: e.NEW_BUSINESS_AI_DAILY_CAP, drafts: e.NEW_BUSINESS_DRAFT_DAILY_CAP, discoveryRuns: e.NEW_BUSINESS_DISCOVERY_DAILY_CAP },
    maxBusinesses: e.MAX_BUSINESSES,
    clientDraftDailyCap: e.CLIENT_DRAFT_DAILY_CAP,
    clientDiscoveryDailyCap: e.CLIENT_DISCOVERY_DAILY_CAP,
    whatsappCountryCode: e.WHATSAPP_DEFAULT_COUNTRY_CODE,
    mailEnabled: e.MAIL_ENABLED,
    ownerEmail: e.OWNER_EMAIL,
    mailFrom: e.MAIL_FROM,
    ownerEnabled,
    ownerPasswordHash: ownerHash,
    sessionSecret: e.SESSION_SECRET,
    smtp: { host: e.SMTP_HOST, port: e.SMTP_PORT, user: e.SMTP_USER, pass: e.SMTP_PASS },
    warnings,
    notes,
  };
}
