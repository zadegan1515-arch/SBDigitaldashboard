// scripts/test-brand-work.mjs — guards src/lib/brand-work.ts: how many
// people a brand works at once and who stays in play (picks, Oct 12 2026:
// each brand opens with exactly its number, best LinkedIn buyers first; a
// big company only when measured 500+ or owned by a parent).
// Run: node scripts/test-brand-work.mjs
import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const out = mkdtempSync(join(tmpdir(), 'brand-work-test-'))
execSync('npx tsc src/lib/brand-work.ts --outDir ' + out + ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck', { stdio: 'inherit' })
// Node wants the extension on a relative import; tsc leaves it off.
for (const f of readdirSync(out).filter(f => f.endsWith('.js'))) {
  const p = join(out, f)
  writeFileSync(p, readFileSync(p, 'utf8').replace(/from '(\.\/[^']+)'/g, "from '$1.js'"))
}
const { isBigBrand, workCount, keepInPlay, brandNames } = await import(pathToFileURL(join(out, 'brand-work.js')).href)

let n = 0
const t = (name, fn) => { fn(); n++; console.log('  ok — ' + name) }
const brand = (x = {}) => ({ name: 'Plain Co', aka: null, tier: null, liMembers: null, workPeople: null, ...x })

t('big = measured 500+, a parent company\'s brand, or the parent itself — not an established tier alone', () => {
  assert.equal(isBigBrand(brand({ tier: 'established' })), false, 'Notion imports default to established')
  assert.equal(isBigBrand(brand({ liMembers: 500 })), true)
  assert.equal(isBigBrand(brand({ liMembers: 499, tier: 'established' })), false)
  assert.equal(isBigBrand(brand({ name: 'Ketel One' })), true, 'a Diageo brand')
  assert.equal(isBigBrand(brand({ name: 'Diageo' })), true, 'the parent itself')
})
t('the brand\'s number: Leo\'s, else 10 big, 4 established, 3 elsewhere', () => {
  assert.equal(workCount(brand()), 3)
  assert.equal(workCount(brand({ tier: 'established' })), 4)
  assert.equal(workCount(brand({ tier: 'established', liMembers: 900 })), 10)
  assert.equal(workCount(brand({ workPeople: 1, liMembers: 900 })), 1, 'Leo\'s number wins')
})
const p = (id, title, x = {}) => ({ id, title, linkedinUrl: 'https://www.linkedin.com/in/' + id, email: null, fit: 50, ...x })
t('six buyers waiting at a brand that works three: three stay, three are next in line, best first', () => {
  const six = [p('mk1', 'Marketing Manager', { fit: 60 }), p('acct', 'Senior Accountant', { fit: 90 }), p('pp', 'Head of Partnerships', { fit: 40 }),
    p('ev', 'Events Lead'), p('mail', 'Director of Partnerships', { linkedinUrl: null, email: 'x@y.com' }), p('mk2', 'Brand Manager', { fit: 30 })]
  const { keep, next } = keepInPlay(six, 3, 0)
  assert.deepEqual(keep.map(x => x.id), ['pp', 'ev', 'mk1'], 'partnerships > events > marketing, LinkedIn before an email-only contact, a non-buyer last')
  assert.deepEqual(next.map(x => x.id), ['mk2', 'mail', 'acct'])
})
t('work 1 keeps one; people written to count first', () => {
  assert.equal(keepInPlay([p('a', 'CMO'), p('b', 'Brand Manager')], 1, 0).keep.length, 1)
  assert.deepEqual(keepInPlay([p('a', 'CMO'), p('b', 'Brand Manager')], 3, 2).keep.map(x => x.id), ['a'])
  assert.equal(keepInPlay([p('a', 'CMO')], 3, 5).keep.length, 0, 'never below nothing')
})
t('nobody in today\'s list is ever taken out — they count against the number', () => {
  const r = keepInPlay([p('t1', 'Accountant', { today: true }), p('t2', 'Clerk', { today: true }), p('pp', 'Partnerships Lead'), p('mk', 'Marketing Lead')], 3, 0)
  assert.deepEqual(r.keep.map(x => x.id), ['t1', 't2', 'pp'])
  assert.deepEqual(r.next.map(x => x.id), ['mk'])
  const over = keepInPlay([p('t1', 'CMO', { today: true }), p('t2', 'CMO', { today: true }), p('w', 'CMO')], 1, 0)
  assert.deepEqual([over.keep.length, over.next.map(x => x.id)], [2, ['w']], 'past the number already: today stays, the waiting one is next in line')
})
t('brand names include its other names', () => {
  assert.deepEqual(brandNames({ name: 'Liquid Death', aka: 'LD, Liquid Death Water' }), ['Liquid Death', 'LD', 'Liquid Death Water'])
})
console.log(n + ' brand-work tests passed')
