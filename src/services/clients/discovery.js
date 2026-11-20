// Client Finder "Find clients" (M10b): Claude searches the web through Anthropic's web search server
// tool and submits up to 8 organisations as leads. Claude gets business facts only (service names, areas,
// the city, anonymous counts), never customer names or contact details. The server fetches no pages.
// A lead survives only if its source page was in this response's search results or citations.
import fs from 'node:fs';
import { z } from 'zod';
import { ConflictError } from '../../errors.js';
import { computeCostUsd } from '../../ai/cost.js';
import { dailyCallCount } from '../agent/guards.js';
import { todayIST } from '../agent/runTurn.js';
import { normalisePhone } from '../enquiries/schema.js';
import { sanitizeDraft } from './draft.js';
import { identityOf } from './people.js';

export const MAX_LEADS = 8;
export const MAX_SEARCHES = 5;
export const CACHE_HOURS = 6;
const MAX_REQUESTS = 3; // one search turn, plus pause_turn continuations or one nudge
const system = fs.readFileSync(new URL('../../../prompts/discovery.md', import.meta.url), 'utf8');

const conflict = (code, message) => Object.assign(new ConflictError(message), { code });

// ---- Tools ------------------------------------------------------------------------------------
/** The server web search tool. allowed_callers ["direct"]: no hidden code-execution step, and the search count in usage is exact. */
export const webSearchTool = (city) => ({
  type: 'web_search_20260209', name: 'web_search', max_uses: MAX_SEARCHES, allowed_callers: ['direct'],
  user_location: { type: 'approximate', city, country: 'IN', timezone: 'Asia/Kolkata' },
});

export const SUBMIT_TOOL = {
  name: 'submit_leads',
  description: 'Submit the organisations you found. Call once. Use an empty list if nothing suitable turned up.',
  input_schema: {
    type: 'object',
    properties: {
      leads: {
        type: 'array', maxItems: MAX_LEADS,
        items: {
          type: 'object',
          properties: {
            organisation: { type: 'string' },
            type: { type: 'string', description: 'What kind of organisation it is' },
            why_a_fit: { type: 'string', description: 'One short sentence' },
            source_url: { type: 'string', description: 'A page from your search results' },
            public_contact: { type: ['string', 'null'], description: 'A contact shown publicly on that page, or null' },
          },
          required: ['organisation', 'type', 'why_a_fit', 'source_url', 'public_contact'],
        },
      },
    },
    required: ['leads'],
  },
};

// ---- Validation -------------------------------------------------------------------------------
const leadSchema = z.object({
  organisation: z.string().trim().min(2).max(120),
  type: z.string().trim().min(2).max(80),
  why_a_fit: z.string().trim().min(5).max(300),
  source_url: z.string().trim().max(500).url().refine((u) => /^https?:\/\//i.test(u), 'http(s) only'),
  public_contact: z.string().trim().max(120).nullable().optional(),
});

const SOCIAL = ['facebook.com', 'fb.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com', 'tiktok.com', 'youtube.com', 'youtu.be',
  'pinterest.com', 'reddit.com', 'whatsapp.com', 'wa.me', 't.me', 'telegram.me', 'snapchat.com', 'threads.net', 'quora.com', 'tumblr.com', 'linktr.ee'];
const PERSONAL_EMAIL = ['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.in', 'yahoo.co.in', 'ymail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'icloud.com', 'rediffmail.com', 'proton.me', 'protonmail.com', 'aol.com'];
const NOT_AN_ORGANISATION = /\b(individual|freelanc\w*|private person|influencer|personal)\b/i;
const TITLE_NAME = /^(mr|mrs|ms|miss|dr|shri|smt|sri)\.?\s/i;

export const hostOf = (url) => new URL(url).hostname.toLowerCase().replace(/^www\./, '');
const hostIs = (host, domain) => host === domain || host.endsWith(`.${domain}`);
export const isSocial = (host) => SOCIAL.some((d) => hostIs(host, d));

/** host + path, no www, no query or fragment, no trailing slash: so tracking parameters don't matter. */
export function normUrl(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** URLs this response really contained: search results and citations. */
export function sourcesOf(content) {
  const urls = new Set();
  for (const block of content ?? []) {
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const r of block.content) if (r?.url) urls.add(normUrl(r.url));
    }
    if (block.type === 'text') for (const c of block.citations ?? []) if (c?.url) urls.add(normUrl(c.url));
  }
  urls.delete(null);
  return urls;
}

const STOP = new Set(['facilities', 'services', 'management', 'solutions', 'group', 'company', 'limited', 'private', 'events', 'association', 'society', 'the', 'and']);
/** Does the page's own domain look like it belongs to this organisation? */
export function isOwnPage(host, organisation) {
  const labels = host.split('.');
  labels.pop(); // TLD
  if (['co', 'com', 'org', 'net', 'ac', 'gov', 'edu'].includes(labels.at(-1)) && labels.length > 1) labels.pop();
  const base = (labels.at(-1) ?? '').replace(/[^a-z0-9]/g, '');
  const squashed = organisation.toLowerCase().replace(/[^a-z0-9]/g, '');
  const tokens = organisation.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((t) => t.length >= 4 && !STOP.has(t));
  return base.length >= 4 && (squashed.includes(base) || tokens.some((t) => base.includes(t) || t.includes(base)));
}

/** A mobile number or a free personal mailbox. */
export function looksPersonal(contact) {
  if (contact.includes('@')) return PERSONAL_EMAIL.some((d) => hostIs(contact.split('@').pop().toLowerCase(), d));
  const digits = contact.replace(/\D/g, '').replace(/^(?:91|0)(?=\d{10}$)/, '');
  return /^[6-9]\d{9}$/.test(digits);
}

/** Tidy the contact: a valid email, a phone-looking number, or null. */
export function cleanContact(raw) {
  const c = (raw ?? '').trim();
  if (!c) return null;
  if (c.includes('@')) return z.email().max(120).safeParse(c).success ? c.toLowerCase() : null;
  return /^[+\d][\d\s().-]{6,}$/.test(c) && c.replace(/\D/g, '').length >= 8 ? c : null;
}

const orgKey = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Filter submitted leads. Returns { kept, dropped } where dropped counts reasons.
 * `existing` = leads already stored (for duplicates). Order is kept; at most MAX_LEADS survive.
 */
export function filterLeads(raw, allowed, existing, countryCode = '91') {
  const kept = [];
  const dropped = {};
  const drop = (reason) => { dropped[reason] = (dropped[reason] ?? 0) + 1; };
  const seenOrg = new Set(existing.map((l) => orgKey(l.name ?? '')));
  const seenUrl = new Set(existing.map((l) => (l.sourceUrl ? normUrl(l.sourceUrl) : null)).filter(Boolean));
  const seenContact = new Set(existing.map((l) => identityOf({ email: l.email, phone: l.phone, channel: l.email ? 'email' : 'whatsapp' })).filter(Boolean));

  for (const item of (Array.isArray(raw) ? raw : []).slice(0, MAX_LEADS)) {
    const parsed = leadSchema.safeParse(item);
    if (!parsed.success) { drop('invalid'); continue; }
    const lead = parsed.data;
    const norm = normUrl(lead.source_url);
    const host = hostOf(lead.source_url);
    if (!norm || !allowed.has(norm)) { drop('source_not_in_results'); continue; }
    if (isSocial(host)) { drop('social_media'); continue; }
    if (NOT_AN_ORGANISATION.test(lead.type) || TITLE_NAME.test(lead.organisation)) { drop('individual'); continue; }
    const contact = cleanContact(lead.public_contact);
    if (contact && looksPersonal(contact) && !isOwnPage(host, lead.organisation)) { drop('personal_contact'); continue; }
    const email = contact?.includes('@') ? contact : null;
    const phone = contact && !email ? normalisePhone(contact, countryCode) : null;
    const key = identityOf({ email, phone, channel: email ? 'email' : 'whatsapp' });
    if (seenOrg.has(orgKey(lead.organisation)) || seenUrl.has(norm) || (key && seenContact.has(key))) { drop('duplicate'); continue; }
    seenOrg.add(orgKey(lead.organisation));
    seenUrl.add(norm);
    if (key) seenContact.add(key);
    kept.push({
      organisation: lead.organisation, orgType: lead.type, whyFit: sanitizeDraft(lead.why_a_fit).text, sourceUrl: lead.source_url,
      sourceDomain: host, publicContact: contact, email, phone,
    });
  }
  return { kept, dropped };
}

// ---- Facts and limits ---------------------------------------------------------------------------
/** What Claude is told: names of services and areas, the city, anonymous counts. No customer data. */
export function businessFacts(repos, focus = {}) {
  const business = repos.businessSettings.get();
  const pricing = repos.pricingConfigs.latestApproved().configJson;
  const services = pricing.services.map((s) => s.name);
  const areas = Object.keys(pricing.travel.areas);
  const bySvc = {};
  const byArea = {};
  for (const e of repos.enquiries.list()) {
    const name = pricing.services.find((s) => s.id === e.requirementsJson?.service_id)?.name;
    if (name) bySvc[name] = (bySvc[name] ?? 0) + 1;
    const area = e.requirementsJson?.location;
    if (area) byArea[area] = (byArea[area] ?? 0) + 1;
  }
  return {
    business_name: business.businessName, city: business.city, services, areas,
    enquiries_per_service: bySvc, enquiries_per_area: byArea,
    ...(focus.service ? { focus_service: focus.service } : {}), ...(focus.area ? { focus_area: focus.area } : {}),
  };
}

const sameDay = (a, b) => todayIST(a) === todayIST(b);
export const runsToday = (repos, now) => repos.discoveryRuns.all().filter((r) => !r.cached && sameDay(r.createdAt, now)).length;
export const searchesToday = (repos, now) => repos.aiCalls.all().filter((r) => r.purpose === 'discovery' && sameDay(r.createdAt, now)).reduce((n, r) => n + r.webSearchRequests, 0);

function logCall({ repos, config }, now, resp, latencyMs, err) {
  const usage = resp?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearchRequests: 0 };
  const searches = usage.webSearchRequests ?? 0;
  repos.aiCalls.create({
    enquiryId: null, purpose: 'discovery', model: resp?.model ?? config.ai.modelDiscovery,
    inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite,
    costUsd: computeCostUsd(usage, config.ai.prices), webSearchRequests: searches, searchCostUsd: Number((searches * config.ai.webSearchPrice).toFixed(6)),
    latencyMs, ok: !err, error: err ? String(err.status ?? err.code ?? err.name).slice(0, 100) : null, // a code only
  }, now);
}

// ---- The run ----------------------------------------------------------------------------------
/**
 * Find clients for an optional service and area. Returns { leads, dropped, cached, searches }.
 * Cached per service+area for 6 hours (cached runs cost nothing and don't count toward the daily cap).
 */
export async function discoverClients(deps, { service = null, area = null } = {}) {
  const { repos, config, ai } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const business = repos.businessSettings.get();
  const pricing = repos.pricingConfigs.latestApproved().configJson;
  if (service && !pricing.services.some((s) => s.name === service)) throw conflict('bad_focus', 'Choose a service from the list.');
  if (area && !Object.hasOwn(pricing.travel.areas, area)) throw conflict('bad_focus', 'Choose an area from the list.');
  if (!business.city) throw conflict('no_city', 'Add your city on Business setup first, so searches are local.');

  const key = `${service ?? 'all'}|${area ?? 'all'}`;
  const cached = repos.discoveryRuns.all().filter((r) => r.key === key && now - r.createdAt < CACHE_HOURS * 3600 * 1000 && r.leadIds.length).at(-1);
  if (cached) {
    const leads = cached.leadIds.map((id) => repos.leads.get(id)).filter(Boolean);
    return { leads, dropped: {}, cached: true, searches: 0 };
  }
  if (!config.aiEnabled || !ai) throw conflict('ai_off', 'Finding clients needs AI, which is switched off.');
  const cap = config.clientDiscoveryDailyCap;
  if (runsToday(repos, now) >= cap) throw conflict('discovery_limit', `You’ve reached today’s limit of ${cap} searches for clients. Try again tomorrow.`);
  if (dailyCallCount(repos, now) >= config.ai.dailyCap) throw conflict('ai_cap', 'The daily AI limit has been reached. Try again tomorrow.');

  const facts = businessFacts(repos, { service, area });
  const sys = [{ type: 'text', text: system.replaceAll('{{business_name}}', business.businessName), cache_control: { type: 'ephemeral' } }];
  const messages = [{ role: 'user', content: `Find organisations that could become clients.\n<business>${JSON.stringify(facts).replaceAll('</business>', '[/business]')}</business>` }];
  const run = repos.discoveryRuns.create({ key, service, area, cached: false }, now); // reserves the daily slot before the AI call

  const allowed = new Set();
  let submitted = null;
  let searches = 0;
  for (let i = 0; i < MAX_REQUESTS && !submitted; i += 1) {
    let resp;
    const t0 = Date.now();
    try {
      resp = await ai.createMessage({
        purpose: 'discovery', system: sys, tools: [webSearchTool(business.city), SUBMIT_TOOL], messages, maxTokens: 4000, timeoutMs: 90000,
      });
      logCall(deps, now, resp, Date.now() - t0, null);
    } catch (err) {
      logCall(deps, now, null, Date.now() - t0, err);
      throw conflict('discovery_failed', 'The search didn’t work this time. Nothing was saved. Try again in a minute.');
    }
    searches += resp.usage?.webSearchRequests ?? 0;
    for (const u of sourcesOf(resp.content)) allowed.add(u);
    submitted = resp.content.find((b) => b.type === 'tool_use' && b.name === SUBMIT_TOOL.name)?.input ?? null;
    if (submitted) break;
    messages.push({ role: 'assistant', content: resp.content });
    if (resp.stopReason !== 'pause_turn') {
      messages.push({ role: 'user', content: 'Now call submit_leads with the organisations you found, or an empty list if none.' });
    }
  }

  const existing = repos.leads.all();
  const { kept, dropped } = filterLeads(submitted?.leads, allowed, existing, config.whatsappCountryCode);
  const leads = kept.map((l) => repos.leads.create({
    kind: 'discovered', name: l.organisation, orgType: l.orgType, whyFit: l.whyFit, note: `${l.orgType}. ${l.whyFit}`,
    sourceUrl: l.sourceUrl, sourceDomain: l.sourceDomain, publicContact: l.publicContact, email: l.email, phone: l.phone,
  }, now));
  repos.discoveryRuns.update(run.id, { leadIds: leads.map((l) => l.id), searches });
  return { leads, dropped, cached: false, searches };
}
