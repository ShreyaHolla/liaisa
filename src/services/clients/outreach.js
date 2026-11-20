// Client Finder (M10-lite): draft, approve, send. Nothing is sent automatically: the only way to
// send is sendDraft(), which needs a saved draft and the owner's approved text.
import { ConflictError, NotFoundError, ValidationError } from '../../errors.js';
import { buildWaLink } from '../whatsapp/link.js';
import { sendLogged } from '../quotes/mail.js';
import { todayIST } from '../agent/runTurn.js';
import { reconnectRows, leadRows, blockOf, identityOf } from './people.js';
import { factsFor, generateDraft } from './draft.js';

const clock = (deps) => (deps.now ?? (() => new Date()))();
const conflict = (code, message) => Object.assign(new ConflictError(message), { code });
const inFlight = new Set();

const BLOCK_TEXT = {
  do_not_contact: (name) => `${name} asked not to be contacted, so no message can be drafted.`,
};

/** Find the person a draft is about, with their current block (do not contact / contacted recently). */
function resolve(deps, type, ref, now) {
  if (type === 'lead') {
    const lead = leadRows(deps, now).find((l) => String(l.id) === ref);
    if (!lead) throw new NotFoundError('That lead is not in your list.');
    return { subject: { type: 'lead', name: lead.name, note: lead.note }, key: lead.key, channel: lead.channel, block: lead.block, leadId: lead.id,
      contact: { email: lead.email, phone: lead.phone }, name: lead.name };
  }
  const row = reconnectRows(deps, now).find((r) => r.key === ref);
  if (!row) throw new NotFoundError('That customer is not in your reconnect list.');
  const enquiry = deps.repos.enquiries.get(row.enquiryId);
  return { subject: { type: 'customer', ...row }, key: row.key, channel: row.channel, block: row.block, enquiryId: row.enquiryId,
    contact: { email: enquiry.customerEmail, phone: enquiry.customerPhone }, name: row.name };
}

const hasContact = (channel, contact) => (channel === 'whatsapp' ? Boolean(contact.phone) : Boolean(contact.email));

/** Drafts created today (IST), counting every one, AI or template. */
export function draftsToday(repos, now) {
  const today = todayIST(now);
  return repos.outreach.all().filter((o) => todayIST(o.createdAt) === today).length;
}

/**
 * Create (or reuse) a draft for one person. Refuses do-not-contact people, anyone contacted in the
 * last 7 days, and anything past the daily draft limit. The slot is reserved before the AI call,
 * so two quick clicks cannot go over the limit.
 */
export async function createDraft(deps, { type, ref }) {
  const { repos, config } = deps;
  const now = clock(deps);
  const who = resolve(deps, type, ref, now);
  if (who.block) throw conflict(who.block.code, who.block.code === 'do_not_contact' ? BLOCK_TEXT.do_not_contact(who.name) : who.block.text);
  if (!hasContact(who.channel, who.contact)) throw conflict('no_contact', `There is no ${who.channel === 'whatsapp' ? 'WhatsApp number' : 'email address'} for ${who.name}.`);

  const open = repos.outreach.all().find((o) => o.key === who.key && o.status === 'draft');
  if (open) return open; // an unsent draft already exists: no new AI call, no new slot

  const cap = config.clientDraftDailyCap;
  if (draftsToday(repos, now) >= cap) throw conflict('draft_limit', `You’ve reached today’s limit of ${cap} drafts. Try again tomorrow.`);

  const row = repos.outreach.create({
    subjectType: type, key: who.key, channel: who.channel, status: 'draft', message: '', name: who.name,
    reason: who.subject.reason?.text ?? 'new contact', enquiryId: who.enquiryId ?? null, leadId: who.leadId ?? null,
  }, now);
  const business = repos.businessSettings.get();
  let result;
  try {
    result = await generateDraft(deps, factsFor(who.subject, business));
  } catch {
    result = null; // never leave the owner without a draft
  }
  const footer = `\n\nYou can reach us any time: ${config.baseUrl.replace(/\/$/, '')}/enquire`;
  const body = result?.text ?? factsFallback(who.subject, business);
  return repos.outreach.update(row.id, { message: `${body}${footer}`, source: result?.source ?? 'template' });
}

function factsFallback(subject, business) {
  return `Hi ${subject.name.trim().split(/\s+/)[0]}, this is ${business.businessName}. We would be glad to help if you are planning something.`;
}

const URL_IN_TEXT = /\b(?:https?:\/\/|www\.)\S+/gi;

/** Only the business's own links may go out in a message. */
function checkLinks(text, baseUrl) {
  const own = baseUrl.replace(/\/$/, '');
  for (const link of text.match(URL_IN_TEXT) ?? []) {
    if (!link.startsWith(`${own}/`) && link !== own) throw new ValidationError('Only your own enquiry or quote link can go in a message.', { message: 'Only your own enquiry or quote link can go in a message.' });
  }
}

/**
 * The owner approved this text: send it. Email goes through the mail service (saved first, then marked
 * sent or failed); WhatsApp returns a wa.me link, and the owner taps Send there.
 */
export async function sendDraft(deps, draftId, text) {
  const { repos, config, mailer } = deps;
  const now = clock(deps);
  const row = repos.outreach.get(draftId);
  if (!row) throw new NotFoundError('That draft was not found.');
  if (!['draft', 'failed'].includes(row.status)) throw conflict('already_sent', 'This message has already been sent.');
  const clean = String(text ?? '').trim();
  if (clean.length < 5 || clean.length > 1000) throw new ValidationError('Write a message of up to 1,000 characters.', { message: 'Write a message of up to 1,000 characters.' });
  checkLinks(clean, config.baseUrl);

  // The person is checked again now: something may have changed since the draft was written.
  const who = resolve(deps, row.subjectType, row.subjectType === 'lead' ? String(row.leadId) : row.key, now);
  const block = blockOf(repos, who.key, who.enquiryId ? [who.enquiryId] : [], now);
  if (block) throw conflict(block.code, block.code === 'do_not_contact' ? BLOCK_TEXT.do_not_contact(who.name) : block.text);
  if (!hasContact(row.channel, who.contact)) throw conflict('no_contact', 'There is no contact detail for this person.');

  if (row.channel === 'whatsapp') {
    const url = buildWaLink(who.contact.phone, clean); // validates the number before anything is recorded
    repos.outreach.update(row.id, { status: 'opened', message: clean, sentAt: now });
    return { channel: 'whatsapp', status: 'opened', url };
  }
  if (!mailer) throw conflict('mail_off', 'Email sending is switched off.');
  if (inFlight.has(row.id)) throw conflict('sending', 'This message is already being sent.');
  inFlight.add(row.id);
  try {
    repos.outreach.update(row.id, { status: 'sending', message: clean }); // saved before sending
    const business = repos.businessSettings.get();
    const ok = await sendLogged(deps, {
      enquiryId: who.enquiryId ?? null, type: 'outreach', to: who.contact.email,
      subject: `A note from ${business.businessName}`, text: clean,
    });
    repos.outreach.update(row.id, ok ? { status: 'sent', sentAt: clock(deps) } : { status: 'failed' });
    return { channel: 'email', status: ok ? 'sent' : 'failed' };
  } finally {
    inFlight.delete(row.id);
  }
}

/** Never contact this person again (all their enquiries, or the lead). */
export function markDoNotContact(deps, { type, ref }) {
  const { repos } = deps;
  const who = resolve(deps, type, ref, clock(deps));
  if (type === 'lead') repos.leads.update(who.leadId, { doNotContact: true });
  else for (const e of repos.enquiries.list()) if (identityOf({ email: e.customerEmail, phone: e.customerPhone, channel: e.preferredChannel }) === who.key) repos.enquiries.update(e.id, { doNotContact: true });
  // An unsent draft for them is no longer wanted.
  for (const o of repos.outreach.all()) if (o.key === who.key && o.status === 'draft') repos.outreach.update(o.id, { status: 'discarded', message: '' });
}

/** Add one lead. The same contact twice is refused. */
export function addLead(deps, input) {
  const { repos } = deps;
  const key = identityOf({ email: input.email, phone: input.phone, channel: input.email ? 'email' : 'whatsapp' });
  if (repos.leads.all().some((l) => identityOf({ email: l.email, phone: l.phone, channel: l.email ? 'email' : 'whatsapp' }) === key)) {
    throw conflict('duplicate_lead', 'This contact is already in your leads.');
  }
  return repos.leads.create(input, clock(deps));
}

/** Messages that were sent, opened or failed, newest first (the activity log). */
export function activityLog({ repos }, limit = 20) {
  const label = { sent: 'Sent', opened: 'Opened in WhatsApp', failed: 'Didn’t send', sending: 'Sending' };
  return repos.outreach.all().filter((o) => !['draft', 'discarded'].includes(o.status)).sort((a, b) => (b.sentAt ?? b.createdAt) - (a.sentAt ?? a.createdAt)).slice(0, limit)
    .map((o) => ({ name: o.name, channel: o.channel, status: label[o.status], at: o.sentAt ?? o.createdAt }));
}
