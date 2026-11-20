import { buildContactEmail } from './buildEmail.js';

/** How long the visitor waits for the mail server before we answer anyway (the send carries on). */
export const SEND_WAIT_MS = 4000;

/** A short, safe reason for an SMTP failure. Never the server's own text, which can echo addresses or content. */
function reasonOf(code) {
  if (code === 'EAUTH') return 'login rejected';
  if (['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'ECONNREFUSED', 'ENOTFOUND', 'EDNS'].includes(code)) return 'could not connect';
  if (code === 'EENVELOPE') return 'no valid recipient';
  return 'send failed';
}

/**
 * Save first, then try email. The message is safe the moment `store.save` returns, whatever happens to the mail.
 * `mailer` is null when MAIL_ENABLED=false: nothing is sent and status is 'skipped'.
 * Resolves once saved, plus up to `waitMs` for the send; a slow send finishes in the background and sets the status.
 * Returns the saved record. Only a failed SAVE throws.
 */
export async function submitContact(input, { store, mailer, config, log = console, waitMs = SEND_WAIT_MS }) {
  const record = await store.save({ ...input, emailStatus: mailer ? 'pending' : 'skipped' });
  if (!mailer) return record;

  const send = (async () => {
    try {
      await mailer.send(buildContactEmail(input, { from: config.mailFrom, to: config.ownerEmail }));
      await store.setStatus(record.id, 'accepted');
    } catch (err) {
      const code = typeof err?.code === 'string' ? err.code : 'UNKNOWN';
      const reason = reasonOf(code);
      log.error(`Contact email not sent (message ${record.id}): ${code} (${reason})`);
      try {
        await store.setStatus(record.id, 'failed', { error: `${code}: ${reason}` });
      } catch {
        /* the message itself is already saved */
      }
    }
  })();

  let timer;
  await Promise.race([send, new Promise((resolve) => { timer = setTimeout(resolve, waitMs); timer.unref?.(); })]);
  clearTimeout(timer);
  return (await store.list()).find((r) => r.id === record.id) ?? record;
}
