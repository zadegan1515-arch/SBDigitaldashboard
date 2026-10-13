// How many people a brand works at once, and who stays in play — one rule
// for /api/data and /api/ingest (they each had a copy of the limit, and
// both kept at least four in play: a brand that works three sent four, and
// Leo's "work 1" still kept four). Oct 12 2026 (picks): each brand opens
// with exactly its number — Leo's own, else ten at a big company, four at
// an established brand, three elsewhere (workNeed, planned-first.ts) —
// best LinkedIn buyers first (comparePicks, queue-check.ts).
// Pure: the routes load the rows and write what comes back.
// node scripts/test-brand-work.mjs

import { brandSize } from './brand-size'
import { isParentCompany, parentOf } from './parents'
import { workNeed } from './planned-first'
import { sortPicks, type PickPerson } from './queue-check'

// A big company (Leo, Oct 7 2026: "for bigger brands we should expand the
// limit to 10 a day"): measured 500+ on LinkedIn, owned by a parent company
// we know, or that parent itself (Molson Coors). An established tier alone
// is a guess and no longer counts (brand-size.ts, Oct 12 2026).
// name / aka / liMembers are required on purpose (label-select): a select
// that left them out fell back to the tier, so the LinkedIn tab called a
// mid-size established brand "big, works 10" while the Schedule said 4.
export type BigBrandFacts = { name: string | null; aka: string | null; tier: string | null; liMembers: number | null }
export function isBigBrand(b: BigBrandFacts): boolean {
  if (b.name && isParentCompany(b.name, b.aka)) return true
  return brandSize({ liMembers: b.liMembers, tier: b.tier, hasParent: !!(b.name && parentOf(b.name, b.aka)) }) === 'big'
}

// How many people the brand keeps in play (written to + waiting) — what
// the limit holds it to, and what a cold brand opens with.
export function workCount(b: BigBrandFacts & { workPeople: number | null }): number {
  return workNeed({ tier: b.tier, workPeople: b.workPeople, big: isBigBrand(b) })
}

// The limit for one brand: of the people waiting in the queue (`active`),
// who stays in play and who is next in line (shelvedHow 'cap' — they come
// back by themselves when a spot opens). Everyone already written to counts
// first (`worked`). Nobody in today's list (`today`) is ever taken out —
// they stay even past the number, and count against it. The rest stay best
// first (comparePicks).
export function keepInPlay<T extends PickPerson & { today?: boolean }>(
  active: T[], work: number, worked: number, names?: string[],
): { keep: T[]; next: T[] } {
  const room = Math.max(0, work - worked)
  const today = active.filter(t => t.today)
  const rest = sortPicks(active.filter(t => !t.today), names)
  const take = Math.max(0, room - today.length)
  return { keep: [...today, ...rest.slice(0, take)], next: rest.slice(take) }
}

// The brand's names, for the title rules (a "CEO of <another company>" is
// judged against them).
export function brandNames(b: { name: string; aka?: string | null }): string[] {
  return [b.name, ...String(b.aka ?? '').split(/[,;]/).map(s => s.trim()).filter(Boolean)]
}
