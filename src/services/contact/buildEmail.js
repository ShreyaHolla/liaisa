import { cleanName } from './schema.js';

/** Pure: builds the owner notification for a contact message (DESIGN §7 emails). */
export function buildContactEmail({ name, email, message }, { from, to }) {
  const safeName = cleanName(name);
  return {
    from,
    to,
    replyTo: email, // visitor's address only; never the name, so it can't carry extra headers
    subject: `Website message from ${safeName}`,
    text: `${safeName} <${email}> wrote:\n\n${message}\n`,
  };
}
