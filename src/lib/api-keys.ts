// src/lib/api-keys.ts
//
// Keys for other tools (Leo, Nov 13 2026: "give me the backend for the
// command center so people can add things to it"; his picks: a key for
// another tool, anything on the site). A founding member makes a named key
// on Operations → Team; whoever holds it can call /api/data with
// `Authorization: Bearer sbk_…` — the same functions the site's buttons
// call — without signing in. Each key:
//   · is shown once, at the moment it's made; only its SHA-256 is stored
//     (Setting apiKeys), so nobody can read a key back out of the database;
//   · acts under its own name (handlers record `by` = the key's name);
//   · has every change it made listed on Team (Setting apiKeyLog, the last
//     40 per key), with one click to revoke it — revoked = refused at once;
//   · can never do the things that stay with a signed-in person
//     (keyBlocked below): who gets in, Google connections, sending email,
//     the ops mailbox, attendee records (CLAUDE.md rule 9).
// Paid AI calls are off for the whole site (NO_PAID_APIS), a key included.
//
// The shared DASHBOARD_TOKEN (Claude's own sessions) is unchanged and is
// not one of these keys.
//
// Rules pure here + the locked read/write of the two Settings.
// node scripts/test-api-keys.mjs

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { KEY_PREFIX, isKeyShaped } from './api-key-shape'

export const API_KEYS_KEY = 'apiKeys'
export const API_KEY_LOG_KEY = 'apiKeyLog'
export const MAX_ACTIVE_KEYS = 25
export const KEY_NAME_MAX = 40
// Revoked keys stay listed (with what they changed) this long.
export const REVOKED_KEEP_DAYS = 90
export const KEY_LOG_KEEP = 40
// A key that only reads: its "last used" is written at most this often.
export const TOUCH_EVERY_MS = 5 * 60 * 1000

export type ApiKeyRow = {
  id: string
  name: string
  hash: string          // sha256 of the whole key, hex
  tail: string          // its last 4 characters, to tell keys apart
  createdAt: string
  createdBy: string | null
  lastUsedAt: string | null
  changes: number       // writes it has made, ever
  revokedAt: string | null
  revokedBy: string | null
}
export type KeyLogLine = { at: string; fn: string; text: string }
export type KeyLog = Record<string, KeyLogLine[]>

// ---- making and checking ------------------------------------------------

export function newKey(): string {
  return KEY_PREFIX + randomBytes(32).toString('base64url')
}
export function hashKey(key: string): string {
  return createHash('sha256').update(String(key)).digest('hex')
}
function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length || !/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

// The live key this token is, or null (not key-shaped, unknown, revoked).
export function findKey(rows: ApiKeyRow[], presented: string): ApiKeyRow | null {
  if (!isKeyShaped(presented)) return null
  const h = hashKey(presented)
  let hit: ApiKeyRow | null = null
  // Every row is compared, so the time taken doesn't say which matched.
  for (const r of rows) if (sameHash(r.hash, h) && !r.revokedAt) hit = r
  return hit
}

// A name Leo will recognise on Team: "Maya", "Zapier — new brands".
export function cleanKeyName(name: unknown): { name: string | null; error: string | null } {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim()
  if (!n) return { name: null, error: 'Give the key a name — who or what it’s for.' }
  if (n.length > KEY_NAME_MAX) return { name: null, error: `Keep the name under ${KEY_NAME_MAX} characters.` }
  // "CLI" is how the site knows Claude's own token; a key never passes as it.
  if (/^(cli|claude)$/i.test(n)) return { name: null, error: 'That name is taken by Claude’s own access — pick another.' }
  if (/[<>]/.test(n)) return { name: null, error: 'Letters, numbers and plain punctuation only.' }
  return { name: n, error: null }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

// What's stored, read defensively (a hand-edited or older value never throws).
export function cleanKeys(v: unknown): ApiKeyRow[] {
  const list = Array.isArray(v) ? v : Array.isArray((v as any)?.keys) ? (v as any).keys : []
  const out: ApiKeyRow[] = []
  const seen = new Set<string>()
  for (const r of list) {
    if (!r || typeof r !== 'object') continue
    const id = str(r.id), name = str(r.name), hash = str(r.hash)
    if (!id || !name || !hash || !/^[0-9a-f]{64}$/.test(hash) || seen.has(id)) continue
    seen.add(id)
    out.push({
      id, name, hash,
      tail: str(r.tail) ?? '',
      createdAt: str(r.createdAt) ?? new Date(0).toISOString(),
      createdBy: str(r.createdBy),
      lastUsedAt: str(r.lastUsedAt),
      changes: Number.isFinite(r.changes) && r.changes > 0 ? Math.floor(r.changes) : 0,
      revokedAt: str(r.revokedAt),
      revokedBy: str(r.revokedBy),
    })
  }
  return out
}
export function cleanKeyLog(v: unknown): KeyLog {
  const out: KeyLog = {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [id, lines] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(lines)) continue
    const keep = lines.filter(l => l && typeof l === 'object' && typeof (l as any).at === 'string' && typeof (l as any).text === 'string')
      .map(l => ({ at: String((l as any).at), fn: String((l as any).fn ?? ''), text: String((l as any).text) }))
    if (keep.length) out[id] = keep.slice(-KEY_LOG_KEEP)
  }
  return out
}

export const activeKeys = (rows: ApiKeyRow[]) => rows.filter(r => !r.revokedAt)

// A new key's row + the key itself (the only time it exists in the clear).
export function mintKey(name: string, by: string | null, now = new Date()): { key: string; row: ApiKeyRow } {
  const key = newKey()
  return {
    key,
    row: {
      id: 'k' + now.getTime().toString(36) + randomBytes(4).toString('hex'),
      name, hash: hashKey(key), tail: key.slice(-4),
      createdAt: now.toISOString(), createdBy: by,
      lastUsedAt: null, changes: 0, revokedAt: null, revokedBy: null,
    },
  }
}

// Old revoked keys drop off the list (and their log with them).
export function pruneKeys(rows: ApiKeyRow[], log: KeyLog, now = new Date()): { rows: ApiKeyRow[]; log: KeyLog } {
  const cut = now.getTime() - REVOKED_KEEP_DAYS * 864e5
  const keep = rows.filter(r => !r.revokedAt || Date.parse(r.revokedAt) >= cut)
  const ids = new Set(keep.map(r => r.id))
  return { rows: keep, log: Object.fromEntries(Object.entries(log).filter(([id]) => ids.has(id))) }
}

// A read-only call: is it time to move "last used" on?
export function needsTouch(row: ApiKeyRow, now = new Date()): boolean {
  const last = row.lastUsedAt ? Date.parse(row.lastUsedAt) : 0
  return !last || now.getTime() - last >= TOUCH_EVERY_MS
}

// What Team shows: never the hash.
export function publicKey(row: ApiKeyRow, lines: KeyLogLine[] = []) {
  const { hash: _hash, ...rest } = row
  return { ...rest, log: lines.slice().reverse() }
}

// ---- what a key can never call -----------------------------------------
// These stay with a person signed in on the site. By name, plus by shape so
// a handler added later with one of these names is closed from its first day
// (the test lists every handler each rule catches).

const WHY = {
  access: 'Who and what gets access is decided by a signed-in person on the site — not with a key.',
  google: 'Google connections are managed by a signed-in person on the site — not with a key.',
  mail: 'A key never sends email.',
  ops: 'The operations mailbox isn’t open to keys.',
  attendees: 'Attendee records never leave the dashboard — a key gets event totals only (audienceEventStats, segmentsOverview).',
} as const

const BLOCKED: Record<string, keyof typeof WHY> = {
  // Who gets in.
  listTeam: 'access', addTeamEmail: 'access', removeTeamEmail: 'access', setRepAccount: 'access',
  createApiKey: 'access', revokeApiKey: 'access',
  // Show Board access for a brand, and which LinkedIn account the fill is locked to.
  approveAccessRequest: 'access', liOwnerReset: 'access',
  // Google.
  disconnectGoogle: 'google', disconnectDrive: 'google', disconnectOps: 'google',
  // Email (sending is off in code too — src/lib/no-send.ts).
  sendApprovedEmails: 'mail', sendEmailDraft: 'mail', sendTestEmail: 'mail', sendReplyEmail: 'mail',
  sendEventInvite: 'mail', approveAllDrafts: 'mail', setSendingPaused: 'mail',
  // The ops@ mailbox.
  scanOps: 'ops', listOps: 'ops', getOpsItem: 'ops', updateOpsItem: 'ops', deleteOpsItem: 'ops',
  replyOps: 'ops', forwardOps: 'ops', opsLinkOptions: 'ops', getOpsStatus: 'ops',
  // People who came to events (rule 9). listAudienceEvents carries each
  // event's door PIN, which opens its guest list.
  listAudienceEvents: 'attendees', saveAudienceEvent: 'attendees', deleteAudienceEvent: 'attendees',
  regenStaffPin: 'attendees', listAttendees: 'attendees', listDupCandidates: 'attendees',
  mergeAttendees: 'attendees', deleteAttendee: 'attendees', importAttendees: 'attendees',
}
const BLOCKED_SHAPES: Array<[RegExp, keyof typeof WHY]> = [
  [/ApiKey|TeamEmail|RepAccount/, 'access'],
  [/^disconnect[A-Z]/, 'google'],
  [/^send[A-Z]/, 'mail'],
  [/Ops(?:Item)?$/, 'ops'],
  [/Attendee|StaffPin/, 'attendees'],
]

// Why a key can't call this function, or null when it can.
export function keyBlocked(fn: string): string | null {
  const f = String(fn || '')
  const hit = BLOCKED[f] ?? BLOCKED_SHAPES.find(([re]) => re.test(f))?.[1]
  return hit ? WHY[hit] : null
}

// ---- the two Settings ---------------------------------------------------

type Db = {
  setting: { findUnique(args: any): Promise<{ value: string } | null>; upsert(args: any): Promise<any> }
  $transaction?: any
  $queryRaw?: any
}

// For the check on every key request: one read. A database error or a
// value that doesn't parse reads as "no keys" — the door stays shut.
export async function readKeys(db: Db): Promise<ApiKeyRow[]> {
  try {
    const row = await db.setting.findUnique({ where: { key: API_KEYS_KEY } })
    return cleanKeys(row ? JSON.parse(row.value) : [])
  } catch {
    return []
  }
}
export async function readKeyLog(db: Db): Promise<KeyLog> {
  try {
    const row = await db.setting.findUnique({ where: { key: API_KEY_LOG_KEY } })
    return cleanKeyLog(row ? JSON.parse(row.value) : {})
  } catch {
    return {}
  }
}

// Every change to the list or the log, one writer at a time, both read
// fresh inside the lock (the pattern of li-review's updateReviewState: two
// saves close together used to undo each other). A value that doesn't parse
// throws here rather than being written over.
export async function updateKeys<T>(db: Db, fn: (st: { rows: ApiKeyRow[]; log: KeyLog }) => T): Promise<T> {
  let out: T
  const work = async (tx: any) => {
    if (tx.$queryRaw) await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${API_KEYS_KEY}))::text`
    const [a, b] = [await tx.setting.findUnique({ where: { key: API_KEYS_KEY } }), await tx.setting.findUnique({ where: { key: API_KEY_LOG_KEY } })]
    const st = { rows: cleanKeys(a ? JSON.parse(a.value) : []), log: cleanKeyLog(b ? JSON.parse(b.value) : {}) }
    const r0 = JSON.stringify(st.rows), l0 = JSON.stringify(st.log)
    out = fn(st)
    const r1 = JSON.stringify(st.rows), l1 = JSON.stringify(st.log)
    if (r1 !== r0) await tx.setting.upsert({ where: { key: API_KEYS_KEY }, create: { key: API_KEYS_KEY, value: r1 }, update: { value: r1 } })
    if (l1 !== l0) await tx.setting.upsert({ where: { key: API_KEY_LOG_KEY }, create: { key: API_KEY_LOG_KEY, value: l1 }, update: { value: l1 } })
  }
  if (typeof db.$transaction === 'function') await db.$transaction(work, { maxWait: 10000, timeout: 20000 })
  else await work(db)
  return out!
}

// After a key's call: a change is logged under the key (and counted); a
// read only moves "last used" on, a few times an hour at most.
export async function noteKeyUse(db: Db, key: ApiKeyRow, fn: string, text: string | null, now = new Date()): Promise<void> {
  if (!text && !needsTouch(key, now)) return
  await updateKeys(db, st => {
    const row = st.rows.find(r => r.id === key.id)
    if (!row) return
    row.lastUsedAt = now.toISOString()
    if (!text) return
    row.changes += 1
    const lines = st.log[row.id] ?? []
    lines.push({ at: now.toISOString(), fn: String(fn).slice(0, 80), text: text.slice(0, 400) })
    st.log[row.id] = lines.slice(-KEY_LOG_KEEP)
  })
}
