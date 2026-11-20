// The Contact section on a lead card: a fixed template message (no AI, no cap use), a contact typed in by
// the owner when the cited page had none, and three ways to reach the lead. Nothing is sent by the server
// unless the owner presses "Send from Liaisa"; mailto and wa.me open the owner's own app.
// Rules reused from Client Finder: nobody twice in 7 days (outreach and follow-ups), do-not-contact, own links only.
import { ConflictError, NotFoundError, ValidationError } from '../../errors.js';
import { buildWaLink } from '../whatsapp/link.js';
import { sendLogged } from '../quotes/mail.js';
import { enquiryUrl } from '../share.js';
import { identityOf, leadRows } from './people.js';
import { checkLinks } from './outreach.js';

const clock = (deps) => (deps.now ?? (() => new Date()))();
const conflict = (code, message) => Object.assign(new ConflictError(message), { code });
const sending = new Set(); // lead ids with an email in flight
const firstWord = (s) => String(s ?? '').trim().split(/\s+/)[0] ?? '';

/** The service and area the lead was found for (the "Find clients" run that produced it), if any. */
export function leadFocus(repos, lead) {
  const run = repos.discoveryRuns.all().find((r) => r.leadIds.includes(lead.id));
  return { service: run?.service ?? null, area: run?.area ?? null };
}

/** The fixed message. Business name, owner first name, the lead's organisation, matched service and area, own enquiry link. */
export function contactTemplate({ business, ownerName, lead, focus, link }) {
  const biz = business.businessName;
  const owner = firstWord(ownerName);
  const discovered = lead.kind === 'discovered';
  const intro = owner ? `I’m ${owner} from ${biz}${business.city ? ` in ${business.city}` : ''}.` : `This is ${biz}${business.city ? ` in ${business.city}` : ''}.`;
  const help = `We think we could help ${discovered ? lead.name : 'you'}${focus.service ? ` with ${focus.service.toLowerCase()}` : ''}${focus.area ? ` in ${focus.area}` : ''}.`;
  return [
    discovered ? `Hi team at ${lead.name},` : `Hi ${firstWord(lead.name)},`, '',
    `${intro} ${help}`, '',
    `If that sounds useful, you can tell us what you need and get a quote here: ${link}`, '',
    'Thanks,', owner || biz, ...(owner ? [biz] : []),
  ].join('\n');
}

/** Template for one lead, as the card shows it. */
export function composeTemplate(deps, lead, ownerName) {
  const { repos, config } = deps;
  return contactTemplate({
    business: { ...repos.businessSettings.get() }, ownerName, lead, focus: leadFocus(repos, lead), link: enquiryUrl(config, repos.business.slug),
  });
}

/** Save a contact the owner typed in. Only for a lead that has none, and never a duplicate of another lead. */
export function saveContact(deps, leadId, { email, phone }) {
  const { repos } = deps;
  const lead = repos.leads.get(leadId);
  if (!lead) throw new NotFoundError('That lead is not in your list.');
  if (lead.email || lead.phone) throw conflict('contact_exists', 'This lead already has a contact.');
  const key = identityOf({ email, phone, channel: email ? 'email' : 'whatsapp' });
  if (repos.leads.all().some((l) => l.id !== lead.id && identityOf({ email: l.email, phone: l.phone, channel: l.email ? 'email' : 'whatsapp' }) === key)) {
    throw conflict('duplicate_lead', 'This contact is already in your leads.');
  }
  return repos.leads.update(lead.id, { email, phone, typedContact: true });
}

/** mailto: with subject and body encoded (line breaks as CRLF, as mail apps expect). */
export function mailtoUrl(email, subject, body) {
  return `mailto:${encodeURIComponent(email).replace(/%40/g, '@')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body.replace(/\r?\n/g, '\r\n'))}`;
}

/**
 * The owner pressed one of the three buttons. Refuses do-not-contact and anyone contacted in the last 7 days,
 * records the contact, and moves the lead to Contacted. Returns { channel, status, url? } (url for mailto and wa.me).
 * `draftId`: an AI draft made with "Personalise with AI"; it is the record for this contact (its slot was already counted).
 */
export async function contactLead(deps, leadId, { action, message, draftId = null }) {
  const { repos, config, mailer } = deps;
  const now = clock(deps);
  const lead = repos.leads.get(leadId);
  if (!lead) throw new NotFoundError('That lead is not in your list.');
  const text = String(message ?? '').trim();
  if (text.length < 5 || text.length > 1000) throw new ValidationError('Write a message of up to 1,000 characters.', { message: 'Write a message of up to 1,000 characters.' });
  checkLinks(text, config.baseUrl);

  const row = leadRows(deps, now).find((l) => l.id === lead.id);
  if (row.block) {
    throw conflict(row.block.code, row.block.code === 'do_not_contact' ? `${lead.name} asked not to be contacted.` : row.block.text);
  }
  const channel = action === 'whatsapp' ? 'whatsapp' : 'email';
  if (channel === 'email' && !row.email) throw conflict('no_contact', 'There is no email address for this lead.');
  if (channel === 'whatsapp' && !row.phone) throw conflict('no_contact', 'There is no WhatsApp number for this lead.');
  if (action === 'send' && !mailer) throw conflict('mail_off', 'Email sending is switched off.');
  const subject = `A note from ${repos.businessSettings.get().businessName}`;

  let draft = null;
  if (draftId) {
    draft = repos.outreach.get(draftId);
    if (!draft || draft.leadId !== lead.id || !['draft', 'failed'].includes(draft.status)) throw conflict('already_sent', 'That draft was already used.');
  }
  const base = { subjectType: 'lead', leadId: lead.id, key: row.key, channel, name: lead.name, message: text, viaContact: true };
  const record = (status, extra = {}) => (draft
    ? repos.outreach.update(draft.id, { ...base, status, ...extra })
    : repos.outreach.create({ ...base, kind: 'contact', source: 'template', status, ...extra }, now));
  const markContacted = () => {
    if (!['replied', 'not_interested'].includes(repos.leads.get(lead.id).status)) repos.leads.update(lead.id, { status: 'contacted' });
  };

  if (action === 'send') {
    if (sending.has(lead.id)) throw conflict('sending', 'This message is already being sent.');
    sending.add(lead.id);
    try {
      const saved = record('sending'); // saved before sending
      const ok = await sendLogged(deps, { enquiryId: null, type: 'outreach', to: row.email, subject, text });
      repos.outreach.update(saved.id, ok ? { status: 'sent', sentAt: clock(deps) } : { status: 'failed' });
      if (ok) markContacted();
      return { channel, status: ok ? 'sent' : 'failed' };
    } finally {
      sending.delete(lead.id);
    }
  }
  // mailto and wa.me: the owner presses send in their own app, so this is recorded as "opened".
  const url = action === 'whatsapp' ? buildWaLink(row.phone, text) : mailtoUrl(row.email, subject, text);
  record('opened', { sentAt: now });
  markContacted();
  return { channel, status: 'opened', url };
}
