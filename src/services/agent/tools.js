// Tool definitions (PRD §6.3) and the zod schema that validates finish_intake.
import { z } from 'zod';

export const TOOLS = [
  {
    name: 'calculate_estimate',
    description:
      "Calculate the price for the given requirements using the business's approved rate card. Always use this; never compute prices yourself.",
    input_schema: {
      type: 'object',
      properties: {
        service_id: { type: 'string' },
        quantity: { type: 'number', description: "Guests, hours or units, per the service's pricing unit" },
        event_date: { type: 'string', description: 'YYYY-MM-DD' },
        distance_km: { type: 'number' },
        addon_ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['service_id', 'quantity'],
    },
  },
  {
    name: 'finish_intake',
    description: 'Report the result of this turn. Call exactly once per turn, as the last call.',
    input_schema: {
      type: 'object',
      properties: {
        status: { enum: ['needs_info', 'ready', 'out_of_scope'] },
        requirements: {
          type: 'object',
          properties: {
            service_id: { type: 'string' },
            quantity: { type: 'number' },
            event_date: { type: 'string' },
            location: { type: 'string' },
            distance_km: { type: 'number' },
            addon_ids: { type: 'array', items: { type: 'string' } },
            notes: { type: 'string' },
          },
        },
        missing_fields: { type: 'array', items: { type: 'string' } },
        question_to_customer: { type: 'string', description: 'Only when status is needs_info. One short friendly question.' },
        summary_for_owner: { type: 'string', description: '1–2 sentences.' },
      },
      required: ['status', 'requirements', 'missing_fields', 'summary_for_owner'],
    },
  },
];

const reqShape = {
  service_id: z.string().max(40).nullish(),
  quantity: z.number().nullish(),
  event_date: z.string().max(10).nullish(),
  location: z.string().max(120).nullish(),
  distance_km: z.number().nullish(),
  addon_ids: z.array(z.string().max(40)).max(20).nullish(),
  notes: z.string().max(1000).nullish(),
};

export const finishSchema = z.object({
  status: z.enum(['needs_info', 'ready', 'out_of_scope']),
  requirements: z.object(reqShape),
  missing_fields: z.array(z.string().max(40)).max(10),
  question_to_customer: z.string().trim().min(1).max(300).optional(),
  summary_for_owner: z.string().trim().min(1).max(500),
});

/** Drop null/undefined so merged requirements stay clean JSON. */
export function cleanRequirements(r = {}) {
  return Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null && v !== undefined));
}

/** Keep each field of a malformed finish_intake that is individually valid (pre-fills the fallback form). */
export function salvageRequirements(input) {
  const raw = input?.requirements;
  if (raw === null || typeof raw !== 'object') return {};
  const out = {};
  for (const [key, schema] of Object.entries(reqShape)) {
    const parsed = schema.safeParse(raw[key]);
    if (parsed.success && parsed.data !== null && parsed.data !== undefined) out[key] = parsed.data;
  }
  return out;
}
