// scripts/test-carry.mjs — guards src/lib/carry.ts (Outreach → Schedule:
// unsent work rolls to the next sending day).
//
// The morning roll changes the plan by itself, so its rules are pinned
// here: which past days it looks at, what counts as not sent (a person in
// the day's queue who never went; a pinned or shown brand that sent
// nobody), and what stays put and why (archived, passed that day, planned
// elsewhere, nobody left, day full). Compiles the lib on its own, like
// test-stock.mjs. Run: node scripts/test-carry.mjs

import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = mkdtempSync(join(tmpdir(), 'carry-test-'))
execSync(
  'npx tsc src/lib/carry.ts --outDir ' + out +
  ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck',
  { stdio: 'inherit' },
)
const { rollWindow, findUnsent, planCarry } = await import(pathToFileURL(join(out, 'carry.js')).href)

let pass = 0, fail = 0
const is = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return }
  fail++; console.log('✗', label, '— got', JSON.stringify(got), 'want', JSON.stringify(want))
}

// ---- which days the roll looks at ---------------------------------------
is('first run: the last week', rollWindow('2026-09-26', {}),
  ['2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'])
is('already ran today: nothing', rollWindow('2026-09-26', { day: '2026-09-26', through: '2026-09-25' }), [])
is('since the last day it looked at', rollWindow('2026-09-29', { day: '2026-09-26', through: '2026-09-25' }),
  ['2026-09-26', '2026-09-27', '2026-09-28'])
is('the next morning: just yesterday', rollWindow('2026-09-27', { day: '2026-09-26', through: '2026-09-25' }), ['2026-09-26'])
is('a marker months old: the last week only', rollWindow('2026-12-01', { day: '2026-08-01', through: '2026-07-31' }).length, 7)
is('junk in the marker: the last week', rollWindow('2026-09-26', { day: 'x', through: 42 }).length, 7)

// ---- what counts as not sent ---------------------------------------------
{
  const u = findUnsent({
    days: ['2026-09-25'],
    stamped: [
      { id: 't1', brandId: 'celsius', day: '2026-09-25' },
      { id: 't2', brandId: 'celsius', day: '2026-09-25' },
      { id: 't9', brandId: 'old', day: '2026-09-20' },          // outside the window
    ],
    sent: [{ brandId: 'ghost', day: '2026-09-25' }, { brandId: 'celsius', day: '2026-09-25' }],
    pins: { '2026-09-25': ['ghost', 'poppi'] },
    shown: { day: '2026-09-25', brandIds: ['reign', 'ghost'] },
  })
  is('people in the queue who never went carry, even at a brand that sent someone', u.get('celsius'), { from: '2026-09-25', stamped: ['t1', 't2'] })
  is('a pinned brand that sent nobody carries', u.get('poppi'), { from: '2026-09-25', stamped: [] })
  is('a pinned brand that sent someone that day does not', u.has('ghost'), false)
  is('a brand the rotation showed that day carries', u.get('reign'), { from: '2026-09-25', stamped: [] })
  is('stamps from outside the window are not looked at', u.has('old'), false)
  is('nothing else', [...u.keys()].sort(), ['celsius', 'poppi', 'reign'])
}
{
  const u = findUnsent({
    days: ['2026-09-24', '2026-09-25'],
    stamped: [{ id: 'a', brandId: 'x', day: '2026-09-24' }, { id: 'b', brandId: 'x', day: '2026-09-25' }],
    sent: [{ brandId: 'y', day: '2026-09-24' }],
    pins: { '2026-09-24': ['y'], '2026-09-25': ['y'] },
    shown: { day: '2026-09-23', brandIds: ['z'] },
  })
  is('a brand due on two days: the later day, all its stamps', u.get('x'), { from: '2026-09-25', stamped: ['a', 'b'] })
  is('sent on one day, pinned again the next and not sent: carries from the later day', u.get('y'), { from: '2026-09-25', stamped: [] })
  is('a snapshot of another day is ignored', u.has('z'), false)
}
is('a broken snapshot is ignored', [...findUnsent({ days: ['2026-09-25'], stamped: [], sent: [], pins: {}, shown: { day: 'nope', brandIds: 'x' } }).keys()], [])

// ---- what moves and what stays ---------------------------------------------
{
  const unsent = new Map([
    ['a', { from: '2026-09-25', stamped: ['a1', 'a2'] }],
    ['b', { from: '2026-09-25', stamped: [] }],
    ['c', { from: '2026-09-25', stamped: ['c1'] }],
    ['d', { from: '2026-09-25', stamped: [] }],
    ['e', { from: '2026-09-25', stamped: ['e1'] }],
    ['f', { from: '2026-09-25', stamped: [] }],
    ['g', { from: '2026-09-25', stamped: [] }],
  ])
  const F = (name, o = {}) => ({ name, refusal: null, passedOn: null, pinnedOn: null, people: 3, ...o })
  const facts = new Map([
    ['a', F('Alpha')],
    ['b', F('Bravo', { people: 4 })],
    ['c', F('Charlie', { refusal: 'Archived. Bring it back from its brand page first.' })],
    ['d', F('Delta', { passedOn: '2026-09-25' })],
    ['e', F('Echo', { pinnedOn: '2026-09-30', pinnedLabel: 'Wed Sep 30' })],
    ['f', F('Foxtrot', { people: 0 })],
    ['g', F('Golf', { pinnedOn: '2026-09-29' })],   // already on the target day
  ])
  const r = planCarry(unsent, facts, '2026-09-29', ['g', 'kept'], 40)
  is('moved, with who goes', r.moved, [
    { id: 'a', name: 'Alpha', people: 2, from: '2026-09-25' },
    { id: 'b', name: 'Bravo', people: 4, from: '2026-09-25' },
    { id: 'g', name: 'Golf', people: 3, from: '2026-09-25' },
  ])
  is('stayed, each with why', r.left.map(x => [x.name, x.why]), [
    ['Charlie', 'Archived. Bring it back from its brand page first.'],
    ['Delta', 'Passed that day'],
    ['Echo', 'Planned for Wed Sep 30 already'],
    ['Foxtrot', 'Nobody left to invite'],
  ])
  is('the day keeps what it had and gains the moved, once each', r.dayIds, ['g', 'kept', 'a', 'b'])
  is('unstamp: the moved brands, and one planned elsewhere; not the refused', r.unstamp.sort(), ['a1', 'a2', 'e1'])
}
{
  const unsent = new Map([['a', { from: '2026-09-25', stamped: [] }], ['b', { from: '2026-09-25', stamped: [] }]])
  const facts = new Map([['a', { name: 'A', refusal: null, passedOn: null, pinnedOn: null, people: 3 }], ['b', { name: 'B', refusal: null, passedOn: null, pinnedOn: null, people: 3 }]])
  const r = planCarry(unsent, facts, '2026-09-29', ['x'], 2)
  is('a full day takes what fits', [r.moved.map(m => m.id), r.left.map(x => [x.id, x.why])], [['a'], [['b', 'That day is full']]])
  const passedEarlier = planCarry(new Map([['a', { from: '2026-09-25', stamped: [] }]]),
    new Map([['a', { name: 'A', refusal: null, passedOn: '2026-09-22', pinnedOn: null, people: 2 }]]), '2026-09-29', [], 40)
  is('a Pass on another day does not hold it back', passedEarlier.moved.map(m => m.id), ['a'])
  const unknown = planCarry(new Map([['gone', { from: '2026-09-25', stamped: ['z'] }]]), new Map(), '2026-09-29', [], 40)
  is('a brand deleted since is skipped quietly', [unknown.moved, unknown.left, unknown.unstamp], [[], [], []])
}

console.log(fail ? `carry: ${pass} passed, ${fail} FAILED` : `carry: all ${pass} passed`)
process.exit(fail ? 1 : 0)
