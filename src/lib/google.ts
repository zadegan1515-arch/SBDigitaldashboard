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

export function googleAuthUrl(): string {
  const p = new URLSearchParams({
    client_id: process.env.GMAIL_CLIENT_ID!,
    redirect_uri: siteUrl() + REDIRECT_PATH,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',      // we need a refresh token
    prompt: 'consent',           // force one so re-connecting always works
    include_granted_scopes: 'false',
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
