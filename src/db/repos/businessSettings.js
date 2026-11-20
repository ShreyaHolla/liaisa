// In-memory `business_settings` (single row, id = 1). Data resets on restart; MySQL replaces this later.
export function createBusinessSettingsStore() {
  let row = null;
  return {
    get: () => (row ? structuredClone(row) : null),
    save(data) {
      row = { ...row, ...data, id: 1, updatedAt: new Date() };
      return structuredClone(row);
    },
  };
}
