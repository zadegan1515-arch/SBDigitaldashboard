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

export type Unsent = { from: string; stamped: string[] }

// Brands with work left on `days`: people stamped into one of those days'
// queue who were never sent (whatever else happened at the brand), and
// brands pinned to the day — or shown on it by the rotation (`shown`, the
// Schedule's snapshot of that day's rows) — that sent nobody that day.
// `from` = the latest such day.
export function findUnsent(input: {
  days: string[]
  stamped: Array<{ id: string; brandId: string; day: string }>
  sent: Array<{ brandId: string; day: string }>
  pins: Record<string, string[]>
  shown?: { day?: unknown; brandIds?: unknown } | null
}): Map<string, Unsent> {
  const out = new Map<string, Unsent>()
  const wanted = new Set(input.days)
  const sentOn = new Set(input.sent.map(t => `${t.brandId}|${t.day}`))
  const note = (id: string, day: string): Unsent => {
    const e = out.get(id) ?? { from: day, stamped: [] }
    if (day > e.from) e.from = day
    out.set(id, e)
    return e
  }
  for (const t of input.stamped) if (wanted.has(t.day)) note(t.brandId, t.day).stamped.push(t.id)
  const shown = input.shown && isKey(input.shown.day) && Array.isArray(input.shown.brandIds)
    ? { day: input.shown.day, ids: input.shown.brandIds.map(String) } : null
  for (const d of input.days) {
    const ids = [...(input.pins[d] ?? []), ...(shown && shown.day === d ? shown.ids : [])]
    for (const id of ids) if (!sentOn.has(`${id}|${d}`)) note(id, d)
  }
  return out
}

// What each unsent brand is, as far as moving it goes. refusal: why it
// can't go out at all (archived, do-not-email, in talks), in words, or
// null. passedOn: the day Pass today was pressed on it, if any. pinnedOn:
// a day from today on it is already planned for (not one being emptied).
// people: who would go out if it moved.
export type CarryFacts = {
  name: string; refusal: string | null; passedOn: string | null; pinnedOn: string | null; people: number
  // How to say pinnedOn ("Tue Sep 29"); the key itself when missing.
  pinnedLabel?: string
}

// Which brands move to `to` and which stay, each staying one with why.
// dayIds = the brands already on `to`; the day holds `max` at most.
// unstamp = queue stamps to take off: the moved brands' and those of a
// brand planned for another day (it goes out on that day instead).
export function planCarry(
  unsent: Map<string, Unsent>,
  facts: ReadonlyMap<string, CarryFacts>,
  to: string,
  dayIds: string[],
  max: number,
): {
  moved: Array<{ id: string; name: string; people: number; from: string }>
  left: Array<{ id: string; name: string; why: string }>
  unstamp: string[]
  dayIds: string[]
} {
  const moved: Array<{ id: string; name: string; people: number; from: string }> = []
  const left: Array<{ id: string; name: string; why: string }> = []
  const unstamp: string[] = []
  const day = dayIds.slice()
  for (const [id, u] of unsent) {
    const f = facts.get(id)
    if (!f) continue
    if (f.refusal) { left.push({ id, name: f.name, why: f.refusal }); continue }
    if (f.passedOn === u.from) { left.push({ id, name: f.name, why: 'Passed that day' }); continue }
    if (f.pinnedOn && f.pinnedOn !== to) {
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
    moved.push({ id, name: f.name, people, from: u.from })
  }
  return { moved, left, unstamp, dayIds: day }
}
