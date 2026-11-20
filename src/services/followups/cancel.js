/** Cancel reminders that haven't gone out (accept, decline, owner decline). M8 builds scheduling on top. */
export function cancelFollowups(repos, enquiryId) {
  for (const f of repos.followups.listByEnquiry(enquiryId)) {
    if (f.status === 'pending' || f.status === 'awaiting_owner') repos.followups.update(f.id, { status: 'cancelled' });
  }
}
