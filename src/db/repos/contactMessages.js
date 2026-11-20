// In-memory stand-in for the `contact_messages` table (PRD §7.2) until the M4 database exists.
// NOTE: messages are LOST WHEN THE PROCESS RESTARTS (including host restarts and deploys).
// Every business has its own store; the landing-page form belongs to the demo business only.

export const EMAIL_STATUSES = ['pending', 'accepted', 'failed', 'skipped'];

export function createContactMessageStore() {
  const rows = [];
  let nextId = 1;
  const find = (id) => {
    const row = rows.find((r) => r.id === Number(id));
    if (!row) throw new Error('contact message not found');
    return row;
  };
  const check = (s) => {
    if (!EMAIL_STATUSES.includes(s)) throw new Error('invalid email_status');
  };
  return {
    async save({ name, email, message, emailStatus }) {
      check(emailStatus);
      const row = { id: nextId++, name, email, message, emailStatus, emailError: null, readAt: null, createdAt: new Date() };
      rows.push(row);
      return { ...row };
    },
    /** `error` is a short code plus reason only: never message content or SMTP output. */
    async setStatus(id, emailStatus, { error = null } = {}) {
      check(emailStatus);
      const row = find(id);
      row.emailStatus = emailStatus;
      row.emailError = error;
      return { ...row };
    },
    async list() {
      return rows.map((r) => ({ ...r }));
    },
    /** Newest first. */
    all() {
      return rows.map((r) => ({ ...r })).reverse();
    },
    get(id) {
      const row = rows.find((r) => r.id === Number(id));
      return row ? { ...row } : null;
    },
    markRead(id) {
      const row = find(id);
      row.readAt ??= new Date();
      return { ...row };
    },
    markAllRead() {
      for (const r of rows) r.readAt ??= new Date();
    },
    unreadCount() {
      return rows.filter((r) => !r.readAt).length;
    },
  };
}
