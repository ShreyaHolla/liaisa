// Tiny in-memory "table" used by every repo in src/db/repos (PRD §7.2 shapes, camelCase).
// DATA RESETS ON RESTART. MySQL repos with the same method names replace these later.
// Rows are copied on the way in and out so callers can't mutate stored data by accident.

/**
 * @param {object} opts
 * @param {Record<string,string[]>} [opts.enums]  column -> allowed values (checked on insert/update)
 * @param {string[][]} [opts.unique]              column groups that must be unique together
 * @param {object} [opts.defaults]                default column values
 * @param {string} [opts.name]                    table name, used to find the shared id counter
 * @param {{businessId?: number, seq?: (name: string) => {next: () => number}}} [opts.scope]
 *        the business every row belongs to (stamped as `businessId`), and shared id counters so ids are
 *        unique across businesses (an id from another business is simply "not found")
 */
export function createTable({ enums = {}, unique = [], defaults = {}, name, scope = {} } = {}) {
  const rows = [];
  let localId = 1;
  const shared = name && scope.seq ? scope.seq(name) : null;
  const takeId = () => (shared ? shared.next() : localId++);
  const stamp = scope.businessId === undefined ? {} : { businessId: scope.businessId };

  const checkEnums = (data) => {
    for (const [col, allowed] of Object.entries(enums)) {
      if (col in data && !allowed.includes(data[col])) throw new Error(`invalid ${col}`);
    }
  };
  const checkUnique = (row) => {
    for (const cols of unique) {
      const clash = rows.some((r) => r.id !== row.id && cols.every((c) => r[c] === row[c]));
      if (clash) throw new Error(`duplicate ${cols.join('+')}`);
    }
  };

  return {
    insert(data, now = new Date()) {
      const row = { ...defaults, ...data, ...stamp, id: 0, createdAt: now };
      checkEnums(row);
      row.id = takeId();
      checkUnique(row);
      rows.push(row);
      return structuredClone(row);
    },
    update(id, patch) {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error('row not found');
      checkEnums(patch);
      const next = { ...row, ...patch, id: row.id, updatedAt: new Date() };
      checkUnique(next);
      Object.assign(row, next);
      return structuredClone(row);
    },
    get: (id) => structuredClone(rows.find((r) => r.id === id) ?? null),
    find: (fn) => structuredClone(rows.filter(fn)),
    all: () => structuredClone(rows),
    /** Count without copying rows (daily caps are checked on every AI call). */
    count: (fn) => rows.filter(fn).length,
  };
}
