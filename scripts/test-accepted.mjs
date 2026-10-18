// node scripts/test-accepted.mjs — Home → Accepted on LinkedIn: who counts as
// accepted, which date the list sorts by, and the one-word stage (src/lib/accepted.ts).
import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const out = mkdtempSync(join(tmpdir(), 'accepted-test-'))
execSync('npx tsc src/lib/accepted.ts --outDir ' + out + ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck', { stdio: 'inherit' })
const { isAccepted, acceptedWhen, acceptedStage } = await import(pathToFileURL(join(out, 'accepted.js')).href)

let n = 0
function t(name, fn) { fn(); n++; console.log('  ok — ' + name) }

const D = (s) => new Date(s)
const base = {
  status: 'accepted', sentAt: D('2026-10-01T15:00:00Z'), repliedAt: null, updatedAt: D('2026-10-05T15:00:00Z'),
  dmSentAt: null, callAt: null, handDeclinedAt: null, acceptedAt: D('2026-10-03T15:00:00Z'),
  emailReply: false, contactStopped: false, brandStopped: false,
}
const r = (o) => ({ ...base, ...o })

t('accepted counts, with or without an invite date', () => {
  assert.equal(isAccepted(base), true)
  assert.equal(isAccepted(r({ sentAt: null })), true)
  assert.equal(isAccepted(r({ acceptedAt: null })), true)
})
t('an accept that was undone (back to sent) does not', () => {
  assert.equal(isAccepted(r({ status: 'sent' })), false)
  assert.equal(isAccepted(r({ status: 'withdrawn' })), false)
  assert.equal(isAccepted(r({ status: 'queued' })), false)
})
t('replied / converted / said no after an accept count', () => {
  for (const status of ['replied', 'converted', 'declined']) assert.equal(isAccepted(r({ status })), true, status)
})
t('a LinkedIn reply with no accept logged counts; an email-only reply does not', () => {
  assert.equal(isAccepted(r({ status: 'replied', acceptedAt: null })), true)
  assert.equal(isAccepted(r({ status: 'replied', acceptedAt: null, emailReply: true })), false)
  assert.equal(isAccepted(r({ status: 'replied', acceptedAt: null, sentAt: null })), false)
  assert.equal(isAccepted(r({ status: 'declined', acceptedAt: null })), false)
})
t('the date is the accept when logged, else the reply', () => {
  assert.deepEqual(acceptedWhen(base), { at: base.acceptedAt, kind: 'accepted' })
  assert.deepEqual(acceptedWhen(r({ acceptedAt: null })), { at: base.updatedAt, kind: 'accepted' })
  const rep = D('2026-10-07T15:00:00Z')
  assert.deepEqual(acceptedWhen(r({ status: 'replied', acceptedAt: null, repliedAt: rep })), { at: rep, kind: 'replied' })
  assert.deepEqual(acceptedWhen(r({ status: 'replied', repliedAt: rep })), { at: base.acceptedAt, kind: 'accepted' })
})
t('stage: stop beats everything, then said no, call, replied, messaged', () => {
  const now = D('2026-10-18T15:00:00Z')
  assert.equal(acceptedStage(r({ handDeclinedAt: now, status: 'replied' }), now).stage, 'stopped')
  assert.equal(acceptedStage(r({ contactStopped: true }), now).stage, 'stopped')
  assert.equal(acceptedStage(r({ brandStopped: true }), now).stage, 'stopped')
  assert.equal(acceptedStage(r({ status: 'declined' }), now).label, 'said no')
  assert.equal(acceptedStage(r({ callAt: D('2026-10-20T15:00:00Z'), status: 'replied' }), now).label, 'call booked')
  assert.equal(acceptedStage(r({ callAt: D('2026-10-10T15:00:00Z') }), now).label, 'had a call')
  assert.equal(acceptedStage(r({ status: 'converted' }), now).stage, 'converted')
  assert.equal(acceptedStage(r({ status: 'replied', dmSentAt: now }), now).stage, 'replied')
  assert.equal(acceptedStage(r({ dmSentAt: now }), now).stage, 'messaged')
  assert.equal(acceptedStage(base, now).label, 'accepted')
})

console.log(n + ' passed')
