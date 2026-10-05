// Which brands are worth reaching out to (Leo, Oct 2026: "a filter
// process to determine which brands we should reach out to"). Rules
// only, no model calls — every point comes with the reason it was given,
// so the score is never a black box.
//
// Leo's answers:
//   - Rank by budget, any size. Money weighs the most: annual sales, or
//     venture funding ($5M+ raised is "a lot"). No money known → estimate
//     it from the brand's LinkedIn size (brand-size.ts — the same size the
//     LinkedIn fill uses, one definition).
//   - Also counts: already sponsors college / music, a category that sells
//     to 18–24 (drinks, nicotine & betting, apparel / athletic / beauty),
//     people we can reach on file, and how well the category converts.
//   - Ruled out: confirmed not sold in the US. Unknown → kept, tagged "US?".
//   - Too small (a switch, on by default): sales under $1M; sales not
//     known → under 20 people on LinkedIn, measured (brand-size.ts's
//     SMALL_BELOW). A size guessed from tier never hides a brand.
//   - Suggest Archive: confirmed not in the US, out of business / acquired,
//     or researched and none of the signals above.
//
// Money is integer cents (CLAUDE.md rule 1). Sales and funding totals pass
// $21M, past Postgres Int in cents, so the columns are BigInt; callers
// hand this file plain numbers (exact up to ~$90 trillion).

import { brandSize, sizeFromMembers, type BrandSize } from './brand-size'

export const TOO_SMALL_SALES_CENTS = 1_000_000 * 100 // $1M
export const BIG_FUNDING_CENTS = 5_000_000 * 100 // $5M raised = "a lot of venture money"
export const RECENT_ROUND_DAYS = 730 // a round in the last 2 years is fresh money
export const LOW_FIT = 35 // under this with no signal → suggested for Archive

// The categories that sell to 18–24 (Leo's pick).
export const YOUTH_CATEGORIES = [
  'electrolytes', 'energy', 'beverage', 'rtd', 'spirits', 'alcohol',
  'nicotine', 'betting',
  'apparel', 'athletic', 'beauty',
]

export type UsStatus = 'yes' | 'no'
export type BizStatus = 'active' | 'closed' | 'acquired'

export interface FitInput {
  category: string | null
  tier?: string | null
  liMembers?: number | null
  hasParent?: boolean
  salesCents?: number | null
  fundingCents?: number | null
  lastRoundAt?: Date | string | null
  usStatus?: string | null
  sponsorsCollege?: boolean | null
  bizStatus?: string | null
  acquiredBy?: string | null
  researchedAt?: Date | string | null
  reachable: number // people we can write to (email or LinkedIn)
  need: number // threads the brand wants open (contactLabel's need)
  acceptRate?: number | null // the category's smoothed accept rate, 0..1
  now: Date
}

export interface FitReason {
  good: boolean | null // true = counts for, false = against, null = unknown
  text: string
  points: number
}

export interface FitResult {
  score: number // 0..100
  size: BrandSize
  tooSmall: boolean
  tooSmallWhy: string | null
  ruledOut: string | null // not in the US / closed / acquired
  archiveWhy: string | null // why it's on the suggest-Archive list
  usUnknown: boolean // the "US?" tag
  reasons: FitReason[]
}

// "$12M" / "12,000,000" / "1.2B" / "750k" / 12000000 (dollars) → cents.
// Null for blank or unreadable — never a guess.
export function dollarsToCents(v: unknown): number | null {
  if (v == null || v === '') return null
  if (typeof v === 'number') return isFinite(v) && v >= 0 ? Math.round(v * 100) : null
  const s = String(v).trim().toLowerCase().replace(/^us\$|^\$|usd\s*/g, '').replace(/,/g, '').trim()
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(k|thousand|m|mm|mil|million|b|bn|billion)?\+?$/)
  if (!m) return null
  const mult: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, mil: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 }
  const dollars = Number(m[1]) * (m[2] ? mult[m[2]] : 1)
  return isFinite(dollars) ? Math.round(dollars * 100) : null
}

// Cents → "$1.2M" for reasons and tags.
export function shortMoney(cents: number): string {
  const d = cents / 100
  if (d >= 1e9) return '$' + trim(d / 1e9) + 'B'
  if (d >= 1e6) return '$' + trim(d / 1e6) + 'M'
  if (d >= 1e3) return '$' + trim(d / 1e3) + 'K'
  return '$' + Math.round(d)
}
function trim(n: number): string {
  return n >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10)
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v)
  return isNaN(d.getTime()) ? null : d
}

export function normUs(v: unknown): UsStatus | null {
  const s = String(v ?? '').trim().toLowerCase()
  if (['yes', 'y', 'true', 'us'].includes(s)) return 'yes'
  if (['no', 'n', 'false'].includes(s)) return 'no'
  return null
}

export function normBiz(v: unknown): BizStatus | null {
  const s = String(v ?? '').trim().toLowerCase()
  if (s === 'active') return 'active'
  if (s === 'closed' || s === 'out of business' || s === 'defunct') return 'closed'
  if (s === 'acquired') return 'acquired'
  return null
}

export function isTooSmall(b: { salesCents?: number | null; liMembers?: number | null; tier?: string | null; hasParent?: boolean }): { tooSmall: boolean; why: string | null; size: BrandSize } {
  const size = brandSize(b)
  if (b.salesCents != null) {
    return b.salesCents < TOO_SMALL_SALES_CENTS
      ? { tooSmall: true, why: 'sales ' + shortMoney(b.salesCents) + ' a year (under $1M)', size }
      : { tooSmall: false, why: null, size }
  }
  // Only a measured headcount hides a brand: brandSize's tier / parent
  // fallback is a guess, and hiding a real buyer costs more than showing
  // an extra row.
  if (sizeFromMembers(b.liMembers) === 'small') {
    return { tooSmall: true, why: b.liMembers + ' people on LinkedIn (under 20)', size }
  }
  return { tooSmall: false, why: null, size }
}

// Money: up to 40 points, whichever of sales / funding says more.
function salesPoints(c: number): number {
  if (c >= 100_000_000 * 100) return 40
  if (c >= 25_000_000 * 100) return 34
  if (c >= 10_000_000 * 100) return 28
  if (c >= TOO_SMALL_SALES_CENTS) return 18
  return 0
}
function fundingPoints(c: number, recent: boolean): number {
  let p = 0
  if (c >= 100_000_000 * 100) p = 36
  else if (c >= 25_000_000 * 100) p = 32
  else if (c >= BIG_FUNDING_CENTS) p = 26
  else if (c >= 1_000_000 * 100) p = 10
  else p = 2
  if (recent && c >= BIG_FUNDING_CENTS) p += 4
  return Math.min(40, p)
}
// No money known: LinkedIn size stands in.
const SIZE_POINTS: Record<BrandSize, number> = { big: 30, target: 22, unknown: 15, small: 6 }

export function scoreBrand(b: FitInput): FitResult {
  const reasons: FitReason[] = []
  const add = (good: boolean | null, text: string, points: number) => reasons.push({ good, text, points })

  // 1. Budget / venture money.
  const last = toDate(b.lastRoundAt)
  const recent = !!last && (b.now.getTime() - last.getTime()) / 86_400_000 <= RECENT_ROUND_DAYS
  const sp = b.salesCents != null ? salesPoints(b.salesCents) : null
  const fp = b.fundingCents != null ? fundingPoints(b.fundingCents, recent) : null
  const size = brandSize(b)
  if (sp == null && fp == null) {
    const p = SIZE_POINTS[size]
    add(size === 'small' ? false : null,
      'money not known — ' + (b.liMembers != null ? b.liMembers + ' people on LinkedIn' : size === 'unknown' ? 'size not known' : size + ' (by ' + (b.hasParent ? 'parent company' : 'tier') + ')'),
      p)
  } else {
    if (sp != null) add(sp >= 18, 'sales ' + shortMoney(b.salesCents!) + ' a year', (sp >= (fp ?? -1)) ? sp : 0)
    if (fp != null) {
      const big = b.fundingCents! >= BIG_FUNDING_CENTS
      add(big, 'raised ' + shortMoney(b.fundingCents!) + (last ? ' · last round ' + last.toISOString().slice(0, 7) : '') + (big ? '' : ' (under $5M)'),
        fp > (sp ?? -1) ? fp : 0)
    }
  }

  // 2. Already sponsors college / music.
  if (b.sponsorsCollege === true) add(true, 'already sponsors college / music', 20)
  else if (b.sponsorsCollege === false) add(false, 'no college / music sponsorships found', 0)
  else add(null, 'college / music sponsorships not checked', 6)

  // 3. Sells to 18–24.
  if (b.category && YOUTH_CATEGORIES.includes(b.category)) add(true, 'category sells to 18–24', 15)
  else add(false, 'category not aimed at 18–24', 0)

  // 4. People we can reach.
  if (b.reachable >= b.need && b.reachable > 0) add(true, b.reachable + ' people we can reach', 15)
  else if (b.reachable > 0) add(null, 'only ' + b.reachable + ' of ' + b.need + ' people we can reach', 8)
  else add(false, 'no one we can reach yet', 0)

  // 5. The category converts.
  if (b.acceptRate == null) add(null, 'category accept rate not known yet', 5)
  else {
    const p = Math.max(0, Math.min(10, Math.round(b.acceptRate * 25)))
    add(p >= 5, 'category accepts ' + Math.round(b.acceptRate * 100) + '% of invites', p)
  }

  const score = Math.max(0, Math.min(100, reasons.reduce((s, r) => s + r.points, 0)))

  const us = normUs(b.usStatus)
  const biz = normBiz(b.bizStatus)
  let ruledOut: string | null = null
  if (us === 'no') ruledOut = 'not sold in the US'
  else if (biz === 'closed') ruledOut = 'out of business'
  else if (biz === 'acquired') ruledOut = 'acquired' + (b.acquiredBy ? ' by ' + b.acquiredBy : '')

  // Researched and nothing speaks for it: no money signal, no college /
  // music sponsorships, not an 18–24 category. Unknowns are not "no" —
  // a brand nobody has researched is never suggested on score alone.
  const moneySignal = (b.salesCents != null && b.salesCents >= TOO_SMALL_SALES_CENTS)
    || (b.fundingCents != null && b.fundingCents >= BIG_FUNDING_CENTS)
  const youth = !!b.category && YOUTH_CATEGORIES.includes(b.category)
  const noSignals = !!toDate(b.researchedAt) && !moneySignal && b.sponsorsCollege !== true && !youth
  const archiveWhy = ruledOut ?? (noSignals && score < LOW_FIT ? 'low fit (' + score + '), no signal: no budget or funding, no college / music sponsorships, not 18–24' : null)

  const small = isTooSmall({ ...b })
  return {
    score,
    size,
    tooSmall: small.tooSmall,
    tooSmallWhy: small.why,
    ruledOut,
    archiveWhy,
    usUnknown: us == null,
    reasons,
  }
}

// One row of a pasted research import (Claude researches, Leo pastes).
// Accepts dollars in any common spelling; never invents a field that
// isn't there — a missing key leaves the brand's value as it is.
export interface ResearchRow {
  name: string
  website?: string | null
  salesCents?: number | null
  fundingCents?: number | null
  lastRoundAt?: string | null // YYYY-MM or YYYY-MM-DD
  usStatus?: UsStatus | null
  sponsorsCollege?: boolean | null
  sponsorNote?: string | null
  bizStatus?: BizStatus | null
  acquiredBy?: string | null
  note?: string | null
}

export const RESEARCH_KEYS = ['sales', 'funding', 'lastRound', 'us', 'sponsorsCollege', 'sponsorNote', 'status', 'acquiredBy', 'note', 'website'] as const

export function cleanResearchRow(raw: any): { row: ResearchRow | null; error: string | null } {
  if (!raw || typeof raw !== 'object') return { row: null, error: 'not an object' }
  const name = String(raw.name ?? raw.brand ?? '').trim()
  if (!name) return { row: null, error: 'no name' }
  const row: ResearchRow = { name }
  const has = (k: string) => Object.prototype.hasOwnProperty.call(raw, k) && raw[k] !== undefined

  if (has('sales')) {
    if (raw.sales === null || raw.sales === '') row.salesCents = null
    else {
      const c = dollarsToCents(raw.sales)
      if (c == null) return { row: null, error: name + ': sales "' + raw.sales + '" is not an amount' }
      row.salesCents = c
    }
  }
  if (has('funding')) {
    if (raw.funding === null || raw.funding === '') row.fundingCents = null
    else {
      const c = dollarsToCents(raw.funding)
      if (c == null) return { row: null, error: name + ': funding "' + raw.funding + '" is not an amount' }
      row.fundingCents = c
    }
  }
  if (has('lastRound')) {
    const s = raw.lastRound == null ? '' : String(raw.lastRound).trim()
    if (!s) row.lastRoundAt = null
    else if (/^\d{4}-\d{2}(-\d{2})?$/.test(s)) row.lastRoundAt = s.length === 7 ? s + '-01' : s
    else return { row: null, error: name + ': lastRound "' + s + '" — use YYYY-MM' }
  }
  if (has('us')) {
    const u = raw.us == null || raw.us === '' || String(raw.us).toLowerCase() === 'unknown' ? null : normUs(raw.us)
    if (raw.us != null && raw.us !== '' && String(raw.us).toLowerCase() !== 'unknown' && u == null) return { row: null, error: name + ': us must be yes / no / unknown' }
    row.usStatus = u
  }
  if (has('sponsorsCollege')) {
    const v = raw.sponsorsCollege
    if (v === true || v === false || v === null) row.sponsorsCollege = v
    else {
      const s = String(v).trim().toLowerCase()
      if (s === 'yes' || s === 'true') row.sponsorsCollege = true
      else if (s === 'no' || s === 'false') row.sponsorsCollege = false
      else if (s === '' || s === 'unknown') row.sponsorsCollege = null
      else return { row: null, error: name + ': sponsorsCollege must be yes / no / unknown' }
    }
  }
  if (has('status')) {
    const s = raw.status == null || raw.status === '' ? null : normBiz(raw.status)
    if (raw.status != null && raw.status !== '' && s == null) return { row: null, error: name + ': status must be active / closed / acquired' }
    row.bizStatus = s
  }
  const text = (k: string, max: number) => has(k) ? (raw[k] == null ? null : String(raw[k]).trim().slice(0, max) || null) : undefined
  const sn = text('sponsorNote', 500); if (sn !== undefined) row.sponsorNote = sn
  const ab = text('acquiredBy', 120); if (ab !== undefined) row.acquiredBy = ab
  const nt = text('note', 1000); if (nt !== undefined) row.note = nt
  const ws = text('website', 300); if (ws !== undefined) row.website = ws
  return { row, error: null }
}
