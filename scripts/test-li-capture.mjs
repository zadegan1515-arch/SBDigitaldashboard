// scripts/test-li-capture.mjs — guards the LinkedIn capture rules.
//
// Who counts as a buyer, how a headline becomes a title, and how a
// LinkedIn card is recognised as someone already on file. Compiles
// src/lib/li-capture.ts (pure, dependency-free) on its own and asserts
// the rules. Run: node scripts/test-li-capture.mjs

import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const out = mkdtempSync(join(tmpdir(), 'li-test-'))
execSync(
  'npx tsc src/lib/li-capture.ts --outDir ' + out +
  ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck',
  { stdio: 'inherit' },
)
const lib = await import(pathToFileURL(join(out, 'li-capture.js')).href)
const { companySlug, profileSlug, profileUrl, cleanName, personKey, roleFromHeadline, isBuyer,
  normalizeCompany, decideCompanyMatch, focusTerms, matchesFocus,
  parseFollowers, industryOf, categoryFromIndustry, judgeDiscovery } = lib

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
  assert.equal(categoryFromIndustry('Wine & Spirits'), 'alcohol')
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

console.log(n + ' checks passed')
