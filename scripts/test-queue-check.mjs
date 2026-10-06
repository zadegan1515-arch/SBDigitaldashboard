// scripts/test-queue-check.mjs — guards src/lib/queue-check.ts (Home →
// Today's send list: flag queued people who aren't buyers, offer a better
// person at the same brand). Run: node scripts/test-queue-check.mjs
import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const out = mkdtempSync(join(tmpdir(), 'qc-test-'))
execSync('npx tsc src/lib/queue-check.ts --outDir ' + out + ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck', { stdio: 'inherit' })
for (const f of readdirSync(out).filter(f => f.endsWith('.js'))) {
  const p = join(out, f)
  writeFileSync(p, readFileSync(p, 'utf8').replace(/from '(\.\/[^']+)'/g, "from '$1.js'"))
}
const { checkBrandQueue, personProblem } = await import(pathToFileURL(join(out, 'queue-check.js')).href)

let n = 0
const t = (name, fn) => { fn(); n++; console.log('  ok — ' + name) }
const o = (id, title, x = {}) => ({ contactId: id, name: id, title, linkedinUrl: 'https://www.linkedin.com/in/' + id, contacted: false, queued: false, ...x })

t('buyers pass, others are flagged with why', () => {
  assert.equal(personProblem('Director of Partnerships'), null)
  assert.equal(personProblem('Brand Manager'), null)
  assert.equal(personProblem('Founder & CEO'), null)
  assert.match(personProblem('Sales Associate'), /store staff/)
  assert.match(personProblem('Senior Accountant'), /not a marketing/)
  assert.match(personProblem('Marketing Student at NYU'), /student/)
  assert.match(personProblem(''), /no job title/)
})
t('a flagged person gets the best uncontacted buyer as replacement', () => {
  const [f] = checkBrandQueue([{ targetId: 't1', name: 'A', title: 'Senior Accountant' }],
    [o('mk', 'Marketing Manager'), o('pp', 'Head of Partnerships')])
  assert.match(f.problem, /not a marketing/)
  assert.equal(f.better.contactId, 'pp')
})
t('a marketing person is offered a partnerships replacement; partnerships never replaced', () => {
  const r = checkBrandQueue([{ targetId: 't1', name: 'A', title: 'Marketing Manager' }, { targetId: 't2', name: 'B', title: 'Sponsorship Lead' }],
    [o('pp', 'Partnerships Director')])
  assert.equal(r[0].problem, null); assert.equal(r[0].better.contactId, 'pp'); assert.match(r[0].better.why, /partnerships beats marketing/)
  assert.equal(r[1].better, null)
})
t('contacted, already queued, no-link or non-buyer people are never offered', () => {
  const [f] = checkBrandQueue([{ targetId: 't1', name: 'A', title: 'Cashier' }],
    [o('a', 'Partnerships', { contacted: true }), o('b', 'Partnerships', { queued: true }), o('c', 'Partnerships', { linkedinUrl: null }), o('d', 'Accountant')])
  assert.equal(f.better, null)
})
t('one candidate replaces one person; the weakest gets it', () => {
  const r = checkBrandQueue([{ targetId: 't1', name: 'A', title: 'Brand Manager' }, { targetId: 't2', name: 'B', title: 'Store Manager' }],
    [o('pp', 'VP Partnerships')])
  assert.equal(r[1].better.contactId, 'pp'); assert.equal(r[0].better, null)
})
console.log(n + ' queue-check tests passed')
