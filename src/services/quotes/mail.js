// Send one email and record it in `emails` (accepted or failed). Never throws on a send failure.
export async function sendLogged(deps, { enquiryId = null, type, to, subject, text, html }) {
  const { repos, mailer, config } = deps;
  const now = (deps.now ?? (() => new Date()))();
  try {
    const info = await mailer.send({ from: config.mailFrom, to, subject, text, ...(html ? { html } : {}) });
    repos.emails.create({ enquiryId, type, toAddress: to, subject, status: 'accepted', providerMessageId: info?.messageId ?? null }, now);
    return true;
  } catch (err) {
    // Log the error code only: SMTP messages can echo hostnames or addresses.
    const code = String(err?.code ?? err?.responseCode ?? err?.name ?? 'send_failed').slice(0, 100);
    repos.emails.create({ enquiryId, type, toAddress: to, subject, status: 'failed', error: code }, now);
    return false;
  }
}

/** Best-effort note to the owner. Skipped when email is off. Never blocks or fails the caller. */
export async function notifyOwner(deps, enquiryId, { subject, text }) {
  const to = deps.config.ownerEmail ?? deps.repos.businessSettings.get()?.ownerEmail;
  if (!deps.mailer || !to) return false;
  return sendLogged(deps, { enquiryId, type: 'owner_notice', to, subject, text });
}
