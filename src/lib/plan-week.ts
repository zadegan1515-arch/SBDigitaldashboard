// Plan my week (Outreach → Schedule) and the numbers around it: LinkedIn's
// weekly limit and how often each category accepts. Pure — the planWeek
// handler in src/app/api/data/route.ts loads the brands, works out who each
// one would put in play on a later day (previewBrandPicks), and hands them
// here best first. Tested by scripts/test-plan-week.mjs.

// LinkedIn stops a personal account at roughly a hundred connection invites
// a week, counted over the last seven days rather than Monday to Sunday.
// The Schedule warns before a day would take those seven days past it (and
// a little before, from 80). Nothing is blocked: the limit is LinkedIn's,
// not ours, and it moves.
export const LINKEDIN_WEEK_LIMIT = 100
export const LINKEDIN_WEEK_NEAR = 80
export type LinkedInWindow = { count: number; over: number; near: boolean }

// The day key n days after `key` (noon UTC is the same calendar date in
// New York, so the key never slides).
function shiftKey(key: string, n: number): string {
  return new Date(new Date(`${key}T12:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10)
}

// For each day key: the invites in the seven days ending that day. Days
// before today count what actually went out (`sent`); today and later count
// what the schedule sends (`planned` — today's number already includes what
// went out this morning). A day with nothing planned counts what was logged
// on it, which for a later day is nothing.
export function linkedinWindows(
  keys: string[], planned: ReadonlyMap<string, number>, sent: ReadonlyMap<string, number>, today: string,
): Record<string, LinkedInWindow> {
  const out: Record<string, LinkedInWindow> = {}
  for (const key of keys) {
    let count = 0
    for (let i = 6; i >= 0; i--) {
      const k = shiftKey(key, -i)
      count += k < today ? (sent.get(k) ?? 0) : (planned.get(k) ?? sent.get(k) ?? 0)
    }
    out[key] = { count, over: Math.max(0, count - LINKEDIN_WEEK_LIMIT), near: count > LINKEDIN_WEEK_NEAR }
  }
  return out
}

// How often each category accepts, for ranking. A category with a handful
// of invites is pulled toward the overall rate (five invites' worth of it),
// so one lucky accept doesn't put it top, and a category never tried sits
// at the average instead of at zero.
export type AcceptRates = {
  overall: number
  of: (category: string | null) => number
  raw: Map<string, { invites: number; accepted: number }>
}
export function acceptRates(invites: Array<{ category: string | null; accepted: boolean }>): AcceptRates {
  const raw = new Map<string, { invites: number; accepted: number }>()
  let all = 0
  let yes = 0
  for (const t of invites) {
    const k = t.category ?? ''
    const r = raw.get(k) ?? { invites: 0, accepted: 0 }
    r.invites += 1
    if (t.accepted) r.accepted += 1
    raw.set(k, r)
    all += 1
    if (t.accepted) yes += 1
  }
  const overall = all ? yes / all : 0
  const PRIOR = 5
  return {
    overall, raw,
    of: category => {
      const r = raw.get(category ?? '')
      return r ? (r.accepted + PRIOR * overall) / (r.invites + PRIOR) : overall
    },
  }
}

// One brand the plan may put on a day: its category, whether it is Ready
// (enough reachable people), and how many people it would put in play.
export type WeekCand = { id: string; category: string | null; ready: boolean; size: number }
// A planned day as it stands: the brands already pinned to it (and how many
// people each sends) and the category Leo set, if any.
export type WeekDayIn = { date: string; kept: Array<{ id: string; going: number }>; category: string | null }
export type WeekSource = 'yours' | 'asked' | 'picked' | 'full' | 'none'
export type WeekDayOut = {
  date: string
  category: string | null
  source: WeekSource
  // Ready brands the day's category still had when the day was planned.
  readyNow: number
  keptPeople: number
  add: Array<{ id: string; from: 'day' | 'related' | 'other'; size: number }>
  addPeople: number
  total: number
}

// The days in order. For each: keep what is pinned and Leo's category; a day
// without one gets the category whose brands can fill it — never the one the
// day before worked, one not used earlier in the plan, filling the whole day
// before half of it, least recently worked first, then the ones that accept
// more, then the most ready brands. Then fill to `cap` with whole brands: the
// day's category first, the related categories next, then the rest (the
// ones that accept more first, brands with no category last). A brand that
// doesn't fit whole is skipped, never split. `forced[date]` is a category
// Leo picked in the preview, or '__pick' to let the plan pick over his own.
// 'unresolved' and no category are never a day's category.
export function planWeekDays(opts: {
  days: WeekDayIn[]
  cands: WeekCand[]
  cap: number
  forced?: Record<string, string>
  prev: string | null
  lastSent: ReadonlyMap<string, number>
  rateOf: (category: string | null) => number
  related: Partial<Record<string, string[]>>
}): WeekDayOut[] {
  const { cap, lastSent, rateOf, related } = opts
  const forced = opts.forced ?? {}
  const byCat = new Map<string, WeekCand[]>()
  for (const c of opts.cands) {
    if (c.size <= 0) continue
    const k = c.category ?? ''
    const list = byCat.get(k) ?? []
    list.push(c)
    byCat.set(k, list)
  }
  const used = new Set<string>()
  const avail = (k: string) => (byCat.get(k) ?? []).filter(c => !used.has(c.id))
  // People a category could put on a day, whole brands only.
  const fillable = (k: string, spots: number) => {
    let left = spots
    for (const c of avail(k)) if (c.size <= left) left -= c.size
    return spots - left
  }
  // Rates in five-point steps, so a hair's difference doesn't outrank the
  // rules before it.
  const rateStep = (k: string | null) => Math.round(rateOf(k) * 20)
  const chosen: string[] = []
  let prev = opts.prev

  return opts.days.map(day => {
    const keptPeople = day.kept.reduce((n, k) => n + k.going, 0)
    const room = Math.max(0, cap - keptPeople)
    let category = day.category
    let source: WeekSource = category ? 'yours' : room === 0 ? 'full' : 'none'
    const f = forced[day.date]
    if (f && f !== '__pick') {
      category = f
      source = 'asked'
    } else if ((f === '__pick' || !category) && room > 0) {
      const options = [...byCat.keys()]
        .filter(k => k && k !== 'unresolved')
        .map(k => ({
          k,
          can: fillable(k, room),
          ready: avail(k).filter(c => c.ready).length,
          last: lastSent.get(k) ?? 0,
          rate: rateStep(k),
        }))
        .filter(o => o.can > 0)
      // Fills the whole day, fills half of it, or less.
      const reach = (o: { can: number }) => (o.can >= room ? 0 : o.can * 2 >= room ? 1 : 2)
      options.sort((x, y) =>
        Number(x.k === prev) - Number(y.k === prev) ||
        Number(chosen.includes(x.k)) - Number(chosen.includes(y.k)) ||
        reach(x) - reach(y) ||
        x.last - y.last ||
        y.rate - x.rate ||
        y.ready - x.ready ||
        x.k.localeCompare(y.k))
      if (options.length) {
        category = options[0].k
        source = 'picked'
      }
    }

    const readyNow = category ? avail(category).filter(c => c.ready).length : 0
    const add: WeekDayOut['add'] = []
    let left = room
    const take = (list: WeekCand[], from: 'day' | 'related' | 'other') => {
      for (const c of list) {
        if (left <= 0) return
        if (used.has(c.id) || c.size > left) continue
        add.push({ id: c.id, from, size: c.size })
        used.add(c.id)
        left -= c.size
      }
    }
    if (room > 0) {
      if (category) take(avail(category), 'day')
      const rel = category ? related[category] ?? [] : []
      for (const k of rel) take(avail(k), 'related')
      const rest = [...byCat.keys()]
        .filter(k => k !== category && !rel.includes(k))
        .sort((x, y) =>
          Number(!x || x === 'unresolved') - Number(!y || y === 'unresolved') ||
          rateOf(y || null) - rateOf(x || null) ||
          x.localeCompare(y))
      for (const k of rest) take(avail(k), 'other')
    }
    if (category) chosen.push(category)
    prev = category ?? prev
    const addPeople = add.reduce((n, a) => n + a.size, 0)
    return { date: day.date, category, source, readyNow, keptPeople, add, addPeople, total: keptPeople + addPeople }
  })
}
