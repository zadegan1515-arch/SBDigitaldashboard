// src/lib/ops.ts
//
// Operations inbox: the ops@ mailbox pulled into the dashboard so
// contracts and invoices get tracked, linked and answered from one
// place. Classification is rules-only (no model calls, by Leo's
// decision) — sender, subject, body and attachment names decide the
// bucket; amounts and due dates are pulled by regex and are always
// editable by hand. A hand edit is never overwritten by a rescan.

import { PrismaClient } from '@prisma/client'
import {
  opsListIds, opsGetMessage, opsGetAttachment, opsSend, opsMessageIdHeader,
  opsStatus, opsSetLastScan,
} from '@/lib/google'

const prisma = new PrismaClient()

export const OPS_KINDS = ['contract', 'invoice_payable', 'invoice_receivable', 'other'] as const
export const OPS_STATUS = ['needs_review', 'approved', 'paid', 'signed', 'done', 'ignored'] as const
const OUR_DOMAIN = (process.env.OPS_DOMAIN || 'sboyagency.com').toLowerCase()
const BACKFILL_DAYS = Number(process.env.OPS_BACKFILL_DAYS || 90)
const SITE_ASSETS = 'https://sb-digitaldashboard.vercel.app/materials/'

// ---- rules -----------------------------------------------------------

const RX = {
  contract: /\b(contract|agreement|docusign|pandadoc|hellosign|dropbox sign|signature requested|please sign|countersign|signed copy|executed|rider|terms of service|sow\b|statement of work|msa\b|nda\b)/i,
  invoice: /\b(invoice|inv\.?\s?#|inv\s?\d|amount due|balance due|payment due|remittance|past due|overdue|statement of account|receipt for|bill for|billing statement|payment request|deposit due|final payment)/i,
  receivable: /\b(your invoice|invoice from sb agency|payment received|we have received your|paid your invoice|remitted)/i,
  money: /(?:\$|USD\s?)\s?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.([0-9]{2}))?/g,
  due: /\b(?:due|payable|pay by|payment due|due date)[:\s]*(?:on|by)?\s*([A-Z][a-z]{2,8}\.? \d{1,2}(?:st|nd|rd|th)?,? \d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})/i,
  net: /\bnet\s?(\d{1,3})\b/i,
}

export function classify(m: { fromEmail: string; subject: string; body: string; attachments: { filename: string; mimeType: string }[]; date: Date }) {
  const hay = [m.subject, m.body.slice(0, 6000), ...m.attachments.map(a => a.filename)].join('\n')
  const fromUs = m.fromEmail.endsWith('@' + OUR_DOMAIN)
  const attNames = m.attachments.map(a => a.filename.toLowerCase())
  const hasPdf = m.attachments.some(a => /pdf/i.test(a.mimeType) || /\.pdf$/i.test(a.filename))

  let kind: typeof OPS_KINDS[number] = 'other'
  const looksInvoice = RX.invoice.test(hay) || attNames.some(n => /invoice|inv[-_ ]?\d|receipt|bill/.test(n))
  const looksContract = RX.contract.test(hay) || attNames.some(n => /contract|agreement|rider|sow|msa|nda|signed/.test(n))
  if (looksInvoice && !(looksContract && !hasPdf)) kind = fromUs || RX.receivable.test(hay) ? 'invoice_receivable' : 'invoice_payable'
  else if (looksContract) kind = 'contract'

  // Amount: the largest dollar figure in the text (totals beat line items).
  let amountCents: number | null = null
  if (kind !== 'other') {
    let best = 0
    for (const mm of hay.matchAll(RX.money)) {
      const v = Math.round(Number(mm[1].replace(/,/g, '')) * 100 + Number(mm[2] || 0))
      if (v > best && v < 100_000_000_00) best = v
    }
    if (best > 0) amountCents = best
  }

  let dueDate: Date | null = null
  const d = hay.match(RX.due)
  if (d) { const t = new Date(d[1].replace(/(\d)(st|nd|rd|th)/, '$1')); if (!isNaN(t.getTime())) dueDate = t }
  if (!dueDate) { const n = hay.match(RX.net); if (n) dueDate = new Date(m.date.getTime() + Number(n[1]) * 86400000) }

  const vendor = fromUs ? null : (m.fromEmail.split('@')[1] || '').replace(/^www\./, '').split('.')[0] || null
  return { kind, amountCents, dueDate, vendor: vendor ? vendor.charAt(0).toUpperCase() + vendor.slice(1) : null }
}

// ---- scan ------------------------------------------------------------

export async function scanOps(opts: { max?: number } = {}) {
  const st = await opsStatus()
  if (!st.connected) return { connected: false, scanned: 0, added: 0 }
  const last = st.lastScanAt ? new Date(st.lastScanAt) : null
  const since = last ? new Date(last.getTime() - 2 * 86400000) : new Date(Date.now() - BACKFILL_DAYS * 86400000)
  const q = `after:${Math.floor(since.getTime() / 1000)} -in:spam -in:trash`
  const ids = await opsListIds(q, opts.max ?? (last ? 200 : 400))
  const known = new Set((await prisma.opsMessage.findMany({ where: { gmailId: { in: ids } }, select: { gmailId: true } })).map(x => x.gmailId))
  const fresh = ids.filter(id => !known.has(id))
  let added = 0
  const errors: string[] = []
  for (let i = 0; i < fresh.length; i += 5) {
    const batch = await Promise.all(fresh.slice(i, i + 5).map(async id => {
      try { return await opsGetMessage(id) } catch (e: any) { errors.push(`${id}: ${String(e?.message || e).slice(0, 80)}`); return null }
    }))
    for (const m of batch) {
      if (!m) continue
      const c = classify(m)
      await prisma.opsMessage.create({
        data: {
          gmailId: m.id, threadId: m.threadId,
          fromName: m.fromName, fromEmail: m.fromEmail, toEmail: m.toEmail,
          subject: m.subject, snippet: m.snippet.slice(0, 300), body: m.body, date: m.date,
          attachments: JSON.stringify(m.attachments), hasAttachments: m.attachments.length > 0,
          kind: c.kind, autoKind: c.kind, amountCents: c.amountCents, dueDate: c.dueDate, vendor: c.vendor,
          status: c.kind === 'other' ? 'done' : 'needs_review',
        },
      })
      added++
    }
  }
  await opsSetLastScan(new Date().toISOString())
  return { connected: true, scanned: ids.length, added, since: since.toISOString(), errors: errors.slice(0, 5) }
}

// ---- reading -----------------------------------------------------------

export async function listOps(args: { kind?: string; status?: string; q?: string; limit?: number } = {}) {
  const where: any = {}
  if (args.kind && args.kind !== 'all') {
    if (args.kind === 'invoice') where.kind = { in: ['invoice_payable', 'invoice_receivable'] }
    else where.kind = args.kind
  }
  if (args.status && args.status !== 'all') {
    if (args.status === 'open') where.status = { in: ['needs_review', 'approved'] }
    else where.status = args.status
  }
  if (args.q) {
    const needle = String(args.q)
    where.OR = [
      { subject: { contains: needle, mode: 'insensitive' } },
      { fromEmail: { contains: needle, mode: 'insensitive' } },
      { fromName: { contains: needle, mode: 'insensitive' } },
      { vendor: { contains: needle, mode: 'insensitive' } },
      { snippet: { contains: needle, mode: 'insensitive' } },
    ]
  }
  const rows = await prisma.opsMessage.findMany({
    where, orderBy: { date: 'desc' }, take: Math.min(500, args.limit ?? 200),
    select: {
      id: true, gmailId: true, threadId: true, fromName: true, fromEmail: true, subject: true, snippet: true, date: true,
      hasAttachments: true, attachments: true, kind: true, status: true, amountCents: true, dueDate: true, vendor: true,
      owner: true, brandId: true, activationId: true, dealId: true, budgetLineId: true, forwardedTo: true, repliedAt: true,
    },
  })
  const counts = await prisma.opsMessage.groupBy({ by: ['kind', 'status'], _count: { _all: true } })
  const summary = { inbox: 0, contracts: 0, payable: 0, receivable: 0, overdue: 0 }
  for (const c of counts) {
    const n = c._count._all
    if (c.status === 'needs_review' || c.status === 'approved') {
      summary.inbox += n
      if (c.kind === 'contract') summary.contracts += n
      if (c.kind === 'invoice_payable') summary.payable += n
      if (c.kind === 'invoice_receivable') summary.receivable += n
    }
  }
  summary.overdue = await prisma.opsMessage.count({ where: { status: { in: ['needs_review', 'approved'] }, dueDate: { lt: new Date() } } })
  return { rows: rows.map(r => ({ ...r, attachments: JSON.parse(r.attachments || '[]') })), summary, status: await opsStatus() }
}

export async function getOps(id: string) {
  const m = await prisma.opsMessage.findUnique({ where: { id } })
  if (!m) throw new Error('Not found')
  const thread = await prisma.opsMessage.findMany({ where: { threadId: m.threadId }, orderBy: { date: 'asc' }, select: { id: true, fromName: true, fromEmail: true, date: true, snippet: true, subject: true } })
  const [brand, activation, deal, line] = await Promise.all([
    m.brandId ? prisma.brand.findUnique({ where: { id: m.brandId }, select: { id: true, name: true } }) : null,
    m.activationId ? prisma.activation.findUnique({ where: { id: m.activationId }, select: { id: true, name: true, events: { select: { id: true, name: true, lines: { select: { id: true, item: true, section: true, estimateCents: true, finalCents: true } } } } } }) : null,
    m.dealId ? prisma.deal.findUnique({ where: { id: m.dealId }, select: { id: true, name: true } }) : null,
    m.budgetLineId ? prisma.budgetLine.findUnique({ where: { id: m.budgetLineId }, select: { id: true, item: true, estimateCents: true, finalCents: true } }) : null,
  ])
  return { ...m, attachments: JSON.parse(m.attachments || '[]'), thread, brand, activation, deal, line }
}

export async function updateOps(args: any) {
  const { id } = args
  const data: any = {}
  for (const k of ['kind', 'status', 'vendor', 'owner', 'notes', 'brandId', 'activationId', 'dealId', 'budgetLineId']) {
    if (args[k] !== undefined) data[k] = args[k] === '' ? null : args[k]
  }
  if (args.amountCents !== undefined) data.amountCents = args.amountCents == null || args.amountCents === '' ? null : Math.round(Number(args.amountCents))
  if (args.dueDate !== undefined) data.dueDate = args.dueDate ? new Date(args.dueDate) : null
  if (args.status || args.kind) data.reviewedAt = new Date()
  const m = await prisma.opsMessage.update({ where: { id }, data })
  // A paid vendor invoice linked to a budget line becomes that line's final cost.
  if (m.budgetLineId && m.kind === 'invoice_payable' && m.amountCents != null && (args.status === 'paid' || args.applyToLine)) {
    await prisma.budgetLine.update({ where: { id: m.budgetLineId }, data: { finalCents: m.amountCents, ordered: true } })
  }
  return m
}

export async function deleteOps(id: string) {
  await prisma.opsMessage.delete({ where: { id } })
  return { ok: true }
}

// ---- sending -------------------------------------------------------------

function opsSignatureText() {
  return ['SB Agency Operations', 'ops@sboyagency.com | sboyagency.com'].join('\n')
}
function esc(s: string) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>') }
function opsHtml(text: string) {
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.55">' + esc(text) +
    '<div style="margin-top:18px"><img src="' + SITE_ASSETS + 'sb-logo.png?v=2026-09-03" alt="SB Agency" width="110" style="width:110px;height:auto;display:block;border:0;margin-bottom:6px">' +
    '<div style="font-size:13px"><span style="font-weight:700">SB Agency Operations</span><br>' +
    '<a href="mailto:ops@sboyagency.com" style="color:#1a1a1a">ops@sboyagency.com</a> | <a href="https://sboyagency.com" style="color:#1a1a1a">sboyagency.com</a></div></div></div>'
}
async function opsFrom(): Promise<string> {
  const st = await opsStatus()
  return `SB Agency Operations <${st.address || 'ops@' + OUR_DOMAIN}>`
}

export async function replyOps(args: { id: string; body: string; to?: string; cc?: string[] }) {
  const m = await prisma.opsMessage.findUnique({ where: { id: args.id } })
  if (!m) throw new Error('Not found')
  const to = (args.to || m.fromEmail).trim()
  if (!/@/.test(to)) throw new Error('Valid address required')
  const text = String(args.body || '').trimEnd() + '\n\n' + opsSignatureText()
  const inReplyTo = await opsMessageIdHeader(m.gmailId).catch(() => null)
  const subject = /^re:/i.test(m.subject) ? m.subject : 'Re: ' + m.subject
  await opsSend({ from: await opsFrom(), to, ...(args.cc?.length ? { cc: args.cc } : {}), subject, text, html: opsHtml(String(args.body || '')), threadId: m.threadId, ...(inReplyTo ? { inReplyTo } : {}) })
  await prisma.opsMessage.update({ where: { id: m.id }, data: { repliedAt: new Date() } })
  return { ok: true, to }
}

export async function forwardOps(args: { id: string; to: string; note?: string; withAttachments?: boolean }) {
  const m = await prisma.opsMessage.findUnique({ where: { id: args.id } })
  if (!m) throw new Error('Not found')
  const to = String(args.to || '').trim()
  if (!/@/.test(to)) throw new Error('Valid address required')
  const atts: { id: string; filename: string; mimeType: string; size: number }[] = JSON.parse(m.attachments || '[]')
  const files: { filename: string; content: Buffer }[] = []
  if (args.withAttachments !== false) {
    for (const a of atts.slice(0, 6)) {
      if (a.size > 20 * 1024 * 1024) continue
      try { files.push({ filename: a.filename, content: await opsGetAttachment(m.gmailId, a.id) }) } catch {}
    }
  }
  const header = `---------- Forwarded message ----------\nFrom: ${m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail}\nDate: ${m.date.toLocaleString('en-US')}\nSubject: ${m.subject}\n\n`
  const text = (args.note ? String(args.note).trimEnd() + '\n\n' : '') + header + (m.body || m.snippet || '') + '\n\n' + opsSignatureText()
  await opsSend({ from: await opsFrom(), to, subject: 'Fwd: ' + m.subject, text, html: opsHtml((args.note ? String(args.note).trimEnd() + '\n\n' : '') + header + (m.body || m.snippet || '')), ...(files.length ? { attachments: files } : {}) })
  await prisma.opsMessage.update({ where: { id: m.id }, data: { forwardedTo: to, forwardedAt: new Date() } })
  return { ok: true, to, attachments: files.length }
}

export { opsGetAttachment }
