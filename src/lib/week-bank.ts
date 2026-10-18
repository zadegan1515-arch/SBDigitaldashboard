// Outreach → Week plan (Leo, Oct 18 2026: "a page that fills up to around
// 100 brands and i can add more or have less where it puts in the top 100
// ranked brands then also a search bar to add brands … add brands to this
// list by filtering through categories … the goal of this is to have the
// brands i want to reach out to in a week set up before and make sure that
// higher ranked brands are getting put into the schedule. then from there i
// want it to randomly put them into the days for the week which i should be
// able to move between days"). His picks, the same day: the list is a bank
// spent week by week; brands are dealt onto the days as an even mix of rank;
// a day spread from the list takes only brands from the list.
//
// Pure: the handlers in src/app/api/data/route.ts read the roster, work out
// each brand's Brand Fit and who would go out, and hand them here. Tested by
// scripts/test-week-bank.mjs.

import { weekCap, BIG_PER_BEST_FIT_DAY } from './plan-week'

export const BANK_KEY = 'weekBank'
export const BANK_SIZE_DEFAULT = 100
export const BANK_SIZE_MIN = 10
export const BANK_SIZE_MAX = 300
// Taken off by hand: remembered so the list doesn't put it back by itself.
const REMOVED_MAX = 500
const HAND_MAX = 300

// What is stored (Setting weekBank). hand = brands Leo put on the list
// (search, a category), oldest first, with when; removed = brands he took
// off, with when. The rest of the list is worked out on every read: the
// best Brand Fit brands the system would pick by itself, up to `size`.
export type BankState = {
  size: number
  hand: Array<{ id: string; at: string }>
  removed: Record<string, string>
}

export function bankSize(n: unknown): number {
  const v = Math.round(Number(n))
  if (!Number.isFinite(v) || v <= 0) return BANK_SIZE_DEFAULT
  return Math.max(BANK_SIZE_MIN, Math.min(BANK_SIZE_MAX, v))
}

export function cleanBank(v: unknown): BankState {
  const o: any = v && typeof v === 'object' ? v : {}
  const seen = new Set<string>()
  const hand: BankState['hand'] = []
  for (const h of Array.isArray(o.hand) ? o.hand : []) {
    const id = typeof h?.id === 'string' ? h.id : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    hand.push({ id, at: typeof h.at === 'string' ? h.at : new Date(0).toISOString() })
  }
  const removed: Record<string, string> = {}
  if (o.removed && typeof o.removed === 'object') {
    for (const [id, at] of Object.entries(o.removed)) if (id && !seen.has(id)) removed[id] = typeof at === 'string' ? at : new Date(0).toISOString()
  }
  return { size: o.size == null ? BANK_SIZE_DEFAULT : bankSize(o.size), hand: hand.slice(-HAND_MAX), removed: trimRemoved(removed) }
}

function trimRemoved(removed: Record<string, string>): Record<string, string> {
  const list = Object.entries(removed)
  if (list.length <= REMOVED_MAX) return removed
  return Object.fromEntries(list.sort((a, b) => a[1].localeCompare(b[1])).slice(-REMOVED_MAX))
}

// Adds by hand: on the list from now on (a removed one comes back).
export function addToBank(state: BankState, ids: string[], at: string): { state: BankState; added: string[] } {
  const have = new Set(state.hand.map(h => h.id))
  const added: string[] = []
  const removed = { ...state.removed }
  const hand = state.hand.slice()
  for (const id of ids) {
    if (!id || have.has(id)) continue
    have.add(id)
    hand.push({ id, at })
    delete removed[id]
    added.push(id)
  }
  return { state: { ...state, hand: hand.slice(-HAND_MAX), removed }, added }
}

// Taken off by hand: off the list, and the list never adds it back by
// itself (Put back, or adding it again, does).
export function removeFromBank(state: BankState, ids: string[], at: string): BankState {
  const drop = new Set(ids.filter(Boolean))
  const removed = { ...state.removed }
  for (const id of drop) removed[id] = at
  return { ...state, hand: state.hand.filter(h => !drop.has(h.id)), removed: trimRemoved(removed) }
}

export function putBack(state: BankState, ids: string[]): BankState {
  const removed = { ...state.removed }
  for (const id of ids) delete removed[id]
  return { ...state, removed }
}

// A brand Leo added by hand is spent once something went out to it after
// he added it (an invite or an email): it leaves the list like any brand
// reached. One added while it was resting stays until it goes again.
export function handSpent(addedAt: string, lastOutreachAt: string | null): boolean {
  return !!lastOutreachAt && lastOutreachAt > addedAt
}

// One brand the list may hold. auto = the system's own picks would take
// it (Best fit's rules, and someone would go out); fit = its Brand Fit.
export type BankCand = { id: string; name: string; fit: number; ready: boolean; auto: boolean }

// Best Brand Fit first (Leo: "make sure that higher ranked brands are
// getting put into the schedule"); on a tie a brand with as many people
// reachable as it works goes first, then the name.
export function compareBank(x: { fit: number; ready: boolean; name: string }, y: { fit: number; ready: boolean; name: string }): number {
  return y.fit - x.fit || Number(y.ready) - Number(x.ready) || x.name.localeCompare(y.name)
}

// The list: every brand Leo added by hand that is still a candidate, then
// the best of the system's own picks — never one he took off — up to
// `size` brands in all (hand ones count toward it; more hand ones than
// `size` and the list is just those). Best Brand Fit first.
export function composeBank(cands: BankCand[], state: BankState): {
  list: Array<BankCand & { how: 'hand' | 'auto' }>
  // System picks left out past `size` (the next ones in, if the number goes up).
  autoLeft: number
} {
  const handIds = new Set(state.hand.map(h => h.id))
  const hand = cands.filter(c => handIds.has(c.id))
  const room = Math.max(0, state.size - hand.length)
  const auto = cands
    .filter(c => c.auto && !handIds.has(c.id) && !(c.id in state.removed))
    .sort(compareBank)
  const list = [
    ...hand.map(c => ({ ...c, how: 'hand' as const })),
    ...auto.slice(0, room).map(c => ({ ...c, how: 'auto' as const })),
  ].sort(compareBank)
  return { list, autoLeft: Math.max(0, auto.length - room) }
}

// ── The week ──────────────────────────────────────────────────────────
// Day keys are New York dates (YYYY-MM-DD); noon UTC is the same calendar
// date there, so a key never slides.
function shiftKey(key: string, n: number): string {
  return new Date(new Date(`${key}T12:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10)
}
function dowOf(key: string): number {
  return new Date(`${key}T12:00:00Z`).getUTCDay()
}
// The Monday of the Monday-to-Sunday week that holds `key`.
export function weekStart(key: string): string {
  const dow = dowOf(key)
  return shiftKey(key, dow === 0 ? -6 : 1 - dow)
}
export function weekDayKeys(start: string): string[] {
  return Array.from({ length: 7 }, (_, i) => shiftKey(start, i))
}
// The weeks the page offers: this week while it has a sending day after
// today, and the week after. isSending = the Schedule's own rule (Tue–Thu,
// days opened, minus days taken off).
export function planWeeks(today: string, isSending: (key: string) => boolean): Array<{ start: string; which: 'this' | 'next'; days: string[] }> {
  const thisStart = weekStart(today)
  const nextStart = shiftKey(thisStart, 7)
  const daysOf = (start: string) => weekDayKeys(start).filter(k => k > today && isSending(k))
  const out: Array<{ start: string; which: 'this' | 'next'; days: string[] }> = []
  const mine = daysOf(thisStart)
  if (mine.length) out.push({ start: thisStart, which: 'this', days: mine })
  out.push({ start: nextStart, which: 'next', days: daysOf(nextStart) })
  return out
}

// How many people each day can take from the list: the day's limit, or
// what LinkedIn's week leaves (weekCap — the system's own picks are held to
// it, and the spread is the system's picking), less what is already going
// that day. Days in date order; each is counted full for the days after it.
// counts = invites per day outside these days (what went out, today and
// the Schedule's other days).
export function weekRooms(days: Array<{ date: string; kept: number }>, counts: ReadonlyMap<string, number>, daily: number): Array<{ date: string; cap: number; room: number }> {
  const c = new Map(counts)
  return [...days].sort((a, b) => a.date.localeCompare(b.date)).map(d => {
    const cap = weekCap(d.date, c, daily)
    c.set(d.date, Math.max(cap, d.kept))
    return { date: d.date, cap, room: Math.max(0, cap - d.kept) }
  })
}

// ── Dealing the list onto the days ───────────────────────────────────
// A small seeded random (mulberry32): the page sends a seed, so Shuffle
// again deals differently and Apply writes what the preview showed.
export function seeded(seed: number): () => number {
  let a = (Math.floor(Math.abs(Number(seed) || 0)) % 4294967296) >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type SpreadDay = { date: string; room: number; bigs: number }
export type SpreadBrand = { id: string; size: number; big: boolean }
export type SpreadLeft = { id: string; why: 'nofit' | 'big' | 'nobody' }

// An even mix of rank (Leo's pick): the list in its order, each brand whole
// onto the day — among the days it fits on — that has been dealt the
// fewest brands so far, ties broken at random. So #1, #2, #3 land on three
// different days in a random order, #4–#6 the same, and so on; a day that
// fills up drops out and the others go on. A brand too big for every day's
// room left is passed over (a smaller one after it can still go) and waits
// on the list for next week. A day takes one big company at most (bigFits,
// the Best fit day's rule; `bigs` = the ones it holds already).
export function spreadWeek(days: SpreadDay[], brands: SpreadBrand[], rand: () => number): {
  put: Record<string, string[]>
  left: SpreadLeft[]
} {
  const state = days.map(d => ({ date: d.date, room: Math.max(0, d.room), bigs: d.bigs, dealt: 0 }))
  const put: Record<string, string[]> = Object.fromEntries(days.map(d => [d.date, [] as string[]]))
  const left: SpreadLeft[] = []
  for (const b of brands) {
    if (!(b.size > 0)) { left.push({ id: b.id, why: 'nobody' }); continue }
    const roomy = state.filter(d => d.room >= b.size)
    const fits = roomy.filter(d => !b.big || d.bigs < BIG_PER_BEST_FIT_DAY)
    if (!fits.length) { left.push({ id: b.id, why: roomy.length ? 'big' : 'nofit' }); continue }
    const least = Math.min(...fits.map(d => d.dealt))
    const pool = fits.filter(d => d.dealt === least)
    const day = pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))]
    put[day.date].push(b.id)
    day.room -= b.size
    day.dealt += 1
    if (b.big) day.bigs += 1
  }
  return { put, left }
}
