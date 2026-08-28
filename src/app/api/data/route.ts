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
import {
  emailStatus, listEmailQueue, draftDailyEmails,
  sendApprovedEmails, checkReplies, suggestForDraft, sendTestEmail,
  setDraftRecipients, sendOneEmail, approveAllDrafts, draftBrandIntro,
  emailDifferentContact, draftFinalNudge, draftReplyResponse, sendReplyEmail,
} from '@/lib/email'
import { syncNotionDeals } from '@/lib/notion'

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

// AI-or-template: returns null when the API account can't pay (or has no
// key), so callers can fall back to a deterministic document instead of
// failing. Any other error still surfaces.
async function tryClaude(prompt: string, maxTokens: number): Promise<{ text: string; model: string } | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null
  try {
    return await askClaude(prompt, maxTokens)
  } catch (err: any) {
    if (/credit balance|billing|purchase credits/i.test(String(err?.message ?? ''))) return null
    throw err
  }
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

// How many people we actually pursue per brand. A brand pull can surface
// ten marketing contacts; we only want the best few in the send queue so
// outreach stays focused and the weekly LinkedIn cap isn't blown on one
// brand. The rest are "shelved" — kept, visible, promotable, just not
// queued. Leo's call: top 3 by fit.
const TARGET_CAP_PER_BRAND = 3

// Enforces the cap for one brand. Among the currently-active targets
// (queued/drafted, not already shelved), keeps the highest-fit few and
// shelves the rest. Already-contacted people (anyone with a sentAt) count
// against the cap — reaching four people at a brand because three were
// already messaged isn't the intent.
//
// Shelve-only by design: it never auto-promotes a shelved person, so a
// deliberate manual shelve is never silently undone by a later retrim.
// Promoting is always an explicit act (setTargetShelved). Idempotent.
async function reconcileBrandTargets(brandId: string, perBrand = TARGET_CAP_PER_BRAND) {
  const worked = await prisma.target.count({
    where: { brandId, sentAt: { not: null } },
  })
  const room = Math.max(0, perBrand - worked)

  const active = await prisma.target.findMany({
    where: { brandId, status: { in: ['queued', 'drafted'] }, shelved: false },
    orderBy: [{ fitScore: 'desc' }, { createdAt: 'asc' }],
    select: { id: true },
  })

  const shelve = active.slice(room).map(t => t.id)
  if (shelve.length) {
    await prisma.target.updateMany({ where: { id: { in: shelve } }, data: { shelved: true } })
  }
  return {
    active: Math.min(active.length, room),
    shelvedNow: shelve.length,
  }
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
      // Only active targets — shelved ones (parked by the per-brand cap)
      // shouldn't inflate the headline "Targets" / "Queued" numbers, since
      // they're deliberately not being worked.
      prisma.target.groupBy({ by: ['status'], _count: true, where: { shelved: false } }),
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
    // Shelved targets (parked by the per-brand cap) never enter the queue.
    const carried = await prisma.target.findMany({
      where: { queuedFor: { not: null }, status: { in: ['queued', 'drafted'] }, shelved: false },
      include,
      orderBy: [{ fitScore: 'desc' }, { createdAt: 'asc' }],
      take: room,
    })
    if (carried.length >= room) return carried

    // Includes 'drafted': drafting from the All-targets tab sets the
    // status without stamping queuedFor, and those rows used to match
    // neither branch and never surface in Today again.
    const picks = await prisma.target.findMany({
      where: { status: { in: ['queued', 'drafted'] }, queuedFor: null, shelved: false },
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

  async listTargets({ status, category, search, take = 200, shelved = false }: any) {
    return prisma.target.findMany({
      where: {
        // Shelved targets (parked by the per-brand cap) are hidden unless
        // explicitly asked for, so the outreach list shows the real queue.
        ...(shelved === 'any' ? {} : { shelved: !!shelved }),
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

  async setTargetStatus({ targetId, status, actor, nextStep, followUpAt, clearFollowUp }: any) {
    const before = await prisma.target.findUnique({ where: { id: targetId } })
    if (!before) throw new Error('Target not found')

    const now = new Date()
    const updated = await prisma.target.update({
      where: { id: targetId },
      data: {
        ...(status ? { status } : {}),
        ...(status === 'sent' && !before.sentAt ? { sentAt: now } : {}),
        ...(status === 'replied' && !before.repliedAt ? { repliedAt: now } : {}),
        // Follow-up layer. clearFollowUp wipes it (e.g. when a deal closes);
        // otherwise set whatever was passed.
        ...(nextStep !== undefined ? { nextStep: nextStep || null } : {}),
        ...(clearFollowUp ? { nextStep: null, followUpAt: null }
          : followUpAt !== undefined ? { followUpAt: followUpAt ? new Date(followUpAt) : null } : {}),
      },
      include: { brand: true, contact: true },
    })

    // Audit trail — only when the status actually changed (this handler is
    // also used to set a next step without moving the deal).
    if (status && status !== before.status) {
      await prisma.targetEvent.create({
        data: {
          targetId,
          kind: 'status',
          fromStatus: before.status,
          toStatus: status,
          actor: actor ?? null,
          detail: nextStep || null,
        },
      })
    }

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

  // The "Needs action today" list — the follow-up layer's payoff. A target
  // needs action when it isn't dead/won and either its follow-up is due (or
  // overdue), or a reply came in that hasn't been given a next step yet.
  async getActionQueue() {
    const endOfToday = new Date(startOfLocalDay().getTime() + 24 * 60 * 60 * 1000)
    const now = new Date()

    const targets = await prisma.target.findMany({
      where: {
        status: { notIn: ['converted', 'declined', 'dead'] },
        OR: [
          { followUpAt: { lte: endOfToday } },
          { AND: [{ status: 'replied' }, { followUpAt: null }] },
        ],
      },
      include: {
        brand: { select: { id: true, name: true, category: true } },
        contact: { select: { name: true, title: true, linkedinUrl: true } },
      },
      orderBy: [{ followUpAt: 'asc' }, { repliedAt: 'asc' }],
      take: 100,
    })

    const items = targets.map(t => {
      const due = t.followUpAt != null
      return {
        targetId: t.id,
        brandId: t.brandId,
        brandName: t.brand.name,
        category: t.brand.category,
        contactName: t.contact.name,
        contactTitle: t.contact.title,
        linkedinUrl: t.contact.linkedinUrl,
        status: t.status,
        nextStep: t.nextStep,
        followUpAt: t.followUpAt,
        overdue: due && t.followUpAt! < now,
        reason: due ? 'followup' : 'reply',
      }
    })
    return { count: items.length, items }
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
      brandsCreated: 0, contactsCreated: 0, targetsCreated: 0, targetsShelved: 0,
      skipped: 0, failed: 0, errors: [] as string[],
    }

    // Every brand a row touched, so the cap can be applied once per brand
    // at the end rather than after each contact.
    const touched = new Set<string>()

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
      touched.add(brand.id)

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

    // Apply the per-brand cap. Targets were created for everyone who
    // qualifies; this shelves all but the top few per brand so only the
    // best land in the queue.
    for (const brandId of touched) {
      try {
        const r = await reconcileBrandTargets(brandId)
        result.targetsShelved += r.shelvedNow
      } catch { /* one brand's cap failing must not fail the import */ }
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

  // The FULL sb-crm lead table — every stage, not just confirmed. Read
  // only: this is a window into the booking pipeline so nobody has to
  // switch apps to see where a show stands. Nothing here ever writes back.
  async listAllLeads({ take = 500 }: any) {
    if (!CRM_CONNECTED) return { connected: false, leads: [] }
    const limit = Math.max(1, Math.min(1000, Number(take) || 500))
    const rows: any[] = await crm.$queryRawUnsafe(`
      SELECT l."id", l."stage", l."schoolRaw", l."chapterRaw", l."artist",
             l."rep", l."eventDate", s."name" AS "schoolName"
      FROM "Lead" l
      LEFT JOIN "School" s ON s."id" = l."schoolId"
      ORDER BY l."stage" DESC, l."eventDate" ASC NULLS LAST
      LIMIT ${limit}
    `)
    const leads = rows.map(r => ({
      id: r.id,
      stage: r.stage,
      school: r.schoolName || r.schoolRaw,
      chapter: r.chapterRaw,
      artist: r.artist,
      rep: r.rep,
      eventDate: r.eventDate,
    }))
    // Stage counts for the header line, biggest stage first.
    const byStage: Record<string, number> = {}
    for (const l of leads) byStage[l.stage ?? 'unknown'] = (byStage[l.stage ?? 'unknown'] ?? 0) + 1
    return { connected: true, total: leads.length, byStage, leads }
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

  // One deal, many shows. "Alec's Ice Cream — $10k for the fall, these 4
  // shows." The total is split across the shows in exact cents (remainder
  // on the first), each link mirrors into its own pipeline deal via the
  // usual sync, and every show involved lists the brand as its sponsor —
  // so Pipeline, the Sponsorships ledger, and the Shows tab all agree
  // without anything being typed twice.
  async createDealPackage({ brandId, description, duration, totalCents = 0, status = 'proposed', owner, shows = [] }: any) {
    const brand = await prisma.brand.findUnique({ where: { id: brandId } })
    if (!brand) throw new Error('Brand not found')
    if (!Array.isArray(shows) || shows.length === 0) throw new Error('Pick at least one show')

    const total = Math.max(0, Math.round(Number(totalCents) || 0))
    const base = Math.floor(total / shows.length)
    let remainder = total - base * shows.length

    const results = []
    for (const s of shows) {
      const cents = base + (remainder > 0 ? 1 : 0)
      if (remainder > 0) remainder--
      const row = await prisma.showSponsor.upsert({
        where: { brandId_crmLeadId: { brandId, crmLeadId: s.id } },
        create: {
          brandId, crmLeadId: s.id,
          school: s.school ?? null, chapter: s.chapter ?? null,
          artist: s.artist ?? null, eventDate: s.eventDate ?? null,
          status, valueCents: cents,
          deliverables: description || null,
          notes: duration ? `Duration: ${duration}` : null,
          owner: owner ?? null,
        },
        update: {
          status, valueCents: cents,
          deliverables: description || null,
          notes: duration ? `Duration: ${duration}` : null,
          owner: owner ?? null,
        },
      })
      await syncSponsorDeal(row.id)
      results.push(row)
    }

    await prisma.partner.upsert({
      where: { brandId },
      create: { brandId, lifecycle: status === 'confirmed' ? 'active_partner' : 'in_network', owner: owner ?? null },
      update: status === 'confirmed' ? { lifecycle: 'active_partner' } : {},
    })

    return { attached: results.length, totalCents: total, brandName: brand.name }
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

  // Permanently remove a brand — for junk or misnamed rows. Two-step by
  // design: called without confirm, it returns a summary of everything
  // that would go with it (contacts, targets, attached shows and their
  // money, deals) so the UI can show it before anything is destroyed.
  // Cascades handle the children — see onDelete: Cascade on each relation.
  async deleteBrand({ brandId, confirm = false }: any) {
    const brand = await prisma.brand.findUnique({
      where: { id: brandId },
      include: {
        _count: { select: { contacts: true, targets: true, shows: true, deals: true } },
        shows: { select: { valueCents: true } },
      },
    })
    if (!brand) throw new Error('Brand not found')

    const attachedCents = brand.shows.reduce((sum, s) => sum + s.valueCents, 0)
    const summary = {
      name: brand.name,
      contacts: brand._count.contacts,
      targets: brand._count.targets,
      shows: brand._count.shows,
      deals: brand._count.deals,
      attachedCents,
    }

    if (!confirm) return { deleted: false, summary }

    await prisma.brand.delete({ where: { id: brandId } })
    return { deleted: true, summary }
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
        shows: {
          orderBy: { createdAt: 'desc' },
          include: { deliverableItems: { orderBy: { createdAt: 'asc' } } },
        },
        deals: { orderBy: { valueCents: 'desc' } },
        documents: { orderBy: { createdAt: 'desc' } },
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
    const allowed = ['category', 'tier', 'owner', 'notes', 'goals', 'website', 'linkedinUrl', 'hq', 'externalId'] as const
    const data: Record<string, any> = {}
    for (const key of allowed) {
      if (fields[key] !== undefined) data[key] = fields[key] === '' ? null : fields[key]
    }
    if (fields.doNotEmail !== undefined) data.doNotEmail = !!fields.doNotEmail
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
  async upsertContact({ id, brandId, name, title, email, phone, location, linkedinUrl, isDecisionMaker }: any) {
    if (id) {
      return prisma.contact.update({
        where: { id },
        data: { name, title, email, phone, location, linkedinUrl, isDecisionMaker },
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
        phone: phone || null,
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
      // A manual add is deliberate, so the person goes straight into the
      // queue even if the brand already has its three — the cap governs
      // bulk pulls, not a hand-picked contact. They can be shelved later.
    }
    return contact
  },

  // -------- per-brand target cap --------

  // Re-applies the top-N-per-brand cap across every brand at once. Used to
  // trim a queue that grew too large (e.g. after a big pull queued ten
  // people per brand). Preview by default — pass apply:true to commit.
  // Nothing is deleted; extras are shelved and stay promotable.
  async retrimTargets({ perBrand = TARGET_CAP_PER_BRAND, apply = false }: any) {
    const cap = Math.max(1, Number(perBrand) || TARGET_CAP_PER_BRAND)
    const brands = await prisma.brand.findMany({ select: { id: true, name: true } })

    let activeBefore = 0, wouldShelve = 0, brandsAffected = 0
    const sample: Array<{ brand: string; active: number; keep: number; shelve: number }> = []

    for (const b of brands) {
      const worked = await prisma.target.count({
        where: { brandId: b.id, sentAt: { not: null } },
      })
      const room = Math.max(0, cap - worked)
      const openActive = await prisma.target.count({
        where: { brandId: b.id, status: { in: ['queued', 'drafted'] }, shelved: false },
      })
      activeBefore += openActive
      const over = Math.max(0, openActive - room)
      if (over > 0) {
        wouldShelve += over
        brandsAffected++
        if (sample.length < 50) {
          sample.push({ brand: b.name, active: openActive, keep: Math.min(openActive, room), shelve: over })
        }
      }
      if (apply) await reconcileBrandTargets(b.id, cap)
    }

    sample.sort((a, b) => b.shelve - a.shelve)
    return {
      apply, perBrand: cap,
      brandsScanned: brands.length,
      brandsAffected,
      activeBefore,
      shelved: wouldShelve,
      activeAfter: activeBefore - wouldShelve,
      sample,
    }
  },

  // "I want to reach out to THIS brand." Hand-picks a brand into today's
  // queue: takes its best-fit reachable person (LinkedIn required, decision
  // makers first), revives or creates their target, unshelves it, and
  // stamps queuedFor so it surfaces in Today immediately — a deliberate
  // pick always jumps the line, cap or no cap.
  async queueBrandTargets({ brandId }: any) {
    const brand = await prisma.brand.findUnique({
      where: { id: brandId },
      include: {
        contacts: {
          where: { linkedinUrl: { not: null } },
          orderBy: { isDecisionMaker: 'desc' },
        },
        targets: { include: { contact: { select: { name: true } } } },
      },
    })
    if (!brand) throw new Error('Brand not found')

    // Already actively in the pipeline? Say so instead of double-queuing.
    const live = brand.targets.find(t => !t.shelved && ['queued', 'drafted', 'sent', 'replied'].includes(t.status))
    if (live) {
      return { queued: false, reason: 'already', contactName: live.contact.name, status: live.status }
    }

    // A shelved or dormant target to revive, best fit first.
    const revivable = brand.targets
      .filter(t => ['queued', 'drafted'].includes(t.status))
      .sort((a, b) => b.fitScore - a.fitScore)[0]
    if (revivable) {
      await prisma.target.update({
        where: { id: revivable.id },
        data: { shelved: false, queuedFor: new Date() },
      })
      return { queued: true, contactName: revivable.contact.name, revived: true }
    }

    // No target yet — create one from the best reachable contact.
    const targeted = new Set(brand.targets.map(t => t.contactId))
    const pick = brand.contacts
      .filter(c => !targeted.has(c.id))
      .sort((a, b) => scoreFit(b.title, brand.tier) - scoreFit(a.title, brand.tier))[0]
    if (!pick) {
      throw new Error(brand.contacts.length === 0
        ? `${brand.name} has no contacts with a LinkedIn URL yet — add one or pull from SponsorUnited first.`
        : `${brand.name} has no one left to queue — everyone reachable was already contacted.`)
    }
    const t = await prisma.target.create({
      data: {
        brandId, contactId: pick.id,
        fitScore: scoreFit(pick.title, brand.tier),
        assignedTo: brand.owner ?? null,
        queuedFor: new Date(),
      },
    })
    return { queued: true, contactName: pick.name, targetId: t.id }
  },

  // Flip one target in or out of the queue by hand. Promoting past the
  // cap is allowed — it's an explicit choice, and the next bulk retrim
  // would reconsider it.
  async setTargetShelved({ targetId, shelved }: any) {
    return prisma.target.update({
      where: { id: targetId },
      data: { shelved: !!shelved },
    })
  },

  // -------- brands with no contacts --------

  // The "Needs contact info" tab: brands where we have nobody to reach.
  // These are the gaps to fill by hand or by another SponsorUnited pull.
  async listNeedsContact() {
    const brands = await prisma.brand.findMany({
      include: { _count: { select: { contacts: true } } },
      orderBy: { name: 'asc' },
    })
    const missing = brands
      .filter(b => b._count.contacts === 0)
      .map(b => ({
        id: b.id, name: b.name, category: b.category, tier: b.tier,
        website: b.website, linkedinUrl: b.linkedinUrl,
      }))
    return { count: missing.length, total: brands.length, brands: missing }
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

  // -------- rate card / valuation --------

  async getRateCard() {
    const row = await prisma.setting.findUnique({ where: { key: 'rateCard' } })
    if (!row) return { perAttendeeCents: 0, packages: [] as any[] }
    try {
      const v = JSON.parse(row.value)
      return { perAttendeeCents: v.perAttendeeCents ?? 0, packages: Array.isArray(v.packages) ? v.packages : [] }
    } catch {
      return { perAttendeeCents: 0, packages: [] as any[] }
    }
  },

  async saveRateCard({ perAttendeeCents = 0, packages = [] }: any) {
    const value = JSON.stringify({
      perAttendeeCents: Math.max(0, Math.round(Number(perAttendeeCents) || 0)),
      // Each package: { name, cents, deliverables }
      packages: (Array.isArray(packages) ? packages : []).map((p: any) => ({
        name: String(p.name ?? '').slice(0, 60),
        cents: Math.max(0, Math.round(Number(p.cents) || 0)),
        deliverables: String(p.deliverables ?? '').slice(0, 300),
      })).filter((p: any) => p.name),
    })
    await prisma.setting.upsert({
      where: { key: 'rateCard' },
      create: { key: 'rateCard', value },
      update: { value },
    })
    return { ok: true }
  },

  // -------- fulfillment deliverables --------

  async addDeliverable({ showSponsorId, text }: any) {
    if (!showSponsorId || !text) throw new Error('Show and text required')
    return prisma.deliverable.create({ data: { showSponsorId, text: String(text).slice(0, 200) } })
  },

  async updateDeliverable({ id, done, proofUrl, text }: any) {
    return prisma.deliverable.update({
      where: { id },
      data: {
        ...(done !== undefined ? { done: !!done } : {}),
        ...(proofUrl !== undefined ? { proofUrl: proofUrl || null } : {}),
        ...(text !== undefined ? { text: String(text).slice(0, 200) } : {}),
      },
    })
  },

  async deleteDeliverable({ id }: any) {
    await prisma.deliverable.delete({ where: { id } })
    return { ok: true }
  },

  // Bootstraps the checklist from the free-text deliverables on the
  // sponsorship (comma or newline separated), if it has none yet.
  async seedDeliverables({ showSponsorId }: any) {
    const existing = await prisma.deliverable.count({ where: { showSponsorId } })
    if (existing > 0) return { created: 0 }
    const sp = await prisma.showSponsor.findUnique({ where: { id: showSponsorId } })
    if (!sp?.deliverables) return { created: 0 }
    const items = sp.deliverables.split(/[,\n;]+/).map(s => s.trim()).filter(Boolean)
    for (const text of items) {
      await prisma.deliverable.create({ data: { showSponsorId, text: text.slice(0, 200) } })
    }
    return { created: items.length }
  },

  // -------- proposal + recap generators --------

  async generateProposal({ brandId, shows = [], packageName, valueCents, extra, __user }: any) {
    const brand = await prisma.brand.findUnique({ where: { id: brandId } })
    if (!brand) throw new Error('Brand not found')

    const showLines = (shows as any[]).map(s =>
      `- ${[s.school, s.chapter].filter(Boolean).join(' · ')}` +
      `${s.eventDate ? `, ${s.eventDate}` : ''}` +
      `${s.artist ? `, artist: ${s.artist}` : ''}` +
      `${s.attendance ? `, ~${s.attendance} attendees` : ''}`
    ).join('\n') || '(no specific shows selected)'

    const dollars = valueCents ? `$${(valueCents / 100).toLocaleString('en-US')}` : 'to be discussed'

    const prompt = [
      `You are a sponsorship sales rep at SB Agency, which books artists and DJs for US college fraternity and sorority events and sells brands the chance to activate at those shows (sampling, banners, product seeding, title sponsorship).`,
      `SB AGENCY FACTS you may cite: 500+ shows/year; 100+ tier-1 college markets; 100+ Greek life campus networks; fully customizable programs; in-house photo/video production with full commercial asset rights; data-backed post-campaign recaps.`,
      `Write a concise, tailored sponsorship PROPOSAL (max ~500 words, markdown) to pitch this brand. Do NOT use generic tier packages — tailor it to what THIS brand wants.`,
      ``,
      `BRAND: ${brand.name}${brand.category ? ` (${brand.category})` : ''}`,
      brand.goals ? `WHAT THEY WANT (from discovery): ${brand.goals}` : `WHAT THEY WANT: unknown — infer likely goals for this kind of brand reaching college students.`,
      `SHOWS ON OFFER:\n${showLines}`,
      packageName ? `PACKAGE: ${packageName}` : ``,
      `INVESTMENT: ${dollars}`,
      extra ? `EXTRA CONTEXT: ${extra}` : ``,
      ``,
      `Structure: a one-line hook tied to their goal; why this audience fits them; the specific shows + what they get; the investment; a clear next step. Frame a win for the brand, the chapter, and the students. Warm and direct, not corporate. Output markdown only, no preamble.`,
    ].filter(Boolean).join('\n')

    let res = await tryClaude(prompt, 1200)
    if (!res) {
      // Template proposal — no AI, all real data.
      res = {
        model: 'template',
        text: [
          `# ${brand.name} × SB Agency — Sponsorship Proposal`,
          ``,
          `**Who we are.** SB Agency is the nation's largest collegiate concert producer: 500+ shows a year across 100+ tier-1 college markets, run through our own Greek life campus networks, with in-house photo/video production and full commercial asset rights on every show.`,
          ``,
          `**Why ${brand.name}.** Our audiences put your brand directly inside the room with thousands of high-intent students at peak energy — sampling, signage, product seeding, ambassadors, and the content wave that follows every show.`,
          ``,
          `**The shows on offer**`,
          showLines,
          ``,
          packageName ? `**Package:** ${packageName}` : `**Program:** fully customizable — built around your goals.`,
          `**Investment:** ${dollars}`,
          extra ? `\n**Notes:** ${extra}` : ``,
          ``,
          `**What you get.** On-site activation at each show, brand integration in event promotion, all professional photo/video with full rights, and a data-backed recap (reach, sampling counts, impressions) after every event.`,
          ``,
          `**Next step.** A 15-minute call to tailor this to ${brand.name}'s goals for the semester — we'll bring concrete ideas.`,
        ].filter(l => l !== '').join('\n'),
      }
    }
    const title = `Proposal — ${brand.name}${packageName ? ` (${packageName})` : ''}`
    const doc = await prisma.document.create({
      data: { brandId, kind: 'proposal', title, content: res.text, model: res.model, author: __user ?? null },
    })
    return doc
  },

  async generateRecap({ showSponsorId, attendance, extra, __user }: any) {
    const sp = await prisma.showSponsor.findUnique({
      where: { id: showSponsorId },
      include: { brand: true, deliverableItems: { orderBy: { createdAt: 'asc' } } },
    })
    if (!sp) throw new Error('Sponsorship not found')

    // Best-effort attendance from sb-crm if not supplied.
    let att = attendance
    if (!att && CRM_CONNECTED) {
      try {
        const rows: any[] = await crm.$queryRawUnsafe(
          `SELECT "attendance" FROM "Lead" WHERE "id" = $1 LIMIT 1`, sp.crmLeadId)
        att = rows?.[0]?.attendance ?? null
      } catch { /* ignore */ }
    }

    const delivered = sp.deliverableItems.filter(d => d.done)
    const pending = sp.deliverableItems.filter(d => !d.done)
    const delivLines = sp.deliverableItems.length
      ? sp.deliverableItems.map(d => `- [${d.done ? 'x' : ' '}] ${d.text}${d.proofUrl ? ` (proof: ${d.proofUrl})` : ''}`).join('\n')
      : (sp.deliverables ? sp.deliverables : '(no deliverables recorded)')

    const prompt = [
      `You are a sponsorship account rep at SB Agency (books artists/DJs for college fraternity & sorority events; sells brands activation at those shows).`,
      `Write a short, upbeat post-event RECAP (max ~400 words, markdown) to send the sponsor, proving what they got and setting up a renewal for next season.`,
      ``,
      `BRAND: ${sp.brand.name}`,
      `SHOW: ${[sp.school, sp.chapter].filter(Boolean).join(' · ')}${sp.eventDate ? `, ${sp.eventDate}` : ''}${sp.artist ? `, artist ${sp.artist}` : ''}`,
      att ? `ATTENDANCE: ~${att} students` : ``,
      `INVESTMENT: $${(sp.valueCents / 100).toLocaleString('en-US')}`,
      `DELIVERABLES:\n${delivLines}`,
      delivered.length ? `(${delivered.length} delivered, ${pending.length} outstanding)` : ``,
      extra ? `EXTRA CONTEXT / RESULTS: ${extra}` : ``,
      ``,
      `Structure: a warm thank-you; what was delivered (make it feel valuable, reference attendance/energy); a soft results/impressions note; a clear invitation to run it back next season. Do not invent hard metrics you weren't given. Output markdown only, no preamble.`,
    ].filter(Boolean).join('\n')

    let res = await tryClaude(prompt, 1000)
    if (!res) {
      res = {
        model: 'template',
        text: [
          `# Recap — ${sp.brand.name} × SB Agency`,
          ``,
          `Thank you for partnering with us${sp.school ? ` at ${[sp.school, sp.chapter].filter(Boolean).join(' · ')}` : ''}${sp.eventDate ? ` (${sp.eventDate})` : ''}${sp.artist ? ` featuring ${sp.artist}` : ''}. The room was electric — exactly the environment this partnership was built for.`,
          ``,
          att ? `**Attendance:** ~${att} students` : ``,
          `**Investment:** $${(sp.valueCents / 100).toLocaleString('en-US')}`,
          ``,
          `**Delivered**`,
          delivLines,
          ``,
          `Every professional photo and video from the night is yours with full commercial rights — we'll send the asset folder separately.`,
          ``,
          `We'd love to run it back next semester — same energy, bigger footprint. Let's find 15 minutes to talk about what's next.`,
        ].filter(l => l !== '').join('\n'),
      }
    }
    const title = `Recap — ${sp.brand.name} @ ${[sp.school, sp.chapter].filter(Boolean).join(' ') || 'show'}`
    const doc = await prisma.document.create({
      data: { brandId: sp.brandId, showSponsorId, kind: 'recap', title, content: res.text, model: res.model, author: __user ?? null },
    })
    return doc
  },

  async listDocuments({ brandId, kind }: any) {
    return prisma.document.findMany({
      where: { ...(brandId ? { brandId } : {}), ...(kind ? { kind } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
  },

  async deleteDocument({ id }: any) {
    await prisma.document.delete({ where: { id } })
    return { ok: true }
  },

  // -------- results / analytics --------

  // The outreach funnel and what's working, computed brand-level so one
  // brand emailed five times still counts once. Feeds the Results tab.
  async getOutreachAnalytics() {
    const sent = await prisma.emailMessage.findMany({
      where: { direction: 'out', status: 'sent' },
      select: {
        id: true, kind: true, opens: true, sentAt: true,
        target: { select: { brandId: true, brand: { select: { category: true } } } },
      },
    })
    const replies = await prisma.emailMessage.findMany({
      where: { direction: 'in' },
      select: { createdAt: true, target: { select: { brandId: true, brand: { select: { category: true } } } } },
    })
    const deals = await prisma.deal.findMany({ select: { brandId: true, stage: true, valueCents: true } })

    // Brand-level funnel.
    const emailed = new Set(sent.map(m => m.target.brandId))
    const opened = new Set(sent.filter(m => m.opens > 0).map(m => m.target.brandId))
    const replied = new Set(replies.map(m => m.target.brandId))
    const inPipeline = new Set(deals.filter(d => !['lost'].includes(d.stage)).map(d => d.brandId))
    const won = new Set(deals.filter(d => d.stage === 'closed').map(d => d.brandId))

    // Per category: emails sent / brands opened / brands replied.
    const byCat: Record<string, { sent: number; openedBrands: Set<string>; repliedBrands: Set<string>; brands: Set<string> }> = {}
    const catOf = (m: any) => m.target.brand.category || 'uncategorized'
    for (const m of sent) {
      const c = catOf(m)
      byCat[c] = byCat[c] || { sent: 0, openedBrands: new Set(), repliedBrands: new Set(), brands: new Set() }
      byCat[c].sent++
      byCat[c].brands.add(m.target.brandId)
      if (m.opens > 0) byCat[c].openedBrands.add(m.target.brandId)
    }
    for (const m of replies) {
      const c = catOf(m)
      byCat[c] = byCat[c] || { sent: 0, openedBrands: new Set(), repliedBrands: new Set(), brands: new Set() }
      byCat[c].repliedBrands.add(m.target.brandId)
    }
    const categories = Object.entries(byCat).map(([category, v]) => ({
      category, sent: v.sent, brands: v.brands.size,
      opened: v.openedBrands.size, replied: v.repliedBrands.size,
      replyRate: v.brands.size ? Math.round((v.repliedBrands.size / v.brands.size) * 100) : 0,
    })).sort((a, b) => b.sent - a.sent)

    // Last 8 weeks, Monday-anchored buckets.
    const weekOf = (d: Date) => {
      const t = new Date(d)
      const day = (t.getUTCDay() + 6) % 7   // Mon=0
      t.setUTCDate(t.getUTCDate() - day)
      t.setUTCHours(0, 0, 0, 0)
      return t.getTime()
    }
    const now = Date.now()
    const weeks: { start: number; label: string; sent: number; replies: number }[] = []
    for (let i = 7; i >= 0; i--) {
      const start = weekOf(new Date(now - i * 7 * 24 * 60 * 60 * 1000))
      const d = new Date(start)
      weeks.push({ start, label: `${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${d.getUTCDate()}`, sent: 0, replies: 0 })
    }
    const bucket = (ts: Date | null) => {
      if (!ts) return null
      const w = weekOf(new Date(ts))
      return weeks.find(x => x.start === w) ?? null
    }
    for (const m of sent) { const w = bucket(m.sentAt); if (w) w.sent++ }
    for (const m of replies) { const w = bucket(m.createdAt); if (w) w.replies++ }

    const sentTotal = sent.length
    const openedMsgs = sent.filter(m => m.opens > 0).length
    return {
      totals: {
        emailsSent: sentTotal,
        openRate: sentTotal ? Math.round((openedMsgs / sentTotal) * 100) : 0,
        replyRate: emailed.size ? Math.round((replied.size / emailed.size) * 100) : 0,
        totalReplies: replies.length,
      },
      funnel: [
        { label: 'Brands emailed', n: emailed.size },
        { label: 'Opened', n: opened.size },
        { label: 'Replied', n: replied.size },
        { label: 'In pipeline', n: [...inPipeline].filter(b => emailed.has(b)).length },
        { label: 'Won', n: [...won].filter(b => emailed.has(b)).length },
      ],
      categories,
      weeks: weeks.map(({ label, sent, replies }) => ({ label, sent, replies })),
    }
  },

  // -------- call prep --------

  // Everything a rep needs before dialing a brand, in one generated brief.
  async generateCallPrep({ brandId, __user }: any) {
    const brand = await prisma.brand.findUnique({
      where: { id: brandId },
      include: {
        contacts: { orderBy: { name: 'asc' } },
        targets: { include: { contact: true, emails: { orderBy: { createdAt: 'asc' } } } },
        deals: true,
        shows: { include: { deliverableItems: true } },
      } as any,
    }) as any
    if (!brand) throw new Error('Brand not found')

    const history: string[] = []
    for (const t of brand.targets ?? []) {
      for (const e of t.emails ?? []) {
        if (e.direction === 'out' && e.status === 'sent') {
          history.push(`- ${e.sentAt ? new Date(e.sentAt).toISOString().slice(0, 10) : '?'} sent ${e.kind} to ${t.contact?.name}${e.opens > 0 ? ` (opened ×${e.opens})` : ''}`)
        }
        if (e.direction === 'in') history.push(`- ${e.sentAt ? new Date(e.sentAt).toISOString().slice(0, 10) : '?'} THEY REPLIED: "${e.subject ?? ''}"`)
      }
    }

    let rateCard = ''
    try {
      const row = await prisma.setting.findUnique({ where: { key: 'rateCard' } })
      if (row) {
        const v = JSON.parse(row.value)
        rateCard = (v.packages ?? []).map((p: any) =>
          `- ${p.name}: $${((p.priceCents ?? 0) / 100).toLocaleString('en-US')}${p.includes ? ` — ${p.includes}` : ''}`).join('\n')
      }
    } catch {}

    const prompt = [
      `You are prepping a sponsorship sales rep at SB Agency (produces large fraternity/sorority concerts at US colleges; sells brands activations there: sampling, banners, product seeding, title sponsorship, ambassadors) for a CALL with this brand.`,
      `SB AGENCY FACTS you may cite: 500+ shows/year; 100+ tier-1 college markets; 100+ Greek life campus networks; fully customizable programs; in-house photo/video production with full asset rights.`,
      `Write a tight one-page CALL PREP BRIEF (markdown, ~350 words max). The rep may know nothing — make them sound informed in 30 seconds.`,
      ``,
      `BRAND: ${brand.name}${brand.category ? ` (${brand.category})` : ''}${brand.tier ? `, stage: ${brand.tier}` : ''}`,
      brand.goals ? `DISCOVERY NOTES (what they want): ${brand.goals}` : `DISCOVERY NOTES: none yet — infer likely goals for this kind of brand with college students.`,
      brand.notes ? `OTHER NOTES: ${brand.notes}` : ``,
      `CONTACTS WE HAVE:\n${(brand.contacts ?? []).map((c: any) => `- ${c.name}${c.title ? `, ${c.title}` : ''}${c.email ? ` <${c.email}>` : ''}`).join('\n') || '(none)'}`,
      `EMAIL HISTORY:\n${history.join('\n') || '(no emails yet)'}`,
      rateCard ? `OUR RATE CARD:\n${rateCard}` : ``,
      brand.deals?.length ? `EXISTING DEALS: ${brand.deals.map((d: any) => `${d.name} (${d.stage}, $${(d.valueCents / 100).toLocaleString('en-US')})`).join('; ')}` : ``,
      ``,
      `Structure exactly: **Who they are** (2 lines); **What they likely want** (tie to college audience); **Who we know** (contacts + who to push for); **Where we stand** (history in one line); **Pitch this** (1–2 specific packages with prices from the rate card if given); **Ask these** (3 sharp discovery questions); **If they push back** (2 likely objections + one-line answers); **Next step** (the close for this call). Markdown only, no preamble.`,
    ].filter(Boolean).join('\n')

    let res = await tryClaude(prompt, 1100)
    if (!res) {
      // Template brief: all the assembled data, canned strategy.
      res = {
        model: 'template',
        text: [
          `# Call prep — ${brand.name}`,
          ``,
          `**Who they are.** ${brand.name}${brand.category ? ` (${brand.category})` : ''}${brand.tier ? `, ${brand.tier}` : ''}.${brand.goals ? ` What they want: ${brand.goals}` : ''}`,
          brand.notes ? `**Notes.** ${brand.notes}` : ``,
          ``,
          `**Who we know**`,
          (brand.contacts ?? []).map((c: any) => `- ${c.name}${c.title ? `, ${c.title}` : ''}${c.email ? ` <${c.email}>` : ''}`).join('\n') || '- (no contacts yet)',
          ``,
          `**Where we stand**`,
          history.slice(-8).join('\n') || '- No outreach yet — this is a first conversation.',
          ``,
          rateCard ? `**Pitch this**\n${rateCard}` : `**Pitch this**\n- A pilot show in a market they care about, with sampling + signage + full content rights.`,
          ``,
          `**Ask these**`,
          `- What does a successful semester with college students look like for you?`,
          `- Which regions or campuses matter most right now?`,
          `- What's your planning window and budget range for experiential this year?`,
          ``,
          `**If they push back**`,
          `- "No budget" → start with a single-show pilot; the recap proves it before a bigger commitment.`,
          `- "Bad timing" → calendars lock early; reserving now costs nothing and holds the best dates.`,
          ``,
          `**Next step.** Close for a specific follow-up: a tailored proposal within 48 hours, or a date hold on a named show.`,
        ].filter(l => l !== '').join('\n'),
      }
    }
    const doc = await prisma.document.create({
      data: { brandId, kind: 'callprep', title: `Call prep — ${brand.name}`, content: res.text, model: res.model, author: __user ?? null },
    })
    return doc
  },

  // -------- contract & invoice --------

  // A clean agreement draft from a deal's actual terms. Clearly labeled a
  // draft — real signatures deserve a lawyer's eyes.
  async generateContract({ dealId, paymentTerms, extra, __user }: any) {
    const deal = await prisma.deal.findUnique({
      where: { id: dealId },
      include: { brand: { include: { contacts: { where: { email: { not: null } }, take: 3 } } }, showSponsor: { include: { deliverableItems: true } } },
    })
    if (!deal) throw new Error('Deal not found')

    const sp = deal.showSponsor
    const showLine = sp
      ? `${[sp.school, sp.chapter].filter(Boolean).join(' · ')}${sp.eventDate ? `, ${sp.eventDate}` : ''}${sp.artist ? `, artist: ${sp.artist}` : ''}`
      : (deal.eventRef ?? 'event(s) to be scheduled')
    const deliverables = sp?.deliverableItems?.length
      ? sp.deliverableItems.map(d => `- ${d.text}`).join('\n')
      : (sp?.deliverables ?? deal.notes ?? '(deliverables per attached proposal)')

    const prompt = [
      `Draft a concise SPONSORSHIP AGREEMENT (markdown, ~450 words) between SB Agency ("Producer") and ${deal.brand.name} ("Sponsor").`,
      ``,
      `DEAL: ${deal.name}`,
      `EVENT(S): ${showLine}`,
      `SPONSORSHIP FEE: $${(deal.valueCents / 100).toLocaleString('en-US')}`,
      `DELIVERABLES:\n${deliverables}`,
      `PAYMENT TERMS: ${paymentTerms || '50% due on signing, 50% due 7 days before the first event'}`,
      extra ? `EXTRA TERMS: ${extra}` : ``,
      ``,
      `Sections: Parties & Purpose; Sponsorship Deliverables; Fee & Payment; Term; Cancellation (event postponed → deliverables move to the rescheduled date or a comparable event); Brand Assets & Approval (sponsor provides assets 14 days ahead, approves use of name/logo for the listed deliverables); Limitation of Liability (each party liable only up to the fee); Signatures block (name/title/date lines for both parties).`,
      `Plain business English, numbered sections, no invented terms beyond what's given. End with the exact line: "*Draft prepared by SB Agency's deal desk — have an attorney review before signing.*" Markdown only, no preamble.`,
    ].filter(Boolean).join('\n')

    let res = await tryClaude(prompt, 1400)
    if (!res) {
      const fee = `$${(deal.valueCents / 100).toLocaleString('en-US')}`
      const terms = paymentTerms || '50% due on signing, 50% due 7 days before the first event'
      res = {
        model: 'template',
        text: [
          `# Sponsorship Agreement`,
          ``,
          `**1. Parties & Purpose.** This Agreement is between SB Agency ("Producer") and ${deal.brand.name} ("Sponsor"). Producer will provide the sponsorship deliverables below in connection with: ${showLine}.`,
          ``,
          `**2. Sponsorship Deliverables.** Producer will deliver:`,
          deliverables,
          ``,
          `**3. Fee & Payment.** Sponsor will pay Producer a total sponsorship fee of **${fee}**. Payment terms: ${terms}. Amounts are non-refundable once the applicable event has occurred.`,
          extra ? `\n**Additional terms.** ${extra}` : ``,
          ``,
          `**4. Term.** This Agreement runs from the date of signing through completion of the deliverables above.`,
          ``,
          `**5. Postponement.** If an event is postponed, the deliverables move to the rescheduled date or a comparable Producer event agreed by both parties.`,
          ``,
          `**6. Brand Assets & Approval.** Sponsor will provide required brand assets at least 14 days before the first event and approves Producer's use of its name and logo solely for the deliverables listed above.`,
          ``,
          `**7. Limitation of Liability.** Each party's total liability under this Agreement is limited to the sponsorship fee. Neither party is liable for indirect or consequential damages.`,
          ``,
          `**8. Signatures**`,
          ``,
          `SB Agency — Name: ______________  Title: ______________  Date: ________`,
          ``,
          `${deal.brand.name} — Name: ______________  Title: ______________  Date: ________`,
          ``,
          `*Draft prepared by SB Agency's deal desk — have an attorney review before signing.*`,
        ].filter(l => l !== '').join('\n'),
      }
    }
    const doc = await prisma.document.create({
      data: { brandId: deal.brandId, kind: 'contract', title: `Agreement — ${deal.brand.name} (${deal.name})`, content: res.text, model: res.model, author: __user ?? null },
    })
    return doc
  },

  // Deterministic invoice — numbers come from the deal, not a model.
  async generateInvoice({ dealId, dueDays = 15, notes, __user }: any) {
    const deal = await prisma.deal.findUnique({
      where: { id: dealId },
      include: { brand: { include: { contacts: { where: { email: { not: null } }, take: 1 } } }, showSponsor: true },
    })
    if (!deal) throw new Error('Deal not found')

    const year = new Date().getFullYear()
    const count = await prisma.document.count({ where: { kind: 'invoice' } })
    const invoiceNo = `INV-${year}-${String(count + 1).padStart(3, '0')}`
    const issued = new Date()
    const due = new Date(issued.getTime() + dueDays * 24 * 60 * 60 * 1000)
    const fmt = (d: Date) => d.toISOString().slice(0, 10)
    const sp = deal.showSponsor
    const lineDesc = sp
      ? `Sponsorship — ${[sp.school, sp.chapter].filter(Boolean).join(' ')}${sp.eventDate ? ` (${sp.eventDate})` : ''}`
      : `Sponsorship — ${deal.name}${deal.eventRef ? ` (${deal.eventRef})` : ''}`
    const total = `$${(deal.valueCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`
    const billContact = deal.brand.contacts[0]

    const content = [
      `# Invoice ${invoiceNo}`,
      ``,
      `**From:** SB Agency · ${process.env.EMAIL_USER ?? 'partnerships@sboyagency.com'}`,
      `**Bill to:** ${deal.brand.name}${billContact ? ` — ${billContact.name} <${billContact.email}>` : ''}`,
      ``,
      `**Issued:** ${fmt(issued)}   **Due:** ${fmt(due)} (net ${dueDays})`,
      ``,
      `| Description | Amount |`,
      `|---|---|`,
      `| ${lineDesc} | ${total} |`,
      `| **Total due** | **${total}** |`,
      ``,
      notes ? `**Notes:** ${notes}\n` : ``,
      `Payment by check or bank transfer — remittance details provided separately. Please reference **${invoiceNo}** on payment.`,
      ``,
      `*Thank you — SB Agency*`,
    ].filter(l => l !== '').join('\n')

    const doc = await prisma.document.create({
      data: { brandId: deal.brandId, kind: 'invoice', title: `Invoice ${invoiceNo} — ${deal.brand.name}`, content, model: null, author: __user ?? null },
    })
    return doc
  },

  // -------- discover --------

  // The brand hunt: Claude searches the live web for brands matching the
  // query, keeps only ones with a verified LinkedIn company page (the
  // "no LinkedIn → forget it" rule), and benches them in DiscoveredBrand
  // for a human to Add or Dismiss. Nothing touches the real Brand table
  // here.
  async discoverBrands({ query }: any) {
    const q = String(query ?? '').trim()
    if (q.length < 3) throw new Error('Give me a real search — e.g. "venture-backed CPG brands"')
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set in Vercel — discovery is off.')

    const CATS = 'beverage, alcohol, cpg, apparel, tech, fintech, software, beauty, apps, betting, nightlife, wellness, qsr, home, entertainment, retail, transport, conglomerate, nicotine'
    const prompt = [
      `Find real, currently-operating brands matching this search, for a sponsorship sales team at SB Agency (they produce 500+ fraternity/sorority concerts a year at US colleges and sell brands activations there).`,
      ``,
      `SEARCH: ${q}`,
      ``,
      `Use web search to find ~15 strong matches. For EACH brand you must verify it has a real LinkedIn COMPANY page (linkedin.com/company/...) — search for it. If you cannot find the LinkedIn company page, DROP the brand entirely; do not guess a URL.`,
      `Prefer brands that plausibly market to US college students / Gen Z. Skip brands that are defunct or acquired-and-retired.`,
      ``,
      `Return ONLY a JSON array, no other text:`,
      `[{"name": "...", "category": "one of: ${CATS}", "reason": "one line on why it fits the search AND why college students matter to them", "website": "https://... or null", "linkedinUrl": "https://www.linkedin.com/company/..."}]`,
    ].join('\n')

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    let text = ''
    const candidates = ['claude-sonnet-5', 'claude-haiku-4-5']
    let lastErr: any = null
    for (const model of candidates) {
      try {
        const res: any = await anthropic.messages.create({
          model, max_tokens: 6000,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 10 }] as any,
          messages: [{ role: 'user', content: prompt }],
        })
        text = res.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
        if (text) break
      } catch (err: any) {
        lastErr = err
        if (/credit balance|billing|purchase credits/i.test(String(err?.message ?? ''))) {
          throw new Error('Discover needs API credits (console.anthropic.com → Plans & Billing) — or ask Claude in Cowork to run this hunt for free and load the results here.')
        }
        if (!(err?.status === 404 || /model/i.test(err?.message ?? ''))) throw err
      }
    }
    if (!text) throw lastErr ?? new Error('Search produced nothing — try again')

    const m = text.replace(/```(?:json)?/g, '').match(/\[[\s\S]*\]/)
    if (!m) throw new Error('Could not parse the search results — try again')
    let rows: any[] = []
    try { rows = JSON.parse(m[0]) } catch { throw new Error('Could not parse the search results — try again') }

    // The rule, enforced: no LinkedIn company page, no row.
    rows = rows.filter(r => r?.name && typeof r.linkedinUrl === 'string' && /linkedin\.com\/company\//i.test(r.linkedinUrl)).slice(0, 20)

    const out: any[] = []
    for (const r of rows) {
      const name = String(r.name).trim().slice(0, 120)
      // Already one of ours?
      const existing = await prisma.brand.findFirst({
        where: { name: { equals: name, mode: 'insensitive' } },
        select: { id: true, _count: { select: { contacts: true } } },
      })
      const row = await (prisma as any).discoveredBrand.upsert({
        where: { query_name: { query: q, name } },
        create: {
          query: q, name,
          category: r.category ? String(r.category).slice(0, 40) : null,
          reason: r.reason ? String(r.reason).slice(0, 300) : null,
          website: r.website ? String(r.website).slice(0, 300) : null,
          linkedinUrl: String(r.linkedinUrl).slice(0, 300),
          ...(existing ? { status: 'added', brandId: existing.id } : {}),
        },
        update: {
          reason: r.reason ? String(r.reason).slice(0, 300) : undefined,
          ...(existing ? { status: 'added', brandId: existing.id } : {}),
        },
      })
      out.push({ ...row, inSystem: !!existing, contactCount: existing?._count.contacts ?? 0 })
    }
    return { query: q, results: out }
  },

  // The bench, refreshed: re-checks each row against the Brand table so a
  // userscript capture on SponsorUnited flips a row to "contacts ✓"
  // the next time this loads.
  async listDiscoveries({ query }: any) {
    const where = query ? { query } : {}
    const rows = await (prisma as any).discoveredBrand.findMany({
      where, orderBy: { createdAt: 'desc' }, take: 200,
    })
    const recent = await (prisma as any).discoveredBrand.groupBy({
      by: ['query'], _count: { query: true }, _max: { createdAt: true },
      orderBy: { _max: { createdAt: 'desc' } }, take: 10,
    })
    const out: any[] = []
    for (const r of rows) {
      const existing = await prisma.brand.findFirst({
        where: r.brandId ? { id: r.brandId } : { name: { equals: r.name, mode: 'insensitive' } },
        select: { id: true, _count: { select: { contacts: true } } },
      })
      if (existing && !r.brandId) {
        await (prisma as any).discoveredBrand.update({ where: { id: r.id }, data: { brandId: existing.id, status: r.status === 'dismissed' ? 'dismissed' : 'added' } })
        r.brandId = existing.id
        if (r.status !== 'dismissed') r.status = 'added'
      }
      out.push({ ...r, inSystem: !!existing, contactCount: existing?._count.contacts ?? 0 })
    }
    return {
      rows: out,
      recent: recent.map(g => ({ query: g.query, n: g._count.query, at: g._max.createdAt })),
    }
  },

  // Promote a discovery to a real Brand. It arrives contact-less, so it
  // shows up on Needs Contacts — the SU userscript or manual add fills it.
  async addDiscoveredBrand({ id, tier = 'established' }: any) {
    const d = await (prisma as any).discoveredBrand.findUnique({ where: { id } })
    if (!d) throw new Error('Not found')
    let brand = await prisma.brand.findFirst({ where: { name: { equals: d.name, mode: 'insensitive' } } })
    if (!brand) {
      brand = await prisma.brand.create({
        data: {
          name: d.name, category: d.category ?? null, tier,
          website: d.website ?? null, linkedinUrl: d.linkedinUrl ?? null,
          source: 'discover', notes: d.reason ? `Discover: ${d.reason}` : null,
        },
      })
    }
    await (prisma as any).discoveredBrand.update({ where: { id }, data: { status: 'added', brandId: brand.id } })
    return { ok: true, brandId: brand.id }
  },

  // Bulk insert for Discover rows researched OUTSIDE the site (e.g. a
  // Cowork/Claude session doing the web hunt for free). Same rules as
  // discoverBrands: a row without a LinkedIn company URL is refused.
  async importDiscoveries({ query, rows = [] }: any) {
    const q = String(query ?? '').trim()
    if (!q) throw new Error('query required')
    let saved = 0, skipped = 0
    for (const r of rows.slice(0, 40)) {
      if (!r?.name || !/linkedin\.com\/company\//i.test(String(r.linkedinUrl ?? ''))) { skipped++; continue }
      const name = String(r.name).trim().slice(0, 120)
      const existing = await prisma.brand.findFirst({
        where: { name: { equals: name, mode: 'insensitive' } }, select: { id: true },
      })
      await (prisma as any).discoveredBrand.upsert({
        where: { query_name: { query: q, name } },
        create: {
          query: q, name,
          category: r.category ? String(r.category).slice(0, 40) : null,
          reason: r.reason ? String(r.reason).slice(0, 300) : null,
          website: r.website ? String(r.website).slice(0, 300) : null,
          linkedinUrl: String(r.linkedinUrl).slice(0, 300),
          ...(existing ? { status: 'added', brandId: existing.id } : {}),
        },
        update: { reason: r.reason ? String(r.reason).slice(0, 300) : undefined },
      })
      saved++
    }
    return { saved, skipped }
  },

  async dismissDiscovered({ id }: any) {
    await (prisma as any).discoveredBrand.update({ where: { id }, data: { status: 'dismissed' } })
    return { ok: true }
  },

  // Stage-only move for the pipeline board. Manual deals only —
  // sponsorship-sourced deals mirror their show and are locked here.
  async setDealStage({ id, stage }: any) {
    const STAGES = ['conversation', 'proposal', 'verbal', 'closed', 'lost']
    if (!STAGES.includes(stage)) throw new Error('Unknown stage')
    const deal = await prisma.deal.findUnique({ where: { id } })
    if (!deal) throw new Error('Deal not found')
    if (deal.source === 'sponsorship') throw new Error('This deal mirrors a show — change the sponsorship status instead.')
    if (deal.source === 'notion') throw new Error('This deal mirrors Notion — change its Stage there (it syncs nightly, or hit Sync now).')
    return prisma.deal.update({ where: { id }, data: { stage } })
  },

  // -------- renewals --------

  // Brands that have booked a confirmed sponsorship — the warmest possible
  // list to re-approach next season, with what they spent last time.
  async listRenewals() {
    const rows = await prisma.showSponsor.findMany({
      where: { status: 'confirmed' },
      include: { brand: { select: { id: true, name: true, category: true, tier: true, owner: true } } },
      orderBy: { createdAt: 'desc' },
    })
    const byBrand = new Map<string, any>()
    for (const r of rows) {
      let b = byBrand.get(r.brandId)
      if (!b) {
        b = { brand: r.brand, totalCents: 0, shows: 0, lastEvent: null as string | null, owner: r.owner ?? r.brand.owner ?? null }
        byBrand.set(r.brandId, b)
      }
      b.totalCents += r.valueCents
      b.shows += 1
      if (r.eventDate && (!b.lastEvent || r.eventDate > b.lastEvent)) b.lastEvent = r.eventDate
    }
    const list = [...byBrand.values()].sort((a, b) => b.totalCents - a.totalCents)
    const totalCents = list.reduce((s, b) => s + b.totalCents, 0)
    return { count: list.length, totalCents, brands: list }
  },

  // -------- email outreach --------

  async getEmailStatus() { return emailStatus() },
  async listEmailQueue() { return listEmailQueue() },
  async draftEmails({ limit = 4 }: any) { return draftDailyEmails(Math.min(6, limit)) },
  async sendApprovedEmails() { return sendApprovedEmails() },
  async checkEmailReplies() { return checkReplies() },

  async suggestForDraft({ id }: any) { return suggestForDraft(id) },
  async sendTestEmail({ to }: any) { return sendTestEmail(to) },
  async setDraftRecipients({ id, toEmail, toName, cc }: any) {
    return setDraftRecipients(id, { toEmail, toName, cc })
  },
  async sendEmailDraft({ id }: any) { return sendOneEmail(id) },
  async syncNotionDeals() { return syncNotionDeals() },
  async draftBrandIntro({ brandId }: any) { return draftBrandIntro(brandId) },
  async approveAllDrafts() { return approveAllDrafts() },
  async emailDifferentContact({ targetId, contactId }: any) { return emailDifferentContact(targetId, contactId) },
  async draftFinalNudge({ targetId }: any) { return draftFinalNudge(targetId) },
  async draftReplyResponse({ id }: any) { return draftReplyResponse(id) },
  async sendReplyEmail({ targetId, to, subject, body }: any) { return sendReplyEmail(targetId, to, subject, body) },

  async updateEmailDraft({ id, subject, body }: any) {
    return prisma.emailMessage.update({
      where: { id },
      data: {
        ...(subject !== undefined ? { subject } : {}),
        ...(body !== undefined ? { body } : {}),
      },
    })
  },

  async deleteEmailDraft({ id }: any) {
    const m = await prisma.emailMessage.findUnique({ where: { id } })
    if (m && m.status !== 'draft') throw new Error('Only drafts can be deleted')
    await prisma.emailMessage.delete({ where: { id } })
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

// Discover's web-searched brand hunt can run well past the default
// function timeout; everything else finishes in a fraction of this.
export const maxDuration = 60

export async function POST(req: NextRequest) {
  try {
    const { fn, args } = await req.json()
    const handler = handlers[fn]
    if (!handler) {
      return NextResponse.json({ ok: false, error: `Unknown function: ${fn}` }, { status: 400 })
    }
    // Who's acting, for attribution (documents record their author).
    // Middleware already guarantees a session exists.
    const a = { ...(args ?? {}) }
    try {
      const session: any = await getServerSession(authOptions)
      const email = session?.user?.email
      if (email) {
        const first = String(email).split('@')[0].split(/[._-]/)[0]
        a.__user = first.charAt(0).toUpperCase() + first.slice(1)
      }
    } catch {}
    const data = await handler(a)
    return NextResponse.json({ ok: true, data })
  } catch (err: any) {
    console.error('[api/data]', err)
    return NextResponse.json({ ok: false, error: err?.message ?? 'Server error' }, { status: 500 })
  }
}
