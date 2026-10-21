// scripts/test-rep-outreach.mjs — guards src/lib/rep-outreach.ts (the
// Elizabeth tab: her sending days, who goes out at a brand and on which
// channel, a day's list, the roll, where each person stands, the steps and
// Back a step, templates, accounts, results).
// Run: node scripts/test-rep-outreach.mjs

import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = mkdtempSync(join(tmpdir(), 'rep-outreach-test-'))
execSync(
  'npx tsc src/lib/rep-outreach.ts --outDir ' + out +
  ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck',
  { stdio: 'inherit' },
)
for (const f of readdirSync(out).filter(f => f.endsWith('.js'))) {
  const p = join(out, f)
  writeFileSync(p, readFileSync(p, 'utf8').replace(/from '(\.\/[^']+)'/g, "from '$1.js'"))
}
const R = await import(pathToFileURL(join(out, 'rep-outreach.js')).href)

let pass = 0, fail = 0
const is = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return }
  fail++; console.log('✗', label, '— got', JSON.stringify(got), 'want', JSON.stringify(want))
}

// ---- days -------------------------------------------------------------
// Oct 2026: Tue 20, Wed 21, Thu 22, Fri 23, Mon 26, Tue 27.
is('Tue is a sending day', R.isSendingKey('2026-10-20'), true)
is('Fri is not', R.isSendingKey('2026-10-23'), false)
is('a Friday due date moves to Tuesday', R.onSendingDay('2026-10-23'), '2026-10-27')
is('a Wednesday stays', R.onSendingDay('2026-10-21'), '2026-10-21')
is('next after Thu = Tue', R.nextSendingAfter('2026-10-22'), '2026-10-27')
is('week from Wed: Wed, Thu + next week', R.weekDays('2026-10-21'),
  [{ start: '2026-10-19', which: 'this', days: ['2026-10-21', '2026-10-22'] }, { start: '2026-10-26', which: 'next', days: ['2026-10-27', '2026-10-28', '2026-10-29'] }])
is('week from Fri: only next week', R.weekDays('2026-10-23').map(w => w.which), ['next'])
is('week from Sunday: the week after it', R.weekDays('2026-10-25')[0].start, '2026-10-26')

// ---- channel ------------------------------------------------------------
const link = 'https://www.linkedin.com/in/jane-doe'
is('email first', R.channelFor({ email: 'jane@brand.com', linkedinUrl: link }), 'email')
is('LinkedIn when no email', R.channelFor({ email: null, linkedinUrl: link }), 'linkedin')
is('the switch wins when it can', R.channelFor({ email: 'jane@brand.com', linkedinUrl: link }, 'linkedin'), 'linkedin')
is('a switch it can’t do falls back', R.channelFor({ email: null, linkedinUrl: link }, 'email'), 'linkedin')
is('a company page is no person link', R.channelFor({ email: null, linkedinUrl: 'https://www.linkedin.com/company/x' }), null)
is('nothing to reach', R.channelFor({}), null)
is('other channel', R.otherChannel({ email: 'a@b.co', linkedinUrl: link }, 'email'), 'linkedin')
is('no other channel', R.otherChannel({ email: 'a@b.co' }, 'email'), null)

// ---- who goes out ----------------------------------------------------------
const people = [
  { id: 'c1', name: 'Store Clerk', title: 'Sales Associate', email: 'clerk@b.co' },
  { id: 'c2', name: 'Ann Market', title: 'Marketing Manager', linkedinUrl: link + '-2' },
  { id: 'c3', name: 'Pat Partner', title: 'Head of Partnerships', email: 'pat@b.co' },
  { id: 'c4', name: 'Eve Events', title: 'Events Manager', linkedinUrl: link + '-4', email: 'eve@b.co' },
  { id: 'c5', name: 'No Way', title: 'Director of Partnerships', email: 'no@b.co', doNotContactAt: '2026-10-01' },
  { id: 'c6', name: 'Nobody', title: 'CMO' },
]
is('best first, flagged and stopped out', R.pickPeople(people, new Set(), 3).map(x => [x.person.id, x.channel]),
  [['c3', 'email'], ['c4', 'email'], ['c2', 'linkedin']])
is('people she has a row for are skipped', R.pickPeople(people, new Set(['c3']), 2).map(x => x.person.id), ['c4', 'c2'])
is('a flagged title only when nobody else', R.pickPeople(people, new Set(['c2', 'c3', 'c4']), 3).map(x => x.person.id), ['c1'])
is('reachable left = who could be picked (the clerk only when nobody else)', R.reachableLeft(people, new Set(['c3'])), 2)
is('reachable left, only the clerk', R.reachableLeft(people, new Set(['c2', 'c3', 'c4'])), 1)

// ---- a day's list -------------------------------------------------------------
is('whole brands, a too-big one waits, a smaller after it goes',
  R.fillDay([{ id: 'a', size: 10 }, { id: 'b', size: 25 }, { id: 'c', size: 4 }, { id: 'd', size: 0 }], 30),
  { take: ['a', 'c'], waits: ['b'], none: ['d'] })

// ---- the plan ---------------------------------------------------------------
is('clean: each brand once, earliest day wins', R.cleanPlan({ '2026-10-21': ['a', 'b'], '2026-10-22': ['b', 'c', 7], junk: ['x'] }),
  { '2026-10-21': ['a', 'b'], '2026-10-22': ['c'] })
is('put moves it', R.planPut({ '2026-10-21': ['a', 'b'] }, 'a', '2026-10-22'), { '2026-10-21': ['b'], '2026-10-22': ['a'] })
is('put at an index', R.planPut({ '2026-10-22': ['x', 'y'] }, 'a', '2026-10-22', 1), { '2026-10-22': ['x', 'a', 'y'] })
is('remove', R.planRemove({ '2026-10-21': ['a'] }, 'a'), {})
is('day of', R.dayOf({ '2026-10-21': ['a'] }, 'a'), '2026-10-21')

// The roll: Tuesday's unbuilt brand goes first on Wednesday (today); a brand
// already on a later day stays; built ones stay as history.
const rolled = R.rollPlan(
  { '2026-10-20': ['a', 'b', 'c'], '2026-10-21': ['d'], '2026-10-22': ['c'] },
  '2026-10-21', new Set(['2026-10-20|b']),
)
is('roll: plan', rolled.plan, { '2026-10-20': ['b'], '2026-10-21': ['a', 'd'], '2026-10-22': ['c'] })
is('roll: moved', rolled.moved, [{ id: 'a', from: '2026-10-20', to: '2026-10-21' }])
is('roll on a Friday goes to Tuesday', R.rollPlan({ '2026-10-22': ['a'] }, '2026-10-23', new Set()).plan, { '2026-10-27': ['a'] })
is('old history is dropped', R.rollPlan({ '2026-09-01': ['a'] }, '2026-10-21', new Set(['2026-09-01|a'])).plan, {})

// ---- where a row stands ---------------------------------------------------------
const T = '2026-10-21'
const at = (k) => k + 'T15:00:00Z'
is('queued', R.standing({ channel: 'email', status: 'queued', day: '2026-10-20' }, T).group, 'list')
is('invite out', R.standing({ channel: 'linkedin', status: 'sent', sentAt: at('2026-10-20') }, T).stage, 'invited')
is('old invite', R.standing({ channel: 'linkedin', status: 'sent', sentAt: at('2026-09-29') }, T).stage, 'oldInvite')
// Accepted Mon Oct 19 → +2 = Wed 21 (due today).
const acc = R.standing({ channel: 'linkedin', status: 'accepted', sentAt: at('2026-10-14'), acceptedAt: at('2026-10-19') }, T)
is('DM due today', [acc.stage, acc.group, acc.due, acc.late], ['dmDue', 'todo', '2026-10-21', false])
// Accepted Wed 21 → +2 = Fri → Tue 27.
is('DM due on a Friday moves to Tuesday', R.standing({ channel: 'linkedin', status: 'accepted', acceptedAt: at('2026-10-21') }, T).due, '2026-10-27')
is('final due 10 days after the DM', R.standing({ channel: 'linkedin', status: 'accepted', acceptedAt: at('2026-10-01'), dmAt: at('2026-10-06') }, T).stage, 'finalDue')
is('final out, waiting', R.standing({ channel: 'linkedin', status: 'accepted', acceptedAt: at('2026-10-01'), dmAt: at('2026-10-06'), followAt: at('2026-10-20') }, T).group, 'waiting')
is('quiet 7 days after the final = no response', R.standing({ channel: 'linkedin', status: 'accepted', acceptedAt: at('2026-10-01'), dmAt: at('2026-10-02'), followAt: at('2026-10-14') }, T).group, 'noreply')
// Email Thu Oct 15 → +4 = Mon 19 → Tue 20: late.
const em = R.standing({ channel: 'email', status: 'sent', sentAt: at('2026-10-15') }, T)
is('email follow-up late', [em.stage, em.due, em.late], ['followDue', '2026-10-20', true])
is('email follow-up not yet', R.standing({ channel: 'email', status: 'sent', sentAt: at('2026-10-20') }, T).group, 'waiting')
is('email quiet', R.standing({ channel: 'email', status: 'sent', sentAt: at('2026-10-01'), followAt: at('2026-10-06') }, T).group, 'noreply')
is('replied', R.standing({ channel: 'email', status: 'replied', sentAt: at('2026-10-01'), repliedAt: at('2026-10-02') }, T).group, 'replied')
is('call', R.standing({ channel: 'email', status: 'call', callAt: at('2026-10-28') }, T).due, '2026-10-28')
is('declined is done', R.standing({ channel: 'email', status: 'declined' }, T).group, 'done')
is('order: a DM due before a reply to answer',
  R.compareStanding(R.standing({ channel: 'linkedin', status: 'accepted', acceptedAt: at('2026-10-19') }, T), R.standing({ channel: 'email', status: 'replied' }, T)) < 0, true)

// ---- steps -------------------------------------------------------------------
const now = new Date('2026-10-21T15:00:00Z')
is('sent from queued', R.stepData({ channel: 'email', status: 'queued' }, 'sent', now), { data: { status: 'sent', sentAt: now } })
is('sent twice refused', 'refuse' in R.stepData({ channel: 'email', status: 'sent' }, 'sent', now), true)
is('accept an email refused', 'refuse' in R.stepData({ channel: 'email', status: 'sent' }, 'accepted', now), true)
is('accept an invite', R.stepData({ channel: 'linkedin', status: 'sent' }, 'accepted', now), { data: { status: 'accepted', acceptedAt: now } })
is('DM before accept refused', 'refuse' in R.stepData({ channel: 'linkedin', status: 'sent' }, 'dm', now), true)
is('final before DM refused', 'refuse' in R.stepData({ channel: 'linkedin', status: 'accepted' }, 'follow', now), true)
is('email follow-up', R.stepData({ channel: 'email', status: 'sent' }, 'follow', now), { data: { followAt: now } })
is('a LinkedIn reply also counts the accept', R.stepData({ channel: 'linkedin', status: 'sent' }, 'replied', now),
  { data: { status: 'replied', repliedAt: now, acceptedAt: now } })
is('call needs a day', 'refuse' in R.stepData({ channel: 'email', status: 'replied', repliedAt: now }, 'call', now), true)
is('call', R.stepData({ channel: 'email', status: 'replied', repliedAt: now }, 'call', now, { callDay: '2026-10-28' }),
  { data: { status: 'call', callAt: new Date('2026-10-28T16:00:00Z'), callBookedAt: now } })
is('leave out only before sending', 'refuse' in R.stepData({ channel: 'email', status: 'sent' }, 'passed', now), true)
is('withdraw an accepted invite refused', 'refuse' in R.stepData({ channel: 'linkedin', status: 'accepted' }, 'withdrawn', now), true)

// Back a step puts back exactly what the step changed.
const row = { channel: 'linkedin', status: 'sent', sentAt: new Date('2026-10-20T15:00:00Z'), acceptedAt: null }
const st = R.stepData(row, 'accepted', now)
const entry = R.stepEntry(row, 'accepted', st.data, now, 'Elizabeth')
is('entry', entry, { s: 'accepted', at: now.toISOString(), by: 'Elizabeth', before: { status: 'sent', acceptedAt: null } })
const back = R.backData({ ...row, ...st.data, steps: [entry] })
is('back', [back.data, back.steps, back.undone], [{ status: 'sent', acceptedAt: null }, [], 'accepted'])
const back2 = R.backData({ channel: 'email', status: 'sent', steps: [{ s: 'sent', at: 'x', by: null, before: { status: 'queued', sentAt: null } }] })
is('back of a send', back2.data, { status: 'queued', sentAt: null })
const back3 = R.backData({ channel: 'email', status: 'replied', steps: [{ s: 'replied', at: 'x', by: null, before: { status: 'sent', repliedAt: '2026-10-01T10:00:00.000Z' } }] })
is('dates come back as dates', back3.data.repliedAt instanceof Date, true)
is('nothing to take back', 'refuse' in R.backData({ channel: 'email', status: 'queued', steps: [] }), true)

// ---- templates -----------------------------------------------------------------
is('fill', R.fillTemplate('Hi (NAME) at [Brand] — (TITLE)', { name: 'Jane Doe', brand: 'Liquid IV', title: 'CMO' }), 'Hi Jane at Liquid IV — CMO')
is('no name', R.fillTemplate('Hi (NAME)', { name: '', brand: 'X' }), 'Hi there')
const note = R.fillTemplate(R.TPL_DEFAULTS.note.body, { name: 'Alexandria', brand: 'A Rather Long Brand Name Company' })
is('the invite note fits LinkedIn’s 300', note.length <= R.NOTE_MAX, true)
is('signed as Elizabeth', /Elizabeth/.test(R.TPL_DEFAULTS.email.body) && !/Zach/.test(JSON.stringify(R.TPL_DEFAULTS)), true)
const tpl = R.cleanTemplates({ email: { subject: 'S', body: 'B', savedAt: 'x', savedBy: 'Leo' }, dm: { body: '  ' } })
is('saved template', [tpl.email.subject, tpl.email.saved], ['S', true])
is('empty falls back', [tpl.dm.body === R.TPL_DEFAULTS.dm.body, tpl.dm.saved], [true, false])

// ---- accounts -------------------------------------------------------------------
is('accounts', R.cleanAccounts({ ' Liz@SBoyAgency.com ': { rep: 'elizabeth', at: 't', by: 'Leo' }, bad: { rep: 'elizabeth' }, 'x@y.co': { rep: 'other' } }),
  { 'liz@sboyagency.com': { rep: 'elizabeth', at: 't', by: 'Leo' } })

// ---- results ---------------------------------------------------------------------
const rows = [
  { channel: 'linkedin', status: 'accepted', sentAt: at('2026-10-20'), acceptedAt: at('2026-10-21') },
  { channel: 'linkedin', status: 'sent', sentAt: at('2026-10-21') },
  { channel: 'email', status: 'replied', sentAt: at('2026-10-15'), repliedAt: at('2026-10-21') },
  { channel: 'email', status: 'call', sentAt: at('2026-09-01'), repliedAt: at('2026-09-03'), callBookedAt: at('2026-09-03') },
  { channel: 'email', status: 'queued' },
]
is('7 days', R.countRows(rows, R.addDays(T, -6), T), { invites: 2, accepted: 1, emails: 1, replied: 1, calls: 0, acceptRate: 0.5, replyRate: 1 / 3 })
is('all time', R.countRows(rows, null, T).calls, 1)
is('by day', R.byDay(rows, T, 2), [
  { day: '2026-10-21', invites: 1, emails: 0, accepted: 1, replied: 1 },
  { day: '2026-10-20', invites: 1, emails: 0, accepted: 0, replied: 0 },
])
is('invites this week', R.invitesThisWeek(rows, T), 2)
is('brand stage', [R.brandStageOf(rows.slice(0, 2)), R.brandStageOf(rows.slice(2)), R.brandStageOf([rows[4]]), R.brandStageOf([rows[1]])], ['a', 'r', null, 'i'])

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
