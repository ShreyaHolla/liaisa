// The agent loop (PRD §6.4). One call = one customer turn.
// Claude only talks through tools. The server validates everything, recomputes the estimate
// from the approved rate card, and never trusts a number or price from the model.
import { RESTING_TEXT } from '../tenants/limits.js';
import { ValidationError } from '../../errors.js';
import { computeCostUsd } from '../../ai/cost.js';
import { calculateEstimate } from '../pricing/calculateEstimate.js';
import { createEstimate } from '../estimates/createEstimate.js';
import { checkGuards, canAskQuestion, MAX_QUESTIONS } from './guards.js';
import { missingFields, normaliseRequirements } from './areas.js';
import { buildRequest } from './promptBuilder.js';
import { formatDate } from '../../util/formatDate.js';
import { finishSchema, cleanRequirements, salvageRequirements } from './tools.js';

const PRICE_WORDS = /₹|\brs\.?\s*\d|\binr\b|\$\s*\d/i;
const OUT_OF_SCOPE_TEXT = (name) => `Thanks for asking. This one isn't something ${name} offers, so we can't quote it.`;

/** Validate a finish_intake input. Returns { data } or { error } (error text goes back to the model). */
/** Today's calendar date in India (the business's timezone), as YYYY-MM-DD. */
export const todayIST = (now) => new Date(now.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ASK_FOR = { service_id: 'which service', quantity: 'how many', location: 'which area' };

/** A past date is never kept or moved to another year: ask again (server wording, so it can't be skipped). */
function pastDateQuestion(date, others) {
  const rest = others.filter((f) => f !== 'event_date').map((f) => ASK_FOR[f]).filter(Boolean);
  return `That date, ${formatDate(date)}, has already passed. Which date did you mean?${rest.length ? ` Please also tell us ${rest.join(', ')}.` : ''}`;
}

function evaluateFinish(input, known, pricing, today) {
  const parsed = finishSchema.safeParse(input);
  if (!parsed.success) return { error: `Invalid finish_intake: ${parsed.error.issues[0].path.join('.') || 'input'} ${parsed.error.issues[0].message}` };
  // Merge across turns, snap the location to a configured area, then work out what is missing here, not from the model.
  let requirements = normaliseRequirements(pricing, { ...known, ...cleanRequirements(parsed.data.requirements) });
  let pastDate = null;
  if (ISO_DATE.test(requirements.event_date ?? '') && requirements.event_date < today) {
    pastDate = requirements.event_date;
    const { event_date: _dropped, ...rest } = requirements;
    requirements = rest;
  }
  const missing = missingFields(pricing, requirements);
  if (pastDate) {
    return { data: { ...parsed.data, status: 'needs_info', requirements, missing_fields: missing, question_to_customer: pastDateQuestion(pastDate, missing) } };
  }
  const data = { ...parsed.data, requirements, missing_fields: parsed.data.status === 'needs_info' ? missing : [] };

  if (data.question_to_customer && PRICE_WORDS.test(data.question_to_customer)) return { error: 'Never mention prices to the customer' };
  if (data.status === 'needs_info') {
    if (!data.question_to_customer) return { error: 'question_to_customer is required for needs_info' };
    if (missing.length === 0) return { error: 'Every required detail is already known. Call calculate_estimate, then finish_intake with status ready.' };
    const wrong = parsed.data.missing_fields.filter((f) => !missing.includes(f));
    if (wrong.length) return { error: `missing_fields lists details already known (${wrong.join(', ')}). Only ask for: ${missing.join(', ')}.` };
  }
  if (data.status === 'ready') {
    if (missing.length) return { error: `Not ready: still missing ${missing.join(', ')}` };
    try {
      calculateEstimate(pricing, data.requirements);
    } catch (err) {
      if (err instanceof ValidationError) return { error: `Cannot price these requirements: ${err.message}` };
      throw err;
    }
  }
  return { data };
}

function runCalc(pricing, input) {
  try {
    const { lineItems, total, warnings } = calculateEstimate(pricing, input);
    return { content: JSON.stringify({ lineItems, total, warnings }) };
  } catch (err) {
    if (err instanceof ValidationError) return { content: err.message, is_error: true };
    throw err;
  }
}

/**
 * @param {{ repos, ai, config, now?: () => Date }} deps
 * @returns {{ outcome: 'needs_info'|'ready'|'out_of_scope'|'fallback', question?, message?, prefill? }}
 */
export async function runTurn(deps, enquiryId, customerText) {
  const { repos, ai, config } = deps;
  const now = deps.now ?? (() => new Date());
  const pricing = repos.pricingConfigs.latestApproved().configJson;
  const businessName = repos.businessSettings.get()?.businessName ?? 'the business';
  const start = repos.enquiries.get(enquiryId);
  const state = start.aiState ?? { history: [], questionsAsked: 0, requirements: {} };
  const history = [...state.history, { role: 'customer', text: customerText }];
  const turnMessages = [];
  let known = state.requirements ?? {};
  let invalid = 0;
  let apiErrors = 0;

  // `why` is a guard reason. A budget cap (this business's or the whole platform's) gets a friendly line: the form still works.
  const fallback = (why = null) => {
    repos.enquiries.update(enquiryId, {
      status: 'needs_owner',
      requirementsJson: known,
      aiState: { history, questionsAsked: state.questionsAsked, requirements: known },
    });
    return { outcome: 'fallback', prefill: known, ...(['daily_cap', 'global_cap'].includes(why) ? { message: RESTING_TEXT } : {}) };
  };

  const logCall = (resp, latencyMs, err) => {
    const usage = resp?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    repos.aiCalls.create(
      {
        enquiryId, purpose: 'intake', model: resp?.model ?? config.ai.modelIntake,
        inputTokens: usage.input, outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite,
        costUsd: computeCostUsd(usage, config.ai.prices), latencyMs, ok: !err,
        // Error name or HTTP status only: never a message that could echo customer text.
        error: err ? String(err.status ?? err.code ?? err.name).slice(0, 100) : null,
      },
      now(),
    );
  };

  for (;;) {
    const enquiry = repos.enquiries.get(enquiryId);
    const blocked = checkGuards({ config, repos, enquiry, now: now() });
    if (blocked) return fallback(blocked);
    // Count the request BEFORE the call so a crash mid-call still counts (TC-AGT-15).
    repos.enquiries.update(enquiryId, { aiRequestsUsed: enquiry.aiRequestsUsed + 1 });

    const today = todayIST(now());
    const req = buildRequest({
      businessName, pricing, history, known, today, turnMessages,
      missing: missingFields(pricing, known), questionsLeft: MAX_QUESTIONS - state.questionsAsked,
    });
    const t0 = Date.now();
    let resp;
    try {
      resp = await ai.createMessage({ purpose: 'intake', enquiryId, ...req });
      logCall(resp, Date.now() - t0, null);
    } catch (err) {
      logCall(null, Date.now() - t0, err);
      apiErrors += 1;
      if (apiErrors >= 2) return fallback(); // one retry, then the form
      continue;
    }

    const uses = resp.content.filter((b) => b.type === 'tool_use');
    const finish = uses.find((b) => b.name === 'finish_intake');
    let finishError = null;
    if (finish) {
      const result = evaluateFinish(finish.input, known, pricing, today);
      if (result.data) return finalize(result.data);
      finishError = result.error;
      known = normaliseRequirements(pricing, { ...known, ...salvageRequirements(finish.input) });
    } else if (uses.length === 0) {
      finishError = 'Reply with a tool call.';
    }

    if (finishError) {
      invalid += 1;
      if (invalid >= 2) return fallback(); // one retry, then the form
    }
    turnMessages.push({ role: 'assistant', content: resp.content });
    turnMessages.push({
      role: 'user',
      content: uses.length
        ? uses.map((u) => ({
            type: 'tool_result',
            tool_use_id: u.id,
            ...(u.name === 'calculate_estimate' ? runCalc(pricing, u.input) : { content: finishError ?? 'Unknown tool', is_error: true }),
          }))
        : [{ type: 'text', text: finishError }],
    });
  }

  function finalize(data) {
    known = data.requirements;
    const base = { requirementsJson: known, missingFieldsJson: data.missing_fields, summaryForOwner: data.summary_for_owner };

    if (data.status === 'needs_info') {
      if (!canAskQuestion(state)) return fallback(); // max 2 questions (TC-AGT-08)
      const aiState = {
        history: [...history, { role: 'agent', text: data.question_to_customer }],
        questionsAsked: state.questionsAsked + 1,
        requirements: known,
      };
      repos.enquiries.update(enquiryId, { ...base, aiState, status: 'collecting' });
      return { outcome: 'needs_info', question: data.question_to_customer };
    }

    const aiState = { history, questionsAsked: state.questionsAsked, requirements: known };
    if (data.status === 'out_of_scope') {
      repos.enquiries.update(enquiryId, { ...base, aiState, status: 'out_of_scope' });
      return { outcome: 'out_of_scope', message: OUT_OF_SCOPE_TEXT(businessName) };
    }

    // ready: save the requirements, then price them here from the approved config.
    repos.enquiries.update(enquiryId, { ...base, missingFieldsJson: [], aiState });
    createEstimate(repos, enquiryId, { now: now() });
    repos.enquiries.update(enquiryId, { status: 'awaiting_approval' });
    return { outcome: 'ready' };
  }
}
