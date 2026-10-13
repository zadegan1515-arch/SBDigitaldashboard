// scripts/test-carry.mjs — guards src/lib/carry.ts (Outreach → Schedule:
// unsent work rolls to the next sending day).
//
// The morning roll changes the plan by itself, so its rules are pinned
// here: which past days it looks at, what counts as not sent (a person in
// the day's queue who never went; a pinned or shown brand that sent
// nobody), and what stays put and why (archived, passed that day or inside
// a Pass's two weeks, planned elsewhere, nobody left, day full), and that a
// part-sent brand's rest moves to the next sending day only — and where
// the moved ones land on the new day (carry-front: half-sent first, then
// the brands planned on the day they missed, then the day's own pins, then
// what was only shown). Compiles the lib with queue-rules.ts.
// Run: node scripts/test-carry.mjs

import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// carry.ts, and queue-rules.ts for the part-sent case (the roll asks the
// queue rules whether a brand may move; route.ts carryBrands).
const out = mkdtempSync(join(tmpdir(), 'carry-test-'))
execSync(
  'npx tsc src/lib/carry.ts src/lib/queue-rules.ts --outDir ' + out +
  ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck',
  { stdio: 'inherit' },
)
// Node wants the extension on a relative import; tsc leaves it off.
for (const f of readdirSync(out).filter(f => f.endsWith('.js'))) {
  const p = join(out, f)
  writeFileSync(p, readFileSync(p, 'utf8').replace(/from '(\.\/[^']+)'/g, "from '$1.js'"))
}
const { rollWindow, findUnsent, planCarry, carryOrder, carryTimes } = await import(pathToFileURL(join(out, 'carry.js')).href)
const { queueGate } = await import(pathToFileURL(join(out, 'queue-rules.js')).href)

let pass = 0, fail = 0
const is = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return }
  fail++; console.log('✗', label, '— got', JSON.stringify(got), 'want', JSON.stringify(want))
}
// What moved and which day it missed (the tier is checked on its own below).
const fs = u => u && { from: u.from, stamped: u.stamped }

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
  is('people in the queue who never went carry, even at a brand that sent someone', fs(u.get('celsius')), { from: '2026-09-25', stamped: ['t1', 't2'] })
  is('a pinned brand that sent nobody carries', fs(u.get('poppi')), { from: '2026-09-25', stamped: [] })
  is('a pinned brand that sent someone that day does not', u.has('ghost'), false)
  is('a brand the rotation showed that day carries', fs(u.get('reign')), { from: '2026-09-25', stamped: [] })
  is('tiers: half-sent 0, pinned 1 (its place on the day), only shown 3',
    [u.get('celsius').tier, u.get('poppi').tier, u.get('poppi').at, u.get('reign').tier], [0, 1, 1, 3])
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
  is('a brand due on two days: the later day, all its stamps', fs(u.get('x')), { from: '2026-09-25', stamped: ['a', 'b'] })
  is('sent on one day, pinned again the next and not sent: carries from the later day', fs(u.get('y')), { from: '2026-09-25', stamped: [] })
  is('stamped with no fill log: queued by hand, tier 1', u.get('x').tier, 1)
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
    { id: 'a', name: 'Alpha', people: 2, from: '2026-09-25', tier: 1 },
    { id: 'b', name: 'Bravo', people: 4, from: '2026-09-25', tier: 1 },
    { id: 'g', name: 'Golf', people: 3, from: '2026-09-25', tier: 1 },
  ])
  is('stayed, each with why', r.left.map(x => [x.name, x.why]), [
    ['Charlie', 'Archived. Bring it back from its brand page first.'],
    ['Delta', 'Passed that day'],
    ['Echo', 'Planned for Wed Sep 30 already'],
    ['Foxtrot', 'Nobody left to invite'],
  ])
  // Carried pins go ahead of the day's own (carry-front); Golf was on the
  // day already and keeps its place among the day's own.
  is('the day keeps what it had and gains the moved, once each — carried first', r.dayIds, ['a', 'b', 'g', 'kept'])
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

// ---- a Pass holds for its two weeks (Leo, Oct 7 2026) ------------------------
{
  const unsent = new Map([['p', { from: '2026-10-07', stamped: [] }], ['q', { from: '2026-10-07', stamped: [] }]])
  const F = (name, o = {}) => ({ name, refusal: null, passedOn: '2026-10-06', pinnedOn: null, people: 3, ...o })
  const facts = new Map([
    ['p', F('Passed Co', { passedUntil: '2026-10-20', passedUntilLabel: 'Tue Oct 20' })],
    ['q', F('Pass Over Co', { passedUntil: '2026-10-07' })],
  ])
  const r = planCarry(unsent, facts, '2026-10-08', [], 40)
  is('passed on another day, shown since: stays out while the Pass runs', r.left.map(x => [x.id, x.why]), [['p', 'Passed until Tue Oct 20']])
  is('a Pass that ended before the day: it moves', r.moved.map(m => m.id), ['q'])
  const onLast = planCarry(new Map([['p', { from: '2026-10-07', stamped: [] }]]),
    new Map([['p', F('Passed Co', { passedUntil: '2026-10-20' })]]), '2026-10-20', [], 40)
  is('its last day is still passed', onLast.moved.length, 0)
}

// ---- part-sent: the rest go out on the next sending day, then it rests -------
// Leo, Oct 12 2026: "If Zach sends only some of a brand's people one day, the
// rest go out on the next sending day". Mirrors route.ts carryBrands: the
// refusal is the queue rules' answer for a hand path, as of the day it moves to.
{
  const next = (key) => {
    for (let k = 1; k < 30; k++) {
      const d = new Date(new Date(key + 'T12:00:00Z').getTime() + k * 864e5).toISOString().slice(0, 10)
      if ([2, 3, 4].includes(new Date(d + 'T12:00:00Z').getUTCDay())) return d
    }
    return null
  }
  const at = day => new Date(day + 'T15:00:00Z')
  // Tue Oct 13: two of four sent, two stamped and never sent.
  const rows = [
    { id: 's1', status: 'sent', sentAt: at('2026-10-13') }, { id: 's2', status: 'sent', sentAt: at('2026-10-13') },
    { id: 'w1', status: 'drafted', sentAt: null }, { id: 'w2', status: 'drafted', sentAt: null },
  ]
  const unsent = findUnsent({
    days: ['2026-10-13'],
    stamped: [{ id: 'w1', brandId: 'acme', day: '2026-10-13' }, { id: 'w2', brandId: 'acme', day: '2026-10-13' }],
    sent: [{ brandId: 'acme', day: '2026-10-13' }, { brandId: 'acme', day: '2026-10-13' }],
    pins: {}, shown: null,
  })
  is('half-sent: its unsent people carry, first', [fs(unsent.get('acme')), unsent.get('acme').tier], [{ from: '2026-10-13', stamped: ['w1', 'w2'] }, 0])
  const factsFor = (to) => {
    const g = queueGate({ name: 'Acme', rows }, { auto: false, giantsOn: false, day: to, nextSending: next })
    return new Map([['acme', { name: 'Acme', refusal: g ? g.reason + (g.until ? ' until ' + g.until : '') : null, passedOn: null, pinnedOn: null, people: 0 }]])
  }
  const wed = planCarry(unsent, factsFor('2026-10-14'), '2026-10-14', [], 40)
  is('the next sending day: it moves, the same two people, half-sent', [wed.moved, wed.unstamp], [[{ id: 'acme', name: 'Acme', people: 2, from: '2026-10-13', tier: 0 }], ['w1', 'w2']])
  const thu = planCarry(unsent, factsFor('2026-10-15'), '2026-10-15', [], 40)
  is('a day later (Wednesday missed): it stays, resting two weeks', [thu.moved.length, thu.left.map(x => x.why)], [0, ['resting until 2026-10-27']])
}

// ---- carry-front: carried brands go first (Leo's call, Oct 12 2026) ---------
// The day's 30 is charged in plan order (route.ts waitingOnDay), mirrored
// here so the cases read as what the Schedule would show.
const waitsOn = (order, size, cap = 30) => {
  const out = []
  let used = 0
  for (const id of order) {
    const n = size[id] ?? 0
    if (n <= 0) continue
    if (used + n > cap) out.push(id)
    else used += n
  }
  return out
}
{
  // Who the fill queued vs who Leo queued by hand, and the plan's order.
  const u = findUnsent({
    days: ['2026-10-13'],
    stamped: [
      { id: 'f1', brandId: 'fillco', day: '2026-10-13' },
      { id: 'h1', brandId: 'handco', day: '2026-10-13' },
      { id: 'p1', brandId: 'pin2', day: '2026-10-13' },
    ],
    sent: [],
    pins: { '2026-10-13': ['pin1', 'pin2'] },
    shown: { day: '2026-10-13', brandIds: ['shownco'] },
    auto: { '2026-10-13': ['fillco'] },
  })
  is('tiers: pinned by its place, by hand 1, the fill 3, shown 3',
    ['pin1', 'pin2', 'handco', 'fillco', 'shownco'].map(id => [id, u.get(id).tier]),
    [['pin1', 1], ['pin2', 1], ['handco', 1], ['fillco', 3], ['shownco', 3]])
  is('a pin keeps its place on the day it missed', [u.get('pin1').at, u.get('pin2').at], [0, 1])
}
{
  // A full Wednesday (Leo's own three 10-person pins) and a carried pin of
  // Tuesday's: the carried brand goes, Wednesday's last one waits instead.
  const F = (name, people) => ({ name, refusal: null, passedOn: null, pinnedOn: null, people })
  const r = planCarry(new Map([['tue', { from: '2026-10-13', stamped: [], tier: 1, at: 0 }]]),
    new Map([['tue', F('Tuesday Co', 10)]]), '2026-10-14', ['w1', 'w2', 'w3'], 40)
  is('a carried pin goes before a full day\'s own', r.dayIds, ['tue', 'w1', 'w2', 'w3'])
  is('…so the day\'s last brand is the one that waits', waitsOn(r.dayIds, { tue: 10, w1: 10, w2: 10, w3: 10 }), ['w3'])
}
{
  const F = (name) => ({ name, refusal: null, passedOn: null, pinnedOn: null, people: 3 })
  const unsent = new Map([
    ['pinned', { from: '2026-10-13', stamped: [], tier: 1, at: 0 }],
    ['half', { from: '2026-10-13', stamped: ['h1'], tier: 0, at: 1e6 }],
    ['shown', { from: '2026-10-13', stamped: [], tier: 3, at: 1e6 + 1 }],
  ])
  const facts = new Map([['pinned', F('Pinned')], ['half', F('Half')], ['shown', F('Shown')]])
  const r = planCarry(unsent, facts, '2026-10-14', ['own1', 'own2'], 40)
  is('half-sent first, then the carried pin, the day\'s own, then what was only shown',
    r.dayIds, ['half', 'pinned', 'own1', 'own2', 'shown'])
  const full = planCarry(unsent, facts, '2026-10-14', ['own1', 'own2'], 4)
  is('a day near its brand limit: the shown one is left, not the half-sent', [full.moved.map(m => m.id), full.left.map(x => x.id)], [['half', 'pinned'], ['shown']])
  // Two missed days: the older one first, then each day's own order.
  const two = planCarry(new Map([
    ['b2', { from: '2026-10-08', stamped: [], tier: 1, at: 1 }],
    ['newer', { from: '2026-10-13', stamped: [], tier: 1, at: 0 }],
    ['b1', { from: '2026-10-08', stamped: [], tier: 1, at: 0 }],
  ]), new Map([['b1', F('B1')], ['b2', F('B2')], ['newer', F('Newer')]]), '2026-10-14', [], 40)
  is('carried pins: the day they missed, then their place on it', two.dayIds, ['b1', 'b2', 'newer'])
}
is('carryOrder: a half-sent brand already on the day still goes first',
  carryOrder(['own', 'half'], [{ id: 'half', tier: 0 }]), ['half', 'own'])
is('carryOrder: no tier reads as a carried pin', carryOrder(['own'], [{ id: 'c' }]), ['c', 'own'])
{
  const prev = { to: '2026-10-14', brands: [{ id: 'a', from: '2026-10-13', since: '2026-10-08', times: 2 }, { id: 'b', from: '2026-10-13' }] }
  const t = carryTimes(prev, [{ id: 'a', from: '2026-10-14' }, { id: 'b', from: '2026-10-14' }, { id: 'c', from: '2026-10-14' }])
  is('rolled again from the day it was moved to: one more time, same first day', t.get('a'), { since: '2026-10-08', times: 3 })
  is('an old log without since: its from day', t.get('b'), { since: '2026-10-13', times: 2 })
  is('new to the roll: once', t.get('c'), { since: '2026-10-14', times: 1 })
  is('a log from another day does not count', carryTimes({ to: '2026-10-01', brands: [{ id: 'a', from: '2026-09-30' }] }, [{ id: 'a', from: '2026-10-14' }]).get('a'), { since: '2026-10-14', times: 1 })
}

console.log(fail ? `carry: ${pass} passed, ${fail} FAILED` : `carry: all ${pass} passed`)
process.exit(fail ? 1 : 0)
