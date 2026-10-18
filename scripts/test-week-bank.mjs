// scripts/test-week-bank.mjs — guards src/lib/week-bank.ts (Outreach →
// Week plan: the list of ~100 brands and how it is dealt onto the week).
//
// Pinned here: the list holds Leo's hand adds plus the best Brand Fit picks
// up to its number, never a brand he took off; a brand added by hand leaves
// once something goes out to it; the weeks offered; each day's room under
// LinkedIn's week; and the deal — whole brands, an even mix of rank, a day
// never past its room, one big company a day, the same seed the same deal.
// Run: node scripts/test-week-bank.mjs

import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = mkdtempSync(join(tmpdir(), 'week-bank-test-'))
execSync(
  'npx tsc src/lib/week-bank.ts --outDir ' + out +
  ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck',
  { stdio: 'inherit' },
)
// Node wants the extension on a relative import; tsc leaves it off.
for (const f of readdirSync(out).filter(f => f.endsWith('.js'))) {
  const p = join(out, f)
  writeFileSync(p, readFileSync(p, 'utf8').replace(/from '(\.\/[^']+)'/g, "from '$1.js'"))
}
const W = await import(pathToFileURL(join(out, 'week-bank.js')).href)

let pass = 0, fail = 0
const is = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return }
  fail++; console.log('✗', label, '— got', JSON.stringify(got), 'want', JSON.stringify(want))
}

// ---- the number --------------------------------------------------------
is('default 100', W.bankSize(undefined), 100)
is('clamped low', W.bankSize(3), W.BANK_SIZE_MIN)
is('clamped high', W.bankSize(5000), W.BANK_SIZE_MAX)
is('rounded', W.bankSize('42.4'), 42)
is('clean of nothing', W.cleanBank(null), { size: 100, hand: [], removed: {} })
is('clean drops a dupe hand row and a removed hand id', W.cleanBank({ size: 50, hand: [{ id: 'a', at: 't1' }, { id: 'a', at: 't2' }, { id: 'b', at: 't3' }], removed: { a: 'x', c: 'y' } }),
  { size: 50, hand: [{ id: 'a', at: 't1' }, { id: 'b', at: 't3' }], removed: { c: 'y' } })

// ---- the list ------------------------------------------------------------
{
  const cand = (id, fit, auto = true, ready = true) => ({ id, name: id.toUpperCase(), fit, ready, auto })
  const cands = [cand('a', 90), cand('b', 80), cand('c', 70), cand('d', 60), cand('e', 50), cand('h', 20, false)]
  let st = { size: 3, hand: [], removed: {} }
  is('top 3 by Brand Fit', W.composeBank(cands, st).list.map(x => x.id), ['a', 'b', 'c'])
  is('two more wait past the number', W.composeBank(cands, st).autoLeft, 2)
  st = W.addToBank(st, ['h'], '2026-10-18T10:00:00Z').state
  const withHand = W.composeBank(cands, st)
  is('a hand add counts toward the number and sits by its fit', withHand.list.map(x => [x.id, x.how]), [['a', 'auto'], ['b', 'auto'], ['h', 'hand']])
  st = W.removeFromBank(st, ['a'], '2026-10-18T11:00:00Z')
  is('taken off: never back by itself, the next one comes in', W.composeBank(cands, st).list.map(x => x.id), ['b', 'c', 'h'])
  st = W.removeFromBank(st, ['h'], '2026-10-18T11:00:00Z')
  is('a hand add taken off leaves the hand list', st.hand.length, 0)
  is('…and is remembered as taken off', 'h' in st.removed, true)
  st = W.putBack(st, ['a'])
  is('put back', W.composeBank(cands, st).list.map(x => x.id), ['a', 'b', 'c'])
  const re = W.addToBank(st, ['h', 'h'], 'now')
  is('adding again clears the taken-off mark, once', [re.added, 'h' in re.state.removed], [['h'], false])
  is('more hand adds than the number: just those', W.composeBank(cands, { size: 1, hand: [{ id: 'b', at: 'x' }, { id: 'c', at: 'x' }], removed: {} }).list.map(x => x.id), ['b', 'c'])
  is('a tie: ready first, then the name', W.composeBank([cand('z', 50, true, true), cand('y', 50, true, false), cand('x', 50, true, true)], { size: 10, hand: [], removed: {} }).list.map(x => x.id), ['x', 'z', 'y'])
}

// ---- a hand add is spent ---------------------------------------------------
is('nothing out since: stays', W.handSpent('2026-10-18T10:00:00Z', null), false)
is('went out before it was added (resting): stays', W.handSpent('2026-10-18T10:00:00Z', '2026-10-10T10:00:00Z'), false)
is('went out after: spent', W.handSpent('2026-10-18T10:00:00Z', '2026-10-20T15:00:00Z'), true)

// ---- the week ----------------------------------------------------------------
{
  const tueWedThu = k => [2, 3, 4].includes(new Date(k + 'T12:00:00Z').getUTCDay())
  is('Monday of a Sunday', W.weekStart('2026-10-18'), '2026-10-12')
  is('Monday of a Wednesday', W.weekStart('2026-10-21'), '2026-10-19')
  is('Monday of a Monday', W.weekStart('2026-10-19'), '2026-10-19')
  // Sunday Oct 18: this week (Oct 12–18) has nothing left; next week does.
  is('on a Sunday: only next week', W.planWeeks('2026-10-18', tueWedThu).map(w => [w.which, w.days]),
    [['next', ['2026-10-20', '2026-10-21', '2026-10-22']]])
  // Monday Oct 19: this week is Tue–Thu.
  is('on a Monday: this week and next', W.planWeeks('2026-10-19', tueWedThu).map(w => [w.which, w.days.length, w.start]),
    [['this', 3, '2026-10-19'], ['next', 3, '2026-10-26']])
  // Wednesday: this week is Thursday only (today is never in it).
  is('on a Wednesday: Thursday only', W.planWeeks('2026-10-21', tueWedThu)[0].days, ['2026-10-22'])
  // A day opened (an extra Friday) and one taken off.
  const custom = k => k === '2026-10-23' || (tueWedThu(k) && k !== '2026-10-21')
  is('extra Friday in, Wednesday off', W.planWeeks('2026-10-19', custom)[0].days, ['2026-10-20', '2026-10-22', '2026-10-23'])

  // Rooms: 30 a day, LinkedIn's 100 over seven days.
  const rooms = W.weekRooms([{ date: '2026-10-20', kept: 0 }, { date: '2026-10-21', kept: 8 }, { date: '2026-10-22', kept: 0 }], new Map(), 30)
  is('a clear week: 30 / 22 / 30', rooms.map(r => [r.cap, r.room]), [[30, 30], [30, 22], [30, 30]])
  const heavy = W.weekRooms(['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'].map(date => ({ date, kept: 0 })), new Map(), 30)
  is('an extra Friday after a full Tue–Thu takes what LinkedIn’s week leaves', heavy.map(r => r.room), [30, 30, 30, 10])
  const late = W.weekRooms([{ date: '2026-10-20', kept: 0 }], new Map([['2026-10-15', 30], ['2026-10-16', 25], ['2026-10-14', 30]]), 30)
  is('last week still in Tuesday’s window', late[0].room, 15)
  is('pins past the day’s cap: no room', W.weekRooms([{ date: '2026-10-20', kept: 34 }], new Map(), 30)[0].room, 0)
}

// ---- dealing -------------------------------------------------------------------
{
  const days = [{ date: 'tue', room: 30, bigs: 0 }, { date: 'wed', room: 30, bigs: 0 }, { date: 'thu', room: 30, bigs: 0 }]
  const brands = Array.from({ length: 30 }, (_, i) => ({ id: 'b' + (i + 1), size: 3 + (i % 2), big: false }))
  const r = W.spreadWeek(days, brands, W.seeded(7))
  const where = id => Object.keys(r.put).find(k => r.put[k].includes(id))
  is('#1–#3 on three different days', new Set(['b1', 'b2', 'b3'].map(where)).size, 3)
  is('#4–#6 on three different days', new Set(['b4', 'b5', 'b6'].map(where)).size, 3)
  const sizeOf = id => brands.find(b => b.id === id).size
  const people = k => r.put[k].reduce((n, id) => n + sizeOf(id), 0)
  is('no day past its 30', ['tue', 'wed', 'thu'].every(k => people(k) <= 30), true)
  is('every brand on one day at most', Object.values(r.put).flat().length, new Set(Object.values(r.put).flat()).size)
  is('placed + left = all', Object.values(r.put).flat().length + r.left.length, 30)
  is('a day keeps the list’s order', r.put.tue.every((id, i, a) => i === 0 || Number(id.slice(1)) > Number(a[i - 1].slice(1))), true)
  is('the same seed deals the same', JSON.stringify(W.spreadWeek(days, brands, W.seeded(7)).put), JSON.stringify(r.put))
  const other = [1, 2, 3, 4, 5, 6, 8, 9].some(s => JSON.stringify(W.spreadWeek(days, brands, W.seeded(s)).put) !== JSON.stringify(r.put))
  is('another seed can deal differently', other, true)
  // The top brands always go: the first ~20 fit easily in 90 spots.
  is('the top 18 all go', brands.slice(0, 18).every(b => !!where(b.id)), true)
}
{
  // A big company: one a day; a second waits for a day without one.
  const days = [{ date: 'tue', room: 30, bigs: 1 }, { date: 'wed', room: 30, bigs: 0 }]
  const brands = [{ id: 'big1', size: 10, big: true }, { id: 'big2', size: 10, big: true }, { id: 's', size: 3, big: false }]
  const r = W.spreadWeek(days, brands, W.seeded(1))
  is('the first big goes to the day without one', r.put.wed.includes('big1'), true)
  is('the second big waits (both days hold one)', r.left, [{ id: 'big2', why: 'big' }])
  is('a small one still goes', Object.values(r.put).flat().includes('s'), true)
}
{
  // Too big for every room left: passed over, a smaller one still fills.
  const days = [{ date: 'tue', room: 5, bigs: 0 }]
  const r = W.spreadWeek(days, [{ id: 'a', size: 4, big: false }, { id: 'b', size: 4, big: false }, { id: 'c', size: 1, big: false }, { id: 'z', size: 0, big: false }], W.seeded(3))
  is('whole brands only', r.put.tue, ['a', 'c'])
  is('why the rest wait', r.left, [{ id: 'b', why: 'nofit' }, { id: 'z', why: 'nobody' }])
}
{
  // A day with less room drops out; the others carry on.
  const days = [{ date: 'tue', room: 6, bigs: 0 }, { date: 'wed', room: 30, bigs: 0 }]
  const brands = Array.from({ length: 6 }, (_, i) => ({ id: 'x' + i, size: 3, big: false }))
  const r = W.spreadWeek(days, brands, W.seeded(11))
  is('tue takes 2, wed the rest', [r.put.tue.length, r.put.wed.length], [2, 4])
}
is('seeded is in [0, 1)', Array.from({ length: 50 }, (_, i) => W.seeded(i)()).every(x => x >= 0 && x < 1), true)

console.log(fail ? `\n${fail} failed, ${pass} passed` : `week-bank: all ${pass} passed`)
process.exit(fail ? 1 : 0)
