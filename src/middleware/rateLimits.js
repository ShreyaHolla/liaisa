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

const ENQUIRY_LIMIT_TEXT = "You've sent a few enquiries in a row. Try again in an hour, or use the contact form.";

/** Enquiry start (3/hour) and reply (10/hour) per IP (openapi "Rate limits"). `html` renders the no-JS/swap response. */
export function enquiryLimiter({ limit, html }) {
  return rateLimit({
    windowMs: 60 * 60 * 1000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      if (wantsJson(req)) return res.status(429).json(errorBody('rate_limited', ENQUIRY_LIMIT_TEXT));
      return html(req, res, ENQUIRY_LIMIT_TEXT);
    },
  });
}

/** Quote page: 60 requests per IP per 15 minutes, so tokens can't be guessed by brute force. */
export function quoteLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      const text = 'Too many requests. Wait a few minutes, then try again.';
      if (wantsJson(req)) return res.status(429).json(errorBody('rate_limited', text));
      return res.status(429).type('text/plain').send(text);
    },
  });
}
