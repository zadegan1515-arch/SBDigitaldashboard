// scripts/test-su-match.mjs — guards "None of these" in src/lib/su-match.ts.
//
// Turning a brand's suggested SponsorUnited pages down used to only drop
// the card; the next lookup parked the same pages right back. The pages
// he rejected must stay out of what is offered, and a bad stored row
// must not break the list. Compiles the lib on its own, like
// test-region.mjs. Run: node scripts/test-su-match.mjs

import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = mkdtempSync(join(tmpdir(), 'su-match-test-'))
execSync(
  'npx tsc src/lib/su-match.ts --outDir ' + out +
  ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck',
  { stdio: 'inherit' },
)
const { candidatesToOffer, rejectCandidates, readRejected, decideMatch, resemblesBrand, resemblingCandidates } =
  await import(pathToFileURL(join(out, 'su-match.js')).href)

let pass = 0, fail = 0
const is = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return }
  fail++; console.log('✗', label, '— got', JSON.stringify(got), 'want', JSON.stringify(want))
}

const found = [
  { externalId: 'GC1', name: 'Good Culture' },
  { externalId: 'GC2', name: 'Good Culture Foods' },
  { externalId: 'CP', name: 'Culture Pop' },
]
const ids = list => list.map(c => c.externalId)

is('nothing rejected: all offered', ids(candidatesToOffer(found)), ['GC1', 'GC2', 'CP'])
is('rejected pages stay down', ids(candidatesToOffer(found, ['GC2', 'CP'])), ['GC1'])
is('all rejected: nothing to ask', ids(candidatesToOffer(found, ['GC1', 'GC2', 'CP'])), [])
is('corrupt rejected row', ids(candidatesToOffer(found, 'GC1')), ['GC1', 'GC2', 'CP'])
is('corrupt candidates row', ids(candidatesToOffer(null, ['GC1'])), [])
is('holes in the list', ids(candidatesToOffer([null, { externalId: '', name: 'x' }, found[0]])), ['GC1'])

// A turned-down exact match is not attached behind Leo's back either:
// the server decides on what is offered, not on what came back.
is('rejected exact match is not picked',
  decideMatch('Good Culture', null, candidatesToOffer(found, ['GC1'])).pick, null)
is('exact match still attaches', decideMatch('Good Culture', null, found).pick.externalId, 'GC1')

// The memory itself, through a fake Setting store.
const rows = new Map()
const db = { setting: {
  findUnique: async ({ where }) => (rows.has(where.key) ? { value: rows.get(where.key) } : null),
  upsert: async ({ where, create, update }) => rows.set(where.key, rows.has(where.key) ? update.value : create.value),
} }
await rejectCandidates(db, 'b1', ['GC2', 'CP'])
await rejectCandidates(db, 'b1', ['CP', 'X9'])
await rejectCandidates(db, 'b2', ['GC1'])
const log = await readRejected(db)
is('remembered per brand, no repeats', log.b1, ['GC2', 'CP', 'X9'])
is('other brands untouched', log.b2, ['GC1'])
// Only pages that could be the brand are offered (SponsorUnited's own
// tiles were parked for every brand, and Use this put Halfday on Notion).
const tiles = [
  { externalId: 'ES', name: 'ESKA Water Beverage - Non-Alcoholic Water & Specialty Water' },
  { externalId: 'HD', name: 'Halfday Iced Tea Beverage - Non-Alcoholic Tea' },
  { externalId: 'HI', name: 'Hims Healthcare Pharma & Over the Counter' },
]
is('tiles are not Notion', ids(resemblingCandidates('Notion', null, tiles)), [])
is('tiles are not Mom Water', ids(resemblingCandidates('Mom Water', null, tiles)), [])
is('Halfday finds its page', ids(resemblingCandidates('Halfday Iced Tea', null, tiles)), ['HD'])
is('short name in a long result', ids(resemblingCandidates('Halfday', null, tiles)), ['HD'])
is('aka counts', ids(resemblingCandidates('Hims & Hers', 'Hims', tiles)), ['HI'])
is('same first word', resemblesBrand("Grillo's Pickles", null, "Grillo's Food & Beverage"), true)
is('Hinge is not Hims', resemblesBrand('Hinge', null, 'Hims Healthcare'), false)
is('no partial words', resemblesBrand('Hu', null, 'Hum Nutrition'), false)
rows.set('suRejected', '{not json')
is('a corrupt store reads as empty', await readRejected(db), {})

console.log(pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
