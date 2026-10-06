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
const { judgeHuntRow, knownKeys, HUNT_LANES, HUNT_SOURCES, huntLabel } = await import(pathToFileURL(join(out, 'claude-hunt.js')).href)

let n = 0
function t(name, fn) { fn(); n++; console.log('  ok — ' + name) }

const good = { name: 'Nova Fizz', category: 'energy', signals: ['genz', 'midsize'], website: 'novafizz.com', reason: 'r', activation: 'a' }

t('priority lanes are the seven Leo named', () => {
  assert.deepEqual(HUNT_LANES.sort(), ['apparel', 'athletic', 'electrolytes', 'energy', 'nicotine', 'rtd', 'spirits'])
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
t('outside the priority lanes → refused', () => {
  const v = judgeHuntRow({ ...good, category: 'fintech' }, new Set())
  assert.equal(v.ok, false); assert.match(v.why, /priority lane/)
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
