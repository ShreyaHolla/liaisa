// Tiny in-memory "table" used by every repo in src/db/repos (PRD §7.2 shapes, camelCase).
// DATA RESETS ON RESTART. MySQL repos with the same method names replace these later.
// Rows are copied on the way in and out so callers can't mutate stored data by accident.

/**
 * @param {object} opts
 * @param {Record<string,string[]>} [opts.enums]  column -> allowed values (checked on insert/update)
 * @param {string[][]} [opts.unique]              column groups that must be unique together
 * @param {object} [opts.defaults]                default column values
 */
export function createTable({ enums = {}, unique = [], defaults = {} } = {}) {
  const rows = [];
  let nextId = 1;

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
      const row = { ...defaults, ...data, id: nextId, createdAt: now };
      checkEnums(row);
      checkUnique(row);
      nextId += 1;
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
  };
}
