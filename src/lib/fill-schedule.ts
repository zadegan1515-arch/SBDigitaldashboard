// The LinkedIn fill's schedule (Leo, Oct 12 2026: "make me a schedule for the
// brands that run in the linkedin fills"): the fill's own worklist (liList,
// li-list-db.ts) cut into the days the run takes it in — DAILY_CAP brands a
// day (LI_PER_DAY), today's what's left after the brands already read today.
// Read-only, a forecast: each run asks for the list fresh, so brands read,
// added or planned in between move it. Pure — scripts/test-fill-schedule.mjs.

import { issueWords } from './li-sweep'

export type FillItem = {
  brandId?: string | null; name: string; category?: string | null; contacts?: number; fit?: number | null
  research?: boolean; asked?: boolean; lane?: string; planned?: string; hiddenRetry?: boolean; mine?: 'list' | 'added'
  retry?: boolean; issue?: string | null; tries?: number
  noBuyer?: boolean; focus?: boolean; last?: 'reached' | 'giant'; size?: string; parent?: { name: string } | null
}
export type FillRow = {
  brandId: string | null; name: string; category: string | null; fit: number | null; contacts: number
  research: boolean; why: string
}
export type FillDay = { day: string; rows: FillRow[] }

// Why the run takes it where it does — the script's whyItem, in a few words.
export function fillWhy(i: FillItem, focus: string, dayLabel: (key: string) => string = k => k): string {
  if (i.planned) return 'On the Schedule ' + dayLabel(i.planned) + ', short on people'
  if (i.mine) return i.mine === 'list' ? 'On your Week plan list (you added it)' : 'You added it'
  if (i.asked) return 'Asked for by name'
  // Read last wins: that's where the run puts it, Sales Navigator retry or not.
  if (i.last === 'reached') return 'Already reached out — read last'
  if (i.last === 'giant') return 'Giant, held back — read last'
  // Back because the last read went wrong (li-sweep.ts liDue).
  if (i.retry) return 'Read again — ' + (issueWords(i.issue) || 'last read had an issue') + (i.tries && i.tries > 1 ? ' (try ' + (i.tries + 1) + ')' : '')
  if (i.hiddenRetry) return 'Back for Sales Navigator (buyers hidden last time)'
  const bits: string[] = []
  if (i.research) bits.push('Research list' + (i.lane ? ' · ' + i.lane : ''))
  // Size and the rest only break a tie in Brand Fit now (byFit below).
  if (!i.research && i.size === 'target') bits.push('mid-size')
  else if (!i.research && i.size === 'big') bits.push('big company')
  if (i.noBuyer && !i.research) bits.push('no buyer on file')
  if (i.focus && focus) bits.push('focus “' + focus + '”')
  const why = bits.join(' · ') || 'under 25 people on file'
  return why.charAt(0).toUpperCase() + why.slice(1)
}

// The fill's order (Leo, Oct 19 2026: "have the highest rated brands … ran
// first then the lower ones after"): best Brand Fit first. It replaced mid-size
// first (Oct 12) and "brands whose last read went wrong go first" (Oct 14) —
// those now only break a tie: a re-read (its buyers are known to be there), a
// saved LinkedIn page (no search that may find nothing), the focus word,
// mid-size → not measured → small → big, no buyer on file yet, fewest on file,
// the name. No score (a research name) goes last.
export type FitOrderItem = {
  name: string; fit?: number | null; retry?: boolean; linkedinUrl?: string | null; focus?: boolean
  size?: string; noBuyer?: boolean; contacts?: number
}
const SIZE_TIE: Record<string, number> = { target: 0, unknown: 1, small: 2, big: 3 }
export function byFit<T extends FitOrderItem>(xs: T[]): T[] {
  const size = (i: T) => SIZE_TIE[i.size || ''] ?? 4
  return [...xs].sort((a, b) => (b.fit ?? -1) - (a.fit ?? -1)
    || Number(!!b.retry) - Number(!!a.retry)
    || Number(!!b.linkedinUrl) - Number(!!a.linkedinUrl)
    || Number(!!b.focus) - Number(!!a.focus)
    || size(a) - size(b)
    || Number(!!b.noBuyer) - Number(!!a.noBuyer)
    || (a.contacts ?? 0) - (b.contacts ?? 0)
    || a.name.localeCompare(b.name))
}

function addDays(key: string, n: number): string {
  return new Date(new Date(key + 'T12:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10)
}

// Cut the ordered list into days: today gets what's left of today's
// perDay, then perDay a day, every calendar day (the run waits for the
// next morning, weekends too).
export function splitFillDays(
  items: FillItem[],
  opts: { today: string; doneToday: number; perDay: number; focus?: string; dayLabel?: (key: string) => string },
): FillDay[] {
  const per = Math.max(1, opts.perDay)
  const left = Math.max(0, per - Math.max(0, opts.doneToday))
  const days: FillDay[] = []
  let day = left ? opts.today : addDays(opts.today, 1)
  let room = left || per
  for (const i of items) {
    if (!days.length || days[days.length - 1].day !== day) days.push({ day, rows: [] })
    days[days.length - 1].rows.push({
      brandId: i.brandId ?? null, name: i.name, category: i.category ?? null, fit: i.fit ?? null,
      contacts: i.contacts ?? 0, research: !!i.research, why: fillWhy(i, opts.focus || '', opts.dayLabel),
    })
    if (--room === 0) { day = addDays(day, 1); room = per }
  }
  return days
}
