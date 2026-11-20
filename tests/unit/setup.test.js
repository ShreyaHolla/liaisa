import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSetupSchema, slugify } from '../../src/services/setup/schema.js';
import { currentSetup, saveSetup, resetToDemo } from '../../src/services/setup/businessSetup.js';
import { createRepos } from '../../src/container.js';
import { seed, DEMO_PRICING_CONFIG } from '../../src/seed.js';
import { calculateEstimate } from '../../src/services/pricing/calculateEstimate.js';

const schema = makeSetupSchema('91');
const base = () => ({
  businessName: 'Spice Route', tagline: 'Street food, catered', currencySymbol: '₹', whatsappNumber: '98450 12345',
  weekendPct: '10', taxPct: '5',
  services: [{ id: 'veg_buffet', name: 'Veg buffet', price: '500', minQty: '20', maxQty: '200', unitLabel: 'Number of guests' }],
  areas: [{ name: 'Koramangala', fee: '0' }, { name: 'Hebbal', fee: '800' }],
});
const issues = (input) => {
  const r = schema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};
const withRepos = () => {
  const repos = createRepos();
  seed(repos);
  return repos;
};

test('slugify: stable ids that match the service_id pattern', () => {
  assert.equal(slugify('Veg Buffet!'), 'veg_buffet');
  assert.equal(slugify('  Non-veg   buffet '), 'non_veg_buffet');
  assert.equal(slugify('मेहफिल'), '');
  assert.match(slugify('x'.repeat(80)), /^[a-z0-9_]{2,40}$/);
});

test('setup schema accepts a good form and turns strings into numbers', () => {
  const r = schema.safeParse(base());
  assert.equal(r.success, true);
  assert.equal(r.data.services[0].price, 500);
  assert.equal(r.data.services[0].maxQty, 200);
  assert.equal(r.data.areas[1].fee, 800);
  assert.equal(r.data.weekendPct, 10);
});

test('setup schema: prices and fees are whole rupees, 0 or more', () => {
  for (const bad of ['-1', '10.5', 'abc', '']) {
    const a = base();
    a.services[0].price = bad;
    assert.ok(issues(a).some((m) => m.startsWith('services.0.price')), `price ${bad}`);
    const b = base();
    b.areas[1].fee = bad;
    assert.ok(issues(b).some((m) => m.startsWith('areas.1.fee')), `fee ${bad}`);
  }
  const free = base();
  free.areas[0].fee = '0';
  assert.deepEqual(issues(free), []);
});

test('setup schema: percentages, quantities, symbol and WhatsApp number', () => {
  for (const [key, val] of [['weekendPct', '101'], ['weekendPct', '-1'], ['taxPct', 'x'], ['taxPct', '5.123']]) {
    assert.ok(issues({ ...base(), [key]: val }).some((m) => m.startsWith(key)), `${key} ${val}`);
  }
  const q = base();
  q.services[0].minQty = '0';
  assert.ok(issues(q).some((m) => m.startsWith('services.0.minQty')));
  q.services[0].minQty = '50';
  q.services[0].maxQty = '10';
  assert.ok(issues(q).some((m) => m.startsWith('services.0.maxQty')));
  assert.ok(issues({ ...base(), currencySymbol: 'RUPEES' }).some((m) => m.startsWith('currencySymbol')));
  assert.ok(issues({ ...base(), whatsappNumber: '12345' }).some((m) => m.startsWith('whatsappNumber')));
  assert.ok(issues({ ...base(), businessName: '  ' }).some((m) => m.startsWith('businessName')));
  assert.deepEqual(issues({ ...base(), whatsappNumber: '' , tagline: ''}), []);
});

test('setup schema: at least one and at most 10 services, 1 and 20 areas', () => {
  assert.ok(issues({ ...base(), services: [] }).some((m) => /Keep at least one service/.test(m)));
  assert.ok(issues({ ...base(), areas: [] }).some((m) => /Keep at least one area/.test(m)));
  const svc = (i) => ({ name: `Service ${i}`, price: '100', minQty: '1', maxQty: '', unitLabel: '' });
  assert.deepEqual(issues({ ...base(), services: Array.from({ length: 10 }, (_, i) => svc(i)) }), []);
  assert.ok(issues({ ...base(), services: Array.from({ length: 11 }, (_, i) => svc(i)) }).some((m) => /up to 10 services/.test(m)));
  const area = (i) => ({ name: `Area ${i}`, fee: '0' });
  assert.deepEqual(issues({ ...base(), areas: Array.from({ length: 20 }, (_, i) => area(i)) }), []);
  assert.ok(issues({ ...base(), areas: Array.from({ length: 21 }, (_, i) => area(i)) }).some((m) => /up to 20 areas/.test(m)));
});

test('setup schema rejects duplicate names after slugifying (services) and ignoring case (areas)', () => {
  const s = base();
  s.services.push({ name: 'VEG  buffet!', price: '1', minQty: '1', maxQty: '', unitLabel: '' });
  assert.ok(issues(s).some((m) => m === 'services.1.name: Another service already has this name.'));
  const a = base();
  a.areas.push({ name: 'koramangala', fee: '0' });
  assert.ok(issues(a).some((m) => m === 'areas.2.name: Another area already has this name.'));
  const bad = base();
  bad.services[0].name = '!!';
  assert.ok(issues(bad).some((m) => /at least 2 letters or numbers/.test(m)));
});

test('saveSetup: new config is published, old quotes keep their config; ids stay stable on rename', () => {
  const repos = withRepos();
  const before = repos.pricingConfigs.latestApproved();
  const parsed = schema.parse({
    ...base(),
    services: [
      { id: 'veg_buffet', name: 'Pure veg thali', price: '500', minQty: '20', maxQty: '', unitLabel: 'Plates' },
      { id: '', name: 'Chaat counter', price: '3000', minQty: '2', maxQty: '', unitLabel: 'Hours' },
    ],
  });
  saveSetup(repos, parsed, '91');
  const after = repos.pricingConfigs.latestApproved();
  assert.notEqual(after.id, before.id);
  assert.equal(repos.pricingConfigs.get(before.id).status, 'superseded');
  assert.deepEqual(repos.pricingConfigs.get(before.id).configJson, DEMO_PRICING_CONFIG, 'the old config is untouched');
  assert.deepEqual(after.configJson.services.map((s) => s.id), ['veg_buffet', 'chaat_counter']);
  assert.equal(after.configJson.services[0].name, 'Pure veg thali');
  assert.equal(after.configJson.services[0].unit_label, 'Plates');
  assert.equal(after.configJson.services[0].max_qty, undefined);
  assert.deepEqual(after.configJson.travel.areas, { Koramangala: { fee: 0 }, Hebbal: { fee: 800 } });
  assert.deepEqual(after.configJson.addons, DEMO_PRICING_CONFIG.addons, 'add-ons are carried over');
  const b = repos.businessSettings.get();
  assert.deepEqual([b.businessName, b.tagline, b.whatsappNumber], ['Spice Route', 'Street food, catered', '919845012345']);
  // The engine prices a new enquiry with the edited numbers.
  const quote = calculateEstimate(after.configJson, { service_id: 'chaat_counter', quantity: 3, event_date: '2026-12-15', location: 'Hebbal' });
  assert.equal(quote.lineItems.find((l) => l.kind === 'service').amount, 9000);
  assert.equal(quote.lineItems.find((l) => l.kind === 'travel').amount, 800);
});

test('currentSetup shows km-style demo areas as fees; resetToDemo restores the Mehfil defaults', () => {
  const repos = withRepos();
  const shown = currentSetup(repos);
  assert.deepEqual(shown.areas, [{ name: 'Koramangala', fee: 0 }, { name: 'Indiranagar', fee: 0 }, { name: 'Whitefield', fee: 1500 }]);
  assert.equal(shown.services[2].unitLabel, 'Hours');
  saveSetup(repos, schema.parse(base()), '91');
  assert.equal(repos.businessSettings.get().businessName, 'Spice Route');
  resetToDemo(repos);
  const reset = repos.businessSettings.get();
  assert.deepEqual([reset.businessName, reset.tagline, reset.currencySymbol, reset.whatsappNumber], ['Mehfil Kitchen', 'Home-style catering for Bengaluru celebrations', '₹', null]);
  assert.equal(reset.ownerEmail, 'owner@mehfilkitchen.example', 'owner email is not touched');
  assert.deepEqual(repos.pricingConfigs.latestApproved().configJson, DEMO_PRICING_CONFIG);
});
