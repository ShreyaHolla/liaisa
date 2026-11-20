import express, { Router } from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import { rateLimit } from 'express-rate-limit';
import { csrf, newCsrfToken } from '../middleware/csrf.js';
import { errorBody } from '../middleware/errors.js';
import { ownerEnquiryRoutes } from './ownerEnquiries.js';
import { ownerSetupRoutes } from './ownerSetup.js';

// Owner pages default to HTML: JSON only when the client explicitly prefers it.
const wantsJson = (req) => req.accepts(['html', 'json']) === 'json';

const MSG = {
  wrong: "That password doesn't match. Try again.",
  tooMany: 'Too many tries. Wait 15 minutes, then try again.',
  empty: 'Enter your password.',
};

/** Used when OWNER_PASSWORD_HASH / SESSION_SECRET aren't set: every /owner/* path is 503. */
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
      return renderLogin(req, res, 429, MSG.tooMany);
    },
  });
}

export function ownerRoutes({ config, repos, mailer = null }) {
  const router = Router();

  // Sessions live in MemoryStore on purpose: one demo process, and the demo data is in
  // memory too, so a restart resets both. Passing the store explicitly also stops
  // express-session printing its generic production warning; config.notes says it once.
  router.use(
    session({
      name: 'liaisa.sid',
      secret: config.sessionSecret,
      store: new session.MemoryStore(),
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax', secure: config.env === 'production', maxAge: 8 * 60 * 60 * 1000 },
    }),
  );
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(express.urlencoded({ extended: false, limit: '20kb' }), express.json({ limit: '20kb' }));

  const businessName = () => repos.businessSettings.get()?.businessName ?? 'Liaisa';
  const renderLogin = (req, res, status = 200, error = null) => {
    if (!req.session.csrf) req.session.csrf = newCsrfToken();
    res.status(status).render('pages/owner-login', { businessName: businessName(), csrfToken: req.session.csrf, error });
  };

  // Login (public pages of the owner area). Order on POST: limiter, CSRF, then the check.
  router.get('/login', (req, res) => {
    if (req.session.isOwner) return res.redirect(302, '/owner');
    renderLogin(req, res);
  });
  router.post('/login', loginLimiter(renderLogin), csrf, async (req, res, next) => {
    try {
      const password = req.body?.password;
      if (typeof password !== 'string' || password.length < 1 || password.length > 200) {
        if (wantsJson(req)) return res.status(400).json(errorBody('validation_error', MSG.empty, { password: MSG.empty }));
        return renderLogin(req, res, 400, MSG.empty);
      }
      const ok = await bcrypt.compare(password, config.ownerPasswordHash).catch(() => false);
      if (!ok) {
        if (wantsJson(req)) return res.status(401).json(errorBody('invalid_credentials', MSG.wrong));
        return renderLogin(req, res, 401, MSG.wrong);
      }
      // Rotate the session ID (and CSRF token) on login to prevent session fixation.
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.isOwner = true;
        req.session.csrf = newCsrfToken();
        req.session.save((err2) => (err2 ? next(err2) : res.redirect(302, '/owner')));
      });
    } catch (err) {
      next(err);
    }
  });

  // Everything below needs a session: HTML gets a redirect, JSON a 401.
  router.use((req, res, next) => {
    if (req.session.isOwner) return next();
    if (wantsJson(req)) return res.status(401).json(errorBody('unauthenticated', 'Log in to continue.'));
    return res.redirect(302, '/owner/login');
  });
  router.use(csrf);

  router.use(ownerEnquiryRoutes({ repos, config, mailer }));
  router.use(ownerSetupRoutes({ repos, config }));
  router.post('/logout', (req, res, next) => {
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie('liaisa.sid');
      res.redirect(302, '/owner/login');
    });
  });

  return router;
}
