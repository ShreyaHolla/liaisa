// Display helpers shared by views and emails (DESIGN §4.3, §7).
const INR = new Intl.NumberFormat('en-IN');

/** 26061 -> '₹26,061', 120000 -> '₹1,20,000', -1300 -> '−₹1,300'. `symbol` is display only (owner setup). */
export function inr(amount, symbol = '₹') {
  const n = Math.round(Number(amount) || 0);
  return `${n < 0 ? '−' : ''}${symbol}${INR.format(Math.abs(n))}`;
}

/** What the quantity is counted in, for labels: 'Number of guests', 'Hours'. */
export function unitLabel(service) {
  return service?.unit_label || (service?.unit === 'per_hour' ? 'Hours' : 'Number of guests');
}

/** 'just now', '2 min ago', '3 h ago', '4 d ago'. */
export function timeAgo(date, now = new Date()) {
  const mins = Math.max(0, Math.floor((now - new Date(date)) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)} h ago`;
  return `${Math.floor(mins / 1440)} d ago`;
}

/** Calendar date (YYYY-MM-DD) `days` after `from`. */
export function dateAfter(from, days) {
  return new Date(from.getTime() + days * 86400000).toISOString().slice(0, 10);
}
