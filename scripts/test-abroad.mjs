// scripts/test-abroad.mjs — guards src/lib/abroad.ts (Leo, Oct 18 2026:
// skip people outside the US "unless the company is based outside the us").
// The cases are titles and locations from the roster.
// Run: node scripts/test-abroad.mjs

import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = mkdtempSync(join(tmpdir(), 'abroad-test-'))
execSync('npx tsc src/lib/abroad.ts --outDir ' + out + ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck', { stdio: 'inherit' })
const A = await import(pathToFileURL(join(out, 'abroad.js')).href)

let pass = 0, fail = 0
const is = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return }
  fail++; console.log('✗', label, '— got', JSON.stringify(got), 'want', JSON.stringify(want))
}

// Titles.
const titles = {
  'UK Partnerships Manager': 'abroad',
  'Sr Events & Activations Manager UK': 'abroad',
  'Partnerships Marketing Manager France': 'abroad',
  'Director Partnerships DACH': 'abroad',
  'Senior Director, Brand and Creative (Europe)': 'abroad',
  'General Manager APAC': 'abroad',
  'Director Commercial & Growth - Asia-Pacific (APAC)': 'abroad',
  'Account Manager - Canada': 'abroad',
  'Sr. Director, Sales & Marketing - Canada & Latin America': 'abroad',
  'Head of Partnerships, North America': 'us',
  'Director of Marketing - US': 'us',
  'Head of Partnerships': null,
  'Field Marketing Manager, East': null,
  'Senior Partnerships Manager': null,
  'Brand Manager, Indiana': null,
  'Asian American Marketing Lead': null,
  'Founder & CEO': null,
}
for (const [t, w] of Object.entries(titles)) is('title: ' + t, A.titleWhere(t), w)
is('the brand’s own name never counts', A.titleWhere('Brand Manager, Canada Dry', ['Canada Dry']), null)
is('…but another country still does', A.titleWhere('Brand Manager, Canada Dry Mexico', ['Canada Dry']), 'abroad')

// Locations.
const locs = {
  'Austin, Texas, United States': 'us',
  'Hoboken, New Jersey, United States': 'us',
  'Tampa Bay': 'us',
  'Greater Philadelphia': 'us',
  'New York City Metropolitan Area': 'us',
  'Los Angeles Metropolitan Area': 'us',
  'San Diego, CA': 'us',
  'Park City, UT': 'us',
  'Chicago, IL': 'us',
  'United States': 'us',
  'Atlanta, Georgia': 'us',
  'Albuquerque, New Mexico': 'us',
  'Lima, Ohio': 'us',
  'Tokyo, Japan': 'abroad',
  'Hong Kong, Hong Kong SAR': 'abroad',
  'Long Crendon, England, United Kingdom': 'abroad',
  'Berlin, Berlin, Germany': 'abroad',
  'Greater Kassel Area': 'abroad',
  'Canada': 'abroad',
  'Toronto, Ontario, Canada': 'abroad',
  'London, Ontario, Canada': 'abroad',
  'Remote': null,
  '': null,
}
for (const [l, w] of Object.entries(locs)) is('location: ' + l, A.locationWhere(l), w)

// A person: the title's region first, else where they are.
is('person: a UK title, no location', A.personWhere({ title: 'UK Partnerships Manager', location: null }), 'abroad')
is('person: a plain title in London', A.personWhere({ title: 'Partnerships Manager', location: 'London, England, United Kingdom' }), 'abroad')
is('person: North America title in Toronto', A.personWhere({ title: 'Head of Partnerships, North America', location: 'Toronto, Ontario, Canada' }), 'us')
is('person: nothing to go on', A.personWhere({ title: 'Head of Partnerships', location: null }), null)

// A company.
const us = (n) => Array.from({ length: n }, () => ({ location: 'Los Angeles, California, United States' }))
const de = (n) => Array.from({ length: n }, () => ({ location: 'Berlin, Berlin, Germany' }))
is('mostly US people: based in the US', A.basedAbroad({}, [...us(10), ...de(2)]), false)
is('mostly abroad: based abroad', A.basedAbroad({}, [...de(2), { location: 'Greater Kassel Area' }, { location: null }]), true)
is('Casetify-like (Tokyo, Hong Kong): abroad', A.basedAbroad({}, [{ location: 'Tokyo, Japan' }, { location: 'Hong Kong, Hong Kong SAR' }]), true)
is('nobody’s location known: not abroad', A.basedAbroad({}, [{ location: null }, {}]), false)
is('a tie: not abroad', A.basedAbroad({}, [...us(1), ...de(1)]), false)
is('hq says it: abroad', A.basedAbroad({ hq: 'Berlin, Germany' }, us(5)), true)
is('hq says it: the US', A.basedAbroad({ hq: 'Austin, TX' }, de(5)), false)

console.log(fail ? `\n${fail} failed, ${pass} passed` : `abroad: all ${pass} passed`)
process.exit(fail ? 1 : 0)
