import { rateLimit } from 'express-rate-limit';
import { wantsJson, errorBody } from './errors.js';

/** Contact form: 5 per IP per hour (openapi "Rate limits"). Counts every POST, valid or not. */
export function contactLimiter() {
  return rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      if (!wantsJson(req)) return res.redirect(303, '/?contact=limit#contact');
      res
        .status(429)
        .json(errorBody('rate_limited', "You've sent a few messages in a row. Try again in an hour."));
    },
  });
}
