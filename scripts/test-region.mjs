// scripts/test-region.mjs — guards src/lib/region.ts.
//
// The non-US flag decides what Leo sees next to a contact before he
// spends one of twenty daily invites on them. A wrong "foreign" tag on a
// US buyer is the expensive mistake, so the rules are conservative and
// this pins them. Compiles the lib on its own, like test-audience.mjs.
// Run: node scripts/test-region.mjs

import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = mkdtempSync(join(tmpdir(), 'region-test-'))
execSync(
  'npx tsc src/lib/region.ts --outDir ' + out +
  ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck',
  { stdio: 'inherit' },
)
const { regionFlag } = await import(pathToFileURL(join(out, 'region.js')).href)

let pass = 0, fail = 0
const is = (label, got, want) => {
  const g = got ? got.label : null
  if (g === want) { pass++; return }
  fail++; console.log('✗', label, '— got', JSON.stringify(g), 'want', JSON.stringify(want))
}

// Real rows from the On! / On Running brand page.
is('Zürich CMO',            regionFlag('Zürich Area, Switzerland', 'Chief Marketing Officer'), 'Switzerland')
is('London, EMEA North',    regionFlag('London, England, United Kingdom', 'Head of Marketing - EMEA North'), 'EMEA')
is('EMEA South, no location', regionFlag(null, 'Head of Marketing | EMEA South'), 'EMEA')
is('London partnerships',   regionFlag('London, England, United Kingdom', 'Senior Lead, Influencer Marketing and Partnerships'), 'UK')
is('US VP, no location',    regionFlag(null, 'VP, Sports & Entertainment Talent Partnerships'), null)

// US rows must never be flagged.
is('California',            regionFlag('Orange County, California, United States', 'Director of Partnerships'), null)
is('Texas metro, no country', regionFlag('San Antonio, Texas Metropolitan Area', 'VP'), null)
is('New York',              regionFlag('New York, New York', 'Brand Marketing'), null)
is('Washington DC',         regionFlag('Washington DC', 'Partnerships'), null)
is('North America title beats foreign city',
   regionFlag('Toronto, Ontario, Canada', 'Head of Marketing Management, North America'), null)
is('Canada is close enough', regionFlag('Toronto, Ontario, Canada', 'Marketing Manager'), null)

// Unknown stays unknown rather than guessing.
is('empty location',        regionFlag('', 'Marketing Manager'), null)
is('nulls',                 regionFlag(null, null), null)
is('unrecognised place',    regionFlag('Atlantis', 'Marketing Manager'), null)

// Other regions.
is('Singapore',             regionFlag('Singapore', 'Marketing Lead'), 'APAC')
is('São Paulo',             regionFlag('São Paulo, Brazil', 'Marketing'), 'LATAM')
is('APAC title',            regionFlag(null, 'Marketing Director, APAC'), 'APAC')
is('Dubai',                 regionFlag('Dubai, United Arab Emirates', 'Head of Brand'), 'Middle East')

console.log(pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
