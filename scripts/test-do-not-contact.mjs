// node scripts/test-do-not-contact.mjs — "Doesn't want to continue"
// (src/lib/do-not-contact.ts; Leo, Oct 15 2026: "some people respond but i
// want to make sure we dont reach out to them again"). A second copy of a
// person who said no — another LinkedIn link form, a re-import, a hand add —
// is still them. Compiles the lib on its own, like test-same-person.mjs.
import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const out = mkdtempSync(join(tmpdir(), 'do-not-contact-test-'))
execSync('npx tsc src/lib/do-not-contact.ts --outDir ' + out + ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck', { stdio: 'inherit' })
for (const f of readdirSync(out)) {
  if (!f.endsWith('.js')) continue
  const p = join(out, f)
  writeFileSync(p, readFileSync(p, 'utf8').replace(/from '\.\/([\w-]+)'/g, "from './$1.js'"))
}
const D = await import(pathToFileURL(join(out, 'do-not-contact.js')).href)

let n = 0
function t(name, fn) { fn(); n++; console.log('  ok — ' + name) }

const alex = { id: 'c1', brandId: 'b1', name: 'Alex Seamon', linkedinUrl: 'https://www.linkedin.com/in/AlexSeamon/', email: 'alex@alphawater.com', at: '2026-10-15T15:00:00Z' }
const sam = { id: 'c2', brandId: 'b1', name: 'Sam Lee', linkedinUrl: null, email: 'partnerships@alphawater.com' }
const ix = D.stopIndex([alex, sam])

t('the same LinkedIn profile, any brand, any case or link form', () => {
  assert.equal(D.stoppedMatch(ix, { brandId: 'b9', name: 'A. Seamon', linkedinUrl: 'http://linkedin.com/in/alexseamon?trk=x' }), alex)
  assert.equal(D.stoppedMatch(ix, { brandId: 'b1', linkedinUrl: 'https://www.linkedin.com/in/alexseamon' }), alex)
})

t('the same personal email, any brand', () => {
  assert.equal(D.stoppedMatch(ix, { brandId: 'b7', name: 'Someone', email: ' Alex@AlphaWater.com ' }), alex)
})

t('a shared inbox is never a person', () => {
  assert.equal(D.stoppedMatch(ix, { brandId: 'b7', name: 'Pat Doe', email: 'partnerships@alphawater.com' }), null)
})

t('the same full name only counts at the same brand', () => {
  assert.equal(D.stoppedMatch(ix, { brandId: 'b1', name: 'alex  seamon' }), alex)
  assert.equal(D.stoppedMatch(ix, { brandId: 'b1', name: 'Sam Lee (Marketing)' }), sam)
  assert.equal(D.stoppedMatch(ix, { brandId: 'b2', name: 'Sam Lee' }), null, 'two Sam Lees at two companies are two people')
  assert.equal(D.stoppedMatch(ix, { brandId: null, name: 'Alex Seamon' }), null, 'no brand: a name alone proves nothing')
})

t('a one-word name never matches', () => {
  const ix2 = D.stopIndex([{ brandId: 'b1', name: 'Alex' }])
  assert.equal(D.stoppedMatch(ix2, { brandId: 'b1', name: 'Alex' }), null)
})

t('nobody else', () => {
  assert.equal(D.stoppedMatch(ix, { brandId: 'b1', name: 'Beth Baker', linkedinUrl: 'https://www.linkedin.com/in/beth/', email: 'beth@alphawater.com' }), null)
  assert.equal(D.stoppedMatch(D.stopIndex([]), { brandId: 'b1', name: 'Alex Seamon' }), null)
})

t('what a refusal says', () => {
  assert.match(D.stopWords({ name: 'Alex Seamon', at: '2026-10-15T15:00:00Z' }), /^Alex Seamon said they don't want to continue \(Oct 15\) — never contacted again\. Undo it on Zach's list or the brand page/)
  assert.match(D.stopWords({ at: '2026-10-15T15:00:00Z' }, 'Alpha Water'), /^Alpha Water said they don't want to continue \(Oct 15\) — nobody there is contacted\. Undo it on its page/)
  assert.match(D.stopWords({}), /^They said they don't want to continue — never/)
})

console.log(`do-not-contact: ${n} passed`)
