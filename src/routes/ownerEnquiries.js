// Owner dashboard, enquiry detail and quote actions (F6, F7, F9, F12). Mounted inside the owner
// router, so session and CSRF checks have already run. HTML by default, JSON when the client asks.
import { Router } from 'express';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { errorBody } from '../middleware/errors.js';
import { approveAndSend, editEstimate, declineEnquiry, retryQuoteEmail, shareOnWhatsapp } from '../services/quotes/approval.js';
import { editSchema, approveSchema, flatErrors } from '../services/quotes/schema.js';
import { dashboardSummary, enquiryDetail } from '../services/owner/dashboard.js';
import { quoteUrl, describeLines } from '../services/quotes/messages.js';
import { inr, timeAgo } from '../util/format.js';
import { formatDate } from '../util/formatDate.js';

const wantsJson = (req) => req.accepts(['html', 'json']) === 'json';

/** Fixed messages for ?n=… (never free text from the URL). [tone, text] */
const NOTICES = {
  approved_sent: ['ok', 'Approved and sent'],
  approved_wa: ['ok', 'Approved. Tap Send on WhatsApp to open the message.'],
  approved_nomail: ['ok', 'Approved. Email is switched off, so copy the quote link below to send it yourself.'],
  send_failed: ['problem', 'The quote email didn’t send. Your quote is saved.'],
  retry_failed: ['problem', 'The quote email still didn’t send. Your quote is saved.'],
  edited: ['ok', 'New version saved. Review it, then approve.'],
  declined: ['ok', 'Enquiry declined. Nothing was sent.'],
  conflict: ['problem', 'That quote has changed or already moved on. Review it and try again.'],
  invalid: ['problem', 'Something in that request wasn’t right. Check it and try again.'],
};
const notice = (req) => (typeof req.query.n === 'string' && Object.hasOwn(NOTICES, req.query.n) ? NOTICES[req.query.n] : null);

const capital = (s) => `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;

function presentEstimate(e) {
  return {
    id: e.id, version: e.version, status: e.status, lineItems: e.lineItemsJson, subtotal: e.subtotal, tax: e.tax,
    total: e.total, currency: e.currency, warnings: e.warningsJson, revisionReason: e.revisionReason ?? undefined,
    ...(e.validUntil ? { validUntil: e.validUntil } : {}),
  };
}

export function ownerEnquiryRoutes({ repos, config, mailer }) {
  const router = Router();
  const deps = () => ({ repos, config, mailer });
  const businessName = () => repos.businessSettings.get()?.businessName ?? 'Liaisa';

  const notFound = (req, res) => (wantsJson(req)
    ? res.status(404).json(errorBody('not_found', 'We couldn’t find that enquiry.'))
    : res.status(404).type('text/plain').send('Not found'));

  router.param('id', (req, res, next, id) => {
    if (!/^\d{1,9}$/.test(id)) return notFound(req, res);
    req.enquiryId = Number(id);
    return next();
  });

  /** Typed service errors → JSON error body, or a redirect back with a fixed notice. */
  function fail(req, res, err, next, back) {
    const hit = [[ValidationError, 400, 'validation_error', 'invalid'], [ConflictError, 409, 'conflict', 'conflict'], [NotFoundError, 404, 'not_found']]
      .find(([C]) => err instanceof C);
    if (!hit) return next(err);
    const [, status, code, key] = hit;
    if (wantsJson(req)) return res.status(status).json(errorBody(code, err.message, err.details));
    if (status === 404) return notFound(req, res);
    return res.redirect(303, `${back}?n=${key}`);
  }
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const detailUrl = (req) => `/owner/enquiries/${req.enquiryId}`;

  // ---- Dashboard -------------------------------------------------------------------------
  router.get('/', (req, res) => {
    const summary = dashboardSummary(deps());
    res.render('pages/owner', {
      businessName: businessName(), csrfToken: res.locals.csrfToken, summary, inr, notice: notice(req),
      baseUrl: config.baseUrl,
    });
  });

  router.get('/api/summary', (req, res) => {
    const { needsYou, week } = dashboardSummary(deps());
    res.json({ needsYou, week });
  });

  // ---- Enquiry detail --------------------------------------------------------------------
  function renderDetail(req, res, status = 200, edit = { errors: {}, values: {} }) {
    const model = enquiryDetail(deps(), req.enquiryId);
    if (!model) return notFound(req, res);
    const link = model.estimate?.quoteToken ? quoteUrl(config, model.estimate.quoteToken) : null;
    return res.status(status).render('pages/owner-enquiry', {
      ...model, businessName: businessName(), csrfToken: res.locals.csrfToken, inr, formatDate, timeAgo, edit,
      rows: model.estimate ? describeLines(model.estimate.lineItemsJson) : [],
      notice: notice(req), quoteLink: link,
      replyEmail: model.enquiry.customerEmail, replyPhone: model.enquiry.customerPhone?.replace(/\D/g, '') ?? null,
    });
  }
  router.get('/enquiries/:id', (req, res) => renderDetail(req, res));

  // ---- Approve & send --------------------------------------------------------------------
  router.post('/enquiries/:id/approve', wrap(async (req, res, next) => {
    try {
      const parsed = approveSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw new ValidationError('Reload the page and try again.', flatErrors(parsed.error));
      const result = await approveAndSend(deps(), req.enquiryId, parsed.data.estimateVersion);
      if (wantsJson(req)) return res.json(result);
      const key = result.channel === 'whatsapp' ? 'approved_wa'
        : result.estimateStatus === 'sent' ? 'approved_sent'
          : result.estimateStatus === 'approved_send_failed' ? 'send_failed' : 'approved_nomail';
      return res.redirect(303, `${detailUrl(req)}?n=${key}`);
    } catch (err) {
      return fail(req, res, err, next, detailUrl(req));
    }
  }));

  // ---- Edit (new version) ----------------------------------------------------------------
  router.post('/enquiries/:id/edit', wrap(async (req, res, next) => {
    try {
      const enquiry = repos.enquiries.get(req.enquiryId);
      if (!enquiry) throw new NotFoundError();
      const body = req.body ?? {};
      const raw = req.is('application/json') ? body : {
        requirements: { ...enquiry.requirementsJson, quantity: body.quantity },
        discount: String(body.discountAmount ?? '').trim() ? { amount: body.discountAmount, reason: body.discountReason } : undefined,
        note: body.note, revisionReason: body.revisionReason,
      };
      const parsed = editSchema.safeParse(raw);
      const formErrors = (fields) => {
        // Map zod paths back to the form's field names
        const map = { 'requirements.quantity': 'quantity', 'discount.amount': 'discountAmount', 'discount.reason': 'discountReason' };
        return Object.fromEntries(Object.entries(fields).map(([k, v]) => [map[k] ?? k, v]));
      };
      const reject = (fields, message) => {
        if (wantsJson(req)) return res.status(400).json(errorBody('validation_error', message, fields));
        return renderDetail(req, res, 400, { errors: formErrors(fields), values: body });
      };
      if (!parsed.success) return reject(flatErrors(parsed.error), 'Please check the highlighted fields.');
      try {
        const created = editEstimate(deps(), req.enquiryId, parsed.data);
        return wantsJson(req) ? res.json(presentEstimate(created)) : res.redirect(303, `${detailUrl(req)}?n=edited`);
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        return reject({ _form: capital(err.message) }, capital(err.message));
      }
    } catch (err) {
      return fail(req, res, err, next, detailUrl(req));
    }
  }));

  // ---- Decline ---------------------------------------------------------------------------
  router.post('/enquiries/:id/decline', (req, res, next) => {
    try {
      declineEnquiry(deps(), req.enquiryId);
      return wantsJson(req) ? res.json({ ok: true }) : res.redirect(303, '/owner?n=declined');
    } catch (err) {
      return fail(req, res, err, next, detailUrl(req));
    }
  });

  // ---- Retry a failed email --------------------------------------------------------------
  router.post('/enquiries/:id/retry-send', wrap(async (req, res, next) => {
    try {
      const result = await retryQuoteEmail(deps(), req.enquiryId);
      if (wantsJson(req)) return res.json(result);
      return res.redirect(303, `${detailUrl(req)}?n=${result.estimateStatus === 'sent' ? 'approved_sent' : 'retry_failed'}`);
    } catch (err) {
      return fail(req, res, err, next, detailUrl(req));
    }
  }));

  // ---- Send on WhatsApp ------------------------------------------------------------------
  router.post('/enquiries/:id/whatsapp', (req, res, next) => {
    try {
      const { url } = shareOnWhatsapp(deps(), req.enquiryId);
      return wantsJson(req) ? res.json({ url }) : res.redirect(302, url);
    } catch (err) {
      return fail(req, res, err, next, detailUrl(req));
    }
  });

  return router;
}
