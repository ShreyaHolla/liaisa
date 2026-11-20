// Money helpers. Amounts are integer paise internally; whole rupees only at the boundary.

const PAISE = 100;

/** Rupees (number) to integer paise. */
export function toPaise(rupees) {
  return Math.round(rupees * PAISE);
}

/** Integer paise to whole rupees, rounding half up. */
export function paiseToRupees(paise) {
  return Math.floor((paise + PAISE / 2) / PAISE);
}

/** Round integer paise to a whole-rupee amount (still in paise), half up. */
export function roundToRupee(paise) {
  return paiseToRupees(paise) * PAISE;
}

/**
 * `pct` percent of `paise`, rounded half up to a whole-rupee amount (in paise).
 * The percentage is held in basis points so the arithmetic stays in integers.
 */
export function percentOf(paise, pct) {
  const basisPoints = Math.round(pct * 100);
  return Math.floor((paise * basisPoints + 500000) / 1000000) * PAISE;
}
