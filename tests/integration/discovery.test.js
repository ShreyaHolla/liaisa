// M10b: Find clients (web search) page, lead pipeline, limits and safety, in mock mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupOwner, login } from '../helpers/ownerApp.js';
import { step } from '../../src/ai/mockClient.js';

const lead = (over = {}) => ({
  organisation: 'Brightway Facilities', type: 'facilities management company', why_a_fit: 'Runs office parks that host team events.',
  source_url: 'https://brightway-facilities.example/about', public_contact: 'events@brightway-facilities.example', ...over,
});
const found = (leads, extra = {}) => step.discovery({ results: leads.map((l) => l.source_url), leads, ...extra });
async function world(opts) {
  const ctx = setupOwner(opts);
  const o = await login(ctx.app);
  return { ...ctx, o };
}
const discover = (o, body = {}) => o.postJson('/owner/clients/discover', body);
const findPage = (o) => o.get('/owner/clients?tab=find');

test('the Find clients tab needs the owner login and shows the responsibility note, the selects and the counters', async () => {
  const ctx = await world();
  assert.equal((await request(ctx.app).get('/owner/clients?tab=find')).status, 302);
  const page = await findPage(ctx.o);
  assert.equal(page.status, 200);
  assert.match(page.text, /Find clients<\/a>/);
  assert.match(page.text, /Check each contact before you send\. You are responsible for what you send\./);
  assert.match(page.text, /<option value="Veg buffet">/);
  assert.match(page.text, /<option value="Whitefield">/);
  assert.match(page.text, /Searches today: 0 · Finds today: 0 of 10/);
  assert.match(page.text, /Nothing yet\.<\/strong>Press Find clients/);
  assert.equal(ctx.ai.calls.length, 0, 'opening the page makes no call');
});

test('mock mode: the button finds a deterministic list; cards show organisation, type, why, source link and contact', async () => {
  const ctx = await world();
  const res = await ctx.o.postForm('/owner/clients/discover', { service: 'Veg buffet', area: 'Whitefield' });
  assert.equal(res.headers.location, '/owner/clients?tab=find&n=found');
  const page = await ctx.o.get(res.headers.location);
  assert.equal((page.text.match(/<li class="card">/g) ?? []).length, 5);
  assert.match(page.text, /Northfield Corporate Park Facilities/);
  assert.match(page.text, /facilities management company/);
  assert.match(page.text, /Source: <a href="https:\/\/northfield-facilities\.example\/about" target="_blank" rel="noopener noreferrer">northfield-facilities\.example<\/a>/);
  assert.match(page.text, /Contact: events@northfield-facilities\.example/);
  assert.match(page.text, /No public contact listed\./);
  assert.match(page.text, />New<\/span>/);
  for (const button of ['Draft message', 'Not interested', 'Mark replied']) assert.ok(page.text.includes(button), button);
  assert.match(page.text, /Searches today: 2 · Finds today: 1 of 10/);
  assert.ok(!/\.(com|in)\b[^<]*<\/a>/.test(page.text.match(/Source: <a[^>]*>[^<]*<\/a>/g).join('')), 'only fake .example domains');
});

test('JSON: leads, dropped counts and searches; a lead not found in the results is dropped', async () => {
  const good = lead();
  const stray = lead({ organisation: 'Invented Ltd', source_url: 'https://invented.example/x' });
  const social = lead({ organisation: 'Facebook Page Events', source_url: 'https://www.facebook.com/events-page' });
  const ctx = await world({ steps: [step.discovery({ results: [good.source_url, social.source_url], leads: [good, stray, social], searches: 3 })] });
  const res = await discover(ctx.o, { area: 'Whitefield' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.leads.map((l) => l.organisation), ['Brightway Facilities']);
  assert.deepEqual(res.body.dropped, { source_not_in_results: 1, social_media: 1 });
  assert.deepEqual([res.body.searches, res.body.cached], [3, false]);
  assert.equal(res.body.leads[0].sourceDomain, 'brightway-facilities.example');
  assert.equal(ctx.repos.leads.all().length, 1);
});

test('"No clear matches. Try another area or service." when nothing valid remains', async () => {
  const ctx = await world({ steps: [found([lead()], { results: ['https://other.example/page'] })] });
  const res = await ctx.o.postForm('/owner/clients/discover', {});
  assert.equal(res.headers.location, '/owner/clients?tab=find&n=no_matches');
  assert.match((await ctx.o.get(res.headers.location)).text, /No clear matches\. Try another area or service\./);
  assert.equal(ctx.repos.leads.all().length, 0);
});

test('caps and cache: a repeat is served from the cache; the daily run cap gives a clear message', async () => {
  const ctx = await world({ env: { CLIENT_DISCOVERY_DAILY_CAP: '1' } });
  await discover(ctx.o, { area: 'Whitefield' });
  const cached = await ctx.o.postForm('/owner/clients/discover', { area: 'Whitefield' });
  assert.equal(cached.headers.location, '/owner/clients?tab=find&n=cached');
  assert.match((await ctx.o.get(cached.headers.location)).text, /Showing the result of the last search/);
  assert.equal(ctx.ai.calls.length, 1, 'no second search');
  const other = await discover(ctx.o, { area: 'Indiranagar' });
  assert.equal(other.status, 409);
  assert.equal(other.body.error.code, 'discovery_limit');
  assert.equal(other.body.error.message, 'You’ve reached today’s limit of 1 searches for clients. Try again tomorrow.');
  const html = await ctx.o.postForm('/owner/clients/discover', { area: 'Koramangala' });
  assert.equal(html.headers.location, '/owner/clients?tab=find&n=discovery_limit');
  assert.match((await ctx.o.get(html.headers.location)).text, /limit of searches for clients/);
  assert.equal(ctx.ai.calls.length, 1);
});

test('cost logging: two searches in the mock run show as Searches today and in ai_calls at $0.01 each', async () => {
  const ctx = await world();
  await discover(ctx.o, {});
  const row = ctx.repos.aiCalls.all().find((r) => r.purpose === 'discovery');
  assert.deepEqual([row.webSearchRequests, row.searchCostUsd], [2, 0.02]);
  await discover(ctx.o, { area: 'Whitefield' });
  assert.match((await findPage(ctx.o)).text, /Searches today: 4 · Finds today: 2 of 10/);
});

test('AI off and an API error give plain messages and save nothing', async () => {
  const off = await world({ env: { AI_ENABLED: 'false' } });
  const r = await off.o.postForm('/owner/clients/discover', {});
  assert.equal(r.headers.location, '/owner/clients?tab=find&n=ai_off');
  assert.match((await off.o.get(r.headers.location)).text, /Finding clients needs AI, which is switched off\./);
  const broken = await world({ steps: [step.error(500)] });
  const b = await broken.o.postForm('/owner/clients/discover', {});
  assert.equal(b.headers.location, '/owner/clients?tab=find&n=discovery_failed');
  assert.equal(broken.repos.leads.all().length, 0);
});

test('lead pipeline: New, then Drafted, then Sent; the draft greets the team and the lead gets the status badge', async () => {
  const ctx = await world();
  await discover(ctx.o, { area: 'Whitefield' });
  const org = ctx.repos.leads.all().find((l) => l.name === 'Northfield Corporate Park Facilities');
  assert.equal(org.status, 'new');
  const d = await ctx.o.postJson('/owner/clients/draft', { type: 'lead', ref: String(org.id) });
  assert.equal(d.status, 201);
  assert.equal(d.body.channel, 'email');
  assert.match(d.body.message, /^Hi team at Northfield Corporate Park Facilities, this is Mehfil Kitchen\. We cater for events/);
  assert.equal(ctx.repos.leads.get(org.id).status, 'drafted');
  const model = JSON.stringify(ctx.ai.calls.find((c) => c.purpose === 'outreach'));
  assert.ok(!model.includes('events@northfield-facilities.example'), 'the contact is never sent to the model');
  assert.match(model, /Hi team at|first_name\\":\\"team/);
  assert.match((await findPage(ctx.o)).text, />Drafted<\/span>/);

  assert.equal(ctx.mailer.sent.length, 0, 'a draft sends nothing');
  const sent = await ctx.o.postJson(`/owner/clients/drafts/${d.body.draftId}/send`, { message: 'Hi team, we would be glad to help with your events. Just reply here.' });
  assert.deepEqual(sent.body, { channel: 'email', status: 'sent' });
  assert.equal(ctx.mailer.sent[0].to, 'events@northfield-facilities.example');
  assert.equal(ctx.repos.leads.get(org.id).status, 'sent');
  assert.match((await findPage(ctx.o)).text, />Sent<\/span>/);
  // The 7-day rule covers organisations too.
  const again = await ctx.o.postJson('/owner/clients/draft', { type: 'lead', ref: String(org.id) });
  assert.deepEqual([again.status, again.body.error.code], [409, 'recent']);
});

test('approval is required before anything is sent to a found organisation, and the send needs the edited text', async () => {
  const ctx = await world();
  await discover(ctx.o, {});
  const org = ctx.repos.leads.all()[0];
  const d = await ctx.o.postJson('/owner/clients/draft', { type: 'lead', ref: String(org.id) });
  assert.equal(ctx.mailer.sent.length, 0);
  assert.equal((await ctx.o.postJson(`/owner/clients/drafts/${d.body.draftId}/send`, { message: '' })).status, 400);
  assert.equal((await ctx.o.postJson('/owner/clients/drafts/9999/send', { message: 'Hello there team' })).status, 404);
  assert.equal(ctx.mailer.sent.length, 0);
});

test('the daily draft cap applies to found organisations', async () => {
  const ctx = await world({ env: { CLIENT_DRAFT_DAILY_CAP: '1' } });
  await discover(ctx.o, {});
  const [a, , b] = ctx.repos.leads.all(); // the 1st and 3rd have a public contact
  assert.equal((await ctx.o.postJson('/owner/clients/draft', { type: 'lead', ref: String(a.id) })).status, 201);
  const second = await ctx.o.postJson('/owner/clients/draft', { type: 'lead', ref: String(b.id) });
  assert.deepEqual([second.status, second.body.error.code], [409, 'draft_limit']);
});

test('a lead with no public contact cannot be drafted; the card says so', async () => {
  const ctx = await world();
  await discover(ctx.o, { area: 'Whitefield' });
  const none = ctx.repos.leads.all().find((l) => l.publicContact === null);
  const res = await ctx.o.postJson('/owner/clients/draft', { type: 'lead', ref: String(none.id) });
  assert.deepEqual([res.status, res.body.error.code], [409, 'no_contact']);
  const page = await findPage(ctx.o);
  assert.match(page.text, /No public contact listed\. Open the source page to find one\./);
  assert.equal(ctx.ai.calls.filter((c) => c.purpose === 'outreach').length, 0);
});

test('Mark replied and Not interested update the pipeline; not interested also stops drafts and discards an open one', async () => {
  const ctx = await world();
  await discover(ctx.o, {});
  const [a, , b] = ctx.repos.leads.all(); // b has a public contact, so a draft can be made for it
  const replied = await ctx.o.postForm(`/owner/clients/leads/${a.id}/status`, { action: 'replied' });
  assert.equal(replied.headers.location, '/owner/clients?tab=find&n=lead_updated');
  assert.equal(ctx.repos.leads.get(a.id).status, 'replied');
  assert.match((await findPage(ctx.o)).text, />Replied<\/span>/);
  const d = await ctx.o.postJson('/owner/clients/draft', { type: 'lead', ref: String(b.id) });
  assert.equal((await ctx.o.postJson(`/owner/clients/leads/${b.id}/status`, { action: 'not_interested' })).status, 200);
  assert.deepEqual([ctx.repos.leads.get(b.id).status, ctx.repos.leads.get(b.id).doNotContact], ['not_interested', true]);
  assert.equal(ctx.repos.outreach.get(d.body.draftId).status, 'discarded');
  const blocked = await ctx.o.postJson('/owner/clients/draft', { type: 'lead', ref: String(b.id) });
  assert.equal(blocked.status, 409);
  const page = await findPage(ctx.o);
  assert.match(page.text, /Marked as not interested\./);
  assert.equal((await ctx.o.postJson(`/owner/clients/leads/${b.id}/status`, { action: 'banana' })).status, 400);
  assert.equal((await ctx.o.postJson('/owner/clients/leads/9999/status', { action: 'replied' })).status, 404);
});

test('links Claude puts in a draft are stripped; only the business’s own enquiry link remains', async () => {
  const l = lead();
  const ctx = await world({ steps: [found([l]), step.draft('Hi team at Brightway Facilities, this is Mehfil Kitchen. See https://evil.example/deal or www.other.example for us. Just reply here.')] });
  await discover(ctx.o, {});
  const org = ctx.repos.leads.all()[0];
  const d = await ctx.o.postJson('/owner/clients/draft', { type: 'lead', ref: String(org.id) });
  assert.equal(d.status, 201);
  assert.ok(!/evil\.example|other\.example/.test(d.body.message));
  assert.deepEqual(d.body.message.match(/https?:\/\/\S+/g), ['https://liaisa.co.in/b/mehfil-kitchen/enquire']);
  assert.equal(d.body.source, 'ai');
});

test('output is escaped: organisation, reason and domain from the model cannot inject HTML; non-http sources are dropped', async () => {
  const evil = lead({ organisation: '<script>alert(1)</script> Events', why_a_fit: '<img src=x onerror=alert(1)> great fit', source_url: 'https://evil-events.example/a?x="><script>' });
  const js = lead({ organisation: 'Js Events', source_url: 'javascript:alert(1)' });
  const ctx = await world({ steps: [found([evil, js])] });
  const res = await discover(ctx.o, {});
  assert.equal(res.body.leads.length, 1);
  assert.equal(res.body.dropped.invalid, 1);
  const page = await findPage(ctx.o);
  assert.ok(!page.text.includes('<script>alert(1)') && !page.text.includes('<img src=x'));
  assert.ok(page.text.includes('&lt;script&gt;alert(1)&lt;/script&gt; Events'));
  assert.ok(!page.text.includes('href="javascript:'));
});

test('all new routes need the owner session and a CSRF token', async () => {
  const ctx = await world();
  for (const url of ['/owner/clients/discover', '/owner/clients/leads/1/status']) {
    assert.equal((await request(ctx.app).post(url).type('form').send({ action: 'replied' })).status, 302, `${url} without a session`);
    assert.equal((await request(ctx.app).post(url).set('Cookie', ctx.o.cookie).type('form').send({ action: 'replied' })).status, 403, `${url} without CSRF`);
  }
  assert.equal(ctx.ai.calls.length, 0);
  assert.equal(ctx.repos.leads.all().length, 0);
});

test('city: set on Business setup (blank keeps it); it is the web search location; no city means no search', async () => {
  const ctx = await world();
  const setup = await ctx.o.get('/owner/setup');
  assert.match(setup.text, /name="city" type="text" maxlength="80" value="Bengaluru"/);
  await discover(ctx.o, {});
  assert.equal(ctx.ai.calls[0].tools[0].user_location.city, 'Bengaluru');
  const form = {
    businessName: 'Mehfil Kitchen', tagline: '', currencySymbol: '₹', whatsappNumber: '', city: 'Pune', followupAfterDays: '2', weekendPct: '10', taxPct: '5',
    svcId: ['veg_buffet'], svcName: ['Veg buffet'], svcPrice: ['450'], svcMin: ['20'], svcMax: ['200'], svcUnit: ['Number of guests'], areaName: ['Koramangala'], areaFee: ['0'],
  };
  assert.equal((await ctx.o.postForm('/owner/setup', form)).status, 303);
  assert.equal(ctx.repos.businessSettings.get().city, 'Pune');
  await ctx.o.postForm('/owner/setup', { ...form, city: '' });
  assert.equal(ctx.repos.businessSettings.get().city, 'Pune', 'blank keeps the current city');
  await discover(ctx.o, { area: 'Koramangala' });
  assert.equal(ctx.ai.calls.at(-1).tools[0].user_location.city, 'Pune');
  ctx.repos.businessSettings.save({ city: null });
  const none = await ctx.o.postForm('/owner/clients/discover', { area: 'Koramangala' });
  assert.equal(none.headers.location, '/owner/clients?tab=find&n=no_city');
});
