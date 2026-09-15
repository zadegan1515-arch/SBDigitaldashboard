// scripts/test-audience.mjs — guards the audience dedupe rules.
//
// Email is identity for the whole attendee system; the repeat-attendance
// signal dies silently if normalization or import mapping drifts. This
// compiles src/lib/audience-core.ts (pure, dependency-free) on its own
// and asserts the rules. Run: node scripts/test-audience.mjs
// (also worth running before any push that touches lib/audience*).

import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const out = mkdtempSync(join(tmpdir(), 'aud-test-'))
execSync(
  'npx tsc src/lib/audience-core.ts --outDir ' + out +
  ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck',
  { stdio: 'inherit' },
)
const core = await import(pathToFileURL(join(out, 'audience-core.js')).href)
const { normalizeEmail, isValidEmail, parsePriceCents, parseCsv, guessColumns, mapImportRows, cleanAmbassadorRef } = core

let n = 0
function t(name, fn) { fn(); n++; console.log('  ok — ' + name) }

// --- normalizeEmail: THE identity rule -------------------------
t('lowercases and trims', () => {
  assert.equal(normalizeEmail('  Jordan.Ellis@TXState.EDU  '), 'jordan.ellis@txstate.edu')
})
t('same person, different casing → same key', () => {
  assert.equal(normalizeEmail('A@B.CO'), normalizeEmail('a@b.co'))
})
t('does NOT strip dots or +tags (not Gmail-only world)', () => {
  assert.notEqual(normalizeEmail('a.b@x.co'), normalizeEmail('ab@x.co'))
  assert.notEqual(normalizeEmail('a+vip@x.co'), normalizeEmail('a@x.co'))
})
t('junk survives as junk, never throws', () => {
  assert.equal(normalizeEmail(null), '')
  assert.equal(normalizeEmail(undefined), '')
  assert.equal(normalizeEmail(42), '42')
})
t('validation rejects non-emails', () => {
  assert.ok(isValidEmail('a@b.co'))
  assert.ok(!isValidEmail('not-an-email'))
  assert.ok(!isValidEmail('a@b'))
  assert.ok(!isValidEmail(''))
  assert.ok(!isValidEmail('a b@c.co'))
})

// --- price parsing ---------------------------------------------
t('prices land in integer cents', () => {
  assert.equal(parsePriceCents('$25'), 2500)
  assert.equal(parsePriceCents('12.50'), 1250)
  assert.equal(parsePriceCents('1,750'), 175000)
  assert.equal(parsePriceCents(''), 0)
})
t('junk prices refuse rather than becoming zero', () => {
  assert.equal(parsePriceCents('abc'), null)
  assert.equal(parsePriceCents('12.5.0'), null)
  assert.equal(parsePriceCents('-5'), null)
})

// --- CSV parsing ------------------------------------------------
t('quotes, escaped quotes, CRLF', () => {
  const rows = parseCsv('a,b\r\n"x, y","he said ""hi"""\n')
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'he said "hi"']])
})
t('blank lines are dropped', () => {
  assert.equal(parseCsv('a,b\n\n\n1,2\n').length, 2)
})

// --- header guessing --------------------------------------------
t('common box-office headers are recognized', () => {
  const m = guessColumns(['Buyer Email', 'Full Name', 'Ticket Type', 'Amount Paid', 'School'])
  assert.equal(m.email, 0); assert.equal(m.name, 1)
  assert.equal(m.ticketType, 2); assert.equal(m.price, 3); assert.equal(m.school, 4)
})

// --- import mapping: the dedupe behaviors ------------------------
t('duplicate emails inside one file collapse to one row', () => {
  const r = mapImportRows('email,name,paid\nA@x.co,Ann,$25\na@x.co ,,\n')
  assert.equal(r.rows.length, 1)
  assert.equal(r.dupesInFile, 1)
  assert.equal(r.rows[0].email, 'a@x.co')
  assert.equal(r.rows[0].name, 'Ann')          // first non-empty wins
  assert.equal(r.rows[0].priceCents, 2500)     // price kept from the paying row
})
t('later duplicate can fill a missing price', () => {
  const r = mapImportRows('email,name,paid,type\na@x.co,Ann,,\na@x.co,,$80,VIP Table\n')
  assert.equal(r.rows.length, 1)
  assert.equal(r.rows[0].priceCents, 8000)
  assert.equal(r.rows[0].ticketType, 'vip')
})
t('bad rows are reported with line numbers, not silently dropped', () => {
  const r = mapImportRows('email,paid\nnope,1\na@x.co,abc\nb@x.co,$10\n')
  assert.equal(r.rows.length, 1)
  assert.equal(r.skipped.length, 2)
  assert.deepEqual(r.skipped.map(s => s.line), [2, 3])
})
t('ticket types normalize to ga/vip/comp', () => {
  const r = mapImportRows('email,type\na@x.co,VIP Booth\nb@x.co,Comp Guest\nc@x.co,General Admission\n')
  assert.deepEqual(r.rows.map(x => x.ticketType), ['vip', 'comp', 'ga'])
})
t('no email column → loud failure, zero rows', () => {
  const r = mapImportRows('name,paid\nAnn,5\n')
  assert.equal(r.rows.length, 0)
  assert.ok(r.skipped[0].reason.includes('email'))
})

// --- ambassador refs ---------------------------------------------
t('only platform-shaped refs pass', () => {
  assert.equal(cleanAmbassadorRef('sboy:u_123'), 'sboy:u_123')
  assert.equal(cleanAmbassadorRef('sboy:<script>'), null)
  assert.equal(cleanAmbassadorRef('u_123'), null)
  assert.equal(cleanAmbassadorRef(''), null)
})

console.log('\nAll ' + n + ' audience tests passed.')
