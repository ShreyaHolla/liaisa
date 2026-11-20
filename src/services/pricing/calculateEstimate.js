import { ValidationError } from '../../errors.js';
import { toPaise, paiseToRupees, roundToRupee, percentOf } from './money.js';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 0 = Sunday ... 6 = Saturday, from the calendar date alone (no timezone drift). */
function weekdayOf(dateStr) {
  const m = DATE_RE.exec(dateStr);
  if (!m) throw new ValidationError('event_date must be YYYY-MM-DD');
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    throw new ValidationError('event_date is not a real date');
  }
  return date.getUTCDay();
}

function validate(config, req) {
  if (req === null || typeof req !== 'object') throw new ValidationError('requirements missing');
  const service = config.services.find((s) => s.id === req.service_id);
  if (!service) throw new ValidationError('Unknown service_id');
  if (!Number.isInteger(req.quantity) || req.quantity < 1) {
    throw new ValidationError('quantity must be a positive whole number');
  }
  const addonIds = req.addon_ids === undefined ? [] : req.addon_ids;
  if (!Array.isArray(addonIds)) throw new ValidationError('addon_ids must be a list');
  const addons = [...new Set(addonIds)].map((id) => {
    const addon = config.addons.find((a) => a.id === id);
    if (!addon) throw new ValidationError('Unknown add-on id');
    return addon;
  });
  const km = req.distance_km;
  if (km !== undefined && !(typeof km === 'number' && Number.isFinite(km) && km >= 0)) {
    throw new ValidationError('distance_km must be a number of 0 or more');
  }
  const hasDate = req.event_date !== undefined && req.event_date !== null && req.event_date !== '';
  const weekday = hasDate ? weekdayOf(req.event_date) : null;
  return { service, addons, weekday };
}

function unitQuantity(item, quantity) {
  return item.unit === 'flat' ? 1 : quantity;
}

/**
 * Flat travel fee (whole rupees) when the named area is configured as `{ fee }`, else null.
 * An explicit distance_km always wins, so the area is ignored then.
 */
function flatFeeFor(config, req) {
  if (req.distance_km !== undefined || !Object.hasOwn(config.travel.areas, req.location)) return null;
  const area = config.travel.areas[req.location];
  return typeof area === 'object' && area !== null ? area.fee : null;
}

/** Travel distance in km from `distance_km` or the named area, else null. */
function distanceFor(config, req) {
  if (req.distance_km !== undefined) return req.distance_km;
  const areas = config.travel.areas;
  return Object.hasOwn(areas, req.location) ? areas[req.location] : null;
}

/**
 * Pure pricing engine (PRD F5, TestCases §2 calculation order).
 * Returns whole-rupee integers; paise are used only inside this function.
 * Throws ValidationError for input that cannot be priced; rate-card mismatches
 * come back as `warnings` and are never silently fixed.
 * `options.discount` ({ amount: whole rupees, reason }) is the owner's own figure, never Claude's.
 * It comes off after weekend and travel, before tax, so tax applies to the discounted amount.
 */
export function calculateEstimate(config, req, options = {}) {
  const { service, addons, weekday } = validate(config, req);
  const warnings = [];
  const lines = []; // { kind, label, quantity?, unitPrice?, paise }

  // 1. Items
  if (req.quantity < service.min_qty) warnings.push('below_min_qty');
  if (service.max_qty !== undefined && req.quantity > service.max_qty) {
    warnings.push('above_max_qty');
  }
  const priced = [
    { kind: 'service', item: service },
    ...addons.map((item) => ({ kind: 'addon', item })),
  ];
  for (const { kind, item } of priced) {
    const quantity = unitQuantity(item, req.quantity);
    const unit = toPaise(item.price);
    lines.push({
      kind,
      label: item.name,
      quantity,
      unitPrice: paiseToRupees(unit),
      paise: roundToRupee(unit * quantity),
    });
  }
  const itemsTotal = lines.reduce((sum, l) => sum + l.paise, 0);

  // 2. Minimum order
  const minimum = toPaise(config.minimum_order);
  let base = itemsTotal;
  if (itemsTotal < minimum) {
    lines.push({
      kind: 'minimum_adjustment',
      label: 'Minimum order adjustment',
      paise: minimum - itemsTotal,
    });
    base = minimum;
  }

  // 3. Weekend surcharge on the step-2 amount
  if (weekday === null) {
    warnings.push('missing_date');
  } else if (weekday === 0 || weekday === 6) {
    const pct = config.surcharges.weekend_pct;
    lines.push({ kind: 'weekend', label: `Weekend surcharge (${pct}%)`, paise: percentOf(base, pct) });
  }

  // 4. Travel fee: a flat fee for the area, else from the distance band
  const flatFee = flatFeeFor(config, req);
  const km = flatFee === null ? distanceFor(config, req) : null;
  if (flatFee !== null) {
    if (flatFee > 0) lines.push({ kind: 'travel', label: 'Travel fee', paise: toPaise(flatFee) });
  } else if (km === null) {
    warnings.push('unknown_location');
  } else {
    const band = config.travel.bands.find((b) => km <= b.max_km);
    if (!band) {
      warnings.push('outside_delivery_area');
    } else if (band.fee > 0) {
      lines.push({ kind: 'travel', label: 'Travel fee', paise: toPaise(band.fee) });
    }
  }

  // 4b. Owner discount: whole rupees, with a reason, never more than the pre-tax amount
  const { discount } = options;
  if (discount !== undefined) {
    if (!Number.isInteger(discount.amount) || discount.amount < 1) {
      throw new ValidationError('discount must be a whole number of rupees, 1 or more');
    }
    if (typeof discount.reason !== 'string' || discount.reason.trim() === '') {
      throw new ValidationError('discount needs a reason');
    }
    const preTax = lines.reduce((sum, l) => sum + l.paise, 0);
    if (toPaise(discount.amount) > preTax) {
      throw new ValidationError('discount is more than the amount before tax');
    }
    lines.push({ kind: 'discount', label: 'Discount', reason: discount.reason.trim(), paise: -toPaise(discount.amount) });
  }

  // 5. Tax on everything so far
  const subtotal = lines.reduce((sum, l) => sum + l.paise, 0);
  const taxPaise = percentOf(subtotal, config.tax_pct);
  if (taxPaise > 0) {
    lines.push({ kind: 'tax', label: `Tax (${config.tax_pct}%)`, paise: taxPaise });
  }

  // 6. Every line is already a whole-rupee amount; the total is their exact sum.
  const lineItems = lines.map(({ paise, ...rest }) => ({ ...rest, amount: paiseToRupees(paise) }));
  return {
    lineItems,
    subtotal: paiseToRupees(subtotal),
    tax: paiseToRupees(taxPaise),
    total: paiseToRupees(subtotal + taxPaise),
    currency: config.currency,
    warnings,
  };
}
