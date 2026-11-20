import { createContactMessageStore } from './db/repos/contactMessages.js';
import { createEnquiryStore } from './db/repos/enquiries.js';
import { createEstimateStore } from './db/repos/estimates.js';
import { createBusinessSettingsStore } from './db/repos/businessSettings.js';
import { createPricingConfigStore } from './db/repos/pricingConfigs.js';
import {
  createFollowupStore, createEmailStore, createWhatsappShareStore,
  createCustomerResponseStore, createAiCallStore,
} from './db/repos/simple.js';
import { createSmtpMailer } from './mail/smtpTransport.js';
import { seed } from './seed.js';

/** All in-memory repos, empty. Data resets on restart until MySQL repos replace these. */
export function createRepos() {
  return {
    businessSettings: createBusinessSettingsStore(),
    pricingConfigs: createPricingConfigStore(),
    enquiries: createEnquiryStore(),
    estimates: createEstimateStore(),
    followups: createFollowupStore(),
    emails: createEmailStore(),
    whatsappShares: createWhatsappShareStore(),
    customerResponses: createCustomerResponseStore(),
    aiCalls: createAiCallStore(),
  };
}

/** Wires adapters by env. mailer is null when MAIL_ENABLED=false. Repos are seeded with demo data. */
export function buildDeps(config) {
  const repos = createRepos();
  seed(repos);
  return {
    contacts: createContactMessageStore(),
    repos,
    mailer: config.mailEnabled ? createSmtpMailer(config.smtp) : null,
  };
}
