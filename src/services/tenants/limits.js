// Per-business daily limits and the platform-wide AI cap. The demo business keeps the configured caps; every
// business that signs up starts lower (NEW_BUSINESS_*), so a stranger can't spend the demo's budget.
export function startOfUtcDay(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** { aiRequests, drafts, discoveryRuns } for this business. A per-business override (repos.business.limits) wins. */
export function limitsOf(repos, config) {
  const base = repos.business.isDemo
    ? { aiRequests: config.ai.dailyCap, drafts: config.clientDraftDailyCap, discoveryRuns: config.clientDiscoveryDailyCap }
    : { aiRequests: config.newBusiness.aiRequests, drafts: config.newBusiness.drafts, discoveryRuns: config.newBusiness.discoveryRuns };
  return { ...base, ...(repos.business.limits ?? {}) };
}

/** AI requests this business made today (UTC day, same as the guard). */
export const businessAiToday = (repos, now) => repos.aiCalls.countSince(startOfUtcDay(now));

/** AI requests across ALL businesses today. Falls back to this business when there is no registry (unit tests). */
export function globalAiToday(repos, now) {
  const from = startOfUtcDay(now);
  return repos.global ? repos.global.aiCallsSince(from) : repos.aiCalls.countSince(from);
}

/** Why the AI must not be called right now, or null. 'global_cap' = the platform budget; 'daily_cap' = this business's. */
export function aiBudgetBlock(repos, config, now) {
  if (businessAiToday(repos, now) >= limitsOf(repos, config).aiRequests) return 'daily_cap';
  if (globalAiToday(repos, now) >= config.ai.globalDailyCap) return 'global_cap';
  return null;
}

export const RESTING_TEXT = 'AI is resting for today, the form still works. Fill in the details below and the owner will take it from there.';
