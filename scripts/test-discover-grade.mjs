// node scripts/test-discover-grade.mjs — the grade on every Discover find
// (src/lib/discover-grade.ts: Brand Fit as a letter).
import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const out = mkdtempSync(join(tmpdir(), 'dgrade-test-'))
execSync('npx tsc src/lib/discover-grade.ts --outDir ' + out + ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck', { stdio: 'inherit' })
const fs = await import('node:fs')
for (const f of fs.readdirSync(out)) {
  if (!f.endsWith('.js')) continue
  const p = join(out, f)
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/from '\.\/([\w-]+)'/g, "from './$1.js'"))
}
const { gradeDiscovery, gradeFromFit, letterFor, hasSign } = await import(pathToFileURL(join(out, 'discover-grade.js')).href)
const { readFind, scoreFind } = await import(pathToFileURL(join(out, 'find-evidence.js')).href)
const { scoreBrand } = await import(pathToFileURL(join(out, 'brand-fit.js')).href)

let n = 0
function t(name, fn) { fn(); n++; console.log('  ok — ' + name) }
const now = new Date('2026-10-15T12:00:00Z')
const ctx = (priority) => ({ priority, acceptRate: null, now })
const M = 1e6 * 100

t('letters by score: A 65 / B 50 / C 40', () => {
  assert.equal(letterFor(65), 'A'); assert.equal(letterFor(64), 'B'); assert.equal(letterFor(50), 'B')
  assert.equal(letterFor(49), 'C'); assert.equal(letterFor(40), 'C'); assert.equal(letterFor(39), 'D')
})

t('signs are read from the comma list', () => {
  assert.ok(hasSign(' genz , midsize', 'midsize')); assert.ok(!hasSign(null, 'sponsors'))
})

t('the write-up: money raised, sales, never a valuation or a price', () => {
  assert.equal(readFind('CB Insights lists a $2M seed round on Mar 4 2026').fundingCents, 2 * M)
  assert.equal(readFind('closed a $10M Series A Feb 2026').fundingCents, 10 * M)
  assert.equal(readFind('Women-owned Spirited Brands raised $3.1M in 2025').fundingCents, 3.1 * M)
  assert.equal(readFind('raised two $7M rounds and had ~4,500 doors').fundingCents, 14 * M)
  assert.equal(readFind('a $106M round at $500M+ valuation, all Kroger divisions').fundingCents, 106 * M)
  assert.equal(readFind('>$10M run rate, revenue doubled YoY').salesCents, 10 * M)
  assert.equal(readFind('Blanco $70 / Reposado $80, $57.99 a bottle').fundingCents, null)
  assert.equal(readFind('US dollar sales up 198% (SPINS)').salesCents, null)
})

t('the write-up: biggest store count, a parent, college / music', () => {
  assert.equal(readFind('in 3,500+ c-stores across TX').stores, 3500)
  assert.equal(readFind('~21,000 points of distribution incl. Walmart going to 3,200+ stores').stores, 21000)
  assert.equal(readFind('Organic electrolyte drink in 6,000+ stores (Publix 1,300 stores)').stores, 6000)
  assert.equal(readFind("Eugene brewery (owned by Tilray's beer arm)").parentNamed, 'Tilray')
  assert.ok(readFind('the Oregon Ducks’ first official craft beer at Autzen Stadium').college)
  assert.ok(readFind('presented his stadium tour and country festival sponsorships').music)
})

const text = (s) => ({ text: s })
t('a Top category that pays for college, nothing else known = 45 (C)', () => {
  const g = gradeDiscovery({ category: 'rtd', signals: 'sponsors', ...text('Official craft beer of the Pac-12 Conference.') }, ctx('top'))
  assert.equal(g.score, 45); assert.equal(g.grade, 'C')
  assert.ok(g.reasons.some(r => /already pays for college/.test(r.text) && r.points === 20))
})

t('proof in the write-up moves a find up', () => {
  const g = gradeDiscovery({ category: 'rtd', signals: 'sponsors', ...text(
    '>$10M run rate, revenue doubled YoY, in 8,000+ stores incl. Costco and Kroger; official beer partner of Texas A&M athletics.') }, ctx('top'))
  assert.equal(g.grade, 'A', JSON.stringify(g))
  assert.ok(g.reasons.some(r => /sweet spot/.test(r.text) && r.points === 25))
  assert.ok(g.reasons.some(r => /8,000\+ stores incl\. costco, kroger/.test(r.text) && r.points === 15))
  assert.ok(g.reasons.some(r => /growing fast/.test(r.text)))
})

t('money to spend but not too big: a parent or a giant gets no money points', () => {
  const base = { category: 'rtd', signals: 'sponsors', text: 'Owned by Tilray, raised $50M, official beer of the Ducks.' }
  const g = gradeDiscovery(base, ctx('top'))
  assert.ok(g.reasons.some(r => /owned by Tilray — too big for now/.test(r.text) && r.points === 0))
  const giant = gradeDiscovery({ ...base, text: 'Raised $50M.', giant: 'household name' }, ctx('top'))
  assert.ok(giant.reasons.some(r => /giant \(household name\)/.test(r.text)))
})

t('only popular with students counts less than paying for it', () => {
  const pop = scoreFind({ priority: 'top', text: 'Preppy brand hugely popular with college women and sororities.' })
  const pays = scoreFind({ priority: 'top', text: 'Official apparel partner of Cal men’s golf.' })
  assert.ok(pays.score > pop.score)
})

t('a Low category with nothing proven → D; Skip → D whatever it proves', () => {
  assert.equal(gradeDiscovery({ category: 'apparel', signals: 'genz', text: 'Streetwear label.' }, ctx('low')).grade, 'D')
  const skip = gradeDiscovery({ category: 'betting', signals: 'sponsors', text: 'Raised $40M, official partner of the Big Ten, 5,000 stores, doubled.' }, ctx('skip'))
  assert.equal(skip.grade, 'D'); assert.equal(skip.capped, 'Skip category')
})

t('every point has a reason, score stays 0..100', () => {
  const g = scoreFind({ priority: 'top', signals: 'genz', text: '$40M in sales, doubled, 9,000 stores at Walmart, official partner of the SEC, festival sponsor.' })
  assert.equal(g.reasons.reduce((s, r) => s + r.points, 0), g.score); assert.ok(g.score <= 100)
  // With the student fit a total can pass 100: a line says the score stops there.
  const w = 'Nootropic gum, $40M in sales, doubled, 9,000 stores at Walmart, official partner of the SEC, festival sponsor.'
  const top = scoreFind({ priority: 'top', signals: 'genz', text: w, writeUp: w, name: 'Max', now })
  assert.equal(top.score, 100); assert.equal(top.reasons.reduce((s, r) => s + r.points, 0), 100)
  assert.ok(top.reasons.some(r => r.points < 0 && /stops at 100/.test(r.text)))
})

// Leo, Oct 18 2026: "neuro should definitely be higher given that the ideal
// candidates are people who study and do work" — it was 46 C.
const NEURO = 'Neuro caffeine/nootropic energy gum and mints. First mass-retail entry Feb 2026 with Walmart endcaps in 202 stores ' +
  '(CA, TX, NV, OR, OK), with the full line to follow later in 2026. Says it is in 10,000+ stores (Whole Foods, CVS, Albertsons).'
const NEURO_PITCH = "Finals-week 'Study Hall' pop-up before a campus show: free Neuro packs at the door plus a branded chill-out zone in the venue."
t('fits a student’s day: Neuro, made for studying, is an A (was 46 C)', () => {
  const g = gradeDiscovery({ category: 'energy', name: 'Neuro', writeUp: NEURO, text: NEURO + ' ' + NEURO_PITCH }, ctx('top'))
  const r = (re) => g.reasons.find(x => re.test(x.text))
  assert.equal(r(/studying \/ focus/).points, 20)
  assert.match(r(/studying/).text, /nootropic/)
  assert.equal(r(/growing fast/).points, 10, 'a first mass-retail entry is growth')
  assert.match(r(/growing fast/).text, /First mass-retail/)
  assert.equal(g.score, 76); assert.equal(g.grade, 'A')
})

t('the student fit and launches read the brand’s write-up, never our pitch', () => {
  const g = scoreFind({ priority: 'top', name: 'Casa X', writeUp: 'Premium tequila from Jalisco.',
    text: 'Premium tequila from Jalisco. Finals-week study break at a campus party, launching at Walmart.' })
  assert.equal(g.reasons.find(x => /student use/.test(x.text)).points, 0)
  assert.ok(!g.reasons.some(x => /growing fast/.test(x.text)))
  const none = scoreFind({ priority: 'top', name: 'Casa X' })
  assert.match(none.reasons.find(x => x.points === 0 && /on file/.test(x.text)).text, /isn’t on file/)
})

t('launches count as growth, once; a footprint that just is doesn’t', () => {
  const grow = (w) => scoreFind({ priority: 'middle', name: 'X', writeUp: w, text: w, now }).reasons.filter(x => /growing fast/.test(x.text))
  for (const w of ['national launch in all 2,300+ Albertsons stores', 'rolling out to Kroger', 'added 400 SoCal stores in 2026',
    'expanding into Walmart', 'moved to Shaw-Ross national distribution in Jan 2025', 'Pure line into Target 2026',
    '2025 rollout into 1,309 Publix stores', 'expanding its US footprint: signed Republic National Distributing', 'expanding to 9 more states']) {
    assert.equal(grow(w).length, 1, w)
  }
  assert.equal(grow('sales doubled, then a national launch').length, 1, 'never twice')
  assert.equal(grow('doubled').at(0).text, 'growing fast')
  // The review of Oct 18 2026: none of these is a launch.
  for (const w of ['sold in 48 states', 'a music-led brand with national distribution', 'launched in 2019', 'DTC brand that ships to 48 states',
    'Sold to 30 states via distributors', 'the CEO called it an expansion into collegiate sponsorships', 'expanding into year-round apparel',
    'the family expand to include Gin Sul', 'Expanded to 12 flavors', 'Expanding its team in Austin', 'Won a national award at Expo West 2024',
    'Gained national attention on TikTok', 'Landed national press in Forbes', 'Signed NIL deals with national champion Georgia athletes',
    'Launched a national ad campaign with NIL athletes', 'Rolled out a TikTok campaign with creators', 'Taps into target audiences on TikTok',
    'Founded in 2012; launched at Whole Foods in 2013', 'Launched at Target in 2017.', 'Sold into Walmart since 2015',
    // the second review
    'Expanded into Walmart (1,200 stores) in 2016.', 'Rolled out to 500 Kroger stores (CA, TX) in 2015.', 'Launched nationally in the U.S. in 2012 and now sells in 40 states.',
    'Expanded into Target in Jan. 2016.', 'Rolled out to Kroger with Acme Inc. in 2015.', 'added 400 SoCal stores in 2024 and its flavor sold out again in Mar 2025.',
    'expanded into Canada in 2016 and launched a new flavor in 2026', 'Lifestyle brand expanding across apparel, accessories and home goods.',
    'Expanding its social reach with a new campaign.', 'Debuted new retail-ready packaging in 2026.', 'Hard seltzer that launched at Target Field with the Twins.',
  ]) assert.equal(grow(w).length, 0, w)
  for (const w of ['Acme (founded 2014) is rolling out to 500 new Kroger stores.', 'expanded into the U.S. market', 'went nationwide at ~2,700 ALDI stores in March 2026',
    'expanded into nearly 250 H-E-B stores in Apr 2026, its largest rollout', 'Protein Pop to retail with a Target launch in April 2026', 'into 3,800+ Walmart stores in Apr 2025',
    'launching in 35 states', 'launched Apr 24 2026 exclusively at Walmart stores nationwide', 'deal expanding across PA, CT and the Northeast',
    // the third review (real finds)
    'went national at Whole Foods, Total Wine and Carnival (Feb 2026)', 'Foley Family Wines took it national as exclusive US distributor, per 2025 coverage',
    'entered Texas via Capital Reyes June 2026', 'Aug 2026 LibDib expansion into CA, CO, FL, IL, NY', 'in Mar 2025 launched in Florida with community activations',
    'expanding into Southern California via Breakthru (May 2026)', 'Mar 2026 signed Los Angeles Distributing to expand across SoCal', 'expanded into NY',
    'June 2026 Reyes Beverage Group deal took it to 20 states', 'launched May 14 2026 on GoPuff in Philadelphia with NY, CA, FL rollout',
    'June 2026 Reyes and Martignetti distribution deals across 20+ states', 'rolling into Indiana retail', 'relaunched 2026 with Crescent Crown distribution in LA',
    'launched in the US market in June 2025', 'Aug 2026 125-store DFW c-store commitment', 'launched its RTD line nationwide at The Vitamin Shoppe in Jul 2026',
    'went from H-E-B to 1,750+ Target stores nationwide in Feb 2026', 'growing on the West Coast: Fred Meyer (Dec 2025)', 'rolling into specialty, large-format retail',
    'expanding city by city from Feb 2026, Denver first']) assert.equal(grow(w).length, 1, w)
  for (const w of ['expanding into apparel in a new way', 'rolled out a campaign to me and you']) assert.equal(grow(w).length, 0, w + ' (state codes only right after the verb)')
})

t('a find on the roster grades on its brand’s own Brand Fit', () => {
  const f = scoreBrand({ category: 'energy', priority: 'top', salesCents: 120 * M, sponsorsCollege: true, reachable: 4, need: 4, acceptRate: 0.3, now })
  const g = gradeFromFit(f); assert.equal(g.score, f.score); assert.equal(g.grade, 'A')
  assert.equal(gradeFromFit(scoreBrand({ category: 'energy', priority: 'top', usStatus: 'no', reachable: 4, need: 4, now })).capped, 'not sold in the US')
  const small = scoreBrand({ category: 'energy', priority: 'top', salesCents: 500_000 * 100, sponsorsCollege: true, reachable: 4, need: 4, now })
  assert.ok(small.tooSmall); assert.ok(['C', 'D'].includes(gradeFromFit(small).grade))
  // Neuro on the roster (Oct 18 2026: 63 B) — its write-up lives in its notes.
  const neuro = scoreBrand({ category: 'energy', priority: 'top', tier: 'growth', name: 'Neuro', reachable: 0, need: 4, now,
    notes: 'Discover: ' + NEURO + '\nActivation idea: ' + NEURO_PITCH + '\nFound in: https://example.com' })
  assert.equal(neuro.score, 83); assert.equal(gradeFromFit(neuro).grade, 'A')
})

console.log(n + ' passed')
