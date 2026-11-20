// One-tap Approve / Decline from the owner notice email (M12). The signed link is the credential, so this is
// public, but a GET only ever shows a confirm page: the action runs on a POST with a double-submit CSRF
// token (cookie + hidden field). Each link works once and expires after 24 hours.
import express, { Router } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ConflictError, NotFoundError } from '../errors.js';
import { quoteLimiter } from '../middleware/rateLimits.js';
import { verifyLink } from '../services/quotes/oneTap.js';
import { approveAndSend, declineEnquiry, currentEstimate } from '../services/quotes/approval.js';
import { logActivity } from '../services/quotes/clean.js';
import { enquiryDetail } from '../services/owner/dashboard.js';
import { describeLines } from '../services/quotes/messages.js';
import { inr } from '../util/format.js';

const COOKIE = 'liaisa.otc';
const cookieOf = (req) => new RegExp(`(?:^|;\\s*)${COOKIE.replace('.', '\\.')}=([^;]+)`).exec(req.headers.cookie ?? '')?.[1] ?? null;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const PROBLEMS = {
  malformed: [400, 'This link isn’t valid', 'The link looks incomplete. Open the email again and tap the button, or review the quote in Liaisa.'],
  tampered: [400, 'This link isn’t valid', 'The link was changed, so it can’t be used. Review the quote in Liaisa instead.'],
  expired: [410, 'This link has expired', 'One-tap links last 24 hours. Review the quote in Liaisa instead.'],
  used: [409, 'This link was already used', 'Each link works once. Review the quote in Liaisa to see what happened.'],
  changed: [409, 'This quote has changed', 'The quote was edited, approved or declined since the email was sent. Review it in Liaisa.'],
  csrf: [403, 'Your confirmation didn’t go through', 'Go back to the email, tap the link again and confirm on the page.'],
};

export function oneTapRoutes({ repos, config, mailer }) {
  const router = Router();
  const deps = () => ({ repos, config, mailer });
  const secret = config.sessionSecret;

  router.use('/a', (req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    next();
  }, quoteLimiter());

  const problem = (res, key) => {
    const [status, title, text] = PROBLEMS[key];
    return res.status(status).render('pages/link-result', { biz: repos.businessSettings.get(), ok: false, title, text });
  };
  /** The link is checked without being spent. null = fine. */
  const check = (token) => {
    if (!secret) return 'malformed';
    const v = verifyLink(secret, token, new Date());
    if (!v.ok) return { fail: v.reason };
    return { payload: v.payload };
  };

  router.get('/a/:token', (req, res) => {
    const v = check(req.params.token);
    if (v === 'malformed' || v.fail) return problem(res, v.fail ?? v);
    const { enquiryId, version, action, nonce } = v.payload;
    if (repos.usedLinks.has(nonce)) return problem(res, 'used');
    const model = enquiryDetail(deps(), enquiryId);
    if (!model?.estimate || model.estimate.version !== version || !model.can.approve) return problem(res, 'changed');
    const csrf = randomBytes(24).toString('base64url');
    res.cookie(COOKIE, csrf, { httpOnly: true, sameSite: 'strict', secure: config.env === 'production', path: '/a', maxAge: 60 * 60 * 1000 });
    const symbol = repos.businessSettings.get()?.currencySymbol ?? '₹';
    return res.render('pages/link-confirm', {
      biz: repos.businessSettings.get(), action, token: req.params.token, csrf, enquiry: model.enquiry, what: model.what,
      rows: describeLines(model.estimate.lineItemsJson, symbol), total: inr(model.estimate.total, symbol), warnings: model.warnings,
    });
  });

  router.post('/a/:token', express.urlencoded({ extended: false, limit: '2kb' }), async (req, res, next) => {
    try {
      const v = check(req.params.token);
      if (v === 'malformed' || v.fail) return problem(res, v.fail ?? v);
      if (!same(cookieOf(req), req.body?._csrf)) return problem(res, 'csrf');
      const { enquiryId, version, action, nonce } = v.payload;
      if (repos.usedLinks.has(nonce)) return problem(res, 'used');
      repos.usedLinks.add(nonce, new Date()); // spent before acting: a double tap or a replay can't act twice
      res.clearCookie(COOKIE, { path: '/a' });
      const biz = repos.businessSettings.get();
      try {
        if (action === 'approve') {
          const result = await approveAndSend(deps(), enquiryId, version);
          logActivity(repos, enquiryId, 'Approved with a one-tap email link', new Date());
          const sent = result.estimateStatus === 'sent';
          return res.render('pages/link-result', { biz, ok: true, title: sent ? 'Approved and sent' : 'Approved', text: sent ? 'The quote is on its way to the customer.' : result.estimateStatus === 'approved_send_failed' ? 'The quote is approved and saved, but the email didn’t send. Open Liaisa to retry.' : 'The quote is approved. Open Liaisa to send it.' });
        }
        declineEnquiry(deps(), enquiryId, { via: 'a one-tap email link' });
        return res.render('pages/link-result', { biz, ok: true, title: 'Declined', text: 'Nothing was sent to the customer.' });
      } catch (err) {
        if (err instanceof ConflictError || err instanceof NotFoundError) return problem(res, 'changed');
        throw err;
      }
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
