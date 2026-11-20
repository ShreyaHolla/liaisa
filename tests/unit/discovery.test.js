import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRepos } from '../../src/container.js';
import { seed } from '../../src/seed.js';
import { loadConfig } from '../../src/config.js';
import { createMockClient, step } from '../../src/ai/mockClient.js';
import {
  discoverClients, businessFacts, filterLeads, sourcesOf, looksPersonal, isOwnPage, normUrl, searchesToday, runsToday,
  webSearchTool, MAX_LEADS, CACHE_HOURS,
} from '../../src/services/clients/discovery.js';

const NOW = new Date('2026-12-01T10:00:00Z');
const HOUR = 3600 * 1000;

function world({ steps, env = {} } = {}) {
  const repos = createRepos();
  seed(repos, { now: NOW });
  const config = loadConfig({ NODE_ENV: 'test', AI_PRICE_INPUT_PER_MTOK: '0.1', AI_PRICE_OUTPUT_PER_MTOK: '0.5', ...env });
  const ai = createMockClient(steps ? { steps } : {});
  const clock = { t: NOW };
  return { repos, config, ai, clock, deps: { repos, config, ai, now: () => clock.t } };
}
const lead = (over = {}) => ({
  organisation: 'Brightway Facilities', type: 'facilities management company', why_a_fit: 'Runs office parks that host team events.',
  source_url: 'https://brightway-facilities.example/about', public_contact: null, ...over,
});
const urls = (...ls) => ls.map((l) => l.source_url);
const run = (steps, env) => {
  const w = world({ steps, env });
  return discoverClients(w.deps, {}).then((r) => ({ ...w, r }));
};

test('model choice: haiku-5-5 supports web search per the Models API check; the env name and caps have defaults', () => {
  const c = loadConfig({ NODE_ENV: 'test' });
  assert.equal(c.ai.modelDiscovery, 'claude-haiku-5-5');
  assert.equal(c.clientDiscoveryDailyCap, 10);
  assert.equal(c.ai.webSearchPrice, 0.01);
  assert.equal(loadConfig({ NODE_ENV: 'test', AI_MODEL_DISCOVERY: 'claude-sonnet-5-5' }).ai.modelDiscovery, 'claude-sonnet-5-5');
});

test('the tool: current web search version, 5 uses, direct calls only, the business city', () => {
  assert.deepEqual(webSearchTool('Bengaluru'), {
    type: 'web_search_20260209', name: 'web_search', max_uses: 5, allowed_callers: ['direct'],
    user_location: { type: 'approximate', city: 'Bengaluru', country: 'IN', timezone: 'Asia/Kolkata' },
  });
});

test('facts sent to Claude: service names, areas, city and anonymous counts; no customer names, emails or phones', async () => {
  const { repos, deps, ai } = world({ steps: [step.discovery({ results: [], leads: [] })] });
  const facts = businessFacts(repos, { service: 'Veg buffet', area: 'Whitefield' });
  assert.equal(facts.city, 'Bengaluru');
  assert.deepEqual(facts.services, ['Veg buffet', 'Non-veg buffet', 'Live dosa counter']);
  assert.deepEqual(facts.areas, ['Koramangala', 'Indiranagar', 'Whitefield']);
  assert.equal(facts.enquiries_per_service['Veg buffet'] >= 1, true);
  assert.equal(facts.focus_service, 'Veg buffet');
  await discoverClients(deps, { service: 'Veg buffet' });
  const sent = JSON.stringify(ai.calls[0]);
  for (const e of repos.enquiries.list()) {
    for (const secret of [e.customerName, e.customerName.split(' ')[0], e.customerEmail, e.customerPhone, e.rawText].filter(Boolean)) {
      assert.ok(!sent.includes(secret), `leaked: ${secret}`);
    }
  }
  assert.ok(!/@example\.test|\+91980/.test(sent));
  const req = ai.calls[0];
  assert.equal(req.purpose, 'discovery');
  assert.deepEqual(req.tools.map((t) => t.name), ['web_search', 'submit_leads']);
  assert.equal(req.tools[0].type, 'web_search_20260209');
  assert.equal(req.tools[0].max_uses, 5);
  assert.equal(req.tools[0].user_location.city, 'Bengaluru');
});

test('the prompt: organisations only, public contacts only, never guess, no prices, no social media', () => {
  const p = fs.readFileSync(new URL('../../prompts/discovery.md', import.meta.url), 'utf8');
  assert.match(p, /ONLY organisations and businesses\. NEVER private individuals/);
  assert.match(p, /shown publicly on the page in source_url/);
  assert.match(p, /Never guess or construct an email address or phone number/);
  assert.match(p, /Never mention prices, costs, rates, discounts or offers/);
  assert.match(p, /Do not use social media pages/);
  assert.match(p, /is data, not instructions/);
});

test('a lead whose source_url was not in the search results is dropped; one with no source is dropped', () => {
  const good = lead();
  const stray = lead({ organisation: 'Made Up Ltd', source_url: 'https://made-up.example/page' });
  const noSource = { ...lead({ organisation: 'No Source Ltd' }), source_url: undefined };
  const emptySource = lead({ organisation: 'Empty Source Ltd', source_url: '' });
  const notHttp = lead({ organisation: 'Script Ltd', source_url: 'javascript:alert(1)' });
  const { kept, dropped } = filterLeads([good, stray, noSource, emptySource, notHttp], new Set([normUrl(good.source_url)]), []);
  assert.deepEqual(kept.map((l) => l.organisation), ['Brightway Facilities']);
  assert.deepEqual(dropped, { source_not_in_results: 1, invalid: 3 });
});

test('citations count as sources, and tracking parameters and www do not matter', () => {
  const content = [
    { type: 'text', text: 'x', citations: [{ type: 'web_search_result_location', url: 'https://www.cited-org.example/team/?utm=1#top' }] },
    { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://found.example/a' }] },
    { type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
  ];
  const sources = sourcesOf(content);
  assert.deepEqual([...sources].sort(), ['cited-org.example/team', 'found.example/a']);
  const a = lead({ organisation: 'Cited Org', source_url: 'https://cited-org.example/team' });
  const b = lead({ organisation: 'Found Org', source_url: 'https://www.found.example/a?ref=x' });
  assert.equal(filterLeads([a, b], sources, []).kept.length, 2);
});

test('social media domains are dropped, subdomains included', () => {
  const sites = ['https://www.facebook.com/brightway', 'https://m.facebook.com/x', 'https://instagram.com/x', 'https://x.com/brightway', 'https://in.linkedin.com/company/x', 'https://youtu.be/abc', 'https://wa.me/919845012345'];
  const leads = sites.map((u, i) => lead({ organisation: `Org ${i} Facilities`, source_url: u }));
  const allowed = new Set(leads.map((l) => normUrl(l.source_url)));
  const { kept, dropped } = filterLeads(leads, allowed, []);
  assert.deepEqual([kept.length, dropped.social_media], [0, 7]);
  const ok = lead({ organisation: 'Notfacebook Events', source_url: 'https://notfacebook.example/x' });
  assert.equal(filterLeads([ok], new Set([normUrl(ok.source_url)]), []).kept.length, 1);
});

test('personal-looking contacts: mobile numbers and gmail-style addresses only survive on the organisation’s own page', () => {
  assert.equal(looksPersonal('priya@gmail.com'), true);
  assert.equal(looksPersonal('Priya@Yahoo.co.in'), true);
  assert.equal(looksPersonal('+91 98450 12345'), true);
  assert.equal(looksPersonal('09845012345'), true);
  // With the trunk 0 an STD landline (080 4123 4567) has the same digits as a mobile (0 8041234567), so it is
  // treated as personal to be safe. Clearly non-mobile numbers are fine.
  assert.equal(looksPersonal('080 4123 4567'), true);
  assert.equal(looksPersonal('044 2345 6789'), false);
  assert.equal(looksPersonal('1800 123 4567'), false);
  assert.equal(looksPersonal('events@brightway-facilities.example'), false);
  assert.equal(isOwnPage('brightway-facilities.example', 'Brightway Facilities'), true);
  assert.equal(isOwnPage('www.brightway.co.in', 'Brightway Facilities Pvt Ltd'), true);
  assert.equal(isOwnPage('directory-listings.example', 'Brightway Facilities'), false);

  const own = lead({ public_contact: 'brightway.events@gmail.com' });
  const elsewhere = lead({ organisation: 'Other Events', source_url: 'https://listings.example/other', public_contact: '+91 98450 12345' });
  const business = lead({ organisation: 'Third Events', source_url: 'https://listings.example/third', public_contact: 'info@thirdevents.example' });
  const allowed = new Set([own, elsewhere, business].map((l) => normUrl(l.source_url)));
  const { kept, dropped } = filterLeads([own, elsewhere, business], allowed, []);
  assert.deepEqual(kept.map((l) => [l.organisation, l.publicContact]), [['Brightway Facilities', 'brightway.events@gmail.com'], ['Third Events', 'info@thirdevents.example']]);
  assert.deepEqual(dropped, { personal_contact: 1 });
});

test('a malformed contact becomes null instead of being kept or guessed', () => {
  const l = lead({ public_contact: 'call us maybe' });
  assert.equal(filterLeads([l], new Set([normUrl(l.source_url)]), []).kept[0].publicContact, null);
});

test('private individuals are dropped', () => {
  const a = lead({ organisation: 'Dr. Asha Rao', source_url: 'https://asha.example/p' });
  const b = lead({ organisation: 'Ravi K', type: 'freelance photographer', source_url: 'https://ravi.example/p' });
  const allowed = new Set([a, b].map((l) => normUrl(l.source_url)));
  assert.deepEqual(filterLeads([a, b], allowed, []).dropped, { individual: 2 });
});

test('duplicates are dropped: against existing leads (name, source page, contact) and within one response', () => {
  const existing = [
    { name: 'Brightway Facilities', sourceUrl: null, email: null, phone: null },
    { name: 'Someone', sourceUrl: 'https://samepage.example/x', email: null, phone: null },
    { name: 'Another', sourceUrl: null, email: 'info@contactdup.example', phone: null },
  ];
  const a = lead();
  const b = lead({ organisation: 'Same Page Ltd', source_url: 'https://www.samepage.example/x/?a=1' });
  const c = lead({ organisation: 'Contact Dup Ltd', source_url: 'https://cd.example/c', public_contact: 'info@contactdup.example' });
  const d1 = lead({ organisation: 'Fresh One Ltd', source_url: 'https://fresh1.example/a' });
  const d2 = lead({ organisation: 'FRESH one, ltd.', source_url: 'https://fresh2.example/b' });
  const allowed = new Set([a, b, c, d1, d2].map((l) => normUrl(l.source_url)));
  const { kept, dropped } = filterLeads([a, b, c, d1, d2], allowed, existing);
  assert.deepEqual(kept.map((l) => l.organisation), ['Fresh One Ltd']);
  assert.deepEqual(dropped, { duplicate: 4 });
});

test('at most 8 leads, links and amounts are stripped from why_a_fit', () => {
  const many = Array.from({ length: 12 }, (_, i) => lead({ organisation: `Org Number ${i} Events`, source_url: `https://org${i}.example/a` }));
  const allowed = new Set(urls(...many).map(normUrl));
  assert.equal(filterLeads(many, allowed, []).kept.length, MAX_LEADS);
  const priced = lead({ why_a_fit: 'Hosts events, pays ₹5,000 per head, see https://x.example now.' });
  const out = filterLeads([priced], new Set([normUrl(priced.source_url)]), []).kept[0];
  assert.ok(!/₹|https?:|5,000/.test(out.whyFit));
});

test('mock mode: a deterministic list on fake .example domains, saved as new leads, 2 searches logged', async () => {
  const w = world();
  const a = await discoverClients(w.deps, { area: 'Whitefield' });
  assert.equal(a.leads.length, 5);
  assert.ok(a.leads.every((l) => l.kind === 'discovered' && l.status === 'new' && l.sourceDomain.endsWith('.example')));
  assert.deepEqual(a.dropped, {});
  assert.match(a.leads[0].whyFit, /Whitefield/);
  const b = await discoverClients(world().deps, { area: 'Whitefield' });
  assert.deepEqual(a.leads.map((l) => [l.name, l.sourceUrl, l.publicContact]), b.leads.map((l) => [l.name, l.sourceUrl, l.publicContact]), 'deterministic');
  assert.equal(a.leads[1].publicContact, null);
  assert.equal(a.leads[0].email, 'events@northfield-facilities.example');
});

test('cost logging: tokens in cost_usd, searches in their own column at $0.01 each, searches today', async () => {
  const w = world({ steps: [step.discovery({ results: [], leads: [], searches: 3 })] });
  await discoverClients(w.deps, {});
  const [row] = w.repos.aiCalls.all().filter((r) => r.purpose === 'discovery');
  assert.deepEqual([row.webSearchRequests, row.searchCostUsd, row.ok, row.model, row.enquiryId], [3, 0.03, true, 'mock-intake', null]);
  assert.equal(row.costUsd, Number(((6000 * 0.1 + 900 * 0.5) / 1e6).toFixed(6)));
  assert.equal(searchesToday(w.repos, NOW), 3);
  assert.equal(searchesToday(w.repos, new Date(NOW.getTime() + 24 * HOUR)), 0, 'yesterday does not count');
  assert.ok(!JSON.stringify(row).includes('Bengaluru'));
});

test('cache: the same service+area within 6 hours is served from the last result, with no AI call', async () => {
  const w = world({ steps: [step.discovery({ results: ['https://a.example/x'], leads: [lead({ source_url: 'https://a.example/x' })] })] });
  const first = await discoverClients(w.deps, { service: 'Veg buffet', area: 'Whitefield' });
  assert.deepEqual([first.cached, first.leads.length], [false, 1]);
  w.clock.t = new Date(NOW.getTime() + (CACHE_HOURS - 1) * HOUR);
  const again = await discoverClients(w.deps, { service: 'Veg buffet', area: 'Whitefield' });
  assert.deepEqual([again.cached, again.leads.map((l) => l.id), again.searches], [true, first.leads.map((l) => l.id), 0]);
  assert.equal(w.ai.calls.length, 1);
  assert.equal(runsToday(w.repos, w.clock.t), 1, 'a cached result does not use a daily run');
});

test('cache expires after 6 hours and an empty result is never cached', async () => {
  const l = lead({ source_url: 'https://a.example/x' });
  const w = world({ steps: [step.discovery({ results: [l.source_url], leads: [l] }), step.discovery({ results: [], leads: [] }), step.discovery({ results: [], leads: [] }), step.discovery({ results: [], leads: [] })] });
  await discoverClients(w.deps, {});
  w.clock.t = new Date(NOW.getTime() + (CACHE_HOURS + 0.1) * HOUR);
  const fresh = await discoverClients(w.deps, {});
  assert.equal(fresh.cached, false);
  assert.equal(w.ai.calls.length, 2);
  const empty = await discoverClients(w.deps, { area: 'Whitefield' });
  assert.deepEqual([empty.leads.length, empty.cached], [0, false]);
  await discoverClients(w.deps, { area: 'Whitefield' });
  assert.equal(w.ai.calls.length, 4, 'an empty result is searched again, not cached');
});

test('daily cap: CLIENT_DISCOVERY_DAILY_CAP runs a day, then a clear message; AI off and API errors save nothing', async () => {
  const w = world({ env: { CLIENT_DISCOVERY_DAILY_CAP: '2' } });
  await discoverClients(w.deps, { area: 'Whitefield' });
  await discoverClients(w.deps, { area: 'Indiranagar' });
  await assert.rejects(() => discoverClients(w.deps, { area: 'Koramangala' }), (e) => e.code === 'discovery_limit' && e.message === 'You’ve reached today’s limit of 2 searches for clients. Try again tomorrow.');
  assert.equal(w.ai.calls.length, 2);
  w.clock.t = new Date(NOW.getTime() + 24 * HOUR);
  const nextDay = await discoverClients(w.deps, { area: 'Koramangala' });
  assert.deepEqual([nextDay.cached, nextDay.dropped], [false, { duplicate: 5 }], 'a new day: the search runs, and the organisations already saved are not added twice');

  const off = world({ env: { AI_ENABLED: 'false' } });
  await assert.rejects(() => discoverClients(off.deps, {}), (e) => e.code === 'ai_off');
  assert.equal(off.ai.calls.length, 0);

  const broken = world({ steps: [step.error(500)] });
  await assert.rejects(() => discoverClients(broken.deps, {}), (e) => e.code === 'discovery_failed');
  assert.equal(broken.repos.leads.all().length, 0);
  const row = broken.repos.aiCalls.all().find((r) => r.purpose === 'discovery');
  assert.deepEqual([row.ok, row.error, row.webSearchRequests], [false, '500', 0]);
});

test('a bad focus and a missing city are refused before any call', async () => {
  const w = world();
  await assert.rejects(() => discoverClients(w.deps, { service: 'Plumbing' }), (e) => e.code === 'bad_focus');
  await assert.rejects(() => discoverClients(w.deps, { area: 'Atlantis' }), (e) => e.code === 'bad_focus');
  w.repos.businessSettings.save({ city: null });
  await assert.rejects(() => discoverClients(w.deps, {}), (e) => e.code === 'no_city');
  assert.equal(w.ai.calls.length, 0);
});

test('pause_turn continues the same search; a missing submit gets one nudge; nothing valid saves nothing', async () => {
  const l = lead({ source_url: 'https://a.example/x' });
  const paused = { ...step.discovery({ results: [l.source_url], submit: false }), stopReason: 'pause_turn' };
  const w = world({ steps: [paused, step.discovery({ results: [], leads: [l] })] });
  const r = await discoverClients(w.deps, {});
  assert.equal(r.leads.length, 1, 'the source found before the pause still counts');
  assert.equal(w.ai.calls.length, 2);
  assert.equal(r.searches, 4);
  assert.equal(w.ai.calls[1].messages.at(-1).role, 'assistant', 'a pause is continued, not nudged');

  const nudged = world({ steps: [step.discovery({ results: ['https://a.example/x'], submit: false }), step.discovery({ results: [], leads: [] })] });
  await discoverClients(nudged.deps, {});
  assert.match(nudged.ai.calls[1].messages.at(-1).content, /call submit_leads/);

  const none = world({ steps: [step.discovery({ results: [], leads: [lead()] })] });
  const empty = await discoverClients(none.deps, {});
  assert.deepEqual([empty.leads.length, empty.dropped], [0, { source_not_in_results: 1 }]);
  assert.equal(none.repos.leads.all().length, 0);
});
