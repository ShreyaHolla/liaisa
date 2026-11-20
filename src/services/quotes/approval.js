// Owner decisions on a quote (F6, F7, F12). Routes stay thin; every rule lives here.
// "Approval record" = estimate status approved + quote_token. Nothing reaches a customer without it.
import { randomBytes } from 'node:crypto';
import { ConflictError, NotFoundError } from '../../errors.js';
import { createEstimate } from '../estimates/createEstimate.js';
import { missingFields, normaliseRequirements } from '../agent/areas.js';
import { cancelFollowups } from '../followups/cancel.js';
import { buildWaLink } from '../whatsapp/link.js';
import { dateAfter } from '../../util/format.js';
import { quoteUrl, quoteEmail, whatsappText } from './messages.js';
import { sendLogged } from './mail.js';

export const VALID_DAYS = 7;
const APPROVED = ['approved', 'sent', 'approved_send_failed'];
const clock = (deps) => (deps.now ?? (() => new Date()))();
const sending = new Set(); // estimate ids with an email in flight

export const newQuoteToken = () => randomBytes(32).toString('base64url'); // 43 chars

export function currentEstimate(repos, enquiryId) {
  return repos.estimates.listByEnquiry(enquiryId).filter((e) => e.status !== 'superseded').at(-1) ?? null;
}

function mustGetEnquiry(repos, id) {
  const enquiry = repos.enquiries.get(id);
  if (!enquiry) throw new NotFoundError('Enquiry not found');
  return enquiry;
}

/**
 * Approve the current draft. One synchronous step (no await between the check and the writes), so a
 * double click cannot approve twice. Then, for email customers, send. Approving again is a no-op.
 */
export async function approveAndSend(deps, enquiryId, estimateVersion) {
  const { repos, mailer } = deps;
  const enquiry = mustGetEnquiry(repos, enquiryId);
  const estimate = currentEstimate(repos, enquiryId);
  if (!estimate) throw new ConflictError('There is no quote to approve.');
  if (estimate.version !== estimateVersion) throw new ConflictError('This quote changed. Reload the page and review it again.');

  let fresh = false;
  if (estimate.status === 'draft') {
    if (!['awaiting_approval', 'needs_owner'].includes(enquiry.status)) throw new ConflictError('This enquiry has already moved on.');
    const now = clock(deps);
    repos.estimates.update(estimate.id, {
      status: 'approved', approvedAt: now, quoteToken: newQuoteToken(), validUntil: dateAfter(now, VALID_DAYS),
    });
    repos.enquiries.update(enquiryId, { status: 'awaiting_approval' });
    fresh = true;
  }
  if (fresh && enquiry.preferredChannel === 'email' && mailer) await sendQuoteEmail(deps, enquiryId);
  return present(deps, enquiryId);
}

/** ApproveResponse (openapi). */
function present(deps, enquiryId) {
  const { repos, config } = deps;
  const enquiry = repos.enquiries.get(enquiryId);
  const estimate = currentEstimate(repos, enquiryId);
  const body = {
    enquiryStatus: enquiry.status, estimateStatus: estimate.status, channel: enquiry.preferredChannel,
    quoteUrl: quoteUrl(config, estimate.quoteToken),
  };
  if (enquiry.preferredChannel === 'whatsapp' && enquiry.customerPhone) body.whatsappUrl = waUrl(deps, enquiry, estimate);
  return body;
}

function waUrl({ repos, config }, enquiry, estimate) {
  const pricing = repos.pricingConfigs.latestApproved().configJson;
  const business = repos.businessSettings.get();
  const link = quoteUrl(config, estimate.quoteToken);
  return buildWaLink(enquiry.customerPhone, whatsappText({ business, enquiry, estimate, pricing, link }));
}

/**
 * Email the approved quote. The service refuses anything without an approval record (TC-APR-02).
 * The quote is already saved; a failure leaves it `approved_send_failed` so the owner can retry.
 */
export async function sendQuoteEmail(deps, enquiryId) {
  const { repos, mailer, config } = deps;
  const enquiry = mustGetEnquiry(repos, enquiryId);
  const estimate = currentEstimate(repos, enquiryId);
  if (!estimate || !estimate.quoteToken || !['approved', 'approved_send_failed'].includes(estimate.status)) {
    throw new ConflictError('Approve the quote before sending it.');
  }
  if (!mailer) throw new ConflictError('Email sending is switched off.');
  if (sending.has(estimate.id)) throw new ConflictError('This quote is already being sent.');

  sending.add(estimate.id);
  try {
    const business = repos.businessSettings.get();
    const message = quoteEmail({ business, enquiry, estimate, link: quoteUrl(config, estimate.quoteToken) });
    const ok = enquiry.customerEmail
      ? await sendLogged(deps, { enquiryId, type: 'estimate', to: enquiry.customerEmail, ...message })
      : false;
    repos.estimates.update(estimate.id, { status: ok ? 'sent' : 'approved_send_failed' });
    if (ok) repos.enquiries.update(enquiryId, { status: 'quoted' });
    return { estimateStatus: ok ? 'sent' : 'approved_send_failed' };
  } finally {
    sending.delete(estimate.id);
  }
}

/** Retry button: only for email customers whose quote is approved but not sent (TC-EML-03). */
export async function retryQuoteEmail(deps, enquiryId) {
  if (!deps.mailer) throw new ConflictError('Email sending is switched off.');
  const enquiry = mustGetEnquiry(deps.repos, enquiryId);
  const estimate = currentEstimate(deps.repos, enquiryId);
  if (enquiry.preferredChannel !== 'email' || !estimate || !['approved', 'approved_send_failed'].includes(estimate.status)) {
    throw new ConflictError('There is nothing to retry.');
  }
  return sendQuoteEmail(deps, enquiryId);
}

/**
 * F12: log the share, mark the quote `sent` ("opened in WhatsApp") and return the wa.me link.
 * Only after approval, and only when the customer gave a phone number.
 */
export function shareOnWhatsapp(deps, enquiryId) {
  const { repos } = deps;
  const enquiry = mustGetEnquiry(repos, enquiryId);
  const estimate = currentEstimate(repos, enquiryId);
  if (!estimate || !estimate.quoteToken || !APPROVED.includes(estimate.status)) throw new ConflictError('Approve the quote before sending it.');
  if (!enquiry.customerPhone) throw new ConflictError("This customer didn't give a phone number.");
  const url = waUrl(deps, enquiry, estimate);
  repos.whatsappShares.create({ enquiryId, type: 'estimate' }, clock(deps));
  if (estimate.status !== 'sent') repos.estimates.update(estimate.id, { status: 'sent' });
  if (enquiry.status === 'awaiting_approval') repos.enquiries.update(enquiryId, { status: 'quoted' });
  return { url };
}

/**
 * Edit = a new draft version, priced by the engine; the previous draft is superseded (TC-APR-03).
 * `input` is { requirements, discount?, note?, revisionReason }. Throws before changing anything
 * when the engine rejects it (ValidationError).
 */
export function editEstimate(deps, enquiryId, input) {
  const { repos } = deps;
  const enquiry = mustGetEnquiry(repos, enquiryId);
  if (!['awaiting_approval', 'needs_owner'].includes(enquiry.status)) throw new ConflictError('This enquiry has already moved on.');
  const previous = currentEstimate(repos, enquiryId);
  if (previous && previous.status !== 'draft') throw new ConflictError("This quote is already approved, so it can't be edited.");

  const pricing = (previous && repos.pricingConfigs.get(previous.pricingConfigId)?.configJson) || repos.pricingConfigs.latestApproved().configJson;
  const requirements = normaliseRequirements(pricing, input.requirements);
  const created = createEstimate(repos, enquiryId, {
    requirements, pricingConfigId: previous?.pricingConfigId, discount: input.discount, note: input.note, revisionReason: input.revisionReason, now: clock(deps),
  });
  if (previous) repos.estimates.update(previous.id, { status: 'superseded' });
  repos.enquiries.update(enquiryId, {
    requirementsJson: requirements, missingFieldsJson: missingFields(pricing, requirements), status: 'awaiting_approval',
  });
  return created;
}

/** Owner declines the enquiry: nothing is sent, reminders stop, any draft can no longer be approved. */
export function declineEnquiry(deps, enquiryId, { reason = null, via = null } = {}) {
  const { repos } = deps;
  const enquiry = mustGetEnquiry(repos, enquiryId);
  if (!['collecting', 'awaiting_approval', 'needs_owner'].includes(enquiry.status)) throw new ConflictError('This enquiry has already moved on.');
  const estimate = currentEstimate(repos, enquiryId);
  if (estimate?.status === 'draft') repos.estimates.update(estimate.id, { status: 'superseded' });
  repos.enquiries.update(enquiryId, { status: 'declined', ...(reason ? { declineReason: reason } : {}) });
  cancelFollowups(repos, enquiryId);
  repos.activity.create({ enquiryId, text: `Declined${via ? ` with ${via}` : ''}${reason ? `: ${reason}` : ''}` }, clock(deps));
}
