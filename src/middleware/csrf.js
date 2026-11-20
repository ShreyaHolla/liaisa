import { randomBytes, timingSafeEqual } from 'node:crypto';
import { errorBody } from './errors.js';

/** Fresh random token, stored in the session by the caller. */
export const newCsrfToken = () => randomBytes(32).toString('base64url');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function matches(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Session-bound CSRF check for every owner POST (openapi: form field `_csrf` or header
 * `X-CSRF-Token`). Also exposes the token to views as `csrfToken`, creating it if missing.
 * Needs express-session and a parsed body before it.
 */
export function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = newCsrfToken();
  res.locals.csrfToken = req.session.csrf;
  if (SAFE_METHODS.has(req.method)) return next();
  const sent = req.get('x-csrf-token') ?? req.body?._csrf;
  if (matches(sent, req.session.csrf)) return next();
  if (req.accepts(['html', 'json']) === 'json') {
    return res.status(403).json(errorBody('csrf_failed', 'Your session expired. Reload the page and try again.'));
  }
  return res.status(403).type('text/plain').send('Your session expired. Go back, reload the page and try again.');
}
