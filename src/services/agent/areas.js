// Location helpers: map what the customer typed to a configured travel area, and find missing fields.

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * The configured area that `text` means, or null. Tries, in order: the exact name, the name as
 * whole words inside the text ("5th Block Koramangala"), then a close spelling (edit distance
 * of 2 or less, words of 5+ letters). More than one close match counts as no match.
 */
export function matchArea(text, areas) {
  const t = norm(text ?? '');
  if (!t) return null;
  const named = areas.map((a) => ({ area: a, n: norm(a) }));
  const exact = named.find((x) => x.n === t) ?? named.find((x) => ` ${t} `.includes(` ${x.n} `));
  if (exact) return exact.area;

  const words = t.split(' ');
  const candidates = [...words, ...words.slice(1).map((w, i) => `${words[i]} ${w}`)].filter((c) => c.length >= 5);
  const hits = new Set();
  for (const c of candidates) {
    for (const x of named) if (distance(c, x.n) <= 2) hits.add(x.area);
  }
  return hits.size === 1 ? [...hits][0] : null;
}

/** Required fields (from the approved config) that are still empty. */
export function missingFields(pricing, requirements) {
  return pricing.required_fields.filter((f) => [undefined, null, ''].includes(requirements[f]));
}

/** Snap `location` to a configured area when it clearly means one. */
export function normaliseRequirements(pricing, requirements) {
  if (!requirements.location) return requirements;
  const area = matchArea(requirements.location, Object.keys(pricing.travel.areas));
  return area ? { ...requirements, location: area } : requirements;
}
