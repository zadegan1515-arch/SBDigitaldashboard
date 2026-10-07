// The LinkedIn fill's first job (Leo, Sep 2026: "planned brands first"):
// brands on the Schedule's coming days that are short on people, so they
// have someone to invite by their day. Pure — liList in
// src/app/api/ingest/route.ts reads the plan, what the Schedule last
// showed on each day and the brands, and hands them here. The Schedule's
// contacts labels (contactLabel in src/app/api/data/route.ts) use the
// same workNeed, so "short" means the same thing in both places.
// Tested by scripts/test-planned-first.mjs.

import { BIG_BRAND_WORK } from './brand-size'

// How many people a brand works at once: Leo's number if he set one,
// else ten at a big company (brand-size.ts — 500+ on LinkedIn, owned by a
// parent company, or the parent itself; Leo, Oct 7 2026), four at an
// established brand and three elsewhere.
export function workNeed(b: { tier: string | null; workPeople: number | null; liMembers?: number | null; big?: boolean }): number {
  if (b.workPeople) return b.workPeople
  if (b.big) return BIG_BRAND_WORK
  return b.tier === 'established' ? 4 : 3
}

// Short on people: fewer reachable (a LinkedIn or an email) than it
// works at once — the Schedule's Thin or No one reachable.
export function shortOnPeople(b: {
  tier: string | null; workPeople: number | null; big?: boolean
  contacts: Array<{ email: string | null; linkedinUrl: string | null }>
}): boolean {
  return b.contacts.filter(c => !!(c.email || c.linkedinUrl)).length < workNeed(b)
}

// The day key n days after `key` (noon UTC is the same calendar date in
// New York, so the key never slides).
function shiftKey(key: string, n: number): string {
  return new Date(new Date(`${key}T12:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10)
}

const isKey = (k: unknown): k is string => typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k)
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

// brandId -> the soonest day it is due. From the plan (Setting
// outreachPlan, { day: { brandIds } }): a day in the last week counts
// too — until the morning roll moves it, a brand pinned to a day that
// went by unsent is due now. From what the Schedule last showed
// (Setting outreachShownDays, { days: { day: brandIds } }, pinned and
// rotation rows alike): today and later only.
export function dueDays(input: { plan: unknown; shown?: unknown; today: string }): Map<string, string> {
  const out = new Map<string, string>()
  const note = (id: string, day: string) => {
    const had = out.get(id)
    if (!had || day < had) out.set(id, day)
  }
  const weekAgo = shiftKey(input.today, -7)
  const plan = input.plan && typeof input.plan === 'object' ? (input.plan as Record<string, any>) : {}
  for (const [day, d] of Object.entries(plan)) {
    if (!isKey(day) || day < weekAgo) continue
    for (const id of ids(d?.brandIds)) note(id, day)
  }
  const shown = input.shown && typeof input.shown === 'object' ? (input.shown as any).days : null
  if (shown && typeof shown === 'object') {
    for (const [day, list] of Object.entries(shown as Record<string, unknown>)) {
      if (!isKey(day) || day < input.today) continue
      for (const id of ids(list)) note(id, day)
    }
  }
  return out
}

// The worklist with the planned brands that are short on people first —
// the soonest day, then the emptiest, then the name — each marked with
// its day. Everything else keeps the order it came in.
export function plannedFirst<T extends { brandId: string; contacts: number; name: string }>(
  items: T[], due: ReadonlyMap<string, string>, short: ReadonlySet<string>,
): { first: Array<T & { planned: string }>; rest: T[] } {
  const first: Array<T & { planned: string }> = []
  const rest: T[] = []
  for (const it of items) {
    const day = short.has(it.brandId) ? due.get(it.brandId) : undefined
    if (day) first.push({ ...it, planned: day })
    else rest.push(it)
  }
  first.sort((a, b) => (a.planned < b.planned ? -1 : a.planned > b.planned ? 1 : 0) || a.contacts - b.contacts || a.name.localeCompare(b.name))
  return { first, rest }
}
