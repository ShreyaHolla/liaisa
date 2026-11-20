// M14 multi-business: tenant isolation, signup, login, slugs, catalogues, budget caps, seed business.
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupOwner, login, addBusiness, PASSWORD, OWNER_EMAIL, makeEnquiry } from '../helpers/ownerApp.js';
import { signLink, verifyLink } from '../../src/services/quotes/oneTap.js';
import { scenarios } from '../../src/ai/mockClient.js';
import { slugify } from '../../src/db/registry.js';
import { buildDeps } from '../../src/container.js';
import { loadConfig } from '../../src/config.js';

const SECRET = 'x'.repeat(48);
const FORM = { service_id: 'example_service', quantity: 10, event_date: '2099-12-15', location: 'Nearby area (rename me)' };

/** Demo business (A) plus a second business (B) with its own owner, both logged in. */
async function world(opts = {}) {
  const ctx = setupOwner(opts);
  const b = addBusiness(ctx.registry);
  const a = await login(ctx.app);
  const bo = await login(ctx.app, { email: b.email, password: b.password });
  return { ...ctx, a, b: bo, B: b.repos, A: ctx.repos };
}

/** An awaiting_approval enquiry in business B (starter catalogue). */
async function bEnquiry(ctx) {
  const row = ctx.B.enquiries.create({ customerName: 'Zed Customer', customerEmail: 'zed@example.test', preferredChannel: 'email', rawText: 'Some service for ten', status: 'collecting' });
  const publicId = row.publicId;
  const form = await request(ctx.app).post(`/b/${ctx.B.business.slug}/api/enquiries/${publicId}/form`).send(FORM);
  assert.equal(form.body.outcome, 'ready', JSON.stringify(form.body));
  return ctx.B.enquiries.getByPublicId(publicId);
}

// ---------------------------------------------------------------------------------------------------
// Data layer
test('every row carries its businessId, and ids are unique across businesses', async () => {
  const ctx = await world();
  const e = await bEnquiry(ctx);
  assert.equal(e.businessId, ctx.B.business.id);
  assert.ok(ctx.A.enquiries.list().every((x) => x.businessId === ctx.A.business.id));
  assert.equal(ctx.A.enquiries.get(e.id), null, 'business A has no row with the id of a business B enquiry');
  for (const name of ['emails', 'aiCalls', 'activity', 'outreach', 'leads']) {
    for (const row of ctx.B[name].all()) assert.equal(row.businessId, ctx.B.business.id, name);
  }
  for (const row of ctx.B.estimates.listByEnquiry(e.id)) assert.equal(row.businessId, ctx.B.business.id, 'estimates');
  assert.equal(ctx.B.businessSettings.get().businessId, ctx.B.business.id);
  assert.equal(ctx.B.pricingConfigs.latestApproved().businessId, ctx.B.business.id);
});

test('seed business unchanged: mehfil-kitchen with its data, and its owner from OWNER_EMAIL', async () => {
  const ctx = await world();
  assert.equal(ctx.A.business.slug, 'mehfil-kitchen');
  assert.equal(ctx.A.business.name, 'Mehfil Kitchen');
  assert.equal(ctx.A.enquiries.list().length, 7);
  assert.equal(ctx.registry.ownerByEmail(OWNER_EMAIL).businessId, ctx.A.business.id);
  assert.ok(ctx.registry.owners().every((o) => !('passwordHash' in o)), 'owner listings never carry the hash');
  assert.equal(ctx.B.enquiries.list().length, 0, 'a new business starts empty');
  assert.equal(ctx.A.pricingConfigs.latestApproved().configJson.services[0].id, 'veg_buffet');
});

test('buildDeps: the demo owner uses OWNER_EMAIL and the B64 hash, and nothing is logged', async () => {
  const bcrypt = (await import('bcryptjs')).default;
  const hash = bcrypt.hashSync('demo-password-1', 4);
  const logged = [];
  const orig = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = (...a) => logged.push(a.join(' '));
  let deps;
  try {
    deps = buildDeps(loadConfig({ NODE_ENV: 'test', OWNER_EMAIL: 'Demo@Host.example', OWNER_PASSWORD_HASH_B64: Buffer.from(hash).toString('base64'), SESSION_SECRET: SECRET }));
  } finally {
    [console.log, console.warn, console.error] = orig;
  }
  const owner = deps.registry.ownerByEmail('demo@host.example');
  assert.equal(owner.passwordHash, hash);
  assert.equal(owner.businessId, deps.repos.business.id);
  assert.deepEqual(logged, []);
});

test('slugify and slug uniqueness', async () => {
  assert.equal(slugify("Priya's Bakes & Café"), 'priyas-bakes-cafe');
  assert.equal(slugify('   '), 'business');
  assert.equal(slugify('!!!'), 'business');
  assert.equal(slugify('a'.repeat(100)).length, 40);
  const ctx = setupOwner();
  const one = addBusiness(ctx.registry, { name: 'Spice Route', email: 'a@x.example' });
  const two = addBusiness(ctx.registry, { name: 'Spice  Route!', email: 'b@x.example' });
  const three = addBusiness(ctx.registry, { name: 'Mehfil Kitchen', email: 'c@x.example' });
  assert.equal(one.repos.business.slug, 'spice-route');
  assert.equal(two.repos.business.slug, 'spice-route-2');
  assert.equal(three.repos.business.slug, 'mehfil-kitchen-2', 'the demo slug is taken too');
  assert.equal(new Set(ctx.registry.businesses().map((b) => b.slug)).size, ctx.registry.size);
});

// ---------------------------------------------------------------------------------------------------
// Signup
const csrfOf = (res) => /name="_csrf" value="([^"]+)"/.exec(res.text)?.[1];
const cookieOf = (res) => /liaisa\.sid=[^;]+/.exec((res.headers['set-cookie'] ?? []).join(';'))?.[0];
async function signup(app, body, { agent } = {}) {
  const page = await request(app).get('/signup');
  const cookie = cookieOf(page);
  const res = await request(app).post('/signup').set('Cookie', cookie).type('form').send({ _csrf: csrfOf(page), ...body });
  return { page, cookie, res };
}
const GOOD = { businessName: 'Chai Point', ownerName: 'Asha Rao', email: 'asha@chai.example', password: 'a long password', city: 'Mysuru' };

test('signup page: says data may reset, has a honeypot, and the landing page links to it', async () => {
  const ctx = setupOwner();
  const page = await request(ctx.app).get('/signup');
  assert.equal(page.status, 200);
  assert.match(page.text, /Demo environment: data may reset\./);
  assert.match(page.text, /name="website"/);
  const home = await request(ctx.app).get('/');
  assert.match(home.text, /href="\/b\/mehfil-kitchen\/enquire"[^>]*>Try the demo enquiry/);
  assert.match(home.text, /href="\/signup"[^>]*>Sign up your business/);
  assert.match(home.text, /href="\/owner\/login"[^>]*>Owner login/);
});

test('signup creates a business from the starter template, logs the owner in and lands on Setup with a checklist', async () => {
  const ctx = setupOwner();
  const { res, cookie } = await signup(ctx.app, GOOD);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/owner/setup');
  const owner = ctx.registry.ownerByEmail('asha@chai.example');
  assert.match(owner.passwordHash, /^\$2[aby]\$12\$/, 'bcrypt cost 12');
  assert.ok(!JSON.stringify(ctx.registry.owners()).includes(owner.passwordHash));
  const repos = ctx.registry.repos(owner.businessId);
  assert.equal(repos.business.slug, 'chai-point');
  assert.equal(repos.business.name, 'Chai Point');
  assert.equal(repos.business.city, 'Mysuru');
  const cfg = repos.pricingConfigs.latestApproved().configJson;
  assert.equal(cfg.services.length, 2);
  assert.equal(Object.keys(cfg.travel.areas).length, 2);

  const session = cookieOf(res);
  const setup = await request(ctx.app).get('/owner/setup').set('Cookie', session);
  assert.equal(setup.status, 200);
  assert.match(setup.text, /Set your prices\./);
  assert.match(setup.text, /Share your link\./);
  assert.match(setup.text, /Chai Point/);
  assert.match(setup.text, /\/b\/chai-point\/enquire/);
  assert.ok(!setup.text.includes('Mehfil Kitchen'), 'no other business on the page');
  assert.ok(!setup.text.includes('a long password'));
  assert.equal(cookie === session, false, 'the session id is rotated');
});

test('the checklist goes away once the owner saves Setup', async () => {
  const ctx = setupOwner();
  const { res } = await signup(ctx.app, GOOD);
  const session = cookieOf(res);
  const page = await request(ctx.app).get('/owner/setup').set('Cookie', session);
  const body = { _csrf: csrfOf(page), businessName: 'Chai Point', tagline: '', currencySymbol: '₹', whatsappNumber: '', followupAfterDays: '2', city: 'Mysuru', weekendPct: '0', taxPct: '0',
    svcId: ['example_service'], svcName: ['Chai catering'], svcPrice: ['300'], svcMin: ['1'], svcMax: [''], svcUnit: ['Number of people'], areaName: ['Nearby'], areaFee: ['0'] };
  const saved = await request(ctx.app).post('/owner/setup').set('Cookie', session).type('form').send(body);
  assert.equal(saved.status, 303, saved.text.slice(0, 300));
  assert.ok(!(await request(ctx.app).get('/owner/setup').set('Cookie', session)).text.includes('Two things to do first'));
});

test('signup validation: every field, with messages, and the password is never echoed', async () => {
  const ctx = setupOwner();
  const { res } = await signup(ctx.app, { businessName: ' ', ownerName: '', email: 'nope', password: 'short', city: '' });
  assert.equal(res.status, 400);
  for (const text of ['Enter your business name', 'Enter your name', 'Enter a valid email address', 'Use at least 10 characters', 'Enter your city']) assert.ok(res.text.includes(text), text);
  assert.ok(!res.text.includes('value="short"'));
  assert.equal(ctx.registry.size, 1, 'nothing was created');
  const nine = await signup(ctx.app, { ...GOOD, password: '123456789' });
  assert.equal(nine.res.status, 400);
  const ten = await signup(ctx.app, { ...GOOD, password: '1234567890' });
  assert.equal(ten.res.status, 302);
});

test('signup: a duplicate email is refused with a clear message, whatever its case', async () => {
  const ctx = setupOwner();
  assert.equal((await signup(ctx.app, GOOD)).res.status, 302);
  const again = await signup(ctx.app, { ...GOOD, businessName: 'Other Shop', email: 'ASHA@chai.example' });
  assert.equal(again.res.status, 409);
  assert.match(again.res.text, /That email already has an account\. Log in instead\./);
  const demo = await signup(ctx.app, { ...GOOD, businessName: 'Third', email: OWNER_EMAIL });
  assert.equal(demo.res.status, 409, 'the demo owner email is taken too');
  assert.equal(ctx.registry.size, 2);
});

test('signup: two businesses with the same name get different slugs', async () => {
  const ctx = setupOwner();
  await signup(ctx.app, GOOD);
  await signup(ctx.app, { ...GOOD, email: 'second@chai.example' });
  assert.deepEqual(ctx.registry.businesses().map((b) => b.slug), ['mehfil-kitchen', 'chai-point', 'chai-point-2']);
});

test('signup honeypot: looks successful, creates nothing', async () => {
  const ctx = setupOwner();
  const { res } = await signup(ctx.app, { ...GOOD, website: 'http://spam.example' });
  assert.equal(res.status, 303);
  assert.equal(ctx.registry.size, 1);
  assert.equal(ctx.registry.emailTaken(GOOD.email), false);
});

test('signup is rate limited per IP', async () => {
  const ctx = setupOwner();
  const statuses = [];
  for (let i = 0; i < 11; i += 1) statuses.push((await signup(ctx.app, { ...GOOD, password: 'x' })).res.status); // invalid posts count too
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(400));
  assert.equal(statuses[10], 429);
});

test('signup is capped: no more businesses than MAX_BUSINESSES', async () => {
  const ctx = setupOwner({ env: { MAX_BUSINESSES: '3' } });
  addBusiness(ctx.registry, { name: 'Two', email: 'two@x.example' });
  assert.equal(ctx.registry.size, 2);
  assert.equal((await signup(ctx.app, GOOD)).res.status, 302);
  assert.equal(ctx.registry.size, 3);
  const full = await signup(ctx.app, { ...GOOD, email: 'late@chai.example', businessName: 'Late' });
  assert.equal(full.res.status, 503);
  assert.match(full.res.text, /full for this demo/);
  assert.equal(ctx.registry.size, 3);
  assert.throws(() => addBusiness(ctx.registry, { name: 'Four', email: 'four@x.example' }), /capacity/);
});

test('the default cap is 50 businesses', () => {
  assert.equal(setupOwner().registry.maxBusinesses, 50);
});

// ---------------------------------------------------------------------------------------------------
// Login
test('login: the page shows the Liaisa wordmark and no business name', async () => {
  const ctx = setupOwner();
  const page = await request(ctx.app).get('/owner/login');
  assert.match(page.text, /<a class="brand brand--logo" href="\/"><img src="\/img\/liaisa-logo\.svg\?v=[0-9a-f]{10}" alt="Liaisa" width="85" height="32"><\/a>/);
  assert.ok(!page.text.includes('Mehfil Kitchen'));
  assert.match(page.text, /name="email"/);
});

async function attempt(app, email, password) {
  const page = await request(app).get('/owner/login');
  return request(app).post('/owner/login').set('Cookie', cookieOf(page)).type('form').send({ _csrf: csrfOf(page), email, password });
}

test('login: an unknown email and a wrong password get the same generic answer', async () => {
  const ctx = setupOwner();
  const unknown = await attempt(ctx.app, 'nobody@x.example', 'whatever it is');
  const wrong = await attempt(ctx.app, OWNER_EMAIL, 'not the password');
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  const msg = (r) => /class="banner tone-problem" role="alert">([^<]*)</.exec(r.text)[1];
  assert.equal(msg(unknown), msg(wrong));
  assert.ok(!/no account|not found|unknown email|wrong password/i.test(unknown.text));
  const json = await request(ctx.app).post('/owner/login').set('Accept', 'application/json').send({ email: 'nobody@x.example', password: 'x' });
  assert.equal(json.status, 403, 'JSON clients need the CSRF token too');
});

test('login: 5 failed tries per IP, then 429 even with the right password', async () => {
  const ctx = setupOwner();
  for (let i = 0; i < 5; i += 1) assert.equal((await attempt(ctx.app, i % 2 ? 'nobody@x.example' : OWNER_EMAIL, 'nope nope')).status, 401);
  const sixth = await attempt(ctx.app, OWNER_EMAIL, PASSWORD);
  assert.equal(sixth.status, 429);
  assert.match(sixth.text, /Too many tries/);
});

test('login: each owner lands in their own business, email is case-insensitive, logout ends the session', async () => {
  const ctx = await world();
  assert.match((await ctx.a.get('/owner')).text, /Mehfil Kitchen/);
  const bPage = (await ctx.b.get('/owner')).text;
  assert.match(bPage, /Spice Route/);
  assert.ok(!bPage.includes('Mehfil Kitchen') && !bPage.includes('Kavita'));
  const upper = await login(ctx.app, { email: 'OWNER@SPICEROUTE.EXAMPLE' });
  assert.match((await upper.get('/owner')).text, /Spice Route/);
  await ctx.b.postForm('/owner/logout');
  assert.equal((await ctx.b.get('/owner')).status, 302);
});

test('a session cannot be pointed at another business: the business is never read from a request', async () => {
  const ctx = await world();
  const res = await ctx.b.get(`/owner?businessId=${ctx.A.business.id}&slug=mehfil-kitchen`);
  assert.ok(!res.text.includes('Kavita') && res.text.includes('Spice Route'));
  const posted = await ctx.b.postForm('/owner/setup', { businessId: String(ctx.A.business.id), businessName: 'Hijack' });
  assert.notEqual(ctx.A.businessSettings.get().businessName, 'Hijack');
  void posted;
});

// ---------------------------------------------------------------------------------------------------
// Tenant isolation, owner routes
test('isolation: reading another business’s enquiry is a 404, both ways, HTML and JSON', async () => {
  const ctx = await world();
  const e = await bEnquiry(ctx);
  const aId = ctx.A.enquiries.list()[0].id;
  assert.equal((await ctx.a.get(`/owner/enquiries/${e.id}`)).status, 404);
  assert.equal((await ctx.a.getJson(`/owner/enquiries/${e.id}`)).status, 404);
  assert.equal((await ctx.b.get(`/owner/enquiries/${aId}`)).status, 404);
  assert.equal((await ctx.b.get(`/owner/enquiries/${e.id}`)).status, 200, 'the owner of B still sees it');
  for (const path of ['/owner', '/owner/follow-ups', '/owner/approve-clean']) {
    assert.ok(!(await ctx.a.get(path)).text.includes('Zed Customer'), `${path} of A never lists B's customer`);
  }
  const summary = await ctx.a.getJson('/owner/api/summary');
  assert.ok(!JSON.stringify(summary.body).includes('Zed'));
});

test('isolation: approve, edit, decline, reprice, retry, follow-up and WhatsApp on another business’s enquiry are 404 and change nothing', async () => {
  const ctx = await world();
  const e = await bEnquiry(ctx);
  const before = JSON.stringify([ctx.B.enquiries.get(e.id), ctx.B.estimates.listByEnquiry(e.id)]);
  const mailBefore = ctx.mailer.sent.length;
  const id = e.id;
  const calls = [
    ['approve', { estimateVersion: 1 }], ['edit', { requirements: { service_id: 'example_service', quantity: 12, event_date: '2099-12-15', location: 'Nearby area (rename me)' }, revisionReason: 'test change' }],
    ['decline', { reason: 'x' }], ['reprice', {}], ['retry-send', {}], ['followup/send', {}], ['followup/done', {}], ['whatsapp', {}],
  ];
  for (const [action, body] of calls) {
    const res = await ctx.a.postJson(`/owner/enquiries/${id}/${action}`, body);
    assert.equal(res.status, 404, action);
    assert.equal(res.body.error.code, 'not_found', action);
    const html = await ctx.a.postForm(`/owner/enquiries/${id}/${action}`, { estimateVersion: '1', revisionReason: 'test change', quantity: '12' });
    assert.equal(html.status, 404, `${action} (form)`);
  }
  assert.equal(JSON.stringify([ctx.B.enquiries.get(e.id), ctx.B.estimates.listByEnquiry(e.id)]), before);
  assert.equal(ctx.mailer.sent.length, mailBefore, 'nothing was emailed');
  // and the owner of B can do it
  assert.equal((await ctx.b.postJson(`/owner/enquiries/${id}/approve`, { estimateVersion: 1 })).status, 200);
});

test('isolation: bulk approve only ever touches the session’s business', async () => {
  const ctx = await world();
  const e = await bEnquiry(ctx);
  ctx.B.businessSettings.save({ bulkApproveLimit: 100000 });
  ctx.A.businessSettings.save({ bulkApproveLimit: 100000 });
  const res = await ctx.a.postJson('/owner/approve-clean', { ids: [e.id] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.approved, []);
  assert.equal(ctx.B.enquiries.get(e.id).status, 'awaiting_approval');
});

test('isolation: Client Finder leads, drafts and do-not-contact are per business', async () => {
  const ctx = await world();
  const lead = await ctx.b.postJson('/owner/clients/leads', { name: 'Dev Shah', contact: 'dev@corp.example', note: 'team lunches' });
  assert.equal(lead.status, 201, JSON.stringify(lead.body));
  const leadId = lead.body.id;
  assert.equal(ctx.A.leads.all().length, 0);
  assert.ok(!(await ctx.a.get('/owner/clients')).text.includes('Dev Shah'));
  assert.ok((await ctx.b.get('/owner/clients?tab=leads')).text.includes('Dev Shah'));
  assert.equal((await ctx.a.postJson(`/owner/clients/leads/${leadId}/status`, { action: 'not_interested' })).status, 404);
  assert.equal(ctx.B.leads.get(leadId).status, 'new');
  const d = await ctx.b.postJson('/owner/clients/draft', { type: 'lead', ref: String(leadId) });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  assert.equal((await ctx.a.get(`/owner/clients/drafts/${d.body.draftId}`)).status, 404);
  assert.equal((await ctx.a.postJson(`/owner/clients/drafts/${d.body.draftId}/send`, { message: 'Hi Dev, hello there from us.' })).status, 404);
  assert.equal((await ctx.a.postJson('/owner/clients/draft', { type: 'lead', ref: String(leadId) })).status, 404);
  assert.equal((await ctx.a.postJson('/owner/clients/dnc', { type: 'lead', ref: String(leadId) })).status, 404);
  assert.equal(ctx.B.leads.get(leadId).doNotContact, false);
  assert.equal(ctx.A.outreach.all().length, 0);
});

test('isolation: Setup edits and resets change only the session’s business', async () => {
  const ctx = await world();
  const aBefore = JSON.stringify([ctx.A.businessSettings.get(), ctx.A.pricingConfigs.latestApproved().configJson]);
  const page = await ctx.b.get('/owner/setup');
  assert.match(page.text, /Example service/);
  assert.ok(!page.text.includes('Veg buffet'));
  const body = { businessName: 'Spice Route 2', tagline: '', currencySymbol: '₹', whatsappNumber: '', followupAfterDays: '2', city: 'Pune', weekendPct: '0', taxPct: '0',
    svcId: ['example_service'], svcName: ['Tiffin'], svcPrice: ['120'], svcMin: ['1'], svcMax: [''], svcUnit: ['Number of people'], areaName: ['Camp'], areaFee: ['0'] };
  assert.equal((await ctx.b.postForm('/owner/setup', body)).status, 303);
  assert.equal(ctx.B.businessSettings.get().businessName, 'Spice Route 2');
  assert.equal((await ctx.b.postForm('/owner/setup/reset')).status, 303);
  assert.equal(ctx.B.businessSettings.get().businessName, 'Spice Route 2', 'reset keeps a non-demo business’s name');
  assert.equal(ctx.B.pricingConfigs.latestApproved().configJson.services[0].id, 'example_service', 'and does not copy the demo catalogue');
  assert.equal(JSON.stringify([ctx.A.businessSettings.get(), ctx.A.pricingConfigs.latestApproved().configJson]), aBefore);
});

test('isolation: the QR and the share link are each business’s own', async () => {
  const ctx = await world();
  const asText = (res, cb) => { let d = ''; res.setEncoding('utf8'); res.on('data', (c) => { d += c; }); res.on('end', () => cb(null, d)); };
  const qr = (o) => request(ctx.app).get('/owner/enquiry-qr.svg').set('Cookie', o.cookie).buffer(true).parse(asText);
  const qa = await qr(ctx.a);
  const qb = await qr(ctx.b);
  assert.equal(qa.status, 200);
  assert.equal(qb.status, 200);
  assert.notEqual(qa.body, qb.body);
  const ra = await ctx.a.get('/owner/setup');
  const rb = await ctx.b.get('/owner/setup');
  assert.ok(ra.text.includes('value="https://liaisa.co.in/b/mehfil-kitchen/enquire"'));
  assert.ok(rb.text.includes('value="https://liaisa.co.in/b/spice-route/enquire"'));
  assert.ok(!rb.text.includes('mehfil-kitchen/enquire'));
});

test('owner area: no session means no business, whatever is asked for', async () => {
  const ctx = await world();
  for (const path of ['/owner', '/owner/setup', '/owner/clients', '/owner/enquiry-qr.svg', `/owner/enquiries/${ctx.A.enquiries.list()[0].id}`]) {
    assert.equal((await request(ctx.app).get(path)).status, 302, path);
    assert.equal((await request(ctx.app).get(path).set('Accept', 'application/json')).status, 401, path);
  }
});

// ---------------------------------------------------------------------------------------------------
// Signed links and customer pages
test('signed links carry the businessId: tampering breaks the signature, and a link never opens another business’s data', async () => {
  const ctx = await world();
  const e = await bEnquiry(ctx);
  const aEnquiry = ctx.A.enquiries.list().find((x) => x.status === 'awaiting_approval');
  const v = ctx.B.estimates.listByEnquiry(e.id)[0].version;
  const good = signLink(SECRET, { businessId: ctx.B.business.id, enquiryId: e.id, version: v, action: 'approve' });
  assert.equal(verifyLink(SECRET, good).payload.businessId, ctx.B.business.id);

  // change the business inside the payload, keep the signature
  const [body, sig] = good.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), b: ctx.A.business.id })).toString('base64url');
  assert.equal(verifyLink(SECRET, `${forged}.${sig}`).reason, 'tampered');
  assert.equal((await request(ctx.app).get(`/a/${forged}.${sig}`)).status, 400);

  // a link for business A that names an enquiry id which only exists in B
  const crossed = signLink(SECRET, { businessId: ctx.A.business.id, enquiryId: e.id, version: v, action: 'approve' });
  const page = await request(ctx.app).get(`/a/${crossed}`);
  assert.equal(page.status, 404);
  assert.ok(!page.text.includes('Zed'));
  // and a link without a business is not valid at all
  const bare = signLink(SECRET, { enquiryId: e.id, version: v, action: 'approve' });
  assert.equal(verifyLink(SECRET, bare).ok, false);
  assert.equal(ctx.B.enquiries.get(e.id).status, 'awaiting_approval');

  // a link for an unknown business
  const ghost = signLink(SECRET, { businessId: 999, enquiryId: e.id, version: v, action: 'approve' });
  assert.equal((await request(ctx.app).get(`/a/${ghost}`)).status, 404);

  // the genuine link works, and only on B (the other owner being logged in changes nothing)
  const ok = await request(ctx.app).get(`/a/${good}`).set('Cookie', ctx.a.cookie);
  assert.equal(ok.status, 200);
  assert.match(ok.text, /Spice Route/);
  assert.equal(ctx.A.enquiries.get(aEnquiry.id).status, 'awaiting_approval');
});

test('a one-tap approve from the owner notice approves in the right business and emails the right owner', async () => {
  const ctx = await world();
  await bEnquiry(ctx);
  await new Promise((r) => setTimeout(r, 30)); // the notice is sent in the background
  const notice = ctx.mailer.sent.find((m) => /Spice Route|ready|quote/i.test(m.subject + m.text) && m.to === 'owner@spiceroute.example');
  assert.ok(notice, JSON.stringify(ctx.mailer.sent.map((m) => [m.to, m.subject])));
  assert.ok(!ctx.mailer.sent.some((m) => m.to === OWNER_EMAIL), 'the demo owner got nothing about business B');
  assert.match(notice.from, /Spice Route via Liaisa/);
  const approve = /https?:\/\/[^\s"]+\/a\/([A-Za-z0-9_.-]+)/.exec(notice.text)[1];
  assert.equal(verifyLink(SECRET, approve).payload.businessId, ctx.B.business.id);
  const agent = request.agent(ctx.app);
  const confirm = await agent.get(`/a/${approve}`);
  assert.equal(confirm.status, 200);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(confirm.text)[1];
  const done = await agent.post(`/a/${approve}`).type('form').send({ _csrf: csrf });
  assert.equal(done.status, 200);
  assert.ok(['sent', 'approved'].includes(ctx.B.estimates.listByEnquiry(ctx.B.enquiries.list()[0].id)[0].status));
  const sent = ctx.mailer.sent.at(-1);
  assert.equal(sent.to, 'zed@example.test');
  assert.match(sent.text, /\/b\/spice-route\/q\//);
  assert.equal(sent.replyTo, 'owner@spiceroute.example');
});

test('customer pages: each business shows its own name and catalogue, and quote tokens work only under their own slug', async () => {
  const ctx = await world();
  const e = await bEnquiry(ctx);
  const a = await request(ctx.app).get('/b/mehfil-kitchen/enquire');
  const b = await request(ctx.app).get('/b/spice-route/enquire');
  assert.match(a.text, /Mehfil Kitchen/);
  assert.match(b.text, /Spice Route/);
  assert.ok(!b.text.includes('Mehfil'));
  assert.equal((await request(ctx.app).get('/b/nope/enquire')).status, 404);
  assert.equal((await request(ctx.app).get('/b/nope/q/abc').set('Accept', 'application/json')).status, 404);
  assert.match((await request(ctx.app).get('/enquire')).headers.location, /^\/b\/mehfil-kitchen\/enquire$/);

  await ctx.b.postJson(`/owner/enquiries/${e.id}/approve`, { estimateVersion: 1 });
  const tokenB = ctx.B.estimates.listByEnquiry(e.id)[0].quoteToken;
  const tokenA = ctx.A.estimates.listByEnquiry(ctx.A.enquiries.list().find((x) => x.status === 'quoted').id)[0].quoteToken;
  const own = await request(ctx.app).get(`/b/spice-route/q/${tokenB}`);
  assert.equal(own.status, 200);
  assert.match(own.text, /Spice Route/);
  assert.match(own.text, new RegExp(`action="/b/spice-route/q/${tokenB}/accept"`));
  assert.equal((await request(ctx.app).get(`/b/mehfil-kitchen/q/${tokenB}`)).status, 404, 'B’s token under A’s slug');
  assert.equal((await request(ctx.app).get(`/b/spice-route/q/${tokenA}`)).status, 404, 'A’s token under B’s slug');
  assert.equal((await request(ctx.app).post(`/b/mehfil-kitchen/q/${tokenB}/accept`).set('Accept', 'application/json')).status, 404);
  assert.equal(ctx.B.enquiries.get(e.id).status, 'quoted');
  // A customer can't answer an enquiry of another business either
  const pid = e.publicId;
  const wrong = await request(ctx.app).post(`/b/mehfil-kitchen/api/enquiries/${pid}/reply`).send({ answer: 'hello' });
  assert.equal(wrong.status, 404);
});

// ---------------------------------------------------------------------------------------------------
// Pricing and the agent use the right catalogue
test('pricing uses the right business’s prices: the same quantity costs what that business charges', async () => {
  const ctx = await world();
  const e = await bEnquiry(ctx);
  const est = ctx.B.estimates.listByEnquiry(e.id)[0];
  assert.equal(est.total, 5000, 'example service: 500 x 10, no tax, no surcharge');
  assert.equal(est.businessId, ctx.B.business.id);
  // the demo's service id means nothing in B
  const row = ctx.B.enquiries.create({ customerName: 'Q', customerEmail: 'q@example.test', preferredChannel: 'email', rawText: 'Veg buffet for forty', status: 'collecting' });
  const bad = await request(ctx.app).post(`/b/spice-route/api/enquiries/${row.publicId}/form`).send({ service_id: 'veg_buffet', quantity: 40, event_date: '2099-12-15', location: 'Koramangala' });
  assert.equal(bad.status, 400);
  // and A's catalogue still prices as before
  const aEst = ctx.A.estimates.listByEnquiry(ctx.A.enquiries.list().find((x) => x.status === 'awaiting_approval').id)[0];
  assert.ok(aEst.total > 5000);
});

test('the agent is given the right business’s catalogue and name', async () => {
  const ctx = await world({ steps: [...scenarios.needs_info(), ...scenarios.needs_info()] });
  await request(ctx.app).post('/b/spice-route/api/enquiries').send({ name: 'Q', channel: 'email', email: 'q@example.test', description: 'Something for ten people' });
  await request(ctx.app).post('/b/mehfil-kitchen/api/enquiries').send({ name: 'R', channel: 'email', email: 'r@example.test', description: 'Veg lunch for forty people' });
  const [forB, forA] = ctx.ai.calls.map((c) => JSON.stringify(c));
  assert.ok(forB.includes('Example service') && forB.includes('Spice Route'));
  assert.ok(!forB.includes('Veg buffet') && !forB.includes('Mehfil'));
  assert.ok(forA.includes('Veg buffet') && forA.includes('Mehfil Kitchen'));
  assert.ok(!forA.includes('Example service') && !forA.includes('Spice Route'));
});

// ---------------------------------------------------------------------------------------------------
// Budget protection
test('new businesses get lower caps than the demo; per-business AI use shows in Setup', async () => {
  const ctx = await world();
  const { limitsOf } = await import('../../src/services/tenants/limits.js');
  assert.deepEqual(limitsOf(ctx.A, ctx.config), { aiRequests: 200, drafts: 20, discoveryRuns: 10 });
  assert.deepEqual(limitsOf(ctx.B, ctx.config), { aiRequests: 40, drafts: 5, discoveryRuns: 3 });
  const a = await ctx.a.get('/owner/setup');
  const b = await ctx.b.get('/owner/setup');
  assert.match(a.text, /AI requests: \d+ of 200/);
  assert.match(a.text, /Message drafts: 0 of 20/);
  assert.match(b.text, /AI requests: 0 of 40/);
  assert.match(b.text, /Message drafts: 0 of 5/);
  assert.match(b.text, /Searches for clients: 0 of 3/);
  // the Client Finder page shows the business's own caps
  assert.match((await ctx.b.get('/owner/clients')).text, /Drafts today: 0 of 5/);
});

test('a new business’s draft cap is 5 a day and does not touch the demo’s', async () => {
  const ctx = await world();
  const ids = [];
  for (let i = 0; i < 6; i += 1) {
    const lead = ctx.B.leads.create({ name: `Lead ${i}`, email: `l${i}@corp.example`, note: 'n' });
    ids.push(lead.id);
  }
  const results = [];
  for (const id of ids) results.push((await ctx.b.postJson('/owner/clients/draft', { type: 'lead', ref: String(id) })).status);
  assert.deepEqual(results, [201, 201, 201, 201, 201, 409]);
  assert.equal(ctx.A.outreach.all().length, 0);
});

test('the global AI cap: once all businesses together reach it, enquiries fall back to the form with a friendly note', async () => {
  const ctx = await world({ env: { AI_GLOBAL_DAILY_CAP: '4' }, steps: [] });
  // 3 calls made by A and 1 by B today: the platform is at its cap although neither business is at its own
  const now = new Date();
  for (let i = 0; i < 3; i += 1) ctx.A.aiCalls.create({ purpose: 'intake', model: 'm', inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1, ok: true }, now);
  ctx.B.aiCalls.create({ purpose: 'intake', model: 'm', inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1, ok: true }, now);
  const before = ctx.ai.calls.length;
  const res = await request(ctx.app).post('/b/spice-route/api/enquiries').send({ name: 'Q', channel: 'email', email: 'q@example.test', description: 'Something for ten people' });
  assert.equal(res.status, 201);
  assert.equal(res.body.outcome, 'fallback');
  assert.match(res.body.message, /AI is resting for today, the form still works/);
  assert.equal(ctx.ai.calls.length, before, 'no AI call was made');
  // the page says it too, and the form still works
  const html = await request(ctx.app).post('/b/mehfil-kitchen/api/enquiries').set('Accept', 'text/html').type('form')
    .send({ name: 'Priya', channel: 'email', email: 'priya@example.test', description: 'Veg lunch for forty' });
  assert.equal(html.status, 201);
  assert.match(html.text, /AI is resting for today, the form still works/);
  assert.match(html.text, /name="service_id"/);
  const e = ctx.B.enquiries.getByPublicId(res.body.publicId);
  const form = await request(ctx.app).post(`/b/spice-route/api/enquiries/${e.publicId}/form`).send(FORM);
  assert.equal(form.body.outcome, 'ready');
  assert.equal(ctx.B.enquiries.get(e.id).status, 'awaiting_approval');
});

test('the global cap also stops drafts (template instead of AI) and client discovery', async () => {
  const ctx = await world({ env: { AI_GLOBAL_DAILY_CAP: '1' } });
  ctx.A.aiCalls.create({ purpose: 'intake', model: 'm', inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1, ok: true });
  const found = await ctx.b.postJson('/owner/clients/discover', {});
  assert.equal(found.status, 409);
  assert.equal(found.body.error.code, 'ai_cap');
  assert.match(found.body.error.message, /resting/i);
  const lead = ctx.B.leads.create({ name: 'Lead', email: 'l@corp.example', note: 'n' });
  const callsBefore = ctx.ai.calls.length;
  const d = await ctx.b.postJson('/owner/clients/draft', { type: 'lead', ref: String(lead.id) });
  assert.equal(d.status, 201);
  assert.equal(ctx.ai.calls.length, callsBefore, 'the template was used, no AI call');
});

test('a business’s own daily AI cap does not use up another business’s', async () => {
  const ctx = await world({ env: { NEW_BUSINESS_AI_DAILY_CAP: '1' }, steps: [...scenarios.needs_info(), ...scenarios.needs_info()] });
  ctx.B.aiCalls.create({ purpose: 'intake', model: 'm', inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1, ok: true });
  const b = await request(ctx.app).post('/b/spice-route/api/enquiries').send({ name: 'Q', channel: 'email', email: 'q@example.test', description: 'Something for ten people' });
  assert.equal(b.body.outcome, 'fallback');
  const a = await request(ctx.app).post('/b/mehfil-kitchen/api/enquiries').send({ name: 'R', channel: 'email', email: 'r@example.test', description: 'Veg lunch for forty people' });
  assert.equal(a.body.outcome, 'needs_info', 'the demo still has its AI');
});

test('per-IP limit on enquiry creation covers every business together', async () => {
  const ctx = await world({ steps: [] });
  const post = (slug) => request(ctx.app).post(`/b/${slug}/api/enquiries`).send({ name: 'Q', channel: 'email', email: 'q@example.test', description: 'x' }); // too short: 400, still counted
  const statuses = [];
  for (const slug of ['spice-route', 'mehfil-kitchen', 'spice-route', 'mehfil-kitchen']) statuses.push((await post(slug)).status);
  assert.deepEqual(statuses.slice(0, 3), [400, 400, 400]);
  assert.equal(statuses[3], 429);
});
