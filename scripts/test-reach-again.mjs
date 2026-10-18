// scripts/test-reach-again.mjs — guards src/lib/reach-again.ts (Week plan →
// Reach out again; Leo, Oct 18 2026: recommend reaching a brand again when it
// has decision makers nobody contacted yet, 1 to 2 weeks after the last
// outreach). Run: node scripts/test-reach-again.mjs

import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = mkdtempSync(join(tmpdir(), 'reach-again-test-'))
execSync(
  'npx tsc src/lib/reach-again.ts --outDir ' + out +
  ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck',
  { stdio: 'inherit' },
)
// Node wants the extension on a relative import; tsc leaves it off.
for (const f of readdirSync(out).filter(f => f.endsWith('.js'))) {
  const p = join(out, f)
  writeFileSync(p, readFileSync(p, 'utf8').replace(/from '(\.\/[^']+)'/g, "from '$1.js'"))
}
const R = await import(pathToFileURL(join(out, 'reach-again.js')).href)

let pass = 0, fail = 0
const is = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return }
  fail++; console.log('✗', label, '— got', JSON.stringify(got), 'want', JSON.stringify(want))
}

const d = (key) => new Date(key + 'T16:00:00Z')
const person = (id, title, o = {}) => ({ id, name: 'P ' + id, title, isDecisionMaker: false, reachable: true, stopped: false, flagged: false, ...o })
const row = (contactId, o = {}) => ({ contactId, status: 'queued', shelved: false, shelvedHow: null, sentAt: null, emailedAt: null, emailSentAt: null, updatedAt: d('2026-10-01'), ...o })

const contacts = [
  person('a', 'Brand Manager'), person('b', 'Head of Partnerships'), person('c', 'CEO & Founder'),
  person('d', 'Head of Events'), person('e', 'Sales Associate'), person('f', 'Ops Lead', { isDecisionMaker: true }),
]
const invitedOn = (day) => [row('a', { status: 'sent', sentAt: d(day) })]
const at = (today, targets = invitedOn('2026-10-08'), o = {}) =>
  R.reachAgainOf({ contacts, targets, today, answered: false, deal: false, off: false, ...o })

is('the window: from day 7, due by day 14', [R.AGAIN_FROM_DAYS, R.AGAIN_DUE_DAYS], [7, 14])
is('never reached: no', at('2026-10-20', []).why, 'never')
is('day 6: not yet, and says from when', [at('2026-10-14').why, at('2026-10-14').from], ['soon', '2026-10-15'])
const due = at('2026-10-15')
is('day 7: due', [due.ok, due.state, due.daysSince, due.dueBy], [true, 'due', 7, '2026-10-22'])
is('the decision makers nobody contacted, partnerships first', due.fresh.map(c => c.id), ['b', 'd', 'c', 'f'])
is('day 14: still due', at('2026-10-22').state, 'due')
is('day 15: late, still recommended', [at('2026-10-23').ok, at('2026-10-23').state], [true, 'late'])
is('in talks: no', at('2026-10-20', invitedOn('2026-10-08'), { answered: true }).why, 'answered')
is('a deal: no', at('2026-10-20', invitedOn('2026-10-08'), { deal: true }).why, 'deal')
is('set aside: no', at('2026-10-20', invitedOn('2026-10-08'), { off: true }).why, 'off')

// Counted from the LAST outreach, any kind.
is('an email later moves the clock', at('2026-10-20', [...invitedOn('2026-10-01'), row('c', { emailedAt: d('2026-10-16') })]).why, 'soon')
is('a machine email counts too', R.lastOutreachAt([row('a', { emailSentAt: d('2026-10-09') })]).toISOString(), d('2026-10-09').toISOString())
is('an accept logged with no date counts from its last change', R.lastOutreachAt([row('a', { status: 'accepted', updatedAt: d('2026-10-11') })]).toISOString(), d('2026-10-11').toISOString())

// Who counts as not contacted.
const everyone = [
  row('a', { status: 'sent', sentAt: d('2026-10-01') }),
  row('b', { status: 'withdrawn', sentAt: d('2026-10-01') }),
  row('c', { status: 'passed' }),
  row('d', { status: 'queued', shelved: true, shelvedHow: null }),
  row('f', { status: 'queued', shelved: true, shelvedHow: 'cap' }),
]
is('withdrawn = contacted; passed / shelved by hand = left out; next in line = still fresh', R.freshDecisionMakers(contacts, everyone).map(c => c.id), ['f'])
is('an invite taken back the day it went (no date) never went: still fresh',
  R.freshDecisionMakers([person('b', 'Head of Partnerships')], [row('b', { status: 'withdrawn' })]).map(c => c.id), ['b'])
is('not a decision maker: never recommended', R.freshDecisionMakers([person('e', 'Sales Associate')], []).length, 0)
is('nobody reachable, stopped or flagged', R.freshDecisionMakers([
  person('x', 'CMO', { reachable: false }), person('y', 'CMO', { stopped: true }), person('z', 'CMO', { flagged: true }),
], []).length, 0)
is('every decision maker already contacted: nobody', at('2026-10-20', [
  ...['a', 'b', 'c', 'd', 'f'].map(id => row(id, { status: 'sent', sentAt: d('2026-10-01') })),
]).why, 'nobody')
is('days between New York keys', [R.daysBetween('2026-10-08', '2026-10-15'), R.daysBetween('2026-10-31', '2026-11-02')], [7, 2])

console.log(fail ? `\n${fail} failed, ${pass} passed` : `reach-again: all ${pass} passed`)
process.exit(fail ? 1 : 0)
