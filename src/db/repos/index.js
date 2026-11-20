// One complete set of in-memory repos for ONE business. Every row carries `businessId`.
// Data resets on restart until MySQL repos replace these. `scope.seq` (from the registry) shares id counters
// across businesses, so an id from another business does not exist here at all.
import { createBusinessSettingsStore } from './businessSettings.js';
import { createContactMessageStore } from './contactMessages.js';
import { createPricingConfigStore } from './pricingConfigs.js';
import { createEnquiryStore } from './enquiries.js';
import { createEstimateStore } from './estimates.js';
import {
  createFollowupStore, createEmailStore, createWhatsappShareStore,
  createCustomerResponseStore, createAiCallStore, createLeadStore, createOutreachStore, createDiscoveryRunStore, createActivityStore, createUsedLinkStore,
} from './simple.js';

export const DEMO_SLUG = 'mehfil-kitchen';

/**
 * @param {{ id?: number, slug?: string, isDemo?: boolean, ownerEmail?: string|null, limits?: object }} [business]
 * @param {{ seq?: Function, global?: { aiCallsSince: (from: Date) => number } }} [ctx]
 */
export function createRepos(business = {}, ctx = {}) {
  const meta = { id: 1, slug: DEMO_SLUG, isDemo: true, ownerEmail: null, limits: null, ...business };
  const scope = { businessId: meta.id, seq: ctx.seq };
  const repos = {
    business: meta,
    global: ctx.global ?? null,
    businessSettings: createBusinessSettingsStore(scope),
    pricingConfigs: createPricingConfigStore(scope),
    enquiries: createEnquiryStore(scope),
    estimates: createEstimateStore(scope),
    followups: createFollowupStore(scope),
    emails: createEmailStore(scope),
    whatsappShares: createWhatsappShareStore(scope),
    customerResponses: createCustomerResponseStore(scope),
    aiCalls: createAiCallStore(scope),
    leads: createLeadStore(scope),
    outreach: createOutreachStore(scope),
    discoveryRuns: createDiscoveryRunStore(scope),
    activity: createActivityStore(scope),
    usedLinks: createUsedLinkStore(),
    contactMessages: createContactMessageStore(),
  };
  // name and city read live from this business's settings, so a rename on Setup shows everywhere.
  Object.defineProperties(meta, {
    name: { enumerable: true, get: () => repos.businessSettings.get()?.businessName ?? 'Liaisa' },
    city: { enumerable: true, get: () => repos.businessSettings.get()?.city ?? null },
  });
  return repos;
}
