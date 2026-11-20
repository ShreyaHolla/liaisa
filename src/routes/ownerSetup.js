// Business setup (/owner/setup). Mounted inside the owner router: session and CSRF already checked.
// Plain HTML form, no JavaScript needed. Rows repeat as svc* / area* fields; a ticked "Remove" box drops a row.
import { Router } from 'express';
import { ValidationError } from '../errors.js';
import { makeSetupSchema, MAX_SERVICES, MAX_AREAS } from '../services/setup/schema.js';
import { currentSetup, saveSetup, resetToDemo } from '../services/setup/businessSetup.js';
import { flatErrors } from '../services/quotes/schema.js';
import { makeShare } from '../services/share.js';
import { limitsOf, businessAiToday } from '../services/tenants/limits.js';
import { draftsToday } from '../services/clients/outreach.js';
import { runsToday, searchesToday } from '../services/clients/discovery.js';

const NOTICES = {
  saved: ['ok', 'Saved. New enquiries will use these details. Quotes already made keep their numbers.'],
  reset: ['ok', 'Reset to the demo business.'],
};
const arr = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const str = (v) => (typeof v === 'string' ? v : '');
const isBlank = (...vals) => vals.every((v) => v.trim() === '');

/** Form body -> the object makeSetupSchema validates. Blank spare rows and ticked "Remove" rows are dropped. */
export function parseSetupBody(body) {
  const rows = (names, removeKey, keep) => {
    const removed = new Set(arr(body[removeKey]).map(String));
    const count = Math.max(...names.map((n) => arr(body[n]).length), 0);
    return Array.from({ length: count }, (_, i) => i)
      .filter((i) => !removed.has(String(i)))
      .map((i) => Object.fromEntries(names.map((n) => [n, str(arr(body[n])[i])])))
      .filter((r) => !isBlank(...keep.map((k) => r[k])));
  };
  const services = rows(['svcId', 'svcName', 'svcPrice', 'svcMin', 'svcMax', 'svcUnit'], 'svcRemove', ['svcName', 'svcPrice', 'svcMin', 'svcMax'])
    .map((r) => ({ id: r.svcId, name: r.svcName, price: r.svcPrice, minQty: r.svcMin, maxQty: r.svcMax, unitLabel: r.svcUnit }));
  const areas = rows(['areaName', 'areaFee'], 'areaRemove', ['areaName', 'areaFee']).map((r) => ({ name: r.areaName, fee: r.areaFee }));
  return {
    businessName: str(body.businessName), tagline: str(body.tagline), currencySymbol: str(body.currencySymbol),
    whatsappNumber: str(body.whatsappNumber), followupAfterDays: str(body.followupAfterDays), city: str(body.city),
    bulkApproveLimit: str(body.bulkApproveLimit), autoApprove: body.autoApprove === 'on', weekendPct: str(body.weekendPct), taxPct: str(body.taxPct), services, areas,
  };
}

export function ownerSetupRoutes({ repos, config }) {
  const router = Router();
  const schema = makeSetupSchema(config.whatsappCountryCode);
  const getShare = makeShare(config, repos.business.slug);
  const businessName = () => repos.businessSettings.get()?.businessName ?? 'Liaisa';

  async function render(req, res, status, values, errors = {}) {
    const share = await getShare();
    const blanks = (list, max, make) => [...list, ...Array.from({ length: Math.max(0, Math.min(3, max - list.length)) }, make)];
    const view = {
      ...values,
      services: blanks(values.services, MAX_SERVICES, () => ({ id: '', name: '', price: '', minQty: '', maxQty: '', unitLabel: 'Number of guests' })),
      areas: blanks(values.areas, MAX_AREAS, () => ({ name: '', fee: '' })),
    };
    let n = typeof req.query.n === 'string' && Object.hasOwn(NOTICES, req.query.n) ? NOTICES[req.query.n] : null;
    if (n === NOTICES.reset && !repos.business.isDemo) n = ['ok', 'Reset to the starter services and areas.'];
    const now = new Date();
    const limits = limitsOf(repos, config);
    const usage = {
      requests: businessAiToday(repos, now), requestLimit: limits.aiRequests,
      drafts: draftsToday(repos, now), draftLimit: limits.drafts,
      runs: runsToday(repos, now), runLimit: limits.discoveryRuns, searches: searchesToday(repos, now),
      aiOn: config.aiEnabled,
    };
    res.status(status).render('pages/owner-setup', {
      usage, isDemo: repos.business.isDemo, onboarding: Boolean(repos.businessSettings.get()?.onboarding), slug: repos.business.slug,
      businessName: businessName(), csrfToken: res.locals.csrfToken, v: view, errors, notice: n, active: 'setup', share, noEnquiries: repos.enquiries.list().length === 0,
      limits: { services: MAX_SERVICES, areas: MAX_AREAS },
    });
  }

  router.get('/setup', (req, res, next) => render(req, res, 200, currentSetup(repos)).catch(next));

  router.post('/setup', async (req, res, next) => {
    try {
      const raw = parseSetupBody(req.body ?? {});
      const parsed = schema.safeParse(raw);
      if (!parsed.success) return await render(req, res, 400, raw, flatErrors(parsed.error));
      try {
        saveSetup(repos, parsed.data, config.whatsappCountryCode);
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        return await render(req, res, 400, raw, { _form: err.message });
      }
      return res.redirect(303, '/owner/setup?n=saved');
    } catch (err) {
      return next(err);
    }
  });

  router.post('/setup/reset', (req, res) => {
    resetToDemo(repos); // the demo business goes back to Mehfil Kitchen; any other business goes back to the starter prices
    res.redirect(303, '/owner/setup?n=reset');
  });

  return router;
}
