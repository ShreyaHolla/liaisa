// zod schemas for the Client Finder forms (M10-lite).
import { z } from 'zod';
import { normalisePhone } from '../enquiries/schema.js';

const CONTACT = 'Enter an email address or a 10-digit mobile number, like 98450 12345.';

/** Lead form: name, one contact (email or WhatsApp number), a one-line note. */
export function makeLeadSchema(countryCode) {
  return z.object({
    name: z.string({ error: 'Enter a name.' }).trim().min(1, 'Enter a name.').max(120, 'Keep the name under 120 characters.')
      .transform((s) => s.replace(/[\r\n]+/g, ' ')),
    contact: z.string({ error: CONTACT }).trim().min(1, CONTACT).max(200, CONTACT)
      .refine((v) => (v.includes('@') ? z.email().max(200).safeParse(v).success : normalisePhone(v, countryCode) !== null), CONTACT),
    note: z.string({ error: 'Add a short note about who they are.' }).trim()
      .min(3, 'Add a short note about who they are.').max(200, 'Keep the note under 200 characters.').transform((s) => s.replace(/[\r\n]+/g, ' ')),
  }).transform((d) => (d.contact.includes('@')
    ? { name: d.name, note: d.note, email: d.contact.toLowerCase(), phone: null }
    : { name: d.name, note: d.note, email: null, phone: normalisePhone(d.contact, countryCode) }));
}

/** A contact typed in for a lead that has none: one email address or one mobile number. */
export function makeContactSchema(countryCode) {
  return z.object({
    contact: z.string({ error: CONTACT }).trim().min(1, CONTACT).max(200, CONTACT)
      .refine((v) => (v.includes('@') ? z.email().max(200).safeParse(v).success : normalisePhone(v, countryCode) !== null), CONTACT),
  }).transform((d) => (d.contact.includes('@')
    ? { email: d.contact.toLowerCase(), phone: null }
    : { email: null, phone: normalisePhone(d.contact, countryCode) }));
}

/** The three ways to reach a lead from its Contact section. The message is the owner's edited text. */
export const contactActionSchema = z.object({
  action: z.enum(['mailto', 'send', 'whatsapp']),
  message: z.string({ error: 'Write a message.' }).trim().min(5, 'Write a message.').max(1000, 'Keep it under 1,000 characters.'),
  draftId: z.preprocess((v) => (v === '' || v === undefined ? undefined : Number(v)), z.number().int().positive().optional()),
});

/** Who a draft or a do-not-contact click is about. */
export const subjectSchema = z.object({
  type: z.enum(['customer', 'lead']),
  ref: z.string().trim().min(1).max(250),
});

/** The text the owner approves. Never longer than a short message. */
export const sendSchema = z.object({
  message: z.string({ error: 'Write a message.' }).trim().min(5, 'Write a message.').max(1000, 'Keep it under 1,000 characters.'),
});
