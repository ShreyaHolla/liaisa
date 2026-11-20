// Guards (ARCHITECTURE §7.3). Return a reason string when the AI must not be called, else null.
export const MAX_REQUESTS_PER_ENQUIRY = 4;
export const MAX_QUESTIONS = 2;

function startOfUtcDay(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function dailyCallCount(repos, now) {
  const from = startOfUtcDay(now);
  return repos.aiCalls.all().filter((r) => r.createdAt >= from).length;
}

export function checkGuards({ config, repos, enquiry, now }) {
  if (!config.aiEnabled) return 'ai_disabled';
  if (enquiry.aiRequestsUsed >= MAX_REQUESTS_PER_ENQUIRY) return 'request_cap';
  if (dailyCallCount(repos, now) >= config.ai.dailyCap) return 'daily_cap';
  return null;
}

export const canAskQuestion = (state) => state.questionsAsked < MAX_QUESTIONS;
