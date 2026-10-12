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
//  - Giants (giants.ts: household names, the big parent companies and
//    their brands, $1B+ sales) are held back for now: the system never
//    picks one, and a hand add asks first ("Add anyway" OKs that brand).
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
// Part-sent brands (Leo, Oct 12 2026: "If Zach sends only some of a
// brand's people one day, the rest go out on the next sending day"): the
// sitting runs on to the next sending day after the first one, for the
// hand paths only (the morning roll's pin, a hand add) — so the rest of
// that first outreach finishes there, and only there. The two weeks
// start after the sitting: from its second day when anything went out
// then, else from its first.
//
// Pure — src/app/api/data/route.ts loads the rows and asks here.
// node scripts/test-queue-rules.mjs

import { giantWhy } from './giants'

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

// The first day a reached brand may be queued again by hand, counted
// from its first outreach (a brand with no second sitting day).
export function restUntilDay(first: Date): string {
  return addDays(nyDayKey(first), REST_DAYS)
}

// The sending day after a day key (route.ts knows the days: Tue–Thu plus
// the extra days Leo opened). Missing = no second sitting day at all.
export type NextSending = (day: string) => string | null

// The brand's sitting and its rest: `days` = the day its first outreach
// began, then the next sending day (the rest of a part-sent brand goes
// out there); `restFrom` = the sitting's last day that anything went out
// on; `until` = the first day it may be queued again by hand. An undated
// reach (an accept logged without its invite, an email with no date) is
// never a sitting: it counts from its last change, as before.
export type Sitting = { first: Date; days: string[]; restFrom: string; until: string }
export function sittingOf(rows: OutreachRow[], nextSending?: NextSending): Sitting | null {
  const { first, undated } = outreachDates(rows)
  if (!first) return null
  const day1 = nyDayKey(first)
  if (undated) return { first, days: [], restFrom: day1, until: addDays(day1, REST_DAYS) }
  const day2 = nextSending ? nextSending(day1) : null
  const days = day2 && day2 > day1 ? [day1, day2] : [day1]
  const restFrom = days.length > 1 && reachDays(rows).has(days[1]) ? days[1] : day1
  return { first, days, restFrom, until: addDays(restFrom, REST_DAYS) }
}

// The New York days anything dated went out on.
function reachDays(rows: OutreachRow[]): Set<string> {
  const out = new Set<string>()
  for (const t of rows) {
    if (!rowReached(t)) continue
    for (const d of [t.sentAt, t.emailedAt, t.firstEmailAt]) if (d && !isNaN(d.getTime())) out.add(nyDayKey(d))
  }
  return out
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
// nextSending: the sending days, for a part-sent brand's second sitting
// day (hand paths only); without it the sitting is its first day alone.
export function queueGate(
  b: { name: string; aka?: string | null; salesCents?: bigint | number | null; rows: OutreachRow[] },
  opts: { auto: boolean; giantsOn: boolean; day: string; nextSending?: NextSending },
): Gate {
  const s = sittingOf(b.rows, opts.nextSending)
  // Reached before this day (the day it opened is its own sitting; by
  // hand, so is the next sending day — the rest of a part-sent brand).
  if (s && (!s.days.length || s.days[0] < opts.day)) {
    const sitting = !opts.auto && s.days.includes(opts.day)
    if (opts.auto) return { reason: 'reached', first: s.first, until: s.until }
    if (!sitting && opts.day < s.until) return { reason: 'resting', first: s.first, until: s.until }
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
