// Scripted AI client for AI_MODE=mock, dev and tests. Same interface as claudeClient. Costs nothing.
//   createMockClient({ steps })  each createMessage call consumes the next step
//   createMockClient()           "auto": a small keyword-based stand-in so the demo works offline
// A step is a response, a function (request) => response, or { error }. `calls` records requests.

import { formatDate } from '../util/formatDate.js';
import { templateDraft } from '../services/clients/template.js';

let seq = 0;
const toolUse = (name, input) => ({
  content: [{ type: 'tool_use', id: `toolu_mock_${++seq}`, name, input }],
  stopReason: 'tool_use',
});

export const step = {
  calc: (input) => toolUse('calculate_estimate', input),
  finish: (input) => toolUse('finish_intake', input),
  draft: (message) => toolUse('draft_message', { message }),
  error: (status = 500) => ({ error: Object.assign(new Error(`mock API error ${status}`), { status }) }),
};

export const REQ_READY = { service_id: 'veg_buffet', quantity: 40, event_date: '2026-12-13', location: 'Koramangala' };
const finishReady = (r) =>
  step.finish({ status: 'ready', requirements: r, missing_fields: [], summary_for_owner: 'Veg buffet for 40 guests on 13 Dec in Koramangala.' });

/** Scenario keys from ARCHITECTURE §7.4. Each returns the steps for one agent turn. */
export const scenarios = {
  ready: (r = REQ_READY) => [step.calc(r), finishReady(r)],
  needs_info: () => [
    step.finish({
      status: 'needs_info',
      requirements: { service_id: 'veg_buffet', quantity: 40 },
      missing_fields: ['event_date', 'location'],
      question_to_customer: 'Lovely! Which date is it, and which area?',
      summary_for_owner: 'Veg buffet for about 40 guests. Date and area still needed.',
    }),
  ],
  out_of_scope: () => [
    step.finish({ status: 'out_of_scope', requirements: {}, missing_fields: [], summary_for_owner: 'Asked for something the business does not offer.' }),
  ],
  invalid_json: () => [step.finish({ status: 'bogus' })],
  api_error: () => [step.error(500)],
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const LABELS = { service_id: 'service', quantity: 'number of guests', event_date: 'date', location: 'area' };

function extract(text, cat, today) {
  const t = text.toLowerCase().replace(/non[\s-]?veg/g, 'nonveg');
  const ids = new Set(cat.services.map((s) => s.id));
  const guess = /nonveg/.test(t) ? 'nonveg_buffet' : /\bveg/.test(t) ? 'veg_buffet' : /dosa|live counter/.test(t) ? 'live_counter' : null;
  const out = {};
  if (guess && ids.has(guess)) out.service_id = guess;

  let rest = t;
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(rest);
  const dm = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS.join('|')})`).exec(rest);
  if (iso) {
    out.event_date = iso[1];
    rest = rest.replace(iso[0], ' ');
  } else if (dm) {
    // The year is today's: a date that has passed stays in the past, and the server asks again.
    const year = Number(today.split('-')[0]);
    const mo = MONTHS.indexOf(dm[2]) + 1;
    const day = Number(dm[1]);
    out.event_date = `${year}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    rest = rest.replace(dm[0], ' ');
  }
  const q = /\b(\d{1,4})\b/.exec(rest);
  if (q) out.quantity = Number(q[1]);
  const area = cat.areas.find((a) => t.includes(a.toLowerCase()));
  if (area) out.location = area;
  return out;
}

function playback(r, cat) {
  const name = cat.services.find((x) => x.id === r.service_id)?.name ?? 'Your enquiry';
  const parts = [r.quantity ? `for ${r.quantity}` : '', r.event_date ? `on ${formatDate(r.event_date)}` : '', r.location ? `in ${r.location}` : ''];
  return [name, ...parts].filter(Boolean).join(' ');
}

/** Client Finder draft: deterministic, built from the <facts> in the prompt. No randomness, no prices. */
function outreachStep(req) {
  const last = req.messages.at(-1);
  const content = typeof last.content === 'string' ? last.content : '';
  const facts = JSON.parse(/<facts>([\s\S]*?)<\/facts>/.exec(content)[1]);
  return step.draft(templateDraft(facts));
}

function autoStep(req) {
  if (req.purpose === 'outreach') return outreachStep(req);
  const sys = req.system.map((b) => b.text).join('\n');
  const cat = JSON.parse(/<catalogue>([\s\S]*?)<\/catalogue>/.exec(sys)[1]);
  const users = req.messages.filter((m) => m.role === 'user' && typeof m.content === 'string').map((m) => m.content);
  const text = users.flatMap((c) => [...c.matchAll(/<customer_message>([\s\S]*?)<\/customer_message>/g)].map((m) => m[1])).join(' \n ');
  const today = /<today>(\d{4}-\d{2}-\d{2})<\/today>/.exec(users[0] ?? '')?.[1] ?? '2026-01-01';
  const r = extract(text, cat, today);

  if (!r.service_id) return scenarios.out_of_scope()[0];
  const missing = cat.required_fields.filter((f) => r[f] === undefined);
  if (missing.length) {
    const words = missing.map((f) => LABELS[f] ?? f);
    return step.finish({
      status: 'needs_info',
      requirements: r,
      missing_fields: missing,
      question_to_customer: `${playback(r, cat)}, lovely! Could you tell us the ${words.join(' and the ')}?`,
      summary_for_owner: `Enquiry understood so far. Still needed: ${words.join(', ')}.`,
    });
  }
  const last = req.messages.at(-1);
  if (Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result')) return finishReady(r);
  return step.calc(r);
}

export function createMockClient({ steps, model = 'mock-intake' } = {}) {
  const queue = steps ? steps.flat() : null;
  const calls = [];
  return {
    calls,
    async createMessage(req) {
      calls.push(structuredClone(req));
      let s;
      if (queue) {
        if (queue.length === 0) throw new Error('mock script exhausted');
        s = queue.shift();
        if (typeof s === 'function') s = s(req);
      } else {
        s = autoStep(req);
      }
      if (s.error) throw s.error;
      return { model, usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 }, ...s };
    },
  };
}
