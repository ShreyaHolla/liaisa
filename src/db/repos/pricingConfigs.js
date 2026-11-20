// In-memory `pricing_configs` (PRD §7.2). Data resets on restart; MySQL replaces this later.
import { createTable } from './table.js';

export function createPricingConfigStore() {
  const t = createTable({
    enums: { status: ['draft', 'approved', 'superseded'] },
    defaults: { sourceText: null, approvedAt: null },
  });
  return {
    get: t.get,
    all: t.all,
    /** Newest approved config: what every new estimate must use (TC-SET-04). */
    latestApproved() {
      const approved = t.find((r) => r.status === 'approved');
      return approved.sort((a, b) => b.id - a.id)[0] ?? null;
    },
    /** Save a config as approved and supersede the previous approved one (TC-SET-02). */
    publish(configJson, now = new Date()) {
      for (const r of t.find((x) => x.status === 'approved')) t.update(r.id, { status: 'superseded' });
      return t.insert({ status: 'approved', configJson, approvedAt: now }, now);
    },
  };
}
