// zod schemas for the enquiry endpoints (openapi EnquiryStartRequest, EnquiryReplyRequest, Requirements).
// Messages are the user-facing words from DESIGN.md §7.3.
import { z } from 'zod';

const MSG = {
  tooLong: 'Please keep it under 1,000 characters. You can add details after we reply.',
  phone: 'Enter a 10-digit mobile number, like 98450 12345.',
  email: 'Enter an email address, like name@example.com.',
};

const blank = (type) => z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), type.optional());

/** Digits only, with country code, ready for wa.me. Returns null when it isn't a phone number. */
export function normalisePhone(raw, countryCode) {
  const s = raw.replace(/[\s\-().]/g, '');
  if (/^\+\d{8,15}$/.test(s)) return s.slice(1);
  if (/^\d{10}$/.test(s)) return countryCode + s;
  if (/^0\d{10}$/.test(s)) return countryCode + s.slice(1);
  if (new RegExp(`^${countryCode}\\d{10}$`).test(s)) return s;
  return null;
}

export function makeStartSchema(countryCode) {
  return z
    .object({
      name: z.string({ error: 'Enter your name.' }).trim().min(1, 'Enter your name.').max(120, 'Enter your name.')
        .transform((s) => s.replace(/[\r\n]+/g, ' ')),
      channel: z.enum(['email', 'whatsapp'], { error: 'Choose how we should reply.' }),
      email: blank(z.email({ error: MSG.email }).max(200, MSG.email)),
      phone: blank(z.string().trim().max(30, MSG.phone)),
      description: z.string({ error: 'Tell us what you need.' }).trim()
        .min(5, 'Tell us a little more, at least a few words.').max(1000, MSG.tooLong),
    })
    .superRefine((d, ctx) => {
      if (d.channel === 'email' && !d.email) ctx.addIssue({ code: 'custom', path: ['email'], message: MSG.email });
      if (d.channel === 'whatsapp' && !d.phone) ctx.addIssue({ code: 'custom', path: ['phone'], message: MSG.phone });
      if (d.phone && !normalisePhone(d.phone, countryCode)) ctx.addIssue({ code: 'custom', path: ['phone'], message: MSG.phone });
    })
    .transform((d) => ({ ...d, phone: d.phone ? normalisePhone(d.phone, countryCode) : undefined }));
}

export const replySchema = z.object({
  answer: z.string({ error: 'Type your answer.' }).trim().min(1, 'Type your answer.').max(1000, MSG.tooLong),
});

const ID = /^[a-z0-9_]{2,40}$/;
export const requirementsSchema = z.object({
  service_id: z.string({ error: 'Choose a service.' }).regex(ID, 'Choose a service.'),
  quantity: z.coerce.number({ error: 'Enter a whole number.' }).int('Enter a whole number.')
    .min(1, 'Enter a whole number.').max(10000, 'Enter a smaller number.'),
  event_date: blank(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date.')),
  location: blank(z.string().trim().max(120, 'Keep the area under 120 characters.')),
  distance_km: blank(z.coerce.number().min(0).max(500)),
  addon_ids: z.preprocess(
    (v) => (v === undefined || v === '' ? [] : Array.isArray(v) ? v : [v]),
    z.array(z.string().regex(ID, 'Choose from the list.')).max(20),
  ),
  notes: blank(z.string().trim().max(1000, MSG.tooLong)),
});

/** First message per field, for the Error schema's `fields`. */
export function fieldErrors(zodError) {
  const fields = {};
  for (const issue of zodError.issues) {
    const key = issue.path[0] ?? '_form';
    if (!fields[key]) fields[key] = issue.message;
  }
  return fields;
}
