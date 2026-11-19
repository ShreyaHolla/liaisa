import { z } from 'zod';

// Names go into the email subject, so strip CR/LF and other control characters
// (header injection, TC-CON-06). Runs of them become one space.
export function cleanName(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const MESSAGES = {
  name: 'Enter your name.',
  email: 'Enter a valid email address, like name@example.com.',
  message: 'Enter a message.',
  messageTooLong: 'Keep your message to 2,000 characters or fewer.',
};

const str = (v) => (typeof v === 'string' ? v : '');

export const contactSchema = z.object({
  name: z.preprocess(cleanName, z.string().min(1, MESSAGES.name).max(120, MESSAGES.name)),
  email: z.preprocess(
    (v) => str(v).trim(),
    z.string().min(1, MESSAGES.email).max(200, MESSAGES.email).email(MESSAGES.email),
  ),
  message: z.preprocess(
    (v) => str(v).trim(),
    z.string().min(1, MESSAGES.message).max(2000, MESSAGES.messageTooLong),
  ),
});
