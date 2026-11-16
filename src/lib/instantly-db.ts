// Instantly, the database side (rules: instantly.ts, calls: instantly-api.ts).
// Shared by /api/data (the card's handlers), /api/instantly/webhook (events
// as they happen) and the daily cron (the sync, as the net under the webhook).
//
//   pushLeads      hand people to a campaign (called only from sendToInstantly)
//   applyEvent     one thing Instantly did: sent · reply · bounce · unsubscribe
//   syncInstantly  read the campaigns' emails and leads, then take back out
//                  whoever shouldn't be emailed any more
//   undoPush       the last Send, back out — whoever wasn't emailed yet
//
// Nothing here sends an email. Instantly does, from its own campaign.

import type { PrismaClient } from '@prisma/client'
import { recordReply } from './email'
import * as api from './instantly-api'
import { addNote, cleanEmail } from './find-emails'
import {
  CAMPAIGN_KEY, HOOK_KEY, PUSH_CHUNK, PUSH_LAST_KEY, SYNC_KEY, VIA, bounceNote, isActive, kindOfStep, leadFacts, pullBackWhy,
  stateBeats, stateOfLead, stepOfEmail, type InstantlyEvent, type InstantlyLeadIn, type LeadState,
} from './instantly'

type Db = PrismaClient

export async function readJson<T>(db: Db, key: string, fallback: T): Promise<T> {
  const row = await db.setting.findUnique({ where: { key } })
  if (!row) return fallback
  try { const v = JSON.parse(row.value); return v ?? fallback } catch { return fallback }
}
export async function writeJson(db: Db, key: string, value: unknown) {
  const text = JSON.stringify(value)
  await db.setting.upsert({ where: { key }, create: { key, value: text }, update: { value: text } })
}

export type ChosenCampaign = { id: string; name: string; at: string; by: string | null }
export const chosenCampaign = (db: Db) => readJson<ChosenCampaign | null>(db, CAMPAIGN_KEY, null)
export type HookInfo = { id: string; secret: string; url: string; at: string }
export const hookInfo = (db: Db) => readJson<HookInfo | null>(db, HOOK_KEY, null)

const dayWords = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })
const NEAR_MS = 2 * 60 * 1000

// ---- handing people over ---------------------------------------------

export type PushOne = { targetId: string; contactId: string; name: string; brandName: string; email: string; lead: InstantlyLeadIn }
export type PushResult = {
  sent: Array<{ targetId: string; name: string; brandName: string; email: string }>
  already: Array<{ name: string; brandName: string; email: string }>     // in an Instantly campaign already
  refused: Array<{ name: string; brandName: string; email: string }>     // on Instantly's block list, or an address it won't take
  remaining: number | null                                                // lead uploads left in the plan, when Instantly says
}
// Into the campaign, in chunks. A row is written only for a lead Instantly
// says it created; one already in a campaign there is adopted as it stands.
export async function pushLeads(db: Db, args: { campaignId: string; people: PushOne[]; by: string | null; batch: string }): Promise<PushResult> {
  const out: PushResult = { sent: [], already: [], refused: [], remaining: null }
  for (let i = 0; i < args.people.length; i += PUSH_CHUNK) {
    const chunk = args.people.slice(i, i + PUSH_CHUNK)
    const res = await api.addLeads(args.campaignId, chunk.map(p => p.lead), args.batch + '-' + i / PUSH_CHUNK)
    if (typeof res.remaining_in_plan === 'number') out.remaining = res.remaining_in_plan
    const made = new Map<string, string>()                    // targetId → Instantly's lead id
    const byEmail = new Map(chunk.map(p => [p.email, p]))
    for (const c of res.created_leads ?? []) {
      const p = (Number.isInteger(c.index) && chunk[c.index] && (!c.email || cleanEmail(c.email) === chunk[c.index].email) ? chunk[c.index] : null)
        ?? byEmail.get(cleanEmail(c.email))
      if (p && c.id) made.set(p.targetId, String(c.id))
    }
    const now = new Date()
    if (made.size) {
      await db.instantlyLead.createMany({
        data: chunk.filter(p => made.has(p.targetId)).map(p => ({
          targetId: p.targetId, email: p.email, campaignId: args.campaignId, leadId: made.get(p.targetId) as string,
          state: 'waiting', pushedAt: now, pushedBy: args.by, batch: args.batch,
        })),
        skipDuplicates: true,
      })
    }
    for (const p of chunk) if (made.has(p.targetId)) out.sent.push({ targetId: p.targetId, name: p.name, brandName: p.brandName, email: p.email })
    // Not created: already in one of his campaigns (adopt it), or refused.
    const rest = chunk.filter(p => !made.has(p.targetId))
    if (!rest.length) continue
    const there = new Map<string, ReturnType<typeof leadFacts>>()
    for (let j = 0; j < rest.length; j += 100) {
      const found = await api.listLeads({ contacts: rest.slice(j, j + 100).map(p => p.email), limit: 100 }).catch(() => ({ items: [] }))
      for (const l of found.items) { const f = leadFacts(l); if (f.email && f.campaignId && !there.has(f.email)) there.set(f.email, f) }
    }
    for (const p of rest) {
      const f = there.get(p.email)
      if (!f) { out.refused.push({ name: p.name, brandName: p.brandName, email: p.email }); continue }
      await db.instantlyLead.createMany({
        data: [{
          targetId: p.targetId, email: p.email, campaignId: f.campaignId as string, leadId: f.leadId || null, state: stateOfLead(f),
          pushedAt: now, pushedBy: null, batch: null, note: 'Already in Instantly when it was sent', sentAt: f.contactedAt, lastSentAt: f.contactedAt,
        }],
        skipDuplicates: true,
      })
      out.already.push({ name: p.name, brandName: p.brandName, email: p.email })
    }
  }
  return out
}

// ---- one thing Instantly did -----------------------------------------

const ROW = { target: { select: { id: true, contactId: true, brandId: true, status: true, handDeclinedAt: true, contact: { select: { id: true, name: true, notes: true, doNotContactAt: true } } } } }

// Someone on the dashboard that Instantly is emailing though the dashboard
// didn't hand them over (added there by hand, or their row was merged):
// taken on as they stand, so a stop still reaches Instantly.
async function adopt(db: Db, email: string, campaignId: string | null, leadId: string | null) {
  const people = await db.contact.findMany({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { targets: { select: { id: true, instantly: { select: { id: true } } } } },
    take: 5,
  })
  const t = people.flatMap(c => c.targets).find(x => !x.instantly)
  if (!t) return null
  await db.instantlyLead.createMany({
    data: [{ targetId: t.id, email, campaignId: campaignId ?? '', leadId, state: 'waiting', batch: null, note: 'Added in Instantly, not from the dashboard' }],
    skipDuplicates: true,
  })
  return db.instantlyLead.findUnique({ where: { targetId: t.id }, include: ROW })
}
async function rowFor(db: Db, email: string, campaignId: string | null, leadId: string | null = null) {
  const row = (campaignId ? await db.instantlyLead.findFirst({ where: { email, campaignId }, orderBy: { pushedAt: 'desc' }, include: ROW }) : null)
    ?? await db.instantlyLead.findFirst({ where: { email }, orderBy: { pushedAt: 'desc' }, include: ROW })
  return row ?? adopt(db, email, campaignId, leadId)
}

export type Applied = { what: 'sent' | 'reply' | 'bounce' | 'unsub' | null; adopted?: boolean; targetId?: string }
export async function applyEvent(db: Db, ev: InstantlyEvent): Promise<Applied> {
  if (!['sent', 'reply', 'bounce', 'unsub'].includes(ev.kind)) return { what: null }
  const before = await db.instantlyLead.count({ where: { email: ev.email } })
  const row = await rowFor(db, ev.email, ev.campaignId)
  if (!row) return { what: null }
  const adopted = before === 0
  const t = row.target
  const state = row.state as LeadState
  const near = { gte: new Date(ev.at.getTime() - NEAR_MS), lte: new Date(ev.at.getTime() + NEAR_MS) }

  if (ev.kind === 'sent') {
    const dupe = await db.emailMessage.findFirst({
      where: { targetId: t.id, direction: 'out', via: VIA, OR: [...(ev.emailId ? [{ externalId: ev.emailId }] : []), { sentAt: near }] },
      select: { id: true },
    })
    if (!dupe) {
      const prior = await db.emailMessage.count({ where: { targetId: t.id, direction: 'out', via: VIA, status: 'sent' } })
      await db.emailMessage.create({
        data: {
          targetId: t.id, direction: 'out', kind: ev.step ? kindOfStep(ev.step) : prior ? 'followup' : 'intro', status: 'sent',
          toEmail: ev.email, fromEmail: ev.account, subject: ev.subject, body: ev.text, sentAt: ev.at, via: VIA, externalId: ev.emailId,
        },
      })
    }
    const steps = await db.emailMessage.count({ where: { targetId: t.id, direction: 'out', via: VIA, status: 'sent' } })
    await db.instantlyLead.update({
      where: { id: row.id },
      data: {
        state: state === 'waiting' ? 'sent' : state, steps,
        sentAt: row.sentAt && row.sentAt < ev.at ? row.sentAt : ev.at,
        lastSentAt: row.lastSentAt && row.lastSentAt > ev.at ? row.lastSentAt : ev.at,
        syncedAt: new Date(),
      },
    })
    return { what: dupe ? null : 'sent', adopted, targetId: t.id }
  }

  if (ev.kind === 'reply') {
    const dupe = await db.emailMessage.findFirst({
      where: { targetId: t.id, direction: 'in', via: VIA, OR: [...(ev.emailId ? [{ externalId: ev.emailId }] : []), { sentAt: near }] },
      select: { id: true },
    })
    const fresh = dupe ? false : await recordReply(t.id, ev.email, ev.subject, ev.at, { body: ev.text, via: VIA, externalId: ev.emailId })
    if (stateBeats('replied', state) || !row.repliedAt) {
      await db.instantlyLead.update({
        where: { id: row.id },
        data: { state: stateBeats('replied', state) ? 'replied' : state, repliedAt: row.repliedAt ?? ev.at, endedAt: row.endedAt ?? ev.at, syncedAt: new Date() },
      })
    }
    return { what: fresh ? 'reply' : null, adopted, targetId: t.id }
  }

  if (ev.kind === 'bounce') {
    if (!stateBeats('bounced', state)) return { what: null, adopted, targetId: t.id }
    const line = bounceNote(ev.email, dayWords(ev.at))
    await db.$transaction([
      db.instantlyLead.update({ where: { id: row.id }, data: { state: 'bounced', endedAt: ev.at, syncedAt: new Date() } }),
      ...(String(t.contact.notes ?? '').includes('bounced (Instantly') ? [] : [db.contact.update({ where: { id: t.contactId }, data: { notes: addNote(t.contact.notes, line) } })]),
    ])
    return { what: 'bounce', adopted, targetId: t.id }
  }

  // Unsubscribed = they asked us to stop. Marked "doesn't want to continue"
  // (just them) in the same moment, with one time on the row and the person —
  // the stop's Undo clears by that time. Their other copies are marked from
  // the dashboard's side on the next sync (finishStops in /api/data).
  if (state === 'unsubscribed') return { what: null, adopted, targetId: t.id }
  const at = ev.at
  await db.$transaction(async tx => {
    await tx.instantlyLead.update({ where: { id: row.id }, data: { state: 'unsubscribed', endedAt: at, syncedAt: new Date() } })
    const cur = await tx.target.findUnique({ where: { id: t.id }, select: { handDeclinedAt: true, contact: { select: { doNotContactAt: true } } } })
    if (!cur || cur.handDeclinedAt) return
    // Already stopped another way (a copy of them, a merge): the row takes that time.
    const mark = cur.contact.doNotContactAt ?? at
    await tx.target.update({ where: { id: t.id }, data: { handDeclinedAt: mark, handDeclinedScope: 'person' } })
    if (!cur.contact.doNotContactAt) await tx.contact.update({ where: { id: t.contactId }, data: { doNotContactAt: mark, doNotContactBy: 'Instantly' } })
    await tx.targetEvent.create({ data: { targetId: t.id, kind: 'doesn’t want to continue', actor: 'Instantly', detail: 'unsubscribed from the emails — just them' } })
  })
  return { what: 'unsub', adopted, targetId: t.id }
}

// ---- the sync ----------------------------------------------------------

export type SyncResult = {
  connected: boolean; at: string; ok: boolean; error?: string | null; partial?: boolean
  campaigns: number; sent: number; replies: number; bounced: number; unsubscribed: number; finished: number
  adopted: number; gone: number; pulledBack: number; blocked: number; failed: number
}
const emptySync = (connected: boolean): SyncResult => ({
  connected, at: new Date().toISOString(), ok: true, error: null, campaigns: 0, sent: 0, replies: 0, bounced: 0, unsubscribed: 0, finished: 0,
  adopted: 0, gone: 0, pulledBack: 0, blocked: 0, failed: 0,
})

// Instantly → dashboard (the campaigns' emails since the last sync, then
// every lead's status), then dashboard → Instantly (pullBack). Bounded by
// `budgetMs`; what it didn't get to is picked up by the next run.
export async function syncInstantly(db: Db, opts: { budgetMs?: number } = {}): Promise<SyncResult> {
  const out = emptySync(api.instantlyKeySet())
  if (!out.connected) return out
  const t0 = Date.now()
  const over = () => Date.now() - t0 > (opts.budgetMs ?? 35000)
  try {
    const chosen = await chosenCampaign(db)
    const used = await db.instantlyLead.findMany({ where: { state: { in: ['waiting', 'sent'] }, campaignId: { not: '' } }, distinct: ['campaignId'], select: { campaignId: true } })
    const campaigns = [...new Set([...(chosen ? [chosen.id] : []), ...used.map(u => u.campaignId)])].slice(0, 8)
    out.campaigns = campaigns.length
    const last = await readJson<{ at?: string; ok?: boolean } | null>(db, SYNC_KEY, null)
    const oldest = await db.instantlyLead.findFirst({ orderBy: { pushedAt: 'asc' }, select: { pushedAt: true } })
    // From a little before the last good sync; the first time, from the first hand-over.
    const since = last?.ok && last.at ? new Date(new Date(last.at).getTime() - 20 * 60000)
      : new Date((oldest?.pushedAt ?? new Date()).getTime() - 864e5)
    const count = (a: Applied) => {
      if (a.what === 'sent') out.sent += 1
      if (a.what === 'reply') out.replies += 1
      if (a.what === 'bounce') out.bounced += 1
      if (a.what === 'unsub') out.unsubscribed += 1
      if (a.adopted && a.what) out.adopted += 1
    }

    for (const campaignId of campaigns) {
      // 1. Emails sent and received.
      for (const type of ['sent', 'received'] as const) {
        let after: string | undefined
        for (let page = 0; page < 5 && !over(); page++) {
          const r = await api.listEmails({ campaignId, type, since, starting_after: after })
          for (const e of r.items) {
            const email = cleanEmail(e.lead)
            const at = new Date(String(e.timestamp_email ?? e.timestamp_created ?? ''))
            if (!email || isNaN(at.getTime())) continue
            if (type === 'received' && Number(e.is_auto_reply) === 1) continue
            count(await applyEvent(db, {
              kind: type === 'sent' ? 'sent' : 'reply', type: type === 'sent' ? 'email_sent' : 'reply_received', email, campaignId, at,
              step: type === 'sent' ? stepOfEmail(e.step) : null, emailId: e.id ? String(e.id) : null,
              subject: e.subject ? String(e.subject).slice(0, 300) : null, text: e.body?.text ? String(e.body.text).slice(0, 20000) : null,
              account: e.eaccount ?? e.from_address_email ?? null,
            }))
          }
          if (!r.next_starting_after || !r.items.length) break
          after = r.next_starting_after
        }
      }
      // 2. Every lead's status. The rows are read once; a page asks the
      //    database only about addresses it hasn't met (a lead added in
      //    Instantly by hand) and about leads whose standing changed.
      const known = new Map((await db.instantlyLead.findMany({ select: { id: true, email: true, leadId: true, campaignId: true, state: true, note: true } })).map(x => [x.email, x]))
      const seen = new Set<string>()
      let after: string | undefined, complete = false
      for (let page = 0; page < 30 && !over(); page++) {
        const r = await api.listLeads({ campaign: campaignId, starting_after: after, limit: 100 })
        const facts = r.items.map(leadFacts).filter(f => f.email)
        const fresh = facts.filter(f => !known.has(f.email))
        if (fresh.length) {
          const people = await db.contact.findMany({
            where: { email: { in: fresh.map(f => f.email), mode: 'insensitive' } },
            select: { email: true, targets: { select: { id: true, instantly: { select: { id: true } } } } },
          })
          const free = new Map<string, string>()            // address → an outreach row with nothing in Instantly yet
          for (const c of people) { const t = c.targets.find(x => !x.instantly); if (t && c.email && !free.has(cleanEmail(c.email))) free.set(cleanEmail(c.email), t.id) }
          const take = fresh.filter(f => free.has(f.email))
          if (take.length) {
            await db.instantlyLead.createMany({
              data: take.map(f => ({ targetId: free.get(f.email) as string, email: f.email, campaignId, leadId: f.leadId || null, state: 'waiting', batch: null, note: 'Added in Instantly, not from the dashboard' })),
              skipDuplicates: true,
            })
            for (const x of await db.instantlyLead.findMany({ where: { email: { in: take.map(f => f.email) } }, select: { id: true, email: true, leadId: true, campaignId: true, state: true, note: true } })) {
              if (!known.has(x.email)) { known.set(x.email, x); out.adopted += 1 }
            }
          }
        }
        for (const f of facts) {
          seen.add(f.email)
          const row = known.get(f.email)
          if (!row) continue
          if (f.leadId && (row.leadId !== f.leadId || row.campaignId !== campaignId)) {
            await db.instantlyLead.update({ where: { id: row.id }, data: { leadId: f.leadId, campaignId } })
            row.leadId = f.leadId; row.campaignId = campaignId
          }
          const next = stateOfLead(f)
          const cur = row.state as LeadState
          const ev = (kind: InstantlyEvent['kind'], at: Date | null): InstantlyEvent =>
            ({ kind, type: 'sync', email: f.email, campaignId, at: at ?? new Date(), step: null, emailId: null, subject: null, text: null, account: null })
          if (next === 'unsubscribed' && cur !== 'unsubscribed') { count(await applyEvent(db, ev('unsub', null))); row.state = 'unsubscribed' }
          else if (next === 'bounced' && stateBeats('bounced', cur)) { count(await applyEvent(db, ev('bounce', null))); row.state = 'bounced' }
          else if (next === 'sent' && cur === 'waiting') { count(await applyEvent(db, ev('sent', f.contactedAt))); row.state = 'sent' }
          else if ((next === 'done' || next === 'removed') && isActive(cur)) {
            await db.instantlyLead.update({
              where: { id: row.id },
              data: { state: next, endedAt: new Date(), note: next === 'removed' ? 'Instantly skipped them' : row.note, syncedAt: new Date() },
            })
            row.state = next
            if (next === 'done') out.finished += 1
          }
        }
        if (!r.next_starting_after || !r.items.length) { complete = true; break }
        after = r.next_starting_after
      }
      // 3. Deleted there by hand: a row still waiting whose lead is gone.
      if (complete) {
        const stale = await db.instantlyLead.findMany({
          where: { campaignId, state: { in: ['waiting', 'sent'] }, pushedAt: { lt: new Date(Date.now() - 10 * 60000) } },
          select: { id: true, email: true },
        })
        const gone = stale.filter(s => !seen.has(s.email)).map(s => s.id)
        if (gone.length) {
          await db.instantlyLead.updateMany({ where: { id: { in: gone } }, data: { state: 'removed', endedAt: new Date(), note: 'Deleted in Instantly' } })
          out.gone += gone.length
        }
      } else out.partial = true
    }
    // 4. The other way: whoever shouldn't be emailed any more.
    if (!over()) {
      const back = await pullBack(db)
      out.pulledBack = back.removed; out.blocked = back.blocked; out.failed = back.failed
    } else out.partial = true
  } catch (err: any) {
    out.ok = false
    out.error = String(err?.message ?? 'The sync failed').slice(0, 300)
  }
  out.at = new Date().toISOString()
  // A failed run keeps the last good time, so the next one reads from there.
  const prev = await readJson<SyncResult | null>(db, SYNC_KEY, null)
  await writeJson(db, SYNC_KEY, out.ok ? out : { ...out, at: prev?.ok ? prev.at : out.at, failedAt: out.at })
  return out
}

// ---- dashboard → Instantly --------------------------------------------

// Leads still being emailed that shouldn't be (instantly.ts pullBackWhy):
// deleted from Instantly; a stop also goes on its block list. A lead the
// dashboard didn't hand over is only ever taken out for a stop.
export async function pullBack(db: Db): Promise<{ removed: number; blocked: number; failed: number; people: Array<{ name: string; why: string }> }> {
  const rows = await db.instantlyLead.findMany({
    where: { state: { in: ['waiting', 'sent'] } },
    select: {
      id: true, email: true, leadId: true, campaignId: true, state: true, batch: true,
      target: {
        select: {
          id: true, brandId: true, status: true, callAt: true, callBookedAt: true, handDeclinedAt: true,
          contact: { select: { name: true, email: true, doNotContactAt: true } },
          brand: { select: { stoppedAt: true, passedAt: true, doNotEmail: true } },
        },
      },
    },
    take: 5000,
  })
  const res = { removed: 0, blocked: 0, failed: 0, people: [] as Array<{ name: string; why: string }> }
  if (!rows.length) return res
  // Brands where somebody answered: a reply, a no, a call — anyone but the row itself.
  const brandIds = [...new Set(rows.map(r => r.target.brandId))]
  const answered = await db.target.findMany({
    where: {
      brandId: { in: brandIds },
      OR: [{ status: { in: ['replied', 'converted', 'declined'] } }, { repliedAt: { not: null } }, { callAt: { not: null } }, { callBookedAt: { not: null } }, { emails: { some: { direction: 'in' } } }],
    },
    select: { id: true, brandId: true },
  })
  const answeredBy = new Map<string, Set<string>>()
  for (const a of answered) answeredBy.set(a.brandId, new Set([...(answeredBy.get(a.brandId) ?? []), a.id]))
  const block: string[] = []
  for (const r of rows) {
    const t = r.target
    const others = new Set(answeredBy.get(t.brandId) ?? [])
    others.delete(t.id)
    const why = pullBackWhy({
      state: r.state, handedEmail: r.email, emailNow: t.contact.email,
      contactStopped: !!t.contact.doNotContactAt, declined: !!t.handDeclinedAt, brandStopped: !!t.brand.stoppedAt,
      brandArchived: !!t.brand.passedAt, brandNoEmail: !!t.brand.doNotEmail, status: t.status, callBooked: !!(t.callAt || t.callBookedAt),
      brandAnswered: others.size > 0,
    })
    if (!why || (!r.batch && !why.block)) continue
    try {
      let leadId = r.leadId
      if (!leadId) {
        const found = await api.listLeads({ contacts: [r.email], limit: 10 })
        leadId = found.items.find(l => !r.campaignId || String(l.campaign ?? '') === r.campaignId)?.id ?? found.items[0]?.id ?? null
      }
      if (leadId) await api.deleteLead(leadId)
      await db.instantlyLead.update({ where: { id: r.id }, data: { state: 'removed', endedAt: new Date(), note: why.why } })
      res.removed += 1
      res.people.push({ name: t.contact.name, why: why.why })
      if (why.block) block.push(r.email)
    } catch { res.failed += 1 }
  }
  if (block.length) {
    try { await api.blockEmails([...new Set(block)]); res.blocked = new Set(block).size } catch { res.failed += 1 }
  }
  return res
}

// ---- the last Send, taken back -----------------------------------------

export type PushLast = { batch: string; at: string; by: string | null; campaignId: string; campaignName: string; count: number }
export const lastPush = (db: Db) => readJson<PushLast | null>(db, PUSH_LAST_KEY, null)

// Who would come back out (nothing sent to them yet) and who stays (already
// emailed, or answered) — and, with `apply`, taking them out: deleted from
// the campaign and from the dashboard's list, so they're ready to send again.
export async function undoPush(db: Db, apply: boolean) {
  const last = await lastPush(db)
  if (!last) throw new Error('Nothing to undo — nobody was sent to Instantly from here.')
  const rows = await db.instantlyLead.findMany({
    where: { batch: last.batch },
    select: { id: true, email: true, leadId: true, campaignId: true, state: true, target: { select: { contact: { select: { name: true } }, brand: { select: { name: true } } } } },
  })
  const who = (r: (typeof rows)[number]) => ({ name: r.target.contact.name, brandName: r.target.brand.name, email: r.email })
  const goes = rows.filter(r => r.state === 'waiting')
  const stays = rows.filter(r => r.state !== 'waiting').map(r => ({ ...who(r), why: r.state === 'sent' ? 'already emailed' : r.state === 'removed' ? 'already taken out' : r.state }))
  const summary = { at: last.at, by: last.by, campaignName: last.campaignName, count: last.count, goes: goes.map(who), stays }
  if (!apply) return { preview: true, ...summary }
  const byCampaign = new Map<string, string[]>()
  for (const r of goes) if (r.leadId) byCampaign.set(r.campaignId, [...(byCampaign.get(r.campaignId) ?? []), r.leadId])
  for (const [campaignId, ids] of byCampaign) await api.deleteLeads(campaignId, ids)
  // Only rows still waiting: one emailed in the meantime stays on the list.
  const gone = await db.instantlyLead.deleteMany({ where: { id: { in: goes.map(r => r.id) }, state: 'waiting' } })
  await db.setting.deleteMany({ where: { key: PUSH_LAST_KEY } })
  return { applied: true, removed: gone.count, ...summary }
}

// ---- the webhook -------------------------------------------------------

// Our address in Instantly's webhook list: made new (any older one of ours
// goes first), or taken off. The secret is made here and kept in Settings;
// Instantly sends it back in a header with each delivery.
export async function setHook(db: Db, on: boolean, url: string, secret: string): Promise<{ on: boolean; id: string | null }> {
  const mine = (await api.listWebhooks()).filter(w => w.target_hook_url === url)
  for (const w of mine) await api.deleteWebhook(w.id)
  if (!on) {
    await db.setting.deleteMany({ where: { key: HOOK_KEY } })
    return { on: false, id: null }
  }
  const made = await api.createWebhook(url, secret)
  await writeJson(db, HOOK_KEY, { id: made.id, secret, url, at: new Date().toISOString() } satisfies HookInfo)
  return { on: true, id: made.id }
}
