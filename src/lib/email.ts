// src/lib/email.ts
//
// The email outreach engine. Runs beside the LinkedIn queue, never through
// it: email sends don't touch LinkedIn statuses or its 10/day budget.
//
// Flow: draftDailyEmails() writes a personalized intro (or a 4-day
// follow-up) for the day's best targets who have a work email — capped by
// a deliverability ramp (10/day at first, +5 per week, ceiling 40). The
// drafts wait for a human: sendApprovedEmails() is wired to the morning
// "Send all" button. checkReplies() reads the inbox over IMAP and marks
// targets replied, which drops them into "Needs action today".
//
// The mailbox is whatever EMAIL_USER/EMAIL_APP_PASSWORD point at (a Gmail
// address + app password). Swapping in marketing@sboyagency.com later is
// changing those two env vars in Vercel — nothing here changes.

import { PrismaClient } from '@prisma/client'
import Anthropic from '@anthropic-ai/sdk'
import nodemailer from 'nodemailer'
import { ImapFlow } from 'imapflow'

const prisma = new PrismaClient()

// ---- config ----------------------------------------------------

const DAILY_START = 10       // day-one cap: warm the address up slowly
const DAILY_MAX = 40         // ceiling, even fully warmed
const RAMP_PER_WEEK = 5      // cap grows this much each week
const FOLLOWUP_AFTER_DAYS = 4
const WORK_TZ = 'America/New_York'

export function emailConfigured(): boolean {
  return !!(process.env.EMAIL_USER && process.env.EMAIL_APP_PASSWORD)
}
export function emailAddress(): string | null {
  return process.env.EMAIL_USER ?? null
}

function startOfLocalDay(): Date {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: WORK_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now).reduce((acc: any, p) => { acc[p.type] = p.value; return acc }, {})
  const asIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second)
  const offset = asIfUtc - now.getTime()
  const localMidnightAsIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day)
  return new Date(localMidnightAsIfUtc - offset)
}

async function getSetting(key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } })
  return row?.value ?? null
}
async function setSetting(key: string, value: string) {
  await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

// The ramp: starts the first day anything is drafted, grows weekly.
export async function currentDailyCap(): Promise<number> {
  let start = await getSetting('emailRampStart')
  if (!start) {
    start = new Date().toISOString()
    await setSetting('emailRampStart', start)
  }
  const weeks = Math.floor((Date.now() - new Date(start).getTime()) / (7 * 24 * 60 * 60 * 1000))
  return Math.min(DAILY_MAX, DAILY_START + weeks * RAMP_PER_WEEK)
}

// ---- Claude (same fallback dance as /api/data) -----------------

const DRAFT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'
const MODEL_FALLBACKS = ['claude-sonnet-5', 'claude-haiku-4-5']

async function askClaude(prompt: string, maxTokens: number): Promise<string> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const candidates = [DRAFT_MODEL, ...MODEL_FALLBACKS.filter(m => m !== DRAFT_MODEL)]
  let lastErr: any = null
  for (const model of candidates) {
    try {
      const res = await anthropic.messages.create({
        model, max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      })
      const block = res.content.find(b => b.type === 'text')
      return block && 'text' in block ? block.text : ''
    } catch (err: any) {
      lastErr = err
      if (!(err?.status === 404 || /model/i.test(err?.message ?? ''))) throw err
    }
  }
  throw lastErr ?? new Error('No usable Claude model')
}

function parseEmailJson(text: string): { subject: string; body: string } | null {
  try {
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) return null
    const j = JSON.parse(m[0])
    if (!j.subject || !j.body) return null
    return { subject: String(j.subject).slice(0, 150), body: String(j.body).slice(0, 3000) }
  } catch { return null }
}

// ---- drafting --------------------------------------------------

function introPrompt(t: any): string {
  return [
    `Write a cold outreach EMAIL for SB Agency, which books artists and DJs for US college fraternity and sorority events and sells brands sponsorship activations at those shows (sampling, banners, product seeding).`,
    `TO: ${t.contact.name}${t.contact.title ? `, ${t.contact.title}` : ''} at ${t.brand.name}${t.brand.category ? ` (${t.brand.category})` : ''}.`,
    t.brand.goals ? `WHAT THEY WANT (from discovery): ${t.brand.goals}` : ``,
    ``,
    `Rules: under 110 words. Plain text, no links, no bullet points, no placeholder brackets. Sound like a real person, not a newsletter. One specific hook about why ${t.brand.name} fits college shows, one concrete offer (get their product in front of thousands of students at live events), one easy ask (worth a quick call?). Sign off exactly:\nLeo\nSB Agency\n\nEnd the body with this exact line: "If this isn't relevant, just reply 'no thanks' and I won't follow up."`,
    ``,
    `Return ONLY JSON: {"subject": "...", "body": "..."} — subject under 8 words, lowercase-casual is fine, no clickbait.`,
  ].filter(Boolean).join('\n')
}

function followupPrompt(t: any, firstEmail: any): string {
  return [
    `Write a short FOLLOW-UP email (the first one got no reply) for SB Agency (books artists/DJs for college greek-life events; sells brands sponsorship at those shows).`,
    `TO: ${t.contact.name} at ${t.brand.name}.`,
    `FIRST EMAIL SUBJECT: ${firstEmail?.subject ?? ''}`,
    ``,
    `Rules: under 60 words, plain text. Friendly, zero pressure, adds one small new angle (timing, a specific school region, or momentum), then a soft ask. No guilt-tripping. Sign off exactly:\nLeo\nSB Agency`,
    ``,
    `Return ONLY JSON: {"subject": "...", "body": "..."} — subject should be "re:" + the first subject.`,
  ].join('\n')
}

// Drafts up to `limit` emails per call (Claude calls are slow; callers
// loop until done=true). Follow-ups first — momentum beats new names.
export async function draftDailyEmails(limit = 5) {
  if (!emailConfigured()) return { configured: false, drafted: 0, done: true }
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set — drafting is off.')

  const cap = await currentDailyCap()
  const sentToday = await prisma.emailMessage.count({
    where: { direction: 'out', status: 'sent', sentAt: { gte: startOfLocalDay() } },
  })
  const pendingDrafts = await prisma.emailMessage.count({
    where: { direction: 'out', status: 'draft' },
  })
  let room = Math.max(0, cap - sentToday - pendingDrafts)
  if (room === 0) return { configured: true, drafted: 0, done: true, cap, sentToday, pendingDrafts }

  let drafted = 0

  // 1. Follow-ups due: intro sent >= N days ago, no reply, no follow-up yet,
  //    target still in play.
  const cutoff = new Date(Date.now() - FOLLOWUP_AFTER_DAYS * 24 * 60 * 60 * 1000)
  const followCandidates = await prisma.target.findMany({
    where: {
      status: { notIn: ['replied', 'converted', 'declined', 'dead'] },
      emails: { some: { direction: 'out', kind: 'intro', status: 'sent', sentAt: { lte: cutoff } } },
    },
    include: {
      brand: true, contact: true,
      emails: { orderBy: { createdAt: 'asc' } },
    },
    take: 50,
  })
  for (const t of followCandidates) {
    if (drafted >= limit || room === 0) break
    const hasReply = t.emails.some(e => e.direction === 'in')
    const hasFollowup = t.emails.some(e => e.kind === 'followup')
    if (hasReply || hasFollowup || !t.contact.email) continue
    const intro = t.emails.find(e => e.kind === 'intro' && e.status === 'sent')
    const parsed = parseEmailJson(await askClaude(followupPrompt(t, intro), 500))
    if (!parsed) continue
    await prisma.emailMessage.create({
      data: {
        targetId: t.id, direction: 'out', kind: 'followup', status: 'draft',
        toEmail: t.contact.email, fromEmail: emailAddress(),
        subject: parsed.subject, body: parsed.body,
      },
    })
    drafted++; room--
  }

  // 2. Fresh intros: best-fit active targets with an email and no email
  //    history at all.
  if (drafted < limit && room > 0) {
    const fresh = await prisma.target.findMany({
      where: {
        status: { in: ['queued', 'drafted', 'sent'] },
        shelved: false,
        contact: { email: { not: null } },
        emails: { none: {} },
      },
      include: { brand: true, contact: true },
      orderBy: [{ fitScore: 'desc' }, { createdAt: 'asc' }],
      take: Math.min(limit - drafted, room),
    })
    for (const t of fresh) {
      const parsed = parseEmailJson(await askClaude(introPrompt(t), 600))
      if (!parsed) continue
      await prisma.emailMessage.create({
        data: {
          targetId: t.id, direction: 'out', kind: 'intro', status: 'draft',
          toEmail: t.contact.email, fromEmail: emailAddress(),
          subject: parsed.subject, body: parsed.body,
        },
      })
      drafted++; room--
    }
  }

  return { configured: true, drafted, done: room === 0 || drafted < limit, cap, sentToday }
}

// ---- sending ---------------------------------------------------

export async function sendApprovedEmails() {
  if (!emailConfigured()) return { configured: false, sent: 0, failed: 0 }

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_APP_PASSWORD },
  })

  const drafts = await prisma.emailMessage.findMany({
    where: { direction: 'out', status: 'draft' },
    include: { target: { include: { contact: true, brand: true } } },
    orderBy: { createdAt: 'asc' },
  })

  let sent = 0, failed = 0
  const errors: string[] = []
  for (const d of drafts) {
    const to = d.toEmail || d.target.contact.email
    if (!to) { failed++; continue }
    try {
      await transporter.sendMail({
        from: `Leo — SB Agency <${process.env.EMAIL_USER}>`,
        to,
        subject: d.subject ?? '',
        text: d.body ?? '',
      })
      await prisma.emailMessage.update({
        where: { id: d.id },
        data: { status: 'sent', sentAt: new Date(), toEmail: to, fromEmail: emailAddress() },
      })
      sent++
    } catch (err: any) {
      failed++
      if (errors.length < 5) errors.push(`${d.target.brand.name}: ${err?.message ?? 'send failed'}`)
      await prisma.emailMessage.update({
        where: { id: d.id },
        data: { status: 'failed', error: String(err?.message ?? 'send failed').slice(0, 300) },
      })
    }
  }
  return { configured: true, sent, failed, errors }
}

// ---- replies ---------------------------------------------------

// Reads the inbox over IMAP and matches senders against people we've
// emailed. A match marks the target replied (which surfaces it in
// "Needs action today") and stops any future follow-up to them.
export async function checkReplies() {
  if (!emailConfigured()) return { configured: false, replies: 0 }

  // Everyone we've emailed, keyed by address.
  const sentOut = await prisma.emailMessage.findMany({
    where: { direction: 'out', status: 'sent', toEmail: { not: null } },
    select: { targetId: true, toEmail: true },
  })
  if (sentOut.length === 0) return { configured: true, replies: 0 }
  const byEmail = new Map<string, string>()
  for (const m of sentOut) byEmail.set(m.toEmail!.toLowerCase(), m.targetId)

  const lastCheck = await getSetting('emailLastCheck')
  const since = lastCheck ? new Date(lastCheck) : new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)

  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user: process.env.EMAIL_USER!, pass: process.env.EMAIL_APP_PASSWORD! },
    logger: false,
  })

  let replies = 0
  try {
    await client.connect()
    const lock = await client.getMailboxLock('INBOX')
    try {
      for await (const msg of client.fetch({ since }, { envelope: true })) {
        const from = msg.envelope?.from?.[0]?.address?.toLowerCase()
        if (!from) continue
        const targetId = byEmail.get(from)
        if (!targetId) continue

        // One reply record per target per message date-ish; skip if we
        // already logged a reply for this target with this subject.
        const subject = msg.envelope?.subject ?? null
        const dupe = await prisma.emailMessage.findFirst({
          where: { targetId, direction: 'in', subject },
        })
        if (dupe) continue

        await prisma.emailMessage.create({
          data: {
            targetId, direction: 'in', kind: 'reply', status: 'received',
            fromEmail: from, subject,
            sentAt: msg.envelope?.date ?? new Date(),
          },
        })

        const t = await prisma.target.findUnique({ where: { id: targetId } })
        if (t && !['replied', 'converted', 'declined', 'dead'].includes(t.status)) {
          await prisma.target.update({
            where: { id: targetId },
            data: { status: 'replied', repliedAt: t.repliedAt ?? new Date() },
          })
          await prisma.targetEvent.create({
            data: { targetId, kind: 'status', fromStatus: t.status, toStatus: 'replied', detail: 'email reply' },
          })
          await prisma.partner.upsert({
            where: { brandId: t.brandId },
            create: { brandId: t.brandId, lifecycle: 'in_network' },
            update: {},
          })
        }
        replies++
      }
    } finally {
      lock.release()
    }
    await client.logout()
  } catch (err: any) {
    try { await client.logout() } catch {}
    return { configured: true, replies, error: String(err?.message ?? 'IMAP failed').slice(0, 200) }
  }

  await setSetting('emailLastCheck', new Date().toISOString())
  return { configured: true, replies }
}

// ---- status ----------------------------------------------------

export async function emailStatus() {
  if (!emailConfigured()) return { configured: false }
  const cap = await currentDailyCap()
  const sentToday = await prisma.emailMessage.count({
    where: { direction: 'out', status: 'sent', sentAt: { gte: startOfLocalDay() } },
  })
  const drafts = await prisma.emailMessage.count({ where: { direction: 'out', status: 'draft' } })
  const totalSent = await prisma.emailMessage.count({ where: { direction: 'out', status: 'sent' } })
  const totalReplies = await prisma.emailMessage.count({ where: { direction: 'in' } })
  return {
    configured: true, address: emailAddress(),
    cap, sentToday, drafts, totalSent, totalReplies,
    lastCheck: await getSetting('emailLastCheck'),
  }
}

export async function listEmailQueue() {
  const include = { target: { include: { brand: { select: { id: true, name: true, category: true } }, contact: { select: { name: true, title: true, email: true } } } } }
  const drafts = await prisma.emailMessage.findMany({
    where: { direction: 'out', status: 'draft' },
    include, orderBy: { createdAt: 'asc' },
  })
  const recent = await prisma.emailMessage.findMany({
    where: { direction: 'out', status: { in: ['sent', 'failed'] } },
    include, orderBy: { sentAt: 'desc' }, take: 20,
  })
  const replies = await prisma.emailMessage.findMany({
    where: { direction: 'in' },
    include, orderBy: { createdAt: 'desc' }, take: 20,
  })
  return { drafts, recent, replies }
}
