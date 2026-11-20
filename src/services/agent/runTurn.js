// The agent loop (PRD §6.4). One call = one customer turn.
// Claude only talks through tools. The server validates everything, recomputes the estimate
// from the approved rate card, and never trusts a number or price from the model.
import { ValidationError } from '../../errors.js';
import { computeCostUsd } from '../../ai/cost.js';
import { calculateEstimate } from '../pricing/calculateEstimate.js';
import { createEstimate } from '../estimates/createEstimate.js';
import { checkGuards, canAskQuestion, MAX_QUESTIONS } from './guards.js';
import { missingFields, normaliseRequirements } from './areas.js';
import { buildRequest } from './promptBuilder.js';
import { finishSchema, cleanRequirements, salvageRequirements } from './tools.js';

const PRICE_WORDS = /₹|\brs\.?\s*\d|\binr\b|\$\s*\d/i;
const OUT_OF_SCOPE_TEXT = (name) => `Thanks for asking. This one isn't something ${name} offers, so we can't quote it.`;

/** Validate a finish_intake input. Returns { data } or { error } (error text goes back to the model). */
function evaluateFinish(input, known, pricing) {
  const parsed = finishSchema.safeParse(input);
  if (!parsed.success) return { error: `Invalid finish_intake: ${parsed.error.issues[0].path.join('.') || 'input'} ${parsed.error.issues[0].message}` };
  // Merge across turns, snap the location to a configured area, then work out what is missing here, not from the model.
  const requirements = normaliseRequirements(pricing, { ...known, ...cleanRequirements(parsed.data.requirements) });
  const missing = missingFields(pricing, requirements);
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

  const fallback = () => {
    repos.enquiries.update(enquiryId, {
      status: 'needs_owner',
      requirementsJson: known,
      aiState: { history, questionsAsked: state.questionsAsked, requirements: known },
    });
    return { outcome: 'fallback', prefill: known };
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
    if (checkGuards({ config, repos, enquiry, now: now() })) return fallback();
    // Count the request BEFORE the call so a crash mid-call still counts (TC-AGT-15).
    repos.enquiries.update(enquiryId, { aiRequestsUsed: enquiry.aiRequestsUsed + 1 });

    const today = now().toISOString().slice(0, 10);
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
      const result = evaluateFinish(finish.input, known, pricing);
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
