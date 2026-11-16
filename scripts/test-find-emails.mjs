// node scripts/test-find-emails.mjs — Outreach → Email's "Emails for people
// who didn't answer on LinkedIn" (Leo, Nov 16 2026; src/lib/find-emails.ts):
// who goes on the list for Hunter, how a name and a company's domain are
// read, the file for Hunter, Hunter's file read back, and what a file would
// save (never over an email already there).
import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const out = mkdtempSync(join(tmpdir(), 'find-emails-test-'))
execSync('npx tsc src/lib/find-emails.ts --outDir ' + out + ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck', { stdio: 'inherit' })
for (const f of readdirSync(out).filter(f => f.endsWith('.js'))) {
  const p = join(out, f)
  writeFileSync(p, readFileSync(p, 'utf8').replace(/from '(\.\/[^']+)'/g, "from '$1.js'"))
}
const m = await import(pathToFileURL(join(out, 'find-emails.js')).href)
const {
  splitName, mailDomain, companyDomain, personGroup, brandIn, brandAnswered, needEmailList, parseCsv, toCsv, hunterCsv, HUNTER_HEAD,
  readFoundFile, verdictOf, planFoundEmails, findKey, sigOf, foundNote, addNote, dropNote, FIND_MIN_DAYS,
} = m

let n = 0
function t(name, fn) { fn(); n++; console.log('  ok — ' + name) }
const NOW = new Date('2026-11-16T17:00:00Z')
const ago = (d) => new Date(NOW.getTime() - d * 864e5).toISOString()

// ---- names
t('a name splits into first and last', () => {
  assert.deepEqual(splitName('Jane Smith'), { first: 'Jane', last: 'Smith' })
  assert.deepEqual(splitName('  Jane   A.  Smith '), { first: 'Jane', last: 'Smith' })
  assert.deepEqual(splitName('Mary Anne Smith'), { first: 'Mary', last: 'Smith' })
  assert.deepEqual(splitName('Jean-Luc Picard'), { first: 'Jean-Luc', last: 'Picard' })
  assert.deepEqual(splitName("Shaun O'Brien"), { first: 'Shaun', last: "O'Brien" })
  assert.deepEqual(splitName('José Núñez'), { first: 'José', last: 'Núñez' })
})
t('titles, credentials, pronouns, nicknames and emoji are dropped', () => {
  assert.deepEqual(splitName('Dr. Jane Smith, MBA'), { first: 'Jane', last: 'Smith' })
  assert.deepEqual(splitName('Jane Smith MBA'), { first: 'Jane', last: 'Smith' })
  assert.deepEqual(splitName('John Smith Jr.'), { first: 'John', last: 'Smith' })
  assert.deepEqual(splitName('Jane Smith (she/her)'), { first: 'Jane', last: 'Smith' })
  assert.deepEqual(splitName('Robert "Bob" Smith'), { first: 'Robert', last: 'Smith' })
  assert.deepEqual(splitName('Jane Smith 🚀 | Partnerships'), { first: 'Jane', last: 'Smith' })
  assert.deepEqual(splitName('Jane Smith - Brand Marketing'), { first: 'Jane', last: 'Smith' })
})
t('a surname keeps its particles; "Ma" is a surname, not a degree', () => {
  assert.deepEqual(splitName('Oscar de la Renta'), { first: 'Oscar', last: 'de la Renta' })
  assert.deepEqual(splitName('Ludwig van Beethoven'), { first: 'Ludwig', last: 'van Beethoven' })
  assert.deepEqual(splitName('Jack Ma'), { first: 'Jack', last: 'Ma' })
})
t('no name to look up: one word, a name LinkedIn cut short, LinkedIn Member', () => {
  assert.equal(splitName('Madonna'), null)
  assert.equal(splitName('Jane S.'), null)
  assert.equal(splitName('J. Smith'), null)
  assert.equal(splitName('LinkedIn Member'), null)
  assert.equal(splitName(''), null)
  assert.equal(splitName(null), null)
})

// ---- domains
t('the company domain: never a free mailbox', () => {
  assert.equal(mailDomain('Jane.Smith@Poppi.com'), 'poppi.com')
  assert.equal(mailDomain('jane@gmail.com'), null)
  assert.equal(mailDomain('not an email'), null)
})
t('a brand is looked up at the domain its people already mail from, else its website', () => {
  assert.deepEqual(companyDomain({ website: 'https://www.ketelone.com/', emails: ['a@diageo.com', 'b@diageo.com', 'c@gmail.com'] }), { domain: 'diageo.com', from: 'emails' })
  assert.deepEqual(companyDomain({ website: 'https://www.drinkpoppi.com/shop', emails: [] }), { domain: 'drinkpoppi.com', from: 'website' })
  assert.deepEqual(companyDomain({ website: 'https://www.instagram.com/brand', emails: ['x@yahoo.com'] }), { domain: null, from: null })
  // A tie goes to the one that matches the website.
  assert.equal(companyDomain({ website: 'brand.com', emails: ['a@agency.com', 'b@brand.com'] }).domain, 'brand.com')
  assert.deepEqual(companyDomain({}), { domain: null, from: null })
})

// ---- who's on the list
const P = (o = {}) => ({ contactId: 'c' + Math.random().toString(36).slice(2, 8), name: 'Jane Smith', title: 'Head of Partnerships', linkedinUrl: null, email: null,
  stage: 'reached', out: null, label: 'invited', lastAt: ago(30), emailedAt: null, by: 'zach', ...o })
const B = (o = {}) => ({ id: 'b' + Math.random().toString(36).slice(2, 8), name: 'Brand', category: 'energy', stage: 'reached', out: null, archived: false, doNotEmail: false, people: [], ...o })

t('a person: invited with no answer = didn\'t accept; quiet after the last follow-up = no response', () => {
  assert.equal(personGroup({ stage: 'reached' }), 'noaccept')
  assert.equal(personGroup({ stage: 'out', out: 'quiet' }), 'quiet')
  for (const p of [{ stage: 'out', out: 'stopped' }, { stage: 'out', out: 'no' }, { stage: 'accepted' }, { stage: 'replied' }, { stage: 'talks' }, { stage: 'emailed' }, { stage: 'continue' }])
    assert.equal(personGroup(p), null)
})
t('a brand: on the list at Reached out or Out · no response; never one that answered', () => {
  assert.equal(brandIn(B({ stage: 'reached' })), 'in')
  assert.equal(brandIn(B({ stage: 'out', out: 'quiet' })), 'in')
  assert.equal(brandIn(B({ stage: 'accepted' })), 'waiting')
  for (const b of [{ stage: 'replied' }, { stage: 'talks' }, { stage: 'continue' }, { stage: 'emailed' }, { stage: 'lireply' }, { stage: 'out', out: 'stopped' }, { stage: 'out', out: 'no' }, { stage: 'out', out: 'lost' }])
    assert.equal(brandIn(B(b)), 'no')
  assert.equal(brandIn(B({ stage: 'reached', archived: true })), 'off')
  assert.equal(brandIn(B({ stage: 'out', out: 'quiet', doNotEmail: true })), 'off')
  assert.equal(brandIn(B({ stage: 'replied', archived: true })), 'no')
})
t('someone there answered — said no, asked us to stop, or wrote back once: the company is not approached again', () => {
  const invited = P({ contactId: 'i1' })
  assert.equal(brandIn(B({ stage: 'reached', people: [invited, P({ stage: 'out', out: 'no' })] })), 'no')
  assert.equal(brandIn(B({ stage: 'reached', people: [invited, P({ stage: 'out', out: 'stopped' })] })), 'no')
  assert.equal(brandIn(B({ stage: 'reached', people: [invited, P({ stage: 'out', out: 'hand' })] })), 'no')
  assert.equal(brandIn(B({ stage: 'reached', people: [invited, P({ stage: 'out', out: 'quiet', steps: ['reached', 'accepted', 'replied'] })] })), 'no')
  assert.equal(brandIn(B({ stage: 'reached', people: [invited, P({ stage: 'out', out: 'quiet', steps: ['reached', 'accepted'] })] })), 'in')
  assert.equal(brandAnswered(B({ people: [invited] })), false)
  assert.deepEqual(needEmailList([B({ people: [invited, P({ stage: 'out', out: 'no' })] })], { now: NOW }).need, [])
})
t('the list: people with no email, old enough, with a name to look up', () => {
  const brands = [
    B({ id: 'b1', name: 'Alpha', people: [
      P({ contactId: 'a1', name: 'Ann Lee' }),
      P({ contactId: 'a2', name: 'Bo Chen', stage: 'out', out: 'quiet', label: 'no response after the last follow-up', lastAt: ago(3) }),
      P({ contactId: 'a3', name: 'Cy Young', email: 'Cy@Alpha.com' }),
      P({ contactId: 'a4', name: 'Di Park', email: 'di@alpha.com', emailedAt: ago(5), label: 'emailed' }),
      P({ contactId: 'a5', name: 'Ed Nolan', lastAt: ago(4) }),
      P({ contactId: 'a6', name: 'Flo R.' }),
      P({ contactId: 'a7', name: 'Gus Hall', lastAt: ago(2), label: 'invite withdrawn' }),
      P({ contactId: null, name: 'No Record' }),
      P({ contactId: 'a1', name: 'Ann Lee', by: 'elizabeth' }),
    ] }),
    B({ id: 'b2', name: 'Beta', stage: 'out', out: 'quiet', people: [P({ contactId: 'b1p', name: 'Hal Roy', stage: 'out', out: 'quiet' })] }),
    B({ id: 'b3', name: 'Gamma', stage: 'accepted', people: [P({ contactId: 'g1' }), P({ contactId: 'g2', stage: 'accepted' })] }),
    B({ id: 'b4', name: 'Delta', stage: 'replied', people: [P({ contactId: 'd1' }), P({ contactId: 'd2', stage: 'replied' })] }),
    B({ id: 'b5', name: 'Epsilon', archived: true, people: [P({ contactId: 'e1' })] }),
    B({ id: 'b6', name: 'Zeta', stage: 'out', out: 'stopped', people: [P({ contactId: 'z1', stage: 'out', out: 'stopped' }), P({ contactId: 'z2', stage: 'out', out: 'quiet' })] }),
  ]
  const r = needEmailList(brands, { now: NOW })
  assert.deepEqual(r.need.map(x => x.contactId), ['a1', 'a2', 'a7', 'b1p'])
  assert.deepEqual(r.need.map(x => x.group), ['noaccept', 'quiet', 'noaccept', 'quiet'])
  assert.deepEqual([r.need[0].first, r.need[0].last, r.need[0].brandName], ['Ann', 'Lee', 'Alpha'])
  assert.deepEqual(r.have.map(x => [x.contactId, x.email]), [['a3', 'cy@alpha.com']])
  assert.deepEqual(r.counts, { need: 4, needBrands: 2, noaccept: 2, quiet: 2, have: 1, emailed: 1, tooNew: 1, noName: 1, offBrands: 1, waitingBrands: 1 })
  assert.equal(FIND_MIN_DAYS, 21)
})
t('the wait is the caller\'s: any time lets a fresh invite in', () => {
  const brands = [B({ people: [P({ contactId: 'x1', lastAt: ago(4) }), P({ contactId: 'x2', lastAt: ago(10) })] })]
  assert.deepEqual(needEmailList(brands, { now: NOW }).need.map(x => x.contactId), [])
  assert.deepEqual(needEmailList(brands, { now: NOW, minDays: 7 }).need.map(x => x.contactId), ['x2'])
  assert.deepEqual(needEmailList(brands, { now: NOW, minDays: 0 }).need.map(x => x.contactId), ['x1', 'x2'])
})

// ---- the file for Hunter, and back
t('the file for Hunter: its columns, quotes kept, our id last', () => {
  const csv = hunterCsv([{ contactId: 'c1', name: 'Ann Lee', first: 'Ann', last: 'Lee', title: 'VP, "Brand"', linkedinUrl: 'https://www.linkedin.com/in/ann-lee/', email: null,
    brandId: 'b1', brandName: 'Alpha, Inc.', category: null, group: 'noaccept', lastAt: null, by: 'zach', company: 'Alpha, Inc.', domain: 'alpha.com' }])
  const grid = parseCsv(csv)
  assert.deepEqual(grid[0], HUNTER_HEAD)
  assert.deepEqual(grid[1], ['Ann', 'Lee', 'Alpha, Inc.', 'alpha.com', 'Alpha, Inc.', 'VP, "Brand"', 'https://www.linkedin.com/in/ann-lee/', 'c1'])
  assert.deepEqual(parseCsv('﻿a,b\r\n"x\ny",2\r\n\r\n'), [['a', 'b'], ['x\ny', '2']])
  assert.equal(toCsv([['a', 'b,c']]), 'a,"b,c"\r\n')
})
const FILE = (rows, head = [...HUNTER_HEAD, 'Email address', 'Confidence score', 'Verification status']) => toCsv([head, ...rows])
const row = (id, email, status = 'valid', score = '95', first = 'Ann', last = 'Lee', brand = 'Alpha') => [first, last, brand, 'alpha.com', brand, 'VP', '', id, email, score, status]
t('Hunter\'s file: the address column is found by what\'s in it; rows with nothing are counted', () => {
  const f = readFoundFile(FILE([row('c1', 'Ann.Lee@Alpha.com'), row('c2', ''), row('c3', 'bo@alpha.com', 'accept_all', '70')]))
  assert.equal(f.error, undefined)
  assert.deepEqual(f.cols, { email: 'Email address', status: 'Verification status', score: 'Confidence score', id: 'SB id' })
  assert.deepEqual(f.rows.map(r => [r.line, r.id, r.email, r.status, r.score]), [[2, 'c1', 'ann.lee@alpha.com', 'valid', 95], [4, 'c3', 'bo@alpha.com', 'accept_all', 70]])
  assert.equal(f.total, 3)
  assert.equal(f.empty, 1)
  // Another tool's headings: "Work Email", "Email Status".
  const g = readFoundFile(toCsv([['Name', 'Company', 'Work Email', 'Email Status'], ['Ann Lee', 'Alpha', 'ann@alpha.com', 'Verified']]))
  assert.deepEqual(g.cols, { email: 'Work Email', status: 'Email Status', score: null, id: null })
  assert.deepEqual([g.rows[0].name, g.rows[0].company, g.rows[0].email], ['Ann Lee', 'Alpha', 'ann@alpha.com'])
})
t('the wrong file says so', () => {
  assert.match(readFoundFile(hunterCsv([])).error, /no rows/)
  assert.match(readFoundFile(toCsv([HUNTER_HEAD, ['Ann', 'Lee', 'Alpha', 'alpha.com', 'Alpha', 'VP', '', 'c1']])).error, /No email addresses/)
})
t('verified or not', () => {
  assert.equal(verdictOf('valid', true), 'valid')
  assert.equal(verdictOf('Deliverable', true), 'valid')
  assert.equal(verdictOf('invalid', true), 'invalid')
  assert.equal(verdictOf('Undeliverable', true), 'invalid')
  assert.equal(verdictOf('accept_all', true), 'unverified')
  assert.equal(verdictOf('Accept all', true), 'unverified')
  assert.equal(verdictOf('unknown', true), 'unverified')
  assert.equal(verdictOf('', true), 'unverified')
  assert.equal(verdictOf('', false), 'unknown')
})

// ---- what a file would save
const C = (id, o = {}) => [id, { id, name: 'Ann Lee', email: null, linkedinUrl: null, brandId: 'b1', brandName: 'Alpha', stopped: null, ...o }]
t('a file fills empty emails only, and says why for every other line', () => {
  const file = readFoundFile(FILE([
    row('c1', 'ann@alpha.com'),
    row('c2', 'bo@alpha.com', 'accept_all', '60'),
    row('c3', 'cy@alpha.com'),
    row('c4', 'di@alpha.com'),
    row('c5', 'ed@alpha.com', 'invalid'),
    row('nope', 'x@alpha.com'),
    row('c6', 'flo@alpha.com'),
    row('c7', 'ann@alpha.com'),
    row('c8', 'gus@alpha.com'),
    row('c9', 'not-an-email'),
    row('c10', 'hal@alpha.com'),
    row('c1', 'ann2@alpha.com'),
  ]))
  const contacts = new Map([
    C('c1'), C('c2', { name: 'Bo Chen' }), C('c3', { name: 'Cy Young', email: 'Cy@Alpha.com' }), C('c4', { name: 'Di Park', email: 'di@other.com' }),
    C('c5', { name: 'Ed Nolan' }), C('c6', { name: 'Flo Reyes', stopped: 'Flo said they don\'t want to continue' }), C('c7', { name: 'Ann Twin' }),
    C('c8', { name: 'Gus Hall' }), C('c9', { name: 'Ivy Ng' }), C('c10', { name: 'Hal Roy' }),
  ])
  const plan = planFoundEmails(file, {
    contacts,
    taken: new Map([['gus@alpha.com', { id: 'other', name: 'Gus H.', brandName: 'Beta' }]]),
    stopHit: (email) => (email === 'hal@alpha.com' ? 'Hal said they don\'t want to continue' : null),
  })
  assert.deepEqual(plan.lines.map(l => [l.contactId, l.action, l.tick]), [
    ['c1', 'save', true], ['c2', 'save', false], ['c3', 'same', false], ['c4', 'has', false], ['c5', 'invalid', false], [null, 'unknown', false],
    ['c6', 'stopped', false], ['c7', 'twice', false], ['c8', 'taken', false], ['c9', 'bad', false], ['c10', 'stopped', false], ['c1', 'twice', false],
  ])
  assert.match(plan.lines[3].why, /Already has di@other\.com/)
  assert.match(plan.lines[8].why, /Gus H\.’s address at Beta/)
  assert.equal(plan.lines[1].why, 'Not verified (accept_all)')
  assert.deepEqual(plan.counts, { save: 2, same: 1, has: 1, invalid: 1, bad: 1, unknown: 1, stopped: 2, taken: 1, twice: 2, ticked: 1 })
  // The signature is what would be saved: a change to it reads as stale.
  assert.equal(plan.sig, sigOf(['c1:ann@alpha.com', 'c2:bo@alpha.com']))
  assert.notEqual(plan.sig, sigOf(['c1:ann@alpha.com']))
  assert.equal(sigOf(['b', 'a']), sigOf(['a', 'b']))
})
t('a file with no verification column: saved lines are ticked, and say so', () => {
  const file = readFoundFile(toCsv([[...HUNTER_HEAD, 'Email'], ['Ann', 'Lee', 'Alpha', 'alpha.com', 'Alpha', 'VP', '', 'c1', 'ann@alpha.com']]))
  const plan = planFoundEmails(file, { contacts: new Map([C('c1')]) })
  assert.deepEqual([plan.lines[0].action, plan.lines[0].tick, plan.lines[0].verdict], ['save', true, 'unknown'])
  assert.match(plan.lines[0].why, /doesn’t say/)
})
t('a file without our id: matched by profile link, else by name and brand', () => {
  const file = readFoundFile(toCsv([
    ['Full name', 'Company', 'LinkedIn URL', 'Email', 'Status'],
    ['Ann Lee', 'Alpha', '', 'ann@alpha.com', 'valid'],
    ['Somebody Else', 'Alpha', 'https://www.linkedin.com/in/Bo-Chen-1/', 'bo@alpha.com', 'valid'],
    ['Zed Zero', 'Nowhere', '', 'zed@nowhere.com', 'valid'],
  ]))
  const plan = planFoundEmails(file, {
    contacts: new Map([C('c1'), C('c2', { name: 'Bo Chen' })]),
    byKey: new Map([[findKey('Ann Lee', 'Alpha'), 'c1']]),
    bySlug: new Map([['bo-chen-1', 'c2']]),
  })
  assert.deepEqual(plan.lines.map(l => [l.contactId, l.action]), [['c1', 'save'], ['c2', 'save'], [null, 'unknown']])
  assert.equal(findKey('ANN  LEE', 'Alpha, Inc.'), findKey('Ann Lee', 'alpha inc'))
  assert.equal(findKey('Madonna', 'Alpha'), '')
})
t('the note a saved address leaves, and taking it back out', () => {
  const line = foundNote('Nov 16, 2026', 'valid')
  assert.equal(line, 'Email added from Hunter’s file, Nov 16, 2026 (verified)')
  assert.equal(foundNote('Nov 16, 2026', 'unknown'), 'Email added from Hunter’s file, Nov 16, 2026')
  assert.equal(addNote(null, line), line)
  assert.equal(addNote('Met at SXSW', line), 'Met at SXSW\n' + line)
  assert.equal(dropNote('Met at SXSW\n' + line, line), 'Met at SXSW')
  assert.equal(dropNote(line, line), null)
  assert.equal(dropNote('Met at SXSW', line), 'Met at SXSW')
})

console.log('\n' + n + ' checks passed')
