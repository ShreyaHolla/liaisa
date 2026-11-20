// The standard, no-AI message. Used when AI is off or capped, when the model's draft keeps failing
// validation, and by the mock AI client (so mock drafts are deterministic). Facts in, text out.
export function templateDraft(facts) {
  const first = `Hi ${facts.first_name}, this is ${facts.business_name}.`;
  const close = ' Just reply to this message if there is anything we can do.';
  if (facts.who_they_are !== undefined) {
    return `${first} We cater for events and would be glad to help if you are planning something.${close}`;
  }
  const past = [
    facts.last_service ? ` We remember your ${facts.last_service.toLowerCase()} enquiry` : null,
    facts.last_service && facts.event_type ? ` for your ${facts.event_type}` : null,
    facts.last_service && facts.event_date ? ` on ${facts.event_date}` : null,
    facts.last_service ? '.' : null,
  ].filter(Boolean).join('');
  // The angle comes from the rule-based reason text (see suggestReason in people.js).
  const reason = facts.reason ?? '';
  const angle = /^event (in|is)/.test(reason) ? ' Your event is coming up, and we would love to help.'
    : /^(recent customer|last event)/.test(reason) ? ' It was a pleasure working with you.'
      : ' If you are still planning something, we would be glad to help.';
  return `${first}${past}${angle}${close}`;
}
