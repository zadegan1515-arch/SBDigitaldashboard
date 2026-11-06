// node scripts/test-tracker.mjs — In talks → Every brand: where each person
// and each brand sits (Reached out → Accepted → Replied → Wants to continue →
// Email sent → In talks, or Out), Zach's rows and Elizabeth's, the list's
// order and the steps each person got through (src/lib/tracker.ts).
import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const out = mkdtempSync(join(tmpdir(), 'tracker-test-'))
execSync('npx tsc src/lib/tracker.ts --outDir ' + out + ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck', { stdio: 'inherit' })
for (const f of readdirSync(out).filter(f => f.endsWith('.js'))) {
  const p = join(out, f)
  writeFileSync(p, readFileSync(p, 'utf8').replace(/from '(\.\/[^']+)'/g, "from '$1.js'"))
}
const m = await import(pathToFileURL(join(out, 'tracker.js')).href)
const { zachStage, zachReached, repStage, repReached, brandStage, compareTracker, zachSteps, repSteps, STAGES, stageRank } = m

let n = 0
function t(name, fn) { fn(); n++; console.log('  ok — ' + name) }
const D = (s) => new Date(s)
// Friday Nov 6 2026, noon in New York.
const NOW = D('2026-11-06T17:00:00Z')

const Z = (o = {}) => ({
  status: 'sent', sentAt: null, repliedAt: null, updatedAt: D('2026-11-01T15:00:00Z'), acceptedAt: null, emailReply: false,
  emailedAt: null, machineEmailAt: null, dmSentAt: null, nudgedAt: null, wantsEmailAt: null, liPathAt: null, liSentAt: null,
  callAt: null, callBookedAt: null, declinedAt: null, skippedAt: null, contactStopped: false, brandStopped: false, ...o,
})
const R = (o = {}) => ({
  channel: 'email', status: 'sent', sentAt: null, acceptedAt: null, dmAt: null, followAt: null, repliedAt: null,
  callAt: null, callBookedAt: null, doneAt: null, ...o,
})
const zs = (o) => zachStage(Z(o), NOW)
const rs = (o) => repStage(R(o), NOW)

t('the steps, in order', () => {
  assert.deepEqual(STAGES.map(s => s.key), ['reached', 'accepted', 'replied', 'continue', 'emailed', 'talks', 'out'])
  assert.ok(stageRank('emailed') > stageRank('continue') && stageRank('out') < stageRank('reached'))
})

t('reached = the Reached tag’s rule', () => {
  assert.equal(zachReached(Z({ status: 'queued' })), false)
  assert.equal(zachReached(Z({ status: 'drafted' })), false)
  assert.equal(zachReached(Z({ sentAt: D('2026-11-02T15:00:00Z') })), true)
  assert.equal(zachReached(Z({ status: 'accepted' })), true)          // logged from LinkedIn, no invite date
  assert.equal(zachReached(Z({ status: 'queued', emailedAt: D('2026-11-02T15:00:00Z') })), true)
  assert.equal(zachReached(Z({ status: 'queued', machineEmailAt: D('2026-11-02T15:00:00Z') })), true)
  assert.equal(repReached(R({ status: 'queued' })), false)
  assert.equal(repReached(R({ sentAt: D('2026-11-02T15:00:00Z') })), true)
})

t('an invite with no answer is Reached out', () => {
  const s = zs({ sentAt: D('2026-11-02T15:00:00Z') })
  assert.equal(s.stage, 'reached'); assert.equal(s.label, 'invited'); assert.equal(s.onUs, false)
  assert.equal(s.next, 'Invite sent Nov 2 — no answer yet')
  const w = zs({ status: 'withdrawn', sentAt: D('2026-10-02T15:00:00Z') })
  assert.equal(w.stage, 'reached'); assert.equal(w.label, 'invite withdrawn'); assert.equal(w.next, 'Invite from Oct 2 withdrawn')
  const e = zs({ status: 'queued', emailedAt: D('2026-11-03T15:00:00Z') })
  assert.equal(e.stage, 'reached'); assert.equal(e.label, 'emailed'); assert.equal(e.next, 'Emailed Nov 3 — no answer yet')
})

t('accepted: text them 2 days later on a Tue–Thu, then the final, then No response', () => {
  const due = zs({ status: 'accepted', sentAt: D('2026-10-28T15:00:00Z'), acceptedAt: D('2026-11-02T15:00:00Z') })
  assert.equal(due.stage, 'accepted'); assert.equal(due.onUs, true); assert.equal(due.due, '2026-11-04'); assert.equal(due.next, 'Text them on LinkedIn')
  const soon = zs({ status: 'accepted', acceptedAt: D('2026-11-05T15:00:00Z') })   // Sat Nov 7 → Tue Nov 10
  assert.equal(soon.onUs, false); assert.equal(soon.due, '2026-11-10'); assert.equal(soon.next, 'Text them Tue, Nov 10')
  const msg = zs({ status: 'accepted', acceptedAt: D('2026-11-02T15:00:00Z'), dmSentAt: D('2026-11-03T15:00:00Z') })
  assert.equal(msg.label, 'messaged'); assert.equal(msg.onUs, false); assert.equal(msg.next, 'Messaged Nov 3 — waiting')
  const fin = zs({ status: 'accepted', acceptedAt: D('2026-10-15T15:00:00Z'), dmSentAt: D('2026-10-20T15:00:00Z') })
  assert.equal(fin.onUs, true); assert.equal(fin.next, 'Send the final reach-out')
  const wait = zs({ status: 'accepted', acceptedAt: D('2026-10-15T15:00:00Z'), dmSentAt: D('2026-10-20T15:00:00Z'), nudgedAt: D('2026-11-03T15:00:00Z') })
  assert.equal(wait.stage, 'accepted'); assert.equal(wait.label, 'final reach-out sent'); assert.equal(wait.onUs, false)
  const quiet = zs({ status: 'accepted', acceptedAt: D('2026-10-01T15:00:00Z'), dmSentAt: D('2026-10-05T15:00:00Z'), nudgedAt: D('2026-10-25T15:00:00Z') })
  assert.equal(quiet.stage, 'out'); assert.equal(quiet.out, 'quiet')
})

t('an accept logged with no date counts from the row', () => {
  const s = zs({ status: 'accepted', updatedAt: D('2026-10-20T15:00:00Z') })
  assert.equal(s.stage, 'accepted'); assert.equal(s.onUs, true)
  assert.equal(s.lastAt.toISOString(), '2026-10-20T15:00:00.000Z')
})

t('replied → how do they want to continue', () => {
  const s = zs({ status: 'replied', sentAt: D('2026-10-28T15:00:00Z'), acceptedAt: D('2026-10-30T15:00:00Z'), repliedAt: D('2026-11-04T15:00:00Z') })
  assert.equal(s.stage, 'replied'); assert.equal(s.onUs, true)
  assert.equal(s.next, 'Find out how they want to continue — email or LinkedIn')
  const byEmail = zs({ status: 'replied', machineEmailAt: D('2026-10-28T15:00:00Z'), emailReply: true, repliedAt: D('2026-11-04T15:00:00Z') })
  assert.equal(byEmail.stage, 'replied'); assert.equal(byEmail.label, 'replied by email')
  const skip = zs({ status: 'replied', sentAt: D('2026-10-28T15:00:00Z'), repliedAt: D('2026-11-04T15:00:00Z'), skippedAt: D('2026-11-05T15:00:00Z') })
  assert.equal(skip.stage, 'replied'); assert.equal(skip.onUs, false)
})

t('wants to continue → the email (or DM) to send, then Email sent', () => {
  const base = { status: 'replied', sentAt: D('2026-10-28T15:00:00Z'), acceptedAt: D('2026-10-30T15:00:00Z'), repliedAt: D('2026-11-03T15:00:00Z') }
  const e = zs({ ...base, wantsEmailAt: D('2026-11-03T16:00:00Z') })
  assert.equal(e.stage, 'continue'); assert.equal(e.label, 'wants an email'); assert.equal(e.onUs, true); assert.equal(e.next, 'Send them the email')
  const d = zs({ ...base, liPathAt: D('2026-11-03T16:00:00Z') })
  assert.equal(d.stage, 'continue'); assert.equal(d.label, 'wants a LinkedIn DM')
  const sent = zs({ ...base, wantsEmailAt: D('2026-11-03T16:00:00Z'), emailedAt: D('2026-11-04T15:00:00Z') })
  assert.equal(sent.stage, 'emailed'); assert.equal(sent.onUs, false); assert.equal(sent.next, 'Emailed Nov 4 — book the call')
  // Both paths: the one still to send keeps them at Wants to continue.
  const both = zs({ ...base, wantsEmailAt: D('2026-11-03T16:00:00Z'), emailedAt: D('2026-11-04T15:00:00Z'), liPathAt: D('2026-11-03T16:00:00Z') })
  assert.equal(both.stage, 'continue')
  // A hand email after an accept means they asked for it.
  const acc = zs({ status: 'accepted', acceptedAt: D('2026-10-30T15:00:00Z'), emailedAt: D('2026-11-02T15:00:00Z') })
  assert.equal(acc.stage, 'emailed')
})

t('a call booked is In talks; no, stopped, dead are Out', () => {
  const up = zs({ status: 'replied', repliedAt: D('2026-11-02T15:00:00Z'), callAt: D('2026-11-12T16:00:00Z'), callBookedAt: D('2026-11-04T15:00:00Z') })
  assert.equal(up.stage, 'talks'); assert.equal(up.label, 'call booked'); assert.equal(up.next, 'Call Nov 12')
  const had = zs({ status: 'replied', callAt: D('2026-11-02T16:00:00Z'), callBookedAt: D('2026-10-30T15:00:00Z') })
  assert.equal(had.label, 'had a call'); assert.equal(had.next, 'Had a call Nov 2')
  assert.equal(zs({ status: 'converted', sentAt: D('2026-10-02T15:00:00Z') }).stage, 'talks')
  assert.equal(zs({ status: 'declined', sentAt: D('2026-10-02T15:00:00Z') }).out, 'no')
  assert.equal(zs({ status: 'accepted', declinedAt: D('2026-11-02T15:00:00Z') }).out, 'stopped')
  assert.equal(zs({ status: 'replied', contactStopped: true }).out, 'stopped')
  assert.equal(zs({ status: 'sent', sentAt: D('2026-10-02T15:00:00Z'), brandStopped: true }).out, 'stopped')
  // "Doesn't want to continue" wins over a call they had booked.
  assert.equal(zs({ status: 'replied', callAt: D('2026-11-12T16:00:00Z'), declinedAt: D('2026-11-05T15:00:00Z') }).out, 'stopped')
  assert.equal(zs({ status: 'dead', machineEmailAt: D('2026-09-02T15:00:00Z') }).out, 'quiet')
})

t('Elizabeth’s rows', () => {
  const fresh = rs({ sentAt: D('2026-11-02T15:00:00Z') })                // follow-up due Tue Nov 10
  assert.equal(fresh.stage, 'reached'); assert.equal(fresh.onUs, false); assert.equal(fresh.next, 'Emailed Nov 2 — no answer yet')
  const fol = rs({ sentAt: D('2026-10-27T15:00:00Z') })                  // due Sat Oct 31 → Tue Nov 3
  assert.equal(fol.stage, 'reached'); assert.equal(fol.onUs, true); assert.equal(fol.next, 'Send a follow-up email')
  assert.equal(rs({ sentAt: D('2026-10-14T15:00:00Z'), followAt: D('2026-10-20T15:00:00Z') }).out, 'quiet')
  const acc = rs({ channel: 'linkedin', status: 'accepted', sentAt: D('2026-10-28T15:00:00Z'), acceptedAt: D('2026-11-02T15:00:00Z') })
  assert.equal(acc.stage, 'accepted'); assert.equal(acc.onUs, true)
  const inv = rs({ channel: 'linkedin', sentAt: D('2026-11-02T15:00:00Z') })
  assert.equal(inv.stage, 'reached'); assert.equal(inv.label, 'invited')
  const rep = rs({ status: 'replied', sentAt: D('2026-10-28T15:00:00Z'), repliedAt: D('2026-11-04T15:00:00Z') })
  assert.equal(rep.stage, 'replied'); assert.equal(rep.onUs, true); assert.equal(rep.next, 'They replied to Elizabeth — book a call')
  assert.equal(rs({ status: 'call', callAt: D('2026-11-12T16:00:00Z') }).stage, 'talks')
  assert.equal(rs({ status: 'declined', sentAt: D('2026-10-28T15:00:00Z') }).out, 'stopped')
})

const F = (o = {}) => ({ stopped: false, talksOn: false, talksWhy: null, deal: null, ...o })
const P = (o) => zachStage(Z(o), NOW)
const invited = P({ sentAt: D('2026-11-02T15:00:00Z') })
const accepted = P({ status: 'accepted', acceptedAt: D('2026-11-03T15:00:00Z') })    // text them Thu Nov 5 — due
const saidNo = P({ status: 'declined', sentAt: D('2026-10-02T15:00:00Z') })
const quiet = P({ status: 'accepted', acceptedAt: D('2026-10-01T15:00:00Z'), dmSentAt: D('2026-10-05T15:00:00Z'), nudgedAt: D('2026-10-25T15:00:00Z') })
const call = P({ status: 'replied', repliedAt: D('2026-11-02T15:00:00Z'), callAt: D('2026-11-12T16:00:00Z'), callBookedAt: D('2026-11-04T15:00:00Z') })

t('a brand sits at the furthest step anyone still in play is on', () => {
  const b = brandStage([invited, accepted, saidNo], F(), NOW)
  assert.equal(b.stage, 'accepted'); assert.equal(b.lead, 1); assert.equal(b.onUs, true); assert.equal(b.next, 'Text them on LinkedIn')
  assert.equal(brandStage([invited], F(), NOW).stage, 'reached')
})

t('everyone out → Out, for the strongest reason', () => {
  const b = brandStage([quiet, saidNo], F(), NOW)
  assert.equal(b.stage, 'out'); assert.equal(b.out, 'no'); assert.equal(b.lead, 1)
  assert.equal(brandStage([quiet], F(), NOW).out, 'quiet')
  // One gone quiet, another still invited: still Reached out.
  assert.equal(brandStage([quiet, invited], F(), NOW).stage, 'reached')
  assert.equal(brandStage([accepted, invited], F({ stopped: true }), NOW).out, 'stopped')
})

t('In talks: a call, a hand add or an open deal', () => {
  const b = brandStage([invited, call], F({ talksOn: true, talksWhy: 'call' }), NOW)
  assert.equal(b.stage, 'talks'); assert.equal(b.next, 'Call Nov 12'); assert.equal(b.nextCallAt.toISOString(), '2026-11-12T16:00:00.000Z'); assert.equal(b.lead, 1)
  const hand = brandStage([invited], F({ talksOn: true, talksWhy: 'hand' }), NOW)
  assert.equal(hand.stage, 'talks'); assert.equal(hand.next, 'Added to In talks'); assert.equal(hand.lead, 0)
  const deal = brandStage([accepted], F({ deal: { stage: 'proposal' } }), NOW)
  assert.equal(deal.stage, 'talks'); assert.equal(deal.next, 'Deal · proposal sent')
  assert.equal(brandStage([accepted], F({ deal: { stage: 'lost' } }), NOW).out, 'lost')
  assert.equal(brandStage([call], F({ talksOn: true, deal: { stage: 'lost' } }), NOW).stage, 'talks')
})

t('a call on a brand taken off In talks: taken off, unless someone else is still going', () => {
  assert.equal(brandStage([call], F(), NOW).out, 'removed')
  const b = brandStage([call, accepted], F(), NOW)
  assert.equal(b.stage, 'accepted'); assert.equal(b.lead, 1)
})

t('the list: ours to do first, calls soonest, then the latest', () => {
  const row = (name, o) => ({ name, stage: 'accepted', onUs: false, due: null, lastAt: null, nextCallAt: null, ...o })
  const rows = [
    row('Late', { lastAt: D('2026-11-01T00:00:00Z') }),
    row('Recent', { lastAt: D('2026-11-05T00:00:00Z') }),
    row('Ours newer due', { onUs: true, due: '2026-11-05' }),
    row('Ours older due', { onUs: true, due: '2026-11-02' }),
    row('Call soon', { nextCallAt: D('2026-11-09T00:00:00Z') }),
    row('Call later', { nextCallAt: D('2026-11-20T00:00:00Z') }),
  ]
  assert.deepEqual(rows.sort(compareTracker).map(r => r.name), ['Ours older due', 'Ours newer due', 'Call soon', 'Call later', 'Recent', 'Late'])
})

t('the steps a person got through', () => {
  assert.deepEqual(zachSteps(Z({ sentAt: D('2026-11-02T15:00:00Z') })), ['reached'])
  assert.deepEqual(zachSteps(Z({ status: 'replied', sentAt: D('2026-10-28T15:00:00Z'), acceptedAt: D('2026-10-30T15:00:00Z'), repliedAt: D('2026-11-03T15:00:00Z'),
    wantsEmailAt: D('2026-11-03T16:00:00Z'), emailedAt: D('2026-11-04T15:00:00Z'), callAt: D('2026-11-12T16:00:00Z') })),
    ['reached', 'accepted', 'replied', 'continue', 'emailed', 'talks'])
  // Said no after accepting: got as far as accepted.
  assert.deepEqual(zachSteps(Z({ status: 'declined', sentAt: D('2026-10-28T15:00:00Z'), acceptedAt: D('2026-10-30T15:00:00Z') })), ['reached', 'accepted'])
  // A cold email isn't Email sent.
  assert.deepEqual(zachSteps(Z({ status: 'queued', emailedAt: D('2026-11-04T15:00:00Z') })), ['reached'])
  assert.deepEqual(repSteps(R({ channel: 'linkedin', status: 'call', sentAt: D('2026-10-28T15:00:00Z'), acceptedAt: D('2026-10-30T15:00:00Z'), callAt: D('2026-11-12T16:00:00Z') })),
    ['reached', 'accepted', 'replied', 'talks'])
})

console.log(`\n${n} passed`)
