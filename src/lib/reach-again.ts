// Reach out again (Leo, Oct 18 2026: "build something where u recommend for
// me to reach out to brands again if there are decision makers who i did not
// reach out to yet, also if i reach out to a brand again it should be around
// 1 to 2 weeks later").
//
// A brand is recommended when we reached out there before, a week or more has
// gone by since the last outreach (the hand-add rest, queue-rules.ts
// REST_DAYS), and someone there who decides — a partnerships, events,
// marketing or founder title (buyers.ts), or a contact marked decision maker —
// has never been contacted. Due from day 7 to day 14 ("1 to 2 weeks"), late
// after. Never a brand where someone replied (Leo: "if someone has replied
// then we prob shouldnt reach out to their company again") — a reply, a no,
// a call booked, in talks — nor with a deal, set aside
// (archived, do-not-email, not sold in the US, said they don't want to
// continue) or on a Pass. Someone who only accepted doesn't stop it: the
// clock then runs from Zach's last message to them (alsoAt).
// People outside the US (a title naming another region, or where they are —
// abroad.ts) are left out unless the company is based outside the US (Leo,
// Oct 18 2026); there, people in the US still go first.
//
// Pure — route.ts loads the rows (weekBank `again`, reachAgain) and asks here.
// node scripts/test-reach-again.mjs

import { buyerKind, type BuyerKind } from './buyers'
import { REST_DAYS } from './queue-rules'
import type { Where } from './abroad'

export const AGAIN_FROM_DAYS = REST_DAYS
export const AGAIN_DUE_DAYS = 14

export type AgainContact = {
  id: string; name: string; title: string | null
  isDecisionMaker: boolean
  // Has a LinkedIn link or an email.
  reachable: boolean
  // Said they don't want to continue (or a copy of someone who did).
  stopped: boolean
  // The queue check flags the title (student, store staff, investor…).
  flagged: boolean
  // Where they work (abroad.ts personWhere); null = not known.
  where?: Where
}
export type AgainTarget = {
  contactId: string; status: string; shelved: boolean; shelvedHow: string | null
  sentAt: Date | null; emailedAt: Date | null; emailSentAt: Date | null
  repliedAt?: Date | null; updatedAt: Date
}

const REACHED_STATUS = ['sent', 'accepted', 'replied', 'converted', 'declined', 'dead']

// Anything went out to this row: an invite (withdrawn since counts — it
// keeps its date; one taken back the day it was sent has none and never
// went), an email, or an answer logged.
export function rowReached(t: AgainTarget): boolean {
  return !!t.sentAt || !!t.emailedAt || !!t.emailSentAt || REACHED_STATUS.includes(t.status)
}

// The last day anything went out at the brand (an accept logged with no
// invite date counts from the row's last change).
export function lastOutreachAt(targets: AgainTarget[]): Date | null {
  let ms = 0
  for (const t of targets) {
    if (!rowReached(t)) continue
    const ds = [t.sentAt, t.emailedAt, t.emailSentAt].filter((d): d is Date => !!d)
    if (!ds.length) ds.push(t.updatedAt)
    for (const d of ds) ms = Math.max(ms, d.getTime())
  }
  return ms ? new Date(ms) : null
}

const KIND_ORDER: Record<BuyerKind, number> = { partnerships: 0, events: 1, marketing: 2, founder: 2 }

// The people who decide there and have never been contacted: no outreach on
// any row of theirs, not passed over or set aside on purpose, reachable, not
// stopped, not flagged, in the US unless the company is based abroad.
// Partnerships first, then events, then marketing and founders; a contact
// marked decision maker with another title last. At a company based abroad,
// people in the US go first, then those we can't place, then the rest.
export function freshDecisionMakers(contacts: AgainContact[], targets: AgainTarget[], opts: { basedAbroad?: boolean } = {}): AgainContact[] {
  return freshAndAbroad(contacts, targets, opts).fresh
}
// The same, and how many were left out for working outside the US.
export function freshAndAbroad(contacts: AgainContact[], targets: AgainTarget[], opts: { basedAbroad?: boolean } = {}) {
  const byContact = new Map<string, AgainTarget[]>()
  for (const t of targets) byContact.set(t.contactId, [...(byContact.get(t.contactId) ?? []), t])
  const rank = (c: AgainContact) => { const k = buyerKind(c.title); return k ? KIND_ORDER[k] : 3 }
  const place = (c: AgainContact) => (opts.basedAbroad ? (c.where === 'us' ? 0 : c.where === 'abroad' ? 2 : 1) : 0)
  let abroad = 0
  const fresh = contacts
    .filter(c => c.reachable && !c.stopped && !c.flagged && (c.isDecisionMaker || !!buyerKind(c.title)))
    .filter(c => {
      const rows = byContact.get(c.id) ?? []
      if (rows.some(rowReached)) return false
      // Left out on purpose (passed, or shelved by hand — not "next in line").
      if (rows.some(t => t.status === 'passed' || (t.shelved && t.shelvedHow !== 'cap'))) return false
      return true
    })
    .filter(c => {
      if (c.where !== 'abroad' || opts.basedAbroad) return true
      abroad++
      return false
    })
    .map((c, i) => ({ c, i }))
    .sort((a, b) => place(a.c) - place(b.c) || rank(a.c) - rank(b.c) || a.i - b.i)
    .map(x => x.c)
  return { fresh, abroad }
}

function dayKeyOf(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d)
}
export function daysBetween(fromKey: string, toKey: string): number {
  return Math.round((Date.parse(`${toKey}T12:00:00Z`) - Date.parse(`${fromKey}T12:00:00Z`)) / 864e5)
}
function shiftKey(key: string, n: number): string {
  return new Date(Date.parse(`${key}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10)
}

export type AgainWhy = 'never' | 'answered' | 'deal' | 'off' | 'soon' | 'nobody'
export type Again =
  | { ok: false; why: AgainWhy; from?: string }
  | { ok: true; state: 'due' | 'late'; last: string; daysSince: number; from: string; dueBy: string; fresh: AgainContact[]; abroad: number }

// Whether to recommend reaching out again, as of `today` (a New York day key).
export function reachAgainOf(opts: {
  contacts: AgainContact[]; targets: AgainTarget[]; today: string
  // Someone replied or said no (a call booked, in talks); a deal; the brand set aside.
  answered: boolean; deal: boolean; off: boolean
  // Later messages to the brand's people (Zach's DMs to someone who accepted).
  alsoAt?: Array<Date | null>
  // The company is based outside the US (abroad.ts basedAbroad).
  basedAbroad?: boolean
}): Again {
  const first = lastOutreachAt(opts.targets)
  if (!first) return { ok: false, why: 'never' }
  const later = (opts.alsoAt ?? []).filter((d): d is Date => !!d).map(d => d.getTime())
  const last = new Date(Math.max(first.getTime(), ...later))
  if (opts.answered) return { ok: false, why: 'answered' }
  if (opts.deal) return { ok: false, why: 'deal' }
  if (opts.off) return { ok: false, why: 'off' }
  const lastKey = dayKeyOf(last)
  const daysSince = daysBetween(lastKey, opts.today)
  const from = shiftKey(lastKey, AGAIN_FROM_DAYS)
  if (daysSince < AGAIN_FROM_DAYS) return { ok: false, why: 'soon', from }
  const { fresh, abroad } = freshAndAbroad(opts.contacts, opts.targets, { basedAbroad: opts.basedAbroad })
  if (!fresh.length) return { ok: false, why: 'nobody' }
  return {
    ok: true, state: daysSince <= AGAIN_DUE_DAYS ? 'due' : 'late',
    last: lastKey, daysSince, from, dueBy: shiftKey(lastKey, AGAIN_DUE_DAYS), fresh, abroad,
  }
}
