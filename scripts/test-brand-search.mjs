// node scripts/test-brand-search.mjs — the Schedule's Find a brand box
// (src/lib/brand-search.ts): exact names first, spelling slips still found.
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const out = mkdtempSync(join(tmpdir(), 'brand-search-test-'))
execSync('npx tsc src/lib/brand-search.ts --outDir ' + out + ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck', { stdio: 'inherit' })
writeFileSync(join(out, 'brand-search.js'), readFileSync(join(out, 'brand-search.js'), 'utf8').replace("from './brand-match'", "from './brand-match.js'"))
const { searchHit, editDistance } = await import(pathToFileURL(join(out, 'brand-search.js')).href)

let n = 0
function t(name, fn) { fn(); n++; console.log('  ok — ' + name) }
const rank = (q, name, aka) => searchHit(q, name, aka)?.rank ?? null

t('exact name is rank 0, punctuation and case ignored', () => {
  assert.equal(rank('celsius', 'Celsius'), 0)
  assert.equal(rank('Liquid IV', 'Liquid I.V.'), 0)
  assert.equal(rank('redbull', 'Red Bull'), 0)
  assert.equal(rank('Red Bull', 'Red Bull, Inc.'), 0)
})
t('starts with, then a word starts with, then contains', () => {
  assert.equal(rank('cel', 'Celsius'), 1)
  assert.equal(rank('bull', 'Red Bull'), 2)
  assert.equal(rank('ull', 'Red Bull'), 3)
})
t('an also-known-as match is rank 4 and names it', () => {
  const hit = searchHit('Smirnoff Ice', 'Smirnoff', 'Smirnoff Ice, Smirnoff Vodka')
  assert.deepEqual(hit, { rank: 4, via: 'aka', aka: 'Smirnoff Ice' })
  const aka = searchHit('Liquid Death', 'LD Water Co', 'Liquid Death')
  assert.deepEqual(aka, { rank: 4, via: 'aka', aka: 'Liquid Death' })
})
t('a spelling slip is rank 5', () => {
  assert.equal(searchHit('celcius', 'Celsius').via, 'fuzzy')
  assert.equal(rank('celcius', 'Celsius Energy'), 5)
  assert.equal(rank('monstr', 'Monster Energy'), 5)
  assert.equal(rank('draftkngs', 'DraftKings'), 5)
})
t('no match, and short words never guess', () => {
  assert.equal(rank('zzz', 'Celsius'), null)
  assert.equal(rank('ab', 'Celsius'), null)
  assert.equal(rank('nike', 'Celsius'), null)
  assert.equal(rank('', 'Celsius'), null)
})
t('edit distance stops early', () => {
  assert.equal(editDistance('celcius', 'celsius'), 1)
  assert.equal(editDistance('abc', 'xyzxyzxyz', 2), 3)
})
console.log(`brand-search: all ${n} passed`)
