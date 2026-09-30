// scripts/test-li-report.mjs — guards the LinkedIn run reports
// (src/lib/li-report.ts): what the dashboard keeps of each run the
// script reports, which Leo reads on Outreach → People and Claude's
// morning check reads through /api/reports/linkedin.
// Run: node scripts/test-li-report.mjs

import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const out = mkdtempSync(join(tmpdir(), 'li-report-'))
execSync(
  'npx tsc src/lib/li-report.ts src/lib/li-review.ts --outDir ' + out +
  ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck',
  { stdio: 'inherit' },
)
const { applyRunEvent } = await import(pathToFileURL(join(out, 'li-report.js')).href)
const { addToReview, sameMember } = await import(pathToFileURL(join(out, 'li-review.js')).href)

let n = 0
function t(name, fn) { fn(); n++; console.log('  ok — ' + name) }
const at = (m) => new Date(Date.UTC(2026, 8, 26, 9, m))

t('a run: start, brands, a pause, carry on, finish', () => {
  let r = applyRunEvent([], { kind: 'start', run: 'f1', script: '1.13', reader: 2, focus: 'electrolyte', items: 40 }, at(0))
  r = applyRunEvent(r, { kind: 'brand', run: 'f1', name: 'LMNT', brandId: 'b1', seen: 12, added: 4 }, at(1))
  r = applyRunEvent(r, { kind: 'brand', run: 'f1', name: 'Nuun', brandId: 'b2', seen: 0, added: 0, note: 'no clear LinkedIn page' }, at(2))
  r = applyRunEvent(r, { kind: 'pause', run: 'f1', why: 'LinkedIn showed a security check' }, at(3))
  assert.equal(r[0].status, 'paused')
  r = applyRunEvent(r, { kind: 'resume', run: 'f1' }, at(4))
  assert.equal(r[0].status, 'running')
  r = applyRunEvent(r, { kind: 'finish', run: 'f1', stopped: false, newBrands: 2 }, at(5))
  const run = r[0]
  assert.equal(run.status, 'finished'); assert.equal(run.added, 4); assert.equal(run.newBrands, 2)
  assert.equal(run.brands.length, 2); assert.equal(run.brands[1].note, 'no clear LinkedIn page')
  assert.equal(run.pauses[0].why, 'LinkedIn showed a security check')
  assert.equal(run.script, '1.13'); assert.equal(run.focus, 'electrolyte'); assert.equal(run.items, 40)
  assert.equal(run.startedAt, at(0).toISOString()); assert.equal(run.lastAt, at(5).toISOString())
})

t('each brand keeps its time and hidden time; the run adds up the hidden minutes', () => {
  let r = applyRunEvent([], { kind: 'brand', run: 'f3', name: 'A', seen: 5, added: 1, ms: 90000, hiddenMs: 0 }, at(0))
  r = applyRunEvent(r, { kind: 'brand', run: 'f3', name: 'B', seen: 5, added: 1, ms: 840000, hiddenMs: 720000 }, at(1))
  r = applyRunEvent(r, { kind: 'brand', run: 'f3', name: 'C', seen: 5, added: 1 }, at(2))
  assert.equal(r[0].hiddenMs, 720000)
  assert.deepEqual(r[0].brands.map(b => [b.ms, b.hiddenMs]), [[90000, 0], [840000, 720000], [null, 0]])
})

t('an unreadable page is counted and keeps a small sample — three at most', () => {
  let r = []
  for (let i = 0; i < 5; i++) {
    r = applyRunEvent(r, { kind: 'brand', run: 'f2', name: 'B' + i, seen: 3, added: 0, problem: 'every title came out blank (3 people)', sample: 'x'.repeat(9000) }, at(i))
  }
  assert.equal(r[0].problems, 5)
  assert.equal(r[0].samples.length, 3)
  assert.equal(r[0].samples[0].sample.length, 6000)
  assert.equal(r[0].brands[0].problem, 'every title came out blank (3 people)')
})

t('a brand for a run it never heard start opens that run (an older script started it)', () => {
  const r = applyRunEvent([], { kind: 'brand', run: 'old', name: 'Olipop', seen: 2, added: 2 }, at(0))
  assert.equal(r.length, 1); assert.equal(r[0].id, 'old'); assert.equal(r[0].status, 'running'); assert.equal(r[0].added, 2)
})

t('newest run first, last ten kept; junk ignored', () => {
  let r = []
  for (let i = 0; i < 12; i++) r = applyRunEvent(r, { kind: 'start', run: 'r' + i, items: 1 }, at(i))
  assert.equal(r.length, 10); assert.equal(r[0].id, 'r11'); assert.equal(r[9].id, 'r2')
  assert.equal(applyRunEvent(r, { kind: 'brand', run: '' }), r, 'no run id, nothing changes')
  const neg = applyRunEvent([], { kind: 'brand', run: 'z', name: 'Z', seen: -4, added: 'lots' }, at(0))
  assert.equal(neg[0].brands[0].seen, 0); assert.equal(neg[0].brands[0].added, 0)
})

t('"Which LinkedIn page is theirs?": findings add up, and a wrong saved page stays the reason', () => {
  const c = (slug, name) => ({ slug, name, subtitle: '' })
  let r = addToReview({}, 'b1', { why: 'none' }, at(0))
  assert.equal(r.b1.why, 'none'); assert.deepEqual(r.b1.candidates, [])
  r = addToReview(r, 'b1', { why: 'unclear', candidates: [c('a', 'A'), c('b', 'B')] }, at(1))
  r = addToReview(r, 'b1', { why: 'unclear', candidates: [c('b', 'B'), c('c', 'C')] }, at(2))
  assert.deepEqual(r.b1.candidates.map(x => x.slug), ['a', 'b', 'c'], 'no repeats, first seen first')
  assert.equal(r.b1.why, 'unclear')
  r = addToReview(r, 'b2', { why: 'wrong', saved: 'https://www.linkedin.com/company/native-co./', pageIndustry: 'Individual and Family Services' }, at(3))
  r = addToReview(r, 'b2', { why: 'unclear', candidates: [c('native-cos', 'Native')] }, at(4))
  assert.equal(r.b2.why, 'wrong'); assert.equal(r.b2.saved, 'https://www.linkedin.com/company/native-co./')
  assert.equal(r.b2.pageIndustry, 'Individual and Family Services'); assert.equal(r.b2.candidates[0].slug, 'native-cos')
})

t('same LinkedIn member: profile links when both known, else names; nothing to go on is no verdict', () => {
  assert.equal(sameMember({ slug: 'leo-z' }, { slug: 'LEO-Z', name: 'Someone' }), true)
  assert.equal(sameMember({ slug: 'leo-z' }, { slug: 'zach-q' }), false)
  assert.equal(sameMember({ name: 'Leo Zadegan' }, { slug: 'x', name: 'Léo  Zadegan' }), true)
  assert.equal(sameMember({ name: 'Leo Z' }, { name: 'Zach Q' }), false)
  assert.equal(sameMember({ slug: 'leo-z' }, { name: 'Leo Z' }), null)
  assert.equal(sameMember(null, { slug: 'leo-z' }), null)
})

console.log(n + ' checks passed')
