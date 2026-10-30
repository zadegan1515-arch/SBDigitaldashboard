// scripts/test-chat-log.mjs — guards src/lib/chat-log.ts (Home → Your chats:
// one row a day per Claude chat — what Leo asked, what it did, what it needs).
// Compiles the lib on its own, like test-work-log.mjs. Run: node scripts/test-chat-log.mjs

import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = mkdtempSync(join(tmpdir(), 'chatlog-test-'))
execSync(
  'npx tsc src/lib/chat-log.ts src/lib/work-log.ts --outDir ' + out +
  ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck',
  { stdio: 'inherit' },
)
// tsc writes "./work-log" imports without an extension; Node needs one.
import { readFileSync, writeFileSync } from 'node:fs'
const f = join(out, 'chat-log.js')
writeFileSync(f, readFileSync(f, 'utf8').replace(/from '\.\/work-log'/, "from './work-log.js'"))
const L = await import(pathToFileURL(f).href)

let pass = 0, fail = 0
const is = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return }
  fail++; console.log('✗', label, '— got', JSON.stringify(got), 'want', JSON.stringify(want))
}

// Session ids and links
is('claude.ai id', L.sessionKey('session_019vbaqHS2fLUyViwTXHELik'), 'session_019vbaqHS2fLUyViwTXHELik')
is('container id → claude.ai id', L.sessionKey('cse_019vbaqHS2fLUyViwTXHELik'), 'session_019vbaqHS2fLUyViwTXHELik')
is('local id kept', L.sessionKey('4d000bed-4eb7-5f3c-8c2a-e8caf615755b'), '4d000bed-4eb7-5f3c-8c2a-e8caf615755b')
is('junk refused', L.sessionKey('x; drop'), null)
is('empty refused', L.sessionKey(''), null)
is('link', L.sessionUrl('cse_019vbaqHS2fLUyViwTXHELik'), 'https://claude.ai/code/session_019vbaqHS2fLUyViwTXHELik')
is('no link for a local chat', L.sessionUrl('4d000bed-4eb7-5f3c-8c2a-e8caf615755b'), null)

// Rule 2: secrets never stored
is('anthropic key', L.redactSecrets('use sk-ant-api03-abcdefghijklmnop please'), 'use [hidden] please')
is('github token', L.redactSecrets('ghp_abcdefghijklmnopqrstuvwxyz123456'), '[hidden]')
is('bearer', L.redactSecrets('Authorization: Bearer abcdefghijklmnop1234'), 'Authorization: Bearer [hidden]')
is('NAME=value', L.redactSecrets('DASHBOARD_TOKEN=s3cr3tvalue99'), 'DASHBOARD_TOKEN=[hidden]')
is('NAME: value', L.redactSecrets('REPORT_TOKEN: a1b2c3d4e5f6g7h8i9j0'), 'REPORT_TOKEN: [hidden]')
is('a variable named, no value, stays', L.redactSecrets('Paste DASHBOARD_TOKEN in Vercel'), 'Paste DASHBOARD_TOKEN in Vercel')
is('prose after a colon stays', L.redactSecrets('REPORT_TOKEN: the one in the cloud settings'), 'REPORT_TOKEN: the one in the cloud settings')
is('password', L.redactSecrets('the app password is abcd-efgh-ijkl'), 'the app password is [hidden]')
is('database url', L.redactSecrets('postgresql://neondb_owner:pa55word@ep-x.neon.tech/db'), 'postgresql://neondb_owner:[hidden]@ep-x.neon.tech/db')
is('plain words untouched', L.redactSecrets('Mug has no ambassador program'), 'Mug has no ambassador program')
is('a LinkedIn link untouched', L.redactSecrets('linkedin.com/in/ACwAAA123abcDEF456ghi789'), 'linkedin.com/in/ACwAAA123abcDEF456ghi789')

// Titles
is('given title wins', L.chatTitle('DAILY REVIEW CHAT', 'i usually use more than 4 chats'), 'DAILY REVIEW CHAT')
is('first ask when no title', L.chatTitle('', 'why do brands come back after I dismiss them?\nmore text'), 'why do brands come back after I dismiss them?')
is('long first ask cut', L.chatTitle(null, 'a'.repeat(120)).length, 80)
is('fallback', L.chatTitle('', ''), 'Claude chat')

// The question a reply ends on
const mug = `Mug doesn't have an ambassador program.

**NEED: Mug's people on the dashboard**
1. On LinkedIn, search people at PepsiCo.
2. Click **Send to dashboard**.

Want me to write the pitch message and the one-page "Campus Dawgs" idea next?

Sources:
- [PepsiCo: launch](https://www.pepsico.com/a)
- [BevNET](https://www.bevnet.com/b)`
is('question before Sources', L.lastQuestion(mug), 'Want me to write the pitch message and the one-page "Campus Dawgs" idea next?')
is('no question', L.lastQuestion('Pushed to main. The build is green.'), null)
is('a question mid-reply is not the end', L.lastQuestion('Should it? Yes.\n\nDone — live now.'), null)
is('last sentence only', L.lastQuestion('All three are fixed. Do you want the same on Stock take?'), 'Do you want the same on Stock take?')

// Digest of a reply
const d = L.digestReply(mug)
is('done line kept (first line is not a title)', d.done[0], "Mug doesn't have an ambassador program.")
is('NEED block', d.needs.map(n => n.label), ["Mug's people on the dashboard"])
is('NEED steps', d.needs[0].steps.length, 2)
is('question', d.question, 'Want me to write the pitch message and the one-page "Campus Dawgs" idea next?')
is('Sources list left out', d.done.some(x => /pepsico\.com|bevnet/i.test(x)), false)
is('the question is not a done line', d.done.some(x => /Campus Dawgs/.test(x)), false)
const after = L.digestReply('Fixed it.\n\n**NEED: Paste the key**\n1. Open Vercel\n2. Paste it\n\nThe build is green now.')
is('a paragraph after a NEED is not a step', [after.needs[0].steps.length, after.done.includes('The build is green now.')], [2, true])
is('one-line reply is what it did', L.digestReply('Done — pushed to main.').done, ['Done — pushed to main.'])
is('secret in a reply hidden', L.digestReply('Set it: DASHBOARD_TOKEN=abc123secret').done[0], 'Set it: DASHBOARD_TOKEN=[hidden]')

// A summary from the hourly review
const s = L.digestSummary({ did: ['Fixed **Discover** re-adding dismissed brands', ''], needs: [{ label: 'NEED: nothing', steps: ['a', 'b'] }, 'Pick a day'], question: 'Ship it?' })
is('summary did', s.done, ['Fixed Discover re-adding dismissed brands'])
is('summary needs', s.needs.map(n => n.label), ['NEED: nothing', 'Pick a day'])
is('summary steps', s.needs[0].steps, ['a', 'b'])
is('summary question', s.question, 'Ship it?')
is('summary empty', L.digestSummary({}), { done: [], needs: [], ideas: [], question: null })

// Ticks carry by the need's words
const oldN = [{ label: 'Paste the key in Vercel', steps: [] }, { label: 'Pick a page', steps: [] }]
const newN = [{ label: 'Pick a page', steps: [] }, { label: '**Paste the key in Vercel**', steps: ['x'] }, { label: 'New one', steps: [] }]
is('ticks follow the words', L.carryTicks(oldN, [0], newN), [1])
is('no ticks', L.carryTicks(oldN, [], newN), [])
is('nothing old', L.carryTicks([], [], newN), [])

// The day's messages
let asks = L.addAsk([], '2026-10-17T20:00:00Z', 'first thing')
asks = L.addAsk(asks, '2026-10-17T20:01:00Z', 'first thing')
is('same message twice is one', asks.length, 1)
asks = L.addAsk(asks, '2026-10-17T20:05:00Z', 'second   thing\nwith a line')
is('second message, one line', asks[1].ask, 'second thing with a line')
is('empty ignored', L.addAsk(asks, 'x', '  ').length, 2)
let many = []
for (let i = 0; i < 30; i++) many = L.addAsk(many, 't' + i, 'ask ' + i)
is('kept to the last 20', [many.length, many[0].ask], [20, 'ask 10'])
is('secret in an ask hidden', L.askLine('here: sk-ant-abcdefghijk123'), 'here: [hidden]')

// System messages are never Leo's asks
is('wake-up is machine', L.isMachineText('<task-notification> <task-type>queued</task-type>'), true)
is('subagent report is machine', L.isMachineText('  <agent-message from="x">'), true)
is('Leo’s words are not', L.isMachineText('why is <b> bold'), false)
is('askLine drops a wake-up', L.askLine('<task-notification>x</task-notification>'), '')
is('addAsk drops old wake-ups', L.addAsk([{ at: 't0', ask: '<task-notification> x' }], 't1', 'real ask').map(a => a.ask), ['real ask'])
is('no title from a wake-up', L.chatTitle('', '<task-notification> x'), 'Claude chat')

// Status
is('working', L.chatStatus(2, 'x?', true), 'working')
is('needs: open need', L.chatStatus(1, null, false), 'needs')
is('needs: question', L.chatStatus(0, 'Ship it?', false), 'needs')
is('done', L.chatStatus(0, null, false), 'done')
const now = new Date('2026-10-17T22:00:00Z')
is('stalled after 2h', L.isStalled('working', '2026-10-17T19:30:00Z', now), true)
is('not stalled yet', L.isStalled('working', '2026-10-17T21:00:00Z', now), false)
is('done never stalls', L.isStalled('done', '2026-10-17T10:00:00Z', now), false)

// A second ask the same day keeps the first answer's first line.
const E = L.EARLIER
is('first reply: nothing earlier', L.keepEarlier([], ['Added Carpe.']), ['Added Carpe.'])
is('a second answer keeps the first', L.keepEarlier(['Added Carpe.', 'mycarpe.com'], ['Added RAW.']), ['Added RAW.', E + 'Added Carpe.'])
is('older earlier lines follow, newest first', L.keepEarlier(['Added RAW.', E + 'Added Carpe.'], ['Added Snackish.']), ['Added Snackish.', E + 'Added RAW.', E + 'Added Carpe.'])
is('the same reply twice is kept once', L.keepEarlier(['Added RAW.', E + 'Added Carpe.'], ['Added RAW.']), ['Added RAW.', E + 'Added Carpe.'])
is('an earlier line the new answer already says is dropped', L.keepEarlier(['Primo Golf sponsors a LIV team.', E + 'Hunt started.'], ['Saved 16 finds.', 'Primo Golf sponsors a LIV team.']), ['Saved 16 finds.', 'Primo Golf sponsors a LIV team.', E + 'Hunt started.'])
is('an older earlier line said again is dropped', L.keepEarlier(['Added RAW.', E + 'Added Carpe.'], ['Added Snackish.', 'Added Carpe.']), ['Added Snackish.', 'Added Carpe.', E + 'Added RAW.'])
is('capped', L.keepEarlier(Array.from({ length: 12 }, (_, i) => E + 'x' + i), ['now']).length, 1 + L.CHAT_EARLIER_KEEP)
is('junk in, nothing kept', L.keepEarlier(null, ['now']), ['now'])

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
