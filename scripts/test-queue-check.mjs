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
const { checkBrandQueue, personProblem, comparePicks, sortPicks, leaveOutFlagged, buyerRank } = await import(pathToFileURL(join(out, 'queue-check.js')).href)

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
t('pick order: a buyer, then a LinkedIn link, then partnerships > events > marketing = founder, then fit, then email (picks, Oct 12 2026)', () => {
  const li = 'https://www.linkedin.com/in/x'
  const ppl = [
    { id: 'acct', title: 'Senior Accountant', linkedinUrl: li, fit: 99 },
    { id: 'mailPP', title: 'VP Partnerships', linkedinUrl: null, email: 'a@b.co', fit: 90 },
    { id: 'mk', title: 'Marketing Manager', linkedinUrl: li, fit: 70 },
    { id: 'fd', title: 'Founder', linkedinUrl: li, fit: 70, email: 'f@b.co' },
    { id: 'ev', title: 'Experiential Marketing Lead', linkedinUrl: li, fit: 10 },
    { id: 'pp', title: 'Head of Partnerships', linkedinUrl: li, fit: 20 },
  ]
  assert.deepEqual(sortPicks(ppl).map(x => x.id), ['pp', 'ev', 'fd', 'mk', 'mailPP', 'acct'])
  assert.deepEqual([buyerRank('Partnerships'), buyerRank('Events'), buyerRank('Brand Manager'), buyerRank('CEO'), buyerRank('Accountant')], [3, 2, 1, 1, 0])
  assert.ok(comparePicks({ title: 'CMO', linkedinUrl: li, fit: 50 }, { title: 'CMO', linkedinUrl: li, fit: 50 }) === 0, 'equal people tie')
  assert.deepEqual(sortPicks([{ id: 'a', title: 'CMO' }, { id: 'b', title: 'CMO' }]).map(x => x.id), ['a', 'b'], 'stable')
})
t('flagged people stay out while anyone unflagged is reachable — waiting or already in play', () => {
  const c = [{ title: 'Accountant' }, { title: 'Brand Manager' }, { title: '' }]
  assert.deepEqual(leaveOutFlagged(c, undefined, false).map(x => x.title), ['Brand Manager'])
  assert.deepEqual(leaveOutFlagged([{ title: 'Accountant' }], undefined, true), [], 'a buyer in play: no flagged filler on the next load')
  assert.deepEqual(leaveOutFlagged([{ title: 'Accountant' }], undefined, false).length, 1, 'nobody else: a worse door beats no door')
})
console.log(n + ' queue-check tests passed')
