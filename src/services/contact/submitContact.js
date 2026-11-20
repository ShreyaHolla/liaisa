import { buildContactEmail } from './buildEmail.js';

/**
 * Save first, then send. A failed send never loses the message (F2 AC).
 * `mailer` is null when MAIL_ENABLED=false: nothing is sent and status is 'skipped'.
 * Returns the saved record.
 */
export async function submitContact(input, { store, mailer, config, log = console }) {
  // Until the send succeeds the honest status is 'failed' (not delivered), so a crash
  // mid-send can't leave a message looking delivered. With mail off it is 'skipped'.
  const record = await store.save({ ...input, emailStatus: mailer ? 'failed' : 'skipped' });
  if (!mailer) return record;

  try {
    await mailer.send(buildContactEmail(input, { from: config.mailFrom, to: config.ownerEmail }));
    return await store.setStatus(record.id, 'accepted');
  } catch (err) {
    // Never log credentials. SMTP errors carry a message and the failing command only.
    log.error(
      `Contact email send failed (message ${record.id}): ${err?.code ?? 'unknown error'}` +
        ` | message: ${err?.message ?? 'n/a'} | command: ${err?.command ?? 'n/a'}`,
    );
    return record;
  }
}
