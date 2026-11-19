import { z } from 'zod';

const bool = (def) =>
  z
    .enum(['true', 'false'])
    .default(def)
    .transform((v) => v === 'true');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    BASE_URL: z.string().url().default('http://localhost:3000'),
    AI_MODE: z.enum(['mock', 'live']).default('mock'),
    AI_ENABLED: bool('true'),
    ANTHROPIC_API_KEY: z.string().optional(),
    SMTP_PASS: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    for (const name of ['ANTHROPIC_API_KEY', 'SMTP_PASS']) {
      if (!env[name]) {
        ctx.addIssue({ code: 'custom', path: [name], message: 'is required in production' });
      }
    }
  });

/**
 * Validate env vars. Throws an Error naming the bad/missing variables.
 * Messages never include the values themselves.
 */
export function loadConfig(env = process.env) {
  const result = schema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const { ANTHROPIC_API_KEY, SMTP_PASS, ...rest } = result.data;
  return {
    env: rest.NODE_ENV,
    port: rest.PORT,
    baseUrl: rest.BASE_URL,
    aiMode: rest.AI_MODE,
    aiEnabled: rest.AI_ENABLED,
    anthropicApiKey: ANTHROPIC_API_KEY,
    smtpPass: SMTP_PASS,
  };
}
