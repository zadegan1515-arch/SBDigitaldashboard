// scripts/test-stock.mjs — guards src/lib/stock.ts (Brands → Stock take,
// and the re-file that makes Leo's lanes real categories).
//
// A brand in the wrong category makes a lane look thinner or fuller than
// it is and puts it on the wrong Schedule day; a brand in two rows makes
// the totals lie; a re-file that isn't stable would keep offering to move
// the same brands. All pinned here against the real seed list
// (data/brands.json) and the built-in summaries. Compiles the lib on its
// own, like test-region.mjs. Run: node scripts/test-stock.mjs

import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = mkdtempSync(join(tmpdir(), 'stock-test-'))
execSync(
  'npx tsc src/lib/stock.ts src/lib/category-hints.ts --outDir ' + out +
  ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck',
  { stdio: 'inherit' },
)
const { placeBrand, refileMoves, remapPlanDays, stateOf, buildStock, brandKey, bestDealStage, LANES, SORTABLE } =
  await import(pathToFileURL(join(out, 'stock.js')).href)
const { guessCategory } = await import(pathToFileURL(join(out, 'category-hints.js')).href)

let pass = 0, fail = 0
const is = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return }
  fail++; console.log('✗', label, '— got', JSON.stringify(got), 'want', JSON.stringify(want))
}

const summaries = JSON.parse(readFileSync('src/data/brand-summaries.json', 'utf8'))
const about = name => summaries[name.toLowerCase()] || {}
const brand = (name, category, extra = {}) => ({
  id: 'b_' + brandKey(name) + '_' + category, name, aka: null, category, tier: null,
  about: about(name).about ?? null, topProducts: about(name).topProducts ?? null,
  linkedinUrl: null, externalId: null, archived: false, doNotEmail: false,
  people: 0, invited: 0, accepted: 0, emailed: 0, replied: 0, queued: 0,
  dealStage: null, activations: 0, ...extra,
})
const to = (name, category, extra) => placeBrand(brand(name, category, extra)).to

// --- the seed list, as it was filed ---------------------------------
const seed = JSON.parse(readFileSync('data/brands.json', 'utf8'))
const seeded = seed.categories.flatMap(c => c.brands.map(b => brand(b.name, c.key)))
const seedTo = Object.fromEntries(seeded.map(b => [b.name, placeBrand(b).to]))

// Electrolytes were filed under two categories; they all go to one.
is('Liquid I.V. (wellness)',   seedTo['Liquid I.V.'], 'electrolytes')
is('LMNT (wellness)',          seedTo['LMNT'], 'electrolytes')
is('Leisure Hydration',        seedTo['Leisure Hydration'], 'electrolytes')
is('Prime Hydration (bev)',    seedTo['Prime Hydration'], 'electrolytes')
is('Celsius',                  seedTo['Celsius'], 'energy')
is('Red Bull',                 seedTo['Red Bull'], 'energy')
is('Ghost Energy',             seedTo['Ghost Energy'], 'energy')
is('Gorgie (no about)',        seedTo['Gorgie'], 'energy')
is('A1R Water stays a drink',  seedTo['A1R Water'], 'beverage')
is('k2o stays a drink',        seedTo['k2o'], 'beverage')
is('Poppi (wellness) → drinks', seedTo['Poppi'], 'beverage')
is('Recess (wellness) → drinks', seedTo['Recess'], 'beverage')
is('Liquid Death (nightlife) → drinks', seedTo['Liquid Death'], 'beverage')
is('BeatBox (nightlife)',      seedTo['BeatBox Beverages'], 'rtd')
is('Happy Dad (nightlife)',    seedTo['Happy Dad'], 'rtd')
for (const n of ['High Noon', 'White Claw', 'Nutrl', 'Surfside', 'BuzzBallz', 'Mom Water', 'SipMargs', 'Sprinter', 'Loverboy']) {
  is(n + ' is a can', seedTo[n], 'rtd')
}
is('818 Tequila',              seedTo['818 Tequila'], 'spirits')
for (const n of ['Zyn', 'Velo', 'On!', 'Rogue', 'Lucy']) is(n + ' stays nicotine', seedTo[n], 'nicotine')
for (const n of ['Gymshark', 'Lululemon']) is(n + ' is athletic', seedTo[n], 'athletic')
for (const n of ['Chubbies', 'True Classic', 'Vineyard Vines', 'Kulani Kinis', 'Revolve', 'Guess', 'Skims', 'goodr', 'Pickle']) {
  is(n + ' stays clothing', seedTo[n], 'apparel')
}
for (const n of ['Govee', 'Fujifilm Instax', 'Loop Earplugs']) is(n + ' stays nightlife', seedTo[n], 'nightlife')
for (const n of ['AG1', 'Vital Proteins', 'Thorne', 'Lemme', 'Royal Honey']) is(n + ' stays wellness', seedTo[n], 'wellness')
for (const [n, c] of [['FanDuel', 'betting'], ['Takis', 'cpg'], ['Anker', 'tech'], ['Robinhood', 'fintech'], ['Hinge', 'apps'], ['UFC', 'entertainment'], ['Cloud', 'unresolved']]) {
  is(n + ' stays put', seedTo[n], c)
}

// --- brands from the summaries list (the wider roster) ---------------
is('Bud Light',          to('Bud Light', 'alcohol'), 'rtd')
is('Modelo (lager)',     to('Modelo', 'alcohol'), 'rtd')
is('Casamigos',          to('Casamigos', 'alcohol'), 'spirits')
is('Malibu lists canned cocktails but is rum', to('Malibu', 'alcohol'), 'spirits')
is('Bacardi likewise',   to('Bacardi', 'alcohol'), 'spirits')
is('Smirnoff (seltzers in products) is spirits', to('Smirnoff', 'alcohol'), 'spirits')
is('Carbliss by words',  to('Carbliss', 'alcohol'), 'rtd')
is('Monster Energy',     to('Monster Energy', 'beverage'), 'energy')
is('5-hour Energy',      to('5-hour Energy', 'beverage'), 'energy')
is('Gatorade',           to('Gatorade', 'beverage'), 'electrolytes')
is('BodyArmor',          to('BodyArmor', 'beverage'), 'electrolytes')
is('Electrolit',         to('Electrolit', 'beverage'), 'electrolytes')
is('Waterloo',           to('Waterloo', 'beverage'), 'beverage')
is('Olipop',             to('Olipop', 'beverage'), 'beverage')
is('Nike',               to('Nike', 'apparel'), 'athletic')
is('Rhoback by words',   to('Rhoback', 'apparel'), 'athletic')
is('Crocs',              to('Crocs', 'apparel'), 'apparel')
is('Princess Polly',     to('Princess Polly', 'apparel'), 'apparel')
is('Supplement stays wellness', to('Ryse', 'wellness'), 'wellness')
is('Ghost filed as wellness goes by name', to('Ghost', 'wellness'), 'energy')

// --- names, aliases and whose filing wins ----------------------------
is('key: Liquid IV = Liquid I.V.', brandKey('Liquid IV'), brandKey('Liquid I.V.'))
is('key: Nütrl = Nutrl', brandKey('Nütrl'), brandKey('NUTRL'))
is('key: corporate tail', brandKey('BeatBox Beverages'), brandKey('BeatBox'))
is('aka carries the name', to('Stateside Surfside Co', 'alcohol', { aka: 'Surfside' }), 'rtd')
is('On Running filed apparel', to('On Running', 'apparel'), 'athletic')
is('Zyn in an old broad bucket goes by name', to('Zyn', 'apparel'), 'nicotine')
is('Needs Clarification can move by name', to('Zyn', 'unresolved'), 'nicotine')
is('unfiled can move by name', to('Liquid I.V.', null), 'electrolytes')
is('unfiled never moves by words', to('Mystery Hydration Co', null), null)
is('Needs Clarification never moves by words', to('Mystery Hydration Co', 'unresolved'), 'unresolved')
is('unknown alcohol stays alcohol', to('Some Distillery Holdings', 'alcohol'), 'alcohol')
// Leo's filing wins: a specific category is never second-guessed.
is('Gatorade filed as snacks stays', to('Gatorade', 'cpg'), 'cpg')
is('Celsius filed as electrolytes stays', to('Celsius', 'electrolytes'), 'electrolytes')
is('Liquid Death filed as energy stays', to('Liquid Death', 'energy'), 'energy')
is('Nike filed as clothing stays... no: apparel is the old bucket', to('Nike', 'apparel'), 'athletic')
is('a new category is not sortable', ['electrolytes', 'energy', 'rtd', 'spirits', 'athletic', 'nicotine'].some(k => SORTABLE.includes(k)), false)
is('why: name', placeBrand(brand('Celsius', 'beverage')).why, 'name')
const w = placeBrand(brand('Unheard Co', 'alcohol', { about: 'Craft IPA brewery from Ohio' }))
is('why: words, with what matched', [w.to, w.why, w.match], ['rtd', 'words', 'IPA'])
is('why: filed', placeBrand(brand('Takis', 'cpg')).why, 'filed')

// --- the re-file ------------------------------------------------------
const wider = [
  ...seeded,
  brand('Bud Light', 'alcohol'), brand('Casamigos', 'alcohol'), brand('Some Distillery Holdings', 'alcohol'),
  brand('Monster Energy', 'beverage'), brand('Gatorade', 'beverage'), brand('Nike', 'apparel'),
  brand('Gatorade Filed', 'cpg', { aka: 'Gatorade' }), brand('Celsius Two', 'electrolytes', { aka: 'Celsius' }),
]
const moves = refileMoves(wider)
const moved = Object.fromEntries(moves.map(m => [m.name, m.to]))
is('moves Liquid I.V. to electrolytes', moved['Liquid I.V.'], 'electrolytes')
is('moves Celsius to energy', moved['Celsius'], 'energy')
is('moves BeatBox to cans', moved['BeatBox Beverages'], 'rtd')
is('moves Nike to athletic', moved['Nike'], 'athletic')
is('does not move what stays', ['Chubbies', 'Takis', 'Zyn', 'A1R Water', 'Some Distillery Holdings'].some(n => n in moved), false)
is('never moves a specific filing', ['Gatorade Filed', 'Celsius Two'].some(n => n in moved), false)
is('every move changes something', moves.every(m => m.to !== m.from), true)
is('moves come grouped in lane order', moves[0].to, 'electrolytes')
// Stable: apply the moves, ask again, nothing left to move.
const after = wider.map(b => { const m = moves.find(x => x.id === b.id); return m ? { ...b, category: m.to } : b })
is('applying the moves leaves nothing to move', refileMoves(after).length, 0)
is('the stock take agrees after the move', buildStock(after).refile, 0)
is('the stock take counts the moves before', buildStock(wider).refile, moves.length)

// Planned Schedule days follow their category's biggest share.
const count = list => list.reduce((o, b) => { const k = b.category ?? 'unresolved'; o[k] = (o[k] ?? 0) + 1; return o }, {})
const plan = {
  '2026-09-29': { category: 'alcohol' },
  '2026-09-30': { category: 'apparel' },
  '2026-10-01': { category: 'beverage' },
  '2026-09-01': { category: 'alcohol' },
  '2026-10-02': { category: null },
}
const days = remapPlanDays(plan, moves, count(wider), '2026-09-24')
const dayTo = Object.fromEntries(days.map(d => [d.day, d.to]))
is('alcohol day follows the cans', dayTo['2026-09-29'], 'rtd')
is('apparel day stays clothing (most stay)', '2026-09-30' in dayTo, false)
is('beverage day follows energy', dayTo['2026-10-01'], 'energy')
is('past days are left alone', '2026-09-01' in dayTo, false)
is('days with no category are left alone', '2026-10-02' in dayTo, false)
const alc = days.find(d => d.day === '2026-09-29')
is('says how many move and stay', [alc.moving > alc.staying, alc.staying], [true, 1])

// --- state ------------------------------------------------------------
const st = extra => stateOf(brand('X', 'beverage', extra))
is('nobody on file',     st({}), 'needs')
is('people, untouched',  st({ people: 4 }), 'ready')
is('invited',            st({ people: 4, invited: 1 }), 'reached')
is('emailed only',       st({ people: 1, emailed: 1 }), 'reached')
is('replied',            st({ people: 4, invited: 2, replied: 1 }), 'replied')
is('deal in talks',      st({ dealStage: 'proposal' }), 'replied')
is('verbal = business',  st({ dealStage: 'verbal' }), 'business')
is('activation = business', st({ activations: 1 }), 'business')
is('archived',           st({ people: 4, archived: true }), 'off')
is('archived after a reply', st({ people: 4, replied: 1, archived: true }), 'off')
is('do-not-email',       st({ doNotEmail: true }), 'off')
is('business beats archived', st({ archived: true, dealStage: 'closed' }), 'business')
is('internal record',    stateOf(brand('SB Agency (internal)', null)), 'off')
is('lost deal is nothing', bestDealStage(['lost']), null)
is('furthest deal wins', bestDealStage(['conversation', 'closed', 'lost']), 'closed')

// --- the whole roster -------------------------------------------------
const roster = seeded.map((b, i) => ({
  ...b,
  people: i % 5 === 0 ? 0 : 3 + (i % 30),
  invited: i % 3 === 0 ? 1 : 0,
  externalId: i % 4 === 0 ? null : 'su' + i,
}))
roster.push(brand('Casamigos', 'alcohol', { people: 6, replied: 1, invited: 2 }))
roster.push(brand('Old Brewing Co', 'alcohol', { aka: 'Yuengling' }))
roster.push(brand('Archived Thing', 'apparel', { archived: true, people: 2 }))
roster.push(brand('Some Distillery Holdings', 'alcohol', { people: 2 }))
roster.push(brand('Unfiled Co', null))
const s = buildStock(roster)
const rows = [...s.lanes, ...s.others]
is('every brand lands once', rows.reduce((n, r) => n + r.counts.total, 0), roster.length)
is('row brand lists match counts', rows.every(r => r.brands.length === r.counts.total), true)
is('totals.brands', s.totals.total, roster.length)
is('state counts add up', ['business', 'replied', 'reached', 'ready', 'needs', 'off'].reduce((n, k) => n + s.totals[k], 0), roster.length)
is('17 seed categories in use', s.totals.categories, 17)
is('priority lanes lead, in order', s.lanes.map(r => r.key), LANES.filter(l => l.priority).map(l => l.key))
is('a lane row files under its own key', s.lanes.every(r => r.file === r.key), true)
is('drinks sit in others', s.others.some(r => r.key === 'beverage'), true)
is('unsorted alcohol has its own row', s.others.some(r => r.key === 'alcohol' && r.counts.total === 1), true)
is('unfiled brands last', s.others[s.others.length - 1].key, 'uncategorised')
is('unfiled row adds nothing', s.others[s.others.length - 1].file, null)

const ideas = key => s.lanes.find(r => r.key === key).ideas
is('ideas skip the roster', ideas('spirits').includes('Casamigos'), false)
is('ideas skip an aka', ideas('rtd').includes('Yuengling'), false)
is('ideas offer what is missing', ideas('electrolytes').includes('Pedialyte'), true)
is('ideas use the display name', ideas('electrolytes').includes('Liquid I.V.'), false)
is('no ideas outside priority lanes', s.others.every(r => r.ideas.length === 0), true)
const casa = s.lanes.find(r => r.key === 'spirits').brands.find(b => b.name === 'Casamigos')
is('replied brand keeps its state', casa.state, 'replied')
is('pipeline order in a row', s.lanes.find(r => r.key === 'spirits').brands[0].name, 'Casamigos')

// --- a new brand's first guess (paste, LinkedIn "add as new brand") ----
// The hint is usually LinkedIn's industry line. It must land in the new
// categories, or every new brand needs a re-file.
for (const [name, hint, want] of [
  ['LMNT', 'Electrolyte drink mix', 'electrolytes'],
  ['Celsius', 'Energy drink', 'energy'],
  ['Twisted Tea', 'Hard iced tea', 'rtd'],
  ['Breckenridge', 'Breweries', 'rtd'],
  ['Casamigos', 'Wine & Spirits', 'spirits'],
  ["Barq's", 'Root beer', 'beverage'],
  ['Stumptown', 'Cold brew coffee', 'beverage'],
  ['Vuori', 'Sporting Goods Manufacturing', 'athletic'],
  ['Chubbies', 'Retail Apparel and Fashion', 'apparel'],
  ['Zyn', 'Tobacco Manufacturing', 'nicotine'],
  ['Mystery', '', 'unresolved'],
]) is('guess: ' + name + ' / ' + hint, guessCategory(name, hint), want)
const known = LANES.map(l => l.key)
is('every guess is a known category or unresolved',
  ['electrolytes', 'energy', 'rtd', 'spirits', 'athletic'].every(k => known.includes(k)), true)

// No known name may sit in two lanes — the first would silently win.
const seen = new Map()
for (const l of LANES) for (const k of new Set(l.known.flatMap(x => x.split('|')).map(brandKey))) {
  if (seen.has(k)) { fail++; console.log('✗ known in two lanes:', k, seen.get(k), l.key) }
  else { seen.set(k, l.key); pass++ }
}

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
