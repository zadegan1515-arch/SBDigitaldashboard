// scripts/test-queue-rules.mjs — guards src/lib/queue-rules.ts: who may go
// into the LinkedIn outreach queue (Leo, Oct 12 2026).
//
// Pins: the system only picks brands nobody has reached out to (an invite
// logged outside the queue or withdrawn counts, a mistaken send taken back
// doesn't); by hand a reached brand rests 14 days from its FIRST outreach;
// giants are held back unless Leo turns them on. Compiles the lib and the
// ones it reads, like test-duplicates.mjs.
// Run: node scripts/test-queue-rules.mjs

import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = mkdtempSync(join(tmpdir(), 'queue-rules-test-'))
execSync(
  'npx tsc src/lib/queue-rules.ts --outDir ' + out +
  ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck',
  { stdio: 'inherit' },
)
// Node wants the extension on a relative import; tsc leaves it off.
for (const f of readdirSync(out).filter(f => f.endsWith('.js'))) {
  const p = join(out, f)
  writeFileSync(p, readFileSync(p, 'utf8').replace(/from '(\.\/[^']+)'/g, "from '$1.js'"))
}
const { REST_DAYS, rowReached, firstOutreachAt, restUntilDay, queueGate, giantOf, nyDayKey, isConglomerate, veryBigWhy, VERY_BIG_LI } = await import(pathToFileURL(join(out, 'queue-rules.js')).href)

let pass = 0, fail = 0
const is = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return }
  fail++; console.log('✗', label, '— got', JSON.stringify(got), 'want', JSON.stringify(want))
}
const d = s => new Date(s + 'T15:00:00Z') // 11am New York
const row = (o = {}) => ({ status: 'queued', sentAt: null, ...o })

// ---- reached or not ------------------------------------------------------
is('a waiting person is not reached', rowReached(row()), false)
is('an invite with its date', rowReached(row({ status: 'sent', sentAt: d('2026-10-01') })), true)
is('logged straight to accepted (no invite date)', rowReached(row({ status: 'accepted' })), true)
is('withdrawn after it went (keeps its date)', rowReached(row({ status: 'withdrawn', sentAt: d('2026-09-01') })), true)
is('a send taken back as a mistake (no date) is not reached', rowReached(row({ status: 'queued', sentAt: null })), false)
is('a hand email', rowReached(row({ emailedAt: d('2026-10-02') })), true)
is('an email the machine sent', rowReached(row({ emails: 1 })), true)
is('passed / skipped people are not reached', rowReached(row({ status: 'passed' })), false)

// ---- the first outreach --------------------------------------------------
is('never reached: null', firstOutreachAt([row(), row({ status: 'drafted' })]), null)
is('the earliest of invites and emails', firstOutreachAt([
  row({ status: 'sent', sentAt: d('2026-10-05') }),
  row({ emailedAt: d('2026-09-28') }),
  row({ emails: 1, firstEmailAt: d('2026-10-01') }),
  row(),
])?.toISOString(), d('2026-09-28').toISOString())
is('an accept logged without a date uses its last change', firstOutreachAt([
  row({ status: 'replied', updatedAt: d('2026-10-04') }),
])?.toISOString(), d('2026-10-04').toISOString())
is('not-reached rows never set the date', firstOutreachAt([
  row({ updatedAt: d('2026-01-01') }), row({ status: 'sent', sentAt: d('2026-10-05') }),
])?.toISOString(), d('2026-10-05').toISOString())
is('two weeks', REST_DAYS, 14)
is('rests until the same weekday two weeks on', restUntilDay(d('2026-10-01')), '2026-10-15')
is('late evening counts as that New York day', restUntilDay(new Date('2026-10-02T02:30:00Z')), '2026-10-15')
is('New York day keys', nyDayKey(new Date('2026-10-02T03:59:00Z')), '2026-10-01')

// ---- the gate ---------------------------------------------------------------
const today = '2026-10-12'
const fresh = { name: 'Tiny Soda', rows: [row(), row()] }
const reachedOn = day => ({ name: 'Mid Co', rows: [row({ status: 'sent', sentAt: d(day) }), row()] })
const gate = (b, o) => queueGate(b, { giantsOn: false, day: today, ...o })
is('a fresh brand goes, picked or by hand', [gate(fresh, { auto: true }), gate(fresh, { auto: false })], [null, null])
is('the system never picks a reached brand, however long ago', [
  gate(reachedOn('2026-10-09'), { auto: true })?.reason,
  gate(reachedOn('2026-08-01'), { auto: true, giantsOn: true })?.reason,
], ['reached', 'reached'])
const r3 = gate(reachedOn('2026-10-09'), { auto: false })
is('by hand: rests two weeks from the first outreach', [r3?.reason, r3?.until], ['resting', '2026-10-23'])
is('by hand: on the 14th day it can go again', gate(reachedOn('2026-09-28'), { auto: false }), null)
is('by hand: still resting on day 13', gate(reachedOn('2026-09-29'), { auto: false })?.reason, 'resting')
is('the day it opened is its sitting: more people that day are fine', [
  gate(reachedOn(today), { auto: true }), gate(reachedOn(today), { auto: false }),
], [null, null])
is('a later Schedule day is judged as of that day', [
  gate(reachedOn('2026-10-09'), { auto: false, day: '2026-10-22' })?.reason,
  gate(reachedOn('2026-10-09'), { auto: false, day: '2026-10-23' }),
  gate(reachedOn(today), { auto: false, day: '2026-10-13' })?.reason,
], ['resting', null, 'resting'])
const loggedAccept = { name: 'Mid Co', rows: [row({ status: 'accepted', updatedAt: d(today) })] }
is('an accept logged without a date is never a sitting (Zach\'s list touches it daily)', [
  gate(loggedAccept, { auto: true })?.reason, gate(loggedAccept, { auto: false })?.reason,
  gate(loggedAccept, { auto: false })?.until,
], ['reached', 'resting', '2026-10-26'])
const red = { name: 'Red Bull', rows: [row()] }
is('a giant is held back from the picks', gate(red, { auto: true }), { reason: 'giant', why: 'a household name' })
is('a giant by hand: a question (giant), not a rest', gate(red, { auto: false })?.reason, 'giant')
is('giants on (or this one OK\'d): it goes', gate(red, { auto: true, giantsOn: true }), null)
is('resting wins over giant by hand', gate({ ...reachedOn('2026-10-09'), name: 'Red Bull' }, { auto: false })?.reason, 'resting')

// ---- giants -------------------------------------------------------------------
is('household name, any spelling', giantOf({ name: 'Celsius Holdings, Inc.' }), 'a household name')
is('Monster Energy is Monster Beverage\'s own page: a conglomerate', giantOf({ name: 'Monster Energy Co.' }), null)
is('a conglomerate\'s brand by another name is still a giant', giantOf({ name: 'Bang Energy' }), 'owned by Monster Beverage')
is('by another name (aka)', giantOf({ name: 'Liquid Hydration Co', aka: 'Liquid IV' }), 'a household name')
// Conglomerates (Leo, Oct 12 2026: "yes except for congomerates"): the parent
// companies themselves are never held back — not as giants, not for 1,500+.
is('a conglomerate is not held back', giantOf({ name: 'Diageo' }), null)
is('a conglomerate on the household list, 12,000 on LinkedIn: not held', giantOf({ name: 'Molson Coors', liMembers: 12338 }), null)
is('a conglomerate by an aka', isConglomerate({ name: 'Diageo North America', aka: 'Diageo' }), true)
is('a conglomerate\'s brand is not a conglomerate', isConglomerate({ name: 'Crown Royal' }), false)
is('a conglomerate goes by itself', gate({ ...fresh, name: 'Diageo' }, { auto: true }), null)
is('owned by a parent', !!giantOf({ name: 'Smirnoff' }), true)
is('$1B+ in sales (cents)', giantOf({ name: 'Unknown Big', salesCents: 150_000_000_000n }), '$1B+ in sales')
is('under $1B is not', giantOf({ name: 'Unknown Mid', salesCents: 5_000_000_000n }), null)
is('a small brand is not', giantOf({ name: 'Olipop' }), null)

// ---- 1,500+ people on LinkedIn (Leo, Oct 12 2026) ------------------------------
is('the line is 1,500', VERY_BIG_LI, 1500)
is('1,500 on LinkedIn: held back', giantOf({ name: 'Vans', liMembers: 1500 }), '1,500+ people on LinkedIn')
is('1,499: not', giantOf({ name: 'Vans', liMembers: 1499 }), null)
is('size unknown: not', giantOf({ name: 'Vans', liMembers: null }), null)
is('a giant by name keeps its own reason', giantOf({ name: 'Bud Light', liMembers: 5000 }), 'a household name')
is('a conglomerate\'s brand is still a giant', !!giantOf({ name: 'Smirnoff', liMembers: 20 }), true)
is('veryBigWhy skips a conglomerate', veryBigWhy({ name: 'PepsiCo', liMembers: 300000 }), null)
is('1,500+ is held from the picks', gate({ ...fresh, name: 'Hugeco', liMembers: 4000 }, { auto: true }), { reason: 'giant', why: '1,500+ people on LinkedIn' })
is('1,500+ by hand: asks (Add anyway)', gate({ ...fresh, name: 'Hugeco', liMembers: 4000 }, { auto: false })?.reason, 'giant')
is('1,500+ OK\'d (or giants on): it goes', gate({ ...fresh, name: 'Hugeco', liMembers: 4000 }, { auto: true, giantsOn: true }), null)

console.log(fail ? `queue-rules: ${pass} passed, ${fail} FAILED` : `queue-rules: all ${pass} passed`)
process.exit(fail ? 1 : 0)
