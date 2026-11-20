import { z } from 'zod';

export const PASSWORD_MIN = 10;
const text = (label, min, max) => z.string({ error: `Enter ${label}.` }).trim()
  .min(min, `Enter ${label}.`).max(max, `Keep ${label} under ${max} characters.`)
  .refine((v) => !/[\u0000-\u001f<>]/.test(v), `${label[0].toUpperCase()}${label.slice(1)} has characters we can't use.`);

/** The signup form. The password is not trimmed (spaces count) and never echoed back. */
export const signupSchema = z.object({
  businessName: text('your business name', 2, 80),
  ownerName: text('your name', 2, 80),
  email: z.string({ error: 'Enter your email address.' }).trim().toLowerCase().max(254, 'That email address is too long.').email('Enter a valid email address.'),
  password: z.string({ error: `Choose a password of at least ${PASSWORD_MIN} characters.` })
    .min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters.`).max(200, 'Keep the password under 200 characters.'),
  city: text('your city', 2, 60),
});
