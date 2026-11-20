// Read models for the owner dashboard and enquiry detail (F9). No writes, no prices computed.
import { timeAgo, unitNoun } from '../../util/format.js';
import { formatDate } from '../../util/formatDate.js';
import { currentEstimate } from '../quotes/approval.js';
import { understoodOf } from '../enquiries/enquiryService.js';
import { followupState, dueFollowUps, draftReminder, MAX_REMINDERS } from '../followups/reminders.js';
import { cleanQuotes, isCleanQuote, limitOf } from '../quotes/clean.js';

/** DESIGN §7.2: DB status -> [owner label, tone]. */
const STATUS = {
  collecting: ['Asking the customer', 'progress'],
  needs_owner: ['Needs your review', 'needs'],
  awaiting_approval: ['Needs your approval', 'needs'],
  quoted: ['Quote sent', 'progress'],
  followed_up: ['Reminder sent', 'progress'],
  won: ['Accepted', 'done'],
  lost: ['Closed: no reply / declined', 'neutral'],
  declined: ['You declined', 'neutral'],
  out_of_scope: ['Not something you offer', 'neutral'],
};
const FAILED = ['Email didn’t send: retry', 'problem'];
const APPROVED_NOT_SENT = ['Approved, not sent yet', 'needs']; // not in DESIGN §7.2 yet

export function statusOf(enquiry, estimate) {
  if (estimate?.status === 'approved_send_failed' && enquiry.status === 'awaiting_approval') return FAILED;
  if (estimate?.status === 'approved' && enquiry.status === 'awaiting_approval') return APPROVED_NOT_SENT;
  return STATUS[enquiry.status];
}

const lastResponse = (repos, enquiryId) => repos.customerResponses.listByEnquiry(enquiryId).at(-1) ?? null;

/** 'Veg buffet, 40 · Sun 13 Dec' */
export function whatOf(pricing, requirements) {
  if (!requirements) return '';
  const service = pricing.services.find((s) => s.id === requirements.service_id);
  const head = [service?.name, requirements.quantity].filter(Boolean).join(', ');
  return [head, requirements.event_date ? formatDate(requirements.event_date) : ''].filter(Boolean).join(' · ');
}

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const RANK = { send_failed: 0, approval: 1, review: 2, customer_question: 3 };

/** What needs the owner now (openapi DashboardSummary.needsYou). */
function needsYouItem(repos, pricing, enquiry, estimate) {
  const base = { enquiryId: enquiry.id, customerName: enquiry.customerName, what: whatOf(pricing, enquiry.requirementsJson) };
  // What the Approvals card shows: service, quantity, date, a chip per warning, and whether it is "clean".
  const req = enquiry.requirementsJson ?? {};
  const svc = pricing.services.find((s) => s.id === req.service_id);
  const card = {
    service: svc?.name ?? null, quantity: req.quantity ?? null, unit: svc ? unitNoun(svc) : null, eventDate: req.event_date ?? null,
    channel: enquiry.preferredChannel, version: estimate?.version ?? null, warnings: (estimate?.warningsJson ?? []).map((c) => warningText(c, pricing, req)),
    clean: isCleanQuote(enquiry, estimate, limitOf(repos)),
  };
  const total = estimate && ['draft', 'approved', 'approved_send_failed'].includes(estimate.status) ? { total: estimate.total } : {};
  if (enquiry.status === 'awaiting_approval' && estimate?.status === 'approved_send_failed') {
    return { kind: 'send_failed', label: FAILED[0], ...base, ...total };
  }
  if (enquiry.status === 'awaiting_approval') {
    return { kind: 'approval', label: statusOf(enquiry, estimate)[0], ...base, ...total, ...card };
  }
  if (enquiry.status === 'needs_owner') return { kind: 'review', label: STATUS.needs_owner[0], ...base, ...total, ...card };
  const last = lastResponse(repos, enquiry.id);
  if (['quoted', 'followed_up'].includes(enquiry.status) && last?.type === 'question') {
    return { kind: 'customer_question', label: 'Customer question', ...base, what: `asked: “${truncate(last.message ?? '', 60)}”` };
  }
  return null;
}

export function dashboardSummary(deps, now = new Date()) {
  const { repos } = deps;
  const pricing = repos.pricingConfigs.latestApproved().configJson;
  const enquiries = repos.enquiries.list();
  const since = now.getTime() - 7 * 86400000;

  const needsYou = enquiries
    .map((e) => ({ item: needsYouItem(repos, pricing, e, currentEstimate(repos, e.id)), at: e.updatedAt }))
    .filter((x) => x.item)
    .sort((a, b) => RANK[a.item.kind] - RANK[b.item.kind] || b.at - a.at)
    .map((x) => x.item);

  const week = {
    enquiries: enquiries.filter((e) => e.createdAt.getTime() >= since).length,
    quotesSent: enquiries.filter((e) => repos.estimates.listByEnquiry(e.id)
      .some((s) => s.status === 'sent' && s.approvedAt && s.approvedAt.getTime() >= since)).length,
    accepted: repos.customerResponses.all().filter((r) => r.type === 'accept' && r.createdAt.getTime() >= since).length,
  };

  // Quotes that were sent, got no reply, and are due a reminder (M8-lite).
  const followUps = dueFollowUps(deps, now).map(({ enquiry, state }) => ({
    enquiryId: enquiry.id, customerName: enquiry.customerName, what: whatOf(pricing, enquiry.requirementsJson),
    quoteAge: `Quote sent ${timeAgo(state.quoteSentAt, now)}`, remindersSent: state.sentCount,
  }));

  const all = enquiries.map((e) => {
    const [label, tone] = statusOf(e, currentEstimate(repos, e.id));
    return { id: e.id, name: e.customerName, what: whatOf(pricing, e.requirementsJson), label, tone, status: e.status, updated: timeAgo(e.updatedAt, now) };
  });
  const clean = cleanQuotes(deps).map(({ enquiry, estimate }) => ({ id: enquiry.id, name: enquiry.customerName, total: estimate.total, channel: enquiry.preferredChannel }));
  return { needsYou, week, followUps, all, bulk: { limit: limitOf(repos), clean } };
}

/** Plain-words warning (DESIGN §4.5, §7.3). */
export function warningText(code, pricing, requirements = {}) {
  const service = pricing.services.find((s) => s.id === requirements.service_id) ?? {};
  const people = service.id ? unitNoun(service) : 'units';
  switch (code) {
    case 'below_min_qty': return `Fewer ${people} (${requirements.quantity}) than this service’s minimum (${service.min_qty}).`;
    case 'above_max_qty': return `More ${people} (${requirements.quantity}) than this service’s maximum (${service.max_qty}).`;
    case 'unknown_location': return requirements.location
      ? `Liaisa couldn’t match ‘${requirements.location}’ to a travel fee. Check the travel charge before approving.`
      : 'No area was given, so no travel fee was added. Check the travel charge before approving.';
    case 'outside_delivery_area': return `${requirements.location ?? 'That area'} is outside the areas you deliver to. Check before approving.`;
    case 'missing_date': return 'No event date yet, so the weekend surcharge could not be checked.';
    default: return code;
  }
}

/** Everything the enquiry detail page shows. */
export function enquiryDetail(deps, id, now = new Date()) {
  const { repos, mailer } = deps;
  const enquiry = repos.enquiries.get(id);
  if (!enquiry) return null;
  const estimate = currentEstimate(repos, id);
  // Pages about an existing quote use the config it was priced with, so later setup edits don't rewrite its warnings.
  const pricing = (estimate && repos.pricingConfigs.get(estimate.pricingConfigId)?.configJson) || repos.pricingConfigs.latestApproved().configJson;
  const [label, tone] = statusOf(enquiry, estimate);
  const requirements = enquiry.requirementsJson ?? {};
  const status = estimate?.status;
  const open = ['awaiting_approval', 'needs_owner'].includes(enquiry.status);
  const approved = ['approved', 'sent', 'approved_send_failed'].includes(status);
  const discount = estimate?.lineItemsJson.find((l) => l.kind === 'discount');
  const fstate = followupState(deps, enquiry, now);
  const channel = enquiry.preferredChannel;
  const followup = !fstate.show ? null : {
    reason: fstate.reason, due: fstate.due, sentCount: fstate.sentCount, max: MAX_REMINDERS, dueAt: fstate.dueAt, channel,
    draft: fstate.due ? draftReminder(deps, enquiry, fstate) : null,
    canSend: fstate.due && (channel === 'whatsapp' ? Boolean(enquiry.customerPhone) : Boolean(mailer && enquiry.customerEmail)),
  };
  // Reminders for the Activity list: numbered within their quote version, like the cap counts them.
  const rows = repos.followups.listByEnquiry(id).filter((f) => f.status !== 'cancelled').sort((a, b) => a.step - b.step);
  const rank = new Map();
  const reminders = rows.map((f) => {
    const n = f.status === 'sent' ? (rank.set(f.estimateId, (rank.get(f.estimateId) ?? 0) + 1), rank.get(f.estimateId)) : null;
    const text = f.status === 'sent' ? `Reminder ${n} ${f.channel === 'whatsapp' ? 'opened in WhatsApp' : 'sent by email'}`
      : f.status === 'failed' ? 'Reminder email didn’t send' : 'Reminder email sending';
    return { text, at: f.sentAt ?? f.createdAt };
  });
  return {
    followup, reminders,
    enquiry, estimate, pricing, requirements, label, tone,
    what: whatOf(pricing, requirements),
    understood: enquiry.requirementsJson ? understoodOf(repos, enquiry.requirementsJson) : null,
    warnings: (estimate?.warningsJson ?? []).map((c) => warningText(c, pricing, requirements)),
    discount: discount ? { amount: -discount.amount, reason: discount.reason } : null,
    history: enquiry.aiState?.history ?? [],
    events: repos.activity.listByEnquiry(id).map((a) => ({ text: a.text, at: a.createdAt })),
    emails: repos.emails.listByEnquiry(id).filter((m) => m.type === 'estimate'), // reminders are listed from the followups rows
    shares: repos.whatsappShares.listByEnquiry(id).filter((s) => s.type === 'estimate'),
    responses: repos.customerResponses.listByEnquiry(id),
    question: (() => {
      const last = lastResponse(repos, id);
      return ['quoted', 'followed_up'].includes(enquiry.status) && last?.type === 'question' ? last : null;
    })(),
    can: {
      approve: open && status === 'draft',
      edit: open && status === 'draft',
      decline: ['collecting', 'awaiting_approval', 'needs_owner'].includes(enquiry.status),
      retry: Boolean(mailer) && enquiry.preferredChannel === 'email' && ['approved', 'approved_send_failed'].includes(status),
      whatsapp: approved && Boolean(enquiry.customerPhone),
      showLink: approved && !['sent'].includes(status ?? ''),
    },
    sentOnWhatsapp: repos.whatsappShares.listByEnquiry(id).length > 0,
    now,
  };
}
