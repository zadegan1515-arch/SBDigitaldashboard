// node scripts/test-in-talks.mjs — In talks: who's in (a call booked or a hand
// add, a removal wins over anything older), replied brands offered, the people
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
const { talksState, suggestTalks, isTalksPerson, talksPersonStage, stageRank, talksJourney, compareTalks, cleanLink, socialHandle, sentenceCount, missingFields } = m

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

console.log(`\n${n} passed`)
