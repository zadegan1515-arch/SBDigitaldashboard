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
const { readFind, scoreFind } = await import(pathToFileURL(join(out, 'find-evidence.js')).href)
const { scoreBrand } = await import(pathToFileURL(join(out, 'brand-fit.js')).href)

let n = 0
function t(name, fn) { fn(); n++; console.log('  ok — ' + name) }
const now = new Date('2026-10-15T12:00:00Z')
const ctx = (priority) => ({ priority, acceptRate: null, now })
const M = 1e6 * 100

t('letters by score: A 65 / B 50 / C 40', () => {
  assert.equal(letterFor(65), 'A'); assert.equal(letterFor(64), 'B'); assert.equal(letterFor(50), 'B')
  assert.equal(letterFor(49), 'C'); assert.equal(letterFor(40), 'C'); assert.equal(letterFor(39), 'D')
})

t('signs are read from the comma list', () => {
  assert.ok(hasSign(' genz , midsize', 'midsize')); assert.ok(!hasSign(null, 'sponsors'))
})

t('the write-up: money raised, sales, never a valuation or a price', () => {
  assert.equal(readFind('CB Insights lists a $2M seed round on Mar 4 2026').fundingCents, 2 * M)
  assert.equal(readFind('closed a $10M Series A Feb 2026').fundingCents, 10 * M)
  assert.equal(readFind('Women-owned Spirited Brands raised $3.1M in 2025').fundingCents, 3.1 * M)
  assert.equal(readFind('raised two $7M rounds and had ~4,500 doors').fundingCents, 14 * M)
  assert.equal(readFind('a $106M round at $500M+ valuation, all Kroger divisions').fundingCents, 106 * M)
  assert.equal(readFind('>$10M run rate, revenue doubled YoY').salesCents, 10 * M)
  assert.equal(readFind('Blanco $70 / Reposado $80, $57.99 a bottle').fundingCents, null)
  assert.equal(readFind('US dollar sales up 198% (SPINS)').salesCents, null)
})

t('the write-up: biggest store count, a parent, college / music', () => {
  assert.equal(readFind('in 3,500+ c-stores across TX').stores, 3500)
  assert.equal(readFind('~21,000 points of distribution incl. Walmart going to 3,200+ stores').stores, 21000)
  assert.equal(readFind('Organic electrolyte drink in 6,000+ stores (Publix 1,300 stores)').stores, 6000)
  assert.equal(readFind("Eugene brewery (owned by Tilray's beer arm)").parentNamed, 'Tilray')
  assert.ok(readFind('the Oregon Ducks’ first official craft beer at Autzen Stadium').college)
  assert.ok(readFind('presented his stadium tour and country festival sponsorships').music)
})

const text = (s) => ({ text: s })
t('a Top category that pays for college, nothing else known = 45 (C)', () => {
  const g = gradeDiscovery({ category: 'rtd', signals: 'sponsors', ...text('Official craft beer of the Pac-12 Conference.') }, ctx('top'))
  assert.equal(g.score, 45); assert.equal(g.grade, 'C')
  assert.ok(g.reasons.some(r => /already pays for college/.test(r.text) && r.points === 20))
})

t('proof in the write-up moves a find up', () => {
  const g = gradeDiscovery({ category: 'rtd', signals: 'sponsors', ...text(
    '>$10M run rate, revenue doubled YoY, in 8,000+ stores incl. Costco and Kroger; official beer partner of Texas A&M athletics.') }, ctx('top'))
  assert.equal(g.grade, 'A', JSON.stringify(g))
  assert.ok(g.reasons.some(r => /sweet spot/.test(r.text) && r.points === 25))
  assert.ok(g.reasons.some(r => /8,000\+ stores incl\. costco, kroger/.test(r.text) && r.points === 15))
  assert.ok(g.reasons.some(r => /growing fast/.test(r.text)))
})

t('money to spend but not too big: a parent or a giant gets no money points', () => {
  const base = { category: 'rtd', signals: 'sponsors', text: 'Owned by Tilray, raised $50M, official beer of the Ducks.' }
  const g = gradeDiscovery(base, ctx('top'))
  assert.ok(g.reasons.some(r => /owned by Tilray — too big for now/.test(r.text) && r.points === 0))
  const giant = gradeDiscovery({ ...base, text: 'Raised $50M.', giant: 'household name' }, ctx('top'))
  assert.ok(giant.reasons.some(r => /giant \(household name\)/.test(r.text)))
})

t('only popular with students counts less than paying for it', () => {
  const pop = scoreFind({ priority: 'top', text: 'Preppy brand hugely popular with college women and sororities.' })
  const pays = scoreFind({ priority: 'top', text: 'Official apparel partner of Cal men’s golf.' })
  assert.ok(pays.score > pop.score)
})

t('a Low category with nothing proven → D; Skip → D whatever it proves', () => {
  assert.equal(gradeDiscovery({ category: 'apparel', signals: 'genz', text: 'Streetwear label.' }, ctx('low')).grade, 'D')
  const skip = gradeDiscovery({ category: 'betting', signals: 'sponsors', text: 'Raised $40M, official partner of the Big Ten, 5,000 stores, doubled.' }, ctx('skip'))
  assert.equal(skip.grade, 'D'); assert.equal(skip.capped, 'Skip category')
})

t('every point has a reason, score stays 0..100', () => {
  const g = scoreFind({ priority: 'top', signals: 'genz', text: '$40M in sales, doubled, 9,000 stores at Walmart, official partner of the SEC, festival sponsor.' })
  assert.equal(g.reasons.reduce((s, r) => s + r.points, 0), g.score); assert.ok(g.score <= 100)
})

t('a find on the roster grades on its brand’s own Brand Fit', () => {
  const f = scoreBrand({ category: 'energy', priority: 'top', salesCents: 120 * M, sponsorsCollege: true, reachable: 4, need: 4, acceptRate: 0.3, now })
  const g = gradeFromFit(f); assert.equal(g.score, f.score); assert.equal(g.grade, 'A')
  assert.equal(gradeFromFit(scoreBrand({ category: 'energy', priority: 'top', usStatus: 'no', reachable: 4, need: 4, now })).capped, 'not sold in the US')
  const small = scoreBrand({ category: 'energy', priority: 'top', salesCents: 500_000 * 100, sponsorsCollege: true, reachable: 4, need: 4, now })
  assert.ok(small.tooSmall); assert.ok(['C', 'D'].includes(gradeFromFit(small).grade))
})

console.log(n + ' passed')
