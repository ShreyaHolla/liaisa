import { calculateEstimate } from '../pricing/calculateEstimate.js';

/**
 * Price an enquiry with the latest APPROVED pricing config and save it as the next draft
 * version. Prices come only from calculateEstimate; nothing here does arithmetic.
 */
export function createEstimate(repos, enquiryId, { revisionReason = null, now } = {}) {
  const enquiry = repos.enquiries.get(enquiryId);
  if (!enquiry) throw new Error('enquiry not found');
  const config = repos.pricingConfigs.latestApproved();
  if (!config) throw new Error('no approved pricing config');
  const result = calculateEstimate(config.configJson, enquiry.requirementsJson);
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
    },
    now,
  );
}
