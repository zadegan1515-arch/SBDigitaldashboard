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
const { REST_DAYS, rowReached, firstOutreachAt, restUntil, queueGate, giantOf } = await import(pathToFileURL(join(out, 'queue-rules.js')).href)

let pass = 0, fail = 0
const is = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return }
  fail++; console.log('✗', label, '— got', JSON.stringify(got), 'want', JSON.stringify(want))
}
const d = s => new Date(s + 'T15:00:00Z')
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
is('an accept logged without a date uses when it was logged', firstOutreachAt([
  row({ status: 'accepted', loggedAt: d('2026-10-03'), updatedAt: d('2026-10-09') }),
])?.toISOString(), d('2026-10-03').toISOString())
is('…or its last change when that is all there is', firstOutreachAt([
  row({ status: 'replied', updatedAt: d('2026-10-04') }),
])?.toISOString(), d('2026-10-04').toISOString())
is('not-reached rows never set the date', firstOutreachAt([
  row({ updatedAt: d('2026-01-01') }), row({ status: 'sent', sentAt: d('2026-10-05') }),
])?.toISOString(), d('2026-10-05').toISOString())
is('two weeks', REST_DAYS, 14)
is('rests until 14 days after', restUntil(d('2026-10-01')).toISOString(), d('2026-10-15').toISOString())

// ---- the gate ---------------------------------------------------------------
const now = d('2026-10-12')
const fresh = { name: 'Tiny Soda', rows: [row(), row()] }
const reached = days => ({ name: 'Mid Co', rows: [row({ status: 'sent', sentAt: new Date(now.getTime() - days * 864e5) }), row()] })
is('a fresh brand goes, picked or by hand', [queueGate(fresh, { auto: true, giantsOn: false, now }), queueGate(fresh, { auto: false, giantsOn: false, now })], [null, null])
is('the system never picks a reached brand, however long ago', [
  queueGate(reached(3), { auto: true, giantsOn: false, now })?.reason,
  queueGate(reached(60), { auto: true, giantsOn: true, now })?.reason,
], ['reached', 'reached'])
const r3 = queueGate(reached(3), { auto: false, giantsOn: false, now })
is('by hand: rests two weeks from the first outreach', [r3?.reason, r3?.until?.toISOString()],
  ['resting', new Date(now.getTime() + 11 * 864e5).toISOString()])
is('by hand: on the 14th day it can go again', queueGate(reached(14), { auto: false, giantsOn: false, now }), null)
is('by hand: still resting on day 13', queueGate(reached(13), { auto: false, giantsOn: false, now })?.reason, 'resting')
const red = { name: 'Red Bull', rows: [row()] }
is('a giant is held back from the picks', queueGate(red, { auto: true, giantsOn: false, now }), { reason: 'giant', why: 'a household name' })
is('a giant by hand: a question (giant), not a rest', queueGate(red, { auto: false, giantsOn: false, now })?.reason, 'giant')
is('giants on: it goes', queueGate(red, { auto: true, giantsOn: true, now }), null)
is('resting wins over giant by hand', queueGate({ ...reached(2), name: 'Red Bull' }, { auto: false, giantsOn: false, now })?.reason, 'resting')

// ---- giants -------------------------------------------------------------------
is('household name, any spelling', giantOf({ name: 'Monster Energy Co.' }), 'a household name')
is('by another name (aka)', giantOf({ name: 'Liquid Hydration Co', aka: 'Liquid IV' }), 'a household name')
is('a parent company', giantOf({ name: 'Diageo' }), 'a parent company')
is('owned by a parent', !!giantOf({ name: 'Smirnoff' }), true)
is('$1B+ in sales (cents)', giantOf({ name: 'Unknown Big', salesCents: 150_000_000_000n }), '$1B+ in sales')
is('under $1B is not', giantOf({ name: 'Unknown Mid', salesCents: 5_000_000_000n }), null)
is('a small brand is not', giantOf({ name: 'Olipop' }), null)

console.log(fail ? `queue-rules: ${pass} passed, ${fail} FAILED` : `queue-rules: all ${pass} passed`)
process.exit(fail ? 1 : 0)
