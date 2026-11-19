// node scripts/test-claude-hunt.mjs — the daily brand hunt's rules.
import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const out = mkdtempSync(join(tmpdir(), 'hunt-test-'))
execSync('npx tsc src/lib/claude-hunt.ts --outDir ' + out + ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck', { stdio: 'inherit' })
for (const f of readdirSync(out).filter(f => f.endsWith('.js'))) {
  const p = join(out, f)
  writeFileSync(p, readFileSync(p, 'utf8').replace(/from '(\.\/[^']+)'/g, "from '$1.js'"))
}
const { judgeHuntRow, knownKeys, HUNT_LANES, HUNT_SOURCES, huntLabel, huntLanes } = await import(pathToFileURL(join(out, 'claude-hunt.js')).href)

let n = 0
function t(name, fn) { fn(); n++; console.log('  ok — ' + name) }

const good = { name: 'Nova Fizz', category: 'energy', signals: ['genz', 'midsize'], website: 'novafizz.com', reason: 'r', activation: 'a' }

// Leo, Nov 18 2026: the hunt searches his Top categories — it was Stock
// take's seven lanes, which still had clothing and athletic (Low).
t('the hunt searches Leo\'s Top categories — never clothing or athletic by default', () => {
  assert.deepEqual([...HUNT_LANES].sort(), ['alcohol', 'beverage', 'electrolytes', 'energy', 'nicotine', 'rtd', 'spirits'])
  assert.deepEqual(huntLanes({}), HUNT_LANES)
  assert.deepEqual(huntLanes(null), HUNT_LANES)
})
t('it follows Category priority: a category he moves to Top is searched, one he moves off is not', () => {
  const mine = huntLanes({ beauty: 'top', nicotine: 'skip', energy: 'low', betting: 'skip' })
  assert.ok(mine.includes('beauty')); assert.ok(!mine.includes('nicotine')); assert.ok(!mine.includes('energy'))
  assert.ok(!mine.includes('betting')); assert.ok(!mine.includes('apparel'))
  // The holding pen is never a lane; a value that isn't a priority = the default.
  assert.ok(!huntLanes({ unresolved: 'top' }).includes('unresolved'))
  assert.ok(huntLanes({ energy: 'highest' }).includes('energy'))
  // Everything taken off Top: the defaults, never an empty hunt.
  const none = Object.fromEntries(HUNT_LANES.map(k => [k, 'low']))
  assert.deepEqual(huntLanes(none), HUNT_LANES)
})
t('a row is judged by the lanes of the day', () => {
  const mine = huntLanes({ beauty: 'top', energy: 'low' })
  assert.equal(judgeHuntRow({ ...good, category: 'beauty' }, new Set(), mine).ok, true)
  const no = judgeHuntRow(good, new Set(), mine)
  assert.equal(no.ok, false); assert.match(no.why, /not one of the Top categories \(energy\)/)
  // Soda / water and Alcohol (other) are Top, so they save now; clothing doesn't.
  assert.equal(judgeHuntRow({ ...good, category: 'beverage' }, new Set()).ok, true)
  assert.equal(judgeHuntRow({ ...good, category: 'alcohol' }, new Set()).ok, true)
  assert.equal(judgeHuntRow({ ...good, category: 'apparel' }, new Set()).ok, false)
  assert.equal(judgeHuntRow({ ...good, category: 'athletic' }, new Set()).ok, false)
})
t('Leo\'s sites to search first', () => {
  assert.deepEqual(HUNT_SOURCES, ['bevnet.com', 'brewbound.com', 'frontofficesports.com', 'cpglatest.com'])
})
t('a good row saves; no LinkedIn needed', () => {
  const v = judgeHuntRow(good, new Set())
  assert.equal(v.ok, true)
  assert.equal(v.row.website, 'https://novafizz.com/')
  assert.equal(v.row.linkedinUrl, null)
  assert.deepEqual(v.row.signals, ['genz', 'midsize'])
})
t('a source link alone is proof enough', () => {
  const v = judgeHuntRow({ ...good, website: null, sourceUrl: 'https://www.bevnet.com/news/nova' }, new Set())
  assert.equal(v.ok, true)
})
t('no website and no source → refused, even with a LinkedIn page', () => {
  const v = judgeHuntRow({ ...good, website: '', linkedinUrl: 'https://www.linkedin.com/company/nova' }, new Set())
  assert.equal(v.ok, false); assert.match(v.why, /website or source/)
})
t('outside the Top categories → refused', () => {
  const v = judgeHuntRow({ ...good, category: 'fintech' }, new Set())
  assert.equal(v.ok, false); assert.match(v.why, /not one of the Top categories \(fintech\)/)
})
t('no recognised signal → refused; unknown signals dropped', () => {
  assert.equal(judgeHuntRow({ ...good, signals: ['viral'] }, new Set()).ok, false)
  assert.deepEqual(judgeHuntRow({ ...good, signals: ['viral', 'sponsors', 'sponsors'] }, new Set()).row.signals, ['sponsors'])
})
t('known by name, aka or an earlier find → refused; twice in one post saves once', () => {
  const known = knownKeys([{ name: 'Liquid I.V.', aka: 'LIV, Liquid IV Inc' }], [{ name: 'Old Find Co' }])
  assert.equal(judgeHuntRow({ ...good, name: 'Liquid IV' }, known).ok, false)
  assert.equal(judgeHuntRow({ ...good, name: 'LIV' }, known).ok, false)
  assert.equal(judgeHuntRow({ ...good, name: 'Old Find' }, known).ok, false)
  assert.equal(judgeHuntRow(good, known).ok, true)
  assert.equal(judgeHuntRow({ ...good, name: 'Nova Fizz Inc.' }, known).ok, false)
})
t('a LinkedIn link that is not a company page is dropped, the row kept', () => {
  const v = judgeHuntRow({ ...good, linkedinUrl: 'https://www.linkedin.com/in/someone' }, new Set())
  assert.equal(v.ok, true); assert.equal(v.row.linkedinUrl, null)
})
t('label is the New York date', () => {
  assert.equal(huntLabel(new Date('2026-10-06T02:00:00Z')), 'Claude hunt · Oct 5')
})

t('giants are refused (Leo, Oct 6 2026)', () => {
  for (const name of ['Red Bull', 'Monster Energy', 'Bud Light', 'Ketel One', 'Diageo', 'Nike', "Tito's"]) {
    const v = judgeHuntRow({ ...good, name }, new Set())
    assert.equal(v.ok, false, name); assert.match(v.why, /^a giant/, name)
  }
  const big = judgeHuntRow({ ...good, name: 'Huge Pop', salesUsd: 2_500_000_000 }, new Set())
  assert.equal(big.ok, false); assert.match(big.why, /\$1B\+/)
  assert.equal(judgeHuntRow({ ...good, name: 'Mid Pop', salesUsd: 40_000_000 }, new Set()).ok, true)
  // A name that only contains a giant's word is not that giant.
  assert.equal(judgeHuntRow({ ...good, name: 'Nikel Energy' }, new Set()).ok, true)
})

console.log(n + ' hunt tests passed')
