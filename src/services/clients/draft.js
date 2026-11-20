// Draft one outreach message with Claude (Haiku) from facts we hold. The model never sees contact
// details, surnames, prices or the quote. Whatever it returns is cleaned (links and amounts stripped)
// and validated before the owner sees it; if it keeps failing, the standard template is used.
import fs from 'node:fs';
import { computeCostUsd } from '../../ai/cost.js';
import { aiBudgetBlock } from '../tenants/limits.js';
import { formatDate } from '../../util/formatDate.js';
import { templateDraft } from './template.js';

export const MAX_WORDS = 80;
const system = fs.readFileSync(new URL('../../../prompts/outreach.md', import.meta.url), 'utf8');

export const DRAFT_TOOL = {
  name: 'draft_message',
  description: 'Return the finished message text. Plain text, under 80 words, no links, no prices.',
  input_schema: {
    type: 'object',
    properties: { message: { type: 'string', description: 'The message, plain text' } },
    required: ['message'],
  },
};

// ---- Cleaning and validation (the output validator) -------------------------------------------
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|in|co|net|org|io|app|me|ly|xyz|info)\b(?:\/\S*)?/gi;
const AMOUNT_RE = /(?:[₹$€£]|\b(?:rs\.?|inr|usd)\s*)\s*\d[\d,]*(?:\.\d+)?(?:\s*(?:k|lakhs?|crores?))?|\b\d[\d,]*(?:\.\d+)?\s*(?:rs\.?|inr|rupees?|bucks)\b/gi;
const PRICE_WORDS = /\b(?:price[sd]?|pricing|costs?|discounts?|cheap\w*|free|complimentary|deals?|offers?|rupees?|rs|inr)\b|[₹$€£]|\d\s*%|\bpercent\b/i;

/** Remove links and currency amounts. Returns the cleaned text and what was removed. */
export function sanitizeDraft(text) {
  const stripped = [];
  let out = String(text ?? '');
  out = out.replace(URL_RE, () => { stripped.push('link'); return ''; });
  out = out.replace(AMOUNT_RE, () => { stripped.push('amount'); return ''; });
  out = out.replace(/[ \t]+/g, ' ').replace(/ +([,.!?])/g, '$1').replace(/\n{3,}/g, '\n\n').trim();
  return { text: out, stripped };
}

const wordCount = (s) => s.trim().split(/\s+/).filter(Boolean).length;

/** Problems left after cleaning. Empty list = acceptable. */
export function draftIssues(text, facts) {
  const issues = [];
  if (!text || wordCount(text) < 5) issues.push('the message is empty or too short');
  if (wordCount(text) > MAX_WORDS) issues.push(`it has more than ${MAX_WORDS} words`);
  if (!new RegExp(`\\b${facts.first_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) issues.push(`it must greet ${facts.first_name} by first name`);
  if (PRICE_WORDS.test(text)) issues.push('it mentions prices, costs, discounts or offers, which is never allowed');
  const allowed = new Set(JSON.stringify(facts).match(/\d+/g) ?? []);
  const invented = (text.match(/\d+/g) ?? []).filter((d) => !allowed.has(d));
  if (invented.length) issues.push(`it contains numbers that are not in the facts (${invented.join(', ')})`);
  return issues;
}

// ---- Facts -----------------------------------------------------------------------------------
/** What Claude is told. First name only; no email, phone, surname, price or quote link. */
export function factsFor(subject, business) {
  const facts = { first_name: subject.name.trim().split(/\s+/)[0], business_name: business.businessName };
  if (subject.type === 'lead' && subject.organisation) {
    // An organisation found on the web: greet the team, not a person.
    facts.first_name = 'team';
    facts.organisation = subject.name;
    facts.who_they_are = subject.note || 'a local organisation';
    facts.reason = 'new organisation the owner would like to reach';
    return facts;
  }
  if (subject.type === 'lead') {
    facts.who_they_are = subject.note || 'a new contact';
    facts.reason = 'new contact the owner would like to reach';
    return facts;
  }
  if (subject.service) facts.last_service = subject.service;
  if (subject.eventType) facts.event_type = subject.eventType;
  if (subject.eventDate) facts.event_date = formatDate(subject.eventDate);
  facts.outcome = subject.outcome.label;
  facts.reason = subject.reason.text;
  return facts;
}

const wrap = (facts) => `<facts>${JSON.stringify(facts).replaceAll('</facts>', '[/facts]')}</facts>`;

function logCall({ repos, config, now }, resp, latencyMs, err) {
  const usage = resp?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  repos.aiCalls.create({
    enquiryId: null, purpose: 'outreach', model: resp?.model ?? config.ai.modelOutreach,
    inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite,
    costUsd: computeCostUsd(usage, config.ai.prices), latencyMs, ok: !err,
    error: err ? String(err.status ?? err.code ?? err.name).slice(0, 100) : null, // a code only, never a message
  }, now());
}

/**
 * Write the message body. Returns { text, source: 'ai' | 'template', attempts, stripped }.
 * Two tries with Claude (the second tells it what was wrong); then the standard template.
 */
export async function generateDraft(deps, facts) {
  const { repos, config, ai } = deps;
  const now = deps.now ?? (() => new Date());
  const fallback = (attempts, stripped) => ({ text: templateDraft(facts), source: 'template', attempts, stripped });
  if (!config.aiEnabled || !ai || aiBudgetBlock(repos, config, now())) return fallback(0, []);

  const businessName = facts.business_name;
  const sys = [{ type: 'text', text: system.replaceAll('{{business_name}}', businessName), cache_control: { type: 'ephemeral' } }];
  const messages = [{ role: 'user', content: `Write the message.\n${wrap(facts)}` }];
  const stripped = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let resp;
    const t0 = Date.now();
    try {
      resp = await ai.createMessage({
        purpose: 'outreach', system: sys, tools: [DRAFT_TOOL], messages, maxTokens: 300,
        toolChoice: { type: 'tool', name: DRAFT_TOOL.name },
      });
      logCall({ repos, config, now }, resp, Date.now() - t0, null);
    } catch (err) {
      logCall({ repos, config, now }, null, Date.now() - t0, err);
      return fallback(attempt, stripped);
    }
    const use = resp.content.find((b) => b.type === 'tool_use' && b.name === DRAFT_TOOL.name);
    const clean = sanitizeDraft(typeof use?.input?.message === 'string' ? use.input.message : '');
    stripped.push(...clean.stripped);
    const issues = draftIssues(clean.text, facts);
    if (!issues.length) return { text: clean.text, source: 'ai', attempts: attempt, stripped };
    if (attempt === 2 || !use) break;
    messages.push({ role: 'assistant', content: resp.content });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, is_error: true, content: `Rewrite it: ${issues.join('; ')}.` }] });
  }
  return fallback(2, stripped);
}
