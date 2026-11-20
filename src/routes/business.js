// Everything a customer sees for ONE business lives under /b/:slug (enquiry page and API, quote page and actions).
// The slug picks the business; each business gets its own routes built from its own repos, so a request can
// only ever touch that business's data. The limiters are shared, so limits are per IP across the platform.
import { Router } from 'express';
import { wantsJson, errorBody } from '../middleware/errors.js';
import { enquiryLimiter, quoteLimiter } from '../middleware/rateLimits.js';
import { enquiryRoutes } from './enquiries.js';
import { quoteRoutes } from './quotes.js';

export function businessRoutes({ registry, ai, config, mailer }) {
  const limiters = {
    // The limiter answers through the page of the business being asked (set per request by enquiryRoutes).
    start: enquiryLimiter({ limit: 3, html: (req, res, text) => req.limitedHtml(req, res, text) }),
    reply: enquiryLimiter({ limit: 10, html: (req, res, text) => req.limitedHtml(req, res, text) }),
    quote: quoteLimiter(),
  };
  const sets = new Map();
  const setFor = (repos) => {
    let s = sets.get(repos.business.id);
    if (!s) {
      s = Router();
      s.use(enquiryRoutes({ repos, ai, config, mailer, limiters }));
      s.use(quoteRoutes({ repos, config, mailer, limiters }));
      sets.set(repos.business.id, s);
    }
    return s;
  };

  // Mount with app.use('/b/:slug', ...): the slug is the only thing that selects a business here.
  return (req, res, next) => {
    const repos = registry.bySlug(req.params.slug);
    if (!repos) {
      return wantsJson(req)
        ? res.status(404).json(errorBody('not_found', 'We couldn’t find that business.'))
        : res.status(404).type('text/plain').send('Not found');
    }
    return setFor(repos)(req, res, next);
  };
}
