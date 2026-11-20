// M11/M12: Approvals inbox, decline reasons, bulk approve, auto-approve, one-tap signed links, voice briefing, UI foundations.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import request from 'supertest';
import { setupOwner, login, byName, estimateOf, makeEnquiry, OWNER_EMAIL } from '../helpers/ownerApp.js';
import { signLink, verifyLink, LINK_HOURS } from '../../src/services/quotes/oneTap.js';

const SECRET = 'x'.repeat(48);
const HOUR = 3600 * 1000;
const tick = () => new Promise((r) => setTimeout(r, 30));
async function world(opts) {
  const ctx = setupOwner(opts);
  const o = await login(ctx.app);
  return { ...ctx, o };
}
/** A ready enquiry via the fallback form (the same path the agent takes at the end). */
async function ready(ctx, { name = 'Tara Sen', channel = 'email', quantity = 40, location = 'Koramangala' } = {}) {
  const e = ctx.repos.enquiries.create({
    customerName: name, customerEmail: channel === 'email' ? `${name.split(' ')[0].toLowerCase()}@example.test` : null,
    customerPhone: channel === 'whatsapp' ? '919845012345' : null, preferredChannel: channel, rawText: 'Veg lunch', status: 'collecting',
  });
  await request(ctx.app).post(`/api/enquiries/${e.publicId}/form`).send({ service_id: 'veg_buffet', quantity, event_date: '2026-12-15', location });
  await tick();
  return ctx.repos.enquiries.get(e.id);
}
const customerMail = (ctx) => ctx.mailer.sent.filter((m) => /^Your quote from/.test(m.subject));
const ownerMail = (ctx) => ctx.mailer.sent.filter((m) => m.to === OWNER_EMAIL);
const linksIn = (mail) => ({ approve: /\/a\/([\w.-]+)/.exec(mail.text.split('Approve and send: ')[1])[1], decline: /\/a\/([\w.-]+)/.exec(mail.text.split('Decline: ')[1])[1] });

// ---- Approvals inbox ---------------------------------------------------------------------------

test('Approvals inbox: a card per item with customer, service, quantity, date, total, a text chip per warning, big Approve and Decline, Edit as a link', async () => {
  const ctx = await world();
  const page = await ctx.o.get('/owner');
  assert.equal((page.text.match(/data-approval/g) ?? []).length, 2);
  const kavita = page.text.slice(page.text.indexOf('<h3 class="approval__name">Kavita Reddy'), page.text.indexOf('<h3 class="approval__name">Arjun Mehta'));
  for (const text of ['Veg buffet', '60 guests', 'Sat 12 Dec', '₹36,729', 'No warnings', 'Approve</button>', 'Decline</button>', 'Edit or see details']) assert.ok(kavita.includes(text), text);
  const arjun = page.text.slice(page.text.indexOf('<h3 class="approval__name">Arjun Mehta'));
  assert.match(arjun, /<li class="chip tone-needs"><span aria-hidden="true">⚠<\/span> Fewer guests \(15\) than this service’s minimum \(20\)\.<\/li>/, 'a warning is text, not only colour');
  assert.match(arjun, /Needs your review/);
  assert.match(page.text, /data-confirm="Send ₹36,729 quote to Kavita by email\?"/);
  assert.match(page.text, /<h2 id="wait-h">Waiting for you \(2\)<\/h2>/);
  assert.equal((page.text.match(/class="stat"/g) ?? []).length, 4, 'four stat cards');
  assert.match(page.text, /Follow-up due \(0\)/);
  assert.match(page.text, /<h2>Sent quotes \(2\)<\/h2>/);
  assert.match(page.text, /<h2>Accepted \(1\)<\/h2>/);
  assert.match(page.text, /<dialog class="sheet-dialog" id="decline-\d+"/);
  assert.match(page.text, /<textarea id="reason-\d+" name="reason" rows="2" maxlength="200">/);
});

test('owner layout: a bottom tab bar and a sidebar, four destinations, the waiting count on Approvals', async () => {
  const ctx = await world();
  const page = await ctx.o.get('/owner');
  assert.match(page.text, /<nav class="tabbar" aria-label="Owner">/);
  assert.match(page.text, /<aside class="sidebar" aria-label="Owner">/);
  for (const [href, label] of [['/owner', 'Approvals'], ['/owner/clients', 'Clients'], ['/owner/follow-ups', 'Follow-ups'], ['/owner/setup', 'Setup']]) {
    assert.match(page.text, new RegExp(`<a href="${href.replace(/\//g, '\\/')}"[^>]*>[\\s\\S]*?${label}`), label);
  }
  assert.match(page.text, /aria-current="page"/);
  assert.match(page.text, /<span class="count" aria-label="2 waiting">2<\/span>/);
  for (const path of ['/owner/clients', '/owner/follow-ups', '/owner/setup']) {
    const p = await ctx.o.get(path);
    assert.equal(p.status, 200, path);
    assert.match(p.text, /class="tabbar"/);
  }
});

test('empty states give a short instruction', async () => {
  const ctx = await world();
  for (const e of ctx.repos.enquiries.list()) ctx.repos.enquiries.update(e.id, { status: 'declined' });
  const page = await ctx.o.get('/owner');
  assert.match(page.text, /Nothing needs you right now\.<\/strong>New enquiries will appear here\. Share your enquiry link/);
  assert.match(page.text, /No sent quotes are waiting for a reminder\./);
  assert.match(page.text, /No quotes sent yet\./);
  assert.match((await ctx.o.get('/owner/follow-ups')).text, /No sent quotes are waiting for a reminder\./);
});

test('Decline with an optional reason: nothing is sent, the reason is kept and shown in Activity', async () => {
  const ctx = await world();
  const kavita = byName(ctx.repos, 'Kavita Reddy');
  const res = await ctx.o.postForm(`/owner/enquiries/${kavita.id}/decline`, { reason: 'Too far\nfor us ' });
  assert.equal(res.headers.location, '/owner?n=declined');
  const e = ctx.repos.enquiries.get(kavita.id);
  assert.deepEqual([e.status, e.declineReason], ['declined', 'Too far for us']);
  assert.equal(ctx.mailer.sent.length, 0);
  assert.match((await ctx.o.get(`/owner/enquiries/${kavita.id}`)).text, /<li>Declined: Too far for us · just now<\/li>/);
  const arjun = byName(ctx.repos, 'Arjun Mehta');
  assert.equal((await ctx.o.postJson(`/owner/enquiries/${arjun.id}/decline`)).status, 200, 'the reason is optional');
  assert.equal(ctx.repos.enquiries.get(arjun.id).declineReason, undefined);
});

test('enquiry detail: stacked sections, a sticky action bar, the decline sheet, Edit as an inline form', async () => {
  const ctx = await world();
  const kavita = byName(ctx.repos, 'Kavita Reddy');
  const page = await ctx.o.get(`/owner/enquiries/${kavita.id}`);
  assert.match(page.text, /class="action-bar action-bar--sticky"/);
  assert.match(page.text, /data-sheet="decline-sheet"/);
  assert.match(page.text, /<dialog class="sheet-dialog" id="decline-sheet"/);
  assert.match(page.text, /href="#edit" data-open="edit"/);
  assert.match(page.text, /<details class="edit edit--bar" id="edit"/);
});

// ---- Approve all clean quotes ------------------------------------------------------------------

test('bulk approve: no limit means no button and an explanation', async () => {
  const ctx = await world();
  const page = await ctx.o.get('/owner');
  assert.ok(!page.text.includes('Approve all clean quotes'));
  assert.match(page.text, /Set a limit for clean quotes/);
  const confirm = await ctx.o.get('/owner/approve-clean');
  assert.match(confirm.text, /No limit set yet\./);
  assert.ok(!confirm.text.includes('name="ids"'));
});

test('bulk approve: the confirmation lists exactly the clean quotes; warned quotes and quotes over the limit are never included', async () => {
  const ctx = await world();
  const small = makeEnquiry(ctx.repos, { name: 'Small Order', quantity: 40 }); // 18,900
  const big = makeEnquiry(ctx.repos, { name: 'Big Order', quantity: 150 }); // 71,000+: over the limit
  const kavita = byName(ctx.repos, 'Kavita Reddy'); // 36,729, no warnings
  const arjun = byName(ctx.repos, 'Arjun Mehta'); // a warning
  assert.deepEqual((estimateOf(ctx.repos, arjun).warningsJson), ['below_min_qty']);
  ctx.repos.businessSettings.save({ bulkApproveLimit: 40000 });
  const home = await ctx.o.get('/owner');
  assert.match(home.text, /Approve all clean quotes \(2\)/);
  const page = await ctx.o.get('/owner/approve-clean');
  assert.match(page.text, /exactly what will be approved/);
  for (const name of ['Small Order', 'Kavita Reddy']) assert.ok(page.text.includes(`<strong>${name}</strong>`), name);
  for (const name of ['Big Order', 'Arjun Mehta']) assert.ok(!page.text.includes(`<strong>${name}</strong>`), `${name} is not listed`);
  assert.match(page.text, /₹18,900/);
  assert.match(page.text, /₹36,729/);
  assert.match(page.text, /2 quotes · ₹55,629 in total/);
  assert.equal((page.text.match(/name="ids"/g) ?? []).length, 2);

  // Even if a warned or too-big quote's id is sent, it is skipped. Only the listed clean ones are approved.
  const res = await ctx.o.postJson('/owner/approve-clean', { ids: [small.id, kavita.id, arjun.id, big.id] });
  assert.deepEqual(res.body.approved.map((a) => a.name).sort(), ['Kavita Reddy', 'Small Order']);
  assert.deepEqual(res.body.skipped.sort(), [arjun.id, big.id].sort());
  assert.equal(estimateOf(ctx.repos, arjun).status, 'draft');
  assert.equal(estimateOf(ctx.repos, big).status, 'draft');
  assert.deepEqual([estimateOf(ctx.repos, small).status, estimateOf(ctx.repos, kavita).status], ['sent', 'sent']);
  assert.equal(customerMail(ctx).length, 2);
  assert.match((await ctx.o.get(`/owner/enquiries/${small.id}`)).text, /Approved with “Approve all clean quotes”/);
});

test('bulk approve: the form posts the listed ids, redirects with a count, and changed quotes are skipped', async () => {
  const ctx = await world();
  const small = makeEnquiry(ctx.repos, { name: 'Small Order', quantity: 40 });
  ctx.repos.businessSettings.save({ bulkApproveLimit: 40000 });
  const page = await ctx.o.get('/owner/approve-clean');
  assert.match(page.text, /Approve &amp; send 2 quotes/);
  // The limit is lowered after the owner opened the page: Kavita is no longer clean, so she is skipped.
  ctx.repos.businessSettings.save({ bulkApproveLimit: 30000 });
  const kavita = byName(ctx.repos, 'Kavita Reddy');
  const res = await ctx.o.postForm('/owner/approve-clean', { ids: [String(small.id), String(kavita.id)] });
  assert.equal(res.headers.location, '/owner?n=bulk_done&c=1');
  assert.match((await ctx.o.get(res.headers.location)).text, /1 quote approved\./);
  assert.equal(estimateOf(ctx.repos, kavita).status, 'draft');
  assert.equal(customerMail(ctx).length, 1);
  assert.match((await ctx.o.get('/owner?n=bulk_done&c=0')).text, /No clean quotes were left to approve\./);
  assert.match((await ctx.o.get('/owner?n=bulk_done&c=abc')).text, /No clean quotes were left/, 'the count in the URL is validated');
});

test('bulk approve needs the owner session and a CSRF token', async () => {
  const ctx = await world();
  ctx.repos.businessSettings.save({ bulkApproveLimit: 99999 });
  const kavita = byName(ctx.repos, 'Kavita Reddy');
  assert.equal((await request(ctx.app).post('/owner/approve-clean').type('form').send({ ids: kavita.id })).status, 302);
  assert.equal((await request(ctx.app).post('/owner/approve-clean').set('Cookie', ctx.o.cookie).type('form').send({ ids: kavita.id })).status, 403);
  assert.equal((await request(ctx.app).get('/owner/approve-clean')).status, 302);
  assert.equal(estimateOf(ctx.repos, kavita).status, 'draft');
});

// ---- Optional auto-approve ---------------------------------------------------------------------

test('auto-approve is OFF by default: a clean quote waits for the owner and the owner is told with one-tap links', async () => {
  const ctx = await world();
  assert.equal(ctx.repos.businessSettings.get().autoApprove, false);
  assert.match((await ctx.o.get('/owner/setup')).text, /<input id="autoApprove" name="autoApprove" type="checkbox" value="on">/, 'unchecked');
  const e = await ready(ctx);
  assert.equal(customerMail(ctx).length, 0);
  assert.equal(ctx.repos.enquiries.get(e.id).status, 'awaiting_approval');
  assert.equal(ownerMail(ctx).length, 1);
});

test('auto-approve needs a limit: the setup form refuses to turn it on without one', async () => {
  const ctx = await world();
  const form = (extra) => ({
    businessName: 'Mehfil Kitchen', tagline: '', currencySymbol: '₹', whatsappNumber: '', city: 'Bengaluru', followupAfterDays: '2', weekendPct: '10', taxPct: '5',
    svcId: ['veg_buffet'], svcName: ['Veg buffet'], svcPrice: ['450'], svcMin: ['20'], svcMax: ['200'], svcUnit: ['Number of guests'], areaName: ['Koramangala'], areaFee: ['0'], ...extra,
  });
  const bad = await ctx.o.postForm('/owner/setup', form({ autoApprove: 'on', bulkApproveLimit: '' }));
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Set a limit first, so auto-approve knows what a clean quote is\./);
  assert.equal(ctx.repos.businessSettings.get().autoApprove, false);
  const worse = await ctx.o.postForm('/owner/setup', form({ bulkApproveLimit: '-5' }));
  assert.match(worse.text, /Enter a whole number of rupees, or leave it empty\./);
  assert.equal((await ctx.o.postForm('/owner/setup', form({ autoApprove: 'on', bulkApproveLimit: '25000' }))).status, 303);
  assert.deepEqual([ctx.repos.businessSettings.get().autoApprove, ctx.repos.businessSettings.get().bulkApproveLimit], [true, 25000]);
  assert.equal((await ctx.o.postForm('/owner/setup', form({ bulkApproveLimit: '25000' }))).status, 303);
  assert.equal(ctx.repos.businessSettings.get().autoApprove, false, 'an unticked box turns it off');
});

test('auto-approve ON: a clean email quote within the limit is sent without asking and logged as sent automatically', async () => {
  const ctx = await world();
  ctx.repos.businessSettings.save({ autoApprove: true, bulkApproveLimit: 25000 });
  const e = await ready(ctx); // 18,900 + weekend-free Tuesday: clean
  assert.equal(estimateOf(ctx.repos, e).warningsJson.length, 0);
  assert.equal(ctx.repos.enquiries.get(e.id).status, 'quoted');
  assert.equal(estimateOf(ctx.repos, e).status, 'sent');
  assert.equal(customerMail(ctx).length, 1);
  assert.equal(customerMail(ctx)[0].to, 'tara@example.test');
  assert.equal(ownerMail(ctx).length, 0, 'no "please approve" email for something already sent');
  assert.match((await ctx.o.get(`/owner/enquiries/${e.id}`)).text, /<li>Sent automatically \(auto-approve is on\) · /);
});

test('auto-approve never covers a quote with a warning, one over the limit, or a WhatsApp customer', async () => {
  const ctx = await world();
  ctx.repos.businessSettings.save({ autoApprove: true, bulkApproveLimit: 25000 });
  const warned = await ready(ctx, { name: 'Warned Wendy', quantity: 10 }); // below the 20-guest minimum
  assert.deepEqual(estimateOf(ctx.repos, warned).warningsJson, ['below_min_qty']);
  const unknown = await ready(ctx, { name: 'Unknown Area', location: 'Mysore' }); // unknown location warning
  assert.ok(estimateOf(ctx.repos, unknown).warningsJson.includes('unknown_location'));
  const over = await ready(ctx, { name: 'Over Limit', quantity: 150 });
  const wa = await ready(ctx, { name: 'Wa Customer', channel: 'whatsapp' });
  for (const e of [warned, unknown, over, wa]) {
    assert.equal(estimateOf(ctx.repos, e).status, 'draft', e.customerName);
    assert.equal(ctx.repos.enquiries.get(e.id).status, 'awaiting_approval', e.customerName);
  }
  assert.equal(customerMail(ctx).length, 0);
  assert.equal(ownerMail(ctx).length, 4, 'the owner is told about each, with one-tap links');
  assert.ok(ctx.repos.activity.all().every((a) => !/automatically/.test(a.text)));
});

test('auto-approve does nothing when email is off, even when switched on', async () => {
  const ctx = await world({ mail: 'off' });
  ctx.repos.businessSettings.save({ autoApprove: true, bulkApproveLimit: 25000 });
  const e = await ready(ctx);
  assert.equal(estimateOf(ctx.repos, e).status, 'draft');
});

// ---- One-tap signed links ----------------------------------------------------------------------

test('signed links: valid, expired after 24 hours, tampered, malformed, wrong secret, and every token is different', () => {
  const now = new Date('2026-12-01T10:00:00Z');
  const t = signLink(SECRET, { enquiryId: 7, version: 2, action: 'approve' }, now);
  const ok = verifyLink(SECRET, t, new Date(now.getTime() + 23 * HOUR));
  assert.equal(ok.ok, true);
  assert.deepEqual([ok.payload.enquiryId, ok.payload.version, ok.payload.action], [7, 2, 'approve']);
  assert.equal(ok.payload.expires.getTime(), now.getTime() + LINK_HOURS * HOUR);
  assert.deepEqual(verifyLink(SECRET, t, new Date(now.getTime() + 24 * HOUR)), { ok: false, reason: 'expired' });
  assert.deepEqual(verifyLink('y'.repeat(48), t, now), { ok: false, reason: 'tampered' });
  const [body, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), a: 'decline' })).toString('base64url');
  assert.equal(verifyLink(SECRET, `${forged}.${sig}`, now).reason, 'tampered', 'changing the action breaks the signature');
  assert.equal(verifyLink(SECRET, `${body}.${sig.slice(0, -2)}AA`, now).reason, 'tampered');
  for (const junk of ['', 'abc', 'a.b.c', `${body}.`, 'x'.repeat(500), null, undefined, 42]) assert.equal(verifyLink(SECRET, junk, now).ok, false, String(junk));
  assert.notEqual(signLink(SECRET, { enquiryId: 7, version: 2, action: 'approve' }, now), t, 'a random id makes each link unique');
});

test('the owner notice email carries signed Approve and Decline links plus the review link', async () => {
  const ctx = await world();
  const e = await ready(ctx);
  const [mail] = ownerMail(ctx);
  assert.match(mail.text, /Quote total: ₹18,900 · no warnings/);
  assert.match(mail.text, /Approve and send: https:\/\/liaisa\.co\.in\/a\//);
  assert.match(mail.text, /Decline: https:\/\/liaisa\.co\.in\/a\//);
  assert.match(mail.text, new RegExp(`Review in Liaisa: https://liaisa\\.co\\.in/owner/enquiries/${e.id}`));
  const links = linksIn(mail);
  assert.equal(verifyLink(SECRET, links.approve).payload.action, 'approve');
  assert.equal(verifyLink(SECRET, links.decline).payload.action, 'decline');
  assert.equal(verifyLink(SECRET, links.approve).payload.version, 1);
  const warned = await ready(ctx, { name: 'Warned Wendy', quantity: 10 });
  assert.match(ownerMail(ctx).at(-1).text, /1 warning: check before approving/);
  assert.ok(warned);
});

test('a link only opens a confirm page on GET: nothing happens until a POST with the CSRF token', async () => {
  const ctx = await world();
  const e = await ready(ctx);
  const { approve } = linksIn(ownerMail(ctx)[0]);
  const get = await request(ctx.app).get(`/a/${approve}`);
  assert.equal(get.status, 200);
  assert.match(get.text, /Approve and send/);
  assert.match(get.text, /₹18,900/);
  assert.match(get.text, /<button class="btn lg block" type="submit">Approve &amp; send<\/button>/);
  assert.equal(ctx.repos.enquiries.get(e.id).status, 'awaiting_approval', 'a GET never acts');
  assert.equal(customerMail(ctx).length, 0);
  assert.match(get.headers['cache-control'], /no-store/);
  const cookie = (get.headers['set-cookie'] ?? []).join(';');
  assert.match(cookie, /liaisa\.otc=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  // A prefetch, crawler or link scanner that only GETs changes nothing, however often.
  for (let i = 0; i < 3; i += 1) await request(ctx.app).get(`/a/${approve}`);
  assert.equal(estimateOf(ctx.repos, e).status, 'draft');
});

test('POST needs the CSRF cookie and the matching hidden field', async () => {
  const ctx = await world();
  const e = await ready(ctx);
  const { approve } = linksIn(ownerMail(ctx)[0]);
  const get = await request(ctx.app).get(`/a/${approve}`);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(get.text)[1];
  const cookie = /liaisa\.otc=[^;]+/.exec((get.headers['set-cookie'] ?? []).join(';'))[0];
  assert.equal(cookie.split('=')[1], csrf);
  const attempts = [
    request(ctx.app).post(`/a/${approve}`).type('form').send({}),
    request(ctx.app).post(`/a/${approve}`).type('form').send({ _csrf: csrf }),
    request(ctx.app).post(`/a/${approve}`).set('Cookie', cookie).type('form').send({}),
    request(ctx.app).post(`/a/${approve}`).set('Cookie', cookie).type('form').send({ _csrf: 'something-else' }),
    request(ctx.app).post(`/a/${approve}`).set('Cookie', 'liaisa.otc=forged').type('form').send({ _csrf: 'forged-other' }),
  ];
  for (const res of await Promise.all(attempts)) { assert.equal((await res).status, 403); }
  assert.equal(estimateOf(ctx.repos, e).status, 'draft');
  const ok = await request(ctx.app).post(`/a/${approve}`).set('Cookie', cookie).type('form').send({ _csrf: csrf });
  assert.equal(ok.status, 200);
  assert.match(ok.text, /Approved and sent/);
  assert.equal(estimateOf(ctx.repos, e).status, 'sent');
  assert.equal(customerMail(ctx).length, 1);
});

/** Open the confirm page and submit it. */
async function tap(app, token) {
  const get = await request(app).get(`/a/${token}`);
  if (get.status !== 200) return get;
  const csrf = /name="_csrf" value="([^"]+)"/.exec(get.text)[1];
  const cookie = /liaisa\.otc=[^;]+/.exec((get.headers['set-cookie'] ?? []).join(';'))[0];
  return request(app).post(`/a/${token}`).set('Cookie', cookie).type('form').send({ _csrf: csrf });
}

test('a link works once: reuse is rejected, even from another device, and it is logged in Activity', async () => {
  const ctx = await world();
  const e = await ready(ctx);
  const { approve } = linksIn(ownerMail(ctx)[0]);
  const first = await tap(ctx.app, approve);
  assert.equal(first.status, 200);
  const again = await tap(ctx.app, approve);
  assert.equal(again.status, 409);
  assert.match(again.text, /This link was already used/);
  assert.equal(customerMail(ctx).length, 1, 'one email, not two');
  assert.equal((await request(ctx.app).get(`/a/${approve}`)).status, 409);
  assert.match((await ctx.o.get(`/owner/enquiries/${e.id}`)).text, /<li>Approved with a one-tap email link · /);
});

test('a double tap at once approves once', async () => {
  const ctx = await world();
  await ready(ctx);
  const { approve } = linksIn(ownerMail(ctx)[0]);
  const get = await request(ctx.app).get(`/a/${approve}`);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(get.text)[1];
  const cookie = /liaisa\.otc=[^;]+/.exec((get.headers['set-cookie'] ?? []).join(';'))[0];
  const post = () => request(ctx.app).post(`/a/${approve}`).set('Cookie', cookie).type('form').send({ _csrf: csrf });
  const results = await Promise.all([post(), post()]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(customerMail(ctx).length, 1);
});

test('expired, tampered and malformed links are refused with a friendly page and change nothing', async () => {
  const ctx = await world();
  const e = await ready(ctx);
  const old = signLink(SECRET, { enquiryId: e.id, version: 1, action: 'approve' }, new Date(Date.now() - 25 * HOUR));
  const expired = await request(ctx.app).get(`/a/${old}`);
  assert.equal(expired.status, 410);
  assert.match(expired.text, /This link has expired/);
  assert.match(expired.text, /href="\/owner"/);
  const { approve } = linksIn(ownerMail(ctx)[0]);
  const tampered = `${approve.slice(0, -3)}AAA`;
  const t = await request(ctx.app).get(`/a/${tampered}`);
  assert.equal(t.status, 400);
  assert.match(t.text, /This link isn’t valid/);
  const [body] = approve.split('.');
  const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), e: byName(ctx.repos, 'Kavita Reddy').id })).toString('base64url');
  assert.equal((await request(ctx.app).get(`/a/${forgedBody}.${approve.split('.')[1]}`)).status, 400, 'a link for another enquiry cannot be made by editing one');
  assert.equal((await request(ctx.app).get('/a/not-a-token')).status, 400);
  assert.equal((await request(ctx.app).post(`/a/${old}`).type('form').send({ _csrf: 'x' })).status, 410);
  assert.equal(estimateOf(ctx.repos, e).status, 'draft');
  assert.equal(customerMail(ctx).length, 0);
});

test('a link signed with a different secret is refused', async () => {
  const ctx = await world();
  const e = await ready(ctx);
  const alien = signLink('z'.repeat(48), { enquiryId: e.id, version: 1, action: 'approve' });
  assert.equal((await request(ctx.app).get(`/a/${alien}`)).status, 400);
});

test('the Decline link declines once, logs it, and sends nothing to the customer', async () => {
  const ctx = await world();
  const e = await ready(ctx);
  const { decline } = linksIn(ownerMail(ctx)[0]);
  const get = await request(ctx.app).get(`/a/${decline}`);
  assert.match(get.text, /Decline enquiry/);
  assert.equal(ctx.repos.enquiries.get(e.id).status, 'awaiting_approval');
  const res = await tap(ctx.app, decline);
  assert.match(res.text, /Declined/);
  assert.equal(ctx.repos.enquiries.get(e.id).status, 'declined');
  assert.equal(customerMail(ctx).length, 0);
  assert.equal((await tap(ctx.app, decline)).status, 409);
  assert.match((await ctx.o.get(`/owner/enquiries/${e.id}`)).text, /<li>Declined with a one-tap email link · /);
});

test('a link for a quote that was edited, approved or declined since is refused ("changed")', async () => {
  const ctx = await world();
  const e = await ready(ctx);
  const { approve, decline } = linksIn(ownerMail(ctx)[0]);
  // The owner edits the quote: version 2. The old link (version 1) no longer matches.
  await ctx.o.postJson(`/owner/enquiries/${e.id}/edit`, { requirements: { ...e.requirementsJson, quantity: 50 }, revisionReason: 'More guests' });
  const stale = await request(ctx.app).get(`/a/${approve}`);
  assert.equal(stale.status, 409);
  assert.match(stale.text, /This quote has changed/);
  assert.equal(customerMail(ctx).length, 0);
  // Approve in Liaisa, then the Decline link (still within 24 hours) must not undo it.
  await ctx.o.postJson(`/owner/enquiries/${e.id}/approve`, { estimateVersion: 2 });
  assert.equal((await request(ctx.app).get(`/a/${decline}`)).status, 409);
  assert.notEqual(ctx.repos.enquiries.get(e.id).status, 'declined');
});

test('one-tap links work without an owner session, and are not sent when there is no owner secret', async () => {
  const ctx = await world();
  const e = await ready(ctx);
  const { approve } = linksIn(ownerMail(ctx)[0]);
  assert.equal((await request(ctx.app).get(`/a/${approve}`)).status, 200, 'no session cookie needed: the link is the credential');
  assert.ok(e);
});

// ---- Voice briefing ----------------------------------------------------------------------------

const briefingSource = fs.readFileSync(new URL('../../src/public/js/briefing.js', import.meta.url), 'utf8');
function fakeDom(items = []) {
  const els = {};
  const make = (hidden) => ({ hidden, textContent: '', listeners: {}, addEventListener(t, f) { this.listeners[t] = f; }, click() { this.listeners.click(); } });
  els.briefing = make(true); els['briefing-start'] = make(false); els['briefing-pause'] = make(true); els['briefing-stop'] = make(true);
  const nodes = items.map((i) => ({ getAttribute: (k) => ({ 'data-customer': i.customer, 'data-service': i.service, 'data-qty': i.qty, 'data-unit': i.unit, 'data-date': i.date, 'data-total': String(i.total), 'data-warnings': JSON.stringify(i.warnings ?? []) })[k] }));
  return { els, doc: { getElementById: (id) => els[id] ?? null, querySelectorAll: () => nodes } };
}
function loadBriefing(win) {
  vm.runInNewContext(briefingSource, { window: win });
  return win.LiaisaBriefing;
}

test('voice briefing: the button stays hidden when speech is not supported, and nothing is sent anywhere', () => {
  const { els, doc } = fakeDom([{ customer: 'Priya', total: 100 }]);
  loadBriefing({ document: doc }); // no speechSynthesis
  assert.equal(els.briefing.hidden, true);
  const noUtterance = fakeDom();
  loadBriefing({ document: noUtterance.doc, speechSynthesis: { speak() {} } }); // synth without utterances
  assert.equal(noUtterance.els.briefing.hidden, true);
  assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon|WebSocket|\.send\(/.test(briefingSource), 'no audio or text leaves the browser');
});

test('voice briefing: when supported it reads the count, then each item with the total in words and the warnings, with Pause and Stop', () => {
  const spoken = []; const calls = [];
  const synth = { speak: (u) => spoken.push(u), cancel: () => calls.push('cancel'), pause: () => calls.push('pause'), resume: () => calls.push('resume') };
  function Utterance(text) { this.text = text; }
  const items = [
    { customer: 'Kavita Reddy', service: 'Veg buffet', qty: '60', unit: 'guests', date: 'Saturday 12 December', total: 36729, warnings: [] },
    { customer: 'Arjun Mehta', service: 'Non-veg buffet', qty: '15', unit: 'guests', date: 'Wednesday 9 December', total: 9450, warnings: ['Fewer guests (15) than this service’s minimum (20).'] },
  ];
  const { els, doc } = fakeDom(items);
  loadBriefing({ document: doc, speechSynthesis: synth, SpeechSynthesisUtterance: Utterance });
  assert.equal(els.briefing.hidden, false);
  els['briefing-start'].click();
  assert.deepEqual(spoken.map((u) => u.text), [
    'You have two approvals waiting.',
    'Item 1 of 2. Kavita Reddy. Veg buffet, 60 guests, on Saturday 12 December. Total: thirty six thousand seven hundred twenty nine rupees. No warnings.',
    'Item 2 of 2. Arjun Mehta. Non-veg buffet, 15 guests, on Wednesday 9 December. Total: nine thousand four hundred fifty rupees. Warning: Fewer guests (15) than this service’s minimum (20).',
  ]);
  assert.deepEqual([els['briefing-start'].hidden, els['briefing-pause'].hidden, els['briefing-stop'].hidden], [true, false, false]);
  els['briefing-pause'].click();
  assert.deepEqual([calls.at(-1), els['briefing-pause'].textContent], ['pause', 'Resume']);
  els['briefing-pause'].click();
  assert.deepEqual([calls.at(-1), els['briefing-pause'].textContent], ['resume', 'Pause']);
  els['briefing-stop'].click();
  assert.equal(calls.at(-1), 'cancel');
  assert.deepEqual([els['briefing-start'].hidden, els['briefing-pause'].hidden, els['briefing-stop'].hidden], [false, true, true]);
});

test('voice briefing: numbers in words use Indian grouping', () => {
  const win = { document: fakeDom().doc };
  const { numberToWords, rupeesInWords, script } = loadBriefing(win);
  const cases = [[0, 'zero'], [1, 'one'], [19, 'nineteen'], [45, 'forty five'], [100, 'one hundred'], [18900, 'eighteen thousand nine hundred'],
    [100000, 'one lakh'], [123456, 'one lakh twenty three thousand four hundred fifty six'], [10000000, 'one crore'], [1234567, 'twelve lakh thirty four thousand five hundred sixty seven']];
  for (const [n, words] of cases) assert.equal(numberToWords(n), words, String(n));
  assert.equal(rupeesInWords(1), 'one rupee');
  assert.equal(rupeesInWords(2), 'two rupees');
  assert.equal(JSON.stringify(script([])), JSON.stringify(['Nothing is waiting for your approval.']));
  assert.equal(script([{ customer: 'A', service: '', quantity: '', unit: '', date: '', total: 5, warnings: [] }])[0], 'You have one approval waiting.');
});

test('the Read my approvals button is on the page but hidden until the browser says it can speak', async () => {
  const ctx = await world();
  const page = await ctx.o.get('/owner');
  assert.match(page.text, /<div class="briefing" id="briefing" hidden>/);
  assert.match(page.text, /<button class="btn secondary" type="button" id="briefing-start">Read my approvals<\/button>/);
  assert.match(page.text, /<button class="btn secondary" type="button" id="briefing-pause" hidden>Pause<\/button>/);
  assert.match(page.text, /<button class="btn text" type="button" id="briefing-stop" hidden>Stop<\/button>/);
  assert.match(page.text, /<script src="\/js\/briefing\.js" defer><\/script>/);
  assert.match(page.text, /data-warnings="\[&#34;Fewer guests|data-warnings="\[&quot;Fewer guests/);
  assert.equal((await request(ctx.app).get('/js/briefing.js')).status, 200);
  ctx.repos.enquiries.list().forEach((e) => ctx.repos.enquiries.update(e.id, { status: 'declined' }));
  assert.ok(!(await ctx.o.get('/owner')).text.includes('id="briefing"'), 'nothing to read: no button');
});

// ---- Foundations: tokens, contrast, no inline styles, fonts, CSP --------------------------------

const css = fs.readFileSync(new URL('../../src/public/css/app.css', import.meta.url), 'utf8');
const token = (name) => {
  const hex = new RegExp(`--${name}:\\s*#([0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?);`).exec(css)[1];
  return `#${hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex}`;
};
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

test('WCAG AA: every text and background pair in the design tokens has at least 4.5:1', () => {
  const pairs = [['ink', 'white'], ['ink', 'cloud'], ['slate', 'white'], ['slate', 'cloud'], ['plum', 'white'], ['plum', 'cloud'], ['white', 'jade'], ['white', 'jade-dark'],
    ['white', 'rose'], ['white', 'rose-dark'], ['white', 'plum'], ['amber', 'white'], ['white', 'amber'], ['rose', 'white'], ['jade', 'white'],
    ['tint-needs-fg', 'tint-needs-bg'], ['tint-done-fg', 'tint-done-bg'], ['tint-problem-fg', 'tint-problem-bg'], ['tint-progress-fg', 'tint-progress-bg'],
    ['plum', 'tint-progress-bg'], ['slate', 'tint-progress-bg']];
  for (const [fg, bg] of pairs) {
    const ratio = contrast(token(fg), token(bg));
    assert.ok(ratio >= 4.5, `${fg} on ${bg}: ${ratio.toFixed(2)}`);
  }
});

test('foundations: 16px inputs, 44px targets, focus ring, one button system, reduced motion, spacing scale, self-hosted fonts', () => {
  assert.match(css, /input, select, textarea \{[^}]*min-height: 44px;[^}]*font: 400 16px/);
  assert.match(css, /\.btn \{[^}]*min-height: 44px/);
  assert.match(css, /:focus-visible[^}]*outline: 3px solid var\(--plum\)/);
  for (const v of ['4px', '8px', '12px', '16px', '24px', '32px']) assert.match(css, new RegExp(`--s-\\d: ${v}`), v);
  assert.match(css, /--r-md: 12px/);
  for (const cls of ['.btn.secondary', '.btn.danger']) assert.ok(css.includes(cls), cls);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*animation-duration: 0\.01ms/);
  assert.match(css, /font-family: 'Figtree'/);
  assert.match(css, /font-family: 'Young Serif'/);
  assert.match(css, /--font: Figtree, "Noto Sans", system-ui/, 'system-font fallback');
  assert.ok(!/https?:\/\/fonts\.|@import/.test(css), 'no external fonts');
  assert.ok(!css.includes('.tabbar a { min-height: 40'));
});

test('fonts are served from our own host and the CSP is unchanged: no inline script, no external hosts', async () => {
  const ctx = await world();
  for (const f of ['figtree-400', 'figtree-500', 'figtree-600', 'young-serif-400']) {
    const res = await request(ctx.app).get(`/fonts/${f}.woff2`);
    assert.equal(res.status, 200, f);
    assert.match(res.headers['content-type'], /font\/woff2|application\/octet-stream/);
  }
  const csp = (await request(ctx.app).get('/')).headers['content-security-policy'];
  assert.match(csp, /script-src 'self'/);
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
  assert.match(csp, /font-src 'self'/);
  assert.match(csp, /form-action 'self' https:\/\/wa\.me https:\/\/api\.whatsapp\.com https:\/\/web\.whatsapp\.com/);
});

test('every screen: mobile viewport, no inline style attributes, no inline scripts, a way to skip to the content on owner pages', async () => {
  const ctx = await world();
  const rohan = byName(ctx.repos, 'Rohan Iyer');
  const tokenOfQuote = estimateOf(ctx.repos, rohan).quoteToken;
  const kavita = byName(ctx.repos, 'Kavita Reddy');
  const paths = [['/', false], ['/enquire', false], ['/owner/login', false], [`/q/${tokenOfQuote}`, false], ['/owner', true], [`/owner/enquiries/${kavita.id}`, true],
    ['/owner/approve-clean', true], ['/owner/follow-ups', true], ['/owner/clients?tab=reconnect', true], ['/owner/clients?tab=leads', true], ['/owner/clients?tab=find', true], ['/owner/setup', true]];
  for (const [path, owner] of paths) {
    const res = owner ? await ctx.o.get(path) : await request(ctx.app).get(path);
    assert.equal(res.status, 200, path);
    assert.match(res.text, /<meta name="viewport" content="width=device-width, initial-scale=1">/, path);
    assert.ok(!/\sstyle="/.test(res.text), `${path} has an inline style`);
    assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/.test(res.text), `${path} has an inline script`);
    if (owner) assert.match(res.text, /<a class="sr" href="#main">Skip to content<\/a>/, path);
  }
});

test('the landing page: hero with two buttons, three steps, the safety strip, the contact card, a sticky top bar', async () => {
  const ctx = await world();
  const page = await request(ctx.app).get('/');
  assert.match(page.text, /<header class="site-bar">/);
  assert.match(page.text, /Every enquiry answered\.<br>Every quote yours to approve\./);
  assert.match(page.text, /<a class="btn lg" href="\/enquire">Try the demo enquiry<\/a>/);
  assert.match(page.text, /<a class="btn secondary lg" href="\/owner\/login">Owner login<\/a>/);
  assert.match(page.text, /<a href="\/owner\/login">Owner login<\/a>/);
  for (const step of ['Describe your need', 'Owner approves the quote', 'Accept on your phone']) assert.ok(page.text.includes(step), step);
  assert.match(page.text, /Why it’s safe/);
  assert.match(page.text, /The server calculates the price\./);
  assert.match(page.text, /The owner approves every quote\./);
  assert.match(page.text, /<div class="card">[\s\S]*id="contact-form"/);
  assert.match(css, /\.site-bar \{ position: sticky; top: 0/);
});

test('the quote page: a clean card with a large total and sticky Accept, Ask a question and Decline', async () => {
  const ctx = await world();
  const rohan = byName(ctx.repos, 'Rohan Iyer');
  const page = await request(ctx.app).get(`/q/${estimateOf(ctx.repos, rohan).quoteToken}`);
  assert.match(page.text, /<article class="quote-card">/);
  assert.match(page.text, /<div class="action-bar action-bar--public">/);
  assert.match(page.text, /Accept quote<\/button>/);
  assert.match(page.text, /href="#ask" data-open="ask">Ask a question<\/a>/);
  assert.match(page.text, /href="#decline" data-open="decline">Decline<\/a>/);
  assert.match(css, /\.action-bar--public \{ position: sticky; bottom: 0/);
  assert.match(css, /\.sheet tfoot td \{[^}]*font-size: var\(--t-xl\)/);
});

test('the enquiry question screen is a chat: the customer’s message and Liaisa’s question as bubbles', async () => {
  const ctx = await world();
  const res = await request(ctx.app).post('/api/enquiries').set('Accept', 'text/html').type('form').send({ name: 'Meera', channel: 'email', email: 'm@example.test', description: 'Veg lunch for 40 people please' });
  assert.match(res.text, /<p class="bubble you"><span class="who">You<\/span>Veg lunch for 40 people please<\/p>/);
  assert.match(res.text, /<p class="bubble liaisa"><span class="who">Liaisa for Mehfil Kitchen<\/span>/);
});

test('submit buttons say "Sending…" while busy (script) and the script is shared', () => {
  const ui = fs.readFileSync(new URL('../../src/public/js/ui.js', import.meta.url), 'utf8');
  assert.match(ui, /textContent = 'Sending…'/);
  assert.match(ui, /data-no-busy/);
  assert.match(ui, /pageshow/);
});
