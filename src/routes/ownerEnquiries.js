// Owner dashboard, enquiry detail and quote actions (F6, F7, F9, F12). Mounted inside the owner
// router, so session and CSRF checks have already run. HTML by default, JSON when the client asks.
import { Router } from 'express';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { errorBody } from '../middleware/errors.js';
import { approveAndSend, editEstimate, declineEnquiry, retryQuoteEmail, shareOnWhatsapp, repriceEstimate } from '../services/quotes/approval.js';
import { editSchema, approveSchema, flatErrors } from '../services/quotes/schema.js';
import { dashboardSummary, enquiryDetail, whatOf } from '../services/owner/dashboard.js';
import { sendReminder, markFollowupDone } from '../services/followups/reminders.js';
import { cleanQuotes, approveClean, limitOf } from '../services/quotes/clean.js';
import { quoteUrl, describeLines } from '../services/quotes/messages.js';
import { makeShare, downloadSvg } from '../services/share.js';
import { inr, timeAgo, unitLabel } from '../util/format.js';
import { formatDate, spokenDate } from '../util/formatDate.js';

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
  reminder_sent: ['ok', 'Reminder sent'],
  reminder_failed: ['problem', 'The reminder email didn’t send. Try again.'],
  followup_done: ['ok', 'Marked as done. This follow-up is hidden.'],
  already_current: ['ok', 'This quote already uses your current prices.'],
  reprice_failed: ['problem', 'The quote couldn’t be repriced with the current prices (for example a service was removed, or the discount is now more than the quote). It is unchanged.'],
  conflict: ['problem', 'That quote has changed or already moved on. Review it and try again.'],
  invalid: ['problem', 'Something in that request wasn’t right. Check it and try again.'],
};
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
  const getShare = makeShare(config, repos.business.slug);
  const money = (n) => inr(n, repos.businessSettings.get()?.currencySymbol ?? '₹'); // symbol is display only

  const notice = (req) => {
    if (req.query.n === 'repriced') {
      const [b, a] = [Number.parseInt(req.query.b, 10), Number.parseInt(req.query.a, 10)];
      const ok = [b, a].every((v) => Number.isInteger(v) && v >= 0 && v <= 1e9);
      return ['ok', ok ? `Repriced with current prices: ${money(b)} to ${money(a)}.` : 'Repriced with current prices.'];
    }
    if (req.query.n === 'bulk_done') {
      const c = Number.parseInt(req.query.c, 10);
      const n = Number.isInteger(c) && c >= 0 && c <= 999 ? c : 0;
      return ['ok', n === 0 ? 'No clean quotes were left to approve.' : `${n} quote${n === 1 ? '' : 's'} approved.`];
    }
    return typeof req.query.n === 'string' && Object.hasOwn(NOTICES, req.query.n) ? NOTICES[req.query.n] : null;
  };

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
    if (wantsJson(req)) return res.status(status).json(errorBody(err.code ?? code, err.message, err.details));
    if (status === 404) return notFound(req, res);
    return res.redirect(303, `${back}?n=${err.code && Object.hasOwn(NOTICES, err.code) ? err.code : key}`);
  }
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const detailUrl = (req) => `/owner/enquiries/${req.enquiryId}`;

  // ---- Dashboard -------------------------------------------------------------------------
  // The QR as a file to print or share (made here, no external service).
  router.get('/enquiry-qr.svg', wrap(async (req, res) => {
    const { qrSvg } = await getShare();
    if (!qrSvg) return notFound(req, res);
    res.set({ 'Content-Type': 'image/svg+xml; charset=utf-8', 'Content-Disposition': 'attachment; filename="enquiry-qr.svg"', 'Cache-Control': 'private, max-age=3600' });
    return res.send(downloadSvg(qrSvg));
  }));

  router.get('/', wrap(async (req, res) => {
    const summary = dashboardSummary(deps());
    const share = await getShare();
    const pending = summary.needsYou.filter((n) => ['approval', 'review'].includes(n.kind));
    res.render('pages/owner', {
      businessName: businessName(), csrfToken: res.locals.csrfToken, summary, inr: money, notice: notice(req), formatDate, spokenDate,
      baseUrl: config.baseUrl, active: 'approvals', pending: pending.length, approvals: pending,
      attention: summary.needsYou.filter((n) => !['approval', 'review'].includes(n.kind)),
      share, noEnquiries: summary.all.length === 0,
    });
  }));

  // ---- Follow-ups page (tab) --------------------------------------------------------------------
  // ---- Account: who is logged in, Setup, Log out (the phone tab opens this as a sheet) ----------
  router.get('/account', (req, res) => {
    res.render('pages/owner-account', { businessName: businessName(), csrfToken: res.locals.csrfToken, active: 'account' });
  });

  router.get('/follow-ups', (req, res) => {
    const summary = dashboardSummary(deps());
    res.render('pages/owner-followups', {
      businessName: businessName(), csrfToken: res.locals.csrfToken, summary, notice: notice(req), active: 'followups',
      pending: summary.needsYou.filter((n) => ['approval', 'review'].includes(n.kind)).length,
      days: repos.businessSettings.get()?.followupAfterDays ?? 2,
    });
  });

  // ---- Approve all clean quotes: a confirmation first, then exactly what was listed -------------------
  router.get('/approve-clean', (req, res) => {
    const pricing = repos.pricingConfigs.latestApproved().configJson;
    const items = cleanQuotes(deps()).map(({ enquiry, estimate }) => ({
      id: enquiry.id, name: enquiry.customerName, total: money(estimate.total), amount: estimate.total, channel: enquiry.preferredChannel,
      what: whatOf(pricing, enquiry.requirementsJson),
    }));
    res.render('pages/owner-bulk', {
      businessName: businessName(), csrfToken: res.locals.csrfToken, items, limit: limitOf(repos), limitText: limitOf(repos) === null ? null : money(limitOf(repos)),
      sum: money(items.reduce((n, i) => n + i.amount, 0)), active: 'approvals', pending: items.length,
    });
  });
  router.post('/approve-clean', wrap(async (req, res, next) => {
    try {
      const raw = req.body?.ids;
      const ids = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0).slice(0, 200);
      const result = await approveClean(deps(), ids);
      if (wantsJson(req)) return res.json({ approved: result.approved, skipped: result.skipped });
      return res.redirect(303, `/owner?n=bulk_done&c=${result.approved.length}`);
    } catch (err) {
      return fail(req, res, err, next, '/owner');
    }
  }));

  router.get('/api/summary', (req, res) => {
    const { needsYou, week } = dashboardSummary(deps());
    res.json({ needsYou, week });
  });

  // ---- Enquiry detail --------------------------------------------------------------------
  function renderDetail(req, res, status = 200, edit = { errors: {}, values: {} }) {
    const model = enquiryDetail(deps(), req.enquiryId);
    if (!model) return notFound(req, res);
    const link = model.estimate?.quoteToken ? quoteUrl(config, model.estimate.quoteToken, repos.business.slug) : null;
    return res.status(status).render('pages/owner-enquiry', {
      active: 'approvals', pending: dashboardSummary(deps()).needsYou.filter((n) => ['approval', 'review'].includes(n.kind)).length,
      ...model, businessName: businessName(), csrfToken: res.locals.csrfToken, inr: money, formatDate, timeAgo, unitLabel, edit,
      rows: model.estimate ? describeLines(model.estimate.lineItemsJson, repos.businessSettings.get()?.currencySymbol ?? '₹') : [],
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

  // ---- Reprice with current prices (open drafts only) ----------------------------------------
  router.post('/enquiries/:id/reprice', (req, res, next) => {
    try {
      const { estimate, before, after } = repriceEstimate(deps(), req.enquiryId);
      if (wantsJson(req)) return res.json({ ...presentEstimate(estimate), before, after });
      return res.redirect(303, `${detailUrl(req)}?n=repriced&b=${before}&a=${after}`);
    } catch (err) {
      if (err instanceof ValidationError) {
        return wantsJson(req) ? fail(req, res, err, next, detailUrl(req)) : res.redirect(303, `${detailUrl(req)}?n=reprice_failed`);
      }
      return fail(req, res, err, next, detailUrl(req));
    }
  });

  // ---- Decline ---------------------------------------------------------------------------
  router.post('/enquiries/:id/decline', (req, res, next) => {
    try {
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.replace(/[\r\n]+/g, ' ').trim().slice(0, 200) : '';
      declineEnquiry(deps(), req.enquiryId, { reason: reason || null });
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

  // ---- Follow up (M8-lite): the owner sends one reminder by hand ---------------------------
  router.post('/enquiries/:id/followup/send', wrap(async (req, res, next) => {
    try {
      const result = await sendReminder(deps(), req.enquiryId);
      if (wantsJson(req)) return res.json(result);
      if (result.channel === 'whatsapp') return res.redirect(302, result.url);
      return res.redirect(303, `${detailUrl(req)}?n=${result.status === 'sent' ? 'reminder_sent' : 'reminder_failed'}`);
    } catch (err) {
      return fail(req, res, err, next, detailUrl(req));
    }
  }));

  router.post('/enquiries/:id/followup/done', (req, res, next) => {
    try {
      markFollowupDone(deps(), req.enquiryId);
      return wantsJson(req) ? res.json({ ok: true }) : res.redirect(303, `${detailUrl(req)}?n=followup_done`);
    } catch (err) {
      return fail(req, res, err, next, detailUrl(req));
    }
  });

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
