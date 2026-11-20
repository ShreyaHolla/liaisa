// "Clean" quotes (M12): no warnings, and a total within the owner's limit. Used by "Approve all clean
// quotes" and by the optional auto-approve. A quote with any warning is never clean.
import { currentEstimate, approveAndSend } from './approval.js';

const clock = (deps) => (deps.now ?? (() => new Date()))();

export function logActivity(repos, enquiryId, text, now = new Date()) {
  repos.activity.create({ enquiryId, text }, now);
}

export const limitOf = (repos) => repos.businessSettings.get()?.bulkApproveLimit ?? null;

/** Zero warnings, an open draft, and total <= limit. A missing limit means nothing is clean. */
export function isCleanQuote(enquiry, estimate, limit) {
  return limit !== null && limit !== undefined
    && enquiry.status === 'awaiting_approval' && estimate?.status === 'draft'
    && (estimate.warningsJson ?? []).length === 0 && estimate.total <= limit;
}

/** Everything that qualifies right now, oldest first. */
export function cleanQuotes({ repos }) {
  const limit = limitOf(repos);
  return repos.enquiries.list().slice().reverse()
    .map((enquiry) => ({ enquiry, estimate: currentEstimate(repos, enquiry.id) }))
    .filter(({ enquiry, estimate }) => isCleanQuote(enquiry, estimate, limit));
}

/**
 * Approve exactly the confirmed clean quotes. `ids` is what the owner saw on the confirmation page;
 * anything that is no longer clean (edited, now has a warning, over the limit) is skipped, and nothing
 * outside the list is touched.
 */
export async function approveClean(deps, ids) {
  const { repos } = deps;
  const confirmed = new Set(ids);
  const approved = [];
  const skipped = [];
  const now = clock(deps);
  const clean = new Map(cleanQuotes(deps).map((c) => [c.enquiry.id, c]));
  for (const id of confirmed) {
    const hit = clean.get(id);
    if (!hit) { skipped.push(id); continue; }
    const result = await approveAndSend(deps, id, hit.estimate.version);
    logActivity(repos, id, 'Approved with “Approve all clean quotes”', now);
    approved.push({ id, name: hit.enquiry.customerName, total: hit.estimate.total, estimateStatus: result.estimateStatus });
  }
  return { approved, skipped };
}

/**
 * Optional auto-approve (OFF by default): a clean quote for an email customer is approved and sent
 * without asking. Never for quotes with warnings, never above the limit, never for WhatsApp customers
 * (the owner always taps Send there). Returns true when it sent.
 */
export async function maybeAutoApprove(deps, enquiryId) {
  const { repos, mailer } = deps;
  const settings = repos.businessSettings.get();
  if (!settings?.autoApprove || !mailer) return false;
  const enquiry = repos.enquiries.get(enquiryId);
  const estimate = enquiry && currentEstimate(repos, enquiryId);
  if (!enquiry || enquiry.preferredChannel !== 'email' || !isCleanQuote(enquiry, estimate, limitOf(repos))) return false;
  const result = await approveAndSend(deps, enquiryId, estimate.version);
  logActivity(repos, enquiryId, 'Sent automatically (auto-approve is on)', clock(deps));
  return result.estimateStatus === 'sent';
}
