// scripts/test-stock.mjs — guards src/lib/stock.ts (Brands → Stock take).
//
// The stock take is how Leo reads the whole roster at once: which lane
// every brand sits in and how far outreach got. A brand in the wrong
// lane makes a lane look thinner or fuller than it is, and a brand in two
// rows makes the totals lie, so both are pinned here against the real
// seed list (data/brands.json) and the built-in summaries. Compiles the
// lib on its own, like test-region.mjs. Run: node scripts/test-stock.mjs

import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = mkdtempSync(join(tmpdir(), 'stock-test-'))
execSync(
  'npx tsc src/lib/stock.ts --outDir ' + out +
  ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck',
  { stdio: 'inherit' },
)
const { laneOf, stateOf, buildStock, brandKey, bestDealStage, LANES } =
  await import(pathToFileURL(join(out, 'stock.js')).href)

let pass = 0, fail = 0
const is = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return }
  fail++; console.log('✗', label, '— got', JSON.stringify(got), 'want', JSON.stringify(want))
}

const summaries = JSON.parse(readFileSync('src/data/brand-summaries.json', 'utf8'))
const about = name => summaries[name.toLowerCase()] || {}
const brand = (name, category, extra = {}) => ({
  id: 'b_' + brandKey(name), name, aka: null, category, tier: null,
  about: about(name).about ?? null, topProducts: about(name).topProducts ?? null,
  linkedinUrl: null, externalId: null, archived: false, doNotEmail: false,
  people: 0, invited: 0, accepted: 0, emailed: 0, replied: 0, queued: 0,
  dealStage: null, activations: 0, ...extra,
})
const lane = (name, category, extra) => laneOf(brand(name, category, extra))

// --- the seed list, as it was filed ---------------------------------
const seed = JSON.parse(readFileSync('data/brands.json', 'utf8'))
const seeded = seed.categories.flatMap(c => c.brands.map(b => brand(b.name, c.key)))
const seedLane = Object.fromEntries(seeded.map(b => [b.name, laneOf(b)]))

// Electrolytes were filed under two categories; the lane gathers both.
is('Liquid I.V. (wellness)',   seedLane['Liquid I.V.'], 'electrolytes')
is('LMNT (wellness)',          seedLane['LMNT'], 'electrolytes')
is('Leisure Hydration',        seedLane['Leisure Hydration'], 'electrolytes')
is('Prime Hydration (bev)',    seedLane['Prime Hydration'], 'electrolytes')
is('Celsius',                  seedLane['Celsius'], 'energy')
is('Red Bull',                 seedLane['Red Bull'], 'energy')
is('Ghost Energy',             seedLane['Ghost Energy'], 'energy')
is('Gorgie (no about)',        seedLane['Gorgie'], 'energy')
is('A1R Water',                seedLane['A1R Water'], 'drinks')
is('k2o falls to drinks',      seedLane['k2o'], 'drinks')
is('Poppi (wellness)',         seedLane['Poppi'], 'drinks')
is('Recess (wellness)',        seedLane['Recess'], 'drinks')
is('Liquid Death (nightlife)', seedLane['Liquid Death'], 'drinks')
is('BeatBox (nightlife)',      seedLane['BeatBox Beverages'], 'rtd')
is('Happy Dad (nightlife)',    seedLane['Happy Dad'], 'rtd')
for (const n of ['High Noon', 'White Claw', 'Nutrl', 'Surfside', 'BuzzBallz', 'Mom Water', 'SipMargs', 'Sprinter', 'Loverboy']) {
  is(n + ' is a can', seedLane[n], 'rtd')
}
is('818 Tequila',              seedLane['818 Tequila'], 'spirits')
for (const n of ['Zyn', 'Velo', 'On!', 'Rogue', 'Lucy']) is(n, seedLane[n], 'nicotine')
for (const n of ['Gymshark', 'Lululemon']) is(n + ' is athletic', seedLane[n], 'athletic')
for (const n of ['Chubbies', 'True Classic', 'Vineyard Vines', 'Kulani Kinis', 'Revolve', 'Guess', 'Skims', 'goodr', 'Pickle']) {
  is(n + ' is clothing', seedLane[n], 'clothing')
}
// Categories no lane splits stay in their own row.
for (const n of ['Govee', 'Fujifilm Instax', 'Loop Earplugs']) is(n + ' stays nightlife', seedLane[n], null)
for (const n of ['AG1', 'Vital Proteins', 'Thorne', 'Lemme', 'Royal Honey']) is(n + ' stays wellness', seedLane[n], null)
for (const n of ['FanDuel', 'Takis', 'Anker', 'Robinhood', 'Hinge', 'UFC', 'Cloud']) is(n + ' stays put', seedLane[n], null)

// --- brands from the summaries list (the wider roster) ---------------
is('Bud Light',          lane('Bud Light', 'alcohol'), 'rtd')
is('Modelo (lager)',     lane('Modelo', 'alcohol'), 'rtd')
is('Casamigos',          lane('Casamigos', 'alcohol'), 'spirits')
is('Malibu lists canned cocktails but is rum', lane('Malibu', 'alcohol'), 'spirits')
is('Bacardi likewise',   lane('Bacardi', 'alcohol'), 'spirits')
is('Smirnoff (seltzers in products) is spirits', lane('Smirnoff', 'alcohol'), 'spirits')
is('Carbliss by words',  lane('Carbliss', 'alcohol'), 'rtd')
is('Monster Energy',     lane('Monster Energy', 'beverage'), 'energy')
is('5-hour Energy',      lane('5-hour Energy', 'beverage'), 'energy')
is('Gatorade',           lane('Gatorade', 'beverage'), 'electrolytes')
is('BodyArmor',          lane('BodyArmor', 'beverage'), 'electrolytes')
is('Electrolit',         lane('Electrolit', 'beverage'), 'electrolytes')
is('Waterloo',           lane('Waterloo', 'beverage'), 'drinks')
is('Olipop',             lane('Olipop', 'beverage'), 'drinks')
is('Nike',               lane('Nike', 'apparel'), 'athletic')
is('Rhoback by words',   lane('Rhoback', 'apparel'), 'athletic')
is('Crocs',              lane('Crocs', 'apparel'), 'clothing')
is('Princess Polly',     lane('Princess Polly', 'apparel'), 'clothing')
is('Supplement stays wellness', lane('Ryse', 'wellness'), null)

// --- names and aliases ------------------------------------------------
is('key: Liquid IV = Liquid I.V.', brandKey('Liquid IV'), brandKey('Liquid I.V.'))
is('key: Nütrl = Nutrl', brandKey('Nütrl'), brandKey('NUTRL'))
is('key: corporate tail', brandKey('BeatBox Beverages'), brandKey('BeatBox'))
is('aka carries the name', lane('Stateside Surfside Co', 'alcohol', { aka: 'Surfside' }), 'rtd')
// A name only counts inside its categories: On! the pouch and On the
// running brand must never swap rows.
is('On Running filed apparel', lane('On Running', 'apparel'), 'athletic')
is('Zyn filed as apparel stays with its filing', lane('Zyn', 'apparel'), 'clothing')
is('Needs Clarification can land by name', lane('Zyn', 'unresolved'), 'nicotine')
is('unfiled can land by name', lane('Liquid I.V.', null), 'electrolytes')
is('unfiled never lands by words', lane('Mystery Hydration Co', null), null)
is('unknown alcohol stays unsorted', lane('Some Distillery Holdings', 'alcohol'), null)

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
const s = buildStock(roster)
const rows = [...s.lanes, ...s.others]
is('every brand lands once', rows.reduce((n, r) => n + r.counts.total, 0), roster.length)
is('row brand lists match counts', rows.every(r => r.brands.length === r.counts.total), true)
is('totals.brands', s.totals.total, roster.length)
is('state counts add up', ['business', 'replied', 'reached', 'ready', 'needs', 'off'].reduce((n, k) => n + s.totals[k], 0), roster.length)
is('17 seed categories in use', s.totals.categories, 17)
is('priority lanes lead, in order', s.lanes.map(r => r.key), LANES.filter(l => l.priority).map(l => l.key))
is('non-priority drinks lane sits in others', s.others.some(r => r.key === 'drinks'), true)
is('unresolved row last', s.others[s.others.length - 1].category, 'unresolved')
is('leftover alcohol named', s.others.find(r => r.key === 'cat:alcohol')?.name ?? null, 'Alcohol — not sorted yet')

const ideas = key => s.lanes.find(r => r.key === key).ideas
is('ideas skip the roster', ideas('spirits').includes('Casamigos'), false)
is('ideas skip an aka', ideas('rtd').includes('Yuengling'), false)
is('ideas offer what is missing', ideas('electrolytes').includes('Pedialyte'), true)
is('ideas use the display name', ideas('electrolytes').includes('Liquid I.V.') || ideas('electrolytes').includes('Liquid IV'), false)
is('no ideas outside priority lanes', s.others.every(r => r.ideas.length === 0), true)
const casa = s.lanes.find(r => r.key === 'spirits').brands.find(b => b.name === 'Casamigos')
is('replied brand keeps its state', casa.state, 'replied')
is('pipeline order in a row', s.lanes.find(r => r.key === 'spirits').brands[0].name, 'Casamigos')

// No known name may sit in two lanes — the first would silently win.
const seen = new Map()
for (const l of LANES) for (const k of new Set(l.known.flatMap(x => x.split('|')).map(brandKey))) {
  if (seen.has(k)) { fail++; console.log('✗ known in two lanes:', k, seen.get(k), l.key) }
  else { seen.set(k, l.key); pass++ }
}

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
