// Live eval (TestCases §4): runs tests/cases/*.json through the REAL agent. Costs API credits.
// Run with `npm run eval`, only after a prompt or model change. Never prints the API key.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createRepos } from '../src/container.js';
import { seed } from '../src/seed.js';
import { createClaudeClient } from '../src/ai/claudeClient.js';
import { startEnquiry, replyToEnquiry, presentResult } from '../src/services/enquiries/enquiryService.js';
import { factsFor, generateDraft, MAX_WORDS } from '../src/services/clients/draft.js';

const casesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cases');
const FIXED_NOW = new Date('2026-11-20T10:00:00Z'); // so "12 Dec" always means 2026
const PRICE_TEXT = /₹|\brs\.?\s*\d|\binr\b|\$\s*\d|\btotal\b|\bprice\b/i;

let config;
try {
  config = loadConfig({ ...process.env, AI_MODE: 'live', AI_ENABLED: 'true', NODE_ENV: 'development' });
} catch (err) {
  console.error(err.message); // names the variable, never its value
  process.exit(2);
}

const same = (a, b) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());

function checkRequirements(want, got, label, fails) {
  for (const [k, v] of Object.entries(want ?? {})) {
    const ok = Array.isArray(v) ? same(v, got?.[k]) : got?.[k] === v;
    if (!ok) fails.push(`${label} ${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got?.[k])}`);
  }
}

async function runCase(c) {
  const repos = createRepos();
  seed(repos);
  const ai = createClaudeClient({ apiKey: config.anthropicApiKey, models: { intake: config.ai.modelIntake, outreach: config.ai.modelOutreach } });
  const deps = { repos, ai, config, now: () => FIXED_NOW };
  const steps = [];
  const shown = []; // everything the customer would see
  const record = (enquiry, result) => {
    steps.push({
      outcome: result.outcome,
      question: result.question ?? '',
      missing: enquiry.missingFieldsJson ?? [],
      requirements: enquiry.requirementsJson ?? {},
    });
    shown.push(JSON.stringify(presentResult(repos, enquiry, result)));
  };

  let { enquiry, result } = await startEnquiry(deps, {
    name: 'Eval Customer', channel: 'email', email: 'eval@example.test', description: c.turns[0],
  });
  record(enquiry, result);
  for (let i = 1; result.outcome === 'needs_info' && i < c.turns.length; i += 1) {
    ({ enquiry, result } = await replyToEnquiry(deps, enquiry.publicId, c.turns[i]));
    record(enquiry, result);
  }

  const e = c.expect;
  const fails = [];
  const first = steps[0];
  const last = steps.at(-1);
  if (e.first) {
    if (first.outcome !== e.first.outcome) fails.push(`first outcome: expected ${e.first.outcome}, got ${first.outcome}`);
    if (e.first.missing && !same(e.first.missing, first.missing)) {
      fails.push(`first missing: expected ${JSON.stringify(e.first.missing)}, got ${JSON.stringify(first.missing)}`);
    }
    checkRequirements(e.first.requirements, first.requirements, 'first', fails);
    for (const word of e.first.questionIncludes ?? []) {
      if (!first.question.includes(word)) fails.push(`question should mention "${word}": "${first.question}"`);
    }
  }
  if (e.final) {
    if (last.outcome !== e.final.outcome) fails.push(`final outcome: expected ${e.final.outcome}, got ${last.outcome}`);
    checkRequirements(e.final.requirements, last.requirements, 'final', fails);
  }
  if (e.questions !== undefined) {
    const asked = steps.filter((s) => s.outcome === 'needs_info').length;
    if (asked !== e.questions) fails.push(`questions asked: expected ${e.questions}, got ${asked}`);
  }
  const [est] = repos.estimates.listByEnquiry(enquiry.id);
  if (e.noEstimate && est) fails.push('an estimate was created');
  if (e.total !== undefined && est?.total !== e.total) fails.push(`server total: expected ${e.total}, got ${est?.total}`);
  if (e.noDiscount) {
    if (est?.lineItemsJson.some((l) => l.kind === 'discount')) fails.push('estimate has a discount line');
    // Customer-facing question: no mention at all. Owner summary: may report the request, must not promise it.
    const DISCOUNT = /discount|\d+\s*%/i;
    const NEGATED = /\b(not|no|never|declin\w*|unable|cannot|ignor\w*|refus\w*)\b|n't/i;
    const asked = steps.map((s) => s.question).join(' ');
    const summary = enquiry.summaryForOwner ?? '';
    if (DISCOUNT.test(asked)) fails.push(`question mentions a discount: "${asked}"`);
    if (DISCOUNT.test(summary) && !NEGATED.test(summary)) fails.push(`summary may promise a discount: "${summary}"`);
  }
  const used = repos.enquiries.get(enquiry.id).aiRequestsUsed;
  if (used > 4) fails.push(`${used} requests (max 4)`);
  if (steps.some((s) => s.outcome === 'fallback')) fails.push('went to the fallback form');
  if (shown.some((s) => PRICE_TEXT.test(s))) fails.push('customer-facing text mentions a price');

  const rows = repos.aiCalls.listByEnquiry(enquiry.id);
  const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
  return {
    id: c.id,
    name: c.name,
    fails,
    used,
    steps,
    tokens: { input: sum('inputTokens'), output: sum('outputTokens'), cacheRead: sum('cacheReadTokens'), cacheWrite: sum('cacheWriteTokens') },
    cost: sum('costUsd'),
    apiErrors: rows.filter((r) => !r.ok).map((r) => r.error),
  };
}

// ---- Client Finder draft cases (D01-D03): quality of the outreach message --------------------------
const NO_PRICES = /₹|\brs\.?\s*\d|\binr\b|\$\s*\d|\d\s*%|\b(?:price[sd]?|pricing|costs?|discounts?|cheap\w*|free|complimentary|deals?|offers?|rupees?)\b/i;
const INVENTED_CLAIMS = /\b(?:years?|awards?|reviews?|rated|testimonials?|ratings?|stars?)\b/i;
const EVENT_WORDS = ['wedding', 'birthday', 'anniversary', 'housewarming', 'engagement', 'baby shower', 'farewell', 'festival', 'diwali'];

async function runDraftCase(c) {
  const repos = createRepos();
  seed(repos);
  const ai = createClaudeClient({ apiKey: config.anthropicApiKey, models: { intake: config.ai.modelIntake, outreach: config.ai.modelOutreach } });
  const facts = factsFor(c.subject, repos.businessSettings.get());
  const result = await generateDraft({ repos, ai, config, now: () => FIXED_NOW }, facts);
  const text = result.text;
  const lower = text.toLowerCase();
  const fails = [];
  if (result.source !== 'ai') fails.push('the model draft was rejected twice (standard template used)');
  const words = text.trim().split(/\s+/).length;
  if (words >= MAX_WORDS) fails.push(`${words} words (max ${MAX_WORDS - 1})`);
  if (!new RegExp(`\\b${facts.first_name}\\b`, 'i').test(text)) fails.push(`does not use the first name ${facts.first_name}`);
  if (NO_PRICES.test(text)) fails.push('mentions a price, discount or offer');
  if (/https?:|www\./i.test(text)) fails.push('contains a link');
  if (INVENTED_CLAIMS.test(text)) fails.push('claims years, awards, reviews or ratings that are not in the facts');
  const allowed = new Set(JSON.stringify(facts).match(/\d+/g) ?? []);
  const invented = (text.match(/\d+/g) ?? []).filter((d) => !allowed.has(d));
  if (invented.length) fails.push(`numbers that are not in the facts: ${invented.join(', ')}`);
  // (?<!non[- ]) so "veg buffet" is not found inside the customer's own "non-veg buffet"
  for (const s of c.otherServices ?? []) if (new RegExp(`(?<!non[- ])${s.replace(/[-]/g, '[- ]')}`, 'i').test(lower)) fails.push(`mentions a service that is not in the facts: "${s}"`);
  for (const w of EVENT_WORDS) if (lower.includes(w) && !(facts.event_type ?? '').includes(w)) fails.push(`mentions an event type that is not in the facts: "${w}"`);

  // Only this case's own calls: the seed adds demo ai_calls rows that must not be counted.
  const rows = repos.aiCalls.all().filter((r) => r.purpose === 'outreach');
  const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
  return {
    id: c.id, name: c.name, fails, text, words, attempts: result.attempts, used: rows.length,
    tokens: { input: sum('inputTokens'), output: sum('outputTokens'), cacheRead: sum('cacheReadTokens'), cacheWrite: sum('cacheWriteTokens') },
    cost: sum('costUsd'),
  };
}

const files = fs.readdirSync(casesDir).filter((f) => /^E\d+\.json$/.test(f)).sort();
const results = [];
for (const f of files) {
  const c = JSON.parse(fs.readFileSync(path.join(casesDir, f), 'utf8'));
  let r;
  try {
    r = await runCase(c);
  } catch (err) {
    r = {
      id: c.id, name: c.name, fails: [`crashed: ${err?.status ?? err?.code ?? err?.name}`], used: 0, steps: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, apiErrors: [],
    };
  }
  results.push(r);
  console.log(`${r.fails.length ? 'FAIL' : 'PASS'}  ${r.id} ${r.name}  [${r.steps.map((s) => s.outcome).join(' > ')}]  requests ${r.used}`);
  for (const x of r.fails) console.log(`        - ${x}`);
  if (r.apiErrors.length) console.log(`        - API errors: ${r.apiErrors.join(', ')}`);
  for (const s of r.steps) if (s.question) console.log(`        Q: ${s.question}`);
}

const drafts = [];
for (const f of fs.readdirSync(casesDir).filter((x) => /^D\d+\.json$/.test(x)).sort()) {
  const c = JSON.parse(fs.readFileSync(path.join(casesDir, f), 'utf8'));
  let r;
  try {
    r = await runDraftCase(c);
  } catch (err) {
    r = { id: c.id, name: c.name, fails: [`crashed: ${err?.status ?? err?.code ?? err?.name}`], text: '', words: 0, attempts: 0, used: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 };
  }
  drafts.push(r);
  console.log(`${r.fails.length ? 'FAIL' : 'PASS'}  ${r.id} ${r.name}  [${r.words} words, ${r.attempts} request${r.attempts === 1 ? '' : 's'}]`);
  for (const x of r.fails) console.log(`        - ${x}`);
  if (r.text) console.log(`        > ${r.text.replace(/\n+/g, ' ')}`);
}

const core = results.filter((r) => Number(r.id.slice(1)) <= 10);
const passed = core.filter((r) => !r.fails.length).length;
const must = ['E08', 'E10'].every((id) => results.find((r) => r.id === id)?.fails.length === 0);
const all = [...results, ...drafts];
const tot = (k) => all.reduce((n, r) => n + r.tokens[k], 0);
const cost = all.reduce((n, r) => n + r.cost, 0);
const priced = Object.values(config.ai.prices).some((p) => p > 0);

console.log('\n--- Summary ---');
console.log(`E01-E10: ${passed}/10 passed (bar: 9, with E08 and E10)  E08+E10: ${must ? 'pass' : 'FAIL'}`);
for (const r of results.filter((x) => Number(x.id.slice(1)) > 10)) console.log(`${r.id}: ${r.fails.length ? 'FAIL' : 'pass'}`);
console.log(`Drafts D01-D03: ${drafts.filter((r) => !r.fails.length).length}/${drafts.length} passed`);
console.log(`Requests: ${all.reduce((n, r) => n + r.used, 0)} (max per case ${Math.max(...all.map((r) => r.used))})`);
console.log(`Tokens: input ${tot('input')}, output ${tot('output')}, cache read ${tot('cacheRead')}, cache write ${tot('cacheWrite')}`);
console.log(priced ? `Cost: $${cost.toFixed(4)} (model ${config.ai.modelIntake})` : 'Cost: not computed (set the AI_PRICE_* variables in .env)');
process.exit(passed >= 9 && must && drafts.every((r) => !r.fails.length) ? 0 : 1);
