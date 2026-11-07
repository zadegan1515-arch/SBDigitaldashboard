// scripts/test-supply.mjs — guards src/lib/supply.ts (Brands → All brands:
// what the queue has to work with; Leo, Nov 5 2026) and the LinkedIn visit
// mark's one more, wider read (li-sweep.ts nextMark / sweptOutcome).
// Run: node scripts/test-supply.mjs

import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = mkdtempSync(join(tmpdir(), 'supply-test-'))
execSync(
  'npx tsc src/lib/supply.ts src/lib/li-sweep.ts --outDir ' + out +
  ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck',
  { stdio: 'inherit' },
)
for (const f of readdirSync(out).filter(f => f.endsWith('.js'))) {
  const p = join(out, f)
  writeFileSync(p, readFileSync(p, 'utf8').replace(/from '(\.\/[^']+)'/g, "from '$1.js'"))
}
const S = await import(pathToFileURL(join(out, 'supply.js')).href)
const L = await import(pathToFileURL(join(out, 'li-sweep.js')).href)

let pass = 0, fail = 0
const is = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return }
  fail++; console.log('✗', label, '— got', JSON.stringify(got), 'want', JSON.stringify(want))
}

// ---- the rules that hold a brand back, and the switches ----
is('a giant held back', S.holdsOf({ giant: true, tooSmall: false, skip: false }, {}), ['giant'])
is('giants let in', S.holdsOf({ giant: true, tooSmall: false, skip: false }, { giantsOn: true }), [])
is('too small held back', S.holdsOf({ giant: false, tooSmall: true, skip: false }, {}), ['small'])
is('too small let in', S.holdsOf({ giant: false, tooSmall: true, skip: false }, { smallOn: true }), [])
is('a Skip category has no switch here (Category priority)', S.holdsOf({ giant: false, tooSmall: false, skip: true }, { giantsOn: true, smallOn: true }), ['skip'])
is('every rule that holds it', S.holdsOf({ giant: true, tooSmall: true, skip: true }, {}), ['giant', 'skip', 'small'])
is('a switch lets in only the brands that rule alone holds',
  [S.onlyHeldBy([['giant'], ['giant', 'small'], ['small'], ['skip']], 'giant'), S.onlyHeldBy([['giant'], ['giant', 'small'], ['small']], 'small')], [1, 1])

// ---- where a brand stands ----
const st = (o) => S.supplyOf({ off: false, reached: false, pass: false, holds: [], ready: true, ...o })
is('ready', st({}), 'ready')
is('short on people', st({ ready: false }), 'short')
is('archived / not US / closed = off, before anything', st({ off: true, reached: true, holds: ['giant'] }), 'off')
is('reached before = only by hand, before a hold', st({ reached: true, holds: ['small'] }), 'reached')
is('a hold, before a Pass', st({ holds: ['skip'], pass: true }), 'held')
is('on a Pass', st({ pass: true }), 'pass')
is('the queue could pick ready, short and a Pass', ['ready', 'short', 'pass', 'held', 'reached', 'off'].map(S.queuePickable), [true, true, true, false, false, false])

// ---- the fill's one more, wider read ----
const at = '2026-10-20T15:00:00.000Z'
const clean = { at, seen: 30, added: 1, v: 2, clean: true, issue: null }
is('a clean read is open for one more read', S.rereadOpen(clean), true)
is('not once it was read again', S.rereadOpen({ ...clean, reread: true }), false)
is('not when its read already searched founders & events', S.rereadOpen({ ...clean, wide: true }), false)
is('not a read with an issue (that one is retried anyway)', S.rereadOpen({ ...clean, clean: false, issue: 'partial' }), false)
is('not a very-big skip', S.rereadOpen({ at, seen: 0, added: 0, v: 2, skip: 'veryBig', clean: false }), false)
is('not a brand never read', S.rereadOpen(undefined), false)
is('a legacy Sales Navigator read counts as clean', S.rereadOpen({ at, seen: 10, added: 0, v: 2, sn: true }), true)
// Nov 7 2026 — a brand that still needs people gets one more read, founders & events searched or not.
is('still needs people: one more read, even after the wide search', S.needsReadOpen({ ...clean, wide: true }), true)
is('…once', S.needsReadOpen({ ...clean, wide: true, reread: true }), false)
is('…not a read with an issue (retried anyway), a skip, or a brand never read',
  [S.needsReadOpen({ ...clean, clean: false, issue: 'partial' }), S.needsReadOpen({ at, seen: 0, added: 0, v: 2, skip: 'veryBig', clean: false }), S.needsReadOpen(undefined)], [false, false, false])

is('fill kinds', [
  S.fillKindOf(undefined, { reread: false, reader: 2 }),
  S.fillKindOf({ at, seen: 0, added: 0, v: 1 }, { reread: false, reader: 2 }),
  S.fillKindOf({ ...clean, clean: false, issue: 'snNoLoad' }, { reread: false, reader: 2 }),
  S.fillKindOf(clean, { reread: true, reader: 2 }),
], ['new', 'new', 'again', 'reread'])

// The visit after a clean read marks the brand re-read, for good.
const m1 = L.nextMark(clean, { seen: 40, added: 3, v: 2, clean: true, issue: null, wide: true }, '2026-11-06T15:00:00.000Z')
is('a visit after a clean read is its one more read', [m1.reread, m1.wide, S.rereadOpen(m1)], [true, true, false])
const m2 = L.nextMark(m1, { seen: 40, added: 0, v: 2, clean: true, issue: null }, '2026-12-06T15:00:00.000Z')
is('re-read stays on later marks', m2.reread, true)
const m3 = L.nextMark(m1, { seen: 0, added: 0, v: 2, clean: false, issue: 'snNoLoad' }, '2026-12-06T15:00:00.000Z')
is('…and through an issue', [m3.reread, m3.issue], [true, 'snNoLoad'])
const first = L.nextMark(undefined, { seen: 10, added: 2, v: 2, clean: true, issue: null }, at)
is('a first read is not a re-read', first.reread, undefined)
const afterIssue = L.nextMark({ ...clean, clean: false, issue: 'partial', tries: 1 }, { seen: 10, added: 2, v: 2, clean: true, issue: null }, at)
is('a retry after an issue is not a re-read', afterIssue.reread, undefined)
is('the visit says it searched founders & events', [L.sweptOutcome({ salesNav: true, done: true, wide: true }).wide, L.sweptOutcome({ salesNav: true, done: true }).wide], [true, undefined])
is('a re-read clean brand is due never again by itself', L.liDue(m2, false).due, false)

// ---- Archive dead weight ----
const dw = (o) => S.deadWeightOf({
  notUs: false, closed: false, seller: false, reachable: 0, cleanRead: true, rereadPending: false, noPage: false,
  inTalks: false, deal: false, activation: false, rep: false, handPick: false, ...o,
})
is('nobody to reach after a full read', dw({}), 'nobody')
is('not while its wider read is still to come', dw({ rereadPending: true }), null)
is('not a brand never read', dw({ cleanRead: false }), null)
is('not with someone to reach', dw({ reachable: 1 }), null)
is('not one Leo picked himself', dw({ handPick: true }), null)
is('a hard fact still counts for a brand he picked', dw({ handPick: true, notUs: true, reachable: 4 }), 'notus')
is('not sold in the US first', dw({ notUs: true, closed: true, seller: true }), 'notus')
is('closed', dw({ closed: true, reachable: 3 }), 'closed')
is('sells sponsorships', dw({ seller: true, reachable: 3 }), 'seller')
is('no page, no parent, nobody', dw({ noPage: true, cleanRead: false }), 'nopage')
is('never a brand in talks, with a deal, an activation or Elizabeth\'s outreach',
  [dw({ inTalks: true, notUs: true }), dw({ deal: true }), dw({ activation: true, closed: true }), dw({ rep: true })], [null, null, null, null])
is('every reason has words', Object.keys(S.DEAD_WORDS).sort(), ['closed', 'nobody', 'nopage', 'notus', 'seller'])

console.log(fail ? `supply: ${fail} failed, ${pass} passed` : `supply: all ${pass} passed`)
process.exit(fail ? 1 : 0)
