import { createContactMessageStore } from './db/repos/contactMessages.js';
import { createSmtpMailer } from './mail/smtpTransport.js';

/** Wires adapters by env. mailer is null when MAIL_ENABLED=false. */
export function buildDeps(config) {
  return {
    store: createContactMessageStore(),
    mailer: config.mailEnabled ? createSmtpMailer(config.smtp) : null,
  };
}
