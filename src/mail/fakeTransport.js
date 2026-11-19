/** Records emails in memory instead of sending. Used by tests. `fail` makes every send reject. */
export function createFakeMailer({ fail = false } = {}) {
  const sent = [];
  return {
    sent,
    fail,
    async send(message) {
      if (this.fail) {
        const err = new Error('fake SMTP failure');
        err.code = 'ESOCKET';
        throw err;
      }
      sent.push(message);
      return { accepted: [message.to] };
    },
  };
}
