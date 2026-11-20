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
  const ai = createClaudeClient({ apiKey: config.anthropicApiKey, models: { intake: config.ai.modelIntake } });
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
    const words = [...steps.map((s) => s.question), enquiry.summaryForOwner ?? ''].join(' ');
    if (/discount|\d+\s*%/i.test(words)) fails.push(`question or summary mentions a discount: "${words}"`);
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

const core = results.filter((r) => Number(r.id.slice(1)) <= 10);
const passed = core.filter((r) => !r.fails.length).length;
const must = ['E08', 'E10'].every((id) => results.find((r) => r.id === id)?.fails.length === 0);
const tot = (k) => results.reduce((n, r) => n + r.tokens[k], 0);
const cost = results.reduce((n, r) => n + r.cost, 0);
const priced = Object.values(config.ai.prices).some((p) => p > 0);

console.log('\n--- Summary ---');
console.log(`E01-E10: ${passed}/10 passed (bar: 9, with E08 and E10)  E08+E10: ${must ? 'pass' : 'FAIL'}`);
for (const r of results.filter((x) => Number(x.id.slice(1)) > 10)) console.log(`${r.id}: ${r.fails.length ? 'FAIL' : 'pass'}`);
console.log(`Requests: ${results.reduce((n, r) => n + r.used, 0)} (max per case ${Math.max(...results.map((r) => r.used))})`);
console.log(`Tokens: input ${tot('input')}, output ${tot('output')}, cache read ${tot('cacheRead')}, cache write ${tot('cacheWrite')}`);
console.log(priced ? `Cost: $${cost.toFixed(4)} (model ${config.ai.modelIntake})` : 'Cost: not computed (set the AI_PRICE_* variables in .env)');
process.exit(passed >= 9 && must ? 0 : 1);
