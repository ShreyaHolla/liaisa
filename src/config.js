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
    if (env.MAIL_ENABLED) need(['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']);
  });

/**
 * Validate env vars. Throws an Error naming the bad/missing variables.
 * Messages never include the values themselves.
 * Returns { ...config, warnings } where warnings are strings to log at boot.
 */
export function loadConfig(env = process.env) {
  const result = schema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const e = result.data;
  const aiLive = e.AI_ENABLED && e.AI_MODE === 'live';

  const warnings = [];
  if (e.NODE_ENV === 'production') {
    const off = [];
    if (!aiLive) off.push('live AI (set AI_ENABLED=true and AI_MODE=live)');
    if (!e.MAIL_ENABLED) off.push('email sending (set MAIL_ENABLED=true)');
    if (off.length) warnings.push(`Disabled features in production: ${off.join('; ')}`);
  }

  return {
    env: e.NODE_ENV,
    port: e.PORT,
    baseUrl: e.BASE_URL,
    aiMode: e.AI_MODE,
    aiEnabled: e.AI_ENABLED,
    aiLive,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    mailEnabled: e.MAIL_ENABLED,
    smtp: { host: e.SMTP_HOST, port: e.SMTP_PORT, user: e.SMTP_USER, pass: e.SMTP_PASS },
    warnings,
  };
}
