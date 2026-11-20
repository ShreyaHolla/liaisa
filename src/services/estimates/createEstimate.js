import { calculateEstimate } from '../pricing/calculateEstimate.js';

/**
 * Price an enquiry with the latest APPROVED pricing config and save it as the next draft
 * version. Prices come only from calculateEstimate; nothing here does arithmetic.
 * `requirements`, `discount` and `note` are the owner's edits (F6); the saved version keeps the note.
 */
export function createEstimate(repos, enquiryId, { requirements, discount, note, revisionReason = null, now } = {}) {
  const enquiry = repos.enquiries.get(enquiryId);
  if (!enquiry) throw new Error('enquiry not found');
  const config = repos.pricingConfigs.latestApproved();
  if (!config) throw new Error('no approved pricing config');
  const result = calculateEstimate(config.configJson, requirements ?? enquiry.requirementsJson, { discount });
  return repos.estimates.create(
    {
      enquiryId,
      pricingConfigId: config.id,
      lineItemsJson: result.lineItems,
      subtotal: result.subtotal,
      tax: result.tax,
      total: result.total,
      currency: result.currency,
      warningsJson: result.warnings,
      revisionReason,
      ...(note ? { noteForCustomer: note } : {}),
    },
    now,
  );
}
