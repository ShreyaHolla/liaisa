// Send one email and record it in `emails` (accepted or failed). Never throws on a send failure.
// Every business sends from the platform mailbox, with its own name in the From line and its owner as Reply-To.

/** The owner's email for THIS business (signup email; for the demo, OWNER_EMAIL). Never another business's. */
export const ownerEmailOf = (repos) => repos.business.ownerEmail ?? repos.businessSettings.get()?.ownerEmail ?? null;

/** `"<Business> via Liaisa" <platform address>`: the address from MAIL_FROM, the display name from the business. */
export function fromFor(config, repos) {
  const address = /<([^>]+)>/.exec(config.mailFrom)?.[1] ?? config.mailFrom;
  const name = String(repos.business.name ?? '').replace(/[\r\n"<>,;:\\]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return name ? `"${name} via Liaisa" <${address}>` : config.mailFrom;
}

export async function sendLogged(deps, { enquiryId = null, type, to, subject, text, html }) {
  const { repos, mailer, config } = deps;
  const now = (deps.now ?? (() => new Date()))();
  try {
    const replyTo = type === 'owner_notice' || type === 'contact' ? null : ownerEmailOf(repos);
    const info = await mailer.send({ from: fromFor(config, repos), to, subject, text, ...(replyTo ? { replyTo } : {}), ...(html ? { html } : {}) });
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
  const to = ownerEmailOf(deps.repos);
  if (!deps.mailer || !to) return false;
  return sendLogged(deps, { enquiryId, type: 'owner_notice', to, subject, text });
}
