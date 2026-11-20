// The Contact section on Find clients lead cards: fixed template, typed contact, mailto / Liaisa / WhatsApp, rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupOwner, login, addBusiness } from '../helpers/ownerApp.js';
import { step } from '../../src/ai/mockClient.js';
import { contactTemplate, mailtoUrl } from '../../src/services/clients/contact.js';

const DAY = 86400000;
const ORG = 'Northfield Corporate Park Facilities'; // mock discovery: events@northfield-facilities.example
const NORTH_MAIL = 'events@northfield-facilities.example';
const LINK = 'https://liaisa.co.in/b/mehfil-kitchen/enquire';
const MAILTO = (to = NORTH_MAIL) => `mailto:${to}?subject=A%20note%20from%20Mehfil%20Kitchen&body=`;

async function world(opts) {
  const ctx = setupOwner(opts);
  return { ...ctx, o: await login(ctx.app) };
}
const lead = (ctx, name = ORG) => ctx.repos.leads.all().find((l) => l.name === name);
async function discovered(opts, focus = {}) {
  const ctx = await world(opts);
  await ctx.o.postJson('/owner/clients/discover', focus);
  return ctx;
}
const msg = (ctx, id, body) => ctx.o.postJson(`/owner/clients/leads/${id}/message`, body);
const findPage = (ctx, query = '') => ctx.o.get(`/owner/clients?tab=find${query}`);
const part = (text, id) => text.slice(text.indexOf(`id="lead-${id}"`), text.indexOf('</details>', text.indexOf(`id="lead-${id}"`)));
const decoded = (text) => text.replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#34;/g, '"');
const textareaOf = (html) => decoded(/<textarea id="msg-\d+" name="message"[^>]*>([\s\S]*?)<\/textarea>/.exec(html)[1]);

// ---- The fixed template ------------------------------------------------------------------------

test('every lead card has a Contact section with a fixed template: business, owner, organisation, service, area and the business’s own link', async () => {
  const ctx = await discovered({}, { service: 'Veg buffet', area: 'Whitefield' });
  const page = await findPage(ctx);
  for (const l of ctx.repos.leads.all()) assert.match(page.text, new RegExp(`<details class="edit contact" id="lead-${l.id}"`), l.name);
  const north = lead(ctx);
  const section = part(page.text, north.id);
  assert.match(section, /<summary>Contact<\/summary>/);
  assert.match(section, /<span class="tag">Fixed template<\/span>/);
  assert.ok(!section.includes('ai-badge'), 'the template is not AI');
  assert.equal(textareaOf(section), [
    `Hi team at ${ORG},`, '',
    `I’m Owner from Mehfil Kitchen in Bengaluru. We think we could help ${ORG} with veg buffet in Whitefield.`, '',
    `If that sounds useful, you can tell us what you need and get a quote here: ${LINK}`, '',
    'Thanks,', 'Owner', 'Mehfil Kitchen',
  ].join('\n'));
  assert.equal(ctx.ai.calls.filter((c) => c.purpose === 'outreach').length, 0, 'no AI call to show the template');
});

test('without a service or area the template leaves those words out; a lead you typed in is greeted by first name', async () => {
  const ctx = await discovered({}, {});
  const north = lead(ctx);
  assert.equal(textareaOf(part((await findPage(ctx)).text, north.id)).split('\n')[2], `I’m Owner from Mehfil Kitchen in Bengaluru. We think we could help ${ORG}.`);
  await ctx.o.postJson('/owner/clients/leads', { name: 'Dev Rao', contact: 'dev@example.test', note: 'HR manager at an IT firm' });
  const dev = lead(ctx, 'Dev Rao');
  const text = textareaOf(part((await ctx.o.get('/owner/clients?tab=leads')).text, dev.id));
  assert.match(text, /^Hi Dev,\n\nI’m Owner from Mehfil Kitchen in Bengaluru\. We think we could help you\.\n\n/);
  assert.ok(text.includes(LINK));
});

test('the link is the business’s own /b/<slug>/enquire, and the owner’s first name comes from the owner', async () => {
  const ctx = await world();
  const other = addBusiness(ctx.registry, { name: 'Spice Route', email: 'owner@spiceroute.example', city: 'Pune' });
  const o2 = await login(ctx.app, { email: other.email, password: other.password });
  await o2.postJson('/owner/clients/leads', { name: 'Asha Menon', contact: 'asha@example.test', note: 'Runs a cafe' });
  const asha = other.repos.leads.all()[0];
  const text = textareaOf(part((await o2.get('/owner/clients?tab=leads')).text, asha.id));
  assert.ok(text.includes(`https://liaisa.co.in/b/${other.repos.business.slug}/enquire`));
  assert.ok(!text.includes('mehfil-kitchen'));
  assert.match(text, /I’m Test from Spice Route in Pune\./);
  assert.ok(text.endsWith('Thanks,\nTest\nSpice Route'));
  // With no owner name the message says who it is from instead.
  assert.match(contactTemplate({ business: { businessName: 'Spice Route', city: null }, ownerName: '', lead: { kind: 'manual', name: 'Asha Menon' }, focus: {}, link: 'https://x.example/b/s/enquire' }), /^Hi Asha,\n\nThis is Spice Route\. We think we could help you\./);
});

// ---- The three buttons -------------------------------------------------------------------------

test('Open in my email app: a mailto: link with the subject and the encoded body; recorded as opened, nothing is sent', async () => {
  const ctx = await discovered();
  const north = lead(ctx);
  const body = `Hi team,\nTotal & more? 50% off #1 — see ${LINK}\n\nThanks,\nOwner`;
  const res = await msg(ctx, north.id, { action: 'mailto', message: body });
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.channel, res.body.status], ['email', 'opened']);
  assert.ok(res.body.url.startsWith(MAILTO()));
  assert.equal(decodeURIComponent(res.body.url.split('&body=')[1]), body.replace(/\n/g, '\r\n'), 'line breaks as CRLF');
  assert.ok(!/[ \n&?#]/.test(res.body.url.slice(res.body.url.indexOf('?') + 1).replace(/&body=|subject=/g, '')), 'nothing raw in the query');
  assert.equal(ctx.mailer.sent.length, 0, 'Liaisa sends nothing: the owner presses send in their own app');
  const row = ctx.repos.outreach.all().at(-1);
  assert.deepEqual([row.status, row.channel, row.kind, row.leadId], ['opened', 'email', 'contact', north.id]);
  assert.equal(row.message, body);
  // The form button: the same POST answers with a redirect to the mailto link.
  const other = lead(ctx, 'Lakeside Events Collective');
  const html = await ctx.o.postForm(`/owner/clients/leads/${other.id}/message`, { action: 'mailto', message: 'Hi team, we would love to help with your events.' });
  assert.equal(html.status, 302);
  assert.ok(html.headers.location.startsWith(MAILTO('hello@lakeside-events.example')));
});

test('Open in WhatsApp: a wa.me link with the encoded message, only when there is a phone number', async () => {
  const ctx = await discovered();
  await ctx.o.postJson('/owner/clients/leads', { name: 'Mina Das', contact: '98450 12345', note: 'Runs a yoga studio' });
  const mina = lead(ctx, 'Mina Das');
  const north = lead(ctx);
  const page = await ctx.o.get('/owner/clients?tab=leads');
  const sec = part(page.text, mina.id);
  assert.match(sec, />Open in WhatsApp<\/button>/);
  assert.ok(!sec.includes('Open in my email app') && !sec.includes('Send from Liaisa'));
  const text = `Hi Mina, hello & welcome!\nSee ${LINK}`;
  const res = await msg(ctx, mina.id, { action: 'whatsapp', message: text });
  assert.deepEqual([res.body.channel, res.body.status], ['whatsapp', 'opened']);
  assert.equal(res.body.url, `https://wa.me/919845012345?text=${encodeURIComponent(text)}`);
  assert.equal(decodeURIComponent(res.body.url.split('?text=')[1]), text);
  assert.equal(ctx.repos.outreach.all().at(-1).status, 'opened');
  assert.equal(ctx.mailer.sent.length, 0);
  const html = await ctx.o.postForm(`/owner/clients/leads/${mina.id}/message`, { action: 'whatsapp', message: text });
  assert.equal(html.status, 303, 'the 7-day rule: the same person twice, back to the card with a notice');
  assert.equal(html.headers.location, `/owner/clients?tab=leads&compose=${mina.id}&n=recent#lead-${mina.id}`);
  // An email-only lead has no WhatsApp button and the server refuses the action.
  assert.ok(!part((await findPage(ctx)).text, north.id).includes('Open in WhatsApp'));
  const wrong = await msg(ctx, north.id, { action: 'whatsapp', message: 'Hi team, a quick hello from us.' });
  assert.deepEqual([wrong.status, wrong.body.error.code], [409, 'no_contact']);
  const noMail = await msg(ctx, mina.id, { action: 'mailto', message: 'Hi Mina, a quick hello from us.' });
  assert.equal(noMail.body.error.code, 'recent', 'checked in this order: rules first');
});

test('Send from Liaisa goes through the mail service, saved first; the button is hidden when email is off', async () => {
  const ctx = await discovered();
  const north = lead(ctx);
  assert.match(part((await findPage(ctx)).text, north.id), />Send from Liaisa<\/button>/);
  const text = `Hi team, we would love to help. ${LINK}`;
  const res = await msg(ctx, north.id, { action: 'send', message: text });
  assert.deepEqual(res.body, { channel: 'email', status: 'sent' });
  const mail = ctx.mailer.sent.at(-1);
  assert.deepEqual([mail.to, mail.text, mail.subject], [NORTH_MAIL, text, 'A note from Mehfil Kitchen']);
  assert.equal(ctx.repos.emails.all().find((m) => m.type === 'outreach').status, 'accepted');
  assert.equal(ctx.repos.outreach.all().at(-1).status, 'sent');
  assert.equal(ctx.repos.leads.get(north.id).status, 'contacted');

  const off = await discovered({ mail: 'off' });
  const n2 = lead(off);
  const page = part((await findPage(off)).text, n2.id);
  assert.ok(!page.includes('Send from Liaisa'), 'hidden when MAIL_ENABLED is false');
  assert.match(page, />Open in my email app<\/button>/);
  const refused = await msg(off, n2.id, { action: 'send', message: 'Hi team, a quick hello from us.' });
  assert.deepEqual([refused.status, refused.body.error.code], [409, 'mail_off']);
  assert.equal(off.repos.outreach.all().length, 0);

  const bad = await discovered({ mail: 'fail' });
  const n3 = lead(bad);
  const failed = await msg(bad, n3.id, { action: 'send', message: 'Hi team, a quick hello from us.' });
  assert.deepEqual(failed.body, { channel: 'email', status: 'failed' });
  assert.equal(bad.repos.outreach.all().at(-1).status, 'failed');
  assert.equal(bad.repos.leads.get(n3.id).status, 'new', 'a failed send is not a contact');
  bad.mailer.fail = false;
  assert.equal((await msg(bad, n3.id, { action: 'send', message: 'Hi team, a quick hello from us.' })).body.status, 'sent');
});

// ---- The rules ---------------------------------------------------------------------------------

test('nobody is contacted twice in 7 days: not after an earlier contact, not after a follow-up reminder', async () => {
  const ctx = await discovered();
  const north = lead(ctx);
  const text = 'Hi team, a quick hello from us.';
  assert.equal((await msg(ctx, north.id, { action: 'mailto', message: text })).status, 200);
  for (const action of ['mailto', 'send']) {
    const again = await msg(ctx, north.id, { action: action, message: text });
    assert.deepEqual([again.status, again.body.error.code], [409, 'recent'], action);
    assert.match(again.body.error.message, /^Contacted recently\. Wait until /);
  }
  assert.equal(ctx.repos.outreach.all().length, 1);
  const page = part((await findPage(ctx)).text, north.id);
  assert.match(page, /Contacted recently\. Wait until/);
  assert.ok(!page.includes('<textarea'), 'no message box for someone who cannot be contacted yet');
  // 8 days later it is allowed again.
  ctx.repos.outreach.update(ctx.repos.outreach.all()[0].id, { sentAt: new Date(Date.now() - 8 * DAY) });
  assert.equal((await msg(ctx, north.id, { action: 'mailto', message: text })).status, 200);

  // A follow-up reminder to a customer with the same email counts too.
  const lakeside = lead(ctx, 'Lakeside Events Collective');
  const e = ctx.repos.enquiries.create({ customerName: 'Hello Lakeside', customerEmail: 'hello@lakeside-events.example', preferredChannel: 'email', rawText: 'x', status: 'quoted' });
  ctx.repos.followups.create({ enquiryId: e.id, step: 1, dueAt: new Date(), channel: 'email', status: 'sent', sentAt: new Date(Date.now() - 2 * DAY) });
  const viaReminder = await msg(ctx, lakeside.id, { action: 'mailto', message: text });
  assert.deepEqual([viaReminder.status, viaReminder.body.error.code], [409, 'recent']);
});

test('do-not-contact and Not interested refuse every button, and nothing is recorded', async () => {
  const ctx = await discovered();
  const [north, lakeside, greenleaf] = ['Northfield Corporate Park Facilities', 'Lakeside Events Collective', 'Greenleaf International School'].map((n) => lead(ctx, n));
  ctx.repos.leads.update(north.id, { doNotContact: true });
  await ctx.o.postJson(`/owner/clients/leads/${lakeside.id}/status`, { action: 'not_interested' });
  // A past customer who asked not to be contacted, with the same email as a lead.
  ctx.repos.enquiries.create({ customerName: 'Office', customerEmail: 'office@greenleaf-school.example', preferredChannel: 'email', rawText: 'x', status: 'lost', doNotContact: true });
  for (const l of [north, lakeside, greenleaf]) {
    for (const action of ['mailto', 'send']) {
      const res = await msg(ctx, l.id, { action, message: 'Hi team, a quick hello from us.' });
      assert.equal(res.status, 409, `${l.name} ${action}`);
      assert.ok(['do_not_contact', 'not_interested'].includes(res.body.error.code), res.body.error.code);
    }
  }
  assert.equal(ctx.repos.outreach.all().length, 0);
  assert.equal(ctx.mailer.sent.length, 0);
  const page = (await findPage(ctx)).text;
  for (const l of [north, lakeside, greenleaf]) assert.ok(!part(page, l.id).includes('<textarea'), l.name);
});

test('the lead becomes Contacted, shows the last contact date, and the activity says how', async () => {
  const ctx = await discovered();
  const north = lead(ctx);
  assert.equal(north.status, 'new');
  await msg(ctx, north.id, { action: 'mailto', message: 'Hi team, a quick hello from us.' });
  assert.equal(ctx.repos.leads.get(north.id).status, 'contacted');
  const page = await findPage(ctx);
  assert.match(page.text, /<h3>Northfield Corporate Park Facilities[\s\S]*?<span class="chip tone-progress">Contacted<\/span>/);
  assert.match(page.text, /Last contacted just now · \w{3} \d{1,2} \w{3}/);
  assert.match(page.text, new RegExp(`<li>${ORG} · email · Contacted by email, opened · just now</li>`));
  await ctx.o.postJson('/owner/clients/leads', { name: 'Mina Das', contact: '98450 12345', note: 'Runs a yoga studio' });
  await msg(ctx, lead(ctx, 'Mina Das').id, { action: 'whatsapp', message: 'Hi Mina, a quick hello from us.' });
  assert.match((await ctx.o.get('/owner/clients?tab=leads')).text, /<li>Mina Das · WhatsApp · Contacted by WhatsApp, opened · just now<\/li>/);
  // A reply is still recorded by the owner afterwards, and a contact does not overwrite it.
  await ctx.o.postJson(`/owner/clients/leads/${north.id}/status`, { action: 'replied' });
  assert.equal(ctx.repos.leads.get(north.id).status, 'replied');
});

// ---- No AI, no cap on the template path ---------------------------------------------------------

test('the template path makes no AI call and uses no draft slot, even when the daily draft cap is used up', async () => {
  const ctx = await discovered({ env: { CLIENT_DRAFT_DAILY_CAP: '1' } });
  const [north, lakeside, greenleaf] = ['Northfield Corporate Park Facilities', 'Lakeside Events Collective', 'Greenleaf International School'].map((n) => lead(ctx, n));
  assert.equal((await ctx.o.postJson(`/owner/clients/leads/${lakeside.id}/personalise`)).status, 201, 'one AI draft uses the one slot');
  const second = await ctx.o.postJson(`/owner/clients/leads/${greenleaf.id}/personalise`);
  assert.deepEqual([second.status, second.body.error.code], [409, 'draft_limit']);
  const before = ctx.ai.calls.length;
  // Template contacts still work, and don't count.
  assert.equal((await msg(ctx, north.id, { action: 'mailto', message: 'Hi team, a quick hello from us.' })).status, 200);
  assert.equal((await msg(ctx, greenleaf.id, { action: 'send', message: 'Hi team, a quick hello from us.' })).status, 200);
  assert.equal(ctx.ai.calls.length, before, 'no AI call');
  assert.equal(ctx.repos.aiCalls.all().filter((r) => r.purpose === 'outreach').length, 1);
  assert.match((await findPage(ctx)).text, /Drafts today: 1 of 1/);
});

test('Personalise with AI puts the existing AI draft in the box (AI badge, cap counted); the template stays the default', async () => {
  const ctx = await discovered();
  const north = lead(ctx);
  const res = await ctx.o.postJson(`/owner/clients/leads/${north.id}/personalise`);
  assert.equal(res.status, 201);
  assert.equal(res.body.source, 'ai');
  assert.match(res.body.message, /^Hi team at Northfield Corporate Park Facilities, this is Mehfil Kitchen\./);
  assert.ok(res.body.message.endsWith(LINK), 'the AI draft carries the business’s own link, not the demo’s');
  const html = await ctx.o.postForm(`/owner/clients/leads/${north.id}/personalise`);
  assert.equal(html.headers.location, `/owner/clients?tab=find&compose=${north.id}&draft=${res.body.draftId}#lead-${north.id}`);
  const page = await ctx.o.get(html.headers.location.replace('#', '#'));
  const sec = part(page.text, north.id);
  assert.match(sec, /<span class="ai-badge"/);
  assert.match(sec, /Written by Liaisa from the facts we hold\. Edit it before you send\./);
  assert.ok(!sec.includes('Fixed template'));
  assert.equal(textareaOf(sec), res.body.message);
  assert.match(sec, new RegExp(`<input type="hidden" name="draftId" value="${res.body.draftId}">`));
  assert.ok(sec.startsWith(`id="lead-${north.id}" open>`), 'the section is open');
  assert.match(page.text, /Drafts today: 1 of 20/, 'the daily cap counted it');
  const call = ctx.ai.calls.find((c) => c.purpose === 'outreach');
  assert.ok(call && !JSON.stringify(call).includes(NORTH_MAIL), 'the contact is never sent to the model');
  // Without the compose parameter the template is the default again.
  assert.ok(textareaOf(part((await findPage(ctx)).text, north.id)).includes('Fixed template') === false);
  assert.match(part((await findPage(ctx)).text, north.id), /Fixed template/);
  // Using the AI text records against that same draft: no second slot, no second row.
  const sent = await msg(ctx, north.id, { action: 'mailto', message: `${res.body.message}\nPS` , draftId: res.body.draftId });
  assert.equal(sent.status, 200);
  assert.equal(ctx.repos.outreach.all().length, 1);
  assert.deepEqual([ctx.repos.outreach.get(res.body.draftId).status, ctx.repos.outreach.get(res.body.draftId).viaContact], ['opened', true]);
  assert.match((await findPage(ctx)).text, /Drafts today: 1 of 20/);
  assert.equal((await msg(ctx, lead(ctx, 'Lakeside Events Collective').id, { action: 'mailto', message: 'Hi team, hello there friend.', draftId: res.body.draftId })).body.error.code, 'already_sent', 'a draft cannot be reused for someone else');
});

// ---- Typing in a contact -----------------------------------------------------------------------

test('a lead with no contact shows an input; a typed email or WhatsApp number is validated and saved on the lead', async () => {
  const ctx = await discovered();
  const welfare = lead(ctx, 'Koramangala Residents Welfare Association');
  assert.equal(welfare.publicContact, null);
  const sec = part((await findPage(ctx)).text, welfare.id);
  assert.match(sec, /No contact was shown on the cited page/);
  assert.match(sec, new RegExp(`<input id="contact-${welfare.id}" name="contact" type="text"`));
  assert.ok(!sec.includes('<textarea') && !sec.includes('Open in my email app'));
  for (const bad of ['', 'abc', '12345', 'a@b', 'x'.repeat(300), '98450 1234x']) {
    const res = await ctx.o.postJson(`/owner/clients/leads/${welfare.id}/contact`, { contact: bad });
    assert.deepEqual([res.status, res.body.error.code], [400, 'invalid_contact'], JSON.stringify(bad));
  }
  const html = await ctx.o.postForm(`/owner/clients/leads/${welfare.id}/contact`, { contact: 'nope' });
  assert.equal(html.headers.location, `/owner/clients?tab=find&compose=${welfare.id}&n=invalid_contact#lead-${welfare.id}`);
  assert.deepEqual([ctx.repos.leads.get(welfare.id).email, ctx.repos.leads.get(welfare.id).phone], [null, null], 'nothing saved');

  const ok = await ctx.o.postJson(`/owner/clients/leads/${welfare.id}/contact`, { contact: ' Info@Welfare.Example ' });
  assert.equal(ok.status, 200);
  const saved = ctx.repos.leads.get(welfare.id);
  assert.deepEqual([saved.email, saved.phone, saved.typedContact], ['info@welfare.example', null, true]);
  const after = part((await findPage(ctx)).text, welfare.id);
  assert.match(after, /Contact: info@welfare\.example <span class="slate">\(you added this\)<\/span>/);
  assert.match(after, />Open in my email app<\/button>/);
  assert.equal((await msg(ctx, welfare.id, { action: 'mailto', message: 'Hi team, a quick hello from us.' })).body.url.startsWith(MAILTO('info@welfare.example')), true);

  const hub = lead(ctx, 'Hub Nine Co-working');
  assert.equal((await ctx.o.postJson(`/owner/clients/leads/${hub.id}/contact`, { contact: '98450 12345' })).status, 200);
  assert.deepEqual([ctx.repos.leads.get(hub.id).phone, ctx.repos.leads.get(hub.id).email], ['919845012345', null]);
  assert.match(part((await findPage(ctx)).text, hub.id), />Open in WhatsApp<\/button>/);
  // A contact that is already there is not overwritten, and a duplicate of another lead is refused.
  const again = await ctx.o.postJson(`/owner/clients/leads/${hub.id}/contact`, { contact: 'other@example.test' });
  assert.deepEqual([again.status, again.body.error.code], [409, 'contact_exists']);
  const north = lead(ctx);
  assert.equal((await ctx.o.postJson(`/owner/clients/leads/${north.id}/contact`, { contact: 'x@example.test' })).body.error.code, 'contact_exists');
  ctx.repos.leads.update(hub.id, { phone: null, typedContact: false });
  assert.equal((await ctx.o.postJson(`/owner/clients/leads/${hub.id}/contact`, { contact: NORTH_MAIL })).body.error.code, 'duplicate_lead');
});

test('messages are validated: a length, an action, and only the business’s own links', async () => {
  const ctx = await discovered();
  const north = lead(ctx);
  for (const body of [{ action: 'mailto', message: '' }, { action: 'mailto', message: 'abc' }, { action: 'mailto', message: 'x'.repeat(1001) }, { action: 'carrier-pigeon', message: 'Hello there team' }, { message: 'Hello there team' }]) {
    const res = await msg(ctx, north.id, body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
  }
  const evil = await msg(ctx, north.id, { action: 'mailto', message: 'Hi team, see https://evil.example/deal today.' });
  assert.equal(evil.status, 400);
  assert.match(evil.body.error.message, /Only your own enquiry or quote link/);
  const html = await ctx.o.postForm(`/owner/clients/leads/${north.id}/message`, { action: 'mailto', message: 'x' });
  assert.equal(html.headers.location, `/owner/clients?tab=find&compose=${north.id}&n=invalid_message#lead-${north.id}`);
  assert.equal(ctx.repos.outreach.all().length, 0);
  assert.equal((await msg(ctx, 99999, { action: 'mailto', message: 'Hello there team' })).status, 404);
  assert.equal((await ctx.o.postJson('/owner/clients/leads/abc/message', { action: 'mailto', message: 'Hello there team' })).status, 404);
});

test('mailtoUrl encodes the subject and body and keeps the address readable', () => {
  const url = mailtoUrl('a.b+c@example.test', 'A note & more', 'Line 1\nLine 2 ₹ 100% #1');
  assert.equal(url, 'mailto:a.b%2Bc@example.test?subject=A%20note%20%26%20more&body=Line%201%0D%0ALine%202%20%E2%82%B9%20100%25%20%231');
});

// ---- Safety ------------------------------------------------------------------------------------

test('output is escaped: an organisation name from the model cannot break out of the box or the page', async () => {
  const evil = { organisation: '<script>alert(1)</script> Events', type: 'event planning company', why_a_fit: 'Plans events.', source_url: 'https://evil-events.example/a', public_contact: 'hi@evil-events.example' };
  const ctx = await world({ steps: [step.discovery({ results: [evil.source_url], leads: [evil] })] });
  await ctx.o.postJson('/owner/clients/discover', {});
  const l = ctx.repos.leads.all()[0];
  const page = await findPage(ctx);
  assert.ok(!page.text.includes('<script>alert(1)'));
  assert.ok(part(page.text, l.id).includes('Hi team at &lt;script&gt;alert(1)&lt;/script&gt; Events,'));
  assert.ok(!/\sstyle="/.test(page.text) && !/<script(?![^>]*\ssrc=)[^>]*>/.test(page.text));
});

test('every Contact route needs the owner session and a CSRF token', async () => {
  const ctx = await discovered();
  const north = lead(ctx);
  for (const [path, body] of [[`/owner/clients/leads/${north.id}/contact`, { contact: 'a@b.co' }], [`/owner/clients/leads/${north.id}/message`, { action: 'mailto', message: 'Hello there team' }], [`/owner/clients/leads/${north.id}/personalise`, {}]]) {
    assert.equal((await request(ctx.app).post(path).type('form').send(body)).status, 302, `${path} without a session`);
    assert.equal((await request(ctx.app).post(path).set('Cookie', ctx.o.cookie).type('form').send(body)).status, 403, `${path} without CSRF`);
  }
  assert.equal(ctx.repos.outreach.all().length, 0);
  assert.match((await request(ctx.app).get('/')).headers['content-security-policy'], /form-action 'self' [^;]*mailto:/);
});

test('another business’s lead is a 404 for every Contact route, and nothing of it changes', async () => {
  const ctx = await discovered();
  const north = lead(ctx);
  const other = addBusiness(ctx.registry);
  const o2 = await login(ctx.app, { email: other.email, password: other.password });
  await o2.postJson('/owner/clients/leads', { name: 'Asha Menon', contact: 'asha@example.test', note: 'Runs a cafe' });
  const asha = other.repos.leads.all()[0];
  assert.notEqual(asha.id, north.id, 'ids are unique across businesses');
  for (const [path, body] of [[`/owner/clients/leads/${north.id}/contact`, { contact: 'x@example.test' }], [`/owner/clients/leads/${north.id}/message`, { action: 'mailto', message: 'Hello there team' }],
    [`/owner/clients/leads/${north.id}/personalise`, {}], [`/owner/clients/leads/${north.id}/status`, { action: 'replied' }]]) {
    const res = await o2.postJson(path, body);
    assert.equal(res.status, 404, path);
  }
  for (const [path, body] of [[`/owner/clients/leads/${asha.id}/message`, { action: 'mailto', message: 'Hello there team' }], [`/owner/clients/leads/${asha.id}/personalise`, {}]]) {
    assert.equal((await ctx.o.postJson(path, body)).status, 404, `demo owner, ${path}`);
  }
  assert.equal(ctx.repos.leads.get(north.id).status, 'new');
  assert.equal(other.repos.leads.get(asha.id).status, 'new');
  assert.equal(ctx.repos.outreach.all().length, 0);
  assert.equal(other.repos.outreach.all().length, 0);
  assert.ok(!(await o2.get('/owner/clients?tab=leads')).text.includes(ORG));
});

test('the lead’s contact never reaches logs, ai_calls or the activity text', async () => {
  const logged = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => logged.push(a.join(' ')); console.error = (...a) => logged.push(a.join(' ')); console.warn = (...a) => logged.push(a.join(' '));
  try {
    const ctx = await discovered();
    const north = lead(ctx);
    await ctx.o.postJson(`/owner/clients/leads/${north.id}/personalise`);
    await msg(ctx, north.id, { action: 'send', message: 'Hi team, a quick hello from us.' });
    await msg(ctx, north.id, { action: 'send', message: 'Hi team, a quick hello from us.' }); // refused: 7 days
    assert.ok(!JSON.stringify(ctx.repos.aiCalls.all()).includes(NORTH_MAIL), 'ai_calls');
    assert.ok(!JSON.stringify(ctx.ai.calls).includes(NORTH_MAIL), 'the model request');
    const activity = /<h2 id="act-h">Activity<\/h2>([\s\S]*?)<\/section>/.exec((await findPage(ctx)).text)[1];
    assert.ok(!activity.includes(NORTH_MAIL) && !activity.includes('northfield-facilities'), 'activity text');
    assert.ok(!logged.some((l) => l.includes(NORTH_MAIL)), 'console output');
  } finally {
    Object.assign(console, orig);
  }
});
