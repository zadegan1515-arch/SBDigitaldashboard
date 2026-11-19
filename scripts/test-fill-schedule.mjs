// scripts/test-fill-schedule.mjs — guards src/lib/fill-schedule.ts (Outreach →
// People's Fill schedule: the LinkedIn fill's worklist cut into its days).
// Run: node scripts/test-fill-schedule.mjs

import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = mkdtempSync(join(tmpdir(), 'fill-schedule-test-'))
execSync('npx tsc src/lib/fill-schedule.ts --outDir ' + out + ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck', { stdio: 'inherit' })
// Node wants the extension the bundler doesn't.
for (const f of readdirSync(out)) if (f.endsWith('.js')) writeFileSync(join(out, f), readFileSync(join(out, f), 'utf8').replace(/from '\.\/([\w-]+)'/g, "from './$1.js'"))
const { splitFillDays, fillWhy, byFit, fillReason, fillFirst, fillOff, FILL_REASONS, FILL_OFF } = await import(pathToFileURL(join(out, 'fill-schedule.js')).href)

let pass = 0, fail = 0
const is = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return }
  fail++; console.log('✗', label, '— got', JSON.stringify(got), 'want', JSON.stringify(want))
}
const items = n => Array.from({ length: n }, (_, i) => ({ brandId: 'b' + i, name: 'B' + i, fit: 70 }))

let d = splitFillDays(items(250), { today: '2026-10-12', doneToday: 0, perDay: 100 })
is('100 a day', d.map(x => [x.day, x.rows.length]), [['2026-10-12', 100], ['2026-10-13', 100], ['2026-10-14', 50]])
is('order kept', d[1].rows[0].name, 'B100')
d = splitFillDays(items(150), { today: '2026-10-12', doneToday: 40, perDay: 100 })
is('today gets what is left', d.map(x => [x.day, x.rows.length]), [['2026-10-12', 60], ['2026-10-13', 90]])
d = splitFillDays(items(5), { today: '2026-10-12', doneToday: 100, perDay: 100 })
is('done for today → starts tomorrow', d.map(x => [x.day, x.rows.length]), [['2026-10-13', 5]])
d = splitFillDays(items(3), { today: '2026-10-31', doneToday: 99, perDay: 100 })
is('across a month', d.map(x => x.day), ['2026-10-31', '2026-11-01'])
is('weekends too', splitFillDays(items(201), { today: '2026-10-16', doneToday: 0, perDay: 100 }).map(x => x.day), ['2026-10-16', '2026-10-17', '2026-10-18'])
is('nothing → no days', splitFillDays([], { today: '2026-10-12', doneToday: 0, perDay: 100 }), [])

is('schedule brand', fillWhy({ name: 'X', brandId: 'x', planned: '2026-10-14' }, '', k => 'Wed'), 'On the Schedule Wed, short on people')
is('asked', fillWhy({ name: 'X', research: true, asked: true }, ''), 'Asked for by name')
is('you added it', fillWhy({ name: 'X', brandId: 'x', mine: 'added', noBuyer: true }, ''), 'You added it')
is('on your Week plan list', fillWhy({ name: 'X', brandId: 'x', mine: 'list' }, ''), 'On your Week plan list (you added it)')
is('research', fillWhy({ name: 'X', research: true, lane: 'Energy drinks', focus: true }, 'electrolyte'), 'Research list · Energy drinks · focus “electrolyte”')
is('no buyer', fillWhy({ name: 'X', brandId: 'x', noBuyer: true }, ''), 'No buyer on file')
is('reached last', fillWhy({ name: 'X', brandId: 'x', last: 'reached', noBuyer: true }, ''), 'Already reached out — read last')
is('read last beats the Sales Navigator retry', fillWhy({ name: 'X', brandId: 'x', last: 'reached', hiddenRetry: true }, ''), 'Already reached out — read last')
is('a read that went wrong', fillWhy({ name: 'X', brandId: 'x', retry: true, issue: 'snNoLoad', tries: 1 }, ''), 'Read again — Sales Navigator’s results didn’t load')
is('…for the third time', fillWhy({ name: 'X', brandId: 'x', retry: true, issue: 'partial', tries: 2 }, ''), 'Read again — didn’t read all the people (try 3)')
is('giant last', fillWhy({ name: 'X', brandId: 'x', last: 'giant' }, ''), 'Giant, held back — read last')
is('plain', fillWhy({ name: 'X', brandId: 'x' }, ''), 'Under 25 people on file')

// Best Brand Fit first (Leo, Oct 19 2026): the score leads; a re-read, a saved
// page, the focus word, mid-size, no buyer yet and fewest on file only break a tie.
const B = (name, fit, extra) => ({ name, fit, ...extra })
const names = xs => byFit(xs).map(i => i.name)
is('highest score first', names([B('Low', 52), B('Top', 83), B('Mid', 68)]), ['Top', 'Mid', 'Low'])
is('a re-read waits for its score', names([B('Reread', 60, { retry: true }), B('Better', 73)]), ['Better', 'Reread'])
is('a big company with the better score goes first', names([B('Midsize', 63, { size: 'target' }), B('Bigco', 73, { size: 'big' })]), ['Bigco', 'Midsize'])
is('the focus word only breaks a tie', names([B('Electro', 53, { focus: true }), B('Energy', 83)]), ['Energy', 'Electro'])
is('ties: re-read, then a saved page, then focus, then mid-size, then no buyer, then fewest on file',
  names([
    B('Plain', 70, { linkedinUrl: 'x', contacts: 5 }), B('Fewer', 70, { linkedinUrl: 'x', contacts: 1 }),
    B('NoBuyer', 70, { linkedinUrl: 'x', noBuyer: true }), B('Midsize', 70, { linkedinUrl: 'x', size: 'target' }),
    B('Focus', 70, { linkedinUrl: 'x', focus: true }), B('NoPage', 70, { retry: false }), B('Reread', 70, { retry: true }),
  ]),
  ['Reread', 'Focus', 'Midsize', 'NoBuyer', 'Fewer', 'Plain', 'NoPage'])
is('no score goes last', names([B('Unknown', null), B('Scored', 50)]), ['Scored', 'Unknown'])
const orig = [B('A', 1), B('B', 2)]
byFit(orig)
is('leaves the list it was given alone', orig.map(i => i.name), ['A', 'B'])

// Brands → LinkedIn run (Leo, Nov 18 2026): every brand on the run under one
// reason — what the run is for there; going first is a tag, not a reason.
const R = extra => fillReason({ name: 'X', brandId: 'x', ...extra })
is('never read on LinkedIn', R({ kind: 'new', short: true, needs: true, noBuyer: true }), 'new')
is('one he added himself, never read, is still new', R({ kind: 'new', mine: 'added' }), 'new')
is('on the Schedule and never read is still new', R({ kind: 'new', planned: '2026-11-25', short: true }), 'new')
is('read before, short on people', R({ kind: 'again', short: true }), 'people')
is('read in full, still needs people — its one more read', R({ kind: 'reread', reread: true, rereadWhy: 'needs', needs: true }), 'people')
is('read before, no buyer on file', R({ kind: 'again', noBuyer: true }), 'people')
is('read in full before founders & events were searched', R({ kind: 'reread', reread: true, rereadWhy: 'wide' }), 'wide')
is('…and short on people: people is the reason', R({ kind: 'reread', reread: true, rereadWhy: 'wide', short: true }), 'people')
is('the last read went wrong', R({ kind: 'again', retry: true, issue: 'snNoLoad', short: true }), 'wrong')
is('buyers hidden last time', R({ kind: 'again', hiddenRetry: true }), 'wrong')
is('has its people, due again', R({ kind: 'again' }), 'due')
is('reached before: read last, whatever else', R({ kind: 'new', last: 'reached', short: true }), 'reached')
is('a giant held back', R({ kind: 'again', last: 'giant' }), 'giant')
is('a research name', fillReason({ name: 'X', research: true, asked: true }), 'research')
is('every reason has its words, once', FILL_REASONS.map(r => r.key).sort(), ['due', 'giant', 'new', 'people', 'reached', 'research', 'wide', 'wrong'])
is('new and not enough people lead the page', FILL_REASONS.slice(0, 2).map(r => r.label), ['New — never read', 'Not enough people'])

is('first: the Schedule', fillFirst({ name: 'X', planned: '2026-11-25', mine: 'added' }, () => 'Wed, Nov 25'), 'On the Schedule Wed, Nov 25')
is('first: he added it', fillFirst({ name: 'X', mine: 'added' }), 'You added it')
is('first: his Week plan list', fillFirst({ name: 'X', mine: 'list' }), 'On your Week plan list')
is('first: asked for', fillFirst({ name: 'X', research: true, asked: true }), 'Asked for by name')
is('in its Brand Fit place', fillFirst({ name: 'X', short: true }), '')

// Every other brand in play: the one thing keeping it off the run.
is('read in full', fillOff({ why: 'resting', back: null }), 'done')
is('resting a month', fillOff({ why: 'resting', back: '2026-12-01T00:00:00Z' }), 'wait')
is('on his page-pick list: the pick is the way back', fillOff({ why: 'resting', back: '2026-12-01T00:00:00Z', inReview: true }), 'pick')
is('stuck and on his list: the pick too', fillOff({ why: 'stuck', back: '2026-12-01T00:00:00Z', inReview: true }), 'pick')
is('stuck', fillOff({ why: 'stuck', back: '2026-12-01T00:00:00Z' }), 'stuck')
is('under the floor stays under the floor, on his list or not', fillOff({ why: 'belowFit', inReview: true }), 'belowFit')
is('full, no page, very big', ['full', 'nopage', 'veryBig'].map(why => fillOff({ why })), ['full', 'nopage', 'veryBig'])
is('anything else', fillOff({ why: 'mystery' }), 'other')
is('every off line has its words, once', FILL_OFF.map(r => r.key).sort(), ['belowFit', 'done', 'full', 'nopage', 'other', 'pick', 'stuck', 'veryBig', 'wait'])
is('what he can act on comes first', FILL_OFF[0].key, 'pick')

console.log(fail ? `fill-schedule: ${fail} failed, ${pass} passed` : `fill-schedule: all ${pass} passed`)
process.exit(fail ? 1 : 0)
