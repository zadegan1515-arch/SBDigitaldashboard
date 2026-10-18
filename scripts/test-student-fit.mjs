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
  assert.equal(pts('Texas-born focus energy drink'), 20)
  assert.equal(pts('Caffeine gum started by college students'), 20)
  assert.equal(pts('Caffeine (nicotine-free) pouch founded by a student'), 20, 'words between caffeine and pouch')
  assert.equal(pts('Louisville caffeinated sparkling water (75mg caffeine + L-theanine)'), 20)
  assert.equal(pts('Mushroom (lion’s mane, cordyceps) energy drink'.replace('’', "'")), 20)
  assert.equal(pts('a snack for late-night studying'), 20)
})

// The review of Oct 18 2026: every one of these scored 20 before.
t('a study, a focus market, eye exams, brain freeze are not studying', () => {
  for (const s of ['with a Gen Z focus', 'Kombucha brand with a strong regional focus in Texas', 'Tested flavors with student focus groups',
    'Apparel brand with a laser focus squarely on Gen Z women', 'Its main focus is clean ingredients', 'Texas is a focus market for the brand',
    'with a focus on Gen Z', "Unilever's youth-focused men's fragrance", 'tequila in expansion mode, focused on on-premise growth',
    'A 2025 Circana study named it the top RTD with Gen Z', 'Supplement backed by a clinical study.', 'Study abroad travel company', 'a case study in brand building',
    'DTC eyewear with free eye exams', 'Slushie mix known for brain freeze', 'Streetwear label Brain Dead', 'The brain behind the brand is a former Nike designer',
    'Mental health app offering cognitive behavioral therapy']) assert.notEqual(pts(s), 20, s)
  assert.equal(S.studentUse('NERD Focus'), null, 'a name never earns the 20 (Focus Brands is a restaurant group)')
})

t('nights out / the morning after = 15', () => {
  assert.equal(pts('Isotonic hydration born as a hangover drink'), 15, 'hangover beats hydration')
  assert.equal(pts('Late-night warm cookie delivery brand'), 15)
  assert.equal(pts('Round single-serve canned cocktails with grab-and-go party appeal'), 15)
  assert.equal(pts('Protein powder, 3rd-party tested for purity'), 10, '3rd-party tested is protein, not a party')
  assert.equal(pts('Protein powder, 3rd party tested.'), 10)
  for (const s of ['ships through a third-party warehouse', 'Chips in party-size bags', 'Candy brand selling party packs', 'appeared on Late Night with Seth Meyers'])
    assert.equal(label(s), null, s)
})

t('game day / campus life = 15 — where the product lives, never campus marketing', () => {
  for (const s of ['Kansas City gameday/vintage tee brand licensed with 50–60 schools', 'Licensed collegiate headwear maker', 'sold at the Liacouras Center and campus bodegas',
    'big with students and tailgaters', 'the it-drink of tailgates and beach days', 'Late-night cookies built around college campuses',
    'Built on campus — once in ~5,000 university bookstores', 'on campuses via Compass Group dining', 'Chicken finger chain with fanatical college-town followings',
    'owns the yoga and campus-wear market']) assert.equal(pts(s), 15, s)
  for (const s of ["ran a 'Dakine Days' campus tour with gear and giveaways with campus surf clubs", 'a large campus ambassador program', 'A large campus brand ambassador program',
    'previewed at college game-day activations in Austin', 'Ran a sampling tour across 30 campuses', 'Brand ambassadors on 100+ campuses', 'Hires campus reps at 40 schools',
    'Campus sponsorships at five SEC schools', 'Ran campus pop-ups at 12 schools', 'HQ on a 40-acre corporate campus in Ohio', 'a campus ambassador program at 50 campuses',
    'Sampling on 40 college campuses this fall', 'Official Rum of McNeese Athletics (Jul 2025) incl. tailgate sponsorship', 'Ran a tailgate tour across SEC schools',
    'Tailgate activations at Texas A&M', 'Presenting sponsor of ESPN College GameDay', 'ambassadors on campus hand out samples']) assert.equal(label(s), null, s)
})

t('energy / hydration / workout = 10 — the product, never a vibe, solar power or skincare', () => {
  for (const s of ['Zero-sugar electrolyte powder', 'Protein snack brand big in gym culture', 'High-caffeine coffee brand', 'Celsius sparkling energy drinks',
    'Clean-label daily hydration powder', 'Energy drink in a mint flavor']) assert.equal(pts(s), 10, s)
  for (const s of ['Canned vodka of UFC. High-energy, young-male skew.', 'Herbal soda, caffeine-free and zero sugar', 'Zero caffeine kids drink',
    'Candle brand that brings good energy to every room', 'Solar panels for clean energy at home', 'Energy Star certified appliances',
    'Apparel with the energy of LA streetwear', 'Skincare with hydrating hyaluronic serum and a caffeine eye cream', 'Face moisturizer for deep hydration',
    'Gen Z energy and humor in its ads', 'Hard seltzer brewed with solar energy']) assert.equal(label(s), null, s)
  assert.equal(S.studentUse('', 'Raze Energy').points, 10, 'a name says energy')
  assert.equal(S.studentUse('Premium tequila', 'Prime Hydration').points, 10)
  assert.equal(S.studentUse('Serum for deep skin care', 'Hydrate Labs'), null, 'skincare never')
})

// The second review of Oct 18 2026.
t('second review: recovery drinks, founder stories, caffeine-free pouches, the morning-after pill, licensed gear, workouts, skincare, power', () => {
  const cases = [
    ['Electrolyte + adaptogen hydration and recovery drink from Austin', "Sap's", 10], ['Protein recovery drink for post-workout', 'X', 10],
    ['Festival/rave and Y2K fashion brand aimed squarely at Gen Z partygoers', 'Dolls Kill', 15], ['Hard seltzer made for darties and pregames', 'X', 15],
    ['Drink mix that helps you bounce back after a night of drinking', 'X', 15],
    ['Tequila brand founded by two friends while studying at Ole Miss; in 400 Texas stores', 'Tequila X', 0],
    ['Hard seltzer started by three Duke grads when studying abroad in Spain', 'X', 0], ['Spirits company that donates to scholarships for study abroad', 'X', 0],
    ['Caffeine-free herbal pouches, a nicotine alternative', 'P', 0], ['Nicotine pouch brand sold next to energy drinks and gum at c-stores', 'P', 10],
    ['Zero caffeine mints and gum', 'P', 0], ['Emergency contraception (morning-after pill) brand at Walmart and Target', 'Julie', 0],
    ['Vodka built around college game day; signed a multi-school deal through Learfield', 'GameDay Vodka', 15], ['Presenting sponsor of ESPN College GameDay', 'X', 0],
    ['Indianapolis vintage college apparel brand; 180+ university licenses', 'Homefield', 15], ['Teen/young-adult mall retailer with an NCAA licensed collection', 'X', 15],
    ['Sock brand that holds 300+ NCAA licenses', 'X', 15], ['Boise-based lifting gear and apparel brand', 'Gymreapers', 10], ['Workout apparel and training gear', 'X', 10],
    ['Coconut water brand backed by L.A. Libations', 'X', 10], ["Otsuka's Japanese ion drink launched in the US", 'Pocari', 10],
    ['Hydrating sunscreen and SPF lip balm', 'Supergoop', 0], ['Hydrating shampoo and hair masks', 'OUAI', 0],
    ['Electrolyte drink mix co-founded by a celebrity makeup artist', 'Glow Hydration', 10], ['Zero-sugar energy drink; its founder also started a lotion brand', 'Raze Energy', 10],
    ['Ran sampling at tailgates across the SEC', 'X', 0], ['Official tailgate partner of Ohio State Athletics', 'X', 0], ['Hosted tailgates at 12 schools', 'X', 0],
    ['known for dorm room pop-ups and campus ambassadors', 'X', 0], ['Residential solar panels and home batteries', 'Sunrun Energy', 0],
    ['Kids drink with no sugar or caffeine', 'X', 0], ['Herbal soda (zero sugar/caffeine)', 'X', 0],
    ['Nicotine-free caffeine energy pouch (100/200mg)', 'Wip', 20], ['Nicotine-free caffeine (100mg) pouches', 'X', 20],
  ]
  for (const [text, name, want] of cases) assert.equal(S.studentUse(text, name)?.points ?? 0, want, text)
  assert.equal(pts(S.brandWriteUp({ topProducts: 'Greens powder, colostrum, energy' })), 10, 'a product list’s bare "energy" is its energy drink')
})

t('first tier that matches wins; nothing → null', () => {
  assert.equal(pts('nootropic energy drink for the gym'), 20)
  assert.equal(S.studentUse('Premium tequila from Jalisco'), null)
  assert.equal(S.studentUse(''), null)
  assert.equal(S.studentUse(null), null)
  assert.equal(S.studentUse('Mojo: Nicotine-free Energy Pouches').word, 'Energy Pouches', 'the words as written')
})

t('a roster brand: About, products and the Discover line — never the pitch or Leo’s notes', () => {
  const notes = "Discover: Neuro caffeine/nootropic energy gum and mints. First mass-retail entry Feb 2026.\n" +
    "Activation idea: Finals-week 'Study Hall' pop-up before a campus show.\nFound in: https://example.com/neuro"
  assert.equal(S.discoverWriteUp(notes), 'Neuro caffeine/nootropic energy gum and mints. First mass-retail entry Feb 2026.')
  assert.equal(S.discoverWriteUp('ACQUIRED-- NOT IN PLAY\nDiscover: Spiked lemonade. activation idea: party bus'), 'Spiked lemonade.', 'case-insensitive split')
  assert.equal(S.discoverWriteUp('Leo: saw on Discover: party at the frat\nDiscover: Premium tequila'), 'Premium tequila', 'only a line that starts with it')
  assert.equal(S.discoverWriteUp('Discover: Hangover drink\r\nActivation idea: frat party'), 'Hangover drink')
  assert.equal(S.discoverWriteUp('Zach Knows - SKIP'), '')
  assert.equal(S.discoverWriteUp(null), '')
  const pitchOnly = 'Discover: Premium tequila from Jalisco.\nActivation idea: Finals-week study break at a campus party.'
  assert.equal(S.studentUse(S.brandWriteUp({ notes: pitchOnly }), 'Casa X'), null, 'our pitch is never read')
  assert.equal(S.studentUse(S.brandWriteUp({ notes: 'Leo: they want a party at the game-day tailgate' }), 'Casa X'), null, 'Leo’s notes are never read')
  assert.equal(pts(S.brandWriteUp({ notes })), 20)
  assert.equal(pts(S.brandWriteUp({ about: 'Hydration multiplier popular for hangover recovery' })), 15)
  assert.equal(pts(S.brandWriteUp({ topProducts: 'Hydration drops' })), 10)
})

t('the reason line says what matched, or why nothing did; past 100 says the score stops there', () => {
  const r = S.studentReason(S.studentUse('nootropic gum'), true)
  assert.deepEqual(r, { good: true, text: 'made for studying / focus (“nootropic”)', points: 20 })
  assert.equal(S.studentReason(null, true).points, 0)
  assert.match(S.studentReason(null, true).text, /no student use named/)
  assert.match(S.studentReason(null, false).text, /isn’t on file/)
  const rs = [{ good: true, text: 'a', points: 70 }, { good: true, text: 'b', points: 45 }]
  assert.equal(S.capAt100(rs), 100)
  assert.equal(rs.reduce((n, x) => n + x.points, 0), 100, 'the points still add up to the score')
  assert.equal(rs.at(-1).points, -15)
  const under = [{ good: true, text: 'a', points: 60 }]
  assert.equal(S.capAt100(under), 60); assert.equal(under.length, 1)
})

console.log(`student-fit: ${n} passed`)
