// In-memory `business_settings` (one row per business, id = 1). Data resets on restart; MySQL replaces this later.
export function createBusinessSettingsStore(scope = {}) {
  let row = null;
  return {
    get: () => (row ? structuredClone(row) : null),
    save(data) {
      row = { ...row, ...data, id: 1, ...(scope.businessId === undefined ? {} : { businessId: scope.businessId }), updatedAt: new Date() };
      return structuredClone(row);
    },
  };
}
