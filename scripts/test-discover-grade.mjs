// node scripts/test-discover-grade.mjs — the grade on every Discover find
// (src/lib/discover-grade.ts: Brand Fit as a letter).
import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const out = mkdtempSync(join(tmpdir(), 'dgrade-test-'))
execSync('npx tsc src/lib/discover-grade.ts --outDir ' + out + ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck', { stdio: 'inherit' })
const fs = await import('node:fs')
for (const f of fs.readdirSync(out)) {
  if (!f.endsWith('.js')) continue
  const p = join(out, f)
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/from '\.\/([\w-]+)'/g, "from './$1.js'"))
}
const { gradeDiscovery, gradeFromFit, letterFor, hasSign } = await import(pathToFileURL(join(out, 'discover-grade.js')).href)
const { scoreBrand } = await import(pathToFileURL(join(out, 'brand-fit.js')).href)

let n = 0
function t(name, fn) { fn(); n++; console.log('  ok — ' + name) }
const now = new Date('2026-10-12T12:00:00Z')
const ctx = (priority, acceptRate = null) => ({ priority, acceptRate, now })

t('letters by score', () => {
  assert.equal(letterFor(72), 'A'); assert.equal(letterFor(60), 'A')
  assert.equal(letterFor(59), 'B'); assert.equal(letterFor(45), 'B')
  assert.equal(letterFor(44), 'C'); assert.equal(letterFor(30), 'C')
  assert.equal(letterFor(29), 'D'); assert.equal(letterFor(0), 'D')
})

t('signs are read from the comma list', () => {
  assert.ok(hasSign('sponsors,genz', 'sponsors'))
  assert.ok(hasSign(' genz , midsize', 'midsize'))
  assert.ok(!hasSign('genz', 'sponsors'))
  assert.ok(!hasSign(null, 'sponsors'))
})

t('a Top category that sponsors college and is growing → A', () => {
  const g = gradeDiscovery({ category: 'electrolytes', signals: 'sponsors,genz,midsize' }, ctx('top'))
  assert.equal(g.grade, 'A', JSON.stringify(g))
  assert.ok(g.reasons.some(r => /already sponsors college/.test(r.text)))
  assert.ok(g.reasons.some(r => /Top priority/.test(r.text)))
})

t('a Top category with no sign → B', () => {
  assert.equal(gradeDiscovery({ category: 'energy', signals: '' }, ctx('top')).grade, 'B')
})

t('a Middle category with no sign → C; mid-size and sponsoring college → B', () => {
  assert.equal(gradeDiscovery({ category: 'snacks', signals: null }, ctx('middle')).grade, 'C')
  assert.equal(gradeDiscovery({ category: 'snacks', signals: 'sponsors,midsize' }, ctx('middle')).grade, 'B')
})

t('a Low category with no sign → D', () => {
  assert.equal(gradeDiscovery({ category: 'apparel', signals: 'genz' }, ctx('low')).grade, 'D')
})

t('the 18–24 sign alone adds nothing (Brand Fit dropped it for category priority)', () => {
  const a = gradeDiscovery({ category: 'snacks', signals: 'genz' }, ctx('middle'))
  const b = gradeDiscovery({ category: 'snacks', signals: '' }, ctx('middle'))
  assert.equal(a.score, b.score)
})

t('a Skip category is always D, and says why', () => {
  const g = gradeDiscovery({ category: 'betting', signals: 'sponsors,midsize' }, ctx('skip'))
  assert.equal(g.grade, 'D')
  assert.equal(g.capped, 'Skip category')
  const f = scoreBrand({ category: 'betting', priority: 'skip', salesCents: 500 * 1e6 * 100, sponsorsCollege: true, reachable: 4, need: 4, now })
  const g2 = gradeFromFit(f)
  assert.equal(g2.grade, 'D'); assert.equal(g2.capped, 'Skip category')
})

t('a giant find grades low', () => {
  const g = gradeDiscovery({ category: 'energy', signals: 'sponsors,midsize', giant: 'household name' }, ctx('top'))
  assert.equal(g.grade, 'B', JSON.stringify(g.score))
  assert.ok(g.score < gradeDiscovery({ category: 'energy', signals: 'sponsors,midsize' }, ctx('top')).score)
})

t('not sold in the US / closed → D', () => {
  const base = { category: 'energy', priority: 'top', salesCents: 200 * 1e6 * 100, sponsorsCollege: true, reachable: 4, need: 4, now }
  assert.equal(gradeFromFit(scoreBrand({ ...base, usStatus: 'no' })).capped, 'not sold in the US')
  assert.equal(gradeFromFit(scoreBrand({ ...base, bizStatus: 'closed' })).grade, 'D')
})

t('too small caps at C', () => {
  const f = scoreBrand({ category: 'energy', priority: 'top', salesCents: 500_000 * 100, sponsorsCollege: true, reachable: 4, need: 4, now })
  assert.ok(f.tooSmall)
  const g = gradeFromFit(f)
  assert.equal(g.grade, 'C'); assert.ok(g.capped)
})

t('an added brand with money and people grades on its own Brand Fit', () => {
  const f = scoreBrand({ category: 'energy', priority: 'top', salesCents: 120 * 1e6 * 100, sponsorsCollege: true, reachable: 4, need: 4, acceptRate: 0.3, now })
  const g = gradeFromFit(f)
  assert.equal(g.grade, 'A'); assert.equal(g.score, f.score)
})

console.log(n + ' passed')
