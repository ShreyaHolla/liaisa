import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepos } from '../../src/container.js';
import { seed, DEMO_PRICING_CONFIG } from '../../src/seed.js';
import { createEstimate } from '../../src/services/estimates/createEstimate.js';
import { calculateEstimate } from '../../src/services/pricing/calculateEstimate.js';

function seeded() {
  const repos = createRepos();
  seed(repos);
  return repos;
}

test('TC-SET-01 seed gives business settings and exactly one approved config, with no network call', () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    throw new Error('network call during seed');
  };
  let repos;
  try {
    repos = seeded();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls, 0);
  assert.equal(repos.businessSettings.get().businessName, 'Mehfil Kitchen');
  const configs = repos.pricingConfigs.all();
  assert.equal(configs.length, 1);
  assert.equal(configs[0].status, 'approved');
  assert.deepEqual(configs[0].configJson, DEMO_PRICING_CONFIG);
  assert.equal(repos.aiCalls.all().every((c) => c.ok), true);
});

test('seed: 7 enquiries across 7 statuses; every estimate is priced by calculateEstimate', () => {
  const repos = seeded();
  const enquiries = repos.enquiries.list();
  assert.equal(enquiries.length, 7);
  assert.equal(new Set(enquiries.map((e) => e.status)).size, 7);
  const config = repos.pricingConfigs.latestApproved();
  let estimates = 0;
  for (const e of enquiries) {
    for (const est of repos.estimates.listByEnquiry(e.id)) {
      estimates += 1;
      assert.equal(est.pricingConfigId, config.id);
      assert.equal(est.total, calculateEstimate(config.configJson, e.requirementsJson).total);
      if (est.status === 'sent') assert.equal(est.quoteToken.length, 43);
    }
  }
  assert.equal(estimates, 6);
  const counts = repos.enquiries.countByStatus();
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 7);
  assert.equal(counts.collecting, 1);
});

test('TC-SET-04 a new estimate uses the latest approved config and records its id', () => {
  const repos = seeded();
  const oldConfig = repos.pricingConfigs.latestApproved();
  const edited = structuredClone(oldConfig.configJson);
  edited.services.find((s) => s.id === 'veg_buffet').price = 500;
  const newConfig = repos.pricingConfigs.publish(edited);

  assert.notEqual(newConfig.id, oldConfig.id);
  assert.equal(repos.pricingConfigs.get(oldConfig.id).status, 'superseded');

  const enquiry = repos.enquiries.list().find((e) => e.status === 'awaiting_approval');
  const before = repos.estimates.listByEnquiry(enquiry.id)[0];
  const est = createEstimate(repos, enquiry.id, { revisionReason: 'Price change' });
  assert.equal(est.pricingConfigId, newConfig.id);
  assert.equal(est.version, before.version + 1);
  assert.equal(est.total, calculateEstimate(edited, enquiry.requirementsJson).total);
  assert.ok(est.total > before.total);
});

test('createEstimate refuses when there is no approved config', () => {
  const repos = createRepos();
  const e = repos.enquiries.create({
    customerName: 'Test', rawText: 'x', status: 'collecting',
    requirementsJson: { service_id: 'veg_buffet', quantity: 30 },
  });
  assert.throws(() => createEstimate(repos, e.id), /no approved pricing config/);
});

test('repos enforce the PRD enums and unique keys', () => {
  const repos = createRepos();
  assert.throws(() => repos.enquiries.create({ customerName: 'A', rawText: 'x', status: 'bogus' }), /invalid status/);
  repos.followups.create({ enquiryId: 1, step: 1, dueAt: new Date(), channel: 'email' });
  assert.throws(() => repos.followups.create({ enquiryId: 1, step: 1, dueAt: new Date(), channel: 'email' }), /duplicate/);
});
