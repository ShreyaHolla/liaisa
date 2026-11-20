// M8-lite follow-ups: a manual, owner-sent reminder for a quote that got no reply. No scheduler, no AI call.
// Eligibility is computed from the data (nothing is scheduled), so it can't go stale:
//   the quote was sent, the customer hasn't responded, fewer than 2 reminders went out for THIS quote
//   version, the owner hasn't marked it done, and `followupAfterDays` have passed since the quote
//   (or the last reminder). A new quote version is a new estimate row, so its count starts at 0.
import { ConflictError, NotFoundError } from '../../errors.js';
import { formatDate } from '../../util/formatDate.js';
import { buildWaLink } from '../whatsapp/link.js';
import { currentEstimate } from '../quotes/approval.js';
import { quoteUrl } from '../quotes/messages.js';
import { sendLogged } from '../quotes/mail.js';

export const MAX_REMINDERS = 2;
export const DEFAULT_AFTER_DAYS = 2;
const DAY = 86400000;
const clock = (deps) => (deps.now ?? (() => new Date()))();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const afterDaysOf = (repos) => repos.businessSettings.get()?.followupAfterDays ?? DEFAULT_AFTER_DAYS;

/** Reminders that actually went out for one quote version, oldest first. */
const sentFor = (repos, enquiryId, estimateId) => repos.followups.listByEnquiry(enquiryId)
  .filter((f) => f.estimateId === estimateId && f.status === 'sent').sort((a, b) => a.step - b.step);

/** When the current quote reached the customer: the latest accepted email or WhatsApp share since approval. */
function quoteSentAt(repos, enquiryId, estimate) {
  const from = estimate.approvedAt?.getTime() ?? 0;
  const times = [
    ...repos.emails.listByEnquiry(enquiryId).filter((e) => e.type === 'estimate' && e.status === 'accepted').map((e) => e.createdAt),
    ...repos.whatsappShares.listByEnquiry(enquiryId).filter((s) => s.type === 'estimate').map((s) => s.createdAt),
  ].map((d) => d.getTime()).filter((t) => t >= from);
  return new Date(Math.max(from, ...times));
}

/**
 * Where an enquiry stands. reason: ok | not_quoted | done | responded | open_question | cap | waiting.
 * `due` is true only for ok; `show` is true while the Follow up panel is worth showing.
 */
export function followupState({ repos }, enquiry, now = new Date()) {
  const estimate = currentEstimate(repos, enquiry.id);
  const none = (reason) => ({ reason, due: false, show: false, estimate, sentCount: 0 });
  if (!['quoted', 'followed_up'].includes(enquiry.status) || estimate?.status !== 'sent') return none('not_quoted');
  if (estimate.followupDoneAt) return none('done');
  const responses = repos.customerResponses.listByEnquiry(enquiry.id);
  if (responses.some((r) => r.type === 'accept' || r.type === 'decline')) return none('responded');
  if (responses.at(-1)?.type === 'question') return none('open_question');

  const sent = sentFor(repos, enquiry.id, estimate.id);
  const quoteSent = quoteSentAt(repos, enquiry.id, estimate);
  const base = { estimate, sentCount: sent.length, quoteSentAt: quoteSent, show: true };
  if (sent.length >= MAX_REMINDERS) return { ...base, reason: 'cap', due: false };
  const baseline = sent.at(-1)?.sentAt ?? quoteSent;
  const dueAt = new Date(baseline.getTime() + afterDaysOf(repos) * DAY);
  return { ...base, dueAt, reason: now >= dueAt ? 'ok' : 'waiting', due: now >= dueAt };
}

const REASON_TEXT = {
  not_quoted: 'This quote hasn’t been sent, or the enquiry has moved on.',
  done: 'This follow-up was marked as done.',
  responded: 'The customer has already replied to this quote.',
  open_question: 'The customer has a question open. Answer it before sending a reminder.',
  cap: 'Both reminders for this quote have already been sent.',
  waiting: 'It’s too early for a reminder on this quote.',
};

/** Quotes due a reminder now, oldest quote first (dashboard "Follow-up due"). */
export function dueFollowUps(deps, now = new Date()) {
  const { repos } = deps;
  return repos.enquiries.list().map((enquiry) => ({ enquiry, state: followupState(deps, enquiry, now) }))
    .filter((x) => x.state.due)
    .sort((a, b) => a.state.quoteSentAt - b.state.quoteSentAt)
    .map(({ enquiry, state }) => ({ enquiry, state }));
}

/** The reminder text: a fixed template (customer name, service, date, quote link). */
export function draftReminder({ repos, config }, enquiry, state) {
  const { estimate } = state;
  const business = repos.businessSettings.get();
  const pricing = (repos.pricingConfigs.get(estimate.pricingConfigId) ?? repos.pricingConfigs.latestApproved()).configJson;
  const requirements = enquiry.requirementsJson ?? {};
  const service = pricing.services.find((s) => s.id === requirements.service_id)?.name;
  const date = requirements.event_date ? formatDate(requirements.event_date) : null;
  const link = quoteUrl(config, estimate.quoteToken);
  const name = enquiry.customerName.split(' ')[0];
  const second = state.sentCount >= 1;
  const valid = estimate.validUntil ? formatDate(estimate.validUntil) : null;

  const about = `${service ? `${service.toLowerCase()} ` : ''}quote from ${business.businessName}${date ? ` for ${date}` : ''}`;
  const text = `Hi ${name}, just checking in on your ${about}.${second && valid ? ` It’s valid until ${valid}.` : ''} `
    + `You can view and accept it here: ${link} If you have any questions, just reply.`;
  const subject = second && valid ? `Your quote from ${business.businessName} expires on ${valid}`
    : date ? `Still planning your ${date} event?` : `Still thinking about your quote from ${business.businessName}?`;
  const html = `<!doctype html><html><body style="margin:0;background:#f3f2f7;font-family:system-ui,Arial,sans-serif;color:#1e1a24;">
<div style="max-width:600px;margin:0 auto;padding:24px;background:#ffffff;">
<p>Hi ${esc(name)},</p>
<p>Just checking in on your ${esc(about)}.${second && valid ? ` It’s valid until ${esc(valid)}.` : ''}</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#17735e;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">View and accept your quote</a></p>
<p style="color:#555e6b;">If you have any questions, just reply to this email.</p>
<p style="color:#555e6b;">${esc(business.businessName)}</p>
</div></body></html>`;
  const emailText = `Hi ${name},\n\nJust checking in on your ${about}.${second && valid ? ` It’s valid until ${valid}.` : ''}\n\nView and accept your quote: ${link}\n\nIf you have any questions, just reply to this email.\n\n${business.businessName}`;
  return { subject, text, emailText, html, link };
}

function mustGet(repos, id) {
  const enquiry = repos.enquiries.get(id);
  if (!enquiry) throw new NotFoundError('Enquiry not found');
  return enquiry;
}

const nextStep = (repos, enquiryId) => Math.max(0, ...repos.followups.listByEnquiry(enquiryId).map((f) => f.step)) + 1;

/**
 * Owner pressed "Send reminder". Email: send it (saved first, status sent or failed).
 * WhatsApp: record it and return the wa.me link; the owner taps Send in WhatsApp.
 * Refuses unless the follow-up rules say it is due (service layer, not just the button).
 */
export async function sendReminder(deps, enquiryId) {
  const { repos, mailer } = deps;
  const now = clock(deps);
  const enquiry = mustGet(repos, enquiryId);
  const state = followupState(deps, enquiry, now);
  if (!state.due) throw new ConflictError(REASON_TEXT[state.reason]);
  const { estimate } = state;
  if (repos.followups.listByEnquiry(enquiryId).some((f) => f.estimateId === estimate.id && f.status === 'sending')) {
    throw new ConflictError('A reminder is already being sent.');
  }
  const draft = draftReminder(deps, enquiry, state);
  const row = (status, extra = {}) => ({ enquiryId, step: nextStep(repos, enquiryId), dueAt: state.dueAt, channel: enquiry.preferredChannel, status, estimateId: estimate.id, ...extra });
  const moveOn = () => { if (enquiry.status === 'quoted') repos.enquiries.update(enquiryId, { status: 'followed_up' }); };

  if (enquiry.preferredChannel === 'whatsapp') {
    if (!enquiry.customerPhone) throw new ConflictError('This customer didn’t give a phone number.');
    const url = buildWaLink(enquiry.customerPhone, draft.text); // validates the number before anything is recorded
    const created = repos.followups.create(row('sent', { sentAt: now }), now);
    repos.whatsappShares.create({ enquiryId, type: 'followup', followupId: created.id }, now);
    moveOn();
    return { channel: 'whatsapp', status: 'sent', url };
  }

  if (!mailer) throw new ConflictError('Email sending is switched off.');
  if (!enquiry.customerEmail) throw new ConflictError('This customer didn’t give an email address.');
  const created = repos.followups.create(row('sending'), now); // saved before sending
  const ok = await sendLogged(deps, { enquiryId, type: 'followup', to: enquiry.customerEmail, subject: draft.subject, text: draft.emailText, html: draft.html });
  repos.followups.update(created.id, ok ? { status: 'sent', sentAt: clock(deps) } : { status: 'failed' });
  if (ok) moveOn();
  return { channel: 'email', status: ok ? 'sent' : 'failed' };
}

/** "Mark as done": hide the follow-up for this quote version. Doing it twice is fine. */
export function markFollowupDone(deps, enquiryId) {
  const { repos } = deps;
  const enquiry = mustGet(repos, enquiryId);
  const estimate = currentEstimate(repos, enquiry.id);
  if (!estimate || estimate.status !== 'sent') throw new ConflictError(REASON_TEXT.not_quoted);
  if (!estimate.followupDoneAt) repos.estimates.update(estimate.id, { followupDoneAt: clock(deps) });
}
