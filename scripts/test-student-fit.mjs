// node scripts/test-student-fit.mjs — does the product fit a student's day?
// (src/lib/student-fit.ts; Leo, Oct 18 2026: "neuro should definitely be
// higher given that the ideal candidates are people who study and do work").
// Read from what the brand says it is, never from our pitch idea.
import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const out = mkdtempSync(join(tmpdir(), 'student-fit-test-'))
execSync('npx tsc src/lib/student-fit.ts --outDir ' + out + ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck', { stdio: 'inherit' })
for (const f of readdirSync(out)) {
  if (!f.endsWith('.js')) continue
  const p = join(out, f)
  writeFileSync(p, readFileSync(p, 'utf8').replace(/from '\.\/([\w-]+)'/g, "from './$1.js'"))
}
const S = await import(pathToFileURL(join(out, 'student-fit.js')).href)

let n = 0
function t(name, fn) { fn(); n++; console.log('  ok — ' + name) }
const pts = (s) => S.studentUse(s)?.points ?? 0
const label = (s) => S.studentUse(s)?.label ?? null

t('made for studying / focus = 20', () => {
  assert.equal(pts('Neuro caffeine/nootropic energy gum and mints'), 20)
  assert.equal(pts('Nicotine-free focus pouches (paraxanthine)'), 20)
  assert.equal(pts('Functional sparkling tea (mood/focus, tea caffeine)'), 20)
  assert.equal(pts('Caffeine gum started by college students'), 20)
  assert.equal(pts('Louisville caffeinated sparkling water (75mg caffeine + L-theanine)'), 20)
  assert.equal(pts('NERD Focus'), 20, 'the name alone counts')
})

t('"focused on" / "youth-focused" / "a focus on" is not a focus product', () => {
  assert.equal(label("Unilever's youth-focused men's fragrance"), null)
  assert.equal(label('tequila in expansion mode, focused on on-premise growth'), null)
  assert.equal(label('with a focus on Gen Z'), null)
  assert.equal(label('a case study in brand building'), null)
})

t('nights out / the morning after = 15', () => {
  assert.equal(pts('Isotonic hydration born as a hangover drink'), 15, 'hangover beats hydration')
  assert.equal(pts('Late-night warm cookie delivery brand'), 15)
  assert.equal(pts('Round single-serve canned cocktails with grab-and-go party appeal'), 15)
  assert.equal(label('ships through a third-party warehouse'), null)
})

t('game day / campus life = 15 — where the product lives, not campus marketing', () => {
  assert.equal(pts('Kansas City gameday/vintage tee brand licensed with 50–60 schools'), 15)
  assert.equal(pts('Licensed collegiate headwear maker'), 15)
  assert.equal(pts('sold at the Liacouras Center and campus bodegas'), 15)
  assert.equal(pts('big with students and tailgaters'), 15)
  assert.equal(label("ran a 'Dakine Days' campus tour with gear and giveaways with campus surf clubs"), null)
  assert.equal(label('a large campus ambassador program'), null)
  assert.equal(label('previewed at college game-day activations in Austin'), null)
})

t('energy / hydration / workout = 10', () => {
  assert.equal(pts('Zero-sugar electrolyte powder'), 10)
  assert.equal(pts('Protein snack brand big in gym culture'), 10)
  assert.equal(pts('High-caffeine coffee brand'), 10)
  assert.equal(label('Canned vodka of UFC. High-energy, young-male skew.'), null, 'a vibe, not a product')
})

t('first tier that matches wins; nothing → null', () => {
  assert.equal(pts('nootropic energy drink for the gym'), 20)
  assert.equal(S.studentUse('Premium tequila from Jalisco'), null)
  assert.equal(S.studentUse(''), null)
  assert.equal(S.studentUse(null), null)
  assert.equal(S.studentUse('Mojo: Nicotine-free Energy Pouches').word, 'Energy Pouches', 'the words as written')
})

t('a roster brand: name, About, products and the Discover write-up — never the pitch or Leo’s notes', () => {
  const notes = "Discover: Neuro caffeine/nootropic energy gum and mints. First mass-retail entry Feb 2026.\n" +
    "Activation idea: Finals-week 'Study Hall' pop-up before a campus show.\nFound in: https://example.com/neuro"
  assert.equal(S.discoverWriteUp(notes), 'Neuro caffeine/nootropic energy gum and mints. First mass-retail entry Feb 2026.')
  assert.equal(S.discoverWriteUp('ACQUIRED-- NOT IN PLAY Discover: Spiked lemonade. Activation idea: party bus'), 'Spiked lemonade.')
  assert.equal(S.discoverWriteUp('Zach Knows - SKIP'), '')
  assert.equal(S.discoverWriteUp(null), '')
  const pitchOnly = 'Discover: Premium tequila from Jalisco.\nActivation idea: Finals-week study break at a campus party.'
  assert.equal(S.studentUse(S.brandWriteUp({ name: 'Casa X', notes: pitchOnly })), null, 'our pitch is never read')
  assert.equal(S.studentUse(S.brandWriteUp({ name: 'Casa X', notes: 'Leo: they want a party at the game-day tailgate' })), null, 'Leo’s notes are never read')
  assert.equal(pts(S.brandWriteUp({ name: 'Neuro', notes })), 20)
  assert.equal(pts(S.brandWriteUp({ name: 'Liquid I.V.', about: 'Hydration multiplier popular for hangover recovery' })), 15)
  assert.equal(pts(S.brandWriteUp({ name: 'Buoy', topProducts: 'Hydration drops' })), 10)
})

t('the reason line says what matched, or why nothing did', () => {
  const r = S.studentReason(S.studentUse('nootropic gum'), true)
  assert.deepEqual(r, { good: true, text: 'made for studying / focus (“nootropic”)', points: 20 })
  assert.equal(S.studentReason(null, true).points, 0)
  assert.match(S.studentReason(null, true).text, /no student use named/)
  assert.match(S.studentReason(null, false).text, /isn’t on file/)
})

console.log(`student-fit: ${n} passed`)
