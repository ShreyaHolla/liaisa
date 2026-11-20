// What the customer can do on /q/:token (F7). The token is the only credential; every miss is a plain 404.
import { ConflictError, NotFoundError } from '../../errors.js';
import { cancelFollowups } from '../followups/cancel.js';
import { notifyOwner } from './mail.js';
import { ownerResponseEmail } from './messages.js';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const EXPIRY_GRACE_DAYS = 30;
const OPEN = ['awaiting_approval', 'quoted', 'followed_up'];
const clock = (deps) => (deps.now ?? (() => new Date()))();

export class QuoteExpiredError extends Error {
  constructor() {
    super('This quote has expired. Please contact the business for a new one.');
    this.name = 'QuoteExpiredError';
    this.status = 410;
  }
}

/** The approved quote behind a token, or NotFoundError (same error for every kind of miss). */
export function findQuote(deps, token) {
  const { repos } = deps;
  if (typeof token !== 'string' || !TOKEN.test(token)) throw new NotFoundError();
  const estimate = repos.estimates.getByToken(token);
  const enquiry = estimate ? repos.enquiries.get(estimate.enquiryId) : null;
  if (!estimate || !enquiry || estimate.status === 'superseded' || ['declined', 'out_of_scope'].includes(enquiry.status)) throw new NotFoundError();
  return { estimate, enquiry };
}

/** Past valid_until + 30 days. */
export function isExpired(estimate, now) {
  const limit = new Date(`${estimate.validUntil}T00:00:00Z`).getTime() + (EXPIRY_GRACE_DAYS + 1) * 86400000;
  return now.getTime() >= limit;
}

function open(deps, token) {
  const found = findQuote(deps, token);
  if (isExpired(found.estimate, clock(deps))) throw new QuoteExpiredError();
  return found;
}

/** Accept: enquiry won, reminders cancelled, owner told. Accepting again changes nothing. */
export async function acceptQuote(deps, token) {
  const { repos, config } = deps;
  const { enquiry } = open(deps, token);
  const message = `Accepted. ${repos.businessSettings.get().businessName} will be in touch to confirm.`;
  if (enquiry.status === 'won') return { enquiryStatus: 'won', message };
  if (!OPEN.includes(enquiry.status)) throw new ConflictError('This quote is no longer open.');
  repos.enquiries.update(enquiry.id, { status: 'won' });
  repos.customerResponses.create({ enquiryId: enquiry.id, type: 'accept' }, clock(deps));
  cancelFollowups(repos, enquiry.id);
  await notifyOwner(deps, enquiry.id, ownerResponseEmail({ config, enquiry, type: 'accept' }));
  return { enquiryStatus: 'won', message };
}

/**
 * A question: saved, owner told. Reminders are paused while it is unanswered (the M8 runner skips
 * enquiries whose latest response is a question), so nothing is cancelled here.
 */
export async function askQuestion(deps, token, text) {
  const { repos, config } = deps;
  const { enquiry } = open(deps, token);
  if (!OPEN.includes(enquiry.status)) throw new ConflictError('This quote is no longer open.');
  repos.customerResponses.create({ enquiryId: enquiry.id, type: 'question', message: text }, clock(deps));
  await notifyOwner(deps, enquiry.id, ownerResponseEmail({ config, enquiry, type: 'question', message: text }));
  return { enquiryStatus: enquiry.status, message: 'Question sent.' };
}

/** Decline: enquiry lost, reminders cancelled. Declining again changes nothing. */
export function declineQuote(deps, token, reason, { doNotContact = false } = {}) {
  const { repos } = deps;
  const { enquiry } = findQuote(deps, token); // declining stays possible after expiry
  if (doNotContact && ['lost', ...OPEN].includes(enquiry.status)) repos.enquiries.update(enquiry.id, { doNotContact: true });
  if (enquiry.status === 'lost') return { enquiryStatus: 'lost', message: 'Declined.' };
  if (!OPEN.includes(enquiry.status)) throw new ConflictError('This quote is no longer open.');
  repos.enquiries.update(enquiry.id, { status: 'lost' });
  repos.customerResponses.create({ enquiryId: enquiry.id, type: 'decline', ...(reason ? { message: reason } : {}) }, clock(deps));
  cancelFollowups(repos, enquiry.id);
  return { enquiryStatus: 'lost', message: 'Declined.' };
}
