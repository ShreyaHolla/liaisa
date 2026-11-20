// In-memory `estimates` table (PRD §7.2). Data resets on restart; MySQL replaces this later.
import { createTable } from './table.js';

export const ESTIMATE_STATUSES = ['draft', 'approved', 'sent', 'approved_send_failed', 'superseded'];

export function createEstimateStore(scope) {
  const t = createTable({ name: 'estimates', scope,
    enums: { status: ESTIMATE_STATUSES },
    unique: [['enquiryId', 'version']],
    defaults: { warningsJson: [], revisionReason: null, approvedAt: null, quoteToken: null, validUntil: null },
  });
  return {
    /** Version is assigned here: one more than the highest for this enquiry. */
    create(data, now) {
      const version = Math.max(0, ...t.find((r) => r.enquiryId === data.enquiryId).map((r) => r.version)) + 1;
      return t.insert({ status: 'draft', ...data, version }, now);
    },
    update: t.update,
    get: t.get,
    getByToken: (token) => t.find((r) => r.quoteToken !== null && r.quoteToken === token)[0] ?? null,
    listByEnquiry: (enquiryId) => t.find((r) => r.enquiryId === enquiryId).sort((a, b) => a.version - b.version),
  };
}
