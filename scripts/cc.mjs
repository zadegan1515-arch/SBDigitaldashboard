#!/usr/bin/env node
// Call any Command Center function from the terminal (or from Claude Code).
//
//   node scripts/cc.mjs getWarmupStatus '{"days":14}'
//   node scripts/cc.mjs listOps '{"status":"open"}'
//   node scripts/cc.mjs scanOps
//   node scripts/cc.mjs getEmailStatus
//   node scripts/cc.mjs chatLog @/tmp/chat.json     # args from a JSON file (long text, no quoting)
//
// Needs DASHBOARD_TOKEN in the environment (or in .env.local). The same
// value must be set in Vercel. Never print it, never commit it.
//
// In a Claude cloud session the key can instead be saved once in the
// environment's settings (a paste box; header X-Dashboard-Token): the
// session's proxy adds it to every request for the dashboard — but only to
// requests that go through it, which Node's fetch doesn't by itself. So with
// a proxy set this runs itself again with NODE_USE_ENV_PROXY=1 (Node 22.21+;
// an older Node ignores it and calls as before).
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const viaProxy = !!(process.env.HTTPS_PROXY || process.env.https_proxy)
if (viaProxy && process.env.NODE_USE_ENV_PROXY !== '1') {
  const r = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1' } })
  process.exit(r.status ?? 1)
}

const fn = process.argv[2]
const argText = process.argv[3]
const args = !argText ? {} : JSON.parse(argText.startsWith('@') ? fs.readFileSync(argText.slice(1), 'utf8') : argText)
if (!fn) { console.error('usage: node scripts/cc.mjs <fn> [jsonArgs]'); process.exit(2) }

let token = process.env.DASHBOARD_TOKEN
if (!token) {
  for (const f of ['.env.local', '.env']) {
    const p = path.join(process.cwd(), f)
    if (fs.existsSync(p)) {
      const m = fs.readFileSync(p, 'utf8').match(/^DASHBOARD_TOKEN=(.+)$/m)
      if (m) { token = m[1].trim().replace(/^["']|["']$/g, ''); break }
    }
  }
}
// No variable, but a session proxy: the key saved in the environment's
// settings is the token (the proxy adds it; this placeholder opens nothing).
if (!token && viaProxy) token = 'saved-in-environment'
if (!token) { console.error('DASHBOARD_TOKEN is not set (env or .env.local)'); process.exit(2) }

const base = process.env.SITE_URL || 'https://sb-digitaldashboard.vercel.app'
const res = await fetch(base + '/api/data', {
  method: 'POST',
  redirect: 'manual',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ fn, args }),
})
// Turned away at the gate = sent to the sign-in page (it used to read "HTTP 405").
if (res.status >= 300 && res.status < 400) {
  console.error('The dashboard turned the token away — DASHBOARD_TOKEN here (or the key saved in this environment\'s settings) is not the one in Vercel.')
  process.exit(1)
}
const text = await res.text()
let j
try { j = JSON.parse(text) } catch { console.error(`HTTP ${res.status}: ${text.slice(0, 300)}`); process.exit(1) }
if (!res.ok || j.ok === false) { console.error('error:', j.error || res.status); process.exit(1) }
console.log(JSON.stringify(j.data, null, 2))
