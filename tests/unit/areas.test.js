import test from 'node:test';
import assert from 'node:assert/strict';
import { matchArea, missingFields, normaliseRequirements } from '../../src/services/agent/areas.js';
import { formatDate } from '../../src/util/formatDate.js';
import { DEMO_PRICING_CONFIG } from '../../src/seed.js';

const AREAS = Object.keys(DEMO_PRICING_CONFIG.travel.areas);

test('matchArea: exact, case-insensitive, and the name inside longer text', () => {
  assert.equal(matchArea('koramangala', AREAS), 'Koramangala');
  assert.equal(matchArea('  INDIRANAGAR ', AREAS), 'Indiranagar');
  assert.equal(matchArea('5th Block Koramangala, near the park', AREAS), 'Koramangala');
});

test('matchArea: close misspellings map to the configured area', () => {
  assert.equal(matchArea('Kormangala', AREAS), 'Koramangala');
  assert.equal(matchArea('5th Block Kormangala', AREAS), 'Koramangala');
  assert.equal(matchArea('Whitfield', AREAS), 'Whitefield');
  assert.equal(matchArea('Indira nagar', AREAS), 'Indiranagar'); // split in two words
  assert.equal(matchArea('Jayanagar', AREAS), null); // a real place we don't serve
});

test('matchArea: unknown places and empty text stay unmatched', () => {
  assert.equal(matchArea('Mysore', AREAS), null);
  assert.equal(matchArea('', AREAS), null);
  assert.equal(matchArea(undefined, AREAS), null);
});

test('missingFields and normaliseRequirements use the approved config', () => {
  assert.deepEqual(missingFields(DEMO_PRICING_CONFIG, { service_id: 'veg_buffet', quantity: 40, location: '' }), ['event_date', 'location']);
  const out = normaliseRequirements(DEMO_PRICING_CONFIG, { service_id: 'veg_buffet', location: 'Kormangala' });
  assert.equal(out.location, 'Koramangala');
  assert.deepEqual(normaliseRequirements(DEMO_PRICING_CONFIG, { location: 'Mysore' }), { location: 'Mysore' });
});

test('formatDate: "Sat 5 Dec" style, and bad input passes through', () => {
  assert.equal(formatDate('2026-12-05'), 'Sat 5 Dec');
  assert.equal(formatDate('2026-12-13'), 'Sun 13 Dec');
  assert.equal(formatDate('2027-01-01'), 'Fri 1 Jan');
  assert.equal(formatDate('2026-02-30'), '2026-02-30');
  assert.equal(formatDate('soon'), 'soon');
  assert.equal(formatDate(undefined), '');
});
