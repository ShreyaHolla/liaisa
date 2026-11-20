// zod schemas for the owner Edit form and the customer question (openapi EstimateEditRequest, QuoteQuestionRequest).
import { z } from 'zod';
import { requirementsSchema } from '../enquiries/schema.js';

const blank = (type) => z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), type.optional());
const RUPEES = 'Enter a whole number of rupees, 1 or more.';

export const editSchema = z.object({
  requirements: requirementsSchema,
  discount: z.object({
    amount: z.coerce.number({ error: RUPEES }).int(RUPEES).min(1, RUPEES),
    reason: z.string({ error: 'Add a reason for the discount.' }).trim()
      .min(3, 'Add a reason for the discount, at least 3 characters.').max(200, 'Keep the reason under 200 characters.'),
  }).optional(),
  note: blank(z.string().trim().max(500, 'Keep the note under 500 characters.')),
  revisionReason: z.string({ error: 'Say why you changed it.' }).trim()
    .min(3, 'Say why you changed it, at least 3 characters.').max(300, 'Keep it under 300 characters.'),
});

export const questionSchema = z.object({
  message: z.string({ error: 'Type your question.' }).trim().min(2, 'Type your question.').max(1000, 'Please keep it under 1,000 characters.'),
});

export const approveSchema = z.object({ estimateVersion: z.coerce.number().int().min(1) });

/** First message per field, keyed 'discount.amount' etc. */
export function flatErrors(zodError) {
  const out = {};
  for (const issue of zodError.issues) {
    const key = issue.path.join('.') || '_form';
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
