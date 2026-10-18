// Plan my week (Outreach → Schedule) and the numbers around it: LinkedIn's
// weekly limit and how often each category accepts. Pure — the planWeek
// handler in src/app/api/data/route.ts loads the brands, works out who each
// one would put in play on a later day (previewBrandPicks), and hands them
// here best first. Tested by scripts/test-plan-week.mjs.

// LinkedIn stops a personal account at roughly a hundred connection invites
// a week, counted over the last seven days rather than Monday to Sunday.
// The Schedule warns before a day would take those seven days past it (and
// a little before, past 90 — a normal Tue–Thu at 30 a day is 90 and warns
// about nothing). Hand adds are never blocked: the limit is LinkedIn's,
// not ours, and it moves. The system's own picks keep under it (weekCap).
export const LINKEDIN_WEEK_LIMIT = 100
export const LINKEDIN_WEEK_NEAR = 90
export type LinkedInWindow = { count: number; over: number; near: boolean }

// The day key n days after `key` (noon UTC is the same calendar date in
// New York, so the key never slides).
function shiftKey(key: string, n: number): string {
  return new Date(new Date(`${key}T12:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10)
}

// How many invites the system's own picks may put on `key` (Leo, Oct 12
// 2026: an extra sending day is sized to what LinkedIn's weekly limit
// leaves — an extra Friday after a full Tue–Thu takes about 10, not 30):
// the day's own limit, or what the six days before it leave of the week's
// hundred, whichever is less. counts = invites per day key — what went out
// before today, what the Schedule sends from today on — filled in by the
// caller in date order, so every seven-day window stays at the limit. Hand
// pins, adds and "Send today anyway" stay on the flat day limit (the
// Schedule warns when they pass the week).
export function weekCap(key: string, counts: ReadonlyMap<string, number>, daily: number, limit = LINKEDIN_WEEK_LIMIT): number {
  let before = 0
  for (let i = 1; i <= 6; i++) before += counts.get(shiftKey(key, -i)) ?? 0
  return Math.max(0, Math.min(daily, limit - before))
}

// ── Filling a day by brand ────────────────────────────────────────────
// The one rule the Schedule's preview (getOutreachPlan), the real queue
// (getTodayQueue) and Plan my week (planWeekDays below) fill a day by, so
// the number the Schedule shows is the number that goes out.
//
// Automatic picks, best first (compareAuto): a brand with as many people
// we can reach as it works at once (Ready) before one short of them
// (Oct 12 2026: short brands are ranked below the ready ones, not held
// back — the LinkedIn fill can still find them people before their turn),
// then the higher Brand Fit.
export function compareAuto(x: { fit: number; short?: boolean }, y: { fit: number; short?: boolean }): number {
  return Number(!!x.short) - Number(!!y.short) || y.fit - x.fit
}

// At most one big company on a Best fit day (Leo, Oct 12 2026: "a Best fit
// day takes at most one big company (10 invites); the rest of the day goes
// to smaller brands"). `onDay` = big companies the day holds already (its
// pins, today's list, what went out today). A second big one waits like a
// brand that doesn't fit: skipped, not counted, still offered for later.
// Category days and brands Leo puts on a day by hand are not held to it.
export const BIG_PER_BEST_FIT_DAY = 1
export function bigFits(big: boolean | undefined, onDay: number, bestFit: boolean): boolean {
  return !big || !bestFit || onDay < BIG_PER_BEST_FIT_DAY
}

// A brand a day may take: `size` = how many people it would put in play;
// held = already part-worked today (goes first, its rest joins the list);
// short = fewer reachable people than it works; big = a big company.
export type FillGroup = { id: string; size: number; fit: number; held: boolean; short?: boolean; big?: boolean }
export function orderFillGroups<T extends FillGroup>(groups: T[]): T[] {
  // Stable: equal groups keep the order they came in.
  return groups
    .map((g, i) => ({ g, i }))
    .sort((a, b) => Number(b.g.held) - Number(a.g.held) || compareAuto(a.g, b.g) || a.i - b.i)
    .map(x => x.g)
}
// Whole brands while they fit in `room`. A brand that doesn't fit is
// skipped rather than ending the fill, so a four-person brand with three
// spots left doesn't leave the day three short. allowPartial: only a day
// that starts empty may split a brand (see getTodayQueue) — a day with a
// few spots left leaves them open; only then, and only when nothing fits
// whole, does the best brand go in partly. bigLimit: a Best fit day's one
// big company (bigFits). A held group (already in today's list) is that
// day's own: `onDay` counts it already, so it is never refused as "a
// second big company" — getTodayQueue tops it up all the same, and the
// Schedule's preview must say so (review fix, Oct 13 2026).
export function fillWholeBrands<T extends FillGroup>(groups: T[], room: number, allowPartial = true,
  bigLimit?: { bestFit: boolean; onDay: number }): {
  whole: T[]; partial: { group: T; take: number } | null; skipped: T[]
} {
  const whole: T[] = []
  const skipped: T[] = []
  let used = 0
  let bigs = bigLimit?.onDay ?? 0
  const bestFit = !!bigLimit?.bestFit
  const bigOk = (g: T) => g.held || bigFits(g.big, bigs, bestFit)
  for (const g of groups) {
    if (g.size <= 0 || used >= room || used + g.size > room || !bigOk(g)) { skipped.push(g); continue }
    whole.push(g)
    used += g.size
    if (g.big && !g.held) bigs += 1
  }
  if (!whole.length && room > 0 && allowPartial) {
    const first = groups.find(g => g.size > 0 && bigOk(g))
    if (first) {
      return { whole, partial: { group: first, take: Math.min(room, first.size) }, skipped: skipped.filter(g => g !== first) }
    }
  }
  return { whole, partial: null, skipped }
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
// fit = its Brand Fit score: a Best fit day takes the highest first.
// skip: its category is set to Skip — only a day Leo gave that category
// takes it. notBest: Best fit would never pick it (Schedule's rule).
// big: a big company — a Best fit day takes one (bigFits).
export type WeekCand = { id: string; category: string | null; ready: boolean; size: number; fit?: number; skip?: boolean; notBest?: boolean; big?: boolean }
// A planned day as it stands: the brands already pinned to it (and how many
// people each sends) and the category Leo set, if any. waits: a pin past
// the day's 30 in the day's order — it goes on the next sending day, so
// the day doesn't count it (the Schedule's own rule, route.ts waitingOnDay).
// list: the day takes only brands from Leo's week list (Outreach → Week
// plan, src/lib/week-bank.ts) — Plan my week keeps its pins and adds nothing.
export type WeekDayIn = { date: string; kept: Array<{ id: string; going: number; waits?: boolean; big?: boolean }>; category: string | null; list?: boolean }
export type WeekSource = 'yours' | 'asked' | 'picked' | 'bestfit' | 'full' | 'none' | 'list'
export type WeekDayOut = {
  date: string
  category: string | null
  source: WeekSource
  // Ready brands the day's category still had when the day was planned.
  readyNow: number
  // The plan gave it the day before's category: nothing else had anyone
  // left to send.
  repeat: boolean
  keptPeople: number
  add: Array<{ id: string; from: 'day' | 'related' | 'other'; size: number }>
  addPeople: number
  total: number
  // What the plan could fill the day to: the day's limit, or less when
  // LinkedIn's weekly limit leaves less (weekCap).
  cap: number
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
  // A day without a category: 'bestfit' (the default since Oct 7 2026)
  // keeps it Best fit; 'pick' gives it a category, the rules above.
  openDays?: 'bestfit' | 'pick'
  // Invites per day key outside the plan (what went out, today's number):
  // with it, each day fills only to what LinkedIn's week leaves (weekCap),
  // the plan's own days counted as it goes. Without it, every day gets cap.
  counts?: ReadonlyMap<string, number>
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
  // Categories Leo set to Skip: never picked for a day, never a top-up.
  const skipCat = new Set(opts.cands.filter(c => c.skip).map(c => c.category ?? ''))
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
  const counts = opts.counts ? new Map(opts.counts) : null

  return opts.days.map(day => {
    // A pin that waits goes on the next sending day: not this day's.
    const keptPeople = day.kept.reduce((n, k) => n + (k.waits ? 0 : k.going), 0)
    const dayCap = counts ? weekCap(day.date, counts, cap) : cap
    const room = day.list ? 0 : Math.max(0, dayCap - keptPeople)
    let category = day.category
    let source: WeekSource = day.list ? 'list' : category ? 'yours' : room === 0 ? 'full' : 'none'
    const before = prev
    const f = forced[day.date]
    if (day.list) {
      // Leo's week list decides this day (nothing picked, nothing added).
    } else if (f && f !== '__pick') {
      category = f
      source = 'asked'
    } else if (!category && !f && room > 0 && opts.openDays !== 'pick') {
      // No category (Leo, Oct 7 2026): the day is Best fit — every
      // category, the highest Brand Fit first.
      source = 'bestfit'
    } else if ((f === '__pick' || !category) && room > 0) {
      const options = [...byCat.keys()]
        .filter(k => k && k !== 'unresolved' && !skipCat.has(k))
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
    // A Best fit day's one big company (bigFits): the day's own pins count.
    let bigs = day.kept.filter(k => k.big && !k.waits && k.going > 0).length
    const bestFitDay = source === 'bestfit'
    const take = (list: WeekCand[], from: 'day' | 'related' | 'other') => {
      for (const c of list) {
        if (left <= 0) return
        if (used.has(c.id) || c.size > left || !bigFits(c.big, bigs, bestFitDay)) continue
        add.push({ id: c.id, from, size: c.size })
        used.add(c.id)
        left -= c.size
        if (c.big) bigs += 1
      }
    }
    if (room > 0 && source === 'bestfit') {
      // Ready before short, then the highest Brand Fit (compareAuto).
      const all = [...byCat.values()].flat().filter(c => !used.has(c.id) && !c.skip && !c.notBest && (c.fit ?? 0) >= 0)
        .sort((x, y) => compareAuto({ fit: x.fit ?? 0, short: !x.ready }, { fit: y.fit ?? 0, short: !y.ready }))
      take(all, 'day')
    } else if (room > 0) {
      if (category) take(avail(category), 'day')
      const rel = category ? related[category] ?? [] : []
      for (const k of rel) if (!skipCat.has(k)) take(avail(k), 'related')
      const rest = [...byCat.keys()]
        .filter(k => k !== category && !rel.includes(k) && !skipCat.has(k))
        .sort((x, y) =>
          Number(!x || x === 'unresolved') - Number(!y || y === 'unresolved') ||
          rateOf(y || null) - rateOf(x || null) ||
          x.localeCompare(y))
      for (const k of rest) take(avail(k), 'other')
    }
    if (category) chosen.push(category)
    prev = category ?? prev
    const addPeople = add.reduce((n, a) => n + a.size, 0)
    const repeat = source === 'picked' && category !== null && category === before
    if (counts) counts.set(day.date, keptPeople + addPeople)
    return { date: day.date, category, source, readyNow, repeat, keptPeople, add, addPeople, total: keptPeople + addPeople, cap: dayCap }
  })
}
