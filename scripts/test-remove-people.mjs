// scripts/test-remove-people.mjs — guards src/lib/remove-people.ts: who may
// be taken off a brand for good and who stays (Leo, Nov 18 2026: the pouch
// brand Rogue had Rogue Fitness's people on it — "remove them").
// Run: node scripts/test-remove-people.mjs
import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const out = mkdtempSync(join(tmpdir(), 'remove-people-test-'))
execSync('npx tsc src/lib/remove-people.ts src/lib/claude-day.ts --outDir ' + out + ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck', { stdio: 'inherit' })
for (const f of readdirSync(out).filter(f => f.endsWith('.js'))) {
  const p = join(out, f)
  writeFileSync(p, readFileSync(p, 'utf8').replace(/from '(\.\/[^']+)'/g, "from '$1.js'"))
}
const { stayWhy, sortRemoval, removalSig, standingText, readRemovalLog, alreadyBack, emailIsHistory, STAY_TEXT } = await import(pathToFileURL(join(out, 'remove-people.js')).href)
const { actionText } = await import(pathToFileURL(join(out, 'claude-day.js')).href)

let n = 0
const t = (name, fn) => { fn(); n++; console.log('  ok — ' + name) }
const row = (x = {}) => ({
  status: 'queued', sentAt: null, emailedAt: null, dmSentAt: null, repliedAt: null, handDeclinedAt: null,
  callAt: null, callBookedAt: null, emails: 0, emailDrafts: 0, instantly: false, drafts: 0, shelved: false, ...x,
})
const person = (id, x = {}, targets = [row()]) => ({ id, name: 'Person ' + id, title: 'Owner', doNotContactAt: null, repOutreach: 0, targets, ...x })
const day = new Date('2026-11-12T15:00:00Z')

t('someone waiting in the queue, drafted, set aside or with no row at all can go', () => {
  assert.equal(stayWhy(person('a')), null)
  assert.equal(stayWhy(person('b', {}, [row({ status: 'drafted', drafts: 2 })])), null)
  assert.equal(stayWhy(person('c', {}, [row({ status: 'passed' })])), null)
  assert.equal(stayWhy(person('d', {}, [row({ shelved: true })])), null)
  assert.equal(stayWhy(person('e', {}, [])), null)
})

t('someone who said they don’t want to continue never goes — the no stays on file', () => {
  assert.equal(stayWhy(person('a', { doNotContactAt: day })), 'stopped')
  assert.equal(stayWhy(person('b', {}, [row({ status: 'accepted', sentAt: day, handDeclinedAt: day })])), 'stopped', 'the stop wins over reached')
})

t('anyone written to stays: an invite, an accept logged without a date, a DM, a reply, a hand email', () => {
  assert.equal(stayWhy(person('a', {}, [row({ status: 'sent', sentAt: day })])), 'reached')
  assert.equal(stayWhy(person('b', {}, [row({ status: 'accepted' })])), 'reached', 'accepted outside the queue has no sentAt')
  assert.equal(stayWhy(person('c', {}, [row({ status: 'withdrawn', sentAt: day })])), 'reached', 'a withdrawn invite still went out')
  assert.equal(stayWhy(person('d', {}, [row({ dmSentAt: day })])), 'reached')
  assert.equal(stayWhy(person('e', {}, [row({ repliedAt: day })])), 'reached')
  assert.equal(stayWhy(person('f', {}, [row({ emailedAt: day })])), 'reached')
  assert.equal(stayWhy(person('g', {}, [row({ status: 'declined' })])), 'reached', 'a no is history too')
})

t('a call, emails on file, an Instantly hand-over and Elizabeth’s list each keep the person', () => {
  assert.equal(stayWhy(person('a', {}, [row({ callBookedAt: day })])), 'call')
  assert.equal(stayWhy(person('b', {}, [row({ emails: 1 })])), 'emails', 'an email that went out or came in')
  assert.equal(stayWhy(person('b2', {}, [row({ status: 'drafted', emailDrafts: 1 })])), null, 'a draft that never went out keeps nobody (Kasey Strickland at Rogue)')
  assert.equal(emailIsHistory({ direction: 'out', status: 'draft', sentAt: null }), false)
  assert.equal(emailIsHistory({ direction: 'out', status: 'approved', sentAt: null }), false)
  assert.equal(emailIsHistory({ direction: 'out', status: 'failed', sentAt: null }), false)
  assert.equal(emailIsHistory({ direction: 'out', status: 'sent', sentAt: null }), true)
  assert.equal(emailIsHistory({ direction: 'out', status: 'draft', sentAt: day }), true)
  assert.equal(emailIsHistory({ direction: 'in', status: 'received', sentAt: null }), true)
  assert.equal(stayWhy(person('c', {}, [row({ instantly: true })])), 'instantly')
  assert.equal(stayWhy(person('d', { repOutreach: 1 })), 'elizabeth')
  for (const k of ['stopped', 'reached', 'call', 'emails', 'instantly', 'elizabeth']) assert.ok(STAY_TEXT[k], k + ' has words')
})

t('the preview sorts who goes and who stays, each id once, and names ids that aren’t at the brand', () => {
  const rows = [person('a', {}, [row({ status: 'drafted', drafts: 2, emailDrafts: 1 })]), person('b', {}, [row({ status: 'sent', sentAt: day })]), person('c', {}, [])]
  const r = sortRemoval(['a', 'b', 'c', 'a', 'zz'], rows)
  assert.deepEqual(r.go.map(g => g.id), ['a', 'c'])
  assert.equal(r.go[0].standing, 'in the queue, note drafted')
  assert.equal(r.go[0].drafts, 2)
  assert.equal(r.go[0].emailDrafts, 1, 'the unsent email is named as going with them')
  assert.equal(r.go[1].standing, 'not in the queue')
  assert.deepEqual(r.stay.map(s => [s.id, s.why]), [['b', 'reached']])
  assert.deepEqual(r.missing, ['zz'])
  assert.equal(standingText(person('p', {}, [row({ status: 'passed' })])), 'left out of the queue')
  assert.equal(standingText(person('q', {}, [row({ shelved: true })])), 'next in line')
})

t('the stamp is the brand and exactly who goes, in any order — a change since the preview is stale', () => {
  const a = removalSig('brand1', [{ id: 'x' }, { id: 'y' }])
  assert.equal(a, removalSig('brand1', [{ id: 'y' }, { id: 'x' }]))
  assert.notEqual(a, removalSig('brand1', [{ id: 'x' }]), 'one was invited since')
  assert.notEqual(a, removalSig('brand2', [{ id: 'x' }, { id: 'y' }]))
})

t('Undo: someone on the brand again already isn’t made twice — same profile, or same name with no link', () => {
  const slug = u => (String(u || '').match(/\/in\/([^/?#]+)/) || [])[1]?.toLowerCase() || null
  const now = [{ name: 'Bill Henniger', linkedinUrl: 'https://www.linkedin.com/in/BillH/' }, { name: 'No Link', linkedinUrl: null }]
  assert.equal(alreadyBack({ name: 'William Henniger', linkedinUrl: 'https://linkedin.com/in/billh' }, now, slug), true, 'same profile, another spelling')
  assert.equal(alreadyBack({ name: 'Bill Henniger', linkedinUrl: 'https://linkedin.com/in/someone-else' }, now, slug), false, 'two links that differ are two people')
  assert.equal(alreadyBack({ name: 'no link', linkedinUrl: null }, now, slug), true)
  assert.equal(alreadyBack({ name: 'Brand New', linkedinUrl: null }, now, slug), false)
  assert.equal(readRemovalLog(null), null)
  assert.equal(readRemovalLog({ brandId: 'b', people: 'x' }), null)
  assert.equal(readRemovalLog({ brandId: 'b', brandName: 'B', at: 'now', by: 'CLI', people: [] }).brandId, 'b')
})

t('Claude’s day words a removal and its Undo, and never a preview or a stale answer', () => {
  assert.equal(actionText('removePeople', { brandId: 'b', contactIds: ['a'] }, { preview: true, brand: { name: 'Rogue' } }), null)
  assert.equal(actionText('removePeople', { brandId: 'b', confirm: true }, { stale: true, brand: { name: 'Rogue' } }), null)
  assert.equal(actionText('removePeople', { brandId: 'b', confirm: true }, { ok: false, removed: 0 }), null)
  assert.equal(
    actionText('removePeople', { brandId: 'b', confirm: true, expect: 'x' }, { ok: true, removed: 2, brand: { id: 'b', name: 'Rogue' }, people: ['Bill Henniger', 'Tom Johnson'] }),
    'Removed 2 people from Rogue (Bill Henniger, Tom Johnson)')
  assert.equal(actionText('undoRemovePeople', {}, { preview: true }), null)
  assert.equal(actionText('undoRemovePeople', { confirm: true }, { ok: true, back: 1, brand: { name: 'Rogue' } }), 'Put 1 person back on Rogue')
})

console.log(`remove-people: all ${n} passed`)
