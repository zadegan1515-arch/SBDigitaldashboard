// src/lib/google.ts
//
// Send-only Gmail access, by design.
//
// The app asks Google for exactly ONE scope — gmail.send — so it can send
// mail AS the connected user and is *physically incapable* of reading,
// searching, or deleting anything in that mailbox. That's enforced by
// Google, not by our good behaviour, and the owner can revoke it in one
// click at myaccount.google.com/permissions.
//
// This is why we don't use an app password: an app password is full
// IMAP/SMTP access to the whole mailbox, can't be scoped down, and never
// expires. SMTP+OAuth wouldn't help either — SMTP requires the broad
// mail.google.com scope — so sends go through the Gmail REST API instead.
//
// The refresh token lives in the app's own Postgres (Setting table),
// server-side only: never in the repo, never in a client bundle, never
// returned by any API this app exposes.
//
// Credentials are GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET — deliberately
// NOT the GOOGLE_* pair, which belongs to NextAuth's dashboard sign-in.
// Two separate OAuth clients, two separate jobs: clobbering the sign-in
// credentials would lock the team out of the site.

import { PrismaClient } from '@prisma/client'
import MailComposer from 'nodemailer/lib/mail-composer'

const prisma = new PrismaClient()

// Two scopes, both narrow, on the campaign mailbox only:
//   gmail.send     — send as that address; cannot read anything
//   gmail.readonly — read that mailbox so replies can be logged
// Note what is NOT here: mail.google.com (full account, what IMAP over
// OAuth would force) and any modify/delete scope. The app can read and
// send; it cannot alter or delete a single message. Revocable in one
// click at myaccount.google.com/permissions.
const SCOPE = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
].join(' ')
const REDIRECT_PATH = '/api/google/callback'

export function googleConfigured(): boolean {
  return !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET)
}

function siteUrl(): string {
  return process.env.SITE_URL || 'https://sb-digitaldashboard.vercel.app'
}

async function getSetting(key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } })
  return row?.value ?? null
}
async function setSetting(key: string, value: string) {
  await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

// ---- connect flow ----------------------------------------------

// Drive is a separate grant on a separate account (whoever owns the
// activation docs — Leo), so it gets its own scope and its own stored
// refresh token. drive.file = only files this app creates; it cannot see
// the rest of the Drive.
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

export function googleAuthUrl(kind: 'gmail' | 'drive' | 'ops' = 'gmail'): string {
  const p = new URLSearchParams({
    client_id: process.env.GMAIL_CLIENT_ID!,
    redirect_uri: siteUrl() + REDIRECT_PATH,
    response_type: 'code',
    // ops = the operations mailbox: same two narrow Gmail scopes as outreach.
    scope: kind === 'drive' ? DRIVE_SCOPE : SCOPE,
    access_type: 'offline',      // we need a refresh token
    prompt: 'consent',           // force one so re-connecting always works
    include_granted_scopes: 'false',
    state: kind,
  })
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString()
}

export async function googleExchangeCode(code: string) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GMAIL_CLIENT_ID!,
      client_secret: process.env.GMAIL_CLIENT_SECRET!,
      redirect_uri: siteUrl() + REDIRECT_PATH,
      grant_type: 'authorization_code',
    }),
  })
  const j: any = await res.json()
  if (!res.ok || !j.refresh_token) {
    throw new Error(j.error_description || j.error || 'Google did not return a refresh token')
  }
  // Whose mailbox did we just get? Ask Gmail for the profile address —
  // allowed under gmail.send, and it's the only thing we read.
  let address = ''
  try {
    const pr = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { Authorization: `Bearer ${j.access_token}` },
    })
    if (pr.ok) address = (await pr.json()).emailAddress ?? ''
  } catch {}

  await setSetting('googleRefreshToken', j.refresh_token)
  if (address) await setSetting('googleEmail', address)
  return { address }
}

export async function googleDisconnect() {
  const token = await getSetting('googleRefreshToken')
  if (token) {
    // Best-effort revoke so the grant disappears from their account too.
    try {
      await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(token), { method: 'POST' })
    } catch {}
  }
  await prisma.setting.deleteMany({ where: { key: { in: ['googleRefreshToken', 'googleEmail'] } } })
  return { ok: true }
}

// ---- status ----------------------------------------------------

export async function googleStatus() {
  const address = await getSetting('googleEmail')
  const connected = !!(await getSetting('googleRefreshToken'))
  return { configured: googleConfigured(), connected, address }
}

// ---- sending ---------------------------------------------------

async function accessToken(): Promise<string> {
  const refresh = await getSetting('googleRefreshToken')
  if (!refresh) throw new Error('No Google account connected')
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refresh,
      client_id: process.env.GMAIL_CLIENT_ID!,
      client_secret: process.env.GMAIL_CLIENT_SECRET!,
      grant_type: 'refresh_token',
    }),
  })
  const j: any = await res.json()
  if (!res.ok || !j.access_token) {
    throw new Error(
      /invalid_grant/.test(String(j.error))
        ? 'Google access was revoked or expired — reconnect the account on the Outreach page.'
        : (j.error_description || j.error || 'Could not refresh Google token')
    )
  }
  return j.access_token
}

export type OutgoingMail = {
  from: string
  to: string
  cc?: string[]
  subject: string
  text: string
  html?: string
  attachments?: Array<{ filename: string; content: Buffer }>
}

// Build a real MIME message (nodemailer does the hard part), then hand
// the raw bytes to Gmail. Same output SMTP would have produced.
function buildRaw(mail: OutgoingMail): Promise<string> {
  return new Promise((resolve, reject) => {
    new MailComposer({
      from: mail.from, to: mail.to,
      ...(mail.cc && mail.cc.length ? { cc: mail.cc } : {}),
      subject: mail.subject, text: mail.text,
      ...(mail.html ? { html: mail.html } : {}),
      ...(mail.attachments && mail.attachments.length ? { attachments: mail.attachments } : {}),
    }).compile().build((err: any, message: Buffer) => {
      if (err) return reject(err)
      resolve(message.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))
    })
  })
}

export async function sendViaGmail(mail: OutgoingMail) {
  const token = await accessToken()
  const raw = await buildRaw(mail)
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`Gmail API ${res.status}: ${t.slice(0, 200)}`)
  }
  return res.json()
}


// ---- reading replies -------------------------------------------------

// Gmail's REST API instead of IMAP: IMAP over OAuth requires the broad
// mail.google.com scope, which would hand over the whole account. This
// path stays inside gmail.readonly.
//
// Returns light metadata only — sender, subject, date. Message bodies
// are never fetched or stored; the dashboard only needs to know that a
// given contact replied.
export type ReplyMeta = { from: string; subject: string | null; date: Date }

export async function gmailListReplies(since: Date, max = 100): Promise<ReplyMeta[]> {
  const token = await accessToken()
  const d = since
  const q = `in:inbox after:${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`

  const listRes = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=' + max +
      '&q=' + encodeURIComponent(q),
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!listRes.ok) {
    const t = await listRes.text()
    throw new Error(`Gmail list ${listRes.status}: ${t.slice(0, 200)}`)
  }
  const list: any = await listRes.json()
  const ids: string[] = (list.messages ?? []).map((m: any) => m.id)
  if (!ids.length) return []

  const out: ReplyMeta[] = []
  // Sequential-ish in small batches: Gmail rate-limits hard on bursts,
  // and this runs once a day against a mailbox with light volume.
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10)
    const metas = await Promise.all(chunk.map(async id => {
      const r = await fetch(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages/' + id +
          '?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date',
        { headers: { Authorization: `Bearer ${token}` } },
      )
      if (!r.ok) return null
      const j: any = await r.json()
      const h: any[] = j.payload?.headers ?? []
      const get = (n: string) => h.find(x => String(x.name).toLowerCase() === n)?.value ?? null
      const fromRaw = get('from') ?? ''
      const m = fromRaw.match(/<([^>]+)>/)
      const from = (m ? m[1] : fromRaw).trim().toLowerCase()
      if (!from) return null
      return {
        from,
        subject: get('subject'),
        date: j.internalDate ? new Date(Number(j.internalDate)) : new Date(),
      } as ReplyMeta
    }))
    for (const m of metas) if (m) out.push(m)
  }
  return out
}


// A raw metadata scan of the connected mailbox, used by the warmup
// monitor. Same gmail.readonly scope as reply detection, same
// metadata-only discipline: sender, recipient, thread id, date. No
// message bodies are fetched or stored.
export type ScanMsg = {
  id: string; threadId: string
  from: string; to: string
  date: Date
}

function addr(raw: string): string {
  const m = String(raw || '').match(/<([^>]+)>/)
  return (m ? m[1] : String(raw || '')).trim().toLowerCase()
}

export async function gmailScan(query: string, max = 150): Promise<ScanMsg[]> {
  const token = await accessToken()
  const out: ScanMsg[] = []
  let pageToken: string | undefined

  while (out.length < max) {
    const url = 'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=' +
      Math.min(100, max - out.length) + '&q=' + encodeURIComponent(query) +
      (pageToken ? '&pageToken=' + pageToken : '')
    const listRes = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!listRes.ok) {
      const t = await listRes.text()
      throw new Error(`Gmail scan ${listRes.status}: ${t.slice(0, 200)}`)
    }
    const list: any = await listRes.json()
    const ids: string[] = (list.messages ?? []).map((m: any) => m.id)
    if (!ids.length) break

    for (let i = 0; i < ids.length; i += 10) {
      const metas = await Promise.all(ids.slice(i, i + 10).map(async id => {
        const r = await fetch(
          'https://gmail.googleapis.com/gmail/v1/users/me/messages/' + id +
            '?format=metadata&metadataHeaders=From&metadataHeaders=To',
          { headers: { Authorization: `Bearer ${token}` } },
        )
        if (!r.ok) return null
        const j: any = await r.json()
        const h: any[] = j.payload?.headers ?? []
        const get = (n: string) => h.find(x => String(x.name).toLowerCase() === n)?.value ?? ''
        return {
          id: j.id, threadId: j.threadId,
          from: addr(get('from')), to: addr(get('to')),
          date: j.internalDate ? new Date(Number(j.internalDate)) : new Date(),
        } as ScanMsg
      }))
      for (const m of metas) if (m) out.push(m)
    }

    pageToken = list.nextPageToken
    if (!pageToken) break
  }
  return out
}


// ---- Google Drive (activation working docs) ---------------------

export async function driveExchangeCode(code: string) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GMAIL_CLIENT_ID!,
      client_secret: process.env.GMAIL_CLIENT_SECRET!,
      redirect_uri: siteUrl() + REDIRECT_PATH,
      grant_type: 'authorization_code',
    }),
  })
  const j: any = await res.json()
  if (!res.ok || !j.refresh_token) {
    throw new Error(j.error_description || j.error || 'Google did not return a refresh token')
  }
  let address = ''
  try {
    const ab = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', {
      headers: { Authorization: `Bearer ${j.access_token}` },
    })
    if (ab.ok) address = (await ab.json()).user?.emailAddress ?? ''
  } catch {}
  await setSetting('driveRefreshToken', j.refresh_token)
  if (address) await setSetting('driveEmail', address)
  return { address }
}

export async function driveDisconnect() {
  const token = await getSetting('driveRefreshToken')
  if (token) {
    try { await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(token), { method: 'POST' }) } catch {}
  }
  await prisma.setting.deleteMany({ where: { key: { in: ['driveRefreshToken', 'driveEmail', 'driveRootFolderId'] } } })
  return { ok: true }
}

export async function driveStatus() {
  return {
    configured: googleConfigured(),
    connected: !!(await getSetting('driveRefreshToken')),
    address: await getSetting('driveEmail'),
  }
}

async function driveAccessToken(): Promise<string> {
  const refresh = await getSetting('driveRefreshToken')
  if (!refresh) throw new Error('Google Drive is not connected — click "Connect Google Drive" on the Activations page.')
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refresh,
      client_id: process.env.GMAIL_CLIENT_ID!,
      client_secret: process.env.GMAIL_CLIENT_SECRET!,
      grant_type: 'refresh_token',
    }),
  })
  const j: any = await res.json()
  if (!res.ok || !j.access_token) {
    throw new Error(/invalid_grant/.test(String(j.error))
      ? 'Google Drive access was revoked or expired — reconnect it on the Activations page.'
      : (j.error_description || j.error || 'Could not refresh Google Drive token'))
  }
  return j.access_token
}

async function gapi(token: string, url: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
  const text = await res.text()
  let j: any = {}
  try { j = text ? JSON.parse(text) : {} } catch { j = { raw: text } }
  if (!res.ok) {
    const msg = j?.error?.message || j?.error_description || j?.error || `HTTP ${res.status}`
    const hint = /has not been used|is disabled|accessNotConfigured/i.test(String(msg))
      ? ' — enable this API in the Google Cloud project (APIs & Services → Library).'
      : ''
    throw new Error(String(msg) + hint)
  }
  return j
}

const MIME = {
  folder: 'application/vnd.google-apps.folder',
  sheet: 'application/vnd.google-apps.spreadsheet',
  doc: 'application/vnd.google-apps.document',
}

async function driveCreate(token: string, name: string, mimeType: string, parentId?: string) {
  const body: any = { name, mimeType }
  if (parentId) body.parents = [parentId]
  return gapi(token, 'https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink', {
    method: 'POST', body: JSON.stringify(body),
  })
}

// One "SB Activations" folder for everything; remembered so we don't
// make a new one each time.
async function rootFolder(token: string): Promise<string> {
  const saved = await getSetting('driveRootFolderId')
  if (saved) {
    try {
      const f = await gapi(token, `https://www.googleapis.com/drive/v3/files/${saved}?fields=id,trashed`)
      if (f?.id && !f.trashed) return saved
    } catch {}
  }
  const f = await driveCreate(token, 'SB Activations', MIME.folder)
  await setSetting('driveRootFolderId', f.id)
  return f.id
}

export type SheetTab = { title: string; rows: (string | number | null)[][]; widths?: number[] }

// Creates <folder>/<name> with a Sheet and a Doc inside. Sheet tabs are
// filled through the Sheets API; the Doc gets a plain-text run sheet
// through the Docs API. Either fill failing (API not enabled yet) is
// reported as a warning — the files still exist and the links still work.
export async function driveCreateActivationDocs(opts: {
  name: string
  sheetTabs: SheetTab[]
  docText: string
}): Promise<{ folderId: string; folderUrl: string; sheetId: string; sheetUrl: string; docId: string; docUrl: string; warnings: string[] }> {
  const token = await driveAccessToken()
  const warnings: string[] = []
  const root = await rootFolder(token)
  const folder = await driveCreate(token, opts.name, MIME.folder, root)
  const sheet = await driveCreate(token, `${opts.name} — Budget`, MIME.sheet, folder.id)
  const doc = await driveCreate(token, `${opts.name} — Run of Show`, MIME.doc, folder.id)

  try {
    await sheetsFill(token, sheet.id, opts.sheetTabs)
  } catch (e: any) { warnings.push('Sheet created but not filled: ' + String(e?.message || e)) }
  try {
    await docsFill(token, doc.id, opts.docText)
  } catch (e: any) { warnings.push('Doc created but not filled: ' + String(e?.message || e)) }

  return {
    folderId: folder.id,
    folderUrl: `https://drive.google.com/drive/folders/${folder.id}`,
    sheetId: sheet.id,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${sheet.id}/edit`,
    docId: doc.id,
    docUrl: `https://docs.google.com/document/d/${doc.id}/edit`,
    warnings,
  }
}

async function sheetsFill(token: string, spreadsheetId: string, tabs: SheetTab[]) {
  if (!tabs.length) return
  // Rename the default first tab, add the rest.
  const meta = await gapi(token, `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets(properties(sheetId,title))`)
  const firstId = meta?.sheets?.[0]?.properties?.sheetId ?? 0
  const requests: any[] = [
    { updateSheetProperties: { properties: { sheetId: firstId, title: tabs[0].title }, fields: 'title' } },
  ]
  tabs.slice(1).forEach((t, i) => requests.push({ addSheet: { properties: { title: t.title, index: i + 1 } } }))
  await gapi(token, `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: 'POST', body: JSON.stringify({ requests }),
  })
  const data = tabs.map((t) => ({ range: `'${t.title.replace(/'/g, "''")}'!A1`, values: t.rows }))
  await gapi(token, `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`, {
    method: 'POST', body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
  })
  // Bold header rows, freeze them, size columns.
  const meta2 = await gapi(token, `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets(properties(sheetId,title))`)
  const fmt: any[] = []
  for (const sh of meta2.sheets || []) {
    const t = tabs.find((x) => x.title === sh.properties.title)
    if (!t) continue
    const sid = sh.properties.sheetId
    fmt.push({ repeatCell: { range: { sheetId: sid, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } })
    fmt.push({ updateSheetProperties: { properties: { sheetId: sid, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } })
    ;(t.widths || []).forEach((w, i) => fmt.push({ updateDimensionProperties: { range: { sheetId: sid, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 }, properties: { pixelSize: w }, fields: 'pixelSize' } }))
  }
  if (fmt.length) await gapi(token, `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: 'POST', body: JSON.stringify({ requests: fmt }),
  })
}

async function docsFill(token: string, documentId: string, text: string) {
  if (!text) return
  await gapi(token, `https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text } }] }),
  })
}


// ---- Operations mailbox (ops@) ---------------------------------------
//
// A second Gmail grant, stored under its own keys, same two scopes as the
// outreach mailbox (send + readonly). Everything below reads with
// gmail.readonly and sends with gmail.send; nothing can modify or delete
// mail in that box.

export async function opsExchangeCode(code: string) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GMAIL_CLIENT_ID!,
      client_secret: process.env.GMAIL_CLIENT_SECRET!,
      redirect_uri: siteUrl() + REDIRECT_PATH,
      grant_type: 'authorization_code',
    }),
  })
  const j: any = await res.json()
  if (!res.ok || !j.refresh_token) throw new Error(j.error_description || j.error || 'Google did not return a refresh token')
  let address = ''
  try {
    const pr = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${j.access_token}` } })
    if (pr.ok) address = (await pr.json()).emailAddress ?? ''
  } catch {}
  await setSetting('opsRefreshToken', j.refresh_token)
  if (address) await setSetting('opsEmail', address)
  return { address }
}

export async function opsDisconnect() {
  const token = await getSetting('opsRefreshToken')
  if (token) { try { await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(token), { method: 'POST' }) } catch {} }
  await prisma.setting.deleteMany({ where: { key: { in: ['opsRefreshToken', 'opsEmail', 'opsLastScanAt'] } } })
  return { ok: true }
}

export async function opsStatus() {
  return {
    configured: googleConfigured(),
    connected: !!(await getSetting('opsRefreshToken')),
    address: await getSetting('opsEmail'),
    lastScanAt: await getSetting('opsLastScanAt'),
  }
}

async function opsAccessToken(): Promise<string> {
  const refresh = await getSetting('opsRefreshToken')
  if (!refresh) throw new Error('Ops mailbox is not connected — click "Connect ops@" on the Operations page.')
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refresh,
      client_id: process.env.GMAIL_CLIENT_ID!,
      client_secret: process.env.GMAIL_CLIENT_SECRET!,
      grant_type: 'refresh_token',
    }),
  })
  const j: any = await res.json()
  if (!res.ok || !j.access_token) {
    throw new Error(/invalid_grant/.test(String(j.error))
      ? 'Ops mailbox access was revoked or expired — reconnect it on the Operations page.'
      : (j.error_description || j.error || 'Could not refresh ops token'))
  }
  return j.access_token
}

async function gm(token: string, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path, {
    ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
  if (!res.ok) { const t = await res.text(); throw new Error(`Gmail ${res.status}: ${t.slice(0, 200)}`) }
  return res.json()
}

export type OpsAttachment = { id: string; filename: string; mimeType: string; size: number }
export type OpsMail = {
  id: string; threadId: string
  fromName: string | null; fromEmail: string; toEmail: string | null
  subject: string; snippet: string; body: string; date: Date
  attachments: OpsAttachment[]
  labels: string[]
}

function b64url(s: string): string {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}
function parseFrom(raw: string): { name: string | null; email: string } {
  const m = String(raw || '').match(/^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>\s*$/)
  if (m) return { name: (m[1] || '').trim() || null, email: m[2].trim().toLowerCase() }
  return { name: null, email: String(raw || '').trim().toLowerCase() }
}
// Walk the MIME tree: collect text/plain (fallback: stripped text/html)
// and every part that has a filename + attachmentId.
function walkParts(payload: any, acc: { text: string[]; html: string[]; att: OpsAttachment[] }) {
  if (!payload) return
  const mime = String(payload.mimeType || '')
  const fname = payload.filename ? String(payload.filename) : ''
  if (fname && payload.body?.attachmentId) {
    acc.att.push({ id: payload.body.attachmentId, filename: fname, mimeType: mime, size: Number(payload.body.size || 0) })
  } else if (mime === 'text/plain' && payload.body?.data) {
    acc.text.push(b64url(payload.body.data))
  } else if (mime === 'text/html' && payload.body?.data) {
    acc.html.push(b64url(payload.body.data))
  }
  for (const p of payload.parts || []) walkParts(p, acc)
}
function htmlToText(h: string): string {
  return h.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

export async function opsGetMessage(id: string): Promise<OpsMail> {
  const token = await opsAccessToken()
  const j = await gm(token, 'messages/' + id + '?format=full')
  const h: any[] = j.payload?.headers ?? []
  const get = (n: string) => h.find(x => String(x.name).toLowerCase() === n)?.value ?? ''
  const acc = { text: [] as string[], html: [] as string[], att: [] as OpsAttachment[] }
  walkParts(j.payload, acc)
  const body = (acc.text.join('\n').trim() || htmlToText(acc.html.join('\n'))).slice(0, 20000)
  const from = parseFrom(get('from'))
  return {
    id: j.id, threadId: j.threadId,
    fromName: from.name, fromEmail: from.email, toEmail: parseFrom(get('to')).email || null,
    subject: get('subject') || '(no subject)', snippet: String(j.snippet || ''), body,
    date: j.internalDate ? new Date(Number(j.internalDate)) : new Date(),
    attachments: acc.att, labels: j.labelIds || [],
  }
}

// Ids of messages matching a query, newest first, up to max.
export async function opsListIds(query: string, max = 300): Promise<string[]> {
  const token = await opsAccessToken()
  const ids: string[] = []
  let pageToken: string | undefined
  while (ids.length < max) {
    const j = await gm(token, 'messages?maxResults=' + Math.min(100, max - ids.length) + '&q=' + encodeURIComponent(query) + (pageToken ? '&pageToken=' + pageToken : ''))
    for (const m of j.messages ?? []) ids.push(m.id)
    pageToken = j.nextPageToken
    if (!pageToken || !(j.messages ?? []).length) break
  }
  return ids
}

export async function opsGetAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
  const token = await opsAccessToken()
  const j = await gm(token, 'messages/' + messageId + '/attachments/' + attachmentId)
  return Buffer.from(String(j.data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

// Send from the ops mailbox. inReplyTo/threadId keep replies in the thread.
export async function opsSend(mail: OutgoingMail & { threadId?: string; inReplyTo?: string }) {
  const token = await opsAccessToken()
  const raw = await new Promise<string>((resolve, reject) => {
    new MailComposer({
      from: mail.from, to: mail.to,
      ...(mail.cc && mail.cc.length ? { cc: mail.cc } : {}),
      subject: mail.subject, text: mail.text,
      ...(mail.html ? { html: mail.html } : {}),
      ...(mail.attachments && mail.attachments.length ? { attachments: mail.attachments } : {}),
      ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo, references: mail.inReplyTo } : {}),
    }).compile().build((err: any, message: Buffer) => {
      if (err) return reject(err)
      resolve(message.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))
    })
  })
  return gm(token, 'messages/send', { method: 'POST', body: JSON.stringify({ raw, ...(mail.threadId ? { threadId: mail.threadId } : {}) }) })
}

// Message-ID header, needed for a threaded reply.
export async function opsMessageIdHeader(id: string): Promise<string | null> {
  const token = await opsAccessToken()
  const j = await gm(token, 'messages/' + id + '?format=metadata&metadataHeaders=Message-ID')
  const h: any[] = j.payload?.headers ?? []
  return h.find(x => String(x.name).toLowerCase() === 'message-id')?.value ?? null
}

export async function opsSetLastScan(iso: string) { await setSetting('opsLastScanAt', iso) }
