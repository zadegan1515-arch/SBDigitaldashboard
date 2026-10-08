// node scripts/test-same-person.mjs — the same person filed twice at one
// brand (src/lib/same-person.ts; Leo, Oct 8 2026: "merge if two people
// appear"). Compiles the lib on its own, like test-coverage.mjs.
import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const out = mkdtempSync(join(tmpdir(), 'same-person-test-'))
execSync('npx tsc src/lib/same-person.ts --outDir ' + out + ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck', { stdio: 'inherit' })
const P = await import(pathToFileURL(join(out, 'same-person.js')).href)

let n = 0
function t(name, fn) { fn(); n++; console.log('  ok — ' + name) }

// The real case: Diageo after its brands were combined.
const ariLi = {
  id: 'li', name: 'Ari Anderman', title: 'Head of Marketing', email: null, location: null,
  linkedinUrl: 'https://www.linkedin.com/in/arianderman/', source: 'linkedin', isDecisionMaker: true,
  notes: null, createdAt: '2026-09-30T20:01:52Z', target: { id: 't1', status: 'sent', sentAt: '2026-10-08T14:24:38Z' },
}
const ariSu = {
  id: 'su', name: 'Ari Anderman', title: 'Marketing Director, Don Julio Tequila', email: 'ari.anderman@diageo.com',
  location: 'New York, New York, United States', linkedinUrl: 'https://www.linkedin.com/in/ari-anderman-8743a831/',
  source: 'sponsorunited', isDecisionMaker: false, notes: null, createdAt: '2026-08-27T03:13:18Z', target: null,
}

t('Ari twice: same name, one email, two LinkedIn links — one person', () => {
  assert.equal(P.samePerson(ariLi, ariSu), true)
  const g = P.samePeopleGroups([ariSu, { id: 'x', name: 'Karissa Downer' }, ariLi])
  assert.equal(g.length, 1)
  assert.deepEqual(g[0].map(r => r.id).sort(), ['li', 'su'])
})

t('the invited row stays; it takes the email and city, and notes the old title and link', () => {
  assert.equal(P.pickKeeper([ariSu, ariLi]).id, 'li')
  const { data, lines } = P.mergeFields(ariLi, ariSu, 'Oct 8, 2026')
  assert.equal(data.email, 'ari.anderman@diageo.com')
  assert.equal(data.location, 'New York, New York, United States')
  assert.equal(data.title, undefined, 'the newer title stays')
  assert.equal(data.linkedinUrl, undefined, 'the link the invite went to stays')
  assert.equal(data.isDecisionMaker, undefined)
  assert.equal(lines.length, 2)
  assert.match(data.notes, /^Merged with a second copy Oct 8, 2026: also on file as “Marketing Director, Don Julio Tequila” \(sponsorunited\); other LinkedIn link https:\/\/www\.linkedin\.com\/in\/ari-anderman-8743a831\/\.$/)
})

t('two people who share a name, each with their own email, are left alone', () => {
  const a = { id: 'a', name: 'Chris Lee', email: 'chris.lee@a.com' }
  const b = { id: 'b', name: 'Chris  Lee', email: 'clee@a.com' }
  assert.equal(P.samePerson(a, b), false)
  assert.deepEqual(P.samePeopleGroups([a, b]), [])
  // …even through a third row with no email that matches both by name
  assert.deepEqual(P.samePeopleGroups([a, b, { id: 'c', name: 'Chris Lee' }]), [])
})

t('same LinkedIn profile or same email: one person whatever the name says', () => {
  assert.equal(P.samePerson({ id: '1', name: 'Rachel Zalis', linkedinUrl: 'https://www.linkedin.com/in/RachelZ/' }, { id: '2', name: 'rachel zalis (she/her)', linkedinUrl: 'https://linkedin.com/in/rachelz?trk=x' }), true)
  assert.equal(P.samePerson({ id: '1', name: 'R. Zalis', email: 'RZ@casamigos.com' }, { id: '2', name: 'Rachel Zalis', email: 'rz@casamigos.com ' }), true)
  assert.equal(P.personNameKey('José Núñez-Ortiz'), 'jose nunezortiz')
  assert.equal(P.personNameKey('Shayna E.'), 'shayna e')
})

t('a one-word name never matches by name alone; different people stay apart', () => {
  assert.equal(P.samePerson({ id: '1', name: 'Shayna' }, { id: '2', name: 'Shayna' }), false)
  assert.equal(P.samePerson({ id: '1', name: 'Abby Wise' }, { id: '2', name: 'Amber Zwolak' }), false)
  assert.equal(P.samePerson({ id: '1', name: 'Test Person 1' }, { id: '2', name: 'Test Person 2' }), false, 'digits count')
})

t('the keeper: furthest outreach first, then a LinkedIn link, then the newest', () => {
  const q = { id: 'q', name: 'A B', target: { id: 'tq', status: 'queued' }, createdAt: '2026-10-01' }
  const acc = { id: 'acc', name: 'A B', target: { id: 'ta', status: 'accepted' }, createdAt: '2026-09-01' }
  assert.equal(P.pickKeeper([q, acc]).id, 'acc')
  const old = { id: 'old', name: 'A B', linkedinUrl: 'https://www.linkedin.com/in/ab/', createdAt: '2026-01-01' }
  const fresh = { id: 'fresh', name: 'A B', createdAt: '2026-10-01' }
  assert.equal(P.pickKeeper([fresh, old]).id, 'old')
  assert.equal(P.pickKeeper([{ id: 'x', name: 'A B', createdAt: '2026-01-01' }, fresh]).id, 'fresh')
  // a withdrawn invite still outranks a queued row; an invite date counts as sent
  assert.ok(P.targetRank({ id: 't', status: 'queued', sentAt: '2026-10-01' }) > P.targetRank({ id: 't', status: 'drafted' }))
})

t('the kept row\'s own fields always win; missing ones fill; notes are kept, not doubled', () => {
  const keep = { id: 'k', name: 'A B', title: 'CMO', email: 'a@x.com', notes: 'met at Expo', isDecisionMaker: false }
  const drop = { id: 'd', name: 'A B', title: 'cmo', email: 'a@x.com', phone: '555', notes: 'met at Expo', isDecisionMaker: true, externalId: 'su-1' }
  const { data, lines } = P.mergeFields(keep, drop, 'Oct 8, 2026')
  assert.deepEqual(data, { phone: '555', externalId: 'su-1', isDecisionMaker: true })
  assert.deepEqual(lines, [])
  const both = P.mergeFields({ id: 'k', name: 'A B', notes: 'one' }, { id: 'd', name: 'A B', notes: 'two' }, 'Oct 8, 2026')
  assert.equal(both.data.notes, 'one\ntwo')
})

t('a shared inbox never makes two people one; a shared address with names that don\'t agree doesn\'t either', () => {
  const jane = { id: 'j', name: 'Jane Doe', email: 'partnerships@brand.com', linkedinUrl: 'https://www.linkedin.com/in/janedoe/' }
  const john = { id: 'o', name: 'John Roe', email: 'Partnerships@brand.com ', linkedinUrl: 'https://www.linkedin.com/in/johnroe/' }
  assert.equal(P.samePerson(jane, john), false)
  assert.deepEqual(P.samePeopleGroups([jane, john]), [])
  assert.equal(P.samePerson({ id: '1', name: 'Jane Doe', email: 'jd@brand.com' }, { id: '2', name: 'Bob Roe', email: 'jd@brand.com' }), false)
  assert.equal(P.isRoleInbox('Sponsorships@diageo.com'), true)
  assert.equal(P.isRoleInbox('ari.anderman@diageo.com'), false)
  // the same inbox AND the same name: one person by name
  assert.equal(P.samePerson({ id: '1', name: 'Jane Doe', email: 'info@b.com' }, { id: '2', name: 'Jane Doe', email: 'info@b.com' }), true)
})

t('"they said no" is never replaced by a copy that\'s only queued or invited', () => {
  const passed = { id: 'p', name: 'A B', target: { id: 't1', status: 'passed' }, createdAt: '2026-01-01' }
  const queued = { id: 'q', name: 'A B', target: { id: 't2', status: 'queued' }, createdAt: '2026-10-01' }
  assert.equal(P.pickKeeper([queued, passed]).id, 'p')
  const declined = { id: 'd', name: 'A B', target: { id: 't3', status: 'declined', sentAt: '2026-09-01' }, createdAt: '2026-01-01' }
  const sent = { id: 's', name: 'A B', target: { id: 't4', status: 'sent', sentAt: '2026-10-01' }, createdAt: '2026-10-01' }
  assert.equal(P.pickKeeper([sent, declined]).id, 'd')
  const dead = { id: 'x', name: 'A B', target: { id: 't5', status: 'dead' }, createdAt: '2026-01-01' }
  assert.equal(P.pickKeeper([dead, queued]).id, 'x', 'gone cold still beats only queued')
  // …while a reply or an accept still outranks an invite
  assert.equal(P.pickKeeper([sent, { id: 'a', name: 'A B', target: { id: 't6', status: 'accepted' } }]).id, 'a')
})

t('a second phone, city, X link, SponsorUnited id or name is noted, never dropped', () => {
  const keep = { id: 'k', name: 'R. Zalis', phone: '111', location: 'NYC', twitterUrl: 'https://x.com/a', externalId: 'su-1' }
  const drop = { id: 'd', name: 'Rachel Zalis', phone: '222', location: 'LA', twitterUrl: 'https://x.com/b', externalId: 'su-2' }
  const { data, lines } = P.mergeFields(keep, drop, 'Oct 8, 2026')
  assert.deepEqual(lines, ['also on file as name “Rachel Zalis”', 'other phone 222', 'also listed in LA', 'other X link https://x.com/b', 'other SponsorUnited id su-2'])
  assert.match(data.notes, /other phone 222/)
})

t('Leo\'s "not the same person" keeps a pair apart, and a group that would join them through a third', () => {
  const a = { id: 'a', name: 'Chris Lee' }, b = { id: 'b', name: 'Chris Lee' }, c = { id: 'c', name: 'Chris Lee' }
  const ns = new Set([P.pairKey('b', 'a')])
  assert.equal(P.samePerson(a, b, ns), false)
  assert.deepEqual(P.samePeopleGroups([a, b], ns), [])
  assert.deepEqual(P.samePeopleGroups([a, b, c], ns), [], 'a and b would meet through c')
  assert.equal(P.samePeopleGroups([a, b, c]).length, 1)
})

t('a pass and a queued copy: the later of the two decisions stays; a live invite beats a copy gone cold', () => {
  const passedOld = { id: 'p', name: 'A B', target: { id: 't1', status: 'passed', updatedAt: '2026-10-01' } }
  const queuedNew = { id: 'q', name: 'A B', target: { id: 't2', status: 'queued', updatedAt: '2026-10-08' } }
  assert.equal(P.pickKeeper([passedOld, queuedNew]).id, 'q')
  assert.equal(P.targetBeats(queuedNew.target, passedOld.target), true)
  const passedNew = { ...passedOld, target: { ...passedOld.target, updatedAt: '2026-10-09' } }
  assert.equal(P.pickKeeper([queuedNew, passedNew]).id, 'p')
  assert.equal(P.pickKeeper([{ id: 'd', name: 'A B', target: { id: 'x', status: 'dead' } }, { id: 's', name: 'A B', target: { id: 'y', status: 'sent', sentAt: '2026-10-01' } }]).id, 's')
})

console.log('same-person: all ' + n + ' passed')
