// node scripts/test-in-talks.mjs — In talks: who's in (a call booked, a reply
// or a hand add, a removal wins over anything older), the stage (Nov 8 2026:
// set by hand or read from what happened), the log's days, the people
// shown, the journey line, the list's order, link cleanup, the 4-sentence
// overview check and what Claude's daily check still fills (src/lib/in-talks.ts).
import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const out = mkdtempSync(join(tmpdir(), 'in-talks-test-'))
execSync('npx tsc src/lib/in-talks.ts --outDir ' + out + ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck', { stdio: 'inherit' })
// Node's ESM loader wants the .js on sibling imports (./accepted).
for (const f of readdirSync(out)) {
  const p = join(out, f)
  writeFileSync(p, readFileSync(p, 'utf8').replace(/from '(\.\/[^']+)'/g, "from '$1.js'"))
}
const m = await import(pathToFileURL(join(out, 'in-talks.js')).href)
const { talksState, suggestTalks, isTalksPerson, talksPersonStage, stageRank, talksJourney, compareTalks, cleanLink, socialHandle, sentenceCount, missingFields,
  TALKS_STAGES, TALKS_ENDS, isTalksStage, talksStageRank, DEAL_OF_STAGE, autoStageMarks, currentTalksStage, stageDates, logMoment, isLogKind } = m

let n = 0
function t(name, fn) { fn(); n++; console.log('  ok — ' + name) }
const D = (s) => new Date(s)

t('a call booked puts a brand in by itself', () => {
  const s = talksState({ addedAt: null, removedAt: null, callsBooked: [D('2026-10-14T15:00:00Z')] })
  assert.deepEqual(s, { on: true, why: 'call', since: D('2026-10-14T15:00:00Z') })
})
t('a hand add puts any brand in', () => {
  const s = talksState({ addedAt: D('2026-10-18T12:00:00Z'), removedAt: null, callsBooked: [] })
  assert.equal(s.on, true); assert.equal(s.why, 'hand')
})
t('nothing = not in', () => {
  assert.equal(talksState({ addedAt: null, removedAt: null, callsBooked: [] }).on, false)
})
t('taking it off wins over an older call or add', () => {
  const s = talksState({ addedAt: D('2026-10-10T12:00:00Z'), removedAt: D('2026-10-15T12:00:00Z'), callsBooked: [D('2026-10-12T12:00:00Z')] })
  assert.equal(s.on, false)
})
t('a newer call or add brings it back; since = the first thing after the removal', () => {
  const s = talksState({ addedAt: D('2026-10-17T12:00:00Z'), removedAt: D('2026-10-15T12:00:00Z'), callsBooked: [D('2026-10-12T12:00:00Z'), D('2026-10-16T12:00:00Z')] })
  assert.deepEqual(s, { on: true, why: 'call', since: D('2026-10-16T12:00:00Z') })
  const h = talksState({ addedAt: D('2026-10-17T12:00:00Z'), removedAt: D('2026-10-15T12:00:00Z'), callsBooked: [D('2026-10-12T12:00:00Z')] })
  assert.deepEqual(h, { on: true, why: 'hand', since: D('2026-10-17T12:00:00Z') })
})
t('replied brands are offered until added, Not now, or stopped; a newer reply offers again', () => {
  const base = { replies: [D('2026-10-10T12:00:00Z')], removedAt: null, on: false, stopped: false }
  assert.equal(suggestTalks(base), true)
  assert.equal(suggestTalks({ ...base, on: true }), false)
  assert.equal(suggestTalks({ ...base, stopped: true }), false)
  assert.equal(suggestTalks({ ...base, removedAt: D('2026-10-11T12:00:00Z') }), false)
  assert.equal(suggestTalks({ ...base, removedAt: D('2026-10-09T12:00:00Z') }), true)
  assert.equal(suggestTalks({ ...base, replies: [] }), false)
})

const p0 = {
  status: 'accepted', sentAt: D('2026-10-01T15:00:00Z'), repliedAt: null, updatedAt: D('2026-10-05T15:00:00Z'),
  dmSentAt: null, callAt: null, callBookedAt: null, handDeclinedAt: null, acceptedAt: D('2026-10-03T15:00:00Z'),
  emailReply: false, contactStopped: false, brandStopped: false,
}
const p = (o) => ({ ...p0, ...o })
t('people shown: accepted, replied anywhere (email too), or a call booked', () => {
  assert.equal(isTalksPerson(p0), true)
  assert.equal(isTalksPerson(p({ status: 'replied', acceptedAt: null, sentAt: null, emailReply: true, repliedAt: D('2026-10-04T15:00:00Z') })), true)
  assert.equal(isTalksPerson(p({ status: 'sent', acceptedAt: null })), false)
  assert.equal(isTalksPerson(p({ status: 'sent', acceptedAt: null, callAt: D('2026-10-20T15:00:00Z') })), true)
  assert.equal(isTalksPerson(p({ status: 'queued', sentAt: null, acceptedAt: null })), false)
})
t('their stage word, and the furthest along first', () => {
  const now = D('2026-10-18T15:00:00Z')
  assert.equal(talksPersonStage(p({ callAt: D('2026-10-21T15:00:00Z') }), now).label, 'call booked')
  assert.equal(talksPersonStage(p({ callAt: D('2026-10-16T15:00:00Z') }), now).label, 'had a call')
  assert.equal(talksPersonStage(p({ status: 'replied' }), now).label, 'replied')
  assert.equal(talksPersonStage(p({ contactStopped: true }), now).stage, 'stopped')
  assert.ok(stageRank('call') < stageRank('replied') && stageRank('replied') < stageRank('accepted') && stageRank('accepted') < stageRank('stopped'))
})
t('the journey: each step with the first date anyone reached it', () => {
  const j = talksJourney([
    { invitedAt: D('2026-09-16T15:00:00Z'), acceptedAt: D('2026-09-16T19:00:00Z'), accepted: true, repliedAt: null, replied: false, callBookedAt: null, callAt: null },
    { invitedAt: D('2026-09-10T15:00:00Z'), acceptedAt: D('2026-09-20T19:00:00Z'), accepted: true, repliedAt: D('2026-10-01T12:00:00Z'), replied: true, callBookedAt: D('2026-10-02T12:00:00Z'), callAt: D('2026-10-16T15:00:00Z') },
  ], null)
  assert.deepEqual(j.map(s => s.done), [true, true, true, true, false])
  assert.equal(j[0].at.toISOString(), '2026-09-10T15:00:00.000Z')
  assert.equal(j[1].at.toISOString(), '2026-09-16T19:00:00.000Z')
  assert.equal(j[3].at.toISOString(), '2026-10-02T12:00:00.000Z')
  const withDeal = talksJourney([], { stage: 'proposal', createdAt: D('2026-10-17T12:00:00Z') })
  assert.equal(withDeal[4].done, true); assert.equal(withDeal[4].label, 'Deal · proposal')
  assert.equal(talksJourney([], { stage: 'lost', createdAt: D('2026-10-17T12:00:00Z') })[4].done, false)
})
t('the list: calls coming up first (soonest), then latest activity, stopped last', () => {
  const rows = [
    { name: 'Quiet', stopped: false, nextCallAt: null, lastAt: D('2026-10-01T00:00:00Z') },
    { name: 'Busy', stopped: false, nextCallAt: null, lastAt: D('2026-10-17T00:00:00Z') },
    { name: 'Later call', stopped: false, nextCallAt: D('2026-10-24T15:00:00Z'), lastAt: null },
    { name: 'Stopped', stopped: true, nextCallAt: D('2026-10-19T15:00:00Z'), lastAt: D('2026-10-18T00:00:00Z') },
    { name: 'Soon call', stopped: false, nextCallAt: D('2026-10-20T15:00:00Z'), lastAt: null },
  ]
  assert.deepEqual(rows.sort(compareTalks).map(r => r.name), ['Soon call', 'Later call', 'Busy', 'Quiet', 'Stopped'])
})
t('links: Instagram / TikTok from a handle, @handle or any link; websites get https', () => {
  assert.equal(cleanLink('instagram', '@drinkelectrolit'), 'https://www.instagram.com/drinkelectrolit/')
  assert.equal(cleanLink('instagram', 'instagram.com/garagebeerco?igsh=xyz'), 'https://www.instagram.com/garagebeerco/')
  assert.equal(cleanLink('instagram', 'https://www.instagram.com/drsquatch/'), 'https://www.instagram.com/drsquatch/')
  assert.equal(cleanLink('tiktok', 'https://www.tiktok.com/@drsquatch?lang=en'), 'https://www.tiktok.com/@drsquatch')
  assert.equal(cleanLink('tiktok', 'redbull'), 'https://www.tiktok.com/@redbull')
  assert.equal(cleanLink('website', 'electrolit.com'), 'https://electrolit.com')
  assert.equal(cleanLink('website', 'https://www.guruenergy.com/'), 'https://www.guruenergy.com')
})
t('links: empty = cleared (null), "none" = they have none (""), wrong links refused', () => {
  assert.equal(cleanLink('instagram', '  '), null)
  assert.equal(cleanLink('tiktok', 'none'), '')
  assert.throws(() => cleanLink('instagram', 'https://www.tiktok.com/@x'), /isn’t an Instagram link/)
  assert.throws(() => cleanLink('instagram', 'https://www.instagram.com/p/Cabc123/'), /account link/)
  assert.throws(() => cleanLink('website', 'not a site'), /web address/)
  assert.throws(() => cleanLink('website', 'instagram.com/x'), /social link/)
  assert.equal(socialHandle('https://www.tiktok.com/@drsquatch'), '@drsquatch')
  assert.equal(socialHandle('https://www.instagram.com/drinkelectrolit/'), '@drinkelectrolit')
  assert.equal(socialHandle(''), null)
})
t('sentences: abbreviations and numbers don’t split them', () => {
  assert.equal(sentenceCount('Dr. Squatch sells soap. It grew fast.'), 2)
  assert.equal(sentenceCount('High Noon is owned by E. & J. Gallo. It sold $1.2B in the U.S. last year.'), 2)
  assert.equal(sentenceCount('One. Two! Three? Four. Five.'), 5)
  assert.equal(sentenceCount('no stop at the end'), 1)
  assert.equal(sentenceCount(''), 0)
})
t('the daily check fills only what was never filled', () => {
  assert.deepEqual(missingFields({ overview: null, activationIdea: 'x', website: 'https://a.com', instagramUrl: '', tiktokUrl: null }), ['overview', 'tiktok'])
  assert.deepEqual(missingFields({ overview: 'a', activationIdea: 'b', website: 'c', instagramUrl: 'd', tiktokUrl: '' }), [])
})

// ---- Nov 8 2026: every brand that replied, the stage bar, the log ----
t('a reply puts a brand in by itself; taking it off wins until a newer reply', () => {
  assert.deepEqual(talksState({ addedAt: null, removedAt: null, callsBooked: [], replies: [D('2026-11-02T15:00:00Z')] }),
    { on: true, why: 'reply', since: D('2026-11-02T15:00:00Z') })
  assert.equal(talksState({ addedAt: null, removedAt: D('2026-11-03T00:00:00Z'), callsBooked: [], replies: [D('2026-11-02T15:00:00Z')] }).on, false)
  assert.equal(talksState({ addedAt: null, removedAt: D('2026-11-03T00:00:00Z'), callsBooked: [], replies: [D('2026-11-02T15:00:00Z'), D('2026-11-05T15:00:00Z')] }).on, true)
  // A call outranks a reply as the reason; since = the first of them.
  const s = talksState({ addedAt: null, removedAt: null, callsBooked: [D('2026-11-04T15:00:00Z')], replies: [D('2026-11-02T15:00:00Z')] })
  assert.equal(s.why, 'call')
  assert.deepEqual(s.since, D('2026-11-02T15:00:00Z'))
  // Without replies given (Every brand reached's own rule) a reply alone isn't in.
  assert.equal(talksState({ addedAt: null, removedAt: null, callsBooked: [] }).on, false)
})
t('stages: eight on the way, two ways out; from Proposal sent the deal moves', () => {
  assert.deepEqual(TALKS_STAGES.map(x => x.key), ['replied', 'call_booked', 'call_done', 'proposal', 'negotiating', 'verbal', 'contract', 'won'])
  assert.deepEqual(TALKS_ENDS.map(x => x.key), ['lost', 'quiet'])
  assert.ok(isTalksStage('quiet') && !isTalksStage('conversation'))
  assert.equal(talksStageRank('won'), 8)
  assert.equal(talksStageRank('lost'), 0)
  assert.equal(DEAL_OF_STAGE.replied, undefined)
  assert.equal(DEAL_OF_STAGE.negotiating, 'proposal')
  assert.equal(DEAL_OF_STAGE.contract, 'verbal')
  assert.equal(DEAL_OF_STAGE.won, 'closed')
  assert.equal(DEAL_OF_STAGE.quiet, undefined)
})
t('the stage from what happened: reply → call booked → call done → the deal', () => {
  const now = D('2026-11-08T18:00:00Z')
  const f = { replies: [D('2026-11-01T15:00:00Z')], callsBooked: [D('2026-11-02T15:00:00Z')], calls: [D('2026-11-05T16:00:00Z')], deal: null, stoppedAt: null }
  assert.equal(currentTalksStage(autoStageMarks(f, now)).stage, 'call_done')
  // A call still to come is only booked.
  assert.equal(currentTalksStage(autoStageMarks({ ...f, calls: [D('2026-11-12T16:00:00Z')] }, now)).stage, 'call_booked')
  // A deal moved on the Deals board shows; a later reply never winds it back.
  const withDeal = autoStageMarks({ ...f, replies: [...f.replies, D('2026-11-07T15:00:00Z')], deal: { stage: 'proposal', at: D('2026-11-06T15:00:00Z') } }, now)
  assert.equal(currentTalksStage(withDeal).stage, 'proposal')
  assert.equal(currentTalksStage(autoStageMarks({ replies: [], callsBooked: [], calls: [], deal: { stage: 'conversation', at: now }, stoppedAt: null }, now)), null)
})
t('a stage set by hand takes; later news moves it only further, or out, or back from out', () => {
  const now = D('2026-11-20T18:00:00Z')
  const hand = (stage, at) => ({ stage, at: D(at), hand: true, by: 'Leo', createdAt: D(at) })
  const auto = autoStageMarks({ replies: [D('2026-11-01T15:00:00Z'), D('2026-11-10T15:00:00Z')], callsBooked: [D('2026-11-12T15:00:00Z')], calls: [], deal: null, stoppedAt: null }, now)
  // Proposal sent on the 5th: a reply on the 10th and a call booked on the 12th don't wind it back.
  let cur = currentTalksStage([...auto, hand('proposal', '2026-11-05T16:30:00Z')])
  assert.equal(cur.stage, 'proposal'); assert.equal(cur.hand, true)
  // Gone quiet on the 8th: the reply on the 10th brings it back.
  cur = currentTalksStage([...auto, hand('quiet', '2026-11-08T16:30:00Z')])
  assert.equal(cur.stage, 'call_booked')
  // They said stop after the proposal: Lost.
  cur = currentTalksStage([hand('proposal', '2026-11-05T16:30:00Z'), ...autoStageMarks({ replies: [], callsBooked: [], calls: [], deal: null, stoppedAt: D('2026-11-15T15:00:00Z') }, now)])
  assert.equal(cur.stage, 'lost')
  // A hand stage after everything always takes, even back a step.
  cur = currentTalksStage([...auto, hand('replied', '2026-11-19T16:30:00Z')])
  assert.equal(cur.stage, 'replied')
  // The bar moving the deal (same stage, a moment later) leaves "set by Leo".
  cur = currentTalksStage([hand('won', '2026-11-19T16:30:00Z'), ...autoStageMarks({ replies: [], callsBooked: [], calls: [], deal: { stage: 'closed', at: D('2026-11-19T16:31:00Z') }, stoppedAt: null }, now)])
  assert.equal(cur.hand, true)
  // Each stage's day = the first time it was reached.
  const days = stageDates([...auto, hand('proposal', '2026-11-05T16:30:00Z')])
  assert.deepEqual(days.replied, D('2026-11-01T15:00:00Z'))
  assert.deepEqual(days.proposal, D('2026-11-05T16:30:00Z'))
})
t('a log line’s day: today = now, a past day = midday New York, never a day to come', () => {
  const now = D('2026-11-08T18:00:00Z')
  assert.deepEqual(logMoment('', now, '2026-11-08'), now)
  assert.deepEqual(logMoment('2026-11-08', now, '2026-11-08'), now)
  assert.deepEqual(logMoment('2026-11-03', now, '2026-11-08'), D('2026-11-03T16:30:00Z'))
  assert.equal(D('2026-11-03T16:30:00Z').toLocaleDateString('en-CA', { timeZone: 'America/New_York' }), '2026-11-03')
  assert.throws(() => logMoment('2026-11-09', now, '2026-11-08'), /hasn’t come yet/)
  assert.throws(() => logMoment('Nov 3', now, '2026-11-08'), /Pick a day/)
  assert.ok(isLogKind('call') && isLogKind('email_out') && !isLogKind('stage'))
})

console.log(`\n${n} passed`)
