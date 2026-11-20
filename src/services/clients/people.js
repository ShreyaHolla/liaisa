// Client Finder (M10-lite): who can the owner reconnect with? Plain server-side rules, no AI.
// A "person" is one customer across all their enquiries, identified by email (or WhatsApp number).
import { currentEstimate } from '../quotes/approval.js';
import { formatDate } from '../../util/formatDate.js';
import { todayIST } from '../agent/runTurn.js';

export const QUIET_AFTER_DAYS = 5; // a sent quote with no reply this long counts as quiet
export const RECENT_CONTACT_DAYS = 7; // nobody is contacted twice inside this window
const DAY = 86400000;

/** Stable key for one person: their reply channel's contact, lower-cased / digits only. */
export function identityOf({ email, phone, channel }) {
  const e = email?.trim().toLowerCase();
  const p = phone?.replace(/\D/g, '');
  if (channel === 'whatsapp' && p) return `p:${p}`;
  if (e) return `e:${e}`;
  return p ? `p:${p}` : null;
}
const keyOfEnquiry = (e) => identityOf({ email: e.customerEmail, phone: e.customerPhone, channel: e.preferredChannel });

const dayNumber = (iso) => Math.floor(new Date(`${iso}T00:00:00Z`).getTime() / DAY);
const daysBetween = (fromIso, toIso) => dayNumber(toIso) - dayNumber(fromIso);

const EVENT_TYPES = [
  [/house-?warming|griha pravesh/i, 'housewarming'], [/wedding|reception|sangeet|mehendi/i, 'wedding'], [/engagement/i, 'engagement'],
  [/birthday/i, 'birthday'], [/anniversary/i, 'anniversary'], [/baby shower|naming ceremony/i, 'baby shower'],
  [/farewell/i, 'farewell'], [/office|team|corporate|company/i, 'office event'], [/puja|festival|diwali|ganesh/i, 'festival'],
];
const DISCOUNT_WORDS = /discount|cheaper|negotiat|too expensive|too costly|lower (the )?price|bargain/i;

/** 'housewarming', 'birthday', … when the customer's own words say so, else null. */
export function eventTypeOf(text) {
  return EVENT_TYPES.find(([re]) => re.test(text ?? ''))?.[1] ?? null;
}

function serviceNameOf(repos, enquiry, estimate) {
  const config = (estimate && repos.pricingConfigs.get(estimate.pricingConfigId)) || repos.pricingConfigs.latestApproved();
  return config.configJson.services.find((s) => s.id === enquiry.requirementsJson?.service_id)?.name ?? null;
}

/** Outcome of an enquiry for reconnecting, or null when it is still active (nothing to reconnect about). */
export function outcomeOf(repos, enquiry, now) {
  const responses = repos.customerResponses.listByEnquiry(enquiry.id);
  const estimate = currentEstimate(repos, enquiry.id);
  const today = todayIST(now);
  if (enquiry.status === 'won') return { code: 'accepted', label: 'Accepted' };
  if (enquiry.status === 'lost') {
    return responses.some((r) => r.type === 'decline') ? { code: 'declined', label: 'Declined' } : { code: 'quiet', label: 'No reply' };
  }
  if (['quoted', 'followed_up'].includes(enquiry.status) && estimate?.status === 'sent') {
    if (responses.at(-1)?.type === 'question') return null; // they are talking to us
    if (estimate.validUntil && estimate.validUntil < today) return { code: 'expired', label: 'Quote expired' };
    const ageDays = (now - (estimate.approvedAt ?? now)) / DAY;
    if (!responses.length && ageDays >= QUIET_AFTER_DAYS) return { code: 'quiet', label: 'No reply' };
  }
  return null;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The rule-based "why now" string handed to Claude and shown to the owner. */
export function suggestReason(repos, enquiry, outcome, now) {
  const responses = repos.customerResponses.listByEnquiry(enquiry.id);
  const words = [enquiry.rawText, enquiry.requirementsJson?.notes, ...responses.map((r) => r.message)].filter(Boolean).join(' ');
  if (outcome.code !== 'accepted' && DISCOUNT_WORDS.test(words)) return { code: 'discount', text: 'asked about a discount' };
  const date = enquiry.requirementsJson?.event_date;
  if (date) {
    const away = daysBetween(todayIST(now), date);
    if (away >= 0 && away <= 14) {
      return { code: 'upcoming', text: away === 0 ? 'event is today' : away % 7 === 0 ? `event in ${plural(away / 7, 'week')}` : `event in ${plural(away, 'day')}` };
    }
    if (outcome.code === 'accepted' && away <= -28) return { code: 'past', text: `last event was ${plural(Math.floor(-away / 7), 'week')} ago` };
  }
  return {
    accepted: { code: 'recent', text: 'recent customer' },
    declined: { code: 'declined', text: 'declined the last quote' },
    expired: { code: 'expired', text: 'quote expired' },
    quiet: { code: 'quiet', text: 'no reply to the quote' },
  }[outcome.code];
}

/** Any contact in the last 7 days counts: Client Finder messages and follow-up reminders that actually went out. */
function contactTimes(repos, key, enquiryIds) {
  const fromOutreach = repos.outreach.all().filter((o) => o.key === key && ['sending', 'sent', 'opened'].includes(o.status)).map((o) => o.sentAt ?? o.createdAt);
  const fromReminders = enquiryIds.flatMap((id) => repos.followups.listByEnquiry(id)).filter((f) => f.status === 'sent' && f.sentAt).map((f) => f.sentAt);
  return [...fromOutreach, ...fromReminders];
}

export function isDoNotContact(repos, key) {
  return repos.enquiries.list().some((e) => e.doNotContact && keyOfEnquiry(e) === key)
    || repos.leads.all().some((l) => l.doNotContact && identityOf(l) === key);
}

/** null when the person can be contacted, else { code, text, until? }. */
export function blockOf(repos, key, enquiryIds, now) {
  if (isDoNotContact(repos, key)) return { code: 'do_not_contact', text: 'Asked not to be contacted' };
  const last = contactTimes(repos, key, enquiryIds).map((d) => d.getTime()).sort((a, b) => b - a)[0];
  if (last !== undefined && now.getTime() - last < RECENT_CONTACT_DAYS * DAY) {
    const until = new Date(last + RECENT_CONTACT_DAYS * DAY);
    return { code: 'recent', text: `Contacted recently. Wait until ${formatDate(todayIST(until))}.`, until };
  }
  return null;
}

/** Last Client Finder or reminder contact, for display. */
export function lastContactOf(repos, key, enquiryIds) {
  const t = contactTimes(repos, key, enquiryIds).map((d) => d.getTime()).sort((a, b) => b - a)[0];
  return t === undefined ? null : new Date(t);
}

/** Past customers worth a message, newest enquiry first. One row per person. */
export function reconnectRows({ repos }, now = new Date()) {
  const groups = new Map();
  for (const e of repos.enquiries.list()) {
    const key = keyOfEnquiry(e);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e); // list() is newest first
  }
  const rows = [];
  for (const [key, list] of groups) {
    const latest = list[0];
    const outcome = outcomeOf(repos, latest, now);
    if (!outcome) continue;
    const estimate = currentEstimate(repos, latest.id);
    const ids = list.map((e) => e.id);
    rows.push({
      key, enquiryId: latest.id, name: latest.customerName, channel: latest.preferredChannel,
      service: serviceNameOf(repos, latest, estimate), eventDate: latest.requirementsJson?.event_date ?? null,
      eventType: eventTypeOf(`${latest.rawText} ${latest.requirementsJson?.notes ?? ''}`),
      outcome, reason: suggestReason(repos, latest, outcome, now),
      block: blockOf(repos, key, ids, now), lastContact: lastContactOf(repos, key, ids),
    });
  }
  return rows;
}

/** The owner's leads with the same block rules. */
export function leadRows({ repos }, now = new Date()) {
  return repos.leads.all().sort((a, b) => b.id - a.id).map((l) => {
    const key = identityOf({ email: l.email, phone: l.phone, channel: l.email ? 'email' : 'whatsapp' });
    const ids = repos.enquiries.list().filter((e) => keyOfEnquiry(e) === key).map((e) => e.id);
    return { ...l, key, channel: l.email ? 'email' : 'whatsapp', block: blockOf(repos, key, ids, now), lastContact: lastContactOf(repos, key, ids) };
  });
}
