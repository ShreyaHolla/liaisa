// In-memory `enquiries` table (PRD §7.2). Data resets on restart; MySQL replaces this later.
import { createTable } from './table.js';
import { ulid } from '../../util/ulid.js';

export const ENQUIRY_STATUSES = [
  'collecting', 'awaiting_approval', 'quoted', 'followed_up',
  'won', 'lost', 'declined', 'needs_owner', 'out_of_scope',
];

export function createEnquiryStore(scope) {
  const t = createTable({ name: 'enquiries', scope,
    enums: { status: ENQUIRY_STATUSES, preferredChannel: ['email', 'whatsapp'], source: ['ai', 'form'] },
    defaults: {
      customerEmail: null, customerPhone: null, preferredChannel: 'email',
      requirementsJson: null, missingFieldsJson: null, summaryForOwner: null,
      aiState: null, aiRequestsUsed: 0, source: 'ai', doNotContact: false,
    },
  });
  return {
    create(data, now) {
      return t.insert({ ...data, publicId: data.publicId ?? ulid(), updatedAt: now ?? new Date() }, now);
    },
    update: t.update,
    get: t.get,
    getByPublicId: (publicId) => t.find((r) => r.publicId === publicId)[0] ?? null,
    list: () => t.all().sort((a, b) => b.createdAt - a.createdAt || b.id - a.id),
    /** { status: count } for every status, zeros included (dashboard counts, TC-DSH-05). */
    countByStatus() {
      const counts = Object.fromEntries(ENQUIRY_STATUSES.map((s) => [s, 0]));
      for (const r of t.all()) counts[r.status] += 1;
      return counts;
    },
  };
}
