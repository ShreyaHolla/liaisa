import express, { Router } from 'express';
import bcrypt from 'bcryptjs';
import { rateLimit } from 'express-rate-limit';
import { csrf, newCsrfToken } from '../middleware/csrf.js';
import { errorBody } from '../middleware/errors.js';
import { normaliseEmail } from '../db/registry.js';
import { ownerEnquiryRoutes } from './ownerEnquiries.js';
import { ownerSetupRoutes } from './ownerSetup.js';
import { ownerMessageRoutes } from './ownerMessages.js';
import { ownerClientRoutes } from './ownerClients.js';

// Owner pages default to HTML: JSON only when the client explicitly prefers it.
const wantsJson = (req) => req.accepts(['html', 'json']) === 'json';

// One message for "no such email" and "wrong password": the page never says which.
const MSG = {
  wrong: "That email and password don't match. Try again.",
  tooMany: 'Too many tries. Wait 15 minutes, then try again.',
  empty: 'Enter your email and password.',
};

/** Used when SESSION_SECRET and an owner password hash aren't set: every /owner/* path is 503. */
export function ownerDisabled(req, res) {
  const message = "Owner area isn't set up yet.";
  if (wantsJson(req)) return res.status(503).json(errorBody('owner_disabled', message));
  return res.status(503).type('text/plain').send(message);
}

/** Login: 5 failed tries per IP per 15 minutes (a successful login doesn't count). */
function loginLimiter(renderLogin) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      if (wantsJson(req)) return res.status(429).json(errorBody('rate_limited', MSG.tooMany));
      return renderLogin(req, res, 429, MSG.tooMany, req.body?.email);
    },
  });
}

// Compared when the email is unknown, so a miss takes as long as a wrong password.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

export function ownerRoutes({ config, registry, mailer = null, ai = null, session }) {
  const router = Router();

  router.use(session);
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(express.urlencoded({ extended: false, limit: '20kb' }), express.json({ limit: '20kb' }));

  // The login page is Liaisa's, not any business's: it shows the wordmark.
  const renderLogin = (req, res, status = 200, error = null, email = '') => {
    if (!req.session.csrf) req.session.csrf = newCsrfToken();
    res.status(status).render('pages/owner-login', { csrfToken: req.session.csrf, error, email: typeof email === 'string' ? email.slice(0, 254) : '' });
  };

  // Login (public pages of the owner area). Order on POST: limiter, CSRF, then the check.
  router.get('/login', (req, res) => {
    if (req.session.ownerId) return res.redirect(302, '/owner');
    renderLogin(req, res);
  });
  router.post('/login', loginLimiter(renderLogin), csrf, async (req, res, next) => {
    try {
      const { email, password } = req.body ?? {};
      const given = typeof email === 'string' && typeof password === 'string' && email.trim() !== '' && password.length >= 1 && email.length <= 254 && password.length <= 200;
      if (!given) {
        if (wantsJson(req)) return res.status(400).json(errorBody('validation_error', MSG.empty));
        return renderLogin(req, res, 400, MSG.empty, email);
      }
      const owner = registry.ownerByEmail(normaliseEmail(email));
      const ok = await bcrypt.compare(password, owner?.passwordHash ?? DUMMY_HASH).catch(() => false);
      if (!owner || !ok) {
        if (wantsJson(req)) return res.status(401).json(errorBody('invalid_credentials', MSG.wrong));
        return renderLogin(req, res, 401, MSG.wrong, email);
      }
      return startOwnerSession(req, res, next, owner, '/owner');
    } catch (err) {
      return next(err);
    }
  });

  // Everything below needs a session: HTML gets a redirect, JSON a 401. The business comes from the SESSION only,
  // never from a URL, query or body parameter, so an owner can only ever reach their own business's data.
  router.use((req, res, next) => {
    const owner = req.session.ownerId ? registry.ownerById(req.session.ownerId) : null;
    if (owner && owner.businessId === req.session.businessId && registry.repos(owner.businessId)) {
      req.owner = owner;
      req.repos = registry.repos(owner.businessId);
      return next();
    }
    if (wantsJson(req)) return res.status(401).json(errorBody('unauthenticated', 'Log in to continue.'));
    return res.redirect(302, '/owner/login');
  });
  router.use(csrf);

  router.post('/logout', (req, res, next) => {
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie('liaisa.sid');
      res.redirect(302, '/owner/login');
    });
  });

  // One set of owner routes per business, built once from THAT business's repos. A request is dispatched to the
  // set of the business in its session, so the route code never sees another business's data.
  const tenants = new Map();
  const tenantRouter = (repos) => {
    let t = tenants.get(repos.business.id);
    if (!t) {
      t = Router();
      // The badge on the Approvals tab: how many quotes wait for the owner (every owner page shows it).
      t.use((req, res, next) => {
        res.locals.pending = repos.enquiries.list().filter((e) => ['awaiting_approval', 'needs_owner'].includes(e.status)).length;
        res.locals.owner = req.owner;
        res.locals.showMessages = Boolean(repos.business.isDemo);
        res.locals.unreadMessages = repos.business.isDemo ? repos.contactMessages.unreadCount() : 0;
        next();
      });
      t.use(ownerMessageRoutes({ repos }));
      t.use(ownerEnquiryRoutes({ repos, config, mailer }));
      t.use(ownerSetupRoutes({ repos, config }));
      t.use(ownerClientRoutes({ repos, config, ai, mailer }));
      tenants.set(repos.business.id, t);
    }
    return t;
  };
  router.use((req, res, next) => tenantRouter(req.repos)(req, res, next));

  return router;
}

/** Rotate the session ID (and CSRF token) when someone logs in or signs up, to prevent session fixation. */
export function startOwnerSession(req, res, next, owner, to) {
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.ownerId = owner.id;
    req.session.businessId = owner.businessId;
    req.session.csrf = newCsrfToken();
    req.session.save((err2) => (err2 ? next(err2) : res.redirect(302, to)));
  });
}
