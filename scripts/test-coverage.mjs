// node scripts/test-coverage.mjs — every brand a buyer (src/lib/coverage.ts):
// what stands between a brand and its first marketing / partnerships
// person, and the LinkedIn fill doing the brands with nobody first.
// Compiles the lib on its own, like test-brand-fit.mjs.
import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const out = mkdtempSync(join(tmpdir(), 'coverage-test-'))
execSync('npx tsc src/lib/coverage.ts --outDir ' + out + ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck', { stdio: 'inherit' })
// tsc emits extensionless relative imports; Node's ESM loader needs ".js".
for (const f of readdirSync(out)) {
  if (!f.endsWith('.js')) continue
  const p = join(out, f)
  writeFileSync(p, readFileSync(p, 'utf8').replace(/from '\.\/([\w-]+)'/g, "from './$1.js'"))
}
const { coverOf, coverCounts, noBuyerFirst, NEED_STATES } = await import(pathToFileURL(join(out, 'coverage.js')).href)
const { liRestsNow } = await import(pathToFileURL(join(out, 'li-sweep.js')).href)

let n = 0
function t(name, fn) { fn(); n++; console.log('  ok — ' + name) }

const now = Date.parse('2026-10-06T12:00:00Z')
const daysAgo = d => new Date(now - d * 864e5).toISOString()
const opts = { cap: 25, now }
const S = (o = {}) => coverOf({ titles: [], ...o }, opts).state

t('archived or do-not-email: off, whoever is on file', () => {
  assert.equal(S({ passedAt: daysAgo(3) }), 'off')
  assert.equal(S({ doNotEmail: true, titles: ['Brand Manager'] }), 'off')
})

t('one marketing / partnerships person covers a brand', () => {
  const c = coverOf({ titles: ['Accountant', 'Brand Partnerships Manager'] }, opts)
  assert.equal(c.state, 'covered')
  assert.equal(c.buyers, 1)
  assert.equal(S({ titles: ['Software Engineer', 'Supply Chain Analyst'] }), 'next', 'other titles are not enough')
})

t('25 on file and none a buyer: full — the fill cannot add anyone', () => {
  assert.equal(S({ titles: Array(25).fill('Sales Associate') }), 'full')
  assert.equal(S({ titles: Array(24).fill('Sales Associate') }), 'next')
})

t('on "Which LinkedIn page is theirs?": pick the page, even while resting', () => {
  assert.equal(S({ inReview: true }), 'page')
  assert.equal(S({ inReview: true, mark: { at: daysAgo(2), seen: 0, added: 0, note: 'no clear LinkedIn page — pick it on Outreach → People', v: 2 } }), 'page')
})

t('Leo said there is no LinkedIn page: noPage — unless a parent company can be searched', () => {
  assert.equal(S({ confirmed: 'none' }), 'noPage')
  assert.equal(S({ confirmed: 'none', hasParent: true }), 'next')
  assert.equal(S({ confirmed: 'none', linkedinUrl: 'https://www.linkedin.com/company/x/' }), 'next', 'a saved page is still read')
  assert.equal(S({ confirmed: 'some-slug' }), 'next')
})

t('read lately with nobody found: resting, with the note and the day it is back', () => {
  const at = daysAgo(6)
  const c = coverOf({ titles: [], linkedinUrl: 'https://www.linkedin.com/company/x/', mark: { at, seen: 40, added: 0, note: 'big company (173 people) — nobody new in its partnerships, sponsorship, brand manager, marketing searches', v: 2 } }, opts)
  assert.equal(c.state, 'resting')
  assert.match(c.note, /^big company/)
  assert.equal(c.at, at)
  assert.equal(c.back, new Date(Date.parse(at) + 30 * 864e5).toISOString())
})

t('back on the list: a visit over a month old, an old reader, a "too big" skip, a parent not yet searched', () => {
  assert.equal(S({ mark: { at: daysAgo(31), seen: 0, added: 0, v: 2 } }), 'next')
  assert.equal(S({ mark: { at: daysAgo(3), seen: 9, added: 0, v: 1 } }), 'next')
  assert.equal(S({ mark: { at: daysAgo(3), seen: 0, added: 0, note: 'too big — 308 people on LinkedIn (skips 100+)', v: 2 } }), 'next')
  assert.equal(S({ hasParent: true, mark: { at: daysAgo(3), seen: 0, added: 0, v: 2 } }), 'next')
  assert.equal(S({ hasParent: true, mark: { at: daysAgo(3), seen: 0, added: 0, v: 2, parentTried: true } }), 'resting')
  assert.equal(S({ hasParent: true, mark: { at: daysAgo(3), seen: 0, added: 0, v: 2, parentTried: true, note: 'no LinkedIn page of its own; could not find E. & J. Gallo on LinkedIn' } }), 'next')
})

t('liRestsNow is the worklist rule: no mark, no rest', () => {
  assert.equal(liRestsNow(undefined, false, now), false)
  assert.equal(liRestsNow({ at: daysAgo(1), seen: 5, added: 2, v: 2 }, false, now), true)
  assert.equal(liRestsNow({ at: daysAgo(1), seen: 5, added: 2, v: 2 }, true, now), true, 'people found: rests even with a parent')
})

t('counts: in play leaves out archived; need = in play and not covered', () => {
  const list = [
    coverOf({ titles: ['CMO'] }, opts),
    coverOf({ titles: [] }, opts),
    coverOf({ titles: [], inReview: true }, opts),
    coverOf({ titles: [], confirmed: 'none' }, opts),
    coverOf({ titles: [], passedAt: daysAgo(1) }, opts),
    coverOf({ titles: [], mark: { at: daysAgo(2), seen: 3, added: 0, v: 2 } }, opts),
  ]
  const c = coverCounts(list)
  assert.deepEqual(
    { inPlay: c.inPlay, need: c.need, covered: c.covered, next: c.next, page: c.page, noPage: c.noPage, resting: c.resting, off: c.off, full: c.full },
    { inPlay: 5, need: 4, covered: 1, next: 1, page: 1, noPage: 1, resting: 1, off: 1, full: 0 },
  )
  assert.deepEqual(NEED_STATES, ['next', 'page', 'resting', 'noPage', 'full'])
})

t('the fill: Schedule brands and asked-for names lead, then brands with no buyer, then the rest — each in its own order', () => {
  const list = [
    { name: 'Planned', planned: '2026-10-07' },
    { name: 'Huel', research: true, asked: true },
    { name: 'Focus research', research: true, focus: true },
    { name: 'Focus with buyer', focus: true },
    { name: 'Focus no buyer', focus: true, noBuyer: true },
    { name: 'Target with buyer' },
    { name: 'Target no buyer', noBuyer: true },
    { name: 'Research name', research: true, noBuyer: true },
    { name: 'Big no buyer', noBuyer: true },
    { name: 'Big with buyer' },
  ]
  assert.deepEqual(noBuyerFirst(list).map(i => i.name), [
    'Planned', 'Huel',
    'Focus no buyer', 'Target no buyer', 'Big no buyer',
    'Focus research', 'Focus with buyer', 'Target with buyer', 'Research name', 'Big with buyer',
  ])
  assert.deepEqual(noBuyerFirst([]), [])
})

console.log(n + ' coverage tests passed')
