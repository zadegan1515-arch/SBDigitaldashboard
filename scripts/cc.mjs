#!/usr/bin/env node
// Call any Command Center function from the terminal (or from Claude Code).
//
//   node scripts/cc.mjs getWarmupStatus '{"days":14}'
//   node scripts/cc.mjs listOps '{"status":"open"}'
//   node scripts/cc.mjs scanOps
//   node scripts/cc.mjs getEmailStatus
//
// Needs DASHBOARD_TOKEN in the environment (or in .env.local). The same
// value must be set in Vercel. Never print it, never commit it.
import fs from 'node:fs'
import path from 'node:path'

const fn = process.argv[2]
const args = process.argv[3] ? JSON.parse(process.argv[3]) : {}
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
if (!token) { console.error('DASHBOARD_TOKEN is not set (env or .env.local)'); process.exit(2) }

const base = process.env.SITE_URL || 'https://sb-digitaldashboard.vercel.app'
const res = await fetch(base + '/api/data', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ fn, args }),
})
const text = await res.text()
let j
try { j = JSON.parse(text) } catch { console.error(`HTTP ${res.status}: ${text.slice(0, 300)}`); process.exit(1) }
if (!res.ok || j.ok === false) { console.error('error:', j.error || res.status); process.exit(1) }
console.log(JSON.stringify(j.data, null, 2))
