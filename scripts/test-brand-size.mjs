// node scripts/test-brand-size.mjs — the LinkedIn fill's brand sizes.
import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const out = mkdtempSync(join(tmpdir(), 'size-test-'))
execSync('npx tsc src/lib/brand-size.ts --outDir ' + out + ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck', { stdio: 'inherit' })
const { brandSize, sizeFromMembers, sizeRank, cleanMembers } = await import(pathToFileURL(join(out, 'brand-size.js')).href)

let n = 0
function t(name, fn) { fn(); n++; console.log('  ok — ' + name) }

t('LinkedIn headcount: small under 20, target 20–499, big from 500', () => {
  assert.equal(sizeFromMembers(0), 'small')
  assert.equal(sizeFromMembers(19), 'small')
  assert.equal(sizeFromMembers(20), 'target')
  assert.equal(sizeFromMembers(499), 'target')
  assert.equal(sizeFromMembers(500), 'big')
  assert.equal(sizeFromMembers(null), null)
})
t('headcount wins over parent and tier', () => {
  assert.equal(brandSize({ liMembers: 140, tier: 'established', hasParent: true }), 'target')
  assert.equal(brandSize({ liMembers: 8, tier: 'growth' }), 'small')
})
t('not measured: a known parent is big, then tier, else unknown', () => {
  assert.equal(brandSize({ hasParent: true, tier: 'emerging' }), 'big')
  assert.equal(brandSize({ tier: 'established' }), 'big')
  assert.equal(brandSize({ tier: 'growth' }), 'target')
  assert.equal(brandSize({ tier: 'emerging' }), 'small')
  assert.equal(brandSize({}), 'unknown')
})
t('order: target, unknown, small, big', () => {
  const s = ['big', 'small', 'unknown', 'target'].sort((a, b) => sizeRank(a) - sizeRank(b))
  assert.deepEqual(s, ['target', 'unknown', 'small', 'big'])
})
t('only whole, sane headcounts are saved', () => {
  assert.equal(cleanMembers(140), 140)
  assert.equal(cleanMembers('140'), 140)
  assert.equal(cleanMembers(1.5), null)
  assert.equal(cleanMembers(-1), null)
  assert.equal(cleanMembers(null), null)
  assert.equal(cleanMembers(''), null)
})
console.log(n + ' checks passed')
