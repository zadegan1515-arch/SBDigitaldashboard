// scripts/test-skip-day.mjs — guards src/lib/skip-day.ts: moving or
// cancelling a whole future sending day (skip-day; Thanksgiving, Dec 24 and
// Dec 31 are Thursdays in 2026).
//
// Pins: the stored days are read today on, malformed ones dropped; onto a
// day with nothing planned the whole plan moves (category and brands), onto
// a planned day the brands go at the end and the moved day's category stays
// behind; Undo brings back what's still where the move put it (or pinned
// nowhere now), leaves what Leo moved since, puts the target's category
// back only if nobody changed it, and closes a day the move opened when
// nothing is left on it. Compiles the lib like test-queue-rules.mjs.
// Run: node scripts/test-skip-day.mjs

import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = mkdtempSync(join(tmpdir(), 'skip-day-test-'))
execSync(
  'npx tsc src/lib/skip-day.ts --outDir ' + out +
  ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck',
  { stdio: 'inherit' },
)
for (const f of readdirSync(out).filter(f => f.endsWith('.js'))) {
  const p = join(out, f)
  writeFileSync(p, readFileSync(p, 'utf8').replace(/from '(\.\/[^']+)'/g, "from '$1.js'"))
}
const { parseSkipDays, dayMoveShape, undoDayMove } = await import(pathToFileURL(join(out, 'skip-day.js')).href)

let pass = 0, fail = 0
const is = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return }
  fail++; console.log('✗', label, '— got', JSON.stringify(got), 'want', JSON.stringify(want))
}

const TODAY = '2026-11-20'
const log = (o = {}) => ({
  at: '2026-11-20T15:00:00Z', by: null, to: '2026-11-25', wasExtra: false, opened: false,
  pins: [], category: null, moved: [], toCategory: null, ...o,
})

// ---- the stored days --------------------------------------------------------
{
  const m = parseSkipDays({
    '2026-11-26': log({ pins: ['a', 'b'], moved: ['a'], category: 'energy' }),
    '2026-11-19': log(), // gone
    'nope': log(),
    '2026-12-24': { to: 'bad', pins: 'x', wasExtra: 'yes' },
  }, TODAY)
  is('past and malformed keys are dropped', [...m.keys()], ['2026-11-26', '2026-12-24'])
  is('a log reads back whole', m.get('2026-11-26').pins, ['a', 'b'])
  is('a bad target reads as none, bad lists as empty', [m.get('2026-12-24').to, m.get('2026-12-24').pins, m.get('2026-12-24').wasExtra], [null, [], false])
  is('nothing stored', parseSkipDays(null, TODAY).size, 0)
  is('an array is not a map', parseSkipDays(['2026-11-26'], TODAY).size, 0)
}

// ---- how the plan lands -----------------------------------------------------
is('onto an empty day: the whole plan, category too',
  dayMoveShape({ category: 'energy', brandIds: ['a'] }, undefined), { whole: true, category: 'energy', categoryLost: null })
is('a day with an empty entry counts as empty',
  dayMoveShape({ category: 'energy', brandIds: ['a'] }, { category: null, brandIds: [] }), { whole: true, category: 'energy', categoryLost: null })
is('onto a planned day: its own category stays, the moved one is named',
  dayMoveShape({ category: 'energy', brandIds: ['a'] }, { category: 'spirits', brandIds: ['x'] }), { whole: false, category: 'spirits', categoryLost: 'energy' })
is('onto a day with only a category: not empty',
  dayMoveShape({ category: null, brandIds: ['a'] }, { category: 'spirits', brandIds: [] }), { whole: false, category: 'spirits', categoryLost: null })
is('same category: nothing lost',
  dayMoveShape({ category: 'spirits', brandIds: ['a'] }, { category: 'spirits', brandIds: ['x'] }).categoryLost, null)

// ---- Undo ---------------------------------------------------------------------
{
  // Thu Nov 26 (Energy: a, b, c) moved to Wed Nov 25, which was empty: a and
  // b landed, c was refused there (back to waiting).
  const l = log({ pins: ['a', 'b', 'c'], category: 'energy', moved: ['a', 'b'], toCategory: { before: null, after: 'energy' } })
  const plan = { '2026-11-25': { category: 'energy', brandIds: ['a', 'b'] } }
  const r = undoDayMove(plan, '2026-11-26', l)
  is('everything comes back in the old order', r.plan['2026-11-26'], { category: 'energy', brandIds: ['a', 'b', 'c'] })
  is('the target empties and its category goes back', r.plan['2026-11-25'], undefined)
  is('back / stay / category', [r.back, r.stay, r.categoryBack], [['a', 'b', 'c'], [], true])
  is('the input plan is not changed', plan['2026-11-25'].brandIds, ['a', 'b'])
}
{
  // Since the move Leo moved b to Fri, took a off Wed by hand, pinned c on
  // Mon, added x to Wed and changed Wed's category.
  const l = log({ pins: ['a', 'b', 'c', 'd'], category: 'energy', moved: ['a', 'b', 'd'], toCategory: { before: null, after: 'energy' } })
  const plan = {
    '2026-11-25': { category: 'spirits', brandIds: ['x', 'd'] },
    '2026-11-27': { category: null, brandIds: ['b'] },
    '2026-11-30': { category: null, brandIds: ['c'] },
  }
  const r = undoDayMove(plan, '2026-11-26', l)
  is('only what is still where the move put it comes back', r.back, ['d'])
  is('what Leo moved stays, named with its day', r.stay, [{ id: 'a', on: null }, { id: 'b', on: '2026-11-27' }, { id: 'c', on: '2026-11-30' }])
  is('a category Leo changed stays', [r.plan['2026-11-25'], r.categoryBack], [{ category: 'spirits', brandIds: ['x'] }, false])
  is('the day comes back with its category', r.plan['2026-11-26'], { category: 'energy', brandIds: ['d'] })
}
{
  // Taken off with no target: its brands went back to waiting.
  const l = log({ to: null, pins: ['a', 'b'], category: null, moved: [] })
  const r = undoDayMove({ '2026-11-30': { category: null, brandIds: ['b'] } }, '2026-11-26', l)
  is('no target: the ones pinned nowhere come back', [r.back, r.stay.map(x => x.id)], [['a'], ['b']])
  is('no target, nothing to close', r.closeTo, false)
}
{
  // Moved onto a Friday the move opened: Undo closes it once it's empty …
  const l = log({ to: '2026-11-27', opened: true, pins: ['a'], moved: ['a'] })
  let r = undoDayMove({ '2026-11-27': { category: null, brandIds: ['a'] } }, '2026-11-26', l)
  is('an opened day with nothing left closes', [r.closeTo, r.plan['2026-11-27']], [true, undefined])
  // … but not while Leo put something else there.
  r = undoDayMove({ '2026-11-27': { category: null, brandIds: ['a', 'z'] } }, '2026-11-26', l)
  is('an opened day Leo used stays open', [r.closeTo, r.plan['2026-11-27']], [false, { category: null, brandIds: ['z'] }])
  // A day that had nothing planned and no category: no empty entry is made.
  r = undoDayMove({}, '2026-11-26', log({ to: '2026-11-27', opened: true }))
  is('nothing planned: no entry, the opened day closes', [r.plan['2026-11-26'], r.closeTo], [undefined, true])
}

{
  // The target has become today and b already sent someone there: b stays
  // on it (a brand that went out today is never taken off it), a comes back.
  const l = log({ to: '2026-11-25', pins: ['a', 'b'], moved: ['a', 'b'] })
  const r = undoDayMove({ '2026-11-25': { category: null, brandIds: ['a', 'b'] } }, '2026-11-26', l, { keep: new Set(['b']) })
  is('keep: a brand that sent on the target stays there', [r.back, r.stay, r.plan['2026-11-25'], r.plan['2026-11-26']],
    [['a'], [{ id: 'b', on: '2026-11-25' }], { category: null, brandIds: ['b'] }, { category: null, brandIds: ['a'] }])
}
// The history (sitting-history): route.ts reads from a few weeks back for
// the days a part-sent brand's sitting is judged by.
is('read from further back, a day gone by is kept',
  [...parseSkipDays({ '2026-11-19': log(), '2026-10-01': log() }, '2026-11-01').keys()], ['2026-11-19'])

console.log(`${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
