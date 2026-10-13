// Unsent work rolls forward (Outreach → Schedule). Leo, Sep 2026: "anything
// that i dont send out one day i want it to move to the next". Pure — the
// rollOverUnsent / moveUnsent code in src/app/api/data/route.ts reads the
// plan, the queue and the sends, and hands them here. Tested by
// scripts/test-carry.mjs.

// The day key n days after `key` (noon UTC is the same calendar date in
// New York, so the key never slides).
function shiftKey(key: string, n: number): string {
  return new Date(new Date(`${key}T12:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10)
}

function isKey(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
}

// The past days the morning roll looks at: every day after the last one
// it looked at, up to yesterday. The very first run (or one after a long
// gap) looks at the last week. Nothing when it already ran today.
export function rollWindow(today: string, done: { day?: unknown; through?: unknown }): string[] {
  if (done.day === today) return []
  const recent = isKey(done.through) && done.through >= shiftKey(today, -30) && done.through < today
  const first = recent ? shiftKey(done.through as string, 1) : shiftKey(today, -7)
  const days: string[] = []
  for (let k = first; k < today; k = shiftKey(k, 1)) days.push(k)
  return days
}

// Where a carried brand lands on its new day (carry-front; Leo's call, Oct
// 12 2026: carried brands go first). It used to go on the end, behind the
// day's own pins, so on a full day it waited again and rolled again — the
// oldest brands never went. 0 = half-sent: the rest of its first outreach
// has to finish on this day, or the queue rules rest it two weeks
// (queue-rules.ts sittingOf). 1 = planned on the day it missed, or queued
// there by hand. 3 = only shown there, or picked by the automatic fill — at
// the back, as before. (2 is the new day's own pins, in Leo's order.)
export type CarryTier = 0 | 1 | 3
// at = its place on the day it missed (the plan's order); brands that
// weren't planned there come after the planned ones, in the order seen.
export type Unsent = { from: string; stamped: string[]; tier: CarryTier; at: number }

// Brands with work left on `days`: people stamped into one of those days'
// queue who were never sent (whatever else happened at the brand), and
// brands pinned to the day — or shown on it by the rotation (`shown`, the
// Schedule's snapshot of that day's rows) — that sent nobody that day.
// `from` = the latest such day. auto = the brands the automatic fill
// queued each day (Setting outreachAutoQueued): people stamped at any
// other brand were queued by hand, a commitment like a pin.
export function findUnsent(input: {
  days: string[]
  stamped: Array<{ id: string; brandId: string; day: string }>
  sent: Array<{ brandId: string; day: string }>
  pins: Record<string, string[]>
  shown?: { day?: unknown; brandIds?: unknown } | null
  auto?: Record<string, string[]> | null
}): Map<string, Unsent> {
  const out = new Map<string, Unsent>()
  const wanted = new Set(input.days)
  const sentOn = new Set(input.sent.map(t => `${t.brandId}|${t.day}`))
  const half = new Set<string>()
  const byHand = new Set<string>()
  let seen = 0
  const note = (id: string, day: string): Unsent => {
    const e = out.get(id) ?? { from: day, stamped: [], tier: 3, at: 1e6 + seen++ }
    if (day > e.from) e.from = day
    out.set(id, e)
    return e
  }
  const autoOn = (id: string, day: string) => {
    const a = input.auto?.[day]
    return Array.isArray(a) && a.includes(id)
  }
  for (const t of input.stamped) {
    if (!wanted.has(t.day)) continue
    note(t.brandId, t.day).stamped.push(t.id)
    // Someone at the brand went that day and these didn't: half-sent.
    if (sentOn.has(`${t.brandId}|${t.day}`)) half.add(t.brandId)
    if (!autoOn(t.brandId, t.day)) byHand.add(t.brandId)
  }
  const shown = input.shown && isKey(input.shown.day) && Array.isArray(input.shown.brandIds)
    ? { day: input.shown.day, ids: input.shown.brandIds.map(String) } : null
  for (const d of input.days) {
    const ids = [...(input.pins[d] ?? []), ...(shown && shown.day === d ? shown.ids : [])]
    for (const id of ids) if (!sentOn.has(`${id}|${d}`)) note(id, d)
  }
  for (const [id, e] of out) {
    // Its place in the plan of the latest day it was pinned to.
    const pinDay = [...input.days].sort().reverse().find(d => (input.pins[d] ?? []).includes(id))
    if (pinDay) e.at = input.pins[pinDay].indexOf(id)
    e.tier = half.has(id) ? 0 : pinDay || byHand.has(id) ? 1 : 3
  }
  return out
}

// A day's new order with carried brands on it: half-sent first, then the
// ones planned (or queued by hand) on the day they missed, then the day's
// own pins in Leo's order, then the ones that were only shown or picked by
// the fill. A carried brand already pinned to the day keeps its place
// among the day's own pins — unless it is half-sent, which always goes
// first. Leo can still reorder the day afterwards.
// first = the day's own pins finishing their first sitting there (part-sent
// and pinned for the rest — Off queue / the Schedule's × put one first on
// its next sending day): the same deadline as a half-sent brand, so they go
// with tier 0, in the day's order, ahead of the brands planned on the day
// they missed. Behind those, one waited past the 30 and then rested two
// weeks with its rest never sent (review fix, Oct 13 2026).
export function carryOrder(dayIds: string[], carried: Array<{ id: string; tier?: CarryTier }>, first: string[] = []): string[] {
  const front0 = [
    ...carried.filter(c => c.tier === 0).map(c => c.id),
    ...dayIds.filter(id => first.includes(id)),
  ]
  const own = dayIds.filter(id => !front0.includes(id))
  const front1 = carried.filter(c => (c.tier ?? 1) === 1 && !own.includes(c.id)).map(c => c.id)
  const back = carried.filter(c => c.tier === 3 && !own.includes(c.id)).map(c => c.id)
  return [...new Set([...front0, ...front1, ...own, ...back])]
}

// How long a carried brand has been rolling: since = the first day it
// missed, times = how many mornings in a row it moved. prev = the last roll
// (Setting outreachCarry): a brand on it that missed the day it was moved
// to has rolled again.
export function carryTimes(
  prev: { to: string; brands: Array<{ id: string; from: string; since?: string; times?: number }> } | null,
  moved: Array<{ id: string; from: string }>,
): Map<string, { since: string; times: number }> {
  const out = new Map<string, { since: string; times: number }>()
  for (const m of moved) {
    const p = prev && prev.to === m.from ? prev.brands.find(b => b.id === m.id) : undefined
    out.set(m.id, p
      ? { since: isKey(p.since) ? p.since : p.from, times: (Number(p.times) || 1) + 1 }
      : { since: m.from, times: 1 })
  }
  return out
}

// What each unsent brand is, as far as moving it goes. refusal: why it
// can't go out at all (archived, do-not-email, in talks), in words, or
// null. passedOn: the day Pass today was pressed on it, if any. pinnedOn:
// a day from today on it is already planned for (not one being emptied).
// people: who would go out if it moved.
// passedUntil: the last day of a Pass's two weeks still running (Leo, Oct
// 7 2026: "it should not show up in the outreach tab again for at least
// two weeks"), else null — a brand the Schedule showed on another day
// never carries back in through it.
export type CarryFacts = {
  name: string; refusal: string | null; passedOn: string | null; pinnedOn: string | null; people: number
  // How to say pinnedOn ("Tue Sep 29"); the key itself when missing.
  pinnedLabel?: string
  passedUntil?: string | null
  passedUntilLabel?: string
}

// Which brands move to `to` and which stay, each staying one with why.
// dayIds = the brands already on `to`; the day holds `max` at most — the
// carried brands are judged in their order (tier, then the day they
// missed, then their place on it), so on a full day the ones only shown
// there are the ones left behind. The new day's order is carryOrder's.
// unstamp = queue stamps to take off: the moved brands' and those of a
// brand planned for another day (it goes out on that day instead).
export type Moved = { id: string; name: string; people: number; from: string; tier: CarryTier }
// first: the day's own pins finishing their sitting there (carryOrder).
export function planCarry(
  unsent: Map<string, Unsent>,
  facts: ReadonlyMap<string, CarryFacts>,
  to: string,
  dayIds: string[],
  max: number,
  first: string[] = [],
): {
  moved: Moved[]
  left: Array<{ id: string; name: string; why: string }>
  unstamp: string[]
  dayIds: string[]
} {
  const moved: Moved[] = []
  const left: Array<{ id: string; name: string; why: string }> = []
  const unstamp: string[] = []
  const day = dayIds.slice()
  const tierOf = (u: Unsent) => u.tier ?? 1
  const atOf = (u: Unsent) => (typeof u.at === 'number' ? u.at : 1e9)
  const ordered = [...unsent.entries()]
    .map(([id, u], i) => ({ id, u, i }))
    .sort((a, b) => tierOf(a.u) - tierOf(b.u) || (a.u.from < b.u.from ? -1 : a.u.from > b.u.from ? 1 : 0) ||
      atOf(a.u) - atOf(b.u) || a.i - b.i)
  for (const { id, u } of ordered) {
    const f = facts.get(id)
    if (!f) continue
    if (f.refusal) { left.push({ id, name: f.name, why: f.refusal }); continue }
    if (f.passedOn === u.from) { left.push({ id, name: f.name, why: 'Passed that day' }); continue }
    if (f.passedUntil && f.passedUntil >= to) {
      left.push({ id, name: f.name, why: `Passed until ${f.passedUntilLabel ?? f.passedUntil}` })
      continue
    }
    // A later pin waits for its own day — but not a half-sent brand's: its
    // rest has to go on `to`, and on that later day it would only read
    // "rests two weeks" (review fix, Oct 13 2026). It moves (the caller
    // takes it off the later day).
    if (f.pinnedOn && f.pinnedOn !== to && tierOf(u) !== 0) {
      left.push({ id, name: f.name, why: `Planned for ${f.pinnedLabel ?? f.pinnedOn} already` })
      unstamp.push(...u.stamped)
      continue
    }
    const people = u.stamped.length || f.people
    if (!people) { left.push({ id, name: f.name, why: 'Nobody left to invite' }); continue }
    if (!day.includes(id)) {
      if (day.length >= max) { left.push({ id, name: f.name, why: 'That day is full' }); continue }
      day.push(id)
    }
    unstamp.push(...u.stamped)
    moved.push({ id, name: f.name, people, from: u.from, tier: tierOf(u) })
  }
  return { moved, left, unstamp, dayIds: carryOrder(dayIds, moved, first) }
}
