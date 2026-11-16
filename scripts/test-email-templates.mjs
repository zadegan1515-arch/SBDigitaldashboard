// node scripts/test-email-templates.mjs — Email → Templates (Leo, Nov 16 2026;
// src/lib/email-templates.ts): which templates there are, what each says
// until Leo saves his own, how a save reads, and Instantly's tags.
import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const out = mkdtempSync(join(tmpdir(), 'email-templates-test-'))
execSync('npx tsc src/lib/email-templates.ts --outDir ' + out + ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck', { stdio: 'inherit' })
for (const f of readdirSync(out).filter(f => f.endsWith('.js'))) {
  const p = join(out, f)
  writeFileSync(p, readFileSync(p, 'utf8').replace(/from '(\.\/[^']+)'/g, "from '$1.js'"))
}
const T = await import(pathToFileURL(join(out, 'email-templates.js')).href)
const C = await import(pathToFileURL(join(out, 'category-hints.js')).href)

let n = 0
function t(name, fn) { fn(); n++; console.log('  ok — ' + name) }
const ANGLES = { energy: { insert: 'Cold cans for {brand} at peak energy — {brand} in hand.' }, '': { insert: 'Ideas matched to {brand}.' } }

t('the keys: three shared emails and one per category, nothing else', () => {
  for (const k of ['intro', 'followup', 'final']) assert.equal(T.isTemplateKey(k), true, k)
  for (const c of C.CATEGORY_KEYS) assert.equal(T.isTemplateKey('cat:' + c), true, c)
  for (const k of ['', 'cat:', 'cat:nope', 'energy', 'cat:bestfit', '__proto__', 'constructor']) assert.equal(T.isTemplateKey(k), false, k)
})
t('the first email is Leo’s intro with the placeholders', () => {
  const d = T.defaultTemplate('intro', ANGLES)
  assert.equal(d.subject, 'SB Agency x (BRAND)')
  assert.match(d.body, /^Hi \(NAME\),\n\nHope you're having a good week!/)
  assert.match(d.body, /understand \(BRAND\)'s goals/)
  assert.doesNotMatch(d.body, /Ideas matched/)
})
t('a category’s first email is the intro plus that category’s angle', () => {
  const e = T.defaultTemplate('cat:energy', ANGLES)
  assert.match(e.body, /Cold cans for \(BRAND\) at peak energy — \(BRAND\) in hand\.\n\nWe'd love to jump on a quick call/)
  assert.doesNotMatch(e.body, /\{brand\}/)
  // No angle of its own → the general one.
  assert.match(T.defaultTemplate('cat:home', ANGLES).body, /Ideas matched to \(BRAND\)\./)
  // No angles at all → the plain intro.
  assert.equal(T.defaultTemplate('cat:home').body, T.defaultTemplate('intro').body)
})
t('stored versions: only known keys with real text', () => {
  const own = T.parseOwn({ 'cat:energy': { subject: ' Hi ', body: 'Yo\r\n(NAME)  \n', at: 'x', by: 'Leo' }, 'cat:nope': { subject: 'a', body: 'b' }, intro: { subject: 'a', body: '  ' }, final: 'text' })
  assert.deepEqual(Object.keys(own), ['cat:energy'])
  assert.deepEqual(own['cat:energy'], { subject: 'Hi', body: 'Yo\n(NAME)', at: 'x', by: 'Leo' })
  assert.deepEqual(T.parseOwn(null), {})
  assert.deepEqual(T.parseOwn([1]), {})
})
t('a row is Leo’s version when he has one, else the default', () => {
  const own = T.parseOwn({ 'cat:energy': { subject: 'Mine', body: 'Body', at: '2026-11-16T00:00:00Z', by: 'Leo' } })
  const a = T.templateRow('cat:energy', own, ANGLES)
  assert.equal(a.own, true); assert.equal(a.subject, 'Mine'); assert.equal(a.by, 'Leo')
  assert.match(a.def.body, /Cold cans/)
  const b = T.templateRow('cat:rtd', own, ANGLES)
  assert.equal(b.own, false); assert.equal(b.subject, 'SB Agency x (BRAND)'); assert.equal(b.at, null)
})
t('a save: cleaned; the default text again is no version of his own; empty refused', () => {
  assert.deepEqual(T.ownFromSave('intro', ' New subject ', 'Hi (NAME)\r\n\r\nBye  '), { subject: 'New subject', body: 'Hi (NAME)\n\nBye' })
  const d = T.defaultTemplate('cat:energy', ANGLES)
  assert.equal(T.ownFromSave('cat:energy', d.subject, d.body + '\n', ANGLES), null)
  assert.throws(() => T.ownFromSave('intro', 'x', '   '), /empty/)
  assert.throws(() => T.ownFromSave('intro', ' ', 'text'), /subject/)
  assert.equal(T.ownFromSave('intro', 'x'.repeat(500), 'y'.repeat(9000)).subject.length, T.SUBJECT_MAX)
})
t('Instantly’s tags and the preview fill', () => {
  assert.equal(T.forInstantly('Hi (NAME), (BRAND) [Name] [brand] (name)'), 'Hi {{firstName}}, {{companyName}} {{firstName}} {{companyName}} {{firstName}}')
  assert.equal(T.fillTemplate("(NAME) — (BRAND)'s", 'Alex', 'Liquid Sun'), "Alex — Liquid Sun's")
})
t('every default has a subject, a greeting and no leftover braces', () => {
  for (const k of [...T.GENERAL_KEYS, ...C.CATEGORY_KEYS.map(T.catKey)]) {
    const d = T.defaultTemplate(k, ANGLES)
    assert.ok(d.subject && /^Hi \(NAME\),/.test(d.body), k)
    assert.doesNotMatch(d.body, /[{}]/, k)
  }
})
console.log('\n' + n + ' checks passed')
