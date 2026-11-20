/** Cost in USD from token usage and per-million-token prices (env). Rounded to 6 decimals. */
export function computeCostUsd(usage, prices) {
  const per = (tokens, price) => (tokens ?? 0) * (price ?? 0);
  const micro =
    per(usage.input, prices.input) +
    per(usage.output, prices.output) +
    per(usage.cacheRead, prices.cacheRead) +
    per(usage.cacheWrite, prices.cacheWrite);
  return Number((micro / 1e6).toFixed(6));
}
