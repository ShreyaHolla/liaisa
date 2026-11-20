// Client Finder (M10-lite): /owner/clients. Mounted inside the owner router, so the session and CSRF
// checks have already run. HTML by default, JSON when the client asks. Nothing here sends by itself.
import { Router } from 'express';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { errorBody } from '../middleware/errors.js';
import { reconnectRows, leadRows } from '../services/clients/people.js';
import { createDraft, sendDraft, markDoNotContact, addLead, activityLog, draftsToday, updateLeadStatus } from '../services/clients/outreach.js';
import { discoverClients, searchesToday, runsToday, CACHE_HOURS } from '../services/clients/discovery.js';
import { makeLeadSchema, subjectSchema, sendSchema } from '../services/clients/schema.js';
import { flatErrors } from '../services/quotes/schema.js';
import { limitsOf } from '../services/tenants/limits.js';
import { formatDate } from '../util/formatDate.js';
import { timeAgo } from '../util/format.js';

const wantsJson = (req) => req.accepts(['html', 'json']) === 'json';

/** Fixed texts for ?n=… (never free text from the URL). [tone, text] */
const NOTICES = {
  lead_added: ['ok', 'Lead added.'],
  dnc_done: ['ok', 'Marked as do not contact. No message can be drafted for them.'],
  do_not_contact: ['problem', 'That person asked not to be contacted, so no message was drafted.'],
  recent: ['problem', 'That person was contacted in the last 7 days. See the date in the list.'],
  draft_limit: ['problem', 'You’ve reached today’s limit of drafts. Try again tomorrow.'],
  no_contact: ['problem', 'There is no contact detail for that person.'],
  duplicate_lead: ['problem', 'This contact is already in your leads.'],
  sent: ['ok', 'Sent.'],
  send_failed: ['problem', 'The email didn’t send. Your message is saved. You can try again.'],
  found: ['ok', 'Here are the organisations Liaisa found. Check each one before you contact it.'],
  cached: ['ok', `Showing the result of the last search for this choice (under ${CACHE_HOURS} hours old). No new search was made.`],
  no_matches: ['problem', 'No clear matches. Try another area or service.'],
  discovery_limit: ['problem', 'You’ve reached today’s limit of searches for clients. Try again tomorrow.'],
  ai_off: ['problem', 'Finding clients needs AI, which is switched off.'],
  ai_cap: ['problem', 'The daily AI limit has been reached. Try again tomorrow.'],
  no_city: ['problem', 'Add your city on Business setup first, so searches are local.'],
  bad_focus: ['problem', 'Choose a service and an area from the lists.'],
  discovery_failed: ['problem', 'The search didn’t work this time. Nothing was saved. Try again in a minute.'],
  lead_updated: ['ok', 'Lead updated.'],
  not_interested: ['problem', 'You marked that lead as not interested, so no message can be drafted.'],
  conflict: ['problem', 'That message has already been sent, or the person has changed. Check the list.'],
};
const notice = (req) => (typeof req.query.n === 'string' && Object.hasOwn(NOTICES, req.query.n) ? NOTICES[req.query.n] : null);

export function ownerClientRoutes({ repos, config, ai, mailer }) {
  const router = Router();
  const deps = () => ({ repos, config, ai, mailer });
  const leadSchema = makeLeadSchema(config.whatsappCountryCode);
  const businessName = () => repos.businessSettings.get()?.businessName ?? 'Liaisa';
  const notFound = (req, res) => (wantsJson(req)
    ? res.status(404).json(errorBody('not_found', 'We couldn’t find that.'))
    : res.status(404).type('text/plain').send('Not found'));

  /** Typed service errors → JSON error, or a redirect back with a fixed notice. */
  function fail(req, res, err, next, back) {
    if (err instanceof NotFoundError) return notFound(req, res);
    if (!(err instanceof ConflictError || err instanceof ValidationError)) return next(err);
    const status = err instanceof ValidationError ? 400 : 409;
    if (wantsJson(req)) return res.status(status).json(errorBody(err.code ?? (status === 400 ? 'validation_error' : 'conflict'), err.message, err.details));
    const key = err.code && Object.hasOwn(NOTICES, err.code) ? err.code : 'conflict';
    return res.redirect(303, `${back}${back.includes('?') ? '&' : '?'}n=${key}`);
  }
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // ---- The page -------------------------------------------------------------------------------
  function renderPage(req, res, status = 200, over = {}) {
    const wanted = over.tab ?? req.query.tab;
    const tab = ['leads', 'find'].includes(wanted) ? wanted : 'reconnect';
    const now = new Date();
    res.status(status).render('pages/owner-clients', {
      businessName: businessName(), csrfToken: res.locals.csrfToken, tab, notice: notice(req),
      rows: tab === 'reconnect' ? reconnectRows(deps(), now) : [],
      leads: tab === 'leads' ? leadRows(deps(), now).filter((l) => l.kind !== 'discovered') : [],
      found: tab === 'find' ? leadRows(deps(), now).filter((l) => l.kind === 'discovered') : [],
      focus: { services: repos.pricingConfigs.latestApproved().configJson.services.map((s) => s.name), areas: Object.keys(repos.pricingConfigs.latestApproved().configJson.travel.areas) },
      searchesToday: searchesToday(repos, now), runsToday: runsToday(repos, now), discoveryCap: limitsOf(repos, config).discoveryRuns,
      activity: activityLog(deps()), draftsToday: draftsToday(repos, now), cap: limitsOf(repos, config).drafts,
      formatDate, timeAgo, now, errors: {}, values: {}, active: 'clients', ...over,
    });
  }
  router.get('/clients', (req, res) => renderPage(req, res));

  // ---- Leads ----------------------------------------------------------------------------------
  router.post('/clients/leads', (req, res, next) => {
    try {
      const parsed = leadSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        const fields = flatErrors(parsed.error);
        if (wantsJson(req)) return res.status(400).json(errorBody('validation_error', 'Please check the highlighted fields.', fields));
        return renderPage(req, res, 400, { tab: 'leads', errors: fields, values: req.body ?? {} });
      }
      const lead = addLead(deps(), parsed.data);
      return wantsJson(req) ? res.status(201).json({ id: lead.id }) : res.redirect(303, '/owner/clients?tab=leads&n=lead_added');
    } catch (err) {
      return fail(req, res, err, next, '/owner/clients?tab=leads');
    }
  });

  // ---- Find clients (web search) ---------------------------------------------------------------
  router.post('/clients/discover', wrap(async (req, res, next) => {
    try {
      const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
      const result = await discoverClients(deps(), { service: pick(req.body?.service), area: pick(req.body?.area) });
      if (wantsJson(req)) {
        return res.json({
          cached: result.cached, searches: result.searches, dropped: result.dropped,
          leads: result.leads.map((l) => ({ id: l.id, organisation: l.name, type: l.orgType, whyAFit: l.whyFit, sourceUrl: l.sourceUrl, sourceDomain: l.sourceDomain, publicContact: l.publicContact, status: l.status })),
        });
      }
      const n = result.leads.length === 0 ? 'no_matches' : result.cached ? 'cached' : 'found';
      return res.redirect(303, `/owner/clients?tab=find&n=${n}`);
    } catch (err) {
      return fail(req, res, err, next, '/owner/clients?tab=find');
    }
  }));

  router.post('/clients/leads/:id/status', (req, res, next) => {
    try {
      const action = req.body?.action;
      if (!['replied', 'not_interested'].includes(action)) throw new ValidationError('Choose what happened with this lead.', { action: 'Choose replied or not_interested.' });
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) throw new NotFoundError();
      updateLeadStatus(deps(), id, action);
      return wantsJson(req) ? res.json({ ok: true }) : res.redirect(303, '/owner/clients?tab=find&n=lead_updated');
    } catch (err) {
      return fail(req, res, err, next, '/owner/clients?tab=find');
    }
  });

  // ---- Draft ----------------------------------------------------------------------------------
  router.post('/clients/draft', wrap(async (req, res, next) => {
    const back = `/owner/clients?tab=${req.body?.tab === 'find' ? 'find' : req.body?.type === 'lead' ? 'leads' : 'reconnect'}`;
    try {
      const parsed = subjectSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw new ValidationError('Choose a person from the list.', flatErrors(parsed.error));
      const draft = await createDraft(deps(), parsed.data);
      if (wantsJson(req)) return res.status(201).json({ draftId: draft.id, channel: draft.channel, message: draft.message, source: draft.source });
      return res.redirect(303, `/owner/clients/drafts/${draft.id}`);
    } catch (err) {
      return fail(req, res, err, next, back);
    }
  }));

  function renderDraft(req, res, status = 200, over = {}) {
    const id = Number(req.params.id);
    const draft = Number.isInteger(id) ? repos.outreach.get(id) : null;
    if (!draft) return notFound(req, res);
    return res.status(status).render('pages/owner-draft', {
      businessName: businessName(), csrfToken: res.locals.csrfToken, draft, notice: notice(req), error: null, text: null, active: 'clients', ...over,
    });
  }
  router.get('/clients/drafts/:id', (req, res) => renderDraft(req, res));

  // ---- Approve & send -------------------------------------------------------------------------
  router.post('/clients/drafts/:id/send', wrap(async (req, res, next) => {
    const id = Number(req.params.id);
    const back = `/owner/clients/drafts/${id}`;
    try {
      const parsed = sendSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        const fields = flatErrors(parsed.error);
        if (wantsJson(req)) return res.status(400).json(errorBody('validation_error', 'Please check the message.', fields));
        return renderDraft(req, res, 400, { error: fields.message, text: req.body?.message ?? '' });
      }
      const result = await sendDraft(deps(), id, parsed.data.message);
      if (wantsJson(req)) return res.json(result);
      if (result.channel === 'whatsapp') return res.redirect(302, result.url);
      return res.redirect(303, `${back}?n=${result.status === 'sent' ? 'sent' : 'send_failed'}`);
    } catch (err) {
      if (err instanceof ValidationError && !wantsJson(req)) return renderDraft(req, res, 400, { error: err.message, text: req.body?.message ?? '' });
      return fail(req, res, err, next, back);
    }
  }));

  // ---- Do not contact -------------------------------------------------------------------------
  router.post('/clients/dnc', (req, res, next) => {
    const back = `/owner/clients?tab=${req.body?.type === 'lead' ? 'leads' : 'reconnect'}`;
    try {
      const parsed = subjectSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw new ValidationError('Choose a person from the list.', flatErrors(parsed.error));
      markDoNotContact(deps(), parsed.data);
      return wantsJson(req) ? res.json({ ok: true }) : res.redirect(303, `${back}&n=dnc_done`);
    } catch (err) {
      return fail(req, res, err, next, back);
    }
  });

  return router;
}
