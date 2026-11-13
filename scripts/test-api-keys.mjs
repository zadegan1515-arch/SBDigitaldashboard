// node scripts/test-api-keys.mjs — keys for other tools (src/lib/api-keys.ts,
// api-key-shape.ts, api-guide.ts): what a key looks like, that only its hash
// is kept, a revoked key never matches, what a key can never call (checked
// against every handler in /api/data), the log, and that every function the
// instructions name exists and is open to a key.
import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const out = mkdtempSync(join(tmpdir(), 'api-keys-test-'))
execSync('npx tsc src/lib/api-keys.ts src/lib/api-guide.ts --outDir ' + out + ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck --types node', { stdio: 'inherit' })
for (const f of readdirSync(out).filter(f => f.endsWith('.js'))) {
  const p = join(out, f)
  writeFileSync(p, readFileSync(p, 'utf8').replace(/from '(\.\/[^']+)'/g, "from '$1.js'"))
}
const K = await import(pathToFileURL(join(out, 'api-keys.js')).href)
const S = await import(pathToFileURL(join(out, 'api-key-shape.js')).href)
const G = await import(pathToFileURL(join(out, 'api-guide.js')).href)

let n = 0
function t(name, fn) { fn(); n++; console.log('  ok — ' + name) }
async function ta(name, fn) { await fn(); n++; console.log('  ok — ' + name) }

// Every function /api/data answers to.
const route = readFileSync('src/app/api/data/route.ts', 'utf8')
const FNS = [...new Set([...route.matchAll(/^  (?:async )?([A-Za-z][A-Za-z0-9]*)\([^\n]*\{/gm)].map(m => m[1]))]
assert.ok(FNS.length > 300, 'read the handlers (' + FNS.length + ')')

t('a key is sbk_ + 43 characters, and a new one every time', () => {
  const a = K.newKey(), b = K.newKey()
  assert.match(a, /^sbk_[A-Za-z0-9_-]{43}$/)
  assert.notEqual(a, b)
  assert.ok(S.isKeyShaped(a))
  for (const bad of ['', 'sbk_', 'sbk_short', a + 'x', a.slice(0, -1), 'xbk_' + a.slice(4), a.replace(/.$/, '!'), null, 42]) assert.equal(S.isKeyShaped(bad), false, String(bad))
})

t('the Authorization header: only "Bearer <token>"', () => {
  assert.equal(S.bearerOf('Bearer abc'), 'abc')
  assert.equal(S.bearerOf('Bearer  abc'), 'abc')
  for (const h of [null, undefined, '', 'abc', 'Basic abc', 'Bearer', 'Bearer a b', 'bearer abc']) assert.equal(S.bearerOf(h), '', String(h))
})

t('only the hash is kept; the key itself is found by it', () => {
  const { key, row } = K.mintKey('Maya', 'leo@sb.test', new Date('2026-11-13T15:00:00Z'))
  assert.equal(row.hash, K.hashKey(key))
  assert.match(row.hash, /^[0-9a-f]{64}$/)
  assert.ok(!JSON.stringify(row).includes(key), 'the row never holds the key')
  assert.equal(row.tail, key.slice(-4))
  assert.equal(row.name, 'Maya'); assert.equal(row.createdBy, 'leo@sb.test'); assert.equal(row.changes, 0)
  assert.equal(K.findKey([row], key)?.id, row.id)
  assert.equal(K.findKey([row], K.newKey()), null, 'another key')
  assert.equal(K.findKey([row], row.hash), null, 'the hash is not a key')
  assert.equal(K.findKey([], key), null)
  // What Team gets: no hash.
  const pub = K.publicKey(row, [{ at: 'a', fn: 'f', text: 'one' }, { at: 'b', fn: 'f', text: 'two' }])
  assert.ok(!('hash' in pub)); assert.deepEqual(pub.log.map(l => l.text), ['two', 'one'])
})

t('a revoked key never matches again', () => {
  const { key, row } = K.mintKey('Maya', null)
  const other = K.mintKey('Zapier', null)
  assert.equal(K.findKey([row, other.row], key)?.name, 'Maya')
  row.revokedAt = new Date().toISOString()
  assert.equal(K.findKey([row, other.row], key), null)
  assert.equal(K.findKey([row, other.row], other.key)?.name, 'Zapier')
  assert.deepEqual(K.activeKeys([row, other.row]).map(r => r.name), ['Zapier'])
})

t('names: something Leo will recognise, never Claude\'s own', () => {
  assert.equal(K.cleanKeyName('  Maya   R ').name, 'Maya R')
  assert.equal(K.cleanKeyName('Zapier — new brands').name, 'Zapier — new brands')
  for (const bad of ['', '   ', null, 'CLI', 'cli', 'Claude', 'x'.repeat(41), '<b>hi</b>']) {
    const r = K.cleanKeyName(bad)
    assert.equal(r.name, null, String(bad)); assert.ok(r.error)
  }
  assert.equal(K.cleanKeyName('Maya’s Claude').name, 'Maya’s Claude')
})

t('what\'s stored is read defensively', () => {
  const { row } = K.mintKey('Maya', null)
  assert.deepEqual(K.cleanKeys([row]), [row])
  assert.deepEqual(K.cleanKeys({ keys: [row] }), [row])
  for (const junk of [null, 'x', 42, {}, [null, 1, {}, { id: 'a', name: 'b', hash: 'nope' }, { id: 'a', name: 'b' }]]) assert.deepEqual(K.cleanKeys(junk), [])
  assert.equal(K.cleanKeys([row, row]).length, 1, 'one row per id')
  assert.deepEqual(K.cleanKeyLog(null), {})
  assert.deepEqual(K.cleanKeyLog({ a: 'x', b: [{ at: 't', text: 'ok', fn: 'f' }, { nope: 1 }] }), { b: [{ at: 't', fn: 'f', text: 'ok' }] })
})

t('revoked keys drop off the list after 90 days, their log with them', () => {
  const now = new Date('2026-11-13T15:00:00Z')
  const a = K.mintKey('Live', null).row, b = K.mintKey('Recent', null).row, c = K.mintKey('Old', null).row
  b.revokedAt = new Date(now.getTime() - 10 * 864e5).toISOString()
  c.revokedAt = new Date(now.getTime() - 91 * 864e5).toISOString()
  const r = K.pruneKeys([a, b, c], { [a.id]: [{ at: 'x', fn: 'f', text: 't' }], [c.id]: [{ at: 'x', fn: 'f', text: 't' }] }, now)
  assert.deepEqual(r.rows.map(x => x.name), ['Live', 'Recent'])
  assert.deepEqual(Object.keys(r.log), [a.id])
})

t('"last used" moves on a read only every few minutes', () => {
  const now = new Date('2026-11-13T15:00:00Z')
  const { row } = K.mintKey('Maya', null)
  assert.equal(K.needsTouch(row, now), true, 'never used')
  row.lastUsedAt = new Date(now.getTime() - 60e3).toISOString()
  assert.equal(K.needsTouch(row, now), false)
  row.lastUsedAt = new Date(now.getTime() - K.TOUCH_EVERY_MS).toISOString()
  assert.equal(K.needsTouch(row, now), true)
})

// The whole list a key can't call, checked against the real handlers: a
// handler renamed or added must be put on one side or the other on purpose.
const MUST_BLOCK = [
  // who gets in
  'listTeam', 'addTeamEmail', 'removeTeamEmail', 'setRepAccount', 'createApiKey', 'revokeApiKey', 'approveAccessRequest', 'liOwnerReset',
  // Google
  'disconnectGoogle', 'disconnectDrive', 'disconnectOps',
  // email
  'sendApprovedEmails', 'sendEmailDraft', 'sendTestEmail', 'sendReplyEmail', 'sendEventInvite', 'approveAllDrafts', 'setSendingPaused',
  // the ops mailbox
  'scanOps', 'listOps', 'getOpsItem', 'updateOpsItem', 'deleteOpsItem', 'replyOps', 'forwardOps', 'opsLinkOptions', 'getOpsStatus',
  // attendee records (rule 9)
  'listAudienceEvents', 'saveAudienceEvent', 'deleteAudienceEvent', 'regenStaffPin', 'listAttendees', 'listDupCandidates',
  'mergeAttendees', 'deleteAttendee', 'importAttendees',
]
t('what a key can never call — exactly this list, out of every handler', () => {
  for (const fn of MUST_BLOCK) assert.ok(FNS.includes(fn), fn + ' is a real handler')
  const blocked = FNS.filter(fn => K.keyBlocked(fn)).sort()
  assert.deepEqual(blocked, [...MUST_BLOCK].sort())
  for (const fn of MUST_BLOCK) assert.ok(K.keyBlocked(fn).length > 20, fn + ' says why')
})

t('a handler added later with one of those names is closed from day one', () => {
  for (const fn of ['sendSomethingNew', 'disconnectNotion', 'listAttendeeEmails', 'exportAttendees', 'rotateApiKey', 'archiveOps', 'setStaffPin']) assert.ok(K.keyBlocked(fn), fn)
  for (const fn of ['createBrand', 'upsertContact', 'addBrandNote', 'getBrand', 'search', 'sentByDay', 'sentByCompany', 'audienceEventStats', 'segmentsOverview', 'sponsorReport', 'whoAmI', 'apiGuide', 'getMe']) assert.equal(K.keyBlocked(fn), null, fn)
})

t('the instructions name only real functions a key may call', () => {
  for (const fn of G.GUIDE_FNS) {
    assert.ok(FNS.includes(fn), fn + ' is a real handler')
    assert.equal(K.keyBlocked(fn), null, fn + ' is open to a key')
  }
  const text = G.apiGuideText('https://example.test/', { dealStages: ['conversation', 'proposal', 'verbal', 'closed', 'lost'] })
  assert.match(text, /POST https:\/\/example\.test\/api\/data\n/)
  assert.match(text, /Authorization: Bearer <the key>/)
  for (const fn of G.GUIDE_FNS) assert.ok(new RegExp('\\b' + fn + '\\b').test(text), fn + ' is in the text')
  // Every function the text shows at the start of a line is on the list.
  const shown = [...text.matchAll(/^  ([a-z][A-Za-z]+) +\{/gm)].map(m => m[1])
  for (const fn of shown) assert.ok(G.GUIDE_FNS.includes(fn), fn + ' is listed in GUIDE_FNS')
  // The lists come from the code.
  for (const w of ['electrolytes', 'unresolved', 'call_booked', 'quiet', 'email_in', 'conversation | proposal | verbal | closed | lost', 'emerging | growth | established']) assert.ok(text.includes(w), w)
  assert.ok(!/sbk_[A-Za-z0-9_-]{20}/.test(text), 'no key in the instructions')
})

// The locked read/write, against a fake Setting table.
const fakeDb = () => {
  const store = new Map()
  const db = {
    store, locks: 0,
    setting: {
      findUnique: async ({ where }) => (store.has(where.key) ? { value: store.get(where.key) } : null),
      upsert: async ({ where, create }) => { store.set(where.key, create.value) },
    },
    $queryRaw: async () => { db.locks++ },
    $transaction: async (fn) => fn(db),
  }
  return db
}

await ta('a change is logged under its key and counted; a read only moves "last used"', async () => {
  const db = fakeDb()
  const made = await K.updateKeys(db, st => { const m = K.mintKey('Maya', 'leo@sb.test'); st.rows.push(m.row); return m })
  assert.equal(db.locks, 1)
  assert.ok(!db.store.get('apiKeys').includes(made.key), 'the key itself is never stored')
  let rows = await K.readKeys(db)
  assert.equal(K.findKey(rows, made.key)?.name, 'Maya')

  const t0 = new Date('2026-11-13T15:00:00Z')
  await K.noteKeyUse(db, rows[0], 'createBrand', 'Added Poppi', t0)
  rows = await K.readKeys(db)
  assert.equal(rows[0].changes, 1); assert.equal(rows[0].lastUsedAt, t0.toISOString())
  assert.deepEqual((await K.readKeyLog(db))[rows[0].id], [{ at: t0.toISOString(), fn: 'createBrand', text: 'Added Poppi' }])

  // A read a minute later: nothing written.
  const locks = db.locks
  await K.noteKeyUse(db, rows[0], 'getBrand', null, new Date(t0.getTime() + 60e3))
  assert.equal(db.locks, locks, 'no write for a read so soon')
  // A read ten minutes later: last used moves, no log line, no count.
  const t1 = new Date(t0.getTime() + 10 * 60e3)
  await K.noteKeyUse(db, rows[0], 'getBrand', null, t1)
  rows = await K.readKeys(db)
  assert.equal(rows[0].lastUsedAt, t1.toISOString()); assert.equal(rows[0].changes, 1)
  assert.equal((await K.readKeyLog(db))[rows[0].id].length, 1)

  // The log keeps the last 40; the count keeps going.
  for (let i = 0; i < 45; i++) await K.noteKeyUse(db, rows[0], 'addBrandNote', 'note ' + i, new Date(t1.getTime() + i * 1000))
  rows = await K.readKeys(db)
  const log = (await K.readKeyLog(db))[rows[0].id]
  assert.equal(rows[0].changes, 46); assert.equal(log.length, K.KEY_LOG_KEEP); assert.equal(log[log.length - 1].text, 'note 44')
})

await ta('a broken stored value shuts the door, and is never written over', async () => {
  const db = fakeDb()
  db.store.set('apiKeys', '{not json')
  assert.deepEqual(await K.readKeys(db), [])
  await assert.rejects(K.updateKeys(db, st => { st.rows.push(K.mintKey('x', null).row) }))
  assert.equal(db.store.get('apiKeys'), '{not json')
  const down = { setting: { findUnique: async () => { throw new Error('db down') }, upsert: async () => {} } }
  assert.deepEqual(await K.readKeys(down), [], 'database down = no keys')
})

// The gate: middleware lets a key-shaped request through to /api/data only,
// and /api/data checks it before anything runs.
t('the gate checks a key before any function runs', () => {
  const mw = readFileSync('src/middleware.ts', 'utf8')
  assert.match(mw, /if \(req\.nextUrl\.pathname !== '\/api\/data'\) return false[\s\S]*isKeyShaped\(bearerOf\(given\)\)/, 'key-shaped requests pass only on /api/data')
  assert.ok(!/node:crypto|api-keys'/.test(mw), 'middleware never imports the database side')
  const post = route.slice(route.indexOf('export async function POST'))
  const iFind = post.indexOf('findKey(await readKeys(prisma), bearer)')
  const iRefuse = post.indexOf("status: 401")
  const iBlocked = post.indexOf('keyBlocked(String(fn))')
  const iRun = post.indexOf('await handler(a)')
  assert.ok(iFind > 0 && iRefuse > iFind && iBlocked > iRefuse && iRun > iBlocked, 'find → 401 → blocked → run')
  // Making and revoking keys need a signed-in founding member.
  for (const fn of ['createApiKey', 'revokeApiKey']) {
    const body = route.slice(route.indexOf('  async ' + fn + '('), route.indexOf('  async ' + fn + '(') + 500)
    assert.match(body, /getServerSession\(authOptions\)[\s\S]*allowlist\(\)\.includes\(me\)/, fn + ' checks the session')
  }
})

console.log('api keys: ' + n + ' passed')
