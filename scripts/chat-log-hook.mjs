#!/usr/bin/env node
// scripts/chat-log-hook.mjs — a Claude chat posts where it stands to Home →
// Your chats (Leo, Oct 17 2026: "i sometimes forget what each one is about").
//
// Run by Claude Code's hooks (.claude/settings.json): when Leo sends a message
// (UserPromptSubmit → "prompt"), when the chat finishes a reply (Stop →
// "reply"), and when it asks him something in a picker (PreToolUse on
// AskUserQuestion / ExitPlanMode → "question"). It posts /api/data chatLog
// with DASHBOARD_TOKEN — the same call `node scripts/cc.mjs chatLog` makes.
//
// It never holds the chat up and never talks to it: it reads the hook's
// input, hands the post to a detached copy of itself and exits 0 with nothing
// on stdout (a UserPromptSubmit hook's stdout would land in the chat). No
// token, no network, a bad transcript: it gives up quietly. Never prints the
// token. No model call (rule 4). node scripts/test-chat-log-hook.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MAX_REPLY = 20000
const MAX_ASK = 2000

// Leo's own words in a user row: a typed prompt, not a tool result, a slash
// command's wrapper or the harness's reminders.
export function promptText(row) {
  if (!row || row.type !== 'user' || row.isMeta || row.isSidechain) return null
  const m = row.message
  if (!m || m.role !== 'user') return null
  let text = ''
  if (typeof m.content === 'string') text = m.content
  else if (Array.isArray(m.content)) {
    if (m.content.some(b => b && b.type === 'tool_result')) return null
    text = m.content.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n')
  }
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<(command-name|command-message|command-args|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g, '')
    .trim()
  if (!text || /^\[Request interrupted/.test(text) || /^Caveat: The messages below/.test(text)) return null
  return text
}

// What a transcript (Claude Code's .jsonl) says: the chat's first and latest
// message from Leo, the title he gave it, and its latest reply — the text it
// wrote after its last tool call since his latest message.
export function readTranscript(text) {
  const out = { firstAsk: null, lastAsk: null, title: null, reply: null }
  let texts = []
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (row.type === 'custom-title' && row.customTitle) { out.title = String(row.customTitle); continue }
    const ask = promptText(row)
    if (ask) {
      if (!out.firstAsk) out.firstAsk = ask
      out.lastAsk = ask
      texts = []
      continue
    }
    if (row.type !== 'assistant' || row.isSidechain || !row.message || !Array.isArray(row.message.content)) continue
    for (const b of row.message.content) {
      if (!b) continue
      if (b.type === 'tool_use') texts = []
      else if (b.type === 'text' && b.text && b.text.trim()) texts.push(b.text.trim())
    }
  }
  if (texts.length) out.reply = texts.join('\n\n')
  return out
}

function readTranscriptFile(p) {
  try { return p && fs.existsSync(p) ? readTranscript(fs.readFileSync(p, 'utf8')) : readTranscript('') } catch { return readTranscript('') }
}

const clip = (s, n) => (s ? String(s).slice(0, n) : null)

// The post for one hook call, or null when there's nothing to say.
export function buildPost(input, env, tr) {
  const ev = input && input.hook_event_name
  const session = env.CLAUDE_CODE_REMOTE_SESSION_ID || (input && input.session_id) || null
  if (!session) return null
  const base = { session, title: clip(tr.title, 200), firstAsk: clip(tr.firstAsk, MAX_ASK), at: new Date().toISOString() }
  if (ev === 'UserPromptSubmit') {
    const ask = input.prompt || tr.lastAsk
    return ask ? { ...base, event: 'prompt', ask: clip(ask, MAX_ASK), firstAsk: base.firstAsk || clip(ask, MAX_ASK) } : null
  }
  if (ev === 'Stop') {
    const reply = input.last_assistant_message || tr.reply
    return reply ? { ...base, event: 'reply', reply: clip(reply, MAX_REPLY) } : null
  }
  if (ev === 'PreToolUse') {
    const ti = input.tool_input || {}
    let q = null
    if (input.tool_name === 'AskUserQuestion') q = (Array.isArray(ti.questions) ? ti.questions : []).map(x => x && x.question).filter(Boolean).join(' · ')
    else if (input.tool_name === 'ExitPlanMode') q = 'It has a plan ready — approve it?'
    return q ? { ...base, event: 'question', question: clip(q, 600) } : null
  }
  return null
}

function token(env, cwd) {
  if (env.DASHBOARD_TOKEN) return env.DASHBOARD_TOKEN
  for (const f of ['.env.local', '.env']) {
    try {
      const m = fs.readFileSync(path.join(cwd, f), 'utf8').match(/^DASHBOARD_TOKEN=(.+)$/m)
      if (m) return m[1].trim().replace(/^["']|["']$/g, '')
    } catch { /* no file */ }
  }
  return null
}

async function send(file) {
  let job
  try { job = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return }
  try { fs.unlinkSync(file) } catch { /* gone */ }
  const { input, cwd } = job
  const env = process.env
  const tok = token(env, cwd || process.cwd())
  if (!tok) return
  // Stop: give the transcript a moment to take the reply's last lines.
  if (input.hook_event_name === 'Stop' && !input.last_assistant_message) await new Promise(r => setTimeout(r, 1500))
  const post = buildPost(input, env, readTranscriptFile(input.transcript_path))
  if (!post) return
  const base = env.SITE_URL || 'https://sb-digitaldashboard.vercel.app'
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(base + '/api/data', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok },
        body: JSON.stringify({ fn: 'chatLog', args: post }),
        signal: AbortSignal.timeout(20000),
      })
      if (res.ok || res.status < 500) return
    } catch { /* retry once */ }
    await new Promise(r => setTimeout(r, 3000))
  }
}

async function main() {
  if (process.argv[2] === '--send') return send(process.argv[3])
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  let input
  try { input = JSON.parse(raw) } catch { return }
  if (!input || typeof input !== 'object') return
  if (!token(process.env, input.cwd || process.cwd())) return
  const file = path.join(os.tmpdir(), 'sb-chatlog-' + process.pid + '-' + Date.now() + '.json')
  fs.writeFileSync(file, JSON.stringify({ input, cwd: input.cwd || process.cwd() }), { mode: 0o600 })
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--send', file], { detached: true, stdio: 'ignore', env: process.env })
  child.unref()
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => {}).finally(() => { if (process.argv[2] !== '--send') process.exit(0) })
}
