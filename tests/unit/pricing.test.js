import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateEstimate } from '../../src/services/pricing/calculateEstimate.js';
import { toPaise, paiseToRupees, roundToRupee, percentOf } from '../../src/services/pricing/money.js';
import { ValidationError } from '../../src/errors.js';

// PRD §7.1 demo config (TestCases §2).
const config = {
  currency: 'INR',
  tax_pct: 5,
  minimum_order: 5000,
  services: [
    { id: 'veg_buffet', name: 'Veg buffet', unit: 'per_person', price: 450, min_qty: 20, max_qty: 200 },
    { id: 'nonveg_buffet', name: 'Non-veg buffet', unit: 'per_person', price: 600, min_qty: 20, max_qty: 200 },
    { id: 'live_counter', name: 'Live dosa counter', unit: 'per_hour', price: 2500, min_qty: 2 },
  ],
  addons: [
    { id: 'dessert', name: 'Dessert counter', unit: 'per_person', price: 80 },
    { id: 'staff', name: 'Serving staff', unit: 'flat', price: 3000 },
  ],
  surcharges: { weekend_pct: 10 },
  travel: {
    areas: { Koramangala: 5, Indiranagar: 8, Whitefield: 18 },
    bands: [{ max_km: 10, fee: 0 }, { max_km: 25, fee: 1500 }],
  },
};

const amount = (est, kind) => est.lineItems.find((l) => l.kind === kind)?.amount;
const kinds = (est) => est.lineItems.map((l) => l.kind);
const sumLines = (est) => est.lineItems.reduce((s, l) => s + l.amount, 0);

test('TC-PRC-01 weekday, Indiranagar, no extras', () => {
  const e = calculateEstimate(config, { service_id: 'veg_buffet', quantity: 40, event_date: '2026-12-15', location: 'Indiranagar' });
  assert.equal(amount(e, 'service'), 18000);
  assert.deepEqual(kinds(e), ['service', 'tax']);
  assert.equal(e.tax, 900);
  assert.equal(e.total, 18900);
  assert.equal(e.currency, 'INR');
  assert.deepEqual(e.warnings, []);
});

test('TC-PRC-02 weekend + add-on + Whitefield travel', () => {
  const e = calculateEstimate(config, { service_id: 'veg_buffet', quantity: 40, addon_ids: ['dessert'], event_date: '2026-12-12', location: 'Whitefield' });
  assert.equal(amount(e, 'service') + amount(e, 'addon'), 21200);
  assert.equal(amount(e, 'weekend'), 2120);
  assert.equal(amount(e, 'travel'), 1500);
  assert.equal(e.tax, 1241);
  assert.equal(e.total, 26061);
});

test('TC-PRC-03 per-hour service + flat add-on', () => {
  const e = calculateEstimate(config, { service_id: 'live_counter', quantity: 3, addon_ids: ['staff'], event_date: '2026-12-15', location: 'Koramangala' });
  assert.equal(e.subtotal, 10500);
  assert.equal(e.tax, 525);
  assert.equal(e.total, 11025);
  const staff = e.lineItems.find((l) => l.kind === 'addon');
  assert.equal(staff.quantity, 1);
  assert.equal(staff.unitPrice, 3000);
});

test('TC-PRC-04 half-up rounding of tax (556.5 -> 557)', () => {
  const e = calculateEstimate(config, { service_id: 'veg_buffet', quantity: 21, addon_ids: ['dessert'], event_date: '2026-12-15', location: 'Koramangala' });
  assert.equal(e.subtotal, 11130);
  assert.equal(e.tax, 557);
  assert.equal(e.total, 11687);
});

test('TC-PRC-05 below minimum order adds adjustment and warns', () => {
  const e = calculateEstimate(config, { service_id: 'veg_buffet', quantity: 10, event_date: '2026-12-15', location: 'Koramangala' });
  assert.equal(amount(e, 'service'), 4500);
  assert.equal(amount(e, 'minimum_adjustment'), 500);
  assert.equal(e.tax, 250);
  assert.equal(e.total, 5250);
  assert.deepEqual(e.warnings, ['below_min_qty']);
});

test('TC-PRC-05b weekend surcharge is on the amount after the minimum adjustment', () => {
  const e = calculateEstimate(config, { service_id: 'veg_buffet', quantity: 10, event_date: '2026-12-12', location: 'Koramangala' });
  assert.equal(amount(e, 'weekend'), 500);
});

test('TC-PRC-06 above max quantity is priced as given with a warning', () => {
  const e = calculateEstimate(config, { service_id: 'nonveg_buffet', quantity: 250, event_date: '2026-12-15', location: 'Koramangala' });
  assert.equal(amount(e, 'service'), 150000);
  assert.deepEqual(e.warnings, ['above_max_qty']);
});

test('TC-PRC-07 per-hour service below minimum warns', () => {
  const e = calculateEstimate(config, { service_id: 'live_counter', quantity: 1, event_date: '2026-12-15', location: 'Koramangala' });
  assert.ok(e.warnings.includes('below_min_qty'));
});

test('TC-PRC-08 unknown service id throws ValidationError', () => {
  assert.throws(() => calculateEstimate(config, { service_id: 'pizza', quantity: 10 }), ValidationError);
});

test('TC-PRC-09 unknown add-on id throws ValidationError', () => {
  assert.throws(() => calculateEstimate(config, { service_id: 'veg_buffet', quantity: 40, addon_ids: ['fireworks'] }), ValidationError);
});

test('TC-PRC-10 unknown location, no distance: no travel fee, warning', () => {
  const e = calculateEstimate(config, { service_id: 'veg_buffet', quantity: 40, event_date: '2026-12-15', location: 'Mysore' });
  assert.equal(amount(e, 'travel'), undefined);
  assert.deepEqual(e.warnings, ['unknown_location']);
});

test('TC-PRC-10b no location at all also warns unknown_location', () => {
  const e = calculateEstimate(config, { service_id: 'veg_buffet', quantity: 40, event_date: '2026-12-15' });
  assert.deepEqual(e.warnings, ['unknown_location']);
});

test('TC-PRC-10c distance_km overrides an unknown location', () => {
  const e = calculateEstimate(config, { service_id: 'veg_buffet', quantity: 40, event_date: '2026-12-15', location: 'Mysore', distance_km: 12 });
  assert.equal(amount(e, 'travel'), 1500);
  assert.deepEqual(e.warnings, []);
});

test('TC-PRC-10d area names like "constructor" are not treated as areas', () => {
  const e = calculateEstimate(config, { service_id: 'veg_buffet', quantity: 40, event_date: '2026-12-15', location: 'constructor' });
  assert.deepEqual(e.warnings, ['unknown_location']);
});

test('TC-PRC-11 distance beyond the last band: no fee, warning', () => {
  const e = calculateEstimate(config, { service_id: 'veg_buffet', quantity: 40, event_date: '2026-12-15', distance_km: 30 });
  assert.equal(amount(e, 'travel'), undefined);
  assert.deepEqual(e.warnings, ['outside_delivery_area']);
});

test('TC-PRC-11b band edges: 10 km free, 25 km charged, 0 km free', () => {
  const run = (distance_km) => calculateEstimate(config, { service_id: 'veg_buffet', quantity: 40, event_date: '2026-12-15', distance_km });
  assert.equal(amount(run(10), 'travel'), undefined);
  assert.equal(amount(run(0), 'travel'), undefined);
  assert.equal(amount(run(25), 'travel'), 1500);
  assert.deepEqual(run(10).warnings, []);
});

test('TC-PRC-12 missing date: no weekend surcharge, warning', () => {
  for (const event_date of [undefined, null, '']) {
    const e = calculateEstimate(config, { service_id: 'veg_buffet', quantity: 40, event_date, location: 'Koramangala' });
    assert.equal(amount(e, 'weekend'), undefined);
    assert.deepEqual(e.warnings, ['missing_date']);
  }
});

test('TC-PRC-12b malformed or impossible date throws ValidationError', () => {
  for (const event_date of ['12 Dec 2026', '2026-13-01', '2026-02-30', 20261212]) {
    assert.throws(() => calculateEstimate(config, { service_id: 'veg_buffet', quantity: 40, event_date }), ValidationError);
  }
});

test('TC-PRC-13 zero, negative or non-integer quantity throws ValidationError', () => {
  for (const quantity of [0, -5, 2.5, '40', NaN, undefined]) {
    assert.throws(() => calculateEstimate(config, { service_id: 'veg_buffet', quantity }), ValidationError);
  }
});

test('TC-PRC-13b bad requirements, add-on list or distance throw ValidationError', () => {
  assert.throws(() => calculateEstimate(config, null), ValidationError);
  assert.throws(() => calculateEstimate(config, 'veg'), ValidationError);
  assert.throws(() => calculateEstimate(config, { service_id: 'veg_buffet', quantity: 40, addon_ids: 'dessert' }), ValidationError);
  for (const distance_km of [-1, NaN, Infinity, '5', null]) {
    assert.throws(() => calculateEstimate(config, { service_id: 'veg_buffet', quantity: 40, distance_km }), ValidationError);
  }
});

test('TC-PRC-13c duplicate add-on ids are charged once', () => {
  const e = calculateEstimate(config, { service_id: 'veg_buffet', quantity: 40, addon_ids: ['dessert', 'dessert'], event_date: '2026-12-15', location: 'Koramangala' });
  assert.equal(e.lineItems.filter((l) => l.kind === 'addon').length, 1);
});

test('TC-PRC-14 same input twice gives identical output, and input is not mutated', () => {
  const input = { service_id: 'veg_buffet', quantity: 40, addon_ids: ['dessert'], event_date: '2026-12-12', location: 'Whitefield' };
  const frozen = structuredClone(input);
  const cfg = structuredClone(config);
  assert.deepEqual(calculateEstimate(config, input), calculateEstimate(config, input));
  assert.deepEqual(input, frozen);
  assert.deepEqual(config, cfg);
});

test('TC-PRC-15 Sunday gets the weekend surcharge; Friday and Monday do not', () => {
  const run = (event_date) => calculateEstimate(config, { service_id: 'veg_buffet', quantity: 40, event_date, location: 'Koramangala' });
  assert.equal(amount(run('2026-12-13'), 'weekend'), 1800);
  assert.equal(amount(run('2026-12-12'), 'weekend'), 1800);
  assert.equal(amount(run('2026-12-11'), 'weekend'), undefined);
  assert.equal(amount(run('2026-12-14'), 'weekend'), undefined);
});

test('TC-PRC-16 integers only; total equals the exact sum of lines', () => {
  const cases = [
    { service_id: 'veg_buffet', quantity: 21, addon_ids: ['dessert'], event_date: '2026-12-12', distance_km: 18 },
    { service_id: 'live_counter', quantity: 7, addon_ids: ['staff', 'dessert'], event_date: '2026-12-13', location: 'Whitefield' },
    { service_id: 'veg_buffet', quantity: 3, event_date: '2026-12-12', location: 'Indiranagar' },
  ];
  for (const input of cases) {
    const e = calculateEstimate(config, input);
    assert.ok(e.lineItems.every((l) => Number.isInteger(l.amount)));
    assert.ok(Number.isInteger(e.total) && Number.isInteger(e.subtotal) && Number.isInteger(e.tax));
    assert.equal(sumLines(e), e.total);
    assert.equal(e.subtotal + e.tax, e.total);
  }
});

test('TC-PRC-16b fractional config values do not drift (0.1 + 0.2 style)', () => {
  const cfg = { ...config, tax_pct: 12.5, services: [{ id: 's', name: 'S', unit: 'per_person', price: 33.33, min_qty: 1 }], addons: [], minimum_order: 0 };
  const e = calculateEstimate(cfg, { service_id: 's', quantity: 3, event_date: '2026-12-15', location: 'Koramangala' });
  assert.equal(amount(e, 'service'), 100); // 99.99 rounds half up to 100
  assert.equal(e.tax, 13); // 12.5
  assert.equal(sumLines(e), e.total);
});

test('zero tax and no max_qty produce no tax line', () => {
  const e = calculateEstimate({ ...config, tax_pct: 0 }, { service_id: 'live_counter', quantity: 2, event_date: '2026-12-15', location: 'Koramangala' });
  assert.deepEqual(kinds(e), ['service']);
  assert.equal(e.tax, 0);
  assert.equal(e.total, 5000);
});

test('money helpers: half-up rounding at the boundary', () => {
  assert.equal(toPaise(0.29), 29);
  assert.equal(paiseToRupees(49), 0);
  assert.equal(paiseToRupees(50), 1);
  assert.equal(roundToRupee(150), 200);
  assert.equal(percentOf(1113000, 5), 55700); // 556.50 -> 557
  assert.equal(percentOf(1000, 5), 100); // 0.50 -> 1
  assert.equal(percentOf(900, 5), 0); // 0.45 -> 0
});

// Owner discount (M7): after weekend and travel, before tax.
const WEEKEND_WHITEFIELD = { service_id: 'veg_buffet', quantity: 40, event_date: '2026-12-12', location: 'Whitefield' };

test('discount comes off after weekend and travel, and tax applies to the discounted amount', () => {
  const e = calculateEstimate(config, WEEKEND_WHITEFIELD, { discount: { amount: 1300, reason: 'Repeat customer' } });
  assert.deepEqual(kinds(e), ['service', 'weekend', 'travel', 'discount', 'tax']);
  assert.equal(amount(e, 'discount'), -1300);
  assert.equal(e.lineItems.find((l) => l.kind === 'discount').reason, 'Repeat customer');
  assert.equal(e.subtotal, 20000); // 18000 + 1800 + 1500 - 1300
  assert.equal(e.tax, 1000);
  assert.equal(e.total, 21000);
  assert.equal(sumLines(e), e.total);
});

test('a discount equal to the pre-tax amount is allowed (total 0); one rupee more is rejected', () => {
  const req = { service_id: 'veg_buffet', quantity: 40, event_date: '2026-12-15', location: 'Indiranagar' };
  const free = calculateEstimate(config, req, { discount: { amount: 18000, reason: 'Gift' } });
  assert.equal(free.total, 0);
  assert.throws(() => calculateEstimate(config, req, { discount: { amount: 18001, reason: 'Gift' } }), ValidationError);
});

test('discount must be a positive whole number with a reason', () => {
  for (const bad of [{ amount: 0, reason: 'x' }, { amount: 10.5, reason: 'x' }, { amount: -5, reason: 'x' }, { amount: 100, reason: '  ' }, { amount: 100 }]) {
    assert.throws(() => calculateEstimate(config, WEEKEND_WHITEFIELD, { discount: bad }), ValidationError);
  }
});
