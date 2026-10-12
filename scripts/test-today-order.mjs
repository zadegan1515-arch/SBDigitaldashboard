// scripts/test-today-order.mjs — guards src/lib/today-order.ts: one order
// for today's LinkedIn list (Outreach → LinkedIn, Today's list for Zach,
// the Schedule's today column). Leo's planned brands in his order, then
// brands added by hand (newest first), then the automatic fill's brands in
// the order it took them (best first); best fit first inside a brand. A
// reload used to list the fill worst-first.
// Run: node scripts/test-today-order.mjs

import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = mkdtempSync(join(tmpdir(), 'today-order-test-'))
execSync(
  'npx tsc src/lib/today-order.ts --outDir ' + out +
  ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck',
  { stdio: 'inherit' },
)
const { compareTodayBrands, sortToday } = await import(pathToFileURL(join(out, 'today-order.js')).href)

let pass = 0, fail = 0
const is = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return }
  fail++; console.log('✗', label, '— got', JSON.stringify(got), 'want', JSON.stringify(want))
}

const o = {
  planIds: ['p2', 'p1'],
  autoIds: ['best', 'good', 'ok'],
  newest: new Map([['h1', 1000], ['h2', 2000], ['best', 5000], ['ok', 9000]]),
}
const row = (brandId, fitScore, id, createdAt = '2026-10-01') => ({ id, brandId, fitScore, createdAt })
// Shuffled the way a reload reads them (newest stamp first).
const rows = [
  row('ok', 50, 'ok-a'), row('h1', 40, 'h1-a'), row('good', 70, 'good-a'), row('p1', 10, 'p1-a'),
  row('best', 60, 'best-a'), row('h2', 30, 'h2-a'), row('p2', 20, 'p2-a'), row('best', 90, 'best-b'),
  row('p2', 80, 'p2-b'), row('good', 70, 'good-b', '2026-09-01'),
]
is('planned in Leo\'s order, then hand-adds newest first, then the fill best first',
  sortToday(rows, o).map(t => t.id),
  ['p2-b', 'p2-a', 'p1-a', 'h2-a', 'h1-a', 'best-b', 'best-a', 'good-b', 'good-a', 'ok-a'])
is('the same order whatever order they come in', sortToday(rows.slice().reverse(), o).map(t => t.id), sortToday(rows, o).map(t => t.id))
is('a planned brand the fill also took is planned', compareTodayBrands({ ...o, autoIds: ['p1', 'best'] })('p1', 'h2') < 0, true)
const cmp = compareTodayBrands(o)
is('two hand-adds with the same stamp never tie (a brand stays together)', [cmp('x', 'y') !== 0, cmp('x', 'x')], [true, 0])
is('nothing planned, no fill: hand-adds newest first', sortToday([row('h1', 1, 'a'), row('h2', 1, 'b')], { planIds: [], autoIds: [], newest: o.newest }).map(t => t.id), ['b', 'a'])

console.log(fail ? `today-order: ${pass} passed, ${fail} FAILED` : `today-order: all ${pass} passed`)
process.exit(fail ? 1 : 0)
