// In-memory repos for the remaining PRD §7.2 tables. Each is a thin table with the enum
// checks from the DDL. Data resets on restart; MySQL repos replace these later.
import { createTable } from './table.js';

const byEnquiry = (t) => (enquiryId) => t.find((r) => r.enquiryId === enquiryId);

export function createFollowupStore() {
  const t = createTable({
    enums: {
      channel: ['email', 'whatsapp'],
      status: ['pending', 'sending', 'sent', 'awaiting_owner', 'cancelled', 'failed'],
    },
    unique: [['enquiryId', 'step']],
    defaults: { status: 'pending', sentAt: null },
  });
  return { create: t.insert, update: t.update, get: t.get, all: t.all, listByEnquiry: byEnquiry(t) };
}

export function createEmailStore() {
  const t = createTable({
    enums: { type: ['estimate', 'followup', 'owner_notice', 'contact', 'outreach'], status: ['accepted', 'failed'] },
    defaults: { enquiryId: null, providerMessageId: null, error: null },
  });
  return { create: t.insert, all: t.all, listByEnquiry: byEnquiry(t) };
}

export function createWhatsappShareStore() {
  const t = createTable({ enums: { type: ['estimate', 'followup'] }, defaults: { followupId: null } });
  return { create: t.insert, all: t.all, listByEnquiry: byEnquiry(t) };
}

export function createCustomerResponseStore() {
  const t = createTable({ enums: { type: ['accept', 'question', 'decline'] }, defaults: { message: null } });
  return { create: t.insert, all: t.all, listByEnquiry: byEnquiry(t) };
}

export function createAiCallStore() {
  const t = createTable({
    enums: { purpose: ['intake', 'ratecard', 'outreach'] },
    defaults: { enquiryId: null, cacheReadTokens: 0, cacheWriteTokens: 0, error: null },
  });
  return { create: t.insert, all: t.all, listByEnquiry: byEnquiry(t) };
}

/** Client Finder leads the owner typed in (M10-lite). One at a time; no imports, no scraping. */
export function createLeadStore() {
  const t = createTable({ defaults: { email: null, phone: null, note: '', doNotContact: false } });
  return { create: t.insert, update: t.update, get: t.get, all: t.all };
}

/** Client Finder messages: a draft, then sent / opened / failed once the owner approves it. */
export function createOutreachStore() {
  const t = createTable({
    enums: {
      subjectType: ['customer', 'lead'],
      channel: ['email', 'whatsapp'],
      status: ['draft', 'sending', 'sent', 'opened', 'failed'],
    },
    defaults: { enquiryId: null, leadId: null, sentAt: null, source: 'ai' },
  });
  return { create: t.insert, update: t.update, get: t.get, all: t.all };
}
