// In-memory stand-in for the `contact_messages` table (PRD §7.2) until the M4 database exists.
// NOTE: messages are LOST WHEN THE PROCESS RESTARTS (including host restarts and deploys).
// M4 replaces this with a MySQL repo exposing the same save / setStatus / list functions.

export const EMAIL_STATUSES = ['accepted', 'failed', 'skipped'];

export function createContactMessageStore() {
  const rows = [];
  let nextId = 1;
  return {
    async save({ name, email, message, emailStatus }) {
      if (!EMAIL_STATUSES.includes(emailStatus)) throw new Error('invalid email_status');
      const row = { id: nextId++, name, email, message, emailStatus, createdAt: new Date() };
      rows.push(row);
      return { ...row };
    },
    async setStatus(id, emailStatus) {
      if (!EMAIL_STATUSES.includes(emailStatus)) throw new Error('invalid email_status');
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error('contact message not found');
      row.emailStatus = emailStatus;
      return { ...row };
    },
    async list() {
      return rows.map((r) => ({ ...r }));
    },
  };
}
