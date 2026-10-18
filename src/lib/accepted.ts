// Home → Accepted on LinkedIn (Leo, Oct 18 2026: "a list of all of the most
// recent and in total people that have been accepted on linkedin and the brand
// and the title"). Pure rules for the `acceptedPeople` handler in route.ts;
// node scripts/test-accepted.mjs.
//
// Who counts: everyone whose LinkedIn invite was accepted and still stands —
//   • status accepted (incl. "They accepted" logged with no invite date);
//   • replied / converted / said no with an accept on record;
//   • replied / converted on LinkedIn with no accept logged (an invite went
//     out and the reply wasn't an email) — they're connected.
// Not: an accept that was undone (status back to sent), or a reply that came
// only by email.

export type AcceptedInput = {
  status: string
  sentAt: Date | null
  repliedAt: Date | null
  updatedAt: Date
  dmSentAt: Date | null
  callAt: Date | null
  handDeclinedAt: Date | null
  acceptedAt: Date | null       // first TargetEvent to 'accepted'
  emailReply: boolean           // an inbound email on this outreach row
  contactStopped: boolean       // Contact.doNotContactAt
  brandStopped: boolean         // Brand.stoppedAt
}

const AFTER_ACCEPT = ['replied', 'converted', 'declined']

export function isAccepted(t: AcceptedInput): boolean {
  if (t.status === 'accepted') return true
  if (!AFTER_ACCEPT.includes(t.status)) return false
  if (t.acceptedAt) return true
  return (t.status === 'replied' || t.status === 'converted') && !!t.sentAt && !t.emailReply
}

// The date the list sorts by: the accept when it was logged, else the reply.
export function acceptedWhen(t: AcceptedInput): { at: Date; kind: 'accepted' | 'replied' } {
  if (t.acceptedAt) return { at: t.acceptedAt, kind: 'accepted' }
  if (t.status === 'accepted') return { at: t.updatedAt, kind: 'accepted' }
  return { at: t.repliedAt ?? t.updatedAt, kind: 'replied' }
}

// One short word for where they are now.
export function acceptedStage(t: AcceptedInput, now = new Date()): { stage: string; label: string } {
  if (t.contactStopped || t.handDeclinedAt || t.brandStopped) return { stage: 'stopped', label: 'doesn’t want to continue' }
  if (t.status === 'declined') return { stage: 'declined', label: 'said no' }
  if (t.callAt) return { stage: 'call', label: t.callAt >= startOfDay(now) ? 'call booked' : 'had a call' }
  if (t.status === 'converted') return { stage: 'converted', label: 'converted' }
  if (t.status === 'replied') return { stage: 'replied', label: 'replied' }
  if (t.dmSentAt) return { stage: 'messaged', label: 'messaged' }
  return { stage: 'accepted', label: 'accepted' }
}

function startOfDay(d: Date) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}
