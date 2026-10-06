// node scripts/test-buyers.mjs — who counts as a buyer on the Brands table.
import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const out = mkdtempSync(join(tmpdir(), 'buyers-test-'))
execSync('npx tsc src/lib/buyers.ts --outDir ' + out + ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck', { stdio: 'inherit' })
const { buyerKind, isBuyerTitle, countBuyers } = await import(pathToFileURL(join(out, 'buyers.js')).href)

let n = 0
function t(name, fn) { fn(); n++; console.log('  ok — ' + name) }

t('partnerships / sponsorship titles', () => {
  for (const s of ['Brand Partnerships Manager', 'Director of Sponsorships', 'Head of Strategic Alliances', 'Business Development Lead', 'Sr. Manager, Partnership Marketing'])
    assert.equal(buyerKind(s), 'partnerships', s)
})
t('events / experiential titles', () => {
  for (const s of ['Experiential Marketing Manager', 'Events Coordinator', 'Field Marketing Manager', 'Campus Ambassador Program Lead', 'Director, College Marketing'])
    assert.equal(buyerKind(s), 'events', s)
})
t('marketing / brand titles', () => {
  for (const s of ['Brand Manager', 'VP Marketing', 'CMO', 'Head of Growth', 'Social Media Manager', 'Director of Communications'])
    assert.equal(buyerKind(s), 'marketing', s)
})
t('founder / CEO titles', () => {
  for (const s of ['Co-Founder', 'Founder & CEO', 'Chief Executive Officer', 'Owner', 'President', 'General Manager'])
    assert.equal(buyerKind(s), 'founder', s)
})
t('a vice president is not the president', () => {
  assert.equal(buyerKind('Vice President, Finance'), null)
  assert.equal(buyerKind('VP of Sales Operations'), null)
})
t('not buyers', () => {
  for (const s of ['', null, undefined, 'Software Engineer', 'Accountant', 'Marketing Intern', 'Former Brand Manager', 'People Partner', 'Supply Chain Analyst', 'Student at NYU'])
    assert.equal(isBuyerTitle(s), false, String(s))
})
t('counts per kind and total', () => {
  const c = countBuyers(['Brand Partnerships Manager', 'Brand Manager', 'Founder', 'Engineer', null, 'Events Lead'])
  assert.deepEqual(c, { partnerships: 1, events: 1, marketing: 1, founder: 1, total: 4 })
})

console.log(n + ' buyer tests passed')
