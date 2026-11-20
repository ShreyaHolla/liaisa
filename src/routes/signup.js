// Signup: a new business from the starter template, its owner logged in, then Setup with a short checklist.
// In-memory demo: data may reset (said on the page). Per-IP limit, honeypot field, and a cap on businesses.
import express, { Router } from 'express';
import bcrypt from 'bcryptjs';
import { rateLimit } from 'express-rate-limit';
import { csrf, newCsrfToken } from '../middleware/csrf.js';
import { signupSchema } from '../services/tenants/signupSchema.js';
import { flatErrors } from '../services/quotes/schema.js';
import { SignupError } from '../db/registry.js';
import { startOwnerSession } from './owner.js';

export const BCRYPT_COST = 12;
const LIMIT_TEXT = 'Too many signup attempts from this connection. Try again in an hour.';
const CAP_TEXT = "We're full for this demo right now. Please try again later.";

export function signupRoutes({ registry, session, hash = (pw) => bcrypt.hash(pw, BCRYPT_COST) }) {
  const router = Router();
  // Scoped to /signup, so no other page pays for a session lookup.
  router.use('/signup', session, (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  }, express.urlencoded({ extended: false, limit: '20kb' }));

  const render = (req, res, status = 200, { errors = {}, values = {}, notice = null } = {}) => {
    if (!req.session.csrf) req.session.csrf = newCsrfToken();
    // The password is never put back in the page.
    const { password, ...safe } = values;
    res.status(status).render('pages/signup', { csrfToken: req.session.csrf, errors, values: safe, notice });
  };

  const limiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => render(req, res, 429, { notice: LIMIT_TEXT, values: req.body ?? {} }),
  });

  router.get('/signup', (req, res) => {
    if (req.session.ownerId) return res.redirect(302, '/owner');
    return render(req, res);
  });

  router.post('/signup', limiter, csrf, async (req, res, next) => {
    try {
      const input = req.body ?? {};
      // Honeypot: look successful, create nothing.
      if (typeof input.website === 'string' && input.website !== '') return res.redirect(303, '/owner/login');

      const parsed = signupSchema.safeParse(input);
      if (!parsed.success) return render(req, res, 400, { errors: flatErrors(parsed.error), values: input });
      const data = parsed.data;
      // Cheap checks first, so a refusal never costs a bcrypt round.
      if (registry.emailTaken(data.email)) return render(req, res, 409, { errors: { email: 'That email already has an account. Log in instead.' }, values: input });
      if (registry.size >= registry.maxBusinesses) return render(req, res, 503, { notice: CAP_TEXT, values: input });

      const passwordHash = await hash(data.password);
      try {
        const { owner } = registry.signup({ ...data, passwordHash });
        return startOwnerSession(req, res, next, owner, '/owner/setup');
      } catch (err) {
        if (!(err instanceof SignupError)) throw err;
        if (err.code === 'email_taken') return render(req, res, 409, { errors: { email: err.message }, values: input });
        return render(req, res, 503, { notice: CAP_TEXT, values: input });
      }
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
