// zod schema for the business setup form (/owner/setup). Prices and fees are whole rupees, 0 or more.
import { z } from 'zod';
import { normalisePhone } from '../enquiries/schema.js';

export const MAX_SERVICES = 10;
export const MAX_AREAS = 20;

const blank = (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const WHOLE = 'Enter a whole number of rupees, 0 or more.';
const rupees = z.preprocess(blank, z.coerce.number({ error: WHOLE }).int(WHOLE).min(0, WHOLE).max(10_000_000, 'Enter a smaller amount.'));
const percent = z.preprocess(blank, z.coerce.number({ error: 'Enter a percentage from 0 to 100.' })
  .min(0, 'Enter a percentage from 0 to 100.').max(100, 'Enter a percentage from 0 to 100.')
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-9, 'Use at most 2 decimal places.'));

/** 'Veg Buffet!' -> 'veg_buffet'. Matches the service_id pattern in openapi (2-40 of a-z 0-9 _). */
export function slugify(name) {
  return String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40).replace(/_+$/, '');
}

const service = z.object({
  id: z.string().optional(),
  name: z.string({ error: 'Enter a name.' }).trim().min(1, 'Enter a name.').max(80, 'Keep the name under 80 characters.'),
  price: rupees,
  minQty: z.preprocess(blank, z.coerce.number({ error: 'Enter a whole number, 1 or more.' }).int('Enter a whole number, 1 or more.').min(1, 'Enter a whole number, 1 or more.').max(10000, 'Enter a smaller number.')),
  maxQty: z.preprocess(blank, z.coerce.number({ error: 'Enter a whole number, or leave it empty.' }).int('Enter a whole number, or leave it empty.').min(1, 'Enter a whole number, or leave it empty.').max(10000, 'Enter a smaller number.').optional()),
  unitLabel: z.preprocess(blank, z.string().trim().max(40, 'Keep the label under 40 characters.').default('Number of guests')),
}).superRefine((s, ctx) => {
  if (s.maxQty !== undefined && s.maxQty < s.minQty) ctx.addIssue({ code: 'custom', path: ['maxQty'], message: 'The maximum can’t be less than the minimum.' });
});

const area = z.object({
  name: z.string({ error: 'Enter an area name.' }).trim().min(1, 'Enter an area name.').max(60, 'Keep the name under 60 characters.'),
  fee: rupees,
});

export function makeSetupSchema(countryCode) {
  return z.object({
    businessName: z.string({ error: 'Enter the business name.' }).trim().min(1, 'Enter the business name.').max(120, 'Keep the name under 120 characters.'),
    tagline: z.preprocess(blank, z.string().trim().max(200, 'Keep the tagline under 200 characters.').optional()),
    currencySymbol: z.preprocess(blank, z.string().trim().min(1).max(3, 'Use 1 to 3 characters, like ₹.').default('₹')),
    whatsappNumber: z.preprocess(blank, z.string().trim().max(30, 'Enter a 10-digit mobile number, like 98450 12345.').optional()),
    bulkApproveLimit: z.preprocess(blank, z.coerce.number({ error: 'Enter a whole number of rupees, or leave it empty.' }).int('Enter a whole number of rupees, or leave it empty.').min(1, 'Enter a whole number of rupees, or leave it empty.').max(10_000_000, 'Enter a smaller amount.').optional()),
    autoApprove: z.boolean().default(false),
    city: z.preprocess(blank, z.string().trim().max(80, 'Keep the city under 80 characters.').optional()),
    followupAfterDays: z.preprocess(blank, z.coerce.number({ error: 'Enter a whole number of days, 0 to 60.' }).int('Enter a whole number of days, 0 to 60.').min(0, 'Enter a whole number of days, 0 to 60.').max(60, 'Enter a whole number of days, 0 to 60.').default(2)),
    weekendPct: percent,
    taxPct: percent,
    services: z.array(service).min(1, 'Keep at least one service.').max(MAX_SERVICES, `You can have up to ${MAX_SERVICES} services.`),
    areas: z.array(area).min(1, 'Keep at least one area.').max(MAX_AREAS, `You can have up to ${MAX_AREAS} areas.`),
  }).superRefine((d, ctx) => {
    if (d.autoApprove && d.bulkApproveLimit === undefined) {
      ctx.addIssue({ code: 'custom', path: ['autoApprove'], message: 'Set a limit first, so auto-approve knows what a clean quote is.' });
    }
    if (d.whatsappNumber && !normalisePhone(d.whatsappNumber, countryCode)) {
      ctx.addIssue({ code: 'custom', path: ['whatsappNumber'], message: 'Enter a 10-digit mobile number, like 98450 12345.' });
    }
    // Duplicates after slugifying: 'Veg buffet' and 'veg  buffet!' are the same service.
    const seen = new Map();
    d.services.forEach((s, i) => {
      const slug = slugify(s.name);
      if (slug.length < 2) return ctx.addIssue({ code: 'custom', path: ['services', i, 'name'], message: 'Use at least 2 letters or numbers in the name.' });
      if (seen.has(slug)) return ctx.addIssue({ code: 'custom', path: ['services', i, 'name'], message: 'Another service already has this name.' });
      seen.set(slug, i);
    });
    const names = new Set();
    d.areas.forEach((a, i) => {
      const key = a.name.toLowerCase().replace(/\s+/g, ' ');
      if (names.has(key)) ctx.addIssue({ code: 'custom', path: ['areas', i, 'name'], message: 'Another area already has this name.' });
      names.add(key);
    });
  });
}
