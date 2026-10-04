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
const { parentOf, decideParentPage, PARENTS, siblingNamed, whyLeaveOut } = await import(pathToFileURL(join(out, 'parents.js')).href)
const { companySlug, profileSlug, profileUrl, cleanName, personKey, roleFromHeadline, isBuyer,
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
t('a brand the old scripts skipped as too big is due at once (big brands are searched now); others rest a month', () => {
  const now = Date.parse('2026-10-01T00:00:00Z')
  const ago = d => new Date(now - d * 864e5).toISOString()
  const v = sweep.LI_READER
  assert.equal(sweep.liResting({ at: ago(1), seen: 0, added: 0, note: 'too big — 12,345 people on LinkedIn (skips 100+)', v }, now), false)
  assert.equal(sweep.liResting({ at: ago(40), seen: 0, added: 0, note: 'too big — 12,345 people on LinkedIn (skips 100+)', v }, now), false)
  assert.equal(sweep.liResting({ at: ago(40), seen: 3, added: 1, note: '', v }, now), false)
  assert.equal(sweep.liResting({ at: ago(10), seen: 3, added: 1, note: '', v }, now), true)
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
