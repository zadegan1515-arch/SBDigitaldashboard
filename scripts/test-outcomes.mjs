// scripts/test-outcomes.mjs — guards src/lib/outcomes.ts: which LinkedIn
// invites get answered, by category, company size, buyer type and how many
// people were invited at a brand (outcome-table, Oct 12 2026: read-only,
// suggestions only). Run: node scripts/test-outcomes.mjs
import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const out = mkdtempSync(join(tmpdir(), 'outcomes-test-'))
execSync('npx tsc src/lib/outcomes.ts --outDir ' + out + ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck', { stdio: 'inherit' })
for (const f of readdirSync(out).filter(f => f.endsWith('.js'))) {
  const p = join(out, f)
  writeFileSync(p, readFileSync(p, 'utf8').replace(/from '(\.\/[^']+)'/g, "from '$1.js'"))
}
const { outcomeRates, threadsKey, ACCEPT_AFTER_DAYS, REPLY_AFTER_DAYS, FEW, PRIOR } = await import(pathToFileURL(join(out, 'outcomes.js')).href)

let n = 0
const t = (name, fn) => { fn(); n++; console.log('  ok — ' + name) }
const now = new Date('2026-10-13T16:00:00Z')
const ago = (d) => new Date(now.getTime() - d * 864e5)
let seq = 0
const inv = (x = {}) => ({ brandId: 'b' + (seq++), at: ago(30), category: 'energy', size: 'target', buyer: 'marketing', accepted: false, replied: false, ...x })

t('answer windows: 7 days for an accept, 19 for a reply (2 + 10 + 7 on Zach\'s list)', () => {
  assert.deepEqual([ACCEPT_AFTER_DAYS, REPLY_AFTER_DAYS, FEW, PRIOR], [7, 19, 30, 5])
  const r = outcomeRates([inv({ at: ago(3), accepted: true }), inv({ at: ago(10), accepted: true }), inv({ at: ago(25), replied: true, accepted: true })], { now })
  assert.deepEqual([r.overall.n, r.overall.accepted], [2, 2], 'a 3-day-old invite is too young to judge')
  assert.deepEqual([r.overall.replyN, r.overall.replied], [1, 1], 'only the 25-day-old one counts for replies')
})
t('accepts and replies counted apart; rates pulled toward the average; n on every cell; too few to tell under 30', () => {
  const list = []
  for (let i = 0; i < 40; i++) list.push(inv({ category: 'electrolytes', accepted: i < 24, replied: i < 4 })) // 60%
  for (let i = 0; i < 60; i++) list.push(inv({ category: 'energy', accepted: i < 12 })) // 20%
  for (let i = 0; i < 4; i++) list.push(inv({ category: 'beauty', accepted: true })) // 4 of 4
  const r = outcomeRates(list, { now })
  const o = r.overall.acceptRate
  assert.equal(o, 40 / 104)
  const el = r.byCategory.find(c => c.key === 'electrolytes')
  assert.deepEqual([el.n, el.accepted, el.replied, el.few], [40, 24, 4, false])
  assert.equal(el.acceptRate, (24 + PRIOR * o) / (40 + PRIOR))
  const be = r.byCategory.find(c => c.key === 'beauty')
  assert.equal(be.few, true, '4 invites: too few to tell')
  assert.ok(be.acceptRate < 1, 'one lucky streak is pulled toward the average')
})
t('grouped by size, buyer type (not a buyer = other) and threads per brand', () => {
  const list = [
    inv({ size: 'big', buyer: 'partnerships', accepted: true }), inv({ size: 'small', buyer: null }),
    { ...inv({ accepted: true }), brandId: 'tri' }, { ...inv(), brandId: 'tri' }, { ...inv(), brandId: 'tri' },
  ]
  const r = outcomeRates(list, { now })
  assert.deepEqual(r.bySize.map(c => c.key), ['small', 'target', 'big'])
  assert.deepEqual(r.byBuyer.map(c => [c.key, c.n]), [['partnerships', 1], ['marketing', 3], ['other', 1]])
  const three = r.byThreads.find(c => c.key === '3')
  assert.deepEqual([three.n, three.accepted], [1, 1], 'per brand: one brand of three threads, someone accepted')
  assert.deepEqual([threadsKey(1), threadsKey(4), threadsKey(6), threadsKey(10), threadsKey(14)], ['1', '4', '5–9', '10+', '10+'])
})
t('suggests a priority change only with enough invites, one step at a time, never for Skip — nothing applied', () => {
  const list = []
  for (let i = 0; i < 40; i++) list.push(inv({ category: 'beauty', accepted: i < 30 })) // 75% — Middle → Top?
  for (let i = 0; i < 40; i++) list.push(inv({ category: 'spirits', accepted: i < 2 })) // 5% — Top → Middle?
  for (let i = 0; i < 60; i++) list.push(inv({ category: 'energy', accepted: i < 18 }))
  for (let i = 0; i < 40; i++) list.push(inv({ category: 'betting', accepted: i < 2 })) // Skip: left alone, however it does
  for (let i = 0; i < 10; i++) list.push(inv({ category: 'apparel', accepted: true })) // too few
  const pr = { beauty: 'middle', spirits: 'top', energy: 'top', betting: 'skip', apparel: 'low' }
  const r = outcomeRates(list, { now, priorityOf: c => pr[c] || 'middle' })
  assert.deepEqual(r.suggestions.map(s => [s.category, s.from, s.to]).sort(), [['beauty', 'middle', 'top'], ['spirits', 'top', 'middle']])
  assert.match(r.suggestions.find(s => s.category === 'beauty').text, /× the average .* make it Top\?/)
  assert.deepEqual(outcomeRates(list, { now }).suggestions, [], 'no priorities given: no suggestions')
})
t('nothing to judge yet: empty, no NaN', () => {
  const r = outcomeRates([inv({ at: ago(1) })], { now })
  assert.deepEqual([r.overall.n, r.overall.acceptRate, r.byCategory.length], [0, null, 0])
  assert.deepEqual([r.depth.personRate, r.depth.model, r.depth.byOrder], [null, [], []])
})
// People per brand (people-per-brand, Oct 18 2026): accepts only, raw rates.
const at = (brandId, x = {}) => ({ ...inv(x), brandId })
t('people per brand: each person by place in the brand’s line, by send time', () => {
  const list = [
    // Listed out of order: the 08:00 invite is the brand's 1st.
    at('a', { at: new Date(ago(30).getTime() + 2 * 36e5) }), at('a', { at: ago(30), accepted: true }), at('a', { at: new Date(ago(30).getTime() + 36e5) }),
    at('b', { at: ago(30), accepted: true }), at('b', { at: ago(30) }), at('b', { at: ago(30) }), at('b', { at: ago(30) }), at('b', { at: ago(30), accepted: true }),
    at('c', { at: ago(30) }), at('c', { at: ago(2), accepted: true }), // 2nd too young to judge
  ]
  const d = outcomeRates(list, { now }).depth
  assert.deepEqual(d.byOrder.map(c => [c.key, c.people, c.peopleYes]), [['1', 3, 2], ['2', 2, 0], ['3', 2, 0], ['4', 1, 0], ['5+', 1, 1]])
  assert.equal(d.byOrder[0].personRate, 2 / 3)
  assert.equal(d.personRate, 3 / 9, 'the 2-day-old invite is too young to count')
})
t('people per brand: first day vs in all — a second try later counts in all, not the first day', () => {
  const list = [
    at('a', { day: '2026-09-15', at: ago(28) }), at('a', { day: '2026-09-15', at: ago(28) }), at('a', { day: '2026-09-15', at: ago(28) }),
    at('a', { day: '2026-10-01', at: ago(12), accepted: true }), // a second try, accepted
    at('b', { day: '2026-09-16', at: ago(27), accepted: true }), at('b', { day: '2026-09-16', at: ago(27) }), at('b', { day: '2026-09-16', at: ago(27) }),
  ]
  const d = outcomeRates(list, { now }).depth
  const f3 = d.byFirstDay.find(c => c.key === '3')
  assert.deepEqual([f3.brands, f3.brandsYes, f3.people, f3.peopleYes], [2, 1, 6, 1], 'a: no yes on its first day; b: yes')
  assert.deepEqual(d.byTotal.map(c => [c.key, c.brands, c.brandsYes, c.people]), [['3', 1, 1, 3], ['4', 1, 1, 4]])
  assert.equal(f3.few, true, 'under 30 brands: too few to tell')
})
t('people per brand: by Brand Fit band, and the separate-chances model', () => {
  const list = [
    at('hi', { fit: 72, accepted: true }), at('hi', { fit: 72 }),
    at('mid', { fit: 50 }), at('lo', { fit: 49.9 }), at('none', { fit: null, accepted: true }),
  ]
  const d = outcomeRates(list, { now }).depth
  assert.deepEqual(d.byFit.map(c => [c.key, c.brands, c.brandsYes, c.people]), [['65+', 1, 1, 2], ['50–64', 1, 0, 1], ['under 50', 1, 0, 1], ['not scored', 1, 1, 1]])
  const p = 2 / 5
  assert.equal(d.personRate, p)
  const m4 = d.model.find(m => m.k === 4)
  assert.ok(Math.abs(m4.brandChance - (1 - (1 - p) ** 4)) < 1e-12)
  assert.ok(Math.abs(m4.adds - p * (1 - p) ** 3) < 1e-12, 'the 4th person adds what the first three left')
  assert.ok(Math.abs(m4.brandsPerDay - (30 / 4) * m4.brandChance) < 1e-12)
  assert.deepEqual(d.model.map(m => m.k), [1, 2, 3, 4, 5, 6])
})
console.log(n + ' outcomes tests passed')
