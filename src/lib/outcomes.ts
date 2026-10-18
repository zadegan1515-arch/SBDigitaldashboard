// Which invites actually get answered (outcome-table, Oct 12 2026: a
// small read-only table so Leo can set priorities from results rather
// than guesses — "only suggest changes for me to approve", never move a
// score by itself). Rules only, no model call; nothing here writes.
//
// LinkedIn invites only, and only ones old enough to have an answer:
// ACCEPT_AFTER_DAYS for accepts, REPLY_AFTER_DAYS for replies — Zach's
// list texts them 2 days after the accept, sends the final reach-out 10
// days later and calls it "No response" 7 days after that (HAND_DM_DAYS
// + HAND_NUDGE_DAYS + HAND_QUIET_DAYS in route.ts). Accepts and replies
// (a reply or a call booked) are counted apart. Grouped by category,
// company size (brand-size.ts), buyer type (buyers.ts) and, per brand,
// how many people were invited there. Rates are pulled toward the overall
// rate by PRIOR invites' worth of it (like plan-week.ts acceptRates), every
// cell carries its n, and under FEW it says "too few to tell".
// Suggestions only ever name a category's priority (the one knob Leo
// set): Leo confirms each one, setCategoryPriority does the rest.
// node scripts/test-outcomes.mjs

import type { BrandSize } from './brand-size'
import type { BuyerKind } from './buyers'
import { PRIORITIES, PRIORITY_WORD, type Priority } from './brand-fit'

export const ACCEPT_AFTER_DAYS = 7
export const REPLY_AFTER_DAYS = 19
export const PRIOR = 5
export const FEW = 30
// A category this far above / below the average is worth a question.
export const SUGGEST_UP = 1.5
export const SUGGEST_DOWN = 0.5

export type OutcomeInvite = {
  brandId: string
  at: Date | string // the invite's sentAt
  category: string | null
  size: BrandSize
  buyer: BuyerKind | null // the person's title (buyerKind); null = not a buyer title
  accepted: boolean // accepted, replied or converted — or an accept logged before a decline
  replied: boolean // wrote back, or a call booked
  day?: string // the invite's New York day key (people per brand: a brand's first day); else its UTC date
  fit?: number | null // the brand's Brand Fit today (people per brand: by fit)
}

// How many people to invite at a brand (people-per-brand, Oct 18 2026 —
// Leo: "if we do more than 3 people do we have a higher probability of
// getting an acceptance"; accepts only, his call — replies are too few
// yet). A brand counts as a yes when anyone there accepted. Raw rates,
// not pulled toward the average: the point is the trend across groups.
export type DepthCell = {
  key: string
  brands: number; brandsYes: number; brandRate: number | null // brands, and brands where someone accepted
  people: number; peopleYes: number; personRate: number | null // each invite
  few: boolean // under FEW brands (FEW people in byOrder)
}
// If each person accepts at the overall rate on their own: a brand's chance
// of a yes with k invited, what the k-th person adds, and brands with a yes
// per DEPTH_DAY invites (a full day) at k a brand.
export type DepthModel = { k: number; brandChance: number; adds: number; brandsPerDay: number }
export type DepthTable = {
  personRate: number | null
  byOrder: DepthCell[] // each person by when they were invited at the brand: 1, 2, 3, 4, 5+
  byFirstDay: DepthCell[] // brands by how many went out on their first day (that day's invites only)
  byTotal: DepthCell[] // brands by how many were invited there in all
  byFit: DepthCell[] // brands by Brand Fit today
  model: DepthModel[]
  day: number
}
export const DEPTH_DAY = 30 // DAILY_SEND_LIMIT in route.ts
export const FIT_BANDS: Array<[string, number]> = [['65+', 65], ['50–64', 50], ['under 50', -Infinity]]
export function fitBand(fit: number | null | undefined): string {
  if (fit == null) return 'not scored'
  return FIT_BANDS.find(([, min]) => fit >= min)![0]
}

export type OutcomeCell = {
  key: string
  // Invites old enough to judge an accept / a reply (per brand for the
  // threads group: brands, and brands with anyone who accepted / replied).
  n: number; accepted: number; acceptRate: number | null
  replyN: number; replied: number; replyRate: number | null
  few: boolean
}
export type OutcomeSuggestion = { category: string; from: Priority; to: Priority; text: string; ratio: number }
export type OutcomeTable = {
  overall: { n: number; accepted: number; acceptRate: number | null; replyN: number; replied: number; replyRate: number | null }
  byCategory: OutcomeCell[]
  bySize: OutcomeCell[]
  byBuyer: OutcomeCell[]
  byThreads: OutcomeCell[]
  depth: DepthTable
  suggestions: OutcomeSuggestion[]
  acceptAfterDays: number; replyAfterDays: number; few: number
}

const DAY = 864e5
const ms = (d: Date | string) => (d instanceof Date ? d.getTime() : Date.parse(d))

// The brand's thread count as a group: 1, 2, 3, 4, 5–9, 10+.
export function threadsKey(n: number): string {
  return n >= 10 ? '10+' : n >= 5 ? '5–9' : String(Math.max(1, n))
}
const THREAD_ORDER = ['1', '2', '3', '4', '5–9', '10+']
const SIZE_ORDER = ['small', 'target', 'unknown', 'big']
const BUYER_ORDER = ['partnerships', 'events', 'marketing', 'founder', 'other']

function smooth(yes: number, n: number, overall: number | null): number | null {
  if (!n) return null
  return overall == null ? yes / n : (yes + PRIOR * overall) / (n + PRIOR)
}

export function outcomeRates(
  invites: OutcomeInvite[],
  opts: { now: Date; priorityOf?: (category: string | null) => Priority; acceptAfterDays?: number; replyAfterDays?: number },
): OutcomeTable {
  const aDays = opts.acceptAfterDays ?? ACCEPT_AFTER_DAYS
  const rDays = opts.replyAfterDays ?? REPLY_AFTER_DAYS
  const now = opts.now.getTime()
  const forAccept = invites.filter(t => now - ms(t.at) >= aDays * DAY)
  const forReply = invites.filter(t => now - ms(t.at) >= rDays * DAY)
  const yesA = forAccept.filter(t => t.accepted).length
  const yesR = forReply.filter(t => t.replied).length
  const overallA = forAccept.length ? yesA / forAccept.length : null
  const overallR = forReply.length ? yesR / forReply.length : null

  const group = (keyOf: (t: OutcomeInvite) => string, order?: string[]): OutcomeCell[] => {
    const cells = new Map<string, OutcomeCell>()
    const cell = (k: string) => {
      let c = cells.get(k)
      if (!c) { c = { key: k, n: 0, accepted: 0, acceptRate: null, replyN: 0, replied: 0, replyRate: null, few: true }; cells.set(k, c) }
      return c
    }
    for (const t of forAccept) { const c = cell(keyOf(t)); c.n++; if (t.accepted) c.accepted++ }
    for (const t of forReply) { const c = cell(keyOf(t)); c.replyN++; if (t.replied) c.replied++ }
    const out = [...cells.values()].map(c => ({
      ...c, acceptRate: smooth(c.accepted, c.n, overallA), replyRate: smooth(c.replied, c.replyN, overallR), few: c.n < FEW,
    }))
    return order
      ? out.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
      : out.sort((a, b) => b.n - a.n || a.key.localeCompare(b.key))
  }

  // Per brand: how many people were invited there (all its LinkedIn
  // invites in the window), and whether anyone accepted / replied.
  const brandGroup = (list: OutcomeInvite[], all: OutcomeInvite[]) => {
    const per = new Map<string, { n: number; yesA: boolean; yesR: boolean }>()
    for (const t of all) {
      const p = per.get(t.brandId) ?? { n: 0, yesA: false, yesR: false }
      p.n++
      per.set(t.brandId, p)
    }
    for (const t of list) {
      const p = per.get(t.brandId)!
      if (t.accepted) p.yesA = true
      if (t.replied) p.yesR = true
    }
    return per
  }
  const brandsA = brandGroup(forAccept, invites)
  const brandsR = brandGroup(forReply, invites)
  const inA = new Set(forAccept.map(t => t.brandId))
  const inR = new Set(forReply.map(t => t.brandId))
  const brandYesA = [...inA].filter(id => brandsA.get(id)!.yesA).length
  const brandYesR = [...inR].filter(id => brandsR.get(id)!.yesR).length
  const bOverallA = inA.size ? brandYesA / inA.size : null
  const bOverallR = inR.size ? brandYesR / inR.size : null
  const tCells = new Map<string, OutcomeCell>()
  const tCell = (k: string) => {
    let c = tCells.get(k)
    if (!c) { c = { key: k, n: 0, accepted: 0, acceptRate: null, replyN: 0, replied: 0, replyRate: null, few: true }; tCells.set(k, c) }
    return c
  }
  for (const id of inA) { const p = brandsA.get(id)!; const c = tCell(threadsKey(p.n)); c.n++; if (p.yesA) c.accepted++ }
  for (const id of inR) { const p = brandsR.get(id)!; const c = tCell(threadsKey(p.n)); c.replyN++; if (p.yesR) c.replied++ }
  const byThreads = [...tCells.values()]
    .map(c => ({ ...c, acceptRate: smooth(c.accepted, c.n, bOverallA), replyRate: smooth(c.replied, c.replyN, bOverallR), few: c.n < FEW }))
    .sort((a, b) => THREAD_ORDER.indexOf(a.key) - THREAD_ORDER.indexOf(b.key))

  const byCategory = group(t => t.category ?? '')
  const suggestions: OutcomeSuggestion[] = []
  if (overallA && opts.priorityOf) {
    for (const c of byCategory) {
      if (c.few || !c.key || c.acceptRate == null) continue
      const from = opts.priorityOf(c.key)
      if (from === 'skip') continue // set aside on purpose
      const ratio = c.acceptRate / overallA
      const i = PRIORITIES.indexOf(from)
      // Top → Middle → Low (Skip is never suggested).
      const to = ratio >= SUGGEST_UP && i > 0 ? PRIORITIES[i - 1] : ratio <= SUGGEST_DOWN && i < 2 ? PRIORITIES[i + 1] : null
      if (!to) continue
      const times = ratio >= 1 ? (Math.round(ratio * 10) / 10) + '× the average' : Math.round(ratio * 100) + '% of the average'
      suggestions.push({
        category: c.key, from, to, ratio,
        text: `accepts ${times} (${c.accepted} of ${c.n}) — make it ${PRIORITY_WORD[to]}?`,
      })
    }
    suggestions.sort((a, b) => Math.abs(Math.log(b.ratio)) - Math.abs(Math.log(a.ratio)))
  }

  return {
    overall: { n: forAccept.length, accepted: yesA, acceptRate: overallA, replyN: forReply.length, replied: yesR, replyRate: overallR },
    byCategory,
    bySize: group(t => t.size, SIZE_ORDER),
    byBuyer: group(t => t.buyer ?? 'other', BUYER_ORDER),
    byThreads,
    depth: depthTable(invites, now, aDays),
    suggestions,
    acceptAfterDays: aDays, replyAfterDays: rDays, few: FEW,
  }
}

const dayOf = (t: OutcomeInvite) => t.day ?? new Date(ms(t.at)).toISOString().slice(0, 10)
const rate = (yes: number, n: number) => (n ? yes / n : null)
const ORDER_KEYS = ['1', '2', '3', '4', '5+']
const FIT_ORDER = [...FIT_BANDS.map(b => b[0]), 'not scored']

// People per brand: is the 4th person less likely to accept than the 1st,
// and does a brand with more people invited get a yes more often than the
// overall per-person rate alone would give it?
export function depthTable(invites: OutcomeInvite[], now: number, aDays: number): DepthTable {
  const old = (t: OutcomeInvite) => now - ms(t.at) >= aDays * DAY
  const byBrand = new Map<string, OutcomeInvite[]>()
  for (const t of invites) {
    const l = byBrand.get(t.brandId)
    if (l) l.push(t); else byBrand.set(t.brandId, [t])
  }
  const cells = (order: string[]) => {
    const m = new Map<string, DepthCell>()
    const at = (k: string) => {
      let c = m.get(k)
      if (!c) { c = { key: k, brands: 0, brandsYes: 0, brandRate: null, people: 0, peopleYes: 0, personRate: null, few: true }; m.set(k, c) }
      return c
    }
    // A brand's judged invites under one key: one brand, its people.
    const add = (k: string, judged: OutcomeInvite[]) => {
      if (!judged.length) return
      const c = at(k)
      c.brands++
      if (judged.some(t => t.accepted)) c.brandsYes++
      c.people += judged.length
      c.peopleYes += judged.filter(t => t.accepted).length
    }
    const done = (perPerson = false) => [...m.values()]
      .map(c => ({ ...c, brandRate: rate(c.brandsYes, c.brands), personRate: rate(c.peopleYes, c.people), few: (perPerson ? c.people : c.brands) < FEW }))
      .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
    return { add, at, done }
  }
  const order = cells(ORDER_KEYS)
  const first = cells(THREAD_ORDER)
  const total = cells(THREAD_ORDER)
  const fit = cells(FIT_ORDER)
  for (const list of byBrand.values()) {
    // Invite order at the brand: by send time (a day's batch goes out in
    // the queue's order, best buyers first); a tie keeps the list's order.
    const sorted = list.map((t, i) => ({ t, i })).sort((a, b) => ms(a.t.at) - ms(b.t.at) || a.i - b.i).map(x => x.t)
    sorted.forEach((t, i) => {
      if (!old(t)) return
      const c = order.at(i >= 4 ? '5+' : String(i + 1))
      c.brands++; c.people++
      if (t.accepted) { c.brandsYes++; c.peopleYes++ }
    })
    const firstDay = dayOf(sorted[0])
    const dayOne = sorted.filter(t => dayOf(t) === firstDay)
    first.add(threadsKey(dayOne.length), dayOne.filter(old))
    const judged = sorted.filter(old)
    total.add(threadsKey(sorted.length), judged)
    fit.add(fitBand(sorted[0].fit), judged)
  }
  const all = invites.filter(old)
  const p = rate(all.filter(t => t.accepted).length, all.length)
  const model: DepthModel[] = p == null ? [] : [1, 2, 3, 4, 5, 6].map(k => {
    const brandChance = 1 - Math.pow(1 - p, k)
    return { k, brandChance, adds: p * Math.pow(1 - p, k - 1), brandsPerDay: (DEPTH_DAY / k) * brandChance }
  })
  return {
    personRate: p,
    byOrder: order.done(true),
    byFirstDay: first.done(),
    byTotal: total.done(),
    byFit: fit.done(),
    model,
    day: DEPTH_DAY,
  }
}
