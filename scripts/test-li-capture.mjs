// scripts/test-li-capture.mjs — guards the LinkedIn capture rules.
//
// Who counts as a buyer, how a headline becomes a title, and how a
// LinkedIn card is recognised as someone already on file. Compiles
// src/lib/li-capture.ts (pure, dependency-free) on its own and asserts
// the rules. Run: node scripts/test-li-capture.mjs

import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const out = mkdtempSync(join(tmpdir(), 'li-test-'))
execSync(
  'npx tsc src/lib/li-capture.ts src/lib/parents.ts --outDir ' + out +
  ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck',
  { stdio: 'inherit' },
)
// Node wants the extension the bundler doesn't.
writeFileSync(join(out, 'parents.js'), readFileSync(join(out, 'parents.js'), 'utf8').replace("from './li-capture'", "from './li-capture.js'"))
const lib = await import(pathToFileURL(join(out, 'li-capture.js')).href)
const { parentOf, decideParentPage, PARENTS, siblingNamed, whyLeaveOut, parentCompanyOf, findParent, parentBrandNames, isParentCompany } = await import(pathToFileURL(join(out, 'parents.js')).href)
const { companySlug, profileSlug, profileUrl, storedProfileUrl, cleanName, personKey, roleFromHeadline, isBuyer,
  normalizeCompany, decideCompanyMatch, focusTerms, matchesFocus,
  parseFollowers, industryOf, categoryFromIndustry, judgeDiscovery, decideResearchMatch, nearName, pageLooksWrong,
  looksLikeSeller, cleanBrandName } = lib

let n = 0
function t(name, fn) { fn(); n++; console.log('  ok — ' + name) }

// --- links ------------------------------------------------------
t('company slug from any company URL', () => {
  assert.equal(companySlug('https://www.linkedin.com/company/liquid-death/people/?keywords=marketing'), 'liquid-death')
  assert.equal(companySlug('https://linkedin.com/company/Olipop'), 'olipop')
  assert.equal(companySlug('/company/818-tequila/people/'), '818-tequila')
  assert.equal(companySlug('https://www.linkedin.com/showcase/celsius-energy/'), 'celsius-energy')
  assert.equal(companySlug('https://www.linkedin.com/in/jane-doe/'), null)
  assert.equal(companySlug(null), null)
})

t('profile slug ignores tracking params and case', () => {
  assert.equal(profileSlug('https://www.linkedin.com/in/Jane-Doe-12ab?miniProfileUrn=urn%3Ali%3Afs'), 'jane-doe-12ab')
  assert.equal(profileSlug('/in/jane-doe-12ab/'), 'jane-doe-12ab')
  assert.equal(profileSlug('https://www.linkedin.com/in/jos%C3%A9-p/'), 'josé-p')
  assert.equal(profileSlug('https://www.linkedin.com/company/x/'), null)
  assert.equal(profileUrl('jane-doe-12ab'), 'https://www.linkedin.com/in/jane-doe-12ab/')
})

t('a Sales Navigator member id keeps its case on file; a vanity link is lower case', () => {
  const id = 'ACwAAA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvWx'
  assert.equal(storedProfileUrl('https://www.linkedin.com/in/' + id + '/'), 'https://www.linkedin.com/in/' + id + '/')
  assert.equal(profileSlug('https://www.linkedin.com/in/' + id + '/'), id.toLowerCase(), 'still compared case-blind')
  assert.equal(storedProfileUrl('https://www.linkedin.com/in/Jane-Doe-12ab?x=1'), 'https://www.linkedin.com/in/jane-doe-12ab/')
  assert.equal(storedProfileUrl('https://www.linkedin.com/company/x/'), null)
})

// --- names ------------------------------------------------------
t('LinkedIn\'s badge and pronouns come off a name', () => {
  assert.equal(cleanName('Holly Thaggard • 3rd+'), 'Holly Thaggard')
  assert.equal(cleanName('James Kase · 2nd'), 'James Kase')
  assert.equal(cleanName('Judy Lee (She/Her)'), 'Judy Lee')
})
t('"LinkedIn Member" and junk are not people', () => {
  assert.equal(cleanName('LinkedIn Member'), null)
  assert.equal(cleanName('jane@brand.com'), null)
  assert.equal(cleanName(''), null)
  assert.equal(cleanName('  Jane   Doe 🚀 '), 'Jane Doe')
})

t('same person, two spellings', () => {
  assert.equal(personKey('Jane Doe, MBA'), personKey('Jane Doe'))
  assert.equal(personKey('José Pérez'), personKey('Jose Perez'))
  assert.equal(personKey('Jane (Smith) Doe'), 'jane doe')
})

// --- headline → title ---------------------------------------------
t('role is the first segment without the company', () => {
  assert.equal(roleFromHeadline('Senior Brand Manager at Liquid Death | ex-Red Bull'), 'Senior Brand Manager')
  assert.equal(roleFromHeadline('VP, Marketing @ Olipop'), 'VP, Marketing')
  assert.equal(roleFromHeadline('Head of Partnerships – Liquid Death', 'Liquid Death'), 'Head of Partnerships')
  assert.equal(roleFromHeadline('Field Marketing • Campus • Events'), 'Field Marketing')
  assert.equal(roleFromHeadline(''), null)
})

// --- who buys -----------------------------------------------------
const buyers = [
  ['Senior Brand Manager', 'Senior Brand Manager at Liquid Death | ex-Red Bull'],
  ['Head of Partnerships', ''],
  ['Director of Field Marketing', ''],
  ['Experiential Marketing Lead', ''],
  ['Co-Founder & CEO', ''],
  ['President', ''],
  ['Head of Student Marketing', ''],
  ['Ambassador Program Manager', ''],
  ['Director', 'Director | Brand Partnerships | Liquid Death'],
  ['Sponsorship Coordinator', ''],
]
const notBuyers = [
  ['Brand Ambassador', ''],
  ['Campus Ambassador', ''],
  ['Marketing Intern', ''],
  ['Student', 'Student at UT Austin | Marketing'],
  ['Red Bull Student Marketeer', ''],
  ['Vice President of Sales', ''],
  ['Vice-President, Finance', ''],
  ['Software Engineer', ''],
  ['Brand Designer', ''],
  ['People & Culture Partner', ''],
  ['Talent Acquisition', ''],
  ['Territory Sales Manager', ''],
  ['Director', 'Director at Liquid Death'],
  ['', ''],
]
t('buyers are kept', () => {
  for (const [role, h] of buyers) assert.equal(isBuyer(role, h), true, role)
})
t('everyone else is left on LinkedIn', () => {
  for (const [role, h] of notBuyers) assert.equal(isBuyer(role, h), false, role)
})

// --- finding a brand's company page ---------------------------------
t('company names normalise', () => {
  assert.equal(normalizeCompany('Liquid I.V., Inc.'), normalizeCompany('Liquid IV'))
  assert.equal(normalizeCompany('The Coca-Cola Company'), 'coca cola')
  assert.equal(normalizeCompany('Casamigos Tequila (Diageo)'), 'casamigos tequila')
})
const bev = (name, subtitle) => ({ slug: name.toLowerCase().replace(/\W+/g, '-'), name, subtitle })
t('exact name wins', () => {
  const r = decideCompanyMatch({ name: 'LMNT', category: 'beverage' }, [bev('LMNT', 'Food and Beverage Services • Austin')])
  assert.equal(r.reason, 'exact'); assert.equal(r.pick.name, 'LMNT')
})
t('"also known as" counts as exact', () => {
  const r = decideCompanyMatch({ name: '818 Spirits', aka: '818 Tequila', category: 'alcohol' }, [bev('818 Tequila', 'Beverage Manufacturing')])
  assert.equal(r.reason, 'exact')
})
t('near miss only with a fitting industry: Casamigos → Casamigos Tequila', () => {
  const r = decideCompanyMatch({ name: 'Casamigos', category: 'alcohol' }, [bev('Casamigos Tequila', 'Beverage Manufacturing • Los Angeles')])
  assert.equal(r.reason, 'near'); assert.equal(r.pick.name, 'Casamigos Tequila')
})
t('"Prime" skips Prime Video for PRIME Hydration', () => {
  const r = decideCompanyMatch({ name: 'Prime', category: 'beverage' }, [
    bev('Prime Video', 'Entertainment Providers • Seattle'),
    bev('PRIME Hydration', 'Beverage Manufacturing • Louisville'),
  ])
  assert.equal(r.pick && r.pick.name, 'PRIME Hydration')
})
t('exact name whose own line says what it sells: "in a pouch" (Oct 12 2026)', () => {
  // An energy brand whose page picked an industry that doesn't fit energy.
  const r = decideCompanyMatch({ name: 'Ultra Pouches', category: 'energy' }, [
    bev('Ultra Pouches', 'Personal Care Services • Brooklyn, New York • Instant focus in a pouch. Zero nicotine.'),
    bev('Ultra Labels & Flexpack', 'Printing Services • Eagle Farm, Queensland • flexible packaging'),
  ])
  assert.equal(r.reason, 'exact'); assert.equal(r.pick.name, 'Ultra Pouches')
  // The industry line alone never counts as the description.
  assert.equal(decideCompanyMatch({ name: 'Native', category: 'beauty' }, [bev('Native', 'Home Health Care Services • Ohio')]).reason, 'unclear')
  // A packaging firm that makes pouches is not a pouch brand.
  assert.equal(decideCompanyMatch({ name: 'Ultra', category: 'energy' }, [bev('Ultra', 'Packaging • Delhi • PVC pouches')]).reason, 'unclear')
  // "Zero nicotine" doesn't make a page a nicotine brand.
  assert.equal(decideCompanyMatch({ name: 'Ultra', category: 'nicotine' }, [bev('Ultra', 'Personal Care Services • Zero nicotine')]).reason, 'unclear')
})
t('a different company is left for Leo', () => {
  assert.equal(decideCompanyMatch({ name: 'Celsius', category: 'beverage' }, [bev('Celsius Network', 'Financial Services')]).reason, 'unclear')
  assert.equal(decideCompanyMatch({ name: 'Celsius', category: null }, [bev('Celsius Holdings Beverages', 'Beverage Manufacturing')]).reason, 'unclear')
  assert.equal(decideCompanyMatch({ name: 'Nova', category: 'beverage' }, [bev('Nova', 'Software'), bev('Nova', 'Banking')]).reason, 'unclear')
  assert.equal(decideCompanyMatch({ name: 'Nova', category: 'beverage' }, []).reason, 'none')
})

// --- "start with electrolyte companies" -----------------------------
t('electrolyte covers the hydration shelf', () => {
  const terms = focusTerms('electrolyte')
  assert.ok(matchesFocus({ name: 'LMNT' }, terms))
  assert.ok(matchesFocus({ name: 'Liquid I.V.' }, terms))
  assert.ok(matchesFocus({ name: 'Some Brand', about: 'Hydration drink mix for athletes' }, terms))
  assert.ok(!matchesFocus({ name: 'Red Bull', about: 'Energy drink' }, terms))
  assert.ok(!matchesFocus({ name: 'LMNT' }, []))
  assert.deepEqual(focusTerms('nicotine, betting'), ['nicotine', 'betting'])
})

// --- finding new brands ------------------------------------------------
t('follower counts read the way LinkedIn writes them', () => {
  assert.equal(parseFollowers('Beverage Manufacturing • 250,512 followers'), 250512)
  assert.equal(parseFollowers('40K followers'), 40000)
  assert.equal(parseFollowers('1.2M followers'), 1200000)
  assert.equal(parseFollowers('Austin, TX'), null)
})
t('industry is the first part of the line', () => {
  assert.equal(industryOf('Food and Beverage Services • Austin, TX • 40K followers'), 'Food and Beverage Services')
  assert.equal(industryOf('12K followers'), '')
})
t('consumer industries map to our categories; the rest don\'t', () => {
  assert.equal(categoryFromIndustry('Wine & Spirits'), 'spirits')
  assert.equal(categoryFromIndustry('Breweries'), 'rtd')
  assert.equal(categoryFromIndustry('Wineries'), 'alcohol')
  assert.equal(categoryFromIndustry('Sporting Goods Manufacturing'), 'athletic')
  assert.equal(categoryFromIndustry('Beverage Manufacturing'), 'beverage')
  assert.equal(categoryFromIndustry('Food and Beverage Services'), 'beverage')
  assert.equal(categoryFromIndustry('Food Production'), 'cpg')
  assert.equal(categoryFromIndustry('Retail Apparel and Fashion'), 'apparel')
  assert.equal(categoryFromIndustry('Personal Care Product Manufacturing'), 'beauty')
  assert.equal(categoryFromIndustry('Wellness and Fitness Services'), 'wellness')
  assert.equal(categoryFromIndustry('Wholesale Food and Beverage'), null)
  assert.equal(categoryFromIndustry('Advertising Services'), null)
  assert.equal(categoryFromIndustry('Software Development'), null)
})
t('a lookalike needs 5K followers and a consumer industry', () => {
  const ok = judgeDiscovery({ name: 'Jose Cuervo', subtitle: 'Beverage Manufacturing • 250,512 followers' }, 'alcohol')
  assert.equal(ok.ok, true); assert.equal(ok.category, 'alcohol', 'takes the source brand\'s category when it fits')
  assert.equal(judgeDiscovery({ name: 'Liquid I.V.', subtitle: 'Food and Beverage Manufacturing • 90K followers' }).category, 'beverage')
  assert.deepEqual(judgeDiscovery({ name: 'Tiny Co', subtitle: 'Beverage Manufacturing • 812 followers' }), { ok: false, reason: 'small' })
  assert.deepEqual(judgeDiscovery({ name: 'No Count', subtitle: 'Beverage Manufacturing' }), { ok: false, reason: 'small' })
  assert.deepEqual(judgeDiscovery({ name: 'Southern Glazer\'s', subtitle: 'Wholesale Alcohol • 300K followers' }, 'alcohol'), { ok: false, reason: 'industry' })
  assert.deepEqual(judgeDiscovery({ name: 'Some Agency', subtitle: 'Advertising Services • 20K followers' }), { ok: false, reason: 'industry' })
  assert.equal(judgeDiscovery({ name: 'Venmo', subtitle: 'Financial Services • 200K followers' }, 'fintech').ok, true, 'a fintech lookalike of a fintech brand')
  assert.equal(judgeDiscovery({ name: 'Venmo', subtitle: 'Financial Services • 200K followers' }).ok, false, 'but not from a keyword search')
})
t('a lookalike in health care, tech hardware, groceries or textiles never passes (the Oct 14 run\'s chain)', () => {
  for (const [name, sub, from] of [
    ['Charlie Health', 'Mental Health Care • 60K followers', 'wellness'],
    ['Spring Health', 'Hospitals and Health Care • 90K followers', 'electrolytes'],
    ['OnePlus', 'Computers and Electronics Manufacturing • 2M followers', 'tech'],
    ['SNOCKS', 'Textile Manufacturing • 40K followers', 'athletic'],
    ['Al Rawabi', 'Retail Groceries • 30K followers', 'beverage'],
    ['Headspace', 'Software Development • 300K followers', 'wellness'],
  ]) assert.deepEqual(judgeDiscovery({ name, subtitle: sub }, from), { ok: false, reason: 'industry' }, name)
  assert.equal(judgeDiscovery({ name: 'Jose Cuervo', subtitle: 'Beverage Manufacturing • 250,512 followers' }, 'alcohol').ok, true, 'drinks still pass')
  assert.equal(judgeDiscovery({ name: 'Liquid Death', subtitle: 'Food and Beverage Services • 300K followers' }, 'beverage').ok, true, 'food and beverage services still pass')
})

t('a lookalike whose LinkedIn name adds what it sells is already on the roster', () => {
  const k = (s) => normalizeCompany(s)
  assert.equal(nearName(k('Waterloo'), k('Waterloo Sparkling Water')), true, 'the end-to-end run added Waterloo twice')
  assert.equal(nearName(k('Casamigos Tequila'), k('Casamigos')), true)
  assert.equal(nearName(k('Poppi'), k('Poppi')), true)
  assert.equal(nearName(k('Red'), k('Red Bull')), false, 'too short to claim a longer name')
  assert.equal(nearName(k('Body'), k('BodyArmor')), false, 'whole words only')
  assert.equal(nearName(k('Olipop'), k('Hoplark')), false)
})

t('an exact name needs a fitting industry too (Native the deodorant, not the care agency)', () => {
  const c = (slug, name, subtitle) => ({ slug, name, subtitle })
  const agency = c('native-co.', 'Native', 'Individual and Family Services • Phoenix, AZ • 1K followers')
  const deo = c('native-cos', 'Native', 'Personal Care Product Manufacturing • San Francisco • 60K followers')
  assert.deepEqual(decideCompanyMatch({ name: 'Native', category: 'beauty' }, [agency]), { pick: null, reason: 'unclear' })
  assert.equal(decideCompanyMatch({ name: 'Native', category: 'beauty' }, [agency, deo]).pick.slug, 'native-cos', 'not the first result')
  const small = c('native-mini', 'Native', 'Personal Care Product Manufacturing • 900 followers')
  assert.equal(decideCompanyMatch({ name: 'Native', category: 'beauty' }, [small, deo]).pick.slug, 'native-cos', 'most followed wins')
  assert.equal(decideCompanyMatch({ name: 'Native', category: 'unresolved' }, [agency]).pick.slug, 'native-co.', 'uncheckable category: the old rule')
  assert.equal(pageLooksWrong('beauty', 'Individual and Family Services'), true)
  assert.equal(pageLooksWrong('beauty', 'Personal Care Product Manufacturing'), false)
  assert.equal(pageLooksWrong('beauty', ''), false, 'no industry shown: no verdict')
  assert.equal(pageLooksWrong('unresolved', 'Individual and Family Services'), false)
  // Oct 13 2026 run: a same-named company in another trade, and LinkedIn's bare "Manufacturing".
  const snc = bev('Sierra Nevada Corporation', 'Defense and Space Manufacturing • Sparks, NV • 200K followers')
  const snb = bev('Sierra Nevada Brewing Co.', 'Food and Beverage Manufacturing • Chico, CA • 60K followers')
  assert.equal(decideCompanyMatch({ name: 'Sierra Nevada', category: 'rtd' }, [snc, snb]).pick?.name, 'Sierra Nevada Brewing Co.')
  assert.equal(decideCompanyMatch({ name: 'NJOY', category: 'nicotine' }, [bev('NJOY', 'Manufacturing • Scottsdale, AZ • 20K followers')]).pick?.name, 'NJOY')
  assert.equal(decideCompanyMatch({ name: 'G FUEL', category: 'energy' }, [bev('G FUEL', 'Manufacturing • 30K followers'), bev('G Fuel Logistics', 'Truck Transportation')]).pick?.name, 'G FUEL')
  assert.equal(decideCompanyMatch({ name: 'Zone', category: 'energy' }, [bev('Zone', 'Manufacturing'), bev('Zone', 'Manufacturing • 2K followers')]).reason, 'unclear', 'two bare Manufacturing pages: Leo picks')
  assert.equal(decideCompanyMatch({ name: 'Zone', category: 'software' }, [bev('Zone', 'Manufacturing')]).reason, 'unclear', 'not a product category')
  assert.equal(pageLooksWrong('nicotine', 'Manufacturing'), false)
  assert.equal(pageLooksWrong('electrolytes', 'Manufacturing'), false)
  assert.equal(pageLooksWrong('energy', 'Defense and Space Manufacturing'), true)
})

t('parent companies: the brands whose people are under them, by any spelling', () => {
  assert.equal(parentOf('Ketel One').name, 'Diageo')
  assert.equal(parentOf('Ciroc').name, 'Diageo', 'Cîroc without the accent')
  assert.equal(parentOf('Some Brand', 'Captain Morgan').name, 'Diageo', 'by also-known-as')
  assert.equal(parentOf("Jameson").name, 'Pernod Ricard')
  assert.equal(parentOf('Fireball').name, 'Sazerac')
  assert.equal(parentOf('Bang').name, 'Monster Beverage')
  assert.equal(parentOf('Liquid Death'), null)
  const all = PARENTS.flatMap(p => p.brands.flatMap(b => b.split('|')))
  assert.equal(new Set(all.map(x => x.toLowerCase())).size, all.length, 'no brand under two parents')
})

t('a parent company combined into one brand has no parent itself; Bacardi is still a brand first', () => {
  const aka = 'Ketel One, Crown Royal, Smirnoff, Captain Morgan'
  assert.equal(parentCompanyOf('Diageo').name, 'Diageo')
  assert.equal(parentCompanyOf('Molson Coors').name, 'Molson Coors')
  assert.equal(parentCompanyOf('Bacardi'), null, 'Bacardi the rum is one of its own brands')
  assert.equal(parentCompanyOf('Ketel One'), null)
  assert.equal(parentOf('Diageo', aka), null)
  assert.equal(parentOf('Bacardi').name, 'Bacardi')
  // Everyone at Diageo is Diageo's: no sister brand to hold against them
  assert.equal(siblingNamed('Brand Manager, Lagavulin', 'Diageo', aka), null)
  assert.equal(whyLeaveOut('Brand Director, Guinness US', 'Diageo', aka), null)
  assert.equal(findParent('Bacardi').name, 'Bacardi')
  assert.equal(findParent('diageo').name, 'Diageo')
  assert.equal(findParent('Nobody Inc'), null)
  const names = parentBrandNames(findParent('Diageo'))
  for (const n of ['Ketel One', 'Cîroc', 'Ciroc', 'DeLeon', 'Lagavulin']) assert.ok(names.includes(n), n)
})

// parent-lookup (Oct 2026): the lookups read a map built once instead of
// PARENTS.find over every name on each call. The old find-based versions,
// kept here verbatim, must answer exactly the same for every spelling.
t('the parent lookups answer exactly what the old PARENTS.find versions did', () => {
  const looseKey = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ').replace(/\b(inc|llc|ltd|co|corp|company|the|brands?|group|holdings?|beverages?)\b/g, ' ').replace(/[^a-z0-9]+/g, '')
  const BY = new Map()
  for (const p of PARENTS) for (const b of p.brands) for (const n of b.split('|')) { const k = looseKey(n); if (k && !BY.has(k)) BY.set(k, p) }
  const namesOf = (p) => [p.name, p.search, ...(p.aka ?? [])]
  const oldCompany = (name) => { const k = looseKey(name); if (!k || BY.has(k)) return null; return PARENTS.find(p => namesOf(p).some(n => looseKey(n) === k)) ?? null }
  const oldFind = (name) => { const k = looseKey(name); if (!k) return null; return PARENTS.find(p => namesOf(p).some(n => looseKey(n) === k)) ?? null }
  const oldParentOf = (name, aka) => { if (oldCompany(name)) return null; for (const n of [name, ...String(aka || '').split(/[,;]/)]) { const p = BY.get(looseKey(n)); if (p) return p } return null }
  const KEYS = new Set(PARENTS.flatMap(p => namesOf(p).map(looseKey)).filter(Boolean))
  const oldIsParent = (name, aka) => [name, ...String(aka || '').split(/[,;]/)].some(n => { const k = looseKey(n); return !!k && KEYS.has(k) })
  const names = [...new Set(PARENTS.flatMap(p => [...namesOf(p), ...p.brands, ...(p.others ?? [])].flatMap(x => x.split('|'))))]
  const tries = [...names, ...names.map(n => n.toUpperCase()), ...names.map(n => 'The ' + n + ' Company'), ...names.map(n => n + ' Inc.'),
    'Liquid Death', 'Nobody Inc', '', null, undefined, '  ', 'Monster', 'Monster Energy', 'monster beverage corp', 'Beam Suntory', 'Gallo', 'Bacardi', 'Heineken', 'Coca-Cola', 'Sazerac Company']
  const akas = [null, '', 'Captain Morgan', 'Diageo', 'Nobody, Ketel One', 'Some; Thing', 'Monster Energy, Bang']
  let checked = 0
  for (const n of tries) {
    assert.equal(parentCompanyOf(n), oldCompany(n), 'parentCompanyOf ' + n)
    assert.equal(findParent(n), oldFind(n), 'findParent ' + n)
    for (const a of akas) {
      assert.equal(parentOf(n, a), oldParentOf(n, a), 'parentOf ' + n + ' / ' + a)
      assert.equal(isParentCompany(n, a), oldIsParent(n, a), 'isParentCompany ' + n + ' / ' + a)
      checked++
    }
  }
  assert.ok(checked > 1000, 'checked ' + checked)
  // Monster Energy is both a brand key and the parent's aka: a brand first.
  assert.equal(parentCompanyOf('Monster Energy'), null)
  assert.equal(parentOf('Monster Energy').name, 'Monster Beverage')
  assert.equal(findParent('Monster Energy').name, 'Monster Beverage')
})

t("a parent's own page: its exact name, the most followed", () => {
  const diageo = PARENTS.find(p => p.name === 'Diageo')
  const c = (slug, name, subtitle) => ({ slug, name, subtitle })
  assert.equal(decideParentPage(diageo, [c('diageo-fans', 'Diageo', 'Beverage • 300 followers'), c('diageo', 'Diageo', 'Beverage Manufacturing • 2M followers')]).slug, 'diageo')
  assert.equal(decideParentPage(diageo, [c('diageo-bar', 'Diageo Bar Academy', 'Education')]), null)
  const beam = PARENTS.find(p => p.name === 'Suntory Global Spirits')
  assert.equal(decideParentPage(beam, [c('beam-suntory', 'Beam Suntory', 'Beverage Manufacturing • 500K followers')]).slug, 'beam-suntory', 'its old name')
  const monster = PARENTS.find(p => p.name === 'Monster Beverage')
  assert.equal(decideParentPage(monster, [c('monster-energy', 'Monster Energy', 'Food and Beverage Services • 1M followers')]).slug, 'monster-energy', 'its page goes by Monster Energy')
})

// --- the research list -------------------------------------------------
t('a list name needs a page whose industry fits its lane', () => {
  const r = decideResearchMatch({ name: 'Powerade', category: 'beverage' }, [bev('Powerade', 'Food and Beverage Services • Atlanta • 150K followers')])
  assert.equal(r.reason, 'exact')
  assert.equal(decideResearchMatch({ name: 'NOS Energy', aka: 'NOS', category: 'beverage' }, [bev('NOS', 'Telecommunications • Lisbon')]).reason, 'unclear', 'NOS the telecom is not NOS the drink')
  assert.equal(decideResearchMatch({ name: 'Hydrant', category: 'beverage' }, [bev('Hydrant', 'Industrial Machinery Manufacturing')]).reason, 'unclear')
  const nuun = decideResearchMatch({ name: 'Nuun', category: 'beverage' }, [bev('Nuun Hydration', 'Food and Beverage Manufacturing • Seattle')])
  assert.equal(nuun.reason, 'near'); assert.equal(nuun.pick.name, 'Nuun Hydration')
  assert.equal(decideResearchMatch({ name: 'Nuun', category: 'beverage' }, []).reason, 'none')
})

// --- resting (li-sweep.ts) ---------------------------------------
execSync(
  'npx tsc src/lib/li-sweep.ts --outDir ' + out +
  ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck',
  { stdio: 'inherit' },
)
const sweep = await import(pathToFileURL(join(out, 'li-sweep.js')).href)
t('a brand the old scripts skipped as too big is due at once (big brands are searched now)', () => {
  const now = Date.parse('2026-10-01T00:00:00Z')
  const ago = d => new Date(now - d * 864e5).toISOString()
  const v = sweep.LI_READER
  assert.equal(sweep.liRestsNow({ at: ago(1), seen: 0, added: 0, note: 'too big — 12,345 people on LinkedIn (skips 100+)', v }, false, now), false)
  assert.equal(sweep.liRestsNow({ at: ago(40), seen: 0, added: 0, note: 'too big — 12,345 people on LinkedIn (skips 100+)', v }, false, now), false)
})

// --- Oct 14 2026: read again only when something went wrong ----------
t('a clean read never comes back by itself; an older read that found people is done too', () => {
  const now = Date.parse('2026-12-01T00:00:00Z')
  const ago = d => new Date(now - d * 864e5).toISOString()
  const v = sweep.LI_READER
  const clean = { at: ago(400), seen: 30, added: 4, v, clean: true, issue: null }
  assert.deepEqual(sweep.liDue(clean, false, now), { due: false, retry: false, stuck: false, back: null, issue: null, tries: 0 })
  assert.equal(sweep.liRestsNow({ at: ago(90), seen: 12, added: 0, v, sn: true }, false, now), true, 'a Sales Navigator read from 1.31–1.37 is clean')
  assert.equal(sweep.liRestsNow({ at: '2026-09-21T00:00:00Z', seen: 3, added: 1, v }, false, now), true, 'People-tab read before Sales Navigator that found people')
  assert.equal(sweep.liRestsNow({ at: '2026-09-21T00:00:00Z', seen: 3, added: 0, v }, false, now), false, '…one that found nobody keeps the month (long over)')
  assert.equal(sweep.liRestsNow({ at: ago(10), seen: 3, added: 0, v, clean: false, issue: null }, false, now), true, 'no page / page review: the month')
  assert.equal(sweep.liRestsNow({ at: ago(40), seen: 3, added: 0, v, clean: false, issue: null }, false, now), false)
  assert.equal(sweep.liRestsNow({ at: ago(1), seen: 3, added: 1, v: 1, clean: true }, false, now), false, 'an old reader proves nothing')
})
t('an issue goes first on the next run, for 3 runs; then it rests a month and shows as stuck', () => {
  const now = Date.parse('2026-12-01T00:00:00Z')
  const ago = d => new Date(now - d * 864e5).toISOString()
  const v = sweep.LI_READER
  const d1 = sweep.liDue({ at: ago(1), seen: 0, added: 0, v, issue: 'snNoLoad', tries: 1 }, false, now)
  assert.equal(d1.due && d1.retry, true); assert.equal(d1.issue, 'snNoLoad')
  assert.equal(sweep.liDue({ at: ago(1), seen: 0, added: 0, v, issue: 'partial', tries: 2 }, false, now).retry, true)
  const stuck = sweep.liDue({ at: ago(1), seen: 0, added: 0, v, issue: 'partial', tries: 3 }, false, now)
  assert.equal(stuck.due, false); assert.equal(stuck.stuck, true); assert.equal(stuck.back, new Date(Date.parse(ago(1)) + 30 * 864e5).toISOString())
  assert.equal(sweep.liDue({ at: ago(31), seen: 0, added: 0, v, issue: 'partial', tries: 3 }, false, now).retry, true, 'a month on, tried again')
  assert.equal(sweep.liDue({ at: '2026-10-13T00:00:00Z', seen: 5, added: 0, v, snMissed: true }, false, now).retry, true, 'an older copy that read the People tab instead')
  assert.equal(sweep.liDue({ at: '2026-10-13T00:00:00Z', seen: 5, added: 2, v }, false, now).issue, 'noSalesNav', 'any read since Sales Navigator shipped without it')
  assert.equal(sweep.liDue({ at: '2026-10-13T00:00:00Z', seen: 0, added: 0, v, note: 'no clear LinkedIn page — pick it on Outreach → People' }, false, now).issue, null, 'a page problem is Leo\'s list, not a retry')
  assert.equal(sweep.liDue({ at: '2026-10-13T00:00:00Z', seen: 0, added: 0, v, snMissed: true, note: 'its saved LinkedIn page looks like another company — pick the right one' }, false, now).retry, false)
  assert.equal(sweep.liDue({ at: ago(1), seen: 0, added: 0, v, skip: 'veryBig', clean: false }, false, now).due, true, 'skipped at 1,500+: the list decides (saved headcount)')
  assert.equal(sweep.liDue({ at: ago(1), seen: 4, added: 0, v, clean: true, issue: null }, true, now).due, true, 'nobody on its own page and the parent not searched yet')
  assert.equal(sweep.liDue({ at: ago(1), seen: 4, added: 0, v, clean: true, issue: null, parentTried: true }, true, now).due, false)
})
t('review fixes: a parent brand\'s issue still counts; a legacy failed retry isn\'t clean; a run with Sales Navigator off keeps its issue', () => {
  const now = Date.parse('2026-12-01T00:00:00Z')
  const ago = d => new Date(now - d * 864e5).toISOString()
  const v = sweep.LI_READER
  assert.equal(sweep.liDue({ at: ago(1), seen: 0, added: 0, v, issue: 'snNoId', tries: 3 }, true, now).stuck, true, 'parent not tried, own read failed 3 runs: stuck')
  const r1 = sweep.liDue({ at: ago(1), seen: 0, added: 0, v, issue: 'snNoId', tries: 1 }, true, now)
  assert.deepEqual([r1.retry, r1.issue], [true, 'snNoId'])
  const legacy = { at: '2026-10-12T20:00:00Z', v, sn: false, snMissed: true, snRetried: true, seen: 5, added: 0 }
  assert.equal(sweep.markOutcome(legacy).clean, false, 'its one retry still had no Sales Navigator')
  const ld = sweep.liDue(legacy, false, Date.parse('2026-10-14T00:00:00Z'))
  assert.deepEqual([ld.retry, ld.tries], [true, sweep.LI_RETRY_MAX - 1], 'one more try')
  const prev = { at: ago(2), seen: 0, added: 0, v, issue: 'snNoLoad', issueNote: 'did not load', tries: 2, run: 'r1' }
  const off = sweep.nextMark(prev, { seen: 4, added: 1, v, clean: false, issue: null, snOff: true, run: 'r2' }, ago(0))
  assert.deepEqual([off.issue, off.tries, off.issueNote], ['snNoLoad', 2, 'did not load'], 'kept, not counted as a try')
  const noRead = sweep.nextMark(prev, { seen: 0, added: 0, v, clean: false, issue: 'noOpen', snOff: true, run: 'r2' }, ago(0))
  assert.equal(noRead.issue, 'noOpen', 'its own issue wins')
  const on = sweep.nextMark(prev, { seen: 4, added: 1, v, clean: true, issue: null, run: 'r3' }, ago(0))
  assert.deepEqual([on.clean, on.issue, on.tries], [true, null, undefined])
  assert.equal(sweep.sweptOutcome({ done: false, snOn: false }).snOff, true)
  // One more try for a legacy failed retry — in every place that counts.
  const after = sweep.nextMark(legacy, { seen: 0, added: 0, v, issue: 'snNoLoad', run: 'r1' }, ago(0))
  assert.equal(after.tries, sweep.LI_RETRY_MAX, 'its 1.38 try failed too')
  assert.equal(sweep.liDue(after, false, now).stuck, true)
  // A saved page that's another company's waits for Leo's pick, parent or not.
  assert.equal(sweep.liDue({ at: ago(1), seen: 0, added: 0, v, clean: false, issue: null, note: 'its saved LinkedIn page looks like another company (Defense) — pick the right one on Outreach → People' }, true, now).due, false)
})

t('tries count runs, not posts: the same run posting twice is one try; a clean read starts over', () => {
  assert.equal(sweep.nextTries(undefined, { issue: 'snNoLoad', run: 'r1' }), 1)
  const m1 = { at: 'x', seen: 0, added: 0, issue: 'snNoLoad', tries: 1, run: 'r1' }
  assert.equal(sweep.nextTries(m1, { issue: 'snNoLoad', run: 'r1' }), 1, 'the in-run second try')
  assert.equal(sweep.nextTries(m1, { issue: 'partial', run: 'r2' }), 2)
  assert.equal(sweep.nextTries({ ...m1, tries: 2, run: 'r2' }, { issue: 'partial', run: 'r3' }), 3)
  assert.equal(sweep.nextTries(m1, { issue: null, run: 'r2' }), 0)
  assert.equal(sweep.nextTries({ at: 'x', seen: 1, added: 1, clean: true }, { issue: 'save', run: 'r9' }), 1)
})
t('a liSwept becomes an outcome: 1.38 says done / issue; older copies are read as before', () => {
  const o = sweep.sweptOutcome({ salesNav: true, done: true, issue: null, run: 'r1', shown: '28', read: 28 })
  assert.deepEqual(o, { clean: true, issue: null, issueNote: null, run: 'r1', skip: null, shown: 28, read: 28 })
  const p = sweep.sweptOutcome({ salesNav: false, done: false, issue: 'partial', issueNote: 'read 18 of 28', run: 'r1' })
  assert.equal(p.clean, false); assert.equal(p.issue, 'partial'); assert.equal(p.issueNote, 'read 18 of 28')
  assert.equal(sweep.sweptOutcome({ done: true, problem: 'every title came out blank' }).issue, 'reading', 'a misread page is an issue')
  assert.equal(sweep.sweptOutcome({ done: true, issue: 'made-up' }).issue, 'reading', 'an unknown code still counts as an issue')
  assert.equal(sweep.sweptOutcome({ done: true, skipped: 'veryBig' }).clean, false)
  assert.equal(sweep.sweptOutcome({ done: true, viaParent: true }).clean, true, 'a parent page read to its end')
  assert.equal(sweep.sweptOutcome({ salesNav: true }).clean, true, '1.37: a Sales Navigator read')
  assert.equal(sweep.sweptOutcome({ salesNav: false, snMissed: true }).issue, 'noSalesNav', '1.37: the People tab instead')
  assert.equal(sweep.sweptOutcome({ salesNav: false }).clean, false, '1.37 with it off: the old month')
  assert.equal(sweep.issueWords('snNoLoad'), 'Sales Navigator’s results didn’t load')
})

// --- the October rules (the Sep 30 run's wrong people) --------------
t('students, new grads and store staff are left on LinkedIn', () => {
  for (const r of ['Marketing Major', 'Recent graduate from The University of Florida', 'Communications Studies Major',
    'University of Michigan Ross School of Business Alum', 'Pursuing a Bachelor\u2019s degree in Integrated Marketing Communications',
    'B.S. in Integrated Marketing Communications', 'Virginia Tech Pamplin College of Business', 'Chapman University',
    'Goldstein Marketing Scholar', 'Pre-Med & Marketing', 'Marketing Co-Chair', 'First-Year Communications Major',
    'MPH Graduate from Emory University', 'Marketing Communications MSc',
    'Assistant Store Manager - Events', 'Assistant Manager', 'National Retail Event Producer & ATX Assistant Manager',
    'Marketing & Sales, Stylist, Clientele Management, Hiring', 'Leasing Marketing Assistant position']) {
    assert.equal(isBuyer(r, r), false, r)
  }
})
t('investors, board members, HR and the CEO\u2019s office are left too', () => {
  for (const r of ['General Partner, Co-Head of Growth Equity', 'Global Retail Executive & Board Member / Start-Up to Fortune 500',
    'Head of People Partnerships (VP)', 'Project Manager, Office of the CEO', 'University Relations Manager',
    'Senior Director of Wholesale Partnerships & B2B', 'Social Media Content Creator', 'I help brands and organizations achieve stronger engagement']) {
    assert.equal(isBuyer(r, r), false, r)
  }
})
t('another company\u2019s leader on the brand\u2019s page is an outsider; the brand\u2019s own is not', () => {
  assert.equal(isBuyer('Founder & CEO of Lendi', '', ['Princess Polly']), false)
  assert.equal(isBuyer('Co-founder of Rapha', '', ['Tracksmith']), false)
  assert.equal(isBuyer('Global Consumer/Consumer Tech CEO \u2726CEO of Sleep Number \u2726Ex Blue Apron', '', ['Ralph Lauren']), false)
  assert.equal(isBuyer('Co-Founder of Oner Active', '', ['Oner Active']), true)
  assert.equal(isBuyer('President of Global Marketing', '', ['Crocs']), true)
  assert.equal(isBuyer('Founder & CEO', '', ['Shinesty']), true)
  assert.equal(isBuyer('Co-founder of PRIME', '', ['Prime Hydration']), true)
  // founders who also invest or advise are still the founder
  assert.equal(isBuyer('Founder, CEO, Advisor, Investor', '', ['Drink LMNT']), true)
  assert.equal(isBuyer('CEO Ten Thousand, Strategic Advisor & Angel Investor', '', ['Ten Thousand']), true)
  assert.equal(isBuyer('Chief of Staff & Senior Director of Partnerships', '', ['Kith']), true)
  // a firm or a board seat is not
  assert.equal(isBuyer('Co-Founder and General Partner True Beauty Ventures', '', ['Vacation Sunscreen']), false)
  assert.equal(isBuyer('Partner - Highland Europe (Growth equity)', '', ['Huel']), false)
  assert.equal(isBuyer('Active board chair, investor, mentor, public speaker', '', ['Maurten']), false)
  assert.equal(isBuyer('Performance Marketer, Growth Consultant', '', ['Buoy']), false)
  assert.equal(isBuyer('CEO of Liquid Death Mountain Water', '', ['Liquid Death']), true)
  assert.equal(isBuyer('Co-Founder & CEO of OLIPOP', '', ['Olipop']), true)
  assert.equal(isBuyer('CEO of Liquid IV', '', ['Liquid I.V.']), true)
  assert.equal(isBuyer('Founder & CEO of Lendi', ''), true, 'no names given: not judged')
})
t('the real buyers from that run stay buyers', () => {
  for (const r of ['Corporate Partnerships Manager', 'Senior Brand Manager', 'College Ambassador Program Associate',
    'Head of College Marketing', 'Retail Marketing Coordinator', 'Retail Brand Manager', 'Influencer & Collabs specialist',
    'Senior Influencer Talent Manager', 'Assistant Manager, Shopper Marketing', 'Shopper & In-Store Marketing Manager',
    'Brand Partnerships and Sports Sponsorships', 'Chief Marketing Officer', 'Director, Business Partnerships']) {
    assert.equal(isBuyer(r, r, ['Brand']), true, r)
  }
})
t('at a parent, someone on a sister brand is named; the brand\u2019s own, the parent\u2019s and history are not', () => {
  assert.equal(siblingNamed('Senior Brand Manager, Crown Royal', 'Ketel One'), 'Crown Royal')
  assert.equal(siblingNamed('Brand Manager, Guinness', 'DeLeón Tequila'), 'Guinness')
  assert.equal(siblingNamed('Brand Manager, D\u2019USSÉ Cognac', 'Grey Goose'), "D'USSÉ")
  assert.equal(siblingNamed('Global Brand Director of Smirnoff Vodka', 'Bulleit'), 'Smirnoff')
  assert.equal(siblingNamed('Brand Manager, Ketel One & Crown Royal', 'Ketel One'), null)
  assert.equal(siblingNamed('AMEA Executive Marketing Leader, Bacardi', 'Grey Goose'), null)
  assert.equal(siblingNamed('Category Marketing Lead - Campari', 'Espolòn'), null)
  assert.equal(siblingNamed('VP Marketing, PepsiCo', 'Propel'), null)
  assert.equal(siblingNamed('Brand Manager, Busch', 'Busch Light'), null)
  assert.equal(siblingNamed('Solutions Lead', 'Heineken'), null)
  assert.equal(siblingNamed('Brand Manager, Crown Royal', 'Liquid Death'), null, 'no parent: nothing to judge')
})
t('the clean-up says why a saved title is out', () => {
  assert.deepEqual(whyLeaveOut('Marketing Major', 'Hollister'), { why: 'student' })
  assert.deepEqual(whyLeaveOut('Assistant Store Manager - Events', 'Kendra Scott'), { why: 'store' })
  assert.deepEqual(whyLeaveOut('Founder & CEO of Lendi', 'Princess Polly'), { why: 'outside' })
  assert.deepEqual(whyLeaveOut('Head of People Partnerships (VP)', 'Ralph Lauren'), { why: 'notMarketing' })
  assert.deepEqual(whyLeaveOut('Brand Director, Guinness US', 'Aviation Gin'), { why: 'sibling', other: 'Guinness' })
  assert.equal(whyLeaveOut('President and Chief Executive Officer, Suntory Global Spirits', "Maker's Mark"), null)
  assert.equal(whyLeaveOut('Associate Manager', 'Aerie'), null, 'a bare generic title is not judged on its own')
  assert.equal(whyLeaveOut('Senior Brand Manager', 'Crocs'), null)
})
t('leagues, teams and sports agencies aren\u2019t added as lookalikes', () => {
  assert.equal(judgeDiscovery({ name: 'National Football League (NFL)', subtitle: 'Spectator Sports • 3M followers' }).ok, false)
  assert.equal(judgeDiscovery({ name: 'Athletes Unlimited', subtitle: 'Spectator Sports • 40K followers' }).ok, false)
  assert.equal(judgeDiscovery({ name: 'Excel Sports Management', subtitle: 'Entertainment Providers • 60K followers' }).ok, false)
  assert.equal(judgeDiscovery({ name: 'Crocs', subtitle: 'Retail Apparel and Fashion • 300K followers' }).ok, true)
  assert.equal(looksLikeSeller('Major League Baseball (MLB)'), true)
  assert.equal(looksLikeSeller('Some Club', 'Found by LinkedIn, similar to MLB — Spectator Sports, 40,000 followers.'), true)
  assert.equal(looksLikeSeller('Liquid Death', 'Found by LinkedIn — Beverage Manufacturing, 1,000,000 followers.'), false)
})
t('page names lose their company suffix and web address', () => {
  assert.equal(cleanBrandName('Abercrombie & Fitch Co.'), 'Abercrombie & Fitch')
  assert.equal(cleanBrandName('PrettyLittleThing.com'), 'PrettyLittleThing')
  assert.equal(cleanBrandName('Aerie by AEO, Inc.'), 'Aerie by AEO')
  assert.equal(cleanBrandName('The Coca-Cola Company'), 'The Coca-Cola Company')
  assert.equal(normalizeCompany('PrettyLittleThing.com'), normalizeCompany('PrettyLittleThing'))
})

console.log(n + ' checks passed')
