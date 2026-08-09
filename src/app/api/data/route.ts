// src/app/api/data/route.ts
//
// Single POST endpoint, dispatched by a `fn` name — same shape as
// sb-crm's /api/gs bridge, so the pattern is already familiar.
//
// Client calls:  api('listTargets', { status: 'queued' })
//
// NOTE: verify every field name below against prisma/schema.prisma
// before pushing. esbuild compiles this without type-checking, so a
// wrong field name builds clean here and fails on Vercel.

import { NextRequest, NextResponse } from 'next/server'
import { PrismaClient, TargetStatus } from '@prisma/client'
import Anthropic from '@anthropic-ai/sdk'

const prisma = new PrismaClient()

// Read-only connection to sb-crm's database. Used ONLY for $queryRaw —
// the models in this project's schema don't describe sb-crm's tables,
// and nothing here ever writes. sb-crm remains the owner of that data.
//
// Falls back to the local URL so the app still builds and runs if
// CRM_DATABASE_URL isn't set; the shows list just comes back empty.
const crm = new PrismaClient({
  datasources: { db: { url: process.env.CRM_DATABASE_URL ?? process.env.DATABASE_URL } },
})

const CRM_CONNECTED = Boolean(process.env.CRM_DATABASE_URL)

// Confirmed shows live in TWO tables with two different vocabularies.
// These values were read off the live database, not guessed from the
// schema — an earlier version matched "10 - Contract Signed", a stage
// that doesn't exist in the real data, and silently under-reported.
//
//   Lead.stage  = "13 - CONFIRMED"                  (20 rows)
//   Deal.status = "Offer Confirmed" | "Signed"      (35 rows, season "current")
//
// Deliberately excluded: Lead "12 - Formal Offer Sent" and Deal
// "Offer Out" (offer made, not accepted); "Declined Pivot",
// "Canceled", "Refund client", "Rescheduled to Fall"; and seasons
// "2425" / "2526", which have already been played.
const LEAD_CONFIRMED_STAGE = '13 - CONFIRMED'
const DEAL_CONFIRMED_STATUS = ['Offer Confirmed', 'Signed']
const DEAL_CURRENT_SEASON = 'current'

// A booking can exist in both tables. Key on school + chapter + date
// so it appears once. Loose normalisation because these are free-text
// fields typed by six different reps.
function showKey(school: string | null, chapter: string | null, date: string | null): string {
  const norm = (v: string | null) => (v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  return [norm(school), norm(chapter), norm(date)].join('|')
}

// LinkedIn's hard limits. Enforced at generation time so drafts
// come back usable rather than needing a trim.
const CONNECTION_NOTE_MAX = 300
const FIRST_MESSAGE_MAX = 600

// One LinkedIn account caps near 100 connection requests a week.
// Ten a day keeps a comfortable margin under that.
const DAILY_SEND_LIMIT = 10

type Handler = (args: any) => Promise<any>

// ---------------------------------------------------------------
// Fit scoring
// ---------------------------------------------------------------

// Titles that indicate someone who actually buys event sponsorships.
// Ordered most to least specific — first match wins.
const TITLE_SIGNALS: Array<[RegExp, number]> = [
  [/college|campus|university|greek/i, 40],
  [/field marketing|experiential|activation/i, 35],
  [/sponsorship|partnerships/i, 30],
  [/sports marketing|entertainment marketing/i, 25],
  [/brand marketing|brand director/i, 15],
  [/^(cmo|chief marketing)/i, 12],
  [/marketing/i, 8],
  [/founder|co-founder|ceo/i, 10], // small brands: the founder IS the buyer
]

const TIER_BONUS: Record<string, number> = {
  emerging: 20,   // hungriest for awareness, fastest yes
  growth: 15,
  established: 5, // biggest budgets, slowest process
}

function scoreFit(title: string | null, tier: string | null): number {
  let score = 30
  if (title) {
    for (const [pattern, points] of TITLE_SIGNALS) {
      if (pattern.test(title)) { score += points; break }
    }
  }
  if (tier && TIER_BONUS[tier] !== undefined) score += TIER_BONUS[tier]
  return Math.max(0, Math.min(100, score))
}

function looksLikeDecisionMaker(title: string | null): boolean {
  if (!title) return false
  return /college|campus|field marketing|experiential|sponsorship|partnerships|sports marketing|brand marketing|founder|ceo|cmo/i.test(title)
}

// ---------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------

const handlers: Record<string, Handler> = {

  // -------- dashboard --------

  async getDashboard() {
    const [byStatus, categories, pipeline, todos] = await Promise.all([
      prisma.target.groupBy({ by: ['status'], _count: true }),
      prisma.brand.groupBy({ by: ['category'], _count: true }),
      prisma.deal.aggregate({
        _sum: { valueCents: true },
        where: { stage: { notIn: ['closed', 'lost'] } },
      }),
      prisma.todo.findMany({ where: { done: false }, orderBy: { createdAt: 'desc' }, take: 25 }),
    ])

    const counts: Record<string, number> = {}
    for (const row of byStatus) counts[row.status] = row._count

    // Sellable inventory: confirmed shows, and how many still have no
    // sponsor attached. Wrapped in try/catch so a CRM connection problem
    // degrades to "no data" rather than blanking the whole dashboard.
    let showStats: { connected: boolean; total: number; unsold: number } =
      { connected: false, total: 0, unsold: 0 }
    if (CRM_CONNECTED) {
      try {
        // Same two-table union as listShows, deduped the same way, so the
        // dashboard count can never disagree with the Shows tab.
        const rows: any[] = await crm.$queryRawUnsafe(`
          SELECT l."id", l."schoolRaw", l."chapterRaw", l."eventDate",
                 s."name" AS "schoolName"
          FROM "Lead" l LEFT JOIN "School" s ON s."id" = l."schoolId"
          WHERE l."stage" = $1
          UNION ALL
          SELECT d."id", d."schoolRaw", d."chapterRaw", d."eventDate",
                 s."name" AS "schoolName"
          FROM "Deal" d LEFT JOIN "School" s ON s."id" = d."schoolId"
          WHERE d."season" = $2 AND d."status" = ANY($3::text[])
        `, LEAD_CONFIRMED_STAGE, DEAL_CURRENT_SEASON, DEAL_CONFIRMED_STATUS)

        const byKey = new Map<string, string>()
        for (const r of rows) {
          const key = showKey(r.schoolName || r.schoolRaw, r.chapterRaw, r.eventDate)
          if (!byKey.has(key)) byKey.set(key, r.id)
        }
        const ids = [...byKey.values()]

        const sold = await prisma.showSponsor.findMany({
          where: { crmLeadId: { in: ids } },
          select: { crmLeadId: true },
          distinct: ['crmLeadId'],
        })
        showStats = { connected: true, total: ids.length, unsold: ids.length - sold.length }
      } catch (err) {
        console.error('[getDashboard] CRM read failed', err)
      }
    }

    return {
      counts,
      totalTargets: Object.values(counts).reduce((a, b) => a + b, 0),
      pipelineCents: pipeline._sum.valueCents ?? 0,
      categories: categories
        .map(c => ({ key: c.category, count: c._count }))
        // Biggest categories first; the "unresolved" junk drawer always
        // last — three unidentifiable brands shouldn't lead the page.
        .sort((a, b) => {
          if (a.key === 'unresolved') return 1
          if (b.key === 'unresolved') return -1
          return b.count - a.count
        }),
      shows: showStats,
      todos,
    }
  },

  // -------- outreach queue --------

  // The day's send list. Locked once built so it doesn't reshuffle
  // underneath you mid-session.
  async getTodayQueue() {
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)

    const already = await prisma.target.findMany({
      where: { queuedFor: { gte: startOfDay }, status: { in: ['queued', 'drafted'] } },
      include: { brand: true, contact: true, drafts: { orderBy: { createdAt: 'desc' } } },
      orderBy: { fitScore: 'desc' },
    })
    if (already.length > 0) return already

    // Nothing locked in yet — pick today's batch by fit.
    const picks = await prisma.target.findMany({
      where: { status: 'queued', queuedFor: null },
      orderBy: [{ fitScore: 'desc' }, { createdAt: 'asc' }],
      take: DAILY_SEND_LIMIT,
      select: { id: true },
    })
    if (picks.length === 0) return []

    await prisma.target.updateMany({
      where: { id: { in: picks.map(p => p.id) } },
      data: { queuedFor: new Date() },
    })

    return prisma.target.findMany({
      where: { id: { in: picks.map(p => p.id) } },
      include: { brand: true, contact: true, drafts: { orderBy: { createdAt: 'desc' } } },
      orderBy: { fitScore: 'desc' },
    })
  },

  async listTargets({ status, category, search, take = 200 }: any) {
    return prisma.target.findMany({
      where: {
        ...(status && status !== 'all' ? { status: status as TargetStatus } : {}),
        ...(category ? { brand: { category } } : {}),
        ...(search
          ? {
              OR: [
                { brand: { name: { contains: search, mode: 'insensitive' } } },
                { contact: { name: { contains: search, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      include: { brand: true, contact: true, drafts: { orderBy: { createdAt: 'desc' }, take: 2 } },
      orderBy: [{ fitScore: 'desc' }, { createdAt: 'asc' }],
      take,
    })
  },

  async setTargetStatus({ targetId, status, actor }: any) {
    const before = await prisma.target.findUnique({ where: { id: targetId } })
    if (!before) throw new Error('Target not found')

    const now = new Date()
    const updated = await prisma.target.update({
      where: { id: targetId },
      data: {
        status,
        ...(status === 'sent' && !before.sentAt ? { sentAt: now } : {}),
        ...(status === 'replied' && !before.repliedAt ? { repliedAt: now } : {}),
      },
      include: { brand: true, contact: true },
    })

    // Audit trail — this is what makes "which approach works" answerable later.
    await prisma.targetEvent.create({
      data: {
        targetId,
        kind: 'status',
        fromStatus: before.status,
        toStatus: status,
        actor: actor ?? null,
      },
    })

    // A reply means a relationship exists. Promote the brand.
    if (status === 'replied') {
      await prisma.partner.upsert({
        where: { brandId: updated.brandId },
        create: { brandId: updated.brandId, lifecycle: 'in_network' },
        update: {},
      })
    }

    return updated
  },

  // -------- draft generation --------

  async generateDrafts({ targetId, variants = ['identity', 'question'] }: any) {
    const target = await prisma.target.findUnique({
      where: { id: targetId },
      include: { brand: true, contact: true },
    })
    if (!target) throw new Error('Target not found')

    const voice = await prisma.voice.findFirst({ where: { active: true } })
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

    const drafts = []
    for (const variant of variants) {
      const prompt = buildPrompt(target, variant, voice)
      const res = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      })

      const text = res.content.find(b => b.type === 'text')
      const parsed = parseDraft(text && 'text' in text ? text.text : '')
      if (!parsed) continue

      drafts.push(await prisma.draft.create({
        data: {
          targetId,
          variant,
          connectionNote: parsed.connectionNote,
          firstMessage: parsed.firstMessage,
          voice: voice?.name ?? null,
          model: 'claude-sonnet-4-6',
        },
      }))
    }

    if (drafts.length > 0 && target.status === 'queued') {
      await prisma.target.update({ where: { id: targetId }, data: { status: 'drafted' } })
      await prisma.targetEvent.create({
        data: { targetId, kind: 'drafted', fromStatus: 'queued', toStatus: 'drafted' },
      })
    }

    return drafts
  },

  async saveDraft({ draftId, connectionNote, firstMessage }: any) {
    return prisma.draft.update({
      where: { id: draftId },
      // Human edits are the training signal for improving prompts.
      data: { connectionNote, firstMessage, editedByHuman: true },
    })
  },

  // -------- voice --------

  async saveVoice({ name, role, samples, guidelines }: any) {
    return prisma.voice.upsert({
      where: { name },
      create: { name, role, samples: samples ?? [], guidelines },
      update: { role, samples: samples ?? [], guidelines },
    })
  },

  async getVoices() {
    return prisma.voice.findMany({ orderBy: { name: 'asc' } })
  },

  // -------- import --------

  // Seeds brands from brands.json. Idempotent — safe to re-run.
  async importBrands({ categories }: any) {
    let created = 0, skipped = 0
    for (const cat of categories) {
      for (const b of cat.brands) {
        const existing = await prisma.brand.findUnique({ where: { name: b.name } })
        if (existing) { skipped++; continue }
        await prisma.brand.create({
          data: { name: b.name, category: cat.key, tier: b.tier ?? null, notes: b.note ?? b.verify ?? null },
        })
        created++
      }
    }
    return { created, skipped }
  },

  // Bulk-loads contacts pulled from SponsorUnited, creating a queued
  // target for anyone who looks like a decision maker.
  async importContacts({ rows }: any) {
    const result = { brandsCreated: 0, contactsCreated: 0, targetsCreated: 0, skipped: 0 }

    for (const row of rows) {
      if (!row.brandName || !row.name) { result.skipped++; continue }

      let brand = await prisma.brand.findUnique({ where: { name: row.brandName } })
      if (!brand) {
        brand = await prisma.brand.create({
          data: { name: row.brandName, category: row.category ?? null, tier: row.tier ?? null, source: 'sponsorunited' },
        })
        result.brandsCreated++
      }

      const dupe = await prisma.contact.findFirst({
        where: { brandId: brand.id, name: row.name },
      })
      if (dupe) { result.skipped++; continue }

      const decisionMaker = looksLikeDecisionMaker(row.title ?? null)
      const contact = await prisma.contact.create({
        data: {
          brandId: brand.id,
          name: row.name,
          title: row.title ?? null,
          email: row.email ?? null,
          location: row.location ?? null,
          linkedinUrl: row.linkedinUrl ?? null,
          source: 'sponsorunited',
          externalId: row.externalId ?? null,
          isDecisionMaker: decisionMaker,
        },
      })
      result.contactsCreated++

      // Only queue people with a LinkedIn URL — outreach is LinkedIn-first,
      // so a contact without one can't be actioned.
      if (decisionMaker && contact.linkedinUrl) {
        await prisma.target.create({
          data: {
            brandId: brand.id,
            contactId: contact.id,
            fitScore: scoreFit(contact.title, brand.tier),
            assignedTo: 'Zach',
          },
        })
        result.targetsCreated++
      }
    }

    return result
  },

  // -------- brands --------

  // Powers the category drill-down. Counts come from the DB rather than
  // being computed client-side, so the numbers can't drift.
  async listBrands({ category, search, take = 500 }: any) {
    const brands = await prisma.brand.findMany({
      where: {
        ...(category && category !== 'all' ? { category } : {}),
        ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
      },
      include: {
        _count: { select: { contacts: true, targets: true } },
        contacts: {
          where: { isDecisionMaker: true },
          select: { name: true, title: true, linkedinUrl: true },
          take: 3,
        },
      },
      take,
    })

    // Brands with contacts first — those are the actionable ones.
    // Then by tier, emerging ahead of established: hungrier for
    // awareness, faster to say yes.
    const tierRank: Record<string, number> = { emerging: 0, growth: 1, established: 2 }
    return brands.sort((a, b) => {
      const aHas = a._count.contacts > 0 ? 0 : 1
      const bHas = b._count.contacts > 0 ? 0 : 1
      if (aHas !== bHas) return aHas - bHas
      const at = tierRank[a.tier ?? ''] ?? 3
      const bt = tierRank[b.tier ?? ''] ?? 3
      if (at !== bt) return at - bt
      return a.name.localeCompare(b.name)
    })
  },

  // -------- shows (read live from sb-crm) --------

  // Confirmed, not-yet-played shows — the inventory you can sell against.
  // Read-only against sb-crm. Never writes.
  async listShows({ search, onlyUnsold = false }: any) {
    if (!CRM_CONNECTED) {
      return { connected: false, shows: [] }
    }

    // Raw SQL because this project's Prisma schema doesn't model sb-crm's
    // tables. Quoted identifiers because Prisma creates them case-sensitive.
    // UNION because confirmed shows live in both Lead and Deal.
    const rows: any[] = await crm.$queryRawUnsafe(`
      SELECT 'lead' AS "src", l."id", l."stage" AS "state",
             l."schoolRaw", l."chapterRaw", l."artist", l."rep",
             l."eventDate", l."venueName", l."attendance",
             l."eventType", l."ticketing",
             s."name" AS "schoolName", s."city", s."state"
      FROM "Lead" l
      LEFT JOIN "School" s ON s."id" = l."schoolId"
      WHERE l."stage" = $1

      UNION ALL

      SELECT 'deal' AS "src", d."id", d."status" AS "state",
             d."schoolRaw", d."chapterRaw", d."artist", d."rep",
             d."eventDate", NULL AS "venueName", NULL AS "attendance",
             NULL AS "eventType", NULL AS "ticketing",
             s."name" AS "schoolName", s."city", s."state"
      FROM "Deal" d
      LEFT JOIN "School" s ON s."id" = d."schoolId"
      WHERE d."season" = $2 AND d."status" = ANY($3::text[])
    `, LEAD_CONFIRMED_STAGE, DEAL_CURRENT_SEASON, DEAL_CONFIRMED_STATUS)

    // A booking can appear in both tables. Keep one row per real show,
    // preferring the Lead record since it carries venue and attendance —
    // the two fields a sponsor actually asks about.
    const seen = new Map<string, any>()
    for (const r of rows) {
      const key = showKey(r.schoolName || r.schoolRaw, r.chapterRaw, r.eventDate)
      const existing = seen.get(key)
      if (!existing || (existing.src === 'deal' && r.src === 'lead')) seen.set(key, r)
    }
    const sellable = [...seen.values()]

    // Which of these already have a sponsor attached, and who.
    const links = await prisma.showSponsor.findMany({
      where: { crmLeadId: { in: sellable.map(r => r.id) } },
      include: { brand: { select: { id: true, name: true } } },
    })
    const byLead: Record<string, any[]> = {}
    for (const link of links) (byLead[link.crmLeadId] ??= []).push(link)

    let shows = sellable.map(r => ({
      id: r.id,
      stage: r.state,
      school: r.schoolName || r.schoolRaw,
      chapter: r.chapterRaw,
      artist: r.artist,
      rep: r.rep,
      eventDate: r.eventDate,
      venue: r.venueName,
      attendance: r.attendance,
      eventType: r.eventType,
      ticketing: r.ticketing,
      city: r.city,
      state: r.state,
      sponsors: (byLead[r.id] ?? []).map(l => ({
        brandId: l.brand.id, brandName: l.brand.name, status: l.status,
      })),
    }))

    if (search) {
      const q = String(search).toLowerCase()
      shows = shows.filter(s =>
        [s.school, s.chapter, s.artist, s.venue].some(v => v && String(v).toLowerCase().includes(q))
      )
    }
    if (onlyUnsold) shows = shows.filter(s => s.sponsors.length === 0)

    return {
      connected: true,
      total: shows.length,
      unsold: shows.filter(s => s.sponsors.length === 0).length,
      shows,
    }
  },

  // Attach a brand to one or more shows. Idempotent — re-attaching
  // updates rather than erroring on the unique constraint.
  async attachShows({ brandId, shows, status = 'proposed', valueCents = 0, deliverables }: any) {
    const results = []
    for (const s of shows) {
      results.push(await prisma.showSponsor.upsert({
        where: { brandId_crmLeadId: { brandId, crmLeadId: s.id } },
        create: {
          brandId, crmLeadId: s.id,
          school: s.school ?? null, chapter: s.chapter ?? null,
          artist: s.artist ?? null, eventDate: s.eventDate ?? null,
          status, valueCents, deliverables: deliverables ?? null,
        },
        update: { status, valueCents, deliverables: deliverables ?? null },
      }))
    }
    return { attached: results.length }
  },

  async detachShow({ brandId, crmLeadId }: any) {
    await prisma.showSponsor.delete({
      where: { brandId_crmLeadId: { brandId, crmLeadId } },
    })
    return { ok: true }
  },

  async listBrandShows({ brandId }: any) {
    return prisma.showSponsor.findMany({
      where: { brandId },
      orderBy: { createdAt: 'desc' },
    })
  },

  // -------- crm + pipeline --------

  async listPartners({ lifecycle }: any) {
    return prisma.partner.findMany({
      where: lifecycle && lifecycle !== 'all' ? { lifecycle } : {},
      include: { brand: { include: { contacts: { where: { isDecisionMaker: true }, take: 3 } } } },
      orderBy: { updatedAt: 'desc' },
    })
  },

  async listDeals() {
    return prisma.deal.findMany({ include: { brand: true }, orderBy: { valueCents: 'desc' } })
  },

  async upsertTodo({ id, text, category, owner, done }: any) {
    if (id) return prisma.todo.update({ where: { id }, data: { text, category, owner, done } })
    return prisma.todo.create({ data: { text, category, owner } })
  },
}

// ---------------------------------------------------------------
// Prompting
// ---------------------------------------------------------------

function buildPrompt(target: any, variant: string, voice: any): string {
  const { brand, contact } = target

  const approach = variant === 'identity'
    ? 'Lead with who SB Agency is and concrete proof. Establish credibility first, then the ask.'
    : 'Lead with one specific, easy-to-answer question about their campus plans. Short. Curiosity over credentials.'

  // Without real samples the model has nothing to imitate, so drafts
  // read generic. This is the gap that closes when Zach sends examples.
  const voiceBlock = voice?.samples?.length
    ? `Write as ${voice.name}${voice.role ? `, ${voice.role}` : ''}.
Match the voice in these real messages they have sent. Copy the rhythm,
sentence length, greetings, sign-offs and level of formality. Do not
imitate the content, only the manner:

${voice.samples.map((s: string, i: number) => `--- sample ${i + 1} ---\n${s}`).join('\n\n')}

${voice.guidelines ?? ''}`
    : `Write as Zach from SB Agency. No voice samples have been provided
yet, so keep it plain and direct — avoid marketing language, avoid
adjectives that sound like a brochure.`

  return `You are drafting LinkedIn outreach for SB Agency, which books artists
and DJs for fraternity and sorority events across roughly 789 chapters.

TARGET
Brand: ${brand.name}${brand.category ? ` (${brand.category})` : ''}${brand.tier ? `, ${brand.tier} stage` : ''}
Person: ${contact.name}${contact.title ? `, ${contact.title}` : ''}

${voiceBlock}

APPROACH
${approach}

RULES
- Connection note: under ${CONNECTION_NOTE_MAX} characters. Hard limit.
- First message: under ${FIRST_MESSAGE_MAX} characters. Hard limit.
- Never invent statistics, past clients, or results. If you don't know
  something, leave it out rather than guessing.
- No "I hope this finds you well", no "I wanted to reach out", no
  "circle back", no "synergy", no exclamation-mark enthusiasm.
- Reference something plausibly true about the brand's audience fit.
  Do not fabricate specifics about their campaigns.
- Write like a person typing quickly, not like marketing copy.

Return exactly this format and nothing else:

CONNECTION_NOTE:
<text>

FIRST_MESSAGE:
<text>`
}

function parseDraft(raw: string): { connectionNote: string; firstMessage: string } | null {
  const note = raw.match(/CONNECTION_NOTE:\s*([\s\S]*?)(?=FIRST_MESSAGE:|$)/i)
  const msg = raw.match(/FIRST_MESSAGE:\s*([\s\S]*)$/i)
  if (!note || !msg) return null
  return {
    connectionNote: note[1].trim().slice(0, CONNECTION_NOTE_MAX),
    firstMessage: msg[1].trim().slice(0, FIRST_MESSAGE_MAX),
  }
}

// ---------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const { fn, args } = await req.json()
    const handler = handlers[fn]
    if (!handler) {
      return NextResponse.json({ ok: false, error: `Unknown function: ${fn}` }, { status: 400 })
    }
    const data = await handler(args ?? {})
    return NextResponse.json({ ok: true, data })
  } catch (err: any) {
    console.error('[api/data]', err)
    return NextResponse.json({ ok: false, error: err?.message ?? 'Server error' }, { status: 500 })
  }
}
