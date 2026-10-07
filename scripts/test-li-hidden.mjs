// node scripts/test-li-hidden.mjs — people LinkedIn hides from Leo's
// account ("LinkedIn Member" cards) and "Read on Zach's LinkedIn"
// (src/lib/li-hidden.ts). Compiles the lib on its own, like
// test-coverage.mjs.
import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const out = mkdtempSync(join(tmpdir(), 'li-hidden-test-'))
execSync('npx tsc src/lib/li-hidden.ts --outDir ' + out + ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck', { stdio: 'inherit' })
for (const f of readdirSync(out)) {
  if (!f.endsWith('.js')) continue
  const p = join(out, f)
  writeFileSync(p, readFileSync(p, 'utf8').replace(/from '\.\/([\w-]+)'/g, "from './$1.js'"))
}
const H = await import(pathToFileURL(join(out, 'li-hidden.js')).href)

let n = 0
function t(name, fn) { fn(); n++; console.log('  ok — ' + name) }

const now = Date.parse('2026-10-07T12:00:00Z')
const daysAgo = d => new Date(now - d * 864e5).toISOString()
const P = 'https://www.linkedin.com/company/hiyo/people/'

t('a People view link is cleaned to the page and its keyword; anything else is not one', () => {
  assert.equal(H.peopleViewUrl('https://www.linkedin.com/company/hiyo/people/?keywords=partnerships&origin=x#y'), P + '?keywords=partnerships')
  assert.equal(H.peopleViewUrl('https://linkedin.com/company/diageo/people/?keywords=Captain%20Morgan'), 'https://www.linkedin.com/company/diageo/people/?keywords=Captain%20Morgan')
  assert.equal(H.peopleViewUrl(P), P)
  assert.equal(H.peopleViewUrl('https://www.linkedin.com/company/hiyo/'), null)
  // Whatever host it came from, the link is LinkedIn's.
  assert.equal(H.peopleViewUrl('http://127.0.0.1:4641/company/hiyo/people/?keywords=marketing'), P + '?keywords=marketing')
  assert.equal(H.peopleViewUrl('https://evil.example/company/hiyo/people/'), P)
  assert.equal(H.peopleViewUrl('javascript:alert(1)'), null)
  assert.equal(H.peopleViewUrl('https://www.linkedin.com/in/someone/'), null)
})

t('what a script sends is kept only for People pages with somebody hidden', () => {
  const v = H.cleanViews([
    { q: '', url: P, heads: ['Marketing Manager at Hiyo', ''] },
    { q: 'marketing', url: P + '?keywords=marketing', heads: [] },
    { q: 'x', url: 'https://www.linkedin.com/feed/', heads: ['Brand Manager'] },
    'junk',
  ])
  assert.equal(v.length, 1)
  assert.deepEqual(v[0].heads, ['Marketing Manager at Hiyo', ''])
  assert.deepEqual(H.cleanViews(null), [])
})

t('the same person in two views counts once; buyers judged on the headline', () => {
  const s = H.summarizeHidden([
    { q: '', url: P, heads: ['Brand Manager at Hiyo', 'Software Engineer', 'Software Engineer', ''] },
    { q: 'marketing', url: P + '?keywords=marketing', heads: ['Brand Manager at Hiyo', 'Head of Partnerships'] },
  ])
  // Brand Manager once, Software Engineer twice, Head of Partnerships once, one blank
  assert.equal(s.n, 5)
  // Brand Manager + Head of Partnerships; the blank was on the whole list, not a keyword view
  assert.equal(s.likely, 2)
  assert.deepEqual(s.titles, ['Brand Manager', 'Head of Partnerships'])
  // The marketing view has both buyers: Zach reads that one
  assert.equal(s.url, P + '?keywords=marketing')
  assert.equal(s.q, 'marketing')
})

t('a hidden card with no headline counts as a likely buyer only in a marketing / partnerships search', () => {
  const s = H.summarizeHidden([{ q: 'partnerships', url: P + '?keywords=partnerships', heads: ['', ''] }])
  assert.equal(s.n, 2)
  assert.equal(s.likely, 2)
  assert.deepEqual(s.titles, [])
  const all = H.summarizeHidden([{ q: '', url: P, heads: ['', ''] }])
  assert.equal(all.likely, 0)
  assert.equal(all.url, null)
})

t('students, store staff and other companies\' leaders are not buyers; the sister-brand rule is the caller\'s', () => {
  const s = H.summarizeHidden([{ q: '', url: P, heads: ['Marketing Major at USC', 'CEO of Other Co', 'Brand Ambassador', 'Brand Manager, Smirnoff'] }],
    ['Captain Morgan', 'Diageo'], h => /smirnoff/i.test(h))
  assert.equal(s.likely, 0)
  assert.equal(s.n, 4)
})

t('a read with likely buyers goes on Zach\'s list; Zach\'s read takes it off for 120 days', () => {
  let log = H.recordHidden({}, 'b1', [{ q: 'marketing', url: P + '?keywords=marketing', heads: ['Brand Manager'] }], { by: 'fill', now })
  assert.equal(log.b1.likely, 1)
  assert.equal(log.b1.by, 'fill')
  assert.ok(H.zachDue(log.b1, now))
  log = H.markZachRead(log, 'b1', 1, now)
  assert.equal(log.b1.zachAdded, 1)
  assert.equal(H.zachDue(log.b1, now + 30 * 864e5), false)
  assert.equal(H.zachDue(log.b1, now + 121 * 864e5), true)
  log = H.clearZachRead(log, 'b1')
  assert.ok(H.zachDue(log.b1, now))
  // A brand that never waited on Zach isn't marked
  assert.equal(H.markZachRead(log, 'nope', 2, now), log)
})

t('Leo\'s next read keeps Zach\'s mark; a whole fill read with nobody hidden clears it, a hand read doesn\'t', () => {
  let log = H.recordHidden({}, 'b1', [{ q: '', url: P, heads: ['Marketing Director'] }], { by: 'fill', now })
  log = H.markZachRead(log, 'b1', 0, now)
  log = H.recordHidden(log, 'b1', [{ q: '', url: P, heads: ['Marketing Director', 'Events Manager'] }], { by: 'fill', now: now + 864e5 })
  assert.equal(log.b1.likely, 2)
  assert.ok(log.b1.zachAt, 'Zach\'s read is kept')
  assert.equal(H.zachDue(log.b1, now + 864e5), false)
  const hand = H.recordHidden(log, 'b1', [], { by: 'hand', now: now + 2 * 864e5 })
  assert.ok(hand.b1, 'a hand read of one view says nothing about the others')
  const fill = H.recordHidden(log, 'b1', [], { by: 'fill', now: now + 2 * 864e5 })
  assert.equal(fill.b1, undefined)
})

t('nobody likely, or no link: not Zach\'s; old entries fall away', () => {
  assert.equal(H.zachDue({ at: daysAgo(1), by: 'fill', n: 3, likely: 0, titles: [], url: P, q: '' }, now), false)
  assert.equal(H.zachDue({ at: daysAgo(1), by: 'fill', n: 3, likely: 2, titles: [], url: null, q: '' }, now), false)
  assert.equal(H.zachDue(undefined, now), false)
  const old = { old: { at: daysAgo(200), by: 'fill', n: 1, likely: 1, titles: [], url: P, q: '' } }
  const next = H.recordHidden(old, 'b2', [{ q: '', url: P, heads: ['CMO'] }], { by: 'fill', now })
  assert.equal(next.old, undefined)
  assert.ok(next.b2)
})

t('one hidden marketer seen on every view: one person, Zach reads the keyword view', () => {
  const LD = 'https://www.linkedin.com/company/liquid-death/people/'
  const s = H.summarizeHidden(['', 'marketing', 'partnerships'].map(q => ({ q, url: LD + (q ? '?keywords=' + q : ''), heads: ['Marketing at Liquid Death'] })))
  assert.deepEqual({ n: s.n, likely: s.likely, titles: s.titles, q: s.q, url: s.url },
    { n: 1, likely: 1, titles: ['Marketing'], q: 'marketing', url: LD + '?keywords=marketing' })
})

t('a parent company\'s tab searched for the brand counts too, and can be the link', () => {
  const D = 'https://www.linkedin.com/company/diageo/people/?keywords=Captain%20Morgan'
  const s = H.summarizeHidden([
    { q: '', url: 'https://www.linkedin.com/company/captain-morgan/people/', heads: ['Marketing'] },
    { q: 'Captain Morgan', url: D, heads: ['Brand Manager, Captain Morgan', 'Senior Brand Manager'] },
  ])
  assert.equal(s.n, 3)
  assert.equal(s.likely, 3)
  assert.equal(s.url, D)
})

t('sizes are capped: 8 views, 60 headlines, 200 characters', () => {
  const v = H.cleanViews(Array.from({ length: 12 }, (_, i) => ({ q: 'v' + i, url: P, heads: Array.from({ length: 80 }, () => 'x'.repeat(300)) })))
  assert.equal(v.length, 8)
  assert.equal(v[0].heads.length, 60)
  assert.equal(v[0].heads[0].length, 200)
})

t('a one-view hand read never wipes a fuller finding; a stronger one replaces it', () => {
  let log = H.recordHidden({}, 'b1', [{ q: 'marketing', url: P + '?keywords=marketing', heads: ['Brand Manager', 'Marketing Director', 'Events Lead', 'CMO'] }], { by: 'fill', now })
  const weaker = H.recordHidden(log, 'b1', [{ q: 'sales', url: P + '?keywords=sales', heads: ['Sales Manager', 'Account Executive'] }], { by: 'hand', now })
  assert.equal(weaker.b1.likely, 4, 'the fill\'s four marketers stay on Zach\'s list')
  assert.equal(weaker.b1.url, P + '?keywords=marketing')
  const stronger = H.recordHidden(log, 'b1', [{ q: 'partnerships', url: P + '?keywords=partnerships', heads: ['Head of Partnerships', 'Partnerships Manager', 'Brand Manager', 'CMO', 'Events Lead'] }], { by: 'hand', now })
  assert.equal(stronger.b1.likely, 5)
  assert.equal(stronger.b1.by, 'hand')
})

t('no headline counts as a buyer only in a marketing / partnerships search — not a parent\'s tab searched for the brand', () => {
  const D = 'https://www.linkedin.com/company/diageo/people/?keywords=Captain%20Morgan'
  const s = H.summarizeHidden([{ q: 'Captain Morgan', url: D, heads: ['', '', ''] }])
  assert.equal(s.n, 3)
  assert.equal(s.likely, 0)
  assert.equal(s.url, null)
  assert.equal(H.summarizeHidden([{ q: 'brand manager', url: P + '?keywords=brand%20manager', heads: [''] }]).likely, 1)
  assert.equal(H.summarizeHidden([{ q: 'sales', url: P + '?keywords=sales', heads: [''] }]).likely, 0)
})

console.log('li-hidden: all ' + n + ' passed')
