// scripts/test-chat-log-hook.mjs — guards scripts/chat-log-hook.mjs (a Claude
// chat posting where it stands to Home → Your chats): what it reads from a
// transcript, the post for each hook, and the real script run as a hook —
// exits at once with nothing on stdout, posts in the background to a fake
// dashboard, says nothing without a token. Run: node scripts/test-chat-log-hook.mjs
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readTranscript, buildPost, promptText } from './chat-log-hook.mjs'

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'chat-log-hook.mjs')
let pass = 0, fail = 0
const is = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return }
  fail++; console.log('✗', label, '— got', JSON.stringify(got), 'want', JSON.stringify(want))
}

const row = (o) => JSON.stringify(o)
const user = (content, extra) => row({ type: 'user', message: { role: 'user', content }, ...extra })
const asst = (...blocks) => row({ type: 'assistant', message: { role: 'assistant', content: blocks } })
const transcript = [
  row({ type: 'queue-operation', operation: 'enqueue' }),
  user('<system-reminder>context</system-reminder>can you look into Mug root beer'),
  asst({ type: 'thinking', thinking: '…' }),
  asst({ type: 'text', text: 'Looking it up now.' }),
  asst({ type: 'tool_use', id: 't1', name: 'WebSearch', input: {} }),
  user([{ type: 'tool_result', tool_use_id: 't1', content: 'results' }]),
  asst({ type: 'text', text: 'Mug has no ambassador program.' }),
  row({ type: 'custom-title', customTitle: 'MUG' }),
  user('how do we pitch them?'),
  asst({ type: 'text', text: 'Checking the board.' }),
  asst({ type: 'tool_use', id: 't2', name: 'Bash', input: {} }),
  user([{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }]),
  row({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'a subagent' }] } }),
  asst({ type: 'text', text: 'Pitch "Campus Dawgs".' }),
  asst({ type: 'text', text: '**NEED: Mug’s people**\n1. Search PepsiCo' }),
  user('[Request interrupted by user]'),
  user('<command-name>/compact</command-name>', { isMeta: false }),
].join('\n')

const t = readTranscript(transcript)
is('first ask, reminders stripped', t.firstAsk, 'can you look into Mug root beer')
is('latest ask', t.lastAsk, 'how do we pitch them?')
is('Leo’s title', t.title, 'MUG')
is('latest reply = text after the last tool call', t.reply, 'Pitch "Campus Dawgs".\n\n**NEED: Mug’s people**\n1. Search PepsiCo')
is('empty transcript', readTranscript(''), { firstAsk: null, lastAsk: null, title: null, reply: null })
is('a broken line is skipped', readTranscript('{bad\n' + user('hi')).firstAsk, 'hi')
is('tool result is not a prompt', promptText(JSON.parse(user([{ type: 'tool_result', content: 'x' }]))), null)
is('meta row is not a prompt', promptText(JSON.parse(user('x', { isMeta: true }))), null)

const env = { CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_01HfnTwnbPnSCv3BvLWgsbiJ' }
const p1 = buildPost({ hook_event_name: 'UserPromptSubmit', prompt: 'how do we pitch them?' }, env, t)
is('prompt post', [p1.event, p1.session, p1.ask, p1.title, p1.firstAsk], ['prompt', 'cse_01HfnTwnbPnSCv3BvLWgsbiJ', 'how do we pitch them?', 'MUG', 'can you look into Mug root beer'])
const p2 = buildPost({ hook_event_name: 'Stop', session_id: 'local-1234' }, env, t)
is('reply post from the transcript', [p2.event, p2.reply.startsWith('Pitch')], ['reply', true])
is('reply post prefers the hook’s own copy', buildPost({ hook_event_name: 'Stop', last_assistant_message: 'Done.' }, env, t).reply, 'Done.')
const p3 = buildPost({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Hourly or daily?' }, { question: 'Which tile?' }] } }, env, t)
is('question post', [p3.event, p3.question], ['question', 'Hourly or daily? · Which tile?'])
is('plan approval is a question', buildPost({ hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: {} }, env, t).question, 'It has a plan ready — approve it?')
is('other tools say nothing', buildPost({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }, env, t), null)
is('local chat: its own id', buildPost({ hook_event_name: 'Stop', session_id: 'local-1234' }, {}, t).session, 'local-1234')
is('no id: nothing', buildPost({ hook_event_name: 'Stop' }, {}, t), null)
is('nothing to reply: nothing', buildPost({ hook_event_name: 'Stop' }, env, readTranscript('')), null)

// The real script as a hook, against a fake dashboard.
const got = []
const server = http.createServer((req, res) => {
  let b = ''
  req.on('data', d => { b += d }).on('end', () => {
    got.push({ auth: req.headers.authorization, body: JSON.parse(b || '{}') })
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"data":{}}')
  })
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const SITE = 'http://127.0.0.1:' + server.address().port
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatlog-hook-'))
const tp = path.join(dir, 't.jsonl')
fs.writeFileSync(tp, transcript)

function runHook(input, extraEnv) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const child = spawn(process.execPath, [HOOK], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, SITE_URL: SITE, ...extraEnv },
      cwd: dir, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('exit', (code) => resolve({ code, out, err, ms: Date.now() - t0 }))
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input))
  })
}
const waitFor = async (n, ms = 8000) => { const t0 = Date.now(); while (got.length < n && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 100)) }

const TOKEN = { DASHBOARD_TOKEN: 'test-token-not-real', CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_01HfnTwnbPnSCv3BvLWgsbiJ' }
let r = await runHook({ hook_event_name: 'UserPromptSubmit', prompt: 'how do we pitch them?', transcript_path: tp, cwd: dir }, TOKEN)
is('prompt hook: exit 0, nothing on stdout', [r.code, r.out, r.err], [0, '', ''])
is('prompt hook returns at once', r.ms < 1500, true)
await waitFor(1)
is('posted in the background', got.length, 1)
is('the post', [got[0]?.auth, got[0]?.body.fn, got[0]?.body.args.event, got[0]?.body.args.ask, got[0]?.body.args.title], ['Bearer test-token-not-real', 'chatLog', 'prompt', 'how do we pitch them?', 'MUG'])

r = await runHook({ hook_event_name: 'Stop', session_id: 'x', transcript_path: tp, cwd: dir }, TOKEN)
is('stop hook: exit 0, nothing on stdout', [r.code, r.out], [0, ''])
await waitFor(2)
is('reply posted from the transcript', [got[1]?.body.args.event, got[1]?.body.args.reply?.slice(0, 5)], ['reply', 'Pitch'])

const before = got.length
r = await runHook({ hook_event_name: 'Stop', transcript_path: tp, cwd: dir }, { CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_01HfnTwnbPnSCv3BvLWgsbiJ' })
is('no token: exit 0, quiet', [r.code, r.out, r.err], [0, '', ''])
r = await runHook('not json', TOKEN)
is('garbage in: exit 0, quiet', [r.code, r.out, r.err], [0, '', ''])
await new Promise(r2 => setTimeout(r2, 2500))
is('nothing posted for either', got.length, before)
is('no token anywhere in what it sent', JSON.stringify(got.map(g => g.body)).includes('test-token-not-real'), false)
is('its temp files are gone', fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('sb-chatlog-')).length, 0)

server.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
