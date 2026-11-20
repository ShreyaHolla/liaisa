// F4 enquiry page and API, F10 fallback form (openapi /api/enquiries, /reply, /form).
// One handler serves JSON and HTML, chosen by the Accept header.
import express, { Router } from 'express';
import { ulid } from '../util/ulid.js';
import { formatDate } from '../util/formatDate.js';
import { unitLabel, unitNoun } from '../util/format.js';
import { wantsJson, errorBody } from '../middleware/errors.js';
import { enquiryLimiter } from '../middleware/rateLimits.js';
import { makeStartSchema, replySchema, requirementsSchema, fieldErrors } from '../services/enquiries/schema.js';
import { startEnquiry, replyToEnquiry, submitForm, presentResult, understoodOf } from '../services/enquiries/enquiryService.js';

const VALIDATION_TEXT = 'Please check the highlighted fields.';

/** Placeholder text for the enquiry box, built from the business's own first service and area. */
function examplePrompt(pricing) {
  const service = pricing.services[0];
  const area = Object.keys(pricing.travel.areas)[0];
  if (!service) return 'Tell us what you need, how many, which date and which area';
  return `e.g. ${service.name} for 40 ${unitNoun(service)} on 13 Dec${area ? `, in ${area}` : ''}`;
}

export function enquiryRoutes({ repos, ai, config, mailer = null }) {
  const router = Router();
  const body = [express.json({ limit: '20kb' }), express.urlencoded({ extended: false, limit: '20kb' })];
  const deps = () => ({ repos, ai, config, mailer });

  /** View model for pages/enquire.ejs. */
  function model(over = {}) {
    const biz = repos.businessSettings.get() ?? { businessName: 'Liaisa', tagline: '' };
    const pricing = repos.pricingConfigs.latestApproved()?.configJson ?? { services: [], addons: [], travel: { areas: {} } };
    return {
      fmtDate: formatDate, unitLabel, biz,
      example: examplePrompt(pricing), services: pricing.services, addons: pricing.addons, areas: Object.keys(pricing.travel.areas),
      view: 'start', publicId: null, rawText: '', firstName: '', replyChannel: 'email',
      question: '', message: '', understood: null, prefill: {}, errors: {}, values: {}, notice: '',
      ...over,
    };
  }

  /** Render the page for an enquiry's current state (no price anywhere). */
  function render(res, status, enquiry, turn, extra = {}) {
    const common = {
      publicId: enquiry.publicId, rawText: enquiry.rawText,
      firstName: enquiry.customerName.split(' ')[0], replyChannel: enquiry.preferredChannel,
    };
    const view = { needs_info: 'ask', fallback: 'fallback', out_of_scope: 'scope' }[turn.outcome] ?? 'done';
    res.status(status).render('pages/enquire', model({
      ...common, view, question: turn.question ?? '', message: turn.message ?? '',
      prefill: turn.prefill ?? enquiry.requirementsJson ?? {},
      understood: view === 'done' ? understoodOf(repos, enquiry.requirementsJson) : null,
      ...extra,
    }));
  }

  function renderLimited(req, res, text) {
    const enquiry = req.params.publicId ? repos.enquiries.getByPublicId(req.params.publicId) : null;
    if (enquiry?.status === 'collecting') {
      const last = enquiry.aiState?.history.at(-1);
      return render(res, 429, enquiry, { outcome: 'needs_info', question: last?.text ?? '' }, { notice: text });
    }
    return res.status(429).render('pages/enquire', model({ notice: text }));
  }

  function sendInvalid(req, res, viewName, fields, extra = {}) {
    if (wantsJson(req)) return res.status(400).json(errorBody('validation_error', VALIDATION_TEXT, fields));
    return res.status(400).render('pages/enquire', model({ view: viewName, errors: fields, values: req.body ?? {}, ...extra }));
  }

  function fail(req, res, err, next) {
    if (err.status === 404) {
      if (wantsJson(req)) return res.status(404).json(errorBody('not_found', err.message));
      return res.status(404).type('text/plain').send('Not found');
    }
    if (err.status === 409) {
      if (wantsJson(req)) return res.status(409).json(errorBody('conflict', err.message));
      return res.redirect(303, '/enquire');
    }
    return next(err);
  }

  const startSchema = makeStartSchema(config.whatsappCountryCode);

  router.get('/enquire', (req, res) => res.render('pages/enquire', model()));

  router.post('/api/enquiries', enquiryLimiter({ limit: 3, html: renderLimited }), ...body, async (req, res, next) => {
    try {
      const input = req.body ?? {};
      // Honeypot: look successful, save and call nothing.
      if (typeof input.website === 'string' && input.website !== '') {
        if (wantsJson(req)) return res.status(201).json({ publicId: ulid(), outcome: 'ready', replyChannel: 'email' });
        return res.status(201).render('pages/enquire', model({ view: 'done' }));
      }
      const parsed = startSchema.safeParse(input);
      if (!parsed.success) return sendInvalid(req, res, 'start', fieldErrors(parsed.error));

      const { enquiry, result } = await startEnquiry(deps(), parsed.data);
      const turn = presentResult(repos, enquiry, result);
      return wantsJson(req) ? res.status(201).json(turn) : render(res, 201, enquiry, { ...result, ...turn });
    } catch (err) {
      return fail(req, res, err, next);
    }
  });

  router.post('/api/enquiries/:publicId/reply', enquiryLimiter({ limit: 10, html: renderLimited }), ...body, async (req, res, next) => {
    try {
      const parsed = replySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        const e = repos.enquiries.getByPublicId(req.params.publicId);
        const last = e?.aiState?.history.at(-1);
        return sendInvalid(req, res, 'ask', fieldErrors(parsed.error), e ? {
          publicId: e.publicId, rawText: e.rawText, question: last?.text ?? '', firstName: e.customerName.split(' ')[0],
        } : {});
      }
      const { enquiry, result } = await replyToEnquiry(deps(), req.params.publicId, parsed.data.answer);
      const turn = presentResult(repos, enquiry, result);
      return wantsJson(req) ? res.json(turn) : render(res, 200, enquiry, { ...result, ...turn });
    } catch (err) {
      return fail(req, res, err, next);
    }
  });

  router.post('/api/enquiries/:publicId/form', ...body, (req, res, next) => {
    const input = { ...(req.body ?? {}) };
    if (input.location === 'Other') input.location = input.location_other;
    const showForm = (fields) => {
      const e = repos.enquiries.getByPublicId(req.params.publicId);
      return sendInvalid(req, res, 'fallback', fields, e ? { publicId: e.publicId, rawText: e.rawText, prefill: input } : {});
    };
    try {
      const parsed = requirementsSchema.safeParse(input);
      if (!parsed.success) return showForm(fieldErrors(parsed.error));
      const { enquiry, result } = submitForm(deps(), req.params.publicId, parsed.data);
      if (wantsJson(req)) return res.json({ publicId: enquiry.publicId, outcome: result.outcome });
      return render(res, 200, enquiry, result);
    } catch (err) {
      if (err.status === 400 && err.details) return showForm(err.details);
      return fail(req, res, err, next);
    }
  });

  return router;
}
