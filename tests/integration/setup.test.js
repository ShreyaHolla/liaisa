import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupOwner, login } from '../helpers/ownerApp.js';
import { DEMO_PRICING_CONFIG } from '../../src/seed.js';

// A full, valid form body (what the browser posts), with the demo rows spelled out.
const form = (over = {}) => ({
  businessName: 'Spice Route', tagline: 'Street food, catered', currencySymbol: '₹', whatsappNumber: '98450 12345',
  weekendPct: '12', taxPct: '18',
  svcId: ['veg_buffet', ''], svcName: ['Pure veg thali', 'Chaat counter'], svcPrice: ['520', '3000'],
  svcMin: ['10', '2'], svcMax: ['150', ''], svcUnit: ['Plates', 'Hours'],
  areaName: ['Koramangala', 'Hebbal'], areaFee: ['0', '800'],
  ...over,
});

test('/owner/setup needs the owner login, like every owner route', async () => {
  const { app } = setupOwner();
  assert.equal((await request(app).get('/owner/setup')).status, 302);
  assert.equal((await request(app).post('/owner/setup').type('form').send(form())).status, 302);
  const o = await login(app);
  const noCsrf = await request(app).post('/owner/setup').set('Cookie', o.cookie).type('form').send(form());
  assert.equal(noCsrf.status, 403);
  assert.equal((await request(app).post('/owner/setup/reset').set('Cookie', o.cookie).type('form').send({})).status, 403);
});

test('the setup page shows the current business, services and areas; the dashboard links to it', async () => {
  const { app } = setupOwner();
  const o = await login(app);
  const page = await o.get('/owner/setup');
  assert.equal(page.status, 200);
  for (const text of ['Mehfil Kitchen', 'Veg buffet', 'Live dosa counter', 'Koramangala', 'Whitefield', 'Reset to demo business']) assert.ok(page.text.includes(text), text);
  assert.match(page.text, /value="1500"/);
  assert.match((await o.get('/owner')).text, /<a href="\/owner\/setup">Business setup<\/a>/);
});

test('saving applies to new enquiries everywhere: engine, enquiry form, owner pages, dashboard', async () => {
  const ctx = setupOwner();
  const o = await login(ctx.app);
  const res = await o.postForm('/owner/setup', form());
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/owner/setup?n=saved');
  assert.match((await o.get(res.headers.location)).text, /Quotes already made keep their numbers/);
  const cfg = ctx.repos.pricingConfigs.latestApproved().configJson;
  assert.equal(cfg.tax_pct, 18);
  assert.equal(cfg.surcharges.weekend_pct, 12);
  assert.equal(cfg.services[0].price, 520);
  assert.equal(cfg.services[1].id, 'chaat_counter');
  assert.match((await o.get('/owner')).text, /Spice Route/);
  const enquire = await request(ctx.app).get('/enquire');
  assert.match(enquire.text, /Spice Route/);
});

test('invalid input: the page comes back with messages and nothing is saved', async () => {
  const ctx = setupOwner();
  const o = await login(ctx.app);
  const before = ctx.repos.pricingConfigs.latestApproved().id;
  const res = await o.postForm('/owner/setup', form({ svcPrice: ['-5', '3000'], areaFee: ['0', '10.5'], businessName: ' ', taxPct: '200' }));
  assert.equal(res.status, 400);
  assert.match(res.text, /Enter a whole number of rupees, 0 or more\./);
  assert.match(res.text, /Enter the business name\./);
  assert.match(res.text, /Enter a percentage from 0 to 100\./);
  assert.match(res.text, /value="3000"/, 'what was typed stays in the form');
  assert.equal(ctx.repos.pricingConfigs.latestApproved().id, before);
  assert.equal(ctx.repos.businessSettings.get().businessName, 'Mehfil Kitchen');
});

test('duplicate service names (after slugifying) are rejected', async () => {
  const ctx = setupOwner();
  const o = await login(ctx.app);
  const res = await o.postForm('/owner/setup', form({ svcName: ['Chaat counter', 'CHAAT  counter!'], svcId: ['veg_buffet', ''] }));
  assert.equal(res.status, 400);
  assert.match(res.text, /Another service already has this name\./);
});

test('a new service cannot take the id of an existing one under a new name', async () => {
  const ctx = setupOwner();
  const o = await login(ctx.app);
  // veg_buffet is renamed, then a new service is called "Veg buffet": same id would clash.
  const res = await o.postForm('/owner/setup', form({ svcId: ['veg_buffet', ''], svcName: ['Thali', 'Veg buffet'] }));
  assert.equal(res.status, 400);
  assert.match(res.text, /Another service already uses this name\./);
});

test('Remove drops a row; the last service and the last area can’t be removed; spare blank rows are ignored', async () => {
  const ctx = setupOwner();
  const o = await login(ctx.app);
  const ok = await o.postForm('/owner/setup', form({ svcRemove: ['1'], areaRemove: ['1'] }));
  assert.equal(ok.status, 303);
  const cfg = ctx.repos.pricingConfigs.latestApproved().configJson;
  assert.deepEqual(cfg.services.map((s) => s.id), ['veg_buffet']);
  assert.deepEqual(Object.keys(cfg.travel.areas), ['Koramangala']);

  const last = await o.postForm('/owner/setup', form({ svcId: ['veg_buffet', ''], svcName: ['Pure veg thali', ''], svcPrice: ['520', ''], svcMin: ['10', ''], svcMax: ['', ''], svcRemove: ['0'], areaRemove: ['0', '1'] }));
  assert.equal(last.status, 400);
  assert.match(last.text, /Keep at least one service\./);
  assert.match(last.text, /Keep at least one area\./);
  assert.equal(ctx.repos.pricingConfigs.latestApproved().configJson.services.length, 1, 'nothing was saved');
});

test('more than 10 services or 20 areas is rejected', async () => {
  const ctx = setupOwner();
  const o = await login(ctx.app);
  const n = 11;
  const many = form({
    svcId: Array(n).fill(''), svcName: Array.from({ length: n }, (_, i) => `Service ${i}`), svcPrice: Array(n).fill('100'),
    svcMin: Array(n).fill('1'), svcMax: Array(n).fill(''), svcUnit: Array(n).fill('Hours'),
  });
  const res = await o.postForm('/owner/setup', many);
  assert.equal(res.status, 400);
  assert.match(res.text, /up to 10 services/);
  const areas = await o.postForm('/owner/setup', form({ areaName: Array.from({ length: 21 }, (_, i) => `Area ${i}`), areaFee: Array(21).fill('0') }));
  assert.match(areas.text, /up to 20 areas/);
});

test('a new quote uses the edited prices; a quote made before the edit keeps its numbers, even when edited', async () => {
  const ctx = setupOwner();
  const o = await login(ctx.app);
  const kavita = ctx.repos.enquiries.list().find((e) => e.customerName === 'Kavita Reddy');
  const oldTotal = ctx.repos.estimates.listByEnquiry(kavita.id)[0].total;
  await o.postForm('/owner/setup', form());
  assert.equal(ctx.repos.estimates.listByEnquiry(kavita.id)[0].total, oldTotal, 'existing estimate untouched');
  // Editing the old draft reprices with the config it was first priced with (old prices), not the new ones.
  const edit = await o.postJson(`/owner/enquiries/${kavita.id}/edit`, { requirements: { ...kavita.requirementsJson, quantity: 60 }, revisionReason: 'Same guests, check' });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.total, oldTotal);
  // A brand new enquiry is priced with the edited config.
  const e = ctx.repos.enquiries.create({ customerName: 'Tara', customerEmail: 't@example.test', preferredChannel: 'email', rawText: 'x', status: 'collecting' });
  const done = await request(ctx.app).post(`/api/enquiries/${e.publicId}/form`).send({ service_id: 'veg_buffet', quantity: 40, event_date: '2026-12-15', location: 'Hebbal' });
  assert.equal(done.body.outcome, 'ready');
  const est = ctx.repos.estimates.listByEnquiry(e.id)[0];
  // 40 x 520 = 20,800 + 800 travel = 21,600; tax 18% = 3,888
  assert.equal(est.total, 25488);
  assert.notEqual(est.pricingConfigId, ctx.repos.estimates.listByEnquiry(kavita.id)[0].pricingConfigId);
});

test('reset to demo restores the Mehfil Kitchen defaults', async () => {
  const ctx = setupOwner();
  const o = await login(ctx.app);
  await o.postForm('/owner/setup', form());
  assert.equal(ctx.repos.businessSettings.get().businessName, 'Spice Route');
  const res = await o.postForm('/owner/setup/reset');
  assert.equal(res.status, 303);
  assert.equal(ctx.repos.businessSettings.get().businessName, 'Mehfil Kitchen');
  assert.deepEqual(ctx.repos.pricingConfigs.latestApproved().configJson, DEMO_PRICING_CONFIG);
  assert.match((await o.get('/owner')).text, /Mehfil Kitchen/);
});
