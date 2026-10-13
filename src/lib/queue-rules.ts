// Who may go into the LinkedIn outreach queue that feeds the Schedule
// (Leo, Oct 12 2026: "i dont want brand i have already reached out to to
// be in the queue and i also dont want to reach out to super big brands
// yet, can we make a system to get the brands in queue for schedule").
//
//  - Anything the system picks by itself (the day's rotation, Fill to 30,
//    the Fill box, Plan my week, next best) takes only brands nobody has
//    reached out to: no LinkedIn invite ever (one logged outside the
//    queue, or withdrawn after it went, counts), no email, no accept or
//    reply.
//  - By hand, a brand that was reached out to rests REST_DAYS from its
//    first outreach ("it should not be reached out to again until two
//    weeks after initial outreach"); from that day on it can go again.
//  - Giants (giants.ts: household names, the big parent companies' brands,
//    $1B+ sales) and brands with 1,500+ people on LinkedIn (Leo, Oct 12
//    2026: "not reach out to any brand with over 1500 employees") are held
//    back for now: the system never picks one, and a hand add asks first
//    ("Add anyway" OKs that brand). Conglomerates — the parent companies
//    themselves (Diageo, Molson Coors, PepsiCo…) — are never held back
//    (Leo: "yes except for congomerates"): he works them as one account.
//  - People already waiting in the queue at such brands are skipped, not
//    removed: nothing here changes data.
//
// Days, not hours: everything is judged on New York day keys, like the
// Schedule. A brand first reached on Oct 1 can go again on Oct 15. The
// day a brand is first reached is its sitting — the rest of its people
// that day are the same outreach, not a second one — so nothing here
// stops a brand on the day it opened. A later day on the Schedule is
// judged as of that day.
//
// Pure — src/app/api/data/route.ts loads the rows and asks here.
// node scripts/test-queue-rules.mjs

import { giantWhy } from './giants'
import { isParentCompany } from './parents'

export const REST_DAYS = 14

// Setting outreachGiants = { on: boolean, ok: [brandId] }: the Schedule's
// Giants switch and the giants Leo OK'd one at a time ("Add anyway").
export const GIANTS_KEY = 'outreachGiants'
export function parseGiants(v: unknown): { on: boolean; ok: Set<string> } {
  const o = v && typeof v === 'object' ? (v as { on?: unknown; ok?: unknown }) : {}
  const ok = Array.isArray(o.ok) ? o.ok.filter((x): x is string => typeof x === 'string') : []
  return { on: o.on === true, ok: new Set(ok) }
}

const WRITTEN_TO = ['sent', 'accepted', 'replied', 'converted']

const NY_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
})
// The New York day key (YYYY-MM-DD) of a moment.
export function nyDayKey(d: Date): string {
  return NY_DAY.format(d)
}
// Noon UTC is the same calendar date in New York, so the key never slides.
export function addDays(key: string, n: number): string {
  return new Date(new Date(`${key}T12:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10)
}

// One person at the brand, as far as outreach goes. `emails` = emails the
// machine actually sent them; `firstEmailAt` = the earliest of those, when
// known; `updatedAt` stands in for the date of an accept or reply logged
// without an invite date.
export type OutreachRow = {
  status: string
  sentAt: Date | null
  emailedAt?: Date | null
  emails?: number
  firstEmailAt?: Date | null
  updatedAt?: Date | null
}

// Was this person reached out to? An invite with its date, a row past the
// invite (logged straight to accepted), a hand email, or a sent email. A
// "Withdrew" taken back as a mistake clears sentAt, so it doesn't count.
export function rowReached(t: OutreachRow): boolean {
  return !!t.sentAt || WRITTEN_TO.includes(t.status) || !!t.emailedAt || (t.emails ?? 0) > 0
}

// When the brand was first reached out to (null if never), and whether
// any of it is undated: an accept or reply logged from LinkedIn without
// an invite date, or an email whose date we don't have. An undated row
// counts from its last change — the closest date there is, and a late
// one, so the rest only ever runs long — and never makes a day the
// brand's sitting (Zach's list touches those rows every day).
export function outreachDates(rows: OutreachRow[]): { first: Date | null; undated: boolean } {
  let first: number | null = null
  let undated = false
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
    if (!t.sentAt && !t.emailedAt && !t.firstEmailAt) {
      undated = true
      note(t.updatedAt ?? null)
    }
  }
  return { first: first == null ? null : new Date(first), undated }
}
export function firstOutreachAt(rows: OutreachRow[]): Date | null {
  return outreachDates(rows).first
}

// The first day a reached brand may be queued again by hand.
export function restUntilDay(first: Date): string {
  return addDays(nyDayKey(first), REST_DAYS)
}

export type GateReason = 'reached' | 'resting' | 'giant'
export type Gate = { reason: GateReason; first?: Date; until?: string; why?: string } | null

// Why a brand can't go into the queue on `day` (a New York day key), or
// null when it can.
//  auto: true for anything the system picks by itself; false for a hand
//    add (which may still go after the rest, and may "add anyway" a giant).
//  giantsOn: Leo turned giants on (the Schedule's switch) or OK'd this one.
// A hand add only ever gets 'resting' or 'giant' back; 'giant' there is a
// question, not a refusal — the caller asks before adding.
export function queueGate(
  b: { name: string; aka?: string | null; salesCents?: bigint | number | null; liMembers?: number | null; rows: OutreachRow[] },
  opts: { auto: boolean; giantsOn: boolean; day: string },
): Gate {
  const { first, undated } = outreachDates(b.rows)
  // Reached before this day (the day it opened is its own sitting).
  if (first && (undated || nyDayKey(first) < opts.day)) {
    const until = restUntilDay(first)
    if (opts.auto) return { reason: 'reached', first, until }
    if (opts.day < until) return { reason: 'resting', first, until }
  }
  if (!opts.giantsOn) {
    const why = giantOf(b)
    if (why) return { reason: 'giant', why }
  }
  return null
}

// "Very big": this many people on LinkedIn (the People tab's "associated
// members", Brand.liMembers) — held back like a giant, and the LinkedIn
// fill's "Skip very big brands" leaves it off.
export const VERY_BIG_LI = 1500

// A conglomerate: one of the parent companies in parents.ts itself, by its
// name or any aka (Diageo, Molson Coors, PepsiCo, Bacardi…), not one of its
// brands. Leo reaches them as one account (Diageo's brands were combined
// into it), so neither the giants list nor the 1,500 rule holds one back.
// Their brands (Smirnoff, Bud Light…) are still giants.
export function isConglomerate(b: { name: string; aka?: string | null }): boolean {
  return isParentCompany(b.name, b.aka ?? null)
}

// 1,500+ people on LinkedIn, and not a conglomerate.
export function veryBigWhy(b: { name: string; aka?: string | null; liMembers?: number | null }): string | null {
  if ((b.liMembers ?? 0) < VERY_BIG_LI || isConglomerate(b)) return null
  return VERY_BIG_LI.toLocaleString('en-US') + '+ people on LinkedIn'
}

// Why the brand is held back as a giant, or null: giants.ts on its name,
// its other names and its sales when we know them, else 1,500+ people on
// LinkedIn. A conglomerate never is.
export function giantOf(b: { name: string; aka?: string | null; salesCents?: bigint | number | null; liMembers?: number | null }): string | null {
  if (isConglomerate(b)) return null
  const cents = b.salesCents == null ? null : Number(b.salesCents)
  return giantWhy(b.name, { aka: b.aka ?? null, salesUsd: cents == null || !isFinite(cents) ? null : cents / 100 })
    ?? veryBigWhy(b)
}
