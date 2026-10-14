// The LinkedIn fill's schedule (Leo, Oct 12 2026: "make me a schedule for the
// brands that run in the linkedin fills"): the fill's own worklist (liList,
// li-list-db.ts) cut into the days the run takes it in — DAILY_CAP brands a
// day (LI_PER_DAY), today's what's left after the brands already read today.
// Read-only, a forecast: each run asks for the list fresh, so brands read,
// added or planned in between move it. Pure — scripts/test-fill-schedule.mjs.

import { issueWords } from './li-sweep'

export type FillItem = {
  brandId?: string | null; name: string; category?: string | null; contacts?: number; fit?: number | null
  research?: boolean; asked?: boolean; lane?: string; planned?: string; hiddenRetry?: boolean
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
  if (i.asked) return 'Asked for by name'
  // Read last wins: that's where the run puts it, Sales Navigator retry or not.
  if (i.last === 'reached') return 'Already reached out — read last'
  if (i.last === 'giant') return 'Giant, held back — read last'
  // Back because the last read went wrong (li-sweep.ts liDue).
  if (i.retry) return 'Read again — ' + (issueWords(i.issue) || 'last read had an issue') + (i.tries && i.tries > 1 ? ' (try ' + (i.tries + 1) + ')' : '')
  if (i.hiddenRetry) return 'Back for Sales Navigator (buyers hidden last time)'
  const bits: string[] = []
  if (i.research) bits.push('Research list' + (i.lane ? ' · ' + i.lane : ''))
  // Mid-size first (Leo, Oct 12 2026): the size the run orders by.
  if (!i.research && i.size === 'target') bits.push('mid-size')
  else if (!i.research && i.size === 'big') bits.push('big company')
  if (i.noBuyer && !i.research) bits.push('no buyer on file')
  if (i.focus && focus) bits.push('focus “' + focus + '”')
  const why = bits.join(' · ') || 'under 25 people on file'
  return why.charAt(0).toUpperCase() + why.slice(1)
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
