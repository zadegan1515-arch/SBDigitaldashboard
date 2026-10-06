// scripts/test-no-send.mjs — Leo, Oct 6 2026: "no emails should be sent
// out". Fails if the switch in src/lib/no-send.ts is flipped, or if any
// code that can send mail (Gmail messages/send, SMTP sendMail) doesn't
// stop at assertSendingAllowed() first. Run: node scripts/test-no-send.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

let fail = 0
const bad = (m) => { fail++; console.log('✗', m) }

const sw = readFileSync('src/lib/no-send.ts', 'utf8')
if (!/export const EMAIL_SENDING_OFF = true\b/.test(sw)) bad('EMAIL_SENDING_OFF is not true — sending was turned back on')

// The three doors: each must check first thing.
const firstLine = (file, fn) => {
  const s = readFileSync(file, 'utf8')
  const m = s.match(new RegExp('function ' + fn + '\\([^)]*\\)[^{]*\\{\\s*([^\\n]*)'))
  if (!m) return bad(fn + ' not found in ' + file)
  if (!/assertSendingAllowed\(\)/.test(m[1])) bad(fn + ' (' + file + ') does not start with assertSendingAllowed()')
}
firstLine('src/lib/google.ts', 'sendViaGmail')
firstLine('src/lib/google.ts', 'opsSend')
firstLine('src/lib/email.ts', 'deliver')

// No other code sends mail around those doors.
const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f)
  return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|js|mjs)$/.test(f) ? [p] : []
})
for (const f of walk('src')) {
  const s = readFileSync(f, 'utf8')
  const sends = (s.match(/messages\/send|\.sendMail\(/g) || []).length
  if (!sends) continue
  const ok = f.endsWith('google.ts') ? sends === 2 : f.endsWith('email.ts') ? sends === 1 : false
  if (!ok) bad(f + ' sends mail outside the guarded doors (' + sends + ' call(s))')
}

console.log(fail ? fail + ' failed' : 'no-send: all doors closed')
process.exit(fail ? 1 : 0)
