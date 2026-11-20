// Owner "Messages": what visitors wrote in the landing-page contact form. Demo business only (the form on
// the landing page belongs to it). Mounted inside the owner router, so session and CSRF have already run.
import { Router } from 'express';
import { timeAgo } from '../util/format.js';

const STATUS = {
  accepted: ['done', 'Email sent'],
  failed: ['problem', 'Email not delivered'],
  skipped: ['neutral', 'Email off'],
  pending: ['progress', 'Sending email…'],
};

export function ownerMessageRoutes({ repos }) {
  const router = Router();
  const store = repos.contactMessages;
  const demoOnly = (req, res, next) => (repos.business.isDemo ? next() : res.status(404).type('text/plain').send('Not found'));

  router.get('/messages', demoOnly, (req, res) => {
    res.render('pages/owner-messages', {
      businessName: repos.business.name, csrfToken: res.locals.csrfToken, active: 'messages',
      messages: store.all(), statusOf: (m) => STATUS[m.emailStatus] ?? STATUS.skipped, timeAgo, now: new Date(),
    });
  });
  router.post('/messages/read-all', demoOnly, (req, res) => {
    store.markAllRead();
    res.redirect(303, '/owner/messages');
  });
  router.post('/messages/:id/read', demoOnly, (req, res) => {
    if (store.get(req.params.id)) store.markRead(req.params.id);
    res.redirect(303, '/owner/messages');
  });
  return router;
}
