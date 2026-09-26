// scripts/test-plan-week.mjs — guards src/lib/plan-week.ts (Outreach →
// Schedule: Plan my week, LinkedIn's weekly limit, accept rates).
//
// Plan my week writes three days of outreach in one click, so the rules it
// picks by are pinned here: a day's category can fill it, never repeats the
// day before, rotates to what was worked least recently, keeps what Leo set;
// every brand goes in whole or not at all and on one day only. The LinkedIn
// count is the seven days ending on each day. Compiles the lib on its own,
// like test-stock.mjs. Run: node scripts/test-plan-week.mjs

import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = mkdtempSync(join(tmpdir(), 'plan-week-test-'))
execSync(
  'npx tsc src/lib/plan-week.ts --outDir ' + out +
  ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck',
  { stdio: 'inherit' },
)
const { linkedinWindows, acceptRates, planWeekDays, LINKEDIN_WEEK_LIMIT, LINKEDIN_WEEK_NEAR } =
  await import(pathToFileURL(join(out, 'plan-week.js')).href)

let pass = 0, fail = 0
const is = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return }
  fail++; console.log('✗', label, '— got', JSON.stringify(got), 'want', JSON.stringify(want))
}

// ---- LinkedIn's seven days --------------------------------------------
{
  is('limit and warning line', [LINKEDIN_WEEK_LIMIT, LINKEDIN_WEEK_NEAR], [100, 80])
  const today = '2026-09-25' // a Friday
  const sent = new Map([['2026-09-22', 20], ['2026-09-23', 20], ['2026-09-24', 18], ['2026-09-25', 7], ['2026-09-18', 20]])
  // Today's planned number already includes this morning's 7.
  const planned = new Map([['2026-09-25', 20], ['2026-09-29', 20], ['2026-09-30', 20], ['2026-10-01', 20]])
  const w = linkedinWindows(['2026-09-25', '2026-09-29', '2026-09-30', '2026-10-01'], planned, sent, today)
  // Sep 19..25: 20 + 20 + 18 (sent) + 20 (today planned, not 7 + 20).
  is('today = the last six days sent + today planned', w['2026-09-25'].count, 78)
  // Sep 23..29: 20 + 18 + 20 (today) + 20 (Tue); the weekend and Monday send nothing.
  is('Tue = sent before today + today + Tue', w['2026-09-29'].count, 78)
  is('Wed = Sep 24..30', w['2026-09-30'].count, 18 + 20 + 20 + 20)
  is('Thu = Sep 25..Oct 1', w['2026-10-01'].count, 20 + 20 + 20 + 20)
  is('80 is not near yet', w['2026-10-01'].near, false)
  const heavy = linkedinWindows(['2026-09-30'], new Map([['2026-09-25', 30], ['2026-09-29', 40], ['2026-09-30', 20]]), sent, today)
  is('over by what passes 100', [heavy['2026-09-30'].count, heavy['2026-09-30'].over, heavy['2026-09-30'].near], [18 + 30 + 40 + 20, 8, true])
  const quiet = linkedinWindows(['2026-09-26'], new Map(), sent, today)
  // A day nothing is planned for counts what was logged (Sep 20..26):
  // 20 + 20 + 18 + 7 (today, logged so far).
  is('nothing planned counts what was logged', quiet['2026-09-26'].count, 65)
  // Today not a sending day: its logged invites still count.
  const off = linkedinWindows(['2026-09-29'], new Map([['2026-09-29', 20]]), sent, today)
  is('an off day today counts its logged invites', off['2026-09-29'].count, 20 + 18 + 7 + 20)
}

// ---- accept rates ------------------------------------------------------
{
  const inv = []
  for (let i = 0; i < 20; i++) inv.push({ category: 'energy', accepted: i < 10 })  // 50%
  for (let i = 0; i < 20; i++) inv.push({ category: 'rtd', accepted: i < 2 })      // 10%
  inv.push({ category: 'beauty', accepted: true })                                 // 1 of 1
  inv.push({ category: null, accepted: false })
  const r = acceptRates(inv)
  is('overall rate', r.overall, 13 / 42)
  is('raw counts kept', r.raw.get('energy'), { invites: 20, accepted: 10 })
  is('no category counted under ""', r.raw.get(''), { invites: 1, accepted: 0 })
  const o = r.overall
  is('energy pulled a little toward overall', r.of('energy'), (10 + 5 * o) / 25)
  is('one lucky accept does not top the list', r.of('beauty') < r.of('energy'), true)
  is('never tried = the overall rate', r.of('spirits'), o)
  is('ranks energy over rtd', r.of('energy') > r.of('rtd'), true)
  is('no invites at all: 0, not NaN', acceptRates([]).of('energy'), 0)
}

// ---- Plan my week ------------------------------------------------------
const cand = (id, category, size, ready = true) => ({ id, category, size, ready })
const day = (date, kept = [], category = null) => ({ date, kept, category })
const DAYS = ['2026-09-29', '2026-09-30', '2026-10-01']
const base = (over = {}) => ({
  days: DAYS.map(d => day(d)),
  cands: [],
  cap: 20,
  prev: null,
  lastSent: new Map(),
  rateOf: () => 0.2,
  related: { electrolytes: ['energy'], energy: ['electrolytes'], rtd: ['spirits'] },
  ...over,
})
const fillCat = (cat, n, size = 4, prefix = cat) => Array.from({ length: n }, (_, i) => cand(prefix + i, cat, size))

{
  // Three categories that can each fill a day; energy was worked most
  // recently, rtd longest ago, electrolytes never.
  const cands = [...fillCat('energy', 5), ...fillCat('rtd', 5), ...fillCat('electrolytes', 5)]
  const lastSent = new Map([['energy', Date.parse('2026-09-24')], ['rtd', Date.parse('2026-08-01')]])
  const p = planWeekDays(base({ cands, lastSent, prev: 'energy' }))
  is('never worked first, then the longest ago, the day before last',
    p.map(d => d.category), ['electrolytes', 'rtd', 'energy'])
  is('each picked', p.map(d => d.source), ['picked', 'picked', 'picked'])
  is('each fills to 20 with whole brands', p.map(d => d.total), [20, 20, 20])
  is('five 4-person brands a day', p.map(d => d.add.length), [5, 5, 5])
  const ids = p.flatMap(d => d.add.map(a => a.id))
  is('no brand on two days', new Set(ids).size, ids.length)
  is('own-category brands are "day"', p[0].add.every(a => a.from === 'day'), true)
  is('ready count at the time of the pick', p[0].readyNow, 5)
}

{
  // The day before's category is never picked while another can fill.
  const cands = [...fillCat('energy', 10), ...fillCat('rtd', 2)]
  const p = planWeekDays(base({ cands, prev: 'energy', days: [day(DAYS[0])] }))
  is('not the same as the day before, even when it has more', p[0].category, 'rtd')
  is('the short category tops up from the rest', [p[0].add.filter(a => a.from === 'day').length, p[0].total], [2, 20])
  // …unless it is the only one with anybody left.
  const only = planWeekDays(base({ cands: fillCat('energy', 10), prev: 'energy', days: [day(DAYS[0])] }))
  is('the day before only when nothing else can go', only[0].category, 'energy')
  is('and it says so', only[0].repeat, true)
  is('a normal pick is no repeat', p[0].repeat, false)
}

{
  // A category that fills the whole day beats one that fills half, even if
  // the half one was worked longer ago.
  const cands = [...fillCat('rtd', 2), ...fillCat('energy', 6)]
  const lastSent = new Map([['energy', Date.parse('2026-09-20')], ['rtd', Date.parse('2026-01-01')]])
  const p = planWeekDays(base({ cands, lastSent, days: [day(DAYS[0])] }))
  is('fills the day beats least recently worked', p[0].category, 'energy')
  // Two that both fill the day: the one that accepts more.
  const tie = planWeekDays(base({
    cands: [...fillCat('rtd', 5), ...fillCat('energy', 5)],
    rateOf: c => (c === 'rtd' ? 0.4 : 0.1),
    days: [day(DAYS[0])],
  }))
  is('then the one that accepts more', tie[0].category, 'rtd')
}

{
  // Whole brands only: 3 spots left and a 4-person brand is skipped for a
  // 3-person one behind it; nothing is split.
  const cands = [cand('a', 'energy', 17), cand('b', 'energy', 4), cand('c', 'energy', 3)]
  const p = planWeekDays(base({ cands, days: [day(DAYS[0])] }))
  is('skips what does not fit whole', p[0].add.map(a => a.id), ['a', 'c'])
  is('never over the cap', p[0].total, 20)
}

{
  // Related categories come before the rest; the rest by accept rate; no
  // category last. Kept pins take room first.
  const cands = [
    cand('e1', 'electrolytes', 4), cand('n1', 'energy', 4), cand('x1', 'fintech', 4), cand('b1', 'beauty', 4),
    cand('u1', null, 4), cand('r1', 'unresolved', 4),
  ]
  const p = planWeekDays(base({
    cands,
    days: [day(DAYS[0], [{ id: 'pinned', going: 4 }], 'electrolytes')],
    rateOf: c => (c === 'beauty' ? 0.5 : c === 'fintech' ? 0.1 : 0.2),
  }))
  is('Leo’s own category is kept', [p[0].category, p[0].source], ['electrolytes', 'yours'])
  is('kept pins count first', p[0].keptPeople, 4)
  is('order: own, related, better rate, worse rate', p[0].add.map(a => a.id), ['e1', 'n1', 'b1', 'x1'])
  is('from marks', p[0].add.map(a => a.from), ['day', 'related', 'other', 'other'])
  is('total', p[0].total, 20)
  const more = planWeekDays(base({ cands, cap: 40, days: [day(DAYS[0], [], 'electrolytes')], rateOf: () => 0.2 }))
  is('no category and unresolved come last', more[0].add.slice(-2).map(a => a.id).sort(), ['r1', 'u1'])
}

{
  // 'unresolved' and no category are never a day's category.
  const p = planWeekDays(base({ cands: [...fillCat('unresolved', 5), ...fillCat(null, 5, 4, 'none')], days: [day(DAYS[0])] }))
  is('no real category: nothing picked', [p[0].category, p[0].source], [null, 'none'])
  is('but the day still fills', p[0].total, 20)
}

{
  // A full day keeps its pins and gets no category from the plan.
  const p = planWeekDays(base({ cands: fillCat('energy', 5), days: [day(DAYS[0], [{ id: 'k', going: 20 }])] }))
  is('full already', [p[0].source, p[0].category, p[0].add.length], ['full', null, 0])
  const over = planWeekDays(base({ cands: fillCat('energy', 5), days: [day(DAYS[0], [{ id: 'k', going: 23 }], 'rtd')] }))
  is('over by its own pins: nothing added, category kept', [over[0].source, over[0].category, over[0].add.length, over[0].total], ['yours', 'rtd', 0, 23])
}

{
  // Leo's pick in the preview wins; '__pick' lets the plan choose over his.
  const cands = [...fillCat('energy', 5), ...fillCat('rtd', 5)]
  const forced = planWeekDays(base({ cands, forced: { [DAYS[0]]: 'rtd' }, days: [day(DAYS[0], [], 'energy')] }))
  is('asked category', [forced[0].category, forced[0].source], ['rtd', 'asked'])
  const repick = planWeekDays(base({ cands, prev: 'energy', forced: { [DAYS[0]]: '__pick' }, days: [day(DAYS[0], [], 'energy')] }))
  is('__pick overrides his own', [repick[0].category, repick[0].source], ['rtd', 'picked'])
  // A category Leo set on an earlier day counts as used: the next day
  // moves on.
  const chain = planWeekDays(base({ cands, days: [day(DAYS[0], [], 'energy'), day(DAYS[1])] }))
  is('the next day does not repeat his', chain[1].category, 'rtd')
}

{
  // Categories not used earlier in the plan come first: with two days and
  // two fillable categories, both get a day.
  const cands = [...fillCat('energy', 10), ...fillCat('rtd', 10)]
  const p = planWeekDays(base({ cands, days: [day(DAYS[0]), day(DAYS[1]), day(DAYS[2])], prev: 'spirits' }))
  is('rotates across the categories', p.map(d => d.category), ['energy', 'rtd', 'energy'])
  // Energy's second day only has what the first left.
  is('the second energy day uses the brands the first did not', p[2].add.every(a => !p[0].add.some(b => b.id === a.id)), true)
}

{
  // Brands that go out nobody (size 0) are never offered.
  const p = planWeekDays(base({ cands: [cand('z', 'energy', 0), cand('y', 'energy', 3)], days: [day(DAYS[0])] }))
  is('size 0 brands skipped', p[0].add.map(a => a.id), ['y'])
}

console.log(fail ? `plan-week: ${pass} passed, ${fail} FAILED` : `plan-week: all ${pass} passed`)
process.exit(fail ? 1 : 0)
