import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupOwner, login, makeEnquiry, estimateOf } from '../helpers/ownerApp.js';
import { normalisePhone } from '../../src/services/enquiries/schema.js';
import { buildWaLink } from '../../src/services/whatsapp/link.js';
import { ValidationError } from '../../src/errors.js';

test('TC-WA-01 phone numbers normalise to 919845012345', () => {
  for (const raw of ['98450 12345', '+91 98450-12345', '09845012345']) assert.equal(normalisePhone(raw, '91'), '919845012345', raw);
});

test('TC-WA-02 short numbers and letters are rejected', () => {
  for (const raw of ['12345', 'abcdefghij', '']) assert.equal(normalisePhone(raw, '91'), null, raw);
  assert.throws(() => buildWaLink('12345', 'hi'), ValidationError);
});

test('TC-WA-03 link: wa.me with the digits, encoded text, line breaks and ₹ survive decoding', () => {
  const text = 'Hi Priya,\nTotal: ₹18,900 & more?\nhttps://liaisa.co.in/q/abc';
  const url = buildWaLink('+919845012345', text);
  assert.match(url, /^https:\/\/wa\.me\/919845012345\?text=/);
  assert.ok(url.includes('%0A') && !url.includes('\n') && !url.includes(' '));
  assert.equal(decodeURIComponent(url.split('?text=')[1]), text);
});

test('TC-WA-03 the message has the right total and quote link', async () => {
  const ctx = setupOwner();
  const o = await login(ctx.app);
  const e = makeEnquiry(ctx.repos, { channel: 'whatsapp', name: 'Priya Nair' });
  const res = await o.postJson(`/owner/enquiries/${e.id}/approve`, { estimateVersion: 1 });
  assert.equal(res.body.channel, 'whatsapp');
  assert.equal(res.body.estimateStatus, 'approved');
  assert.equal(ctx.mailer.sent.length, 0, 'nothing is emailed to a WhatsApp customer');
  const text = decodeURIComponent(res.body.whatsappUrl.split('?text=')[1]);
  const token = estimateOf(ctx.repos, e).quoteToken;
  assert.match(text, /^Hi Priya, here's your quote from Mehfil Kitchen for 40 guests on Tue 15 Dec: ₹18,900\./);
  assert.ok(text.endsWith(`https://liaisa.co.in/q/${token}`));
});

test('TC-WA-04 the button shows only after approval, never for a draft; the endpoint refuses drafts', async () => {
  const ctx = setupOwner();
  const o = await login(ctx.app);
  const e = makeEnquiry(ctx.repos, { channel: 'whatsapp' });
  const draft = await o.get(`/owner/enquiries/${e.id}`);
  assert.ok(!draft.text.includes('Send on WhatsApp'));
  assert.equal((await o.postJson(`/owner/enquiries/${e.id}/whatsapp`)).status, 409);
  assert.equal(ctx.repos.whatsappShares.listByEnquiry(e.id).length, 0);
  await o.postJson(`/owner/enquiries/${e.id}/approve`, { estimateVersion: 1 });
  const approved = await o.get(`/owner/enquiries/${e.id}`);
  assert.match(approved.text, /Send on WhatsApp/);
});

test('TC-WA-05 POST /whatsapp logs the share, marks the quote sent and redirects to wa.me', async () => {
  const ctx = setupOwner();
  const o = await login(ctx.app);
  const e = makeEnquiry(ctx.repos, { channel: 'whatsapp' });
  await o.postJson(`/owner/enquiries/${e.id}/approve`, { estimateVersion: 1 });
  const res = await o.postForm(`/owner/enquiries/${e.id}/whatsapp`);
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^https:\/\/wa\.me\/919845012345\?text=Hi%20Meera/);
  assert.equal(ctx.repos.whatsappShares.listByEnquiry(e.id).length, 1);
  assert.equal(estimateOf(ctx.repos, e).status, 'sent');
  assert.equal(ctx.repos.enquiries.get(e.id).status, 'quoted');
  const page = await o.get(`/owner/enquiries/${e.id}`);
  assert.match(page.text, /Opened in WhatsApp\. Tap Send there to deliver it\./);
  const json = await o.postJson(`/owner/enquiries/${e.id}/whatsapp`);
  assert.equal(json.status, 200);
  assert.match(json.body.url, /^https:\/\/wa\.me\//);
});

test('an email customer with a phone number also gets the WhatsApp button; without a phone, a 409', async () => {
  const ctx = setupOwner();
  const o = await login(ctx.app);
  const withPhone = makeEnquiry(ctx.repos, { channel: 'email', phone: '919845012345', name: 'Dev Rao' });
  const without = makeEnquiry(ctx.repos, { channel: 'email', phone: null, name: 'Ila Rao' });
  for (const e of [withPhone, without]) await o.postJson(`/owner/enquiries/${e.id}/approve`, { estimateVersion: 1 });
  assert.match((await o.get(`/owner/enquiries/${withPhone.id}`)).text, /Send on WhatsApp/);
  assert.ok(!(await o.get(`/owner/enquiries/${without.id}`)).text.includes('Send on WhatsApp'));
  assert.equal((await o.postJson(`/owner/enquiries/${without.id}/whatsapp`)).status, 409);
});

test('the CSP lets the WhatsApp form redirect to wa.me; the WhatsApp POST needs a session and CSRF', async () => {
  const ctx = setupOwner();
  const home = await request(ctx.app).get('/');
  assert.match(home.headers['content-security-policy'], /form-action 'self' https:\/\/wa\.me https:\/\/api\.whatsapp\.com https:\/\/web\.whatsapp\.com[;,]/);
  const e = makeEnquiry(ctx.repos, { channel: 'whatsapp' });
  assert.equal((await request(ctx.app).post(`/owner/enquiries/${e.id}/whatsapp`).type('form').send({})).status, 302);
  const o = await login(ctx.app);
  assert.equal((await request(ctx.app).post(`/owner/enquiries/${e.id}/whatsapp`).set('Cookie', o.cookie).type('form').send({})).status, 403);
});
