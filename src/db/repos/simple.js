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
    enums: { type: ['estimate', 'followup', 'owner_notice', 'contact'], status: ['accepted', 'failed'] },
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
    enums: { purpose: ['intake', 'ratecard'] },
    defaults: { enquiryId: null, cacheReadTokens: 0, cacheWriteTokens: 0, error: null },
  });
  return { create: t.insert, all: t.all, listByEnquiry: byEnquiry(t) };
}
