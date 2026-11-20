// F7 customer quote page and actions (openapi /b/{slug}/q/{token}/*). The token is the credential: no session, no CSRF.
// One handler serves JSON and HTML. A wrong token is always the same plain 404.
import express, { Router } from 'express';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { wantsJson, errorBody } from '../middleware/errors.js';
import { findQuote, isExpired, acceptQuote, askQuestion, declineQuote, QuoteExpiredError } from '../services/quotes/customer.js';
import { questionSchema, flatErrors } from '../services/quotes/schema.js';
import { describeLines, firstName } from '../services/quotes/messages.js';
import { inr } from '../util/format.js';
import { formatDate } from '../util/formatDate.js';

const REASON_MAX = 500;

export function quoteRoutes({ repos, config, mailer = null, limiters }) {
  const router = Router();
  const base = `/b/${repos.business.slug}`;
  const deps = () => ({ repos, config, mailer });
  const body = [express.json({ limit: '20kb' }), express.urlencoded({ extended: false, limit: '20kb' })];

  router.use('/q', (req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    next();
  }, limiters.quote);

  const notFound = (req, res) => (wantsJson(req)
    ? res.status(404).json(errorBody('not_found', 'We couldn’t find that quote.'))
    : res.status(404).type('text/plain').send('Not found'));

  function render(req, res, status, over = {}) {
    const { estimate, enquiry } = findQuote(deps(), req.params.token);
    const biz = repos.businessSettings.get();
    const closed = ['won', 'lost'].includes(enquiry.status);
    return res.status(status).render('pages/quote', {
      biz, base, firstName: firstName(enquiry), rows: describeLines(estimate.lineItemsJson, biz.currencySymbol ?? '₹'), total: inr(estimate.total, biz.currencySymbol ?? '₹'),
      waLink: biz.whatsappNumber ? `https://wa.me/${biz.whatsappNumber}` : null,
      validUntil: formatDate(estimate.validUntil), note: estimate.noteForCustomer ?? null,
      state: enquiry.status, closed, expired: isExpired(estimate, new Date()), token: req.params.token,
      sent: typeof req.query.r === 'string' ? req.query.r : '', errors: {}, values: {},
      ...over,
    });
  }

  router.get('/q/:token', (req, res, next) => {
    try {
      return render(req, res, 200);
    } catch (err) {
      return err instanceof NotFoundError ? notFound(req, res) : next(err);
    }
  });

  /** Run an action: JSON gets the result, HTML gets a redirect back to the page. */
  function action(name, run) {
    router.post(`/q/:token/${name}`, body, async (req, res, next) => {
      try {
        const result = await run(req);
        if (wantsJson(req)) return res.json(result);
        return res.redirect(303, `${base}/q/${req.params.token}?r=${name}`);
      } catch (err) {
        if (err instanceof NotFoundError) return notFound(req, res);
        if (err instanceof QuoteExpiredError) {
          if (wantsJson(req)) return res.status(410).json(errorBody('quote_expired', err.message));
          return render(req, res, 410);
        }
        if (err instanceof ConflictError) {
          if (wantsJson(req)) return res.status(409).json(errorBody('conflict', err.message));
          return res.redirect(303, `${base}/q/${req.params.token}`);
        }
        if (err instanceof ValidationError) {
          if (wantsJson(req)) return res.status(400).json(errorBody('validation_error', 'Please check the highlighted fields.', err.details));
          return render(req, res, 400, { errors: err.details ?? {}, values: req.body ?? {} });
        }
        return next(err);
      }
    });
  }

  action('accept', (req) => acceptQuote(deps(), req.params.token));
  action('question', (req) => {
    const parsed = questionSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new ValidationError('Invalid', flatErrors(parsed.error));
    return askQuestion(deps(), req.params.token, parsed.data.message);
  });
  action('decline', (req) => {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, REASON_MAX) : '';
    const dnc = ['on', 'true', true].includes(req.body?.doNotContact);
    return declineQuote(deps(), req.params.token, reason || null, { doNotContact: dnc });
  });

  return router;
}
