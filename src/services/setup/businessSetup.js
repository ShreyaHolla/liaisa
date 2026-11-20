// Owner business setup: read and write the same business config the engine, agent, forms, emails
// and quote page read. A save publishes a NEW approved pricing config, so existing quotes (which
// point at the config they were priced with) keep their numbers; only new enquiries use the edit.
import { ValidationError } from '../../errors.js';
import { normalisePhone } from '../enquiries/schema.js';
import { DEMO_BUSINESS, DEMO_PRICING_CONFIG } from '../../seed.js';
import { slugify } from './schema.js';
import { unitLabel } from '../../util/format.js';

/** Flat fee for an area: `{ fee }` areas directly, km-style areas via the distance bands. */
function feeOf(config, value) {
  if (typeof value === 'object' && value !== null) return value.fee;
  return config.travel.bands.find((b) => value <= b.max_km)?.fee ?? '';
}

/** What the form shows right now. */
export function currentSetup(repos) {
  const business = repos.businessSettings.get();
  const config = repos.pricingConfigs.latestApproved().configJson;
  return {
    businessName: business.businessName, tagline: business.tagline ?? '',
    currencySymbol: business.currencySymbol ?? '₹', whatsappNumber: business.whatsappNumber ?? '',
    city: business.city ?? '',
    bulkApproveLimit: business.bulkApproveLimit ?? '', autoApprove: Boolean(business.autoApprove),
    followupAfterDays: business.followupAfterDays ?? 2,
    weekendPct: config.surcharges.weekend_pct, taxPct: config.tax_pct,
    services: config.services.map((s) => ({
      id: s.id, name: s.name, price: s.price, minQty: s.min_qty, maxQty: s.max_qty ?? '', unitLabel: unitLabel(s),
    })),
    areas: Object.entries(config.travel.areas).map(([name, v]) => ({ name, fee: feeOf(config, v) })),
  };
}

/**
 * Save validated input (output of makeSetupSchema). Service ids are slugified from the name on
 * creation and stay stable on rename. Add-ons are carried over untouched.
 */
export function saveSetup(repos, input, countryCode, now = new Date()) {
  const current = repos.pricingConfigs.latestApproved().configJson;
  const old = new Map(current.services.map((s) => [s.id, s]));
  const taken = new Set(input.services.map((s) => s.id).filter((id) => old.has(id)));

  const services = input.services.map((s) => {
    const kept = s.id && old.get(s.id);
    const id = kept ? s.id : slugify(s.name);
    if (!kept && taken.has(id)) throw new ValidationError('Another service already uses this name.');
    taken.add(id);
    return {
      id, name: s.name, unit: kept ? kept.unit : 'per_person', unit_label: s.unitLabel, price: s.price,
      min_qty: s.minQty, ...(s.maxQty !== undefined ? { max_qty: s.maxQty } : {}),
    };
  });
  const areas = Object.fromEntries(input.areas.map((a) => [a.name, { fee: a.fee }]));

  repos.pricingConfigs.publish({
    ...current, tax_pct: input.taxPct, surcharges: { ...current.surcharges, weekend_pct: input.weekendPct },
    services, travel: { ...current.travel, areas },
  }, now);
  repos.businessSettings.save({
    businessName: input.businessName, tagline: input.tagline ?? null, currencySymbol: input.currencySymbol,
    whatsappNumber: input.whatsappNumber ? normalisePhone(input.whatsappNumber, countryCode) : null,
    followupAfterDays: input.followupAfterDays,
    bulkApproveLimit: input.bulkApproveLimit ?? null, autoApprove: input.autoApprove,
    ...(input.city ? { city: input.city } : {}), // blank keeps the current city
  });
}

/** "Reset to demo business": Mehfil Kitchen's name, prices and areas. Owner email and templates stay. */
export function resetToDemo(repos, now = new Date()) {
  repos.pricingConfigs.publish(structuredClone(DEMO_PRICING_CONFIG), now);
  repos.businessSettings.save({ ...DEMO_BUSINESS });
}
