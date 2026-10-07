// scripts/test-planned-first.mjs — guards src/lib/planned-first.ts (the
// LinkedIn fill works the Schedule's short-on-people brands first).
//
// Pins which days count as due (the plan's last week, what the Schedule
// showed from today on), what "short on people" means (the Schedule's
// Thin / No one reachable), and the order the fill takes them in.
// Compiles the lib on its own, like test-carry.mjs.
// Run: node scripts/test-planned-first.mjs

import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = mkdtempSync(join(tmpdir(), 'planned-first-test-'))
execSync(
  'npx tsc src/lib/planned-first.ts --outDir ' + out +
  ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck',
  { stdio: 'inherit' },
)
// Node's ESM loader needs the .js on relative imports.
writeFileSync(join(out, 'planned-first.js'), readFileSync(join(out, 'planned-first.js'), 'utf8').replace("from './brand-size'", "from './brand-size.js'"))
const { workNeed, shortOnPeople, dueDays, plannedFirst } = await import(pathToFileURL(join(out, 'planned-first.js')).href)

let pass = 0, fail = 0
const is = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return }
  fail++; console.log('✗', label, '— got', JSON.stringify(got), 'want', JSON.stringify(want))
}

// ---- how many a brand works, and short on people -------------------------
is('three by default', workNeed({ tier: 'growth', workPeople: null }), 3)
is('four at an established brand', workNeed({ tier: 'established', workPeople: null }), 4)
is('Leo’s number wins', workNeed({ tier: 'established', workPeople: 1 }), 1)
const P = (n, o = {}) => Array.from({ length: n }, (_, i) => ({ email: null, linkedinUrl: 'https://www.linkedin.com/in/p' + i, ...o }))
is('thin (2 of 3) is short', shortOnPeople({ tier: null, workPeople: null, contacts: P(2) }), true)
is('nobody reachable is short', shortOnPeople({ tier: null, workPeople: null, contacts: P(3, { linkedinUrl: null }) }), true)
is('an email counts as reachable', shortOnPeople({ tier: null, workPeople: null, contacts: P(3, { linkedinUrl: null, email: 'a@b.co' }) }), false)
is('ready (3 of 3) is not short', shortOnPeople({ tier: null, workPeople: null, contacts: P(3) }), false)
is('3 is short at an established brand', shortOnPeople({ tier: 'established', workPeople: null, contacts: P(3) }), true)

// ---- which days count ------------------------------------------------------
{
  const due = dueDays({
    today: '2026-09-29',
    plan: {
      '2026-09-30': { category: 'energy', brandIds: ['a', 'b'] },
      '2026-10-01': { brandIds: ['b', 'c'] },
      '2026-09-25': { brandIds: ['d'] },                 // went by unsent: due now
      '2026-09-10': { brandIds: ['old'] },               // weeks ago: not counted
      'junk': { brandIds: ['x'] },
      '2026-10-06': { brandIds: 'nope' },
    },
    shown: { days: { '2026-09-29': ['e', 'a'], '2026-09-28': ['gone'], '2026-10-01': ['f'] } },
  })
  is('soonest day per brand', Object.fromEntries([...due].sort()), {
    a: '2026-09-29', b: '2026-09-30', c: '2026-10-01', d: '2026-09-25', e: '2026-09-29', f: '2026-10-01',
  })
  is('what the Schedule showed before today does not count', due.has('gone'), false)
  is('a pin weeks old does not count', due.has('old'), false)
}
is('no plan, no snapshot: nothing', dueDays({ today: '2026-09-29', plan: null, shown: null }).size, 0)
is('a broken snapshot is ignored', dueDays({ today: '2026-09-29', plan: {}, shown: { days: 'x' } }).size, 0)

// ---- the order ---------------------------------------------------------------
{
  const items = [
    { brandId: 'z', name: 'Zeta', contacts: 0 },
    { brandId: 'a', name: 'Alpha', contacts: 2 },
    { brandId: 'b', name: 'Bravo', contacts: 1 },
    { brandId: 'c', name: 'Charlie', contacts: 0 },
    { brandId: 'r', name: 'Ready Co', contacts: 5 },
  ]
  const due = new Map([['a', '2026-09-30'], ['b', '2026-09-30'], ['c', '2026-10-01'], ['r', '2026-09-30']])
  const short = new Set(['a', 'b', 'c', 'z'])
  const { first, rest } = plannedFirst(items, due, short)
  is('planned + short first: soonest day, then the emptiest', first.map(i => [i.brandId, i.planned]), [['b', '2026-09-30'], ['a', '2026-09-30'], ['c', '2026-10-01']])
  is('the rest keep their order (a ready planned brand and an unplanned short one included)', rest.map(i => i.brandId), ['z', 'r'])
}

// ---- a big company works ten (Leo, Oct 7 2026) ----------------------------
is('big company: ten', workNeed({ tier: null, workPeople: null, big: true }), 10)
is('big but Leo set 4: his number', workNeed({ tier: 'established', workPeople: 4, big: true }), 4)
is('big: four reachable is short', shortOnPeople({ tier: null, workPeople: null, big: true, contacts: Array.from({ length: 4 }, () => ({ email: null, linkedinUrl: 'x' })) }), true)
is('not big: established still four', workNeed({ tier: 'established', workPeople: null }), 4)

console.log(fail ? `planned-first: ${pass} passed, ${fail} FAILED` : `planned-first: all ${pass} passed`)
process.exit(fail ? 1 : 0)
