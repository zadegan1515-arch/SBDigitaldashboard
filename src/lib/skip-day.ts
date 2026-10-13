// Moving or cancelling a whole future sending day (skip-day; Thanksgiving,
// Dec 24 and Dec 31 are all Thursdays in 2026). Before this only today
// could be closed ("Move what's left") and only an extra day removed;
// taking a Wednesday off ahead of time meant moving each brand by hand,
// and Best fit and Plan my week kept filling it anyway.
//
// A day taken off is kept in Setting outreachSkipDays as { day: SkipLog }.
// route.ts folds the days into the extra days it reads (readExtraDays →
// `skips`), so every day check skips them. These are the rules the
// handlers share: what the move does to the day's plan, and what Undo puts
// back. Pure — node scripts/test-skip-day.mjs.

export type DayPlan = { category: string | null; brandIds: string[] }
export type Plan = Record<string, DayPlan>

export type SkipLog = {
  at: string
  by: string | null
  // The day its plan went to; null = taken off, its brands back to waiting.
  to: string | null
  // It was an extra day Leo had opened (Undo opens it again).
  wasExtra: boolean
  // `to` was opened as a sending day by the move (Undo closes it again
  // when nothing else has been put there).
  opened: boolean
  // Its planned brands in order, and its category, before the move.
  pins: string[]
  category: string | null
  // The pins that landed on `to` (the rest came off: back to waiting).
  moved: string[]
  // The target's category when the move set it (a day with no plan takes
  // the whole plan), so Undo can put it back while nobody changed it.
  toCategory: { before: string | null; after: string | null } | null
}

const isKey = (k: unknown): k is string => typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k)
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : [])

// The stored days, today on (a day that has gone is spent). Anything
// malformed is dropped rather than trusted.
export function parseSkipDays(raw: unknown, today: string): Map<string, SkipLog> {
  const out = new Map<string, SkipLog>()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [day, v] of Object.entries(raw as Record<string, any>)) {
    if (!isKey(day) || day < today || !v || typeof v !== 'object') continue
    const tc = v.toCategory && typeof v.toCategory === 'object'
      ? { before: typeof v.toCategory.before === 'string' ? v.toCategory.before : null, after: typeof v.toCategory.after === 'string' ? v.toCategory.after : null }
      : null
    out.set(day, {
      at: String(v.at ?? ''), by: typeof v.by === 'string' ? v.by : null,
      to: isKey(v.to) ? v.to : null,
      wasExtra: v.wasExtra === true, opened: v.opened === true,
      pins: ids(v.pins), category: typeof v.category === 'string' ? v.category : null,
      moved: ids(v.moved), toCategory: tc,
    })
  }
  return out
}

// How the day's plan lands on the target. A day with nothing planned (no
// brands, no category) takes the whole plan: its category and its brands
// in Leo's order. A day with a plan keeps its own category and takes the
// brands at the end — the moved day's category stays behind (named), and
// brands outside the target's category are named too (a hand pin still
// goes; "Make the day match" is there if Leo wants it).
export function dayMoveShape(from: DayPlan | undefined, to: DayPlan | undefined): {
  whole: boolean; category: string | null; categoryLost: string | null
} {
  const empty = !to || (!to.brandIds.length && !to.category)
  const cat = from?.category ?? null
  if (empty) return { whole: true, category: cat, categoryLost: null }
  return { whole: false, category: to!.category ?? null, categoryLost: cat && cat !== (to!.category ?? null) ? cat : null }
}

// What Undo does (undoMoveDay): the day comes back with its category and
// the brands that can come back, in their old order —
//  - a brand the move put on `to` and still there comes back;
//  - a brand that came off at the move (refused there, or no target) and is
//    pinned nowhere now comes back;
//  - anything Leo moved since stays where he put it (named).
// The target's category goes back if the move set it and nobody changed it
// since; a target the move opened closes when nothing is left on it.
export function undoDayMove(plan: Plan, date: string, log: SkipLog): {
  plan: Plan; back: string[]; stay: Array<{ id: string; on: string | null }>; categoryBack: boolean; closeTo: boolean
} {
  const next: Plan = {}
  for (const [k, d] of Object.entries(plan)) next[k] = { category: d?.category ?? null, brandIds: [...(d?.brandIds ?? [])] }
  const on = new Map<string, string>()
  for (const k of Object.keys(next).sort()) for (const id of next[k].brandIds) if (!on.has(id)) on.set(id, k)
  const moved = new Set(log.moved)
  const back: string[] = []
  const stay: Array<{ id: string; on: string | null }> = []
  for (const id of log.pins) {
    const now = on.get(id) ?? null
    if (moved.has(id) ? now === log.to && !!log.to : !now) back.push(id)
    else stay.push({ id, on: now })
  }
  const to = log.to
  let categoryBack = false
  let closeTo = false
  if (to && next[to]) {
    const day = next[to]
    const going = new Set(back)
    day.brandIds = day.brandIds.filter(id => !going.has(id))
    if (log.toCategory && day.category === log.toCategory.after) {
      day.category = log.toCategory.before
      categoryBack = log.toCategory.before !== log.toCategory.after
    }
    if (!day.brandIds.length && !day.category) {
      delete next[to]
      closeTo = log.opened
    }
  } else if (to && log.opened) {
    closeTo = true
  }
  if (back.length || log.category) next[date] = { category: log.category, brandIds: back }
  return { plan: next, back, stay, categoryBack, closeTo }
}
