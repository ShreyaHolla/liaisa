import { aiBudgetBlock, startOfUtcDay } from '../tenants/limits.js';

// Guards (ARCHITECTURE §7.3). Return a reason string when the AI must not be called, else null.
export const MAX_REQUESTS_PER_ENQUIRY = 4;
export const MAX_QUESTIONS = 2;

export function dailyCallCount(repos, now) {
  return repos.aiCalls.countSince(startOfUtcDay(now));
}

export function checkGuards({ config, repos, enquiry, now }) {
  if (!config.aiEnabled) return 'ai_disabled';
  if (enquiry.aiRequestsUsed >= MAX_REQUESTS_PER_ENQUIRY) return 'request_cap';
  return aiBudgetBlock(repos, config, now);
}

export const canAskQuestion = (state) => state.questionsAsked < MAX_QUESTIONS;
