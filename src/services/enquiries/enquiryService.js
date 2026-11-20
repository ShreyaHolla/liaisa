// Enquiry use cases: start, reply, fallback form. Routes stay thin; the agent loop is in services/agent.
import { ConflictError, NotFoundError, ValidationError } from '../../errors.js';
import { calculateEstimate } from '../pricing/calculateEstimate.js';
import { createEstimate } from '../estimates/createEstimate.js';
import { runTurn, todayIST } from '../agent/runTurn.js';
import { normaliseRequirements } from '../agent/areas.js';
import { unitNoun } from '../../util/format.js';
import { notifyOwner } from '../quotes/mail.js';
import { ownerReadyEmail } from '../quotes/messages.js';

const clock = (deps) => (deps.now ?? (() => new Date()))();

function findOrFail(repos, publicId) {
  const enquiry = repos.enquiries.getByPublicId(publicId);
  if (!enquiry) throw new NotFoundError("We couldn't find that enquiry.");
  return enquiry;
}

/** Tell the owner an enquiry is ready for approval. Fire and forget: SMTP never slows or fails the customer's request. */
function announceReady(deps, enquiryId) {
  if (!deps.mailer) return;
  const enquiry = deps.repos.enquiries.get(enquiryId);
  const pricing = deps.repos.pricingConfigs.latestApproved().configJson;
  notifyOwner(deps, enquiryId, ownerReadyEmail({ config: deps.config, enquiry, pricing })).catch(() => {});
}

export async function startEnquiry(deps, input) {
  const { repos } = deps;
  const created = repos.enquiries.create(
    {
      customerName: input.name,
      customerEmail: input.email ?? null,
      customerPhone: input.phone ?? null,
      preferredChannel: input.channel,
      rawText: input.description,
      status: 'collecting',
      source: 'ai',
    },
    clock(deps),
  );
  const result = await runTurn(deps, created.id, input.description);
  if (result.outcome === 'ready') announceReady(deps, created.id);
  return { enquiry: repos.enquiries.get(created.id), result };
}

export async function replyToEnquiry(deps, publicId, answer) {
  const { repos } = deps;
  const found = findOrFail(repos, publicId);
  if (found.status !== 'collecting') throw new ConflictError('This enquiry has already moved on.');
  const result = await runTurn(deps, found.id, answer);
  if (result.outcome === 'ready') announceReady(deps, found.id);
  return { enquiry: repos.enquiries.get(found.id), result };
}

const FIELD_FOR = [[/service/i, 'service_id'], [/add-?on/i, 'addon_ids'], [/date/i, 'event_date'], [/quantity/i, 'quantity'], [/distance/i, 'distance_km']];

/** Fallback form (F10). All required fields present → draft estimate and awaiting_approval; else needs_owner. */
export function submitForm(deps, publicId, reqs) {
  const { repos } = deps;
  const found = findOrFail(repos, publicId);
  if (found.status !== 'collecting' && found.status !== 'needs_owner') {
    throw new ConflictError('This enquiry has already moved on.');
  }
  const pricing = repos.pricingConfigs.latestApproved().configJson;
  const requirements = normaliseRequirements(pricing, Object.fromEntries(Object.entries(reqs).filter(([, v]) => v !== undefined)));

  try {
    calculateEstimate(pricing, requirements); // validates service, add-ons and date; result unused here
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    const field = FIELD_FOR.find(([re]) => re.test(err.message))?.[1] ?? '_form';
    throw new ValidationError('Please check the highlighted fields.', { [field]: err.message });
  }

  if (requirements.event_date && requirements.event_date < todayIST(new Date(clock(deps)))) {
    throw new ValidationError('Please check the highlighted fields.', { event_date: 'That date has already passed. Choose a date from today on.' });
  }
  const missing = pricing.required_fields.filter((f) => requirements[f] === undefined);
  repos.enquiries.update(found.id, {
    source: 'form',
    status: 'needs_owner',
    requirementsJson: requirements,
    missingFieldsJson: missing,
    summaryForOwner: 'Customer filled in the structured form.',
  });
  if (missing.length === 0) {
    createEstimate(repos, found.id, { now: clock(deps) });
    repos.enquiries.update(found.id, { status: 'awaiting_approval' });
    announceReady(deps, found.id);
  }
  return { enquiry: repos.enquiries.get(found.id), result: { outcome: missing.length ? 'needs_owner' : 'ready' } };
}

/** What we understood, in words. Never contains a price. */
export function understoodOf(repos, requirements = {}) {
  const pricing = repos.pricingConfigs.latestApproved().configJson;
  const out = {};
  const service = pricing.services.find((s) => s.id === requirements.service_id);
  if (service) {
    out.serviceName = service.name;
    out.unitNoun = unitNoun(service);
  }
  if (Number.isInteger(requirements.quantity)) out.quantity = requirements.quantity;
  if (requirements.event_date) out.eventDate = requirements.event_date;
  if (requirements.location) out.location = requirements.location;
  out.addonNames = (requirements.addon_ids ?? []).map((id) => pricing.addons.find((a) => a.id === id)?.name).filter(Boolean);
  return out;
}

/** AgentTurnResponse (openapi): never contains prices or contact details. */
export function presentResult(repos, enquiry, result) {
  const body = { publicId: enquiry.publicId, outcome: result.outcome };
  if (result.question) body.question = result.question;
  if (result.message) body.message = result.message;
  if (result.outcome === 'fallback') body.prefill = result.prefill ?? {};
  if (result.outcome === 'ready') {
    body.understood = understoodOf(repos, enquiry.requirementsJson);
    body.replyChannel = enquiry.preferredChannel;
  }
  return body;
}
