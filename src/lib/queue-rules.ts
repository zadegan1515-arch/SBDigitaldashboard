// Who may go into the LinkedIn outreach queue that feeds the Schedule
// (Leo, Oct 12 2026: "i dont want brand i have already reached out to to
// be in the queue and i also dont want to reach out to super big brands
// yet, can we make a system to get the brands in queue for schedule").
//
//  - Anything the system picks by itself (the day's rotation, Fill to 20,
//    the Fill box, Plan my week, next best) takes only brands nobody has
//    reached out to: no LinkedIn invite ever (one logged outside the
//    queue, or withdrawn after it went, counts), no email, no accept or
//    reply.
//  - By hand, a brand that was reached out to rests REST_DAYS from its
//    first outreach ("it should not be reached out to again until two
//    weeks after initial outreach"); after that it can go again.
//  - Giants (giants.ts: household names, the big parent companies and
//    their brands, $1B+ sales) are held back for now: the system never
//    picks one, and a hand add asks first.
//  - People already waiting in the queue at such brands are skipped, not
//    removed: nothing here changes data.
//
// Pure — src/app/api/data/route.ts loads the rows and asks here.
// node scripts/test-queue-rules.mjs

import { giantWhy } from './giants'

export const REST_DAYS = 14

const DAY_MS = 864e5
const WRITTEN_TO = ['sent', 'accepted', 'replied', 'converted']

// One person at the brand, as far as outreach goes. `emails` = emails the
// machine actually sent them; `firstEmailAt` = the earliest of those, when
// known; `loggedAt` = when an accept/reply logged without an invite date
// happened (falls back to updatedAt).
export type OutreachRow = {
  status: string
  sentAt: Date | null
  emailedAt?: Date | null
  emails?: number
  firstEmailAt?: Date | null
  loggedAt?: Date | null
  updatedAt?: Date | null
}

// Was this person reached out to? An invite with its date, a row past the
// invite (logged straight to accepted), a hand email, or a sent email. A
// "Withdrew" taken back as a mistake clears sentAt, so it doesn't count.
export function rowReached(t: OutreachRow): boolean {
  return !!t.sentAt || WRITTEN_TO.includes(t.status) || !!t.emailedAt || (t.emails ?? 0) > 0
}

// When the brand was first reached out to, or null if never.
export function firstOutreachAt(rows: OutreachRow[]): Date | null {
  let first: number | null = null
  const note = (d: Date | null | undefined) => {
    if (!d) return
    const ms = d.getTime()
    if (!isNaN(ms) && (first == null || ms < first)) first = ms
  }
  for (const t of rows) {
    if (!rowReached(t)) continue
    note(t.sentAt)
    note(t.emailedAt)
    note(t.firstEmailAt)
    // Logged without an invite date (an accept or reply from LinkedIn):
    // the log is the closest date there is.
    if (!t.sentAt && !t.emailedAt && !t.firstEmailAt) note(t.loggedAt ?? t.updatedAt ?? null)
  }
  return first == null ? null : new Date(first)
}

// The first moment a reached brand may be queued again by hand.
export function restUntil(first: Date): Date {
  return new Date(first.getTime() + REST_DAYS * DAY_MS)
}

export type GateReason = 'reached' | 'resting' | 'giant'
export type Gate = { reason: GateReason; first?: Date; until?: Date; why?: string } | null

// Why a brand can't go into the queue, or null when it can.
//  auto: true for anything the system picks by itself; false for a hand
//    add (which may still go after the rest, and may "add anyway" a giant).
//  giantsOn: Leo turned giants on (the Schedule's switch).
// A hand add only ever gets 'resting' or 'giant' back; 'giant' there is a
// question, not a refusal — the caller asks before adding.
export function queueGate(
  b: { name: string; aka?: string | null; salesCents?: bigint | number | null; rows: OutreachRow[] },
  opts: { auto: boolean; giantsOn: boolean; now?: Date },
): Gate {
  const now = opts.now ?? new Date()
  const first = firstOutreachAt(b.rows)
  if (first) {
    if (opts.auto) return { reason: 'reached', first, until: restUntil(first) }
    const until = restUntil(first)
    if (now.getTime() < until.getTime()) return { reason: 'resting', first, until }
  }
  if (!opts.giantsOn) {
    const why = giantOf(b)
    if (why) return { reason: 'giant', why }
  }
  return null
}

// Why the brand is a giant, or null (giants.ts on its name, its other
// names and its sales when we know them).
export function giantOf(b: { name: string; aka?: string | null; salesCents?: bigint | number | null }): string | null {
  const cents = b.salesCents == null ? null : Number(b.salesCents)
  return giantWhy(b.name, { aka: b.aka ?? null, salesUsd: cents == null || !isFinite(cents) ? null : cents / 100 })
}
