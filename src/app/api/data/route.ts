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
import { getServerSession } from 'next-auth'
import Anthropic from '@anthropic-ai/sdk'
import { authOptions, allowlist } from '@/lib/auth'

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
// "Confirmed" = Lead stage 13 and above (so "14 - COMPLETED" keeps
// counting once a show plays out), plus Deal "Offer Confirmed"/"Signed"
// in the current season. Leo's call on 2026-08-11: stages below 13 —
// including "08 - Offer Form Signed" (63 rows) and "12 - Formal Offer
// Sent" — are pipeline, not confirmed. Also excluded: Deal "Offer Out",
// "Declined Pivot", "Canceled", "Refund client", "Rescheduled to Fall",
// and past seasons "2425"/"2526".
const LEAD_CONFIRMED_STAGE_REGEX = '^1[3-9]'
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

// Vercel functions run in UTC, so a naive setHours(0,0,0,0) makes "today"
// start at 7 or 8pm the previous evening for anyone on the east coast —
// which silently handed out a second day's queue every evening.
const WORK_TZ = 'America/New_York'

function startOfLocalDay(now: Date = new Date()): Date {
  // Find today's date in WORK_TZ, then search for the UTC instant whose
  // local rendering is midnight on that date. Subtracting elapsed
  // wall-clock time is simpler but wrong on the two DST changeover days,
  // when the offset at midnight differs from the offset now.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: WORK_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  })
  const read = (d: Date) => {
    const p = fmt.formatToParts(d)
    const g = (t: string) => p.find(x => x.type === t)?.value ?? '0'
    return { ymd: `${g('year')}-${g('month')}-${g('day')}`, hour: Number(g('hour')) % 24 }
  }
  const today = read(now).ymd
  const [y, m, d] = today.split('-').map(Number)
  // US timezones sit between UTC-4 and UTC-10; scan the plausible range.
  for (let offset = 0; offset <= 14; offset++) {
    const candidate = new Date(Date.UTC(y, m - 1, d, offset))
    const r = read(candidate)
    if (r.ymd === today && r.hour === 0) return candidate
  }
  // Unreachable for real timezones, but never let the queue die on it.
  const fallback = new Date(now)
  fallback.setUTCHours(0, 0, 0, 0)
  return fallback
}

// Seed list for the owner dropdown. Not a whitelist — listOwners unions
// this with every distinct owner already in the data, so adding a person
// is just assigning them something, not editing this file.
const SEED_OWNERS = ['Leo', 'Zach', 'Elizabeth']

// The category vocabulary the UI knows how to render. Auto-categorisation
// must return one of these — a made-up key would render as a raw string
// and drop the brand into an unlabelled bucket.
const CATEGORY_KEYS = [
  'beverage', 'nicotine', 'cpg', 'alcohol', 'apparel', 'tech', 'fintech',
  'software', 'beauty', 'apps', 'betting', 'nightlife', 'wellness',
  'qsr', 'home', 'entertainment', 'unresolved',
] as const

const TIER_KEYS = ['emerging', 'growth', 'established'] as const

// Which Claude model writes the drafts.
//
// This was hardcoded to 'claude-sonnet-4-6', which is not a model ID the
// API currently accepts — every "✦ Draft" click would have returned a
// 404 from Anthropic. Set ANTHROPIC_MODEL in Vercel to change it without
// touching this file; the fallbacks below cover the ID being retired
// later, since a model going away should degrade rather than break the
// one feature the app exists for.
const DRAFT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'
const MODEL_FALLBACKS = ['claude-sonnet-5', 'claude-haiku-4-5']

// Tries DRAFT_MODEL, then each fallback, but only when the failure looks
// like "that model doesn't exist". A rate limit or a bad key should
// surface as itself, not be retried against three models in a row.
async function askClaude(prompt: string, maxTokens: number): Promise<{ text: string; model: string }> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const candidates = [DRAFT_MODEL, ...MODEL_FALLBACKS.filter(m => m !== DRAFT_MODEL)]

  let lastErr: any = null
  for (const model of candidates) {
    try {
      const res = await anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      })
      const block = res.content.find(b => b.type === 'text')
      return { text: block && 'text' in block ? block.text : '', model }
    } catch (err: any) {
      lastErr = err
      const notFound = err?.status === 404 || /model/i.test(err?.message ?? '')
      if (!notFound) throw err
      console.warn(`[askClaude] model ${model} rejected, trying next`, err?.message)
    }
  }
  throw lastErr ?? new Error('No usable Claude model')
}

// A sponsorship's status drives its pipeline stage. Kept as a map rather
// than inline so the two vocabularies can diverge later without hunting.
const SPONSOR_STAGE: Record<string, string> = {
  proposed: 'proposal',
  confirmed: 'closed',
  declined: 'lost',
}

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
// Categorisation
// ---------------------------------------------------------------

// Keyword fallback. Deliberately conservative — it would rather return
// "unresolved" and let a human decide than confidently file a brand
// under the wrong category, because a miscategorised brand is invisible
// (nobody browses the category it landed in looking for it).
const CATEGORY_HINTS: Array<[RegExp, string]> = [
  [/energy drink|seltzer water|sparkling water|hydration|electrolyte|soda|coffee|tea\b|juice/i, 'beverage'],
  [/nicotine|pouch|vape|tobacco|zyn/i, 'nicotine'],
  [/vodka|tequila|whiskey|beer|hard seltzer|rtd|spirits|brewing|distill/i, 'alcohol'],
  [/snack|protein bar|jerky|chips|candy|cereal|granola/i, 'cpg'],
  [/apparel|clothing|streetwear|sneaker|footwear|hoodie|denim/i, 'apparel'],
  [/sportsbook|betting|dfs|parlay|casino/i, 'betting'],
  [/bank|card|invest|trading|crypto|payments|fintech/i, 'fintech'],
  [/dating|social app|messaging app/i, 'apps'],
  [/skincare|grooming|deodorant|fragrance|cosmetic|beauty|haircare/i, 'beauty'],
  [/supplement|creatine|fitness|gym|recovery|sleep|wellness|vitamin/i, 'wellness'],
  [/pizza|burger|chicken|taco|restaurant|delivery|qsr|fast food/i, 'qsr'],
  [/tumbler|drinkware|cooler|bottle|furniture|bedding|home/i, 'home'],
  [/headphone|speaker|camera|charger|laptop|phone|gadget/i, 'tech'],
  [/\bai\b|software|saas|platform|app builder/i, 'software'],
  [/festival|concert|nightclub|dj\b|rave|edm/i, 'nightlife'],
  [/label|studio|streaming|sports team|league|esports/i, 'entertainment'],
]

function guessCategory(name: string, hint?: string | null): string {
  const text = `${name} ${hint ?? ''}`
  for (const [pattern, key] of CATEGORY_HINTS) {
    if (pattern.test(text)) return key
  }
  return 'unresolved'
}

// Asks Claude to place a brand, then validates the answer against the
// known vocabulary. An unrecognised category falls back to the keyword
// guess rather than being written through — the model returning
// something plausible-but-unknown is the failure mode to guard against.
async function inferCategory(name: string, hint?: string | null): Promise<{
  category: string
  tier: string | null
  confidence: string
  reasoning: string
  method: 'claude' | 'keywords'
}> {
  const fallback = () => ({
    category: guessCategory(name, hint),
    tier: null,
    confidence: 'low',
    reasoning: 'Matched on keywords — no model call.',
    method: 'keywords' as const,
  })

  if (!process.env.ANTHROPIC_API_KEY) return fallback()

  try {
    const res = await askClaude(`SB Agency books artists and DJs for fraternity and sorority events and sells
sponsorships against those shows. Place this brand in the sponsor-prospecting taxonomy.

Brand: ${name}${hint ? `\nContext supplied by the user: ${hint}` : ''}

Categories (choose exactly one key):
${CATEGORY_KEYS.join(', ')}

Use "unresolved" if you are not reasonably sure which brand this is, or if
the name is ambiguous. Do not guess between two plausible companies.

Tier, by how established the brand is with US college-age consumers:
  emerging     — young, small budget, moving fast
  growth       — scaling, has a real marketing team
  established  — national, large budget, slow process

Return ONLY minified JSON, no markdown fence:
{"category":"<key>","tier":"<tier or null>","confidence":"high|medium|low","reasoning":"<one short sentence>"}`, 400)

    const match = res.text.match(/\{[\s\S]*\}/)
    if (!match) return fallback()

    const parsed = JSON.parse(match[0])
    const category = (CATEGORY_KEYS as readonly string[]).includes(parsed.category)
      ? parsed.category
      : guessCategory(name, hint)
    const tier = (TIER_KEYS as readonly string[]).includes(parsed.tier) ? parsed.tier : null

    return {
      category,
      tier,
      confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low',
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 240) : '',
      method: 'claude',
    }
  } catch (err) {
    // A categorisation failure must never block adding a brand.
    console.error('[inferCategory] falling back to keywords', err)
    return fallback()
  }
}

// ---------------------------------------------------------------
// Sponsorship → pipeline deal
// ---------------------------------------------------------------

// Every sponsorship attachment mirrors into exactly one Deal, so the
// pipeline is a real total rather than something that has to be kept up
// by hand. Deals created this way carry source="sponsorship" and are
// rewritten on each edit; detaching cascades the delete.
async function syncSponsorDeal(sponsorId: string) {
  const s = await prisma.showSponsor.findUnique({
    where: { id: sponsorId },
    include: { brand: { select: { name: true } } },
  })
  if (!s) return null

  const where = [s.school, s.chapter].filter(Boolean).join(' ')
  const eventRef = [where, s.eventDate].filter(Boolean).join(' · ') || 'Unspecified show'
  const name = `${s.brand.name} — ${where || 'show'}`

  return prisma.deal.upsert({
    where: { showSponsorId: s.id },
    create: {
      brandId: s.brandId,
      showSponsorId: s.id,
      name,
      stage: SPONSOR_STAGE[s.status] ?? 'proposal',
      valueCents: s.valueCents,
      eventRef,
      owner: s.owner,
      source: 'sponsorship',
      notes: s.deliverables,
    },
    update: {
      name,
      stage: SPONSOR_STAGE[s.status] ?? 'proposal',
      valueCents: s.valueCents,
      eventRef,
      owner: s.owner,
      notes: s.deliverables,
    },
  })
}

// ---------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------

const handlers: Record<string, Handler> = {

  // -------- dashboard --------

  async getDashboard() {
    const [byStatus, categories, pipeline, todos, sponsorAgg, byOwner] = await Promise.all([
      prisma.target.groupBy({ by: ['status'], _count: true }),
      prisma.brand.groupBy({ by: ['category'], _count: true }),
      prisma.deal.aggregate({
        _sum: { valueCents: true },
        where: { stage: { notIn: ['closed', 'lost'] } },
      }),
      prisma.todo.findMany({ where: { done: false }, orderBy: { createdAt: 'desc' }, take: 25 }),
      // Sponsorship money, split by status. This is a SEPARATE revenue
      // line from booking revenue — what a chapter pays for the artist
      // lives in sb-crm and is deliberately never added to these numbers.
      prisma.showSponsor.groupBy({
        by: ['status'],
        _sum: { valueCents: true },
        _count: true,
      }),
      prisma.showSponsor.groupBy({
        by: ['owner'],
        _sum: { valueCents: true },
        _count: true,
        where: { status: 'confirmed' },
      }),
    ])

    const counts: Record<string, number> = {}
    for (const row of byStatus) counts[row.status] = row._count

    const sponsorship = { confirmedCents: 0, proposedCents: 0, confirmedCount: 0, proposedCount: 0 }
    for (const row of sponsorAgg) {
      const cents = row._sum.valueCents ?? 0
      if (row.status === 'confirmed') {
        sponsorship.confirmedCents = cents
        sponsorship.confirmedCount = row._count
      } else if (row.status === 'proposed') {
        sponsorship.proposedCents = cents
        sponsorship.proposedCount = row._count
      }
    }

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
          WHERE l."stage" ~ $1
          UNION ALL
          SELECT d."id", d."schoolRaw", d."chapterRaw", d."eventDate",
                 s."name" AS "schoolName"
          FROM "Deal" d LEFT JOIN "School" s ON s."id" = d."schoolId"
          WHERE d."season" = $2 AND d."status" = ANY($3::text[])
        `, LEAD_CONFIRMED_STAGE_REGEX, DEAL_CURRENT_SEASON, DEAL_CONFIRMED_STATUS)

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
      sponsorship,
      byOwner: byOwner
        .map(o => ({
          owner: o.owner ?? 'Unassigned',
          count: o._count,
          cents: o._sum.valueCents ?? 0,
        }))
        .sort((a, b) => b.cents - a.cents),
      todos,
    }
  },

  // -------- outreach queue --------

  // The day's send list.
  //
  // The budget is DAILY_SEND_LIMIT actual sends per day, counted from
  // sentAt — not "ten rows stamped once". Two earlier bugs lived here:
  // marking all ten sent immediately handed out ten more (so the limit
  // capped nothing), and anything stamped but not sent yesterday matched
  // neither branch and vanished from the queue forever.
  //
  // Now: unsent work carries over first, and new targets only top up
  // whatever room is left in today's budget.
  async getTodayQueue() {
    const startOfDay = startOfLocalDay()

    const sentToday = await prisma.target.count({ where: { sentAt: { gte: startOfDay } } })
    const room = Math.max(0, DAILY_SEND_LIMIT - sentToday)
    if (room === 0) return []

    const include = {
      brand: true,
      contact: true,
      // Capped: "Redraft" appends two more rows each time, and without a
      // take the row grows a new pair of panels on every click.
      drafts: { orderBy: { createdAt: 'desc' as const }, take: 2 },
    }

    // Already stamped and still not sent — yesterday's leftovers included.
    const carried = await prisma.target.findMany({
      where: { queuedFor: { not: null }, status: { in: ['queued', 'drafted'] } },
      include,
      orderBy: [{ fitScore: 'desc' }, { createdAt: 'asc' }],
      take: room,
    })
    if (carried.length >= room) return carried

    // Includes 'drafted': drafting from the All-targets tab sets the
    // status without stamping queuedFor, and those rows used to match
    // neither branch and never surface in Today again.
    const picks = await prisma.target.findMany({
      where: { status: { in: ['queued', 'drafted'] }, queuedFor: null },
      orderBy: [{ fitScore: 'desc' }, { createdAt: 'asc' }],
      take: room - carried.length,
      select: { id: true },
    })
    if (picks.length === 0) return carried

    await prisma.target.updateMany({
      where: { id: { in: picks.map(p => p.id) } },
      data: { queuedFor: new Date() },
    })

    const fresh = await prisma.target.findMany({
      where: { id: { in: picks.map(p => p.id) } },
      include,
      orderBy: { fitScore: 'desc' },
    })

    return [...carried, ...fresh].sort((a, b) => b.fitScore - a.fitScore)
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

    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set in Vercel — drafting is off.')
    }

    const voice = await prisma.voice.findFirst({ where: { active: true } })

    const drafts = []
    for (const variant of variants) {
      const res = await askClaude(buildPrompt(target, variant, voice), 1000)
      const parsed = parseDraft(res.text)
      if (!parsed) continue

      drafts.push(await prisma.draft.create({
        data: {
          targetId,
          variant,
          connectionNote: parsed.connectionNote,
          firstMessage: parsed.firstMessage,
          voice: voice?.name ?? null,
          // Record which model actually answered, not which one we asked
          // for — they differ when a fallback kicks in.
          model: res.model,
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
    const result = {
      brandsCreated: 0, contactsCreated: 0, targetsCreated: 0, skipped: 0,
      failed: 0, errors: [] as string[],
    }

    for (const row of rows) {
      // Per-row, because one bad row must not abandon the rest halfway
      // through. Contact.externalId is unique, so the same SponsorUnited
      // person listed under two brands used to throw P2002 and kill the
      // whole import with some rows already written.
      try {
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
      } catch (err: any) {
        result.failed++
        if (result.errors.length < 20) {
          result.errors.push(`${row.brandName} / ${row.name}: ${err?.message ?? 'unknown error'}`)
        }
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
             s."name" AS "schoolName", s."city", s."state" AS "schoolState"
      FROM "Lead" l
      LEFT JOIN "School" s ON s."id" = l."schoolId"
      WHERE l."stage" ~ $1

      UNION ALL

      SELECT 'deal' AS "src", d."id", d."status" AS "state",
             d."schoolRaw", d."chapterRaw", d."artist", d."rep",
             d."eventDate", NULL AS "venueName", NULL AS "attendance",
             NULL AS "eventType", NULL AS "ticketing",
             s."name" AS "schoolName", s."city", s."state" AS "schoolState"
      FROM "Deal" d
      LEFT JOIN "School" s ON s."id" = d."schoolId"
      WHERE d."season" = $2 AND d."status" = ANY($3::text[])
    `, LEAD_CONFIRMED_STAGE_REGEX, DEAL_CURRENT_SEASON, DEAL_CONFIRMED_STATUS)

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
      state: r.schoolState,
      sponsors: (byLead[r.id] ?? []).map(l => ({
        brandId: l.brand.id, brandName: l.brand.name, status: l.status,
        valueCents: l.valueCents,
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
  //
  // Each attachment mirrors into a pipeline Deal, so Pipeline fills in
  // by itself instead of needing the same numbers typed twice.
  async attachShows({ brandId, shows, status = 'proposed', valueCents = 0, deliverables, owner }: any) {
    const results = []
    for (const s of shows) {
      const row = await prisma.showSponsor.upsert({
        where: { brandId_crmLeadId: { brandId, crmLeadId: s.id } },
        create: {
          brandId, crmLeadId: s.id,
          school: s.school ?? null, chapter: s.chapter ?? null,
          artist: s.artist ?? null, eventDate: s.eventDate ?? null,
          status, valueCents, deliverables: deliverables ?? null,
          owner: owner ?? null,
        },
        update: { status, valueCents, deliverables: deliverables ?? null, owner: owner ?? null },
      })
      await syncSponsorDeal(row.id)
      results.push(row)
    }

    // A brand you're attaching to shows is at minimum in the network.
    // Only ever upgrades — never demotes an existing partner record.
    await prisma.partner.upsert({
      where: { brandId },
      create: { brandId, lifecycle: status === 'confirmed' ? 'active_partner' : 'in_network', owner: owner ?? null },
      update: status === 'confirmed' ? { lifecycle: 'active_partner' } : {},
    })

    return { attached: results.length }
  },

  async detachShow({ brandId, crmLeadId }: any) {
    // The Deal cascades away with it — see the relation on Deal.
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

  // -------- sponsorships ledger --------

  // Every brand↔show link in one place, which is the record that didn't
  // exist before: you could create an attachment but never see them all.
  async listSponsorships({ status = 'all', brandId, owner, q, take = 500 }: any) {
    const rows = await prisma.showSponsor.findMany({
      where: {
        ...(status && status !== 'all' ? { status } : {}),
        ...(brandId ? { brandId } : {}),
        ...(owner && owner !== 'all' ? { owner } : {}),
        ...(q
          ? {
              OR: [
                { school: { contains: q, mode: 'insensitive' } },
                { chapter: { contains: q, mode: 'insensitive' } },
                { artist: { contains: q, mode: 'insensitive' } },
                { brand: { name: { contains: q, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      include: { brand: { select: { id: true, name: true, category: true, tier: true } } },
      orderBy: [{ createdAt: 'desc' }],
      take,
    })

    // Totals over the FILTERED set, so the number under the heading
    // always describes what's actually on screen.
    const totals = { all: 0, confirmed: 0, proposed: 0, declined: 0 }
    for (const r of rows) {
      totals.all += r.valueCents
      if (r.status in totals) totals[r.status as 'confirmed' | 'proposed' | 'declined'] += r.valueCents
    }

    return { rows, count: rows.length, totals }
  },

  async updateSponsorship({ id, status, valueCents, deliverables, notes, owner }: any) {
    const row = await prisma.showSponsor.update({
      where: { id },
      data: {
        ...(status !== undefined ? { status } : {}),
        ...(valueCents !== undefined ? { valueCents } : {}),
        ...(deliverables !== undefined ? { deliverables } : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(owner !== undefined ? { owner } : {}),
      },
    })
    await syncSponsorDeal(row.id)
    if (status === 'confirmed') {
      await prisma.partner.upsert({
        where: { brandId: row.brandId },
        create: { brandId: row.brandId, lifecycle: 'active_partner', owner: owner ?? null },
        update: { lifecycle: 'active_partner' },
      })
    }
    return row
  },

  async deleteSponsorship({ id }: any) {
    await prisma.showSponsor.delete({ where: { id } })
    return { ok: true }
  },

  // -------- brand detail --------

  // Everything about one brand on one screen: who works there, which
  // shows they sponsor, what that's worth, what outreach has happened.
  async getBrand({ brandId }: any) {
    const brand = await prisma.brand.findUnique({
      where: { id: brandId },
      include: {
        contacts: { orderBy: [{ isDecisionMaker: 'desc' }, { name: 'asc' }] },
        partner: true,
        shows: { orderBy: { createdAt: 'desc' } },
        deals: { orderBy: { valueCents: 'desc' } },
        targets: {
          include: {
            contact: { select: { id: true, name: true, title: true, linkedinUrl: true } },
            drafts: { orderBy: { createdAt: 'desc' }, take: 2 },
          },
          orderBy: { fitScore: 'desc' },
        },
      },
    })
    if (!brand) throw new Error('Brand not found')

    const events = await prisma.targetEvent.findMany({
      where: { target: { brandId } },
      orderBy: { createdAt: 'desc' },
      take: 30,
      include: { target: { include: { contact: { select: { name: true } } } } },
    })

    const money = { confirmedCents: 0, proposedCents: 0 }
    for (const s of brand.shows) {
      if (s.status === 'confirmed') money.confirmedCents += s.valueCents
      else if (s.status === 'proposed') money.proposedCents += s.valueCents
    }

    return { brand, events, money }
  },

  async updateBrand({ brandId, ...fields }: any) {
    const allowed = ['category', 'tier', 'owner', 'notes', 'website', 'linkedinUrl', 'hq'] as const
    const data: Record<string, any> = {}
    for (const key of allowed) {
      if (fields[key] !== undefined) data[key] = fields[key] === '' ? null : fields[key]
    }
    if (Object.keys(data).length === 0) throw new Error('Nothing to update')
    return prisma.brand.update({ where: { id: brandId }, data })
  },

  // -------- add a brand --------

  // Preview the category without committing, so the form can show its
  // guess and let a human override before anything is written.
  async suggestCategory({ name, hint }: any) {
    if (!name) throw new Error('Name required')
    return inferCategory(name, hint)
  },

  // Category is inferred when not supplied. A duplicate name returns the
  // existing brand rather than throwing — adding a brand twice is a
  // normal thing to do by accident and shouldn't read as an error.
  async createBrand({ name, category, tier, website, linkedinUrl, notes, owner, hint }: any) {
    const clean = String(name ?? '').trim()
    if (!clean) throw new Error('Name required')

    const existing = await prisma.brand.findUnique({ where: { name: clean } })
    if (existing) return { brand: existing, created: false, inference: null }

    let inference: any = null
    let finalCategory = category
    let finalTier = tier

    if (!finalCategory) {
      inference = await inferCategory(clean, hint)
      finalCategory = inference.category
      if (!finalTier) finalTier = inference.tier
    }

    const brand = await prisma.brand.create({
      data: {
        name: clean,
        category: finalCategory ?? 'unresolved',
        tier: finalTier ?? null,
        website: website || null,
        linkedinUrl: linkedinUrl || null,
        notes: notes || null,
        owner: owner || null,
        source: 'manual',
      },
    })

    return { brand, created: true, inference }
  },

  // -------- search --------

  // One box over brands, people, sponsorships and live CRM shows.
  async search({ q, take = 12 }: any) {
    const query = String(q ?? '').trim()
    if (query.length < 2) return { q: query, brands: [], contacts: [], sponsorships: [], shows: [] }

    const [brands, contacts, sponsorships] = await Promise.all([
      prisma.brand.findMany({
        where: { name: { contains: query, mode: 'insensitive' } },
        select: { id: true, name: true, category: true, tier: true, _count: { select: { contacts: true, shows: true } } },
        take,
      }),
      prisma.contact.findMany({
        where: {
          OR: [
            { name: { contains: query, mode: 'insensitive' } },
            { title: { contains: query, mode: 'insensitive' } },
            { email: { contains: query, mode: 'insensitive' } },
          ],
        },
        include: { brand: { select: { id: true, name: true } } },
        take,
      }),
      prisma.showSponsor.findMany({
        where: {
          OR: [
            { school: { contains: query, mode: 'insensitive' } },
            { chapter: { contains: query, mode: 'insensitive' } },
            { artist: { contains: query, mode: 'insensitive' } },
            { brand: { name: { contains: query, mode: 'insensitive' } } },
          ],
        },
        include: { brand: { select: { id: true, name: true } } },
        take,
      }),
    ])

    // Live shows from sb-crm. Wrapped so a CRM hiccup degrades this
    // section rather than failing the whole search.
    let shows: any[] = []
    if (CRM_CONNECTED) {
      try {
        const like = `%${query.toLowerCase()}%`
        const rows: any[] = await crm.$queryRawUnsafe(`
          SELECT l."id", l."schoolRaw", l."chapterRaw", l."artist", l."eventDate",
                 s."name" AS "schoolName"
          FROM "Lead" l LEFT JOIN "School" s ON s."id" = l."schoolId"
          WHERE l."stage" ~ $1
            AND (LOWER(COALESCE(s."name", l."schoolRaw", '')) LIKE $4
              OR LOWER(COALESCE(l."chapterRaw", '')) LIKE $4
              OR LOWER(COALESCE(l."artist", '')) LIKE $4)
          UNION ALL
          SELECT d."id", d."schoolRaw", d."chapterRaw", d."artist", d."eventDate",
                 s."name" AS "schoolName"
          FROM "Deal" d LEFT JOIN "School" s ON s."id" = d."schoolId"
          WHERE d."season" = $2 AND d."status" = ANY($3::text[])
            AND (LOWER(COALESCE(s."name", d."schoolRaw", '')) LIKE $4
              OR LOWER(COALESCE(d."chapterRaw", '')) LIKE $4
              OR LOWER(COALESCE(d."artist", '')) LIKE $4)
          LIMIT 40
        `, LEAD_CONFIRMED_STAGE_REGEX, DEAL_CURRENT_SEASON, DEAL_CONFIRMED_STATUS, like)

        const seen = new Map<string, any>()
        for (const r of rows) {
          const key = showKey(r.schoolName || r.schoolRaw, r.chapterRaw, r.eventDate)
          if (!seen.has(key)) {
            seen.set(key, {
              id: r.id,
              school: r.schoolName || r.schoolRaw,
              chapter: r.chapterRaw,
              artist: r.artist,
              eventDate: r.eventDate,
            })
          }
        }
        shows = [...seen.values()].slice(0, take)
      } catch (err) {
        console.error('[search] CRM read failed', err)
      }
    }

    return { q: query, brands, contacts, sponsorships, shows }
  },

  // -------- people --------

  // Seed names unioned with everyone already assigned to something, so
  // the dropdown grows as the team does without a code change.
  async listOwners() {
    const [brands, sponsors, partners] = await Promise.all([
      prisma.brand.findMany({ where: { owner: { not: null } }, select: { owner: true }, distinct: ['owner'] }),
      prisma.showSponsor.findMany({ where: { owner: { not: null } }, select: { owner: true }, distinct: ['owner'] }),
      prisma.partner.findMany({ where: { owner: { not: null } }, select: { owner: true }, distinct: ['owner'] }),
    ])
    const set = new Set<string>(SEED_OWNERS)
    for (const r of [...brands, ...sponsors, ...partners]) if (r.owner) set.add(r.owner)
    return [...set].sort((a, b) => a.localeCompare(b))
  },

  // -------- team access --------

  // Managers are the founding ALLOWED_EMAILS three. Everyone they add
  // here can sign in; removing an email locks that person out on their
  // next sign-in. The founding list itself can only change in Vercel.
  async listTeam() {
    const session = await getServerSession(authOptions)
    const me = session?.user?.email?.toLowerCase() ?? null
    const managers = allowlist()
    const invited = await prisma.allowedEmail.findMany({ orderBy: { createdAt: 'desc' } })
    return { managers, invited, canManage: Boolean(me && managers.includes(me)) }
  },

  async addTeamEmail({ email }: any) {
    const session = await getServerSession(authOptions)
    const me = session?.user?.email?.toLowerCase()
    if (!me || !allowlist().includes(me)) {
      throw new Error('Only the founding members can manage access.')
    }
    const clean = String(email ?? '').trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) throw new Error('That does not look like an email address.')
    if (allowlist().includes(clean)) throw new Error('That person already has founding access.')
    return prisma.allowedEmail.upsert({
      where: { email: clean },
      create: { email: clean, addedBy: me },
      update: {},
    })
  },

  async removeTeamEmail({ email }: any) {
    const session = await getServerSession(authOptions)
    const me = session?.user?.email?.toLowerCase()
    if (!me || !allowlist().includes(me)) {
      throw new Error('Only the founding members can manage access.')
    }
    const clean = String(email ?? '').trim().toLowerCase()
    await prisma.allowedEmail.deleteMany({ where: { email: clean } })
    return { ok: true }
  },

  // Who is signed in, so actions attribute themselves instead of every
  // event being logged as "Zach" regardless of who clicked.
  async getMe() {
    try {
      const session = await getServerSession(authOptions)
      const email = session?.user?.email ?? null
      const name = session?.user?.name ?? null
      // Match the session against the owner list on first name, so
      // "Elizabeth Chen" signs in and owns things as "Elizabeth".
      const first = (name ?? '').split(' ')[0]
      const owner = SEED_OWNERS.find(o => o.toLowerCase() === first.toLowerCase()) ?? name ?? email
      return { email, name, owner }
    } catch {
      return { email: null, name: null, owner: null }
    }
  },

  // -------- crm + pipeline --------

    // Booking funnel: how many leads sit at each stage of sb-crm's 14-step
  // pipeline. Read-only, same convention as the confirmed-shows query above.
  // Booking revenue is reported here because it's the point of the funnel —
  // it is still NOT added into any sponsorship total.
  async getFunnel() {
    const PIPE = [
      '01 - New Lead', '02 - Group Chat Made', '03 - Call Scheduled', '04 - Discovery Done',
      '05 - List Sent', '06 - Names Highlighted', '07 - Avail Check', '08 - Offer Form Signed',
      '09 - DocuSign Sent', '10 - Contract Signed', '11 - Deposit Pending', '12 - Formal Offer Sent',
      '13 - CONFIRMED', '14 - COMPLETED',
    ]
    try {
      const rows: any[] = await crm.$queryRawUnsafe(`
                SELECT stage, SUM(cnt)::int AS count, SUM(val)::float AS value
        FROM (
          SELECT stage AS stage, COUNT(*) AS cnt, COALESCE(SUM(contract), 0) AS val
          FROM "Lead"
          GROUP BY stage
          UNION ALL
          SELECT COALESCE(
                   NULLIF(btrim(stage), ''),
                   CASE lower(btrim(status))
                     WHEN 'offer out'       THEN '12 - Formal Offer Sent'
                     WHEN 'offer confirmed' THEN '13 - CONFIRMED'
                     WHEN 'confirmed'       THEN '13 - CONFIRMED'
                     WHEN 'signed'          THEN '10 - Contract Signed'
                     WHEN 'deposit pending' THEN '11 - Deposit Pending'
                     WHEN 'completed'       THEN '14 - COMPLETED'
                   END
                 ) AS stage,
                 COUNT(*) AS cnt,
                 COALESCE(SUM(contract), 0) AS val
          FROM "Deal"
          WHERE season = 'current' AND source NOT LIKE 'HISTORY%'
          GROUP BY 1
        ) x
        WHERE stage IS NOT NULL
        GROUP BY stage
      `)
      const by: Record<string, any> = {}
      for (const r of rows) by[String(r.stage || '').trim()] = r

      const stages = PIPE.map((s) => {
        const parts = s.split(' - ')
        return {
          stage: s,
          number: parts[0],
          label: parts.slice(1).join(' - '),
          count: by[s]?.count ?? 0,
          value: by[s]?.value ?? 0,
        }
      })
      return {
        ok: true,
        stages,
        total: stages.reduce((a, s) => a + s.count, 0),
        totalValue: stages.reduce((a, s) => a + s.value, 0),
      }
    } catch (e: any) {
      // Degrade gracefully — a CRM hiccup shouldn't break the page.
      return { ok: false, error: e?.message ?? 'Could not reach sb-crm', stages: [] }
    }
  },

  async listPartners({ lifecycle }: any) {
    return prisma.partner.findMany({
      where: lifecycle && lifecycle !== 'all' ? { lifecycle } : {},
      include: { brand: { include: { contacts: { where: { isDecisionMaker: true }, take: 3 } } } },
      orderBy: { updatedAt: 'desc' },
    })
  },

  async updatePartner({ brandId, lifecycle, relationship, owner, notes }: any) {
    return prisma.partner.upsert({
      where: { brandId },
      create: { brandId, lifecycle: lifecycle ?? 'prospect', relationship, owner, notes },
      update: {
        ...(lifecycle !== undefined ? { lifecycle } : {}),
        ...(relationship !== undefined ? { relationship } : {}),
        ...(owner !== undefined ? { owner } : {}),
        ...(notes !== undefined ? { notes } : {}),
      },
    })
  },

  // Add a person by hand — for brands where SponsorUnited has nothing
  // and the name came off LinkedIn instead. Queues a target on the same
  // rule as the bulk import: decision-maker title plus a LinkedIn URL.
  async upsertContact({ id, brandId, name, title, email, location, linkedinUrl, isDecisionMaker }: any) {
    if (id) {
      return prisma.contact.update({
        where: { id },
        data: { name, title, email, location, linkedinUrl, isDecisionMaker },
      })
    }
    if (!brandId || !name) throw new Error('Brand and name required')

    const brand = await prisma.brand.findUnique({ where: { id: brandId } })
    if (!brand) throw new Error('Brand not found')

    const dm = isDecisionMaker ?? looksLikeDecisionMaker(title ?? null)
    const contact = await prisma.contact.create({
      data: {
        brandId, name,
        title: title || null,
        email: email || null,
        location: location || null,
        linkedinUrl: linkedinUrl || null,
        isDecisionMaker: dm,
        source: 'manual',
      },
    })

    if (dm && contact.linkedinUrl) {
      await prisma.target.create({
        data: {
          brandId,
          contactId: contact.id,
          fitScore: scoreFit(contact.title, brand.tier),
          assignedTo: brand.owner ?? null,
        },
      })
    }
    return contact
  },

  async listDeals() {
    const deals = await prisma.deal.findMany({
      include: {
        brand: { select: { id: true, name: true, category: true, tier: true } },
        showSponsor: { select: { id: true, status: true, eventDate: true, deliverables: true } },
      },
      orderBy: { valueCents: 'desc' },
    })

    // Won vs open, kept apart. All of this is sponsorship money — booking
    // revenue is a different line and lives in sb-crm.
    let openCents = 0, wonCents = 0
    for (const d of deals) {
      if (d.stage === 'closed') wonCents += d.valueCents
      else if (d.stage !== 'lost') openCents += d.valueCents
    }
    return { deals, openCents, wonCents }
  },

  // Manual deals only. Deals with source="sponsorship" are rewritten from
  // their attachment on every sync, so editing one here would be silently
  // undone — updateSponsorship is the right door for those.
  async upsertDeal({ id, brandId, name, stage, valueCents, eventRef, notes, owner }: any) {
    if (id) {
      const existing = await prisma.deal.findUnique({ where: { id } })
      if (existing?.source === 'sponsorship') {
        throw new Error('This deal is generated from a sponsorship — edit the sponsorship instead.')
      }
      return prisma.deal.update({
        where: { id },
        data: { name, stage, valueCents, eventRef, notes, owner },
      })
    }
    if (!brandId || !name) throw new Error('Brand and name required')
    return prisma.deal.create({
      data: {
        brandId, name,
        stage: stage ?? 'conversation',
        valueCents: valueCents ?? 0,
        eventRef: eventRef ?? null,
        notes: notes ?? null,
        owner: owner ?? null,
        source: 'manual',
      },
    })
  },

  async deleteDeal({ id }: any) {
    const existing = await prisma.deal.findUnique({ where: { id } })
    if (existing?.source === 'sponsorship') {
      throw new Error('Detach the show instead — this deal is generated from a sponsorship.')
    }
    await prisma.deal.delete({ where: { id } })
    return { ok: true }
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
