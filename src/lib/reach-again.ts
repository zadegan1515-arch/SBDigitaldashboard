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
// after. Never a brand where someone answered (accepted, replied or said
// no — they're on Zach's list, and a second name would cut across that
// conversation), with a deal, set aside
// (archived, do-not-email, not sold in the US, said they don't want to
// continue) or on a Pass.
//
// Pure — route.ts loads the rows (weekBank `again`, reachAgain) and asks here.
// node scripts/test-reach-again.mjs

import { buyerKind, type BuyerKind } from './buyers'
import { REST_DAYS } from './queue-rules'

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
// stopped, not flagged. Partnerships first, then events, then marketing and
// founders; a contact marked decision maker with another title last.
export function freshDecisionMakers(contacts: AgainContact[], targets: AgainTarget[]): AgainContact[] {
  const byContact = new Map<string, AgainTarget[]>()
  for (const t of targets) byContact.set(t.contactId, [...(byContact.get(t.contactId) ?? []), t])
  const rank = (c: AgainContact) => { const k = buyerKind(c.title); return k ? KIND_ORDER[k] : 3 }
  return contacts
    .filter(c => c.reachable && !c.stopped && !c.flagged && (c.isDecisionMaker || !!buyerKind(c.title)))
    .filter(c => {
      const rows = byContact.get(c.id) ?? []
      if (rows.some(rowReached)) return false
      // Left out on purpose (passed, or shelved by hand — not "next in line").
      if (rows.some(t => t.status === 'passed' || (t.shelved && t.shelvedHow !== 'cap'))) return false
      return true
    })
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map(x => x.c)
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
  | { ok: true; state: 'due' | 'late'; last: string; daysSince: number; from: string; dueBy: string; fresh: AgainContact[] }

// Whether to recommend reaching out again, as of `today` (a New York day key).
export function reachAgainOf(opts: {
  contacts: AgainContact[]; targets: AgainTarget[]; today: string
  // Someone accepted, replied or said no; a deal; the brand set aside.
  answered: boolean; deal: boolean; off: boolean
}): Again {
  const last = lastOutreachAt(opts.targets)
  if (!last) return { ok: false, why: 'never' }
  if (opts.answered) return { ok: false, why: 'answered' }
  if (opts.deal) return { ok: false, why: 'deal' }
  if (opts.off) return { ok: false, why: 'off' }
  const lastKey = dayKeyOf(last)
  const daysSince = daysBetween(lastKey, opts.today)
  const from = shiftKey(lastKey, AGAIN_FROM_DAYS)
  if (daysSince < AGAIN_FROM_DAYS) return { ok: false, why: 'soon', from }
  const fresh = freshDecisionMakers(opts.contacts, opts.targets)
  if (!fresh.length) return { ok: false, why: 'nobody' }
  return {
    ok: true, state: daysSince <= AGAIN_DUE_DAYS ? 'due' : 'late',
    last: lastKey, daysSince, from, dueBy: shiftKey(lastKey, AGAIN_DUE_DAYS), fresh,
  }
}
