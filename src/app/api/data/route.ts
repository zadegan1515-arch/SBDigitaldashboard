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
import { Prisma, PrismaClient, TargetStatus } from '@prisma/client'
import {
  readSearch, writeSearch, readProposals, writeProposals,
  readCaptureQueue, writeCaptureQueue, queueCapture,
  readSweepLog, isResting, SWEEP_REST_DAYS,
} from '@/lib/su-match'
import { getServerSession } from 'next-auth'
import Anthropic from '@anthropic-ai/sdk'
import { authOptions, allowlist } from '@/lib/auth'
import {
  emailStatus, listEmailQueue, draftDailyEmails,
  sendApprovedEmails, checkReplies, suggestForDraft, sendTestEmail,
  setDraftRecipients, sendOneEmail, approveAllDrafts, draftBrandIntro, resignDrafts, warmupStatus,
  sendingPaused, setSendingPaused,
  emailDifferentContact, draftFinalNudge, draftReplyResponse, sendReplyEmail, sendPlainEmail,
} from '@/lib/email'
import { syncNotionDeals } from '@/lib/notion'
import { googleStatus, googleDisconnect, driveStatus, driveDisconnect, driveCreateActivationDocs, opsStatus, opsDisconnect, opsSend } from '@/lib/google'
import { scanOps, listOps, getOps, updateOps, deleteOps, replyOps, forwardOps } from '@/lib/ops'
import { allShows, refreshShows, setGenreOverride, cachedShows, GENRES } from '@/lib/shows'
import { newBoardCode } from '@/lib/board-access'
import BRAND_SUMMARIES from '@/data/brand-summaries.json'
import { regionFlag } from '@/lib/region'
import { readMisses, writeMisses, addMiss, suggestBrands, addAka, parseSponsorUnitedRef } from '@/lib/brand-match'
import {
  listAudienceEvents, saveAudienceEvent, deleteAudienceEvent, regenStaffPin, audienceEventStats,
  listAttendees, listDupCandidates, mergeAttendees, deleteAttendee, importAttendees, segmentsOverview,
} from '@/lib/audience'

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
// Twenty a day, weekdays only, sits exactly at that ceiling — Leo's
// call (Sep 2026). If LinkedIn ever shows the weekly-limit warning or
// asks to verify the account, drop this back to 10 for a week.
const DAILY_SEND_LIMIT = 20

// Vercel functions run in UTC, so a naive setHours(0,0,0,0) makes "today"
// start at 7 or 8pm the previous evening for anyone on the east coast —
// which silently handed out a second day's queue every evening.
const WORK_TZ = 'America/New_York'

// Today's date as YYYY-MM-DD in the working timezone — the key the
// outreach schedule (Setting `outreachPlan`) is stored under.
function localDayKey(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: WORK_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

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
// Leo's rule (Sep 2026): this site makes NO paid API calls, ever. The
// billing-shaped message routes every caller to its template fallback
// (tryClaude returns null; email.ts isBillingError matches it too).
const NO_PAID_APIS = true

async function askClaude(prompt: string, maxTokens: number): Promise<{ text: string; model: string }> {
  if (NO_PAID_APIS) throw new Error('Model calls are turned off — no paid APIs on this site (credit balance guard).')
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
  requested: 'conversation',
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
  [/marketing|event/i, 8],
]

// C-suite / owner titles, excluding marketing chiefs (a CMO is the
// right person). These only make sense to contact at a really small
// brand, where the founder IS the buyer.
const EXEC_TITLE = /founder|co-founder|\bceo\b|chief executive|\bcoo\b|chief operating|\bcfo\b|president|owner/i

const TIER_BONUS: Record<string, number> = {
  emerging: 20,   // hungriest for awareness, fastest yes
  growth: 15,
  established: 5, // biggest budgets, slowest process
}

// A brand where someone already wrote back is in conversation, not in
// the cold-outreach pool: pitching a second person there reads as a
// blast and steps on the live thread. Leo's rule. Hand-picking is
// still allowed — that is the follow-up case.
const NOT_IN_CONVERSATION: Prisma.BrandWhereInput = {
  passedAt: null,
  targets: { none: { status: { in: ['replied', 'converted'] as TargetStatus[] } } },
}

// Both brand-level guards at once: not in conversation, and not passed
// for today. Typed as one where-input so Prisma can narrow it — two
// spread objects left it guessing between its filter shapes.
function coldPoolBrand(): Prisma.BrandWhereInput {
  return { ...NOT_IN_CONVERSATION, ...notPassedToday() }
}

// "Passed for today" wears off at midnight on its own — there is no undo
// to remember. Spread into a brand `where` alongside NOT_IN_CONVERSATION.
// The planner covers WORKING days only — nobody sends LinkedIn invites
// into a Saturday. Today is always included (so the Schedule's Today
// row still mirrors the live queue), then the next weekdays fill it.
// Leo's outreach week: Tuesday, Wednesday, Thursday. Nothing goes out on
// a Monday or a Friday, so the planner doesn't offer those days at all —
// including today, when today is one of them.
const OUTREACH_DOWS = [2, 3, 4]

// The weekday has to be read in WORK_TZ like every other date here.
// d.getDay() is the server's own timezone — UTC on Vercel — so between
// 8pm and midnight in New York the two disagreed about what day it was:
// the planner built its list for tomorrow while the date keys still said
// today, which shifted every panel by a day and stamped "in today's
// queue" onto the one labelled Tomorrow.
const NY_WEEKDAY = new Intl.DateTimeFormat('en-US', { timeZone: WORK_TZ, weekday: 'short' })
const DOW_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
function isOutreachDay(d: Date): boolean {
  return OUTREACH_DOWS.includes(DOW_INDEX[NY_WEEKDAY.format(d)] ?? -1)
}

// The next `count` days we actually send on. Today is included only if
// it is one of them, which means the first day in the list is not
// necessarily today — anything keyed off "today" has to compare dates,
// not positions.
function planningDays(count = 3): Date[] {
  const out: Date[] = []
  const cur = new Date()
  if (isOutreachDay(cur)) out.push(new Date(cur))
  while (out.length < count) {
    cur.setDate(cur.getDate() + 1)
    if (!isOutreachDay(cur)) continue
    out.push(new Date(cur))
  }
  return out
}

function notPassedToday() {
  const start = startOfLocalDay()
  return { OR: [{ passedTodayAt: null }, { passedTodayAt: { lt: start } }] }
}

// A brand we have already reached out to. Leo's rule: once an invite has
// gone to anyone there, the brand stops being offered as something to
// add to an upcoming day — the conversation is live, and a second cold
// approach from a different person reads badly.
function alreadyContacted(b: { targets: { sentAt: Date | null }[] }) {
  return b.targets.some(t => t.sentAt)
}

function scoreFit(title: string | null, tier: string | null): number {
  let score = 30
  if (title) {
    for (const [pattern, points] of TITLE_SIGNALS) {
      if (pattern.test(title)) { score += points; break }
    }
    // Leo's rule: don't reach the C-suite unless the brand is really
    // small — at anything bigger, marketing/events people buy this.
    if (EXEC_TITLE.test(title) && !/marketing/i.test(title)) {
      score += tier === 'emerging' ? 10 : -20
    }
  }
  if (tier && TIER_BONUS[tier] !== undefined) score += TIER_BONUS[tier]
  return Math.max(0, Math.min(100, score))
}

function looksLikeDecisionMaker(title: string | null): boolean {
  if (!title) return false
  return /college|campus|field marketing|experiential|sponsorship|partnerships|sports marketing|brand marketing|founder|ceo|cmo/i.test(title)
}

// How many people to work at a brand when Leo hasn't chosen — rules
// only, mirrored on the brand page client-side. Established orgs get
// three threads (nobody knows who owns campus), growth two, founder-led
// one (a second message just annoys a founder); never more than the
// reachable bench.
// Names for a toast: "Dana", "Dana and Sam", "Dana, Sam and Alex".
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

function recommendWorkPeople(
  brand: { tier: string | null },
  contacts: Array<{ title: string | null; email: string | null; linkedinUrl: string | null }>,
  cold = false,
): number {
  const reachable = contacts.filter(c => c.email || c.linkedinUrl).length
  const founderLed = contacts.some(c => /founder|co-founder|\bceo\b/i.test(c.title ?? ''))
  // Leo's rule: a brand nobody has written to yet opens with three or
  // four threads, four at the big ones — a first approach is where the
  // extra thread is worth most, and there is no live conversation for a
  // second name to cut across. Once someone has been written to the old
  // narrower counts apply, so we don't pile onto a thread in motion.
  // Either way the brand's reachable people are the real ceiling.
  const n = cold
    ? (brand.tier === 'established' ? 4 : 3)
    : (brand.tier === 'established' ? 3 : brand.tier === 'growth' ? 2 : founderLed ? 1 : 2)
  return Math.max(1, Math.min(n, Math.max(reachable, 1)))
}

// Leo's rule, as a filter rather than only a scoring nudge: at anything
// bigger than an emerging brand the chief executive is the wrong door —
// marketing and partnerships people buy this. scoreFit already docks
// those titles, but a dock still picks them when they sort first, so
// they come out of the running entirely while anyone else is reachable.
function dropExecsAtBigBrands<T extends { title: string | null }>(
  contacts: T[],
  tier: string | null,
): T[] {
  if (tier === 'emerging') return contacts
  const notExec = contacts.filter(c => !(c.title && EXEC_TITLE.test(c.title) && !/marketing/i.test(c.title)))
  // A brand whose only reachable people are executives still gets
  // worked — a worse door beats no door.
  return notExec.length ? notExec : contacts
}

// ---------------------------------------------------------------
// LinkedIn draft templates — no model call, no spend, never blocks
// ---------------------------------------------------------------

// One hook per category so the DM says something specific to the brand.
const LI_HOOKS: Record<string, string> = {
  beverage: 'product-in-hand sampling for thousands of students a night',
  alcohol: 'compliant 21+ sampling right where trial converts',
  cpg: 'sampling on show nights plus house drops across our Greek chapters',
  beauty: 'the getting-ready moment before every show, where routines form',
  betting: 'on-site signups from exactly the demo you are acquiring',
  fintech: 'students opening their first accounts — the next decade of customers',
  tech: 'hands-on demos that ride word-of-mouth through Greek networks',
  software: 'student offers seeded through our campus ambassadors',
  apps: 'QR moments on the big screen at peak energy',
  qsr: 'the after-show rush, right when cravings peak',
  apparel: 'the most photographed nights on campus',
  wellness: 'show weekends, when students actually reach for recovery and hydration',
  retail: 'student-exclusive offers pushed through our chapters',
  transport: 'thousands of students needing a ride home after every show',
  nightlife: 'co-branded moments inside the show itself',
  entertainment: 'a captive Gen Z audience at full attention',
}
const LI_HOOK_DEFAULT = 'sampling, stage branding and seeded product built around each show'

// Leo's templates (Sep 2026): one note written for a man, one for a
// woman — same pitch, different opener. The rep picks which to copy;
// the site never guesses gender from a name.
function templateLinkedInDraft(target: { brand: any; contact: any }, variant: string) {
  const first = String(target.contact.name || '').trim().split(/\s+/)[0] || 'there'
  const brand = target.brand.name
  const hook = LI_HOOKS[target.brand.category ?? ''] ?? LI_HOOK_DEFAULT
  const pitch = `I'm Zach with SB Agency, we book top artist talent for fraternities and sororities across the country. Would love to chat more and see if ${brand} is interested in activating at these events, or if we can help build out other college activations for you.`
  const connectionNote = (variant === 'woman'
    ? `Hey ${first}, great to meet you! ${pitch}`
    : `${first} – what's up man! ${pitch}`
  ).slice(0, 300)
  const firstMessage =
    `Thanks for connecting, ${first}! Quick context: SB Agency runs 500+ college shows a year — packed student crowds across 100+ tier-1 markets, with in-house photo and video on every show. For ${brand}, the natural fit is ${hook}.\n\n` +
    `Happy to send this semester's show list, or grab 15 minutes if that's easier — what works best?`
  // Leo's own words, used exactly as he wrote them. One message for
  // everyone: he asked for it unisex, so the note and the first message
  // keep their two voices and this one does not have any.
  // The deck it mentions is attached by hand in the LinkedIn chat.
  const nudge =
    `Hey ${first}, great to be connected. Would love to share ideas and put something together with ${brand}. ` +
    `Do you have 15 minutes for a quick chat later this week? ` +
    `I have also attached our deck for you to check out in the meantime. Thanks!`
  return { connectionNote, firstMessage, nudge }
}

// Every target headed for the Today queue arrives pre-drafted, so a
// day's outreach is copy-paste from the first row. Free (templates), so
// safe to run on every load.
async function ensureTemplateDrafts(targets: any[]) {
  for (const t of targets) {
    // Untouched template drafts from an older template are replaced so
    // the whole queue speaks the current voice; hand-edited drafts and
    // rows with current variants are left alone.
    if (t.drafts && t.drafts.length) {
      // Stale = written before Zach's man/woman templates, edited or
      // not. The editor autosaves on blur, so editedByHuman was set on
      // drafts nobody meaningfully changed (Gorgie's case) and kept
      // them on the old wording forever. Only edits made to the NEW
      // man/woman drafts are worth preserving.
      const stale = t.drafts.every((d: any) =>
        d.variant !== 'man' && d.variant !== 'woman')
      if (!stale) {
        // The follow-up is newer than these drafts. Fill only that field
        // in — deleting and regenerating would throw away hand edits to
        // the note and the first message, which are the two things Leo
        // has actually tuned.
        for (const d of t.drafts) {
          if (d.nudge || (d.variant !== 'man' && d.variant !== 'woman')) continue
          const made = templateLinkedInDraft(t, d.variant)
          await prisma.draft.update({ where: { id: d.id }, data: { nudge: made.nudge } })
          d.nudge = made.nudge
        }
        continue
      }
      await prisma.draft.deleteMany({ where: { targetId: t.id } })
    }
    const created = []
    for (const variant of ['man', 'woman']) {
      const made = templateLinkedInDraft(t, variant)
      created.push(await prisma.draft.create({
        data: { targetId: t.id, variant, connectionNote: made.connectionNote, firstMessage: made.firstMessage, nudge: made.nudge, model: 'template' },
      }))
    }
    t.drafts = created
    if (t.status === 'queued') {
      await prisma.target.update({ where: { id: t.id }, data: { status: 'drafted' } })
      await prisma.targetEvent.create({
        data: { targetId: t.id, kind: 'drafted', fromStatus: 'queued', toStatus: 'drafted' },
      })
      t.status = 'drafted'
    }
  }
  return targets
}

// How many people we actually pursue per brand. A brand pull can surface
// ten marketing contacts; we only want the best few in the send queue so
// outreach stays focused and the weekly LinkedIn cap isn't blown on one
// brand. The rest are "shelved" — kept, visible, promotable, just not
// queued. Leo's call: top 3 by fit.
// How many people per brand can sit in the send queue at once. Four,
// because a cold brand now opens with up to four threads and a cap of
// three would shelve the fourth the moment it was created. NOT the
// contact cap — that one is CONTACT_CAP_PER_BRAND = 25, how many people
// we keep on file.
const TARGET_CAP_PER_BRAND = 4

// How many people we keep on file per brand — a different question from
// how many we write to. Leo's rule (Sep 2026): a brand with fewer than
// 25 people listed comes in whole; a brand with 25 or more comes in 25
// deep, best titles first, so a company like Amazon contributes its
// partnership people instead of seven hundred engineers. Nothing
// already stored is removed — the cap only stops new rows once a brand
// is at 25. Mirrored in /api/ingest.
const CONTACT_CAP_PER_BRAND = 25

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

// A staff-section budget line is a "people line" (slots to fill) unless
// it's travel / labour money rather than named people.
function isPeopleLine(l: { section: string; item: string }): boolean {
  return l.section === 'staff' && !/travel|hotel|airfare|per diem|install|strike|truck|shipping|freight|pre-?production|labou?r|overtime/i.test(l.item)
}

// -------- Sboy Vision ambassador platform client --------
function platformConfigured(): boolean {
  return !!(process.env.AMBASSADOR_PLATFORM_URL && process.env.AMBASSADOR_PLATFORM_TOKEN)
}
async function platformFetch(path: string, init: RequestInit = {}): Promise<any> {
  const base = process.env.AMBASSADOR_PLATFORM_URL
  const token = process.env.AMBASSADOR_PLATFORM_TOKEN
  if (!base || !token) throw new Error('Ambassador platform not connected — set AMBASSADOR_PLATFORM_URL and AMBASSADOR_PLATFORM_TOKEN in Vercel.')
  const res = await fetch(base.replace(/\/$/, '') + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    cache: 'no-store',
  })
  if (res.status === 401) throw new Error('Ambassador platform rejected the token — the two INTEGRATION_TOKEN values don\'t match.')
  const text = await res.text()
  let j: any = {}
  try { j = text ? JSON.parse(text) : {} } catch { j = {} }
  if (!res.ok) throw new Error(j?.error || `Ambassador platform returned ${res.status}`)
  return j
}

// Land people that were held with an unmatched SponsorUnited name onto a
// brand, under exactly the rules a live capture uses: skip anyone already
// on the brand, queue the decision-makers who have a LinkedIn URL, then
// apply the per-brand cap. Shared by attachBrandMiss and
// createBrandFromMiss so "existing brand" and "new brand" behave alike.
async function landMissRows(brand: { id: string; tier: string | null; owner: string | null }, rows: any[]) {
  let contactsCreated = 0, targetsCreated = 0, skipped = 0
  for (const row of rows) {
    try {
      const dupe = await prisma.contact.findFirst({ where: { brandId: brand.id, name: row.name } })
      if (dupe) { skipped++; continue }
      const dm = looksLikeDecisionMaker(row.title ?? null)
      const contact = await prisma.contact.create({
        data: {
          brandId: brand.id,
          name: row.name,
          title: row.title ?? null,
          email: row.email ?? null,
          phone: row.phone ?? null,
          location: row.location ?? null,
          linkedinUrl: row.linkedinUrl ?? null,
          source: 'sponsorunited',
          isDecisionMaker: dm,
        },
      })
      contactsCreated++
      if (dm && contact.linkedinUrl) {
        await prisma.target.create({
          data: {
            brandId: brand.id,
            contactId: contact.id,
            fitScore: scoreFit(contact.title, brand.tier),
            assignedTo: brand.owner ?? null,
          },
        })
        targetsCreated++
      }
    } catch { skipped++ }
  }
  let targetsShelved = 0
  try { targetsShelved = (await reconcileBrandTargets(brand.id)).shelvedNow } catch { /* non-fatal */ }
  return { contactsCreated, targetsCreated, targetsShelved, skipped }
}

// ---------------------------------------------------------------
// For Zach to do — the Home page's hand-email list
// ---------------------------------------------------------------
//
// A LinkedIn accept usually ends in "email me". Everyone who accepted
// the invite or answered there sits on Zach's list until he emails them
// from his own inbox (Emailed ✓) or someone marks "No email needed".
// The mail leaves through Zach's Gmail, never through the email
// machine, so nothing here touches its daily cap. One template for
// everyone, filled per person; an edit made on a card stays on that card.

// (NAME) = first name, (BRAND) = brand, (TITLE) = job title, the same
// placeholders as Leo's intro template. Until he saves his own, the
// stand-in is the "thanks for connecting" note the Results tab's Email
// button already sent.
const HAND_TEMPLATE_KEY = 'handEmailTemplate'
const HAND_TEMPLATE_STANDIN = {
  subject: 'SB Agency × (BRAND)',
  body: [
    'Hi (NAME),',
    '',
    'Thanks for connecting on LinkedIn.',
    '',
    'I run SB Agency — we book artists and DJs for fraternity and sorority events and build ' +
      'brand activations around those shows. Worth a quick look at whether (BRAND) fits one this season?',
    '',
    'Happy to send the one-pager and a few dates.',
    '',
    'Zach',
  ].join('\n'),
}
// How far back the Done list reaches.
const HAND_DONE_DAYS = 30

async function readHandTemplate() {
  const row = await prisma.setting.findUnique({ where: { key: HAND_TEMPLATE_KEY } })
  if (row) {
    try {
      const v = JSON.parse(row.value)
      if (v && typeof v.body === 'string' && v.body.trim()) {
        return { subject: String(v.subject ?? ''), body: v.body as string, standIn: false, savedAt: v.savedAt ?? null, savedBy: v.savedBy ?? null }
      }
    } catch { /* an unreadable row falls back to the stand-in */ }
  }
  return { ...HAND_TEMPLATE_STANDIN, standIn: true, savedAt: null, savedBy: null }
}

// Waiting on Zach: accepted the invite or answered on LinkedIn, not
// emailed by hand yet, not marked "No email needed", and no email thread
// already running. A reply by email means the conversation has moved to
// the Email tab, so that person is not his to start.
const HAND_WAITING: Prisma.TargetWhereInput = {
  status: { in: ['accepted', 'replied'] },
  emailedAt: null,
  handSkippedAt: null,
  emails: { none: { direction: 'in' } },
}

// An archived brand, or one marked do-not-email (the flag, or "skip" in
// its notes — the email machine's rule), stays off Zach's list. The list
// names what it held back, so nobody wonders where a brand went.
function handBrandHold(b: { passedAt: Date | null; doNotEmail: boolean; notes: string | null }): string | null {
  if (b.passedAt) return 'archived'
  if (b.doNotEmail || /skip/i.test(b.notes ?? '')) return 'do not email'
  return null
}

// The ids actually showing on Zach's list right now.
async function handWaitingIds(): Promise<Set<string>> {
  const rows = await prisma.target.findMany({
    where: HAND_WAITING,
    select: { id: true, brand: { select: { passedAt: true, doNotEmail: true, notes: true } } },
  })
  return new Set(rows.filter(t => !handBrandHold(t.brand)).map(t => t.id))
}

const handlers: Record<string, Handler> = {

  // -------- dashboard --------

  async getDashboard() {
    const boardViews7d = await prisma.boardVisit.count({
      where: { createdAt: { gt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
    })
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
    try {
      // Same source as the Shows tab (the CRM sheet), so the dashboard
      // count can never disagree with it.
      const all = await allShows()
      const season = all.shows.filter(x => !x.past).map(x => x.season)[0] || null
      const ids = all.shows.filter(x => !x.past || (x.source === 'sheet' && (!season || x.season === season))).map(x => x.id)
      const sold = await prisma.showSponsor.findMany({
        where: { crmLeadId: { in: ids } },
        select: { crmLeadId: true },
        distinct: ['crmLeadId'],
      })
      showStats = { connected: true, total: ids.length, unsold: ids.length - sold.length }
    } catch (err) {
      console.error('[getDashboard] show read failed', err)
    }

    return {
      counts,
      totalTargets: Object.values(counts).reduce((a, b) => a + b, 0),
      pipelineCents: pipeline._sum.valueCents ?? 0,
      boardViews7d,
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
  // Queue size for the LinkedIn page subtitle — same number the
  // dashboard's "Queued" stat reports (active targets only).
  async countQueued() {
    return { queued: await prisma.target.count({ where: { shelved: false, status: 'queued' } }) }
  },

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

    const include = {
      brand: true,
      contact: true,
      // Capped: "Redraft" appends two more rows each time, and without a
      // take the row grows a new pair of panels on every click.
      drafts: { orderBy: { createdAt: 'desc' as const }, take: 2 },
    }

    // Anything stamped TODAY was put there on purpose (the search box,
    // + Person, Queue on next-best) — it always shows, newest first, on
    // top of the list and past the daily cap. Before this, a hand-pick
    // beyond row 10 queued fine but never rendered.
    // Today's planned brands (Schedule tab) queue themselves — each
    // lands as a hand-pick. Idempotent: an already-live brand is a
    // no-op inside queueBrandTargets.
    const planRow = await prisma.setting.findUnique({ where: { key: 'outreachPlan' } })
    let planDay: any = null
    try { planDay = planRow ? (JSON.parse(planRow.value)[localDayKey()] ?? null) : null } catch { planDay = null }
    // Planned brands queue themselves. A brand that cannot be queued is
    // reported rather than swallowed — that silence was why a brand
    // added on the Schedule could simply never appear.
    const plannedSkipped: { brandId: string; brandName: string; reason: string }[] = []
    if (planDay?.brandIds?.length) {
      for (const bid of planDay.brandIds) {
        try {
          const r: any = await (handlers.queueBrandTargets as Handler)({ brandId: bid })
          if (r && r.queued === false && r.reason !== 'already') {
            plannedSkipped.push({ brandId: bid, brandName: r.brandName ?? '', reason: r.reason ?? 'unknown' })
          }
        } catch (e: any) {
          plannedSkipped.push({ brandId: bid, brandName: '', reason: e?.message ?? 'error' })
        }
      }
    }

    // Category day is strict now (Leo): yesterday's unsent stamps from
    // other days don't carry over — they go back to the pool and come
    // up again on their own category's day. Nothing is lost, only
    // unstamped. Today's hand-picks (stamped today) always stay.
    await prisma.target.updateMany({
      where: { queuedFor: { not: null, lt: startOfDay }, status: { in: ['queued', 'drafted'] }, shelved: false },
      data: { queuedFor: null },
    })

    const handPicked = await prisma.target.findMany({
      where: { queuedFor: { gte: startOfDay }, status: { in: ['queued', 'drafted'] }, shelved: false, brand: { passedAt: null } },
      include,
      orderBy: { queuedFor: 'desc' },
    })

    // Includes 'drafted': drafting from the All-targets tab sets the
    // status without stamping queuedFor, and those rows used to match
    // neither branch and never surface in Today again.
    const candidates = await prisma.target.findMany({
      where: { status: { in: ['queued', 'drafted'] }, queuedFor: null, shelved: false, brand: coldPoolBrand() },
      orderBy: [{ fitScore: 'desc' }, { createdAt: 'asc' }],
      take: 300,
      select: { id: true, fitScore: true, brand: { select: { category: true } } },
    })
    const cats = [...new Set(candidates.map(c => c.brand.category).filter(Boolean))].sort() as string[]
    // A planned category (Schedule tab) beats the automatic rotation.
    const theme = planDay?.category
      ?? (cats.length ? cats[Math.floor(Date.now() / 86400000) % cats.length] : null)

    // The day is ONE category, strictly (Leo): no topping up from other
    // categories. A short day stays short — the Schedule tab's Add-more
    // and side list are how it gets filled.
    const themed = theme ? candidates.filter(c => c.brand.category === theme) : candidates
    const roomLeft = Math.max(0, room - handPicked.length)
    const picks = themed.slice(0, roomLeft)

    if (picks.length) {
      await prisma.target.updateMany({
        where: { id: { in: picks.map(p => p.id) } },
        data: { queuedFor: new Date() },
      })
    }
    const fresh = picks.length
      ? await prisma.target.findMany({ where: { id: { in: picks.map(p => p.id) } }, include })
      : []
    fresh.sort((a, b) => b.fitScore - a.fitScore)

    // "The rest in that category" — everyone in today's category beyond
    // the cap, ready to send if there's room. Not stamped: sending one
    // still counts toward the 20 via sentAt.
    const pickedIds = new Set(picks.map(p => p.id))
    const moreIds = themed.filter(c => !pickedIds.has(c.id)).slice(0, 40).map(c => c.id)
    const more = moreIds.length
      ? await prisma.target.findMany({ where: { id: { in: moreIds } }, include, orderBy: { fitScore: 'desc' } })
      : []

    return {
      plannedSkipped, sentToday, cap: DAILY_SEND_LIMIT,
      theme,
      targets: await ensureTemplateDrafts([...handPicked, ...fresh]),
      more: await ensureTemplateDrafts(more),
    }
  },

  async listTargets({ status, category, search, take = 200, shelved = false }: any) {
    const rows = await prisma.target.findMany({
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
    // The sent / accepted / stale sections read through here, and their
    // copy buttons must serve the current templates too — refresh any
    // never-hand-edited draft that predates them.
    await ensureTemplateDrafts(rows.filter(t => !['declined', 'dead', 'converted', 'passed'].includes(t.status)))
    return rows
  },

  async setTargetStatus({ targetId, status, actor, nextStep, followUpAt, clearFollowUp, clearSent, dmSent }: any) {
    const before = await prisma.target.findUnique({ where: { id: targetId } })
    if (!before) throw new Error('Target not found')

    const now = new Date()
    const updated = await prisma.target.update({
      where: { id: targetId },
      data: {
        ...(status ? { status } : {}),
        ...(status === 'sent' && !before.sentAt ? { sentAt: now } : {}),
        // Undo for a mis-clicked "Mark sent": back to the queue with the
        // send stamp wiped so today's cap and Reached don't count it.
        // A withdrawn invite is uncounted the same way.
        ...(clearSent || status === 'withdrawn' ? { sentAt: null } : {}),
        // "DM sent ✓" on an accepted row — clears them from Today's
        // send-the-DM list without touching the status.
        ...(dmSent ? { dmSentAt: now } : {}),
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

    // A LinkedIn reply still waiting on Zach's email is already on the
    // Home page's "For Zach to do" list; saying it twice on one page
    // helps nobody. Once he emails (or it's marked no email needed) it
    // comes back here for its next step. A due follow-up always shows.
    const onZach = await handWaitingIds()
    const items = targets.filter(t => t.followUpAt != null || !onZach.has(t.id)).map(t => {
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

  async generateDrafts({ targetId, variants = ['man', 'woman'] }: any) {
    const target = await prisma.target.findUnique({
      where: { id: targetId },
      include: { brand: true, contact: true },
    })
    if (!target) throw new Error('Target not found')

    // Template-based on purpose: drafting never costs money and never
    // blocks on an API (Leo's no-paid-APIs rule). Redraft replaces the
    // old pair so the row doesn't grow a new panel per click.
    await prisma.draft.deleteMany({ where: { targetId } })
    const drafts = []
    for (const variant of variants) {
      const made = templateLinkedInDraft(target, variant)
      drafts.push(await prisma.draft.create({
        data: {
          targetId,
          variant,
          connectionNote: made.connectionNote,
          firstMessage: made.firstMessage,
          model: 'template',
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
  async importContacts({ rows: incoming }: any) {
    const result = {
      brandsCreated: 0, contactsCreated: 0, targetsCreated: 0, targetsShelved: 0,
      skipped: 0, capped: 0, failed: 0, heldForReview: 0, errors: [] as string[],
    }
    // Best titles first, so a brand with room for only some of the list
    // keeps its partnership and campus people. Stable sort, so rows for
    // one brand stay together. Mirrors /api/ingest.
    const rows: any[] = (Array.isArray(incoming) ? incoming : [])
      .slice()
      .sort((a: any, b: any) => scoreFit(b?.title ?? null, null) - scoreFit(a?.title ?? null, null))
    // brandId -> how many more people this brand can take. See
    // CONTACT_CAP_PER_BRAND.
    const room = new Map<string, number>()
    // Rows whose brand name matched nothing — parked for Needs contacts
    // rather than turned into brands. Same map shape as /api/ingest.
    const missed = new Map<string, { externalId: string | null; rows: any[] }>()

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

      // Match the name case-insensitively, then any "also known as" name
      // (Brand.aka, comma-separated) — SponsorUnited often lists a brand
      // under a different name than ours ("818 Tequila" vs "818 Spirits").
      // Mirrored in /api/ingest (findBrandForCapture).
      let brand = await prisma.brand.findFirst({
        where: { name: { equals: row.brandName, mode: 'insensitive' } },
      })
      if (!brand) {
        const want = String(row.brandName).trim().toLowerCase()
        const withAka = await prisma.brand.findMany({ where: { aka: { not: null } } })
        brand = withAka.find(b =>
          (b.aka ?? '').split(/[,;]/).some(a => a.trim().toLowerCase() === want)
        ) ?? null
      }
      if (!brand) {
        // Don't invent a brand from a name we don't recognise — that's
        // how a second "818" gets created next to the real one. Park the
        // person with the name instead; Needs contacts asks which brand
        // it is, or lets it become a new brand on purpose. Same worklist
        // the userscript capture feeds.
        const held = missed.get(row.brandName) ?? { externalId: null as string | null, rows: [] as any[] }
        held.rows.push({
          name: row.name,
          title: row.title ?? null,
          email: row.email ?? null,
          location: row.location ?? null,
          linkedinUrl: row.linkedinUrl ?? null,
        })
        missed.set(row.brandName, held)
        result.heldForReview++
        continue
      }
      touched.add(brand.id)

      const dupe = await prisma.contact.findFirst({
        where: { brandId: brand.id, name: row.name },
      })
      if (dupe) { result.skipped++; continue }

      // The per-brand cap, checked after the duplicate check so people
      // we already hold are never reported as capped.
      if (!room.has(brand.id)) {
        const have = await prisma.contact.count({ where: { brandId: brand.id } })
        room.set(brand.id, Math.max(0, CONTACT_CAP_PER_BRAND - have))
      }
      if ((room.get(brand.id) ?? 0) <= 0) { result.capped++; continue }

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
      room.set(brand.id, (room.get(brand.id) ?? 1) - 1)

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

    if (missed.size) {
      try {
        let misses = await readMisses(prisma)
        for (const [name, held] of missed) misses = addMiss(misses, name, held.externalId, held.rows)
        await writeMisses(prisma, misses)
      } catch (err: any) {
        result.errors.push(`miss log: ${err?.message ?? 'unknown error'}`)
      }
    }

    return result
  },

  // -------- brands --------

  // Powers the category drill-down. Counts come from the DB rather than
  // being computed client-side, so the numbers can't drift.
  // `noProfile`: only brands with no SponsorUnited profile id. These
  // are invisible everywhere else — Needs contacts lists brands with
  // nobody on file, which is a different and much smaller set, so "193
  // have no profile" had nowhere to be looked at.
  async listBrands({ category, search, take = 500, noProfile }: any) {
    const brands = await prisma.brand.findMany({
      where: {
        ...(category && category !== 'all' ? { category } : {}),
        ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
        ...(noProfile ? { externalId: null, passedAt: null, doNotEmail: false } : {}),
      },
      include: {
        _count: { select: { contacts: true, targets: true } },
        // Decision-makers first, but never pretend a brand with contacts
        // has none — that read as "No contacts yet" next to "5 contacts".
        contacts: {
          orderBy: { isDecisionMaker: 'desc' },
          select: { name: true, title: true, linkedinUrl: true },
          take: 3,
        },
        // Outreach state for the card: invited / replied and when.
        targets: { select: { status: true, sentAt: true, repliedAt: true, shelved: true } },
      },
      take,
    })

    // Brands with contacts first — those are the actionable ones.
    // Then by tier, emerging ahead of established: hungrier for
    // awareness, faster to say yes.
    const tierRank: Record<string, number> = { emerging: 0, growth: 1, established: 2 }
    const sorted = brands.sort((a, b) => {
      const aHas = a._count.contacts > 0 ? 0 : 1
      const bHas = b._count.contacts > 0 ? 0 : 1
      if (aHas !== bHas) return aHas - bHas
      const at = tierRank[a.tier ?? ''] ?? 3
      const bt = tierRank[b.tier ?? ''] ?? 3
      if (at !== bt) return at - bt
      return a.name.localeCompare(b.name)
    })
    // Flatten each brand's targets into the card's outreach summary —
    // invited / replied and the dates, so the list answers "where does
    // this brand stand?" without opening it.
    return sorted.map(b => {
      const ts = b.targets
      const sent = ts.filter(t => t.sentAt)
      const replied = ts.filter(t => t.repliedAt)
      const last = (xs: Date[]) => xs.length ? new Date(Math.max(...xs.map(d => d.getTime()))) : null
      const { targets, ...rest } = b
      return {
        ...rest,
        outreach: {
          queued: ts.filter(t => !t.shelved && ['queued', 'drafted'].includes(t.status)).length,
          invited: sent.length,
          replied: replied.length,
          lastSentAt: last(sent.map(t => t.sentAt!)),
          lastRepliedAt: last(replied.map(t => t.repliedAt!)),
        },
      }
    })
  },

  // Per-category reach for the Brands tab chips: how many brands in
  // each category anyone has actually invited (sentAt), out of how
  // many exist. Passed brands are counted separately, not as reach.
  async categoryReach() {
    const brands = await prisma.brand.findMany({
      select: {
        category: true, passedAt: true,
        targets: { select: { sentAt: true } },
      },
    })
    const out: Record<string, { total: number; reached: number; passed: number }> = {}
    let all = { total: 0, reached: 0, passed: 0 }
    for (const b of brands) {
      const key = b.category ?? 'uncategorised'
      const row = (out[key] ??= { total: 0, reached: 0, passed: 0 })
      const reached = b.targets.some(t => t.sentAt)
      row.total += 1; all.total += 1
      if (reached) { row.reached += 1; all.reached += 1 }
      if (b.passedAt) { row.passed += 1; all.passed += 1 }
    }
    return { categories: out, all }
  },

  // -------- shows (read live from sb-crm) --------

  // Confirmed, not-yet-played shows — the inventory you can sell against.
  // Read-only against sb-crm. Never writes.
  // Confirmed shows — read from the team's CRM Google Sheet (see
  // lib/shows.ts), not from sb-crm's lead table any more. A show is
  // confirmed only when the sheet row has a booked status AND a date AND
  // an artist AND a school. Past shows are folded in from the website
  // archive for the sponsor page; the tab shows this season by default.
  async listShows({ search, onlyUnsold, includePast, refresh }: any = {}) {
    if (refresh) await refreshShows()
    const [all, cache] = await Promise.all([allShows(), cachedShows()])
    const season = all.shows.filter(s => !s.past).map(s => s.season)[0] || null
    let rows = includePast ? all.shows : all.shows.filter(s => !s.past || (s.source === 'sheet' && (!season || s.season === season)))

    const links = await prisma.showSponsor.findMany({
      where: { crmLeadId: { in: rows.map(r => r.id) } },
      include: { brand: { select: { id: true, name: true } } },
    })
    const byShow: Record<string, any[]> = {}
    for (const link of links) (byShow[link.crmLeadId] ??= []).push(link)

    let shows = rows.map(r => ({
      id: r.id,
      stage: r.status,
      past: r.past,
      source: r.source,
      school: r.schoolName,
      schoolShort: r.school,
      chapter: r.chapter,
      artist: r.artist,
      type: r.type,
      genre: r.genre,
      rep: r.rep,
      eventDate: r.date,
      season: r.season,
      venue: null as string | null,
      attendance: null as number | null,
      eventType: null as string | null,
      ticketing: null as string | null,
      city: r.city,
      state: r.state,
      sponsors: (byShow[r.id] ?? []).map(l => ({
        brandId: l.brand.id, brandName: l.brand.name, status: l.status,
        valueCents: l.valueCents,
      })),
    }))

    if (search) {
      const q = String(search).toLowerCase()
      shows = shows.filter(s =>
        [s.school, s.schoolShort, s.chapter, s.artist, s.city, s.state, s.genre].some(v => v && String(v).toLowerCase().includes(q))
      )
    }
    if (onlyUnsold) shows = shows.filter(s => s.sponsors.length === 0)

    return {
      connected: true,
      source: 'sheet',
      updatedAt: cache.at,
      total: shows.length,
      unsold: shows.filter(s => s.sponsors.length === 0).length,
      rejected: cache.rejected.length,
      genres: GENRES,
      // The brand-facing page. SPONSOR_HOST only when Leo has actually
      // attached that domain in Vercel — otherwise its links 404, so the
      // fallback is the page on the deployment itself, which always works.
      sponsorUrl: process.env.SPONSOR_HOST
        ? 'https://' + process.env.SPONSOR_HOST + '/'
        : (process.env.SITE_URL || 'https://sb-digitaldashboard.vercel.app') + '/partnerships',
      shows,
    }
  },

  // Re-read the CRM sheet now (also runs daily with the email cron).
  async refreshShows() {
    return refreshShows()
  },

  // Rows the sheet parser skipped and why — so a rep can fix the sheet.
  async listShowRejects() {
    const c = await cachedShows()
    return { updatedAt: c.at, rejected: c.rejected }
  },

  // Genre override for one artist (blank genre = back to auto-tag).
  async setArtistGenre({ artist, genre }: any) {
    if (genre && !(GENRES as readonly string[]).includes(genre)) throw new Error('Unknown genre')
    return { overrides: await setGenreOverride(String(artist || ''), String(genre || '')) }
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

  // Merge a duplicate brand into the one you're keeping. Two-step like
  // deleteBrand: called without confirm it only reports what would move,
  // so the UI can show exactly what changes before anything does.
  // Everything hanging off the duplicate (contacts, targets, deals,
  // shows, documents, activations, board activity, ops links) is
  // re-pointed at the keeper; empty fields on the keeper are filled from
  // the duplicate; then the empty duplicate is deleted.
  async mergeBrands({ fromId, toId, confirm = false }: any) {
    if (!fromId || !toId) throw new Error('Pick both brands')
    if (fromId === toId) throw new Error('That is the same brand')
    const [from, to] = await Promise.all([
      prisma.brand.findUnique({ where: { id: fromId }, include: { partner: true, _count: { select: { contacts: true, targets: true, shows: true, deals: true, documents: true, activations: true, boardVisits: true } } } }),
      prisma.brand.findUnique({ where: { id: toId }, include: { partner: true } }),
    ])
    if (!from || !to) throw new Error('Brand not found')

    // Shows both brands are attached to: the keeper's row wins, the
    // duplicate's copy (and its auto-deal, by cascade) is dropped.
    const [fromShows, toShows] = await Promise.all([
      prisma.showSponsor.findMany({ where: { brandId: fromId }, select: { id: true, crmLeadId: true } }),
      prisma.showSponsor.findMany({ where: { brandId: toId }, select: { crmLeadId: true } }),
    ])
    const toLeadIds = new Set(toShows.map(s => s.crmLeadId))
    const dupShowIds = fromShows.filter(s => toLeadIds.has(s.crmLeadId)).map(s => s.id)

    const summary = {
      from: from.name, to: to.name,
      contacts: from._count.contacts, targets: from._count.targets,
      shows: from._count.shows - dupShowIds.length, dupShows: dupShowIds.length,
      deals: from._count.deals, documents: from._count.documents,
      activations: from._count.activations, boardVisits: from._count.boardVisits,
    }
    if (!confirm) return { merged: false, summary }

    // Fields the keeper is missing, taken from the duplicate.
    const fill: Record<string, any> = {}
    for (const k of ['website', 'hq', 'category', 'tier', 'linkedinUrl', 'goals', 'owner', 'notes', 'about', 'topProducts', 'boardCode'] as const) {
      if (!to[k] && from[k]) fill[k] = from[k]
    }
    if (from.doNotEmail && !to.doNotEmail) fill.doNotEmail = true
    const moveExternalId = !to.externalId && !!from.externalId ? from.externalId : null

    await prisma.$transaction(async tx => {
      if (dupShowIds.length) await tx.showSponsor.deleteMany({ where: { id: { in: dupShowIds } } })
      await tx.contact.updateMany({ where: { brandId: fromId }, data: { brandId: toId } })
      await tx.target.updateMany({ where: { brandId: fromId }, data: { brandId: toId } })
      await tx.deal.updateMany({ where: { brandId: fromId }, data: { brandId: toId } })
      await tx.showSponsor.updateMany({ where: { brandId: fromId }, data: { brandId: toId } })
      await tx.document.updateMany({ where: { brandId: fromId }, data: { brandId: toId } })
      await tx.activation.updateMany({ where: { brandId: fromId }, data: { brandId: toId } })
      await tx.boardVisit.updateMany({ where: { brandId: fromId }, data: { brandId: toId } })
      await tx.boardAccessRequest.updateMany({ where: { brandId: fromId }, data: { brandId: toId } })
      await tx.opsMessage.updateMany({ where: { brandId: fromId }, data: { brandId: toId } })
      await tx.discoveredBrand.updateMany({ where: { brandId: fromId }, data: { brandId: toId } })
      // Partner is one-per-brand: move it only if the keeper has none.
      if (from.partner && !to.partner) {
        await tx.partner.update({ where: { brandId: fromId }, data: { brandId: toId } })
      }
      // externalId is unique — free it on the duplicate before it lands
      // on the keeper, so a re-sync from SponsorUnited finds one brand.
      if (moveExternalId) {
        await tx.brand.update({ where: { id: fromId }, data: { externalId: null } })
        fill.externalId = moveExternalId
      }
      if (Object.keys(fill).length) await tx.brand.update({ where: { id: toId }, data: fill })
      await tx.brand.delete({ where: { id: fromId } })
    })
    return { merged: true, summary }
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

    const [boardViewCount, lastVisit, recentVisits] = await Promise.all([
      prisma.boardVisit.count({ where: { brandId } }),
      prisma.boardVisit.findFirst({ where: { brandId }, orderBy: { createdAt: 'desc' } }),
      // The visit log for the brand page: who opened the board with this
      // brand's code and when, newest first.
      prisma.boardVisit.findMany({
        where: { brandId },
        orderBy: { createdAt: 'desc' },
        take: 15,
        select: { email: true, createdAt: true, lastSeenAt: true },
      }),
    ])

    // Flag, never filter (Leo): SB sells US college shows, so a contact
    // running EMEA or sitting in Zürich is almost never the buyer — but
    // the call stays his. Nothing is hidden or un-queued; the row just
    // says so.
    const brandOut = {
      ...brand,
      contacts: brand.contacts.map(c => ({ ...c, region: regionFlag(c.location, c.title)?.label ?? null })),
    }

    // A Show Board access request waiting on a decision for this brand.
    // Approving is the same call the Show Board queue makes; it just
    // wasn't reachable from the place you look the brand up. Pending
    // rows carry no brandId (it is stamped when decided), so they are
    // matched by the company the requester typed — against our name or
    // any "also known as".
    const names = [brand.name, ...((brand.aka ?? '').split(/[,;]/))]
      .map(x => x.trim().toLowerCase()).filter(Boolean)
    const pendingAccess = (await prisma.boardAccessRequest.findMany({
      where: { status: 'pending' },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })).filter(r => r.brandId === brand.id || names.includes(r.company.trim().toLowerCase()))

    return {
      brand: brandOut, events, money,
      accessRequests: pendingAccess,
      boardViews: { count: boardViewCount, last: lastVisit, recent: recentVisits },
    }
  },

  // Generate (or clear) a brand's Show Board access code. Uniqueness is
  // enforced here rather than by the schema (see prisma/schema.prisma).
  async setBrandCode({ brandId, clear }: any) {
    if (clear) {
      await prisma.brand.update({ where: { id: brandId }, data: { boardCode: null } })
      return { code: null }
    }
    for (let i = 0; i < 5; i++) {
      const code = newBoardCode()
      const taken = await prisma.brand.findFirst({ where: { boardCode: code } })
      if (taken) continue
      await prisma.brand.update({ where: { id: brandId }, data: { boardCode: code } })
      return { code }
    }
    throw new Error('Could not generate a unique code — try again')
  },

  // One click on the brand page: search the public web and fill in the
  // brand's website, what it does, and its best sellers. Costs one small
  // Anthropic web-search call; only empty fields are written, so
  // hand-entered data is never overwritten. (Approved by Leo 2026-09-15.)
  async enrichBrand({ brandId }: any) {
    const brand = await prisma.brand.findUnique({ where: { id: brandId } })
    if (!brand) throw new Error('Brand not found')
    if (NO_PAID_APIS) throw new Error('Auto-fill is turned off — this site makes no paid API calls. Fill the fields by hand instead.')
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const prompt =
      `Research the consumer brand "${brand.name}"${brand.website ? ` (website: ${brand.website})` : ''}. ` +
      'Return ONLY a JSON object, no prose: {"website": "official site URL", ' +
      '"about": "what the company does, one plain sentence under 140 characters", ' +
      '"topProducts": "their best-selling products, comma-separated, under 140 characters"}. ' +
      'If you cannot find the brand, return {"website":null,"about":null,"topProducts":null}.'
    let text = ''
    let lastErr: any = null
    for (const model of ['claude-sonnet-5', 'claude-haiku-4-5']) {
      try {
        const res: any = await anthropic.messages.create({
          model, max_tokens: 1000,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }] as any,
          messages: [{ role: 'user', content: prompt }],
        })
        text = res.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
        if (text) break
      } catch (err: any) {
        lastErr = err
        if (/credit balance|billing|purchase credits/i.test(String(err?.message ?? ''))) {
          throw new Error('Auto-fill needs API credits (console.anthropic.com → Plans & Billing).')
        }
        if (!(err?.status === 404 || /model/i.test(err?.message ?? ''))) throw err
      }
    }
    if (!text) throw lastErr ?? new Error('Search produced nothing — try again')
    const m = text.replace(/```(?:json)?/g, '').match(/\{[\s\S]*\}/)
    if (!m) throw new Error('Could not parse the result — try again')
    let j: any = {}
    try { j = JSON.parse(m[0]) } catch { throw new Error('Could not parse the result — try again') }
    const data: Record<string, string> = {}
    if (!brand.website && j.website) data.website = String(j.website).slice(0, 300)
    if (!brand.about && j.about) data.about = String(j.about).slice(0, 200)
    if (!brand.topProducts && j.topProducts) data.topProducts = String(j.topProducts).slice(0, 200)
    if (Object.keys(data).length) await prisma.brand.update({ where: { id: brandId }, data })
    return { found: j, filled: Object.keys(data) }
  },

  // Fill empty About / Best sellers fields from the hand-typed table in
  // src/data/brand-summaries.json — zero API calls, matches on the brand
  // name or any "also known as" name. Never touches a non-empty field,
  // so hand edits and auto-filled data stay as they are. Idempotent.
  async fillBrandSummaries() {
    const table = BRAND_SUMMARIES as Record<string, { about?: string; topProducts?: string }>
    const brands = await prisma.brand.findMany({
      where: { OR: [{ about: null }, { topProducts: null }] },
    })
    let filled = 0
    const unmatched: string[] = []
    for (const b of brands) {
      const names = [b.name, ...(b.aka ?? '').split(/[,;]/)]
        .map(s => s.trim().toLowerCase()).filter(Boolean)
      const hit = names.map(n => table[n]).find(v => v && typeof v === 'object')
      if (!hit) { if (!b.about) unmatched.push(b.name); continue }
      const data: Record<string, string> = {}
      if (!b.about && hit.about) data.about = hit.about.slice(0, 200)
      if (!b.topProducts && hit.topProducts) data.topProducts = hit.topProducts.slice(0, 200)
      if (Object.keys(data).length) {
        await prisma.brand.update({ where: { id: b.id }, data })
        filled++
      }
    }
    return { filled, unmatched }
  },

  async updateBrand({ brandId, ...fields }: any) {
    const allowed = ['category', 'tier', 'owner', 'notes', 'goals', 'website', 'linkedinUrl', 'hq', 'externalId', 'about', 'topProducts', 'aka'] as const
    const data: Record<string, any> = {}
    for (const key of allowed) {
      if (fields[key] !== undefined) data[key] = fields[key] === '' ? null : fields[key]
    }
    if (fields.doNotEmail !== undefined) data.doNotEmail = !!fields.doNotEmail
    // People to work at once at this brand: 1-4, or null to follow the
    // suggestion (which opens wider on a brand nobody has written to).
    if (fields.workPeople !== undefined) {
      const n = Number(fields.workPeople)
      data.workPeople = n >= 1 && n <= 4 ? Math.round(n) : null
    }
    // Renaming is allowed but never to empty; a clash with an existing
    // brand means it's a duplicate — merge, don't rename over it.
    if (fields.name !== undefined) {
      const clean = String(fields.name).trim()
      if (!clean) throw new Error('The brand name cannot be empty')
      data.name = clean
    }
    if (Object.keys(data).length === 0) throw new Error('Nothing to update')
    try {
      return await prisma.brand.update({ where: { id: brandId }, data })
    } catch (err: any) {
      if (err?.code === 'P2002') throw new Error('Another brand already has that name — use "Merge duplicate…" instead')
      throw err
    }
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

    // Shows from the CRM sheet (same source as the Shows tab).
    let shows: any[] = []
    try {
      const q = query.toLowerCase()
      const all = await allShows()
      shows = all.shows
        .filter(x => !x.past && [x.schoolName, x.school, x.chapter, x.artist, x.city, x.state].some(v => v && v.toLowerCase().includes(q)))
        .map(x => ({ id: x.id, school: x.schoolName, chapter: x.chapter, artist: x.artist, eventDate: x.date }))
        .slice(0, take)
    } catch (err) {
      console.error('[search] show read failed', err)
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
  async upsertContact({ id, brandId, name, title, email, phone, location, linkedinUrl, isDecisionMaker, notes }: any) {
    if (id) {
      const before = await prisma.contact.findUnique({ where: { id } })
      const updated = await prisma.contact.update({
        where: { id },
        // notes is optional on the way in: the quick note box sends only
        // that field, and undefined leaves the rest alone.
        data: { name, title, email, phone, location, linkedinUrl, isDecisionMaker, notes },
      })
      // A renamed person needs re-personalized messages (the Ellen /
      // "Elle" case): drop their never-hand-edited drafts so the queue
      // regenerates them with the corrected name on next load.
      if (before && name && before.name !== name) {
        await prisma.draft.deleteMany({ where: { editedByHuman: false, target: { contactId: id } } })
      }
      return updated
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
        notes: notes || null,
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

  // Two companies under one name. "On!" is Altria's nicotine pouch brand
  // and "On" is the Swiss running brand, and SponsorUnited's capture put
  // both sets of people on one record — 42 contacts, some @on.com, some
  // selling nicotine. Moving them one at a time through moveContact is
  // 42 round trips, so this takes a selection at once.
  //
  // Same rule as a single move, for the same reason: a conversation that
  // happened under the old record stays there, and anything not yet sent
  // comes off the queue with its draft, because the draft was written
  // for the wrong company.
  async splitBrand({ fromBrandId, contactIds, toBrandId, toName, category, tier, moveProfile, apply }: any) {
    const from = await prisma.brand.findUnique({
      where: { id: fromBrandId },
      select: { id: true, name: true, externalId: true, _count: { select: { contacts: true } } },
    })
    if (!from) throw new Error('Brand not found')
    const ids: string[] = Array.isArray(contactIds) ? contactIds.slice(0, 500) : []
    if (!ids.length) throw new Error('Pick at least one person to move')

    const moving = await prisma.contact.findMany({
      where: { id: { in: ids }, brandId: from.id },
      select: {
        id: true, name: true, title: true, email: true,
        targets: { select: { id: true, status: true, sentAt: true } },
      },
    })
    if (!moving.length) throw new Error('None of those people are at this brand')
    if (moving.length >= from._count.contacts) {
      throw new Error(`That is everyone at ${from.name} — rename the brand instead of splitting it.`)
    }

    // Where they are going: an existing brand, or a new one by name.
    let target = toBrandId
      ? await prisma.brand.findUnique({ where: { id: toBrandId }, select: { id: true, name: true } })
      : null
    const wantedName = String(toName ?? '').trim()
    if (!target && wantedName) {
      target = await prisma.brand.findFirst({
        where: { name: { equals: wantedName, mode: 'insensitive' } },
        select: { id: true, name: true },
      })
    }
    if (!target && !wantedName) throw new Error('Name the brand they are moving to')
    if (target && target.id === from.id) throw new Error('That is the same brand')

    const isWorked = (t: { status: string; sentAt: Date | null }) =>
      !!t.sentAt || ['sent', 'accepted', 'replied', 'converted', 'declined'].includes(t.status)
    const pendingIds = moving.flatMap(c => c.targets.filter(t => !isWorked(t)).map(t => t.id))
    const workedCount = moving.reduce((n, c) => n + c.targets.filter(isWorked).length, 0)

    // The saved SponsorUnited profile is one company's, and when the
    // people being moved came from a capture of it, it is theirs: left
    // behind, the next sweep would land their colleagues on the wrong
    // record again. Only offered when there is a profile to move.
    const profileMoves = !!moveProfile && !!from.externalId
    const summary = {
      fromBrandId: from.id,
      fromBrandName: from.name,
      toBrandId: target?.id ?? null,
      toBrandName: target?.name ?? wantedName,
      toIsNew: !target,
      profileMoves,
      moving: moving.map(c => ({ id: c.id, name: c.name, title: c.title, email: c.email })),
      staying: from._count.contacts - moving.length,
      historyStays: workedCount,
      queuedDropped: pendingIds.length,
    }
    if (!apply) return { preview: true, ...summary }

    const created = target
      ? target
      : await prisma.brand.create({
          data: {
            name: wantedName,
            category: category || guessCategory(wantedName),
            tier: tier || null,
            source: 'manual',
          },
          select: { id: true, name: true },
        })

    await prisma.$transaction(async tx => {
      if (pendingIds.length) {
        await tx.draft.deleteMany({ where: { targetId: { in: pendingIds } } })
        await tx.target.updateMany({ where: { id: { in: pendingIds } }, data: { shelved: true, queuedFor: null } })
      }
      await tx.contact.updateMany({
        where: { id: { in: moving.map(c => c.id) } },
        data: { brandId: created.id },
      })
      if (profileMoves) {
        // externalId is unique: clear it here before setting it there.
        await tx.brand.update({ where: { id: from.id }, data: { externalId: null } })
        await tx.brand.update({ where: { id: created.id }, data: { externalId: from.externalId } })
      }
    })
    return { split: true, ...summary, toBrandId: created.id, toBrandName: created.name }
  },

  // People change jobs, and SponsorUnited keeps listing them at the old
  // company for months. Moving them by hand meant deleting and retyping,
  // which threw away everything already known about them.
  //
  // What follows the person and what stays behind is the whole question.
  // A conversation that happened at Celsius happened at Celsius — that
  // history stays on the old brand, or the brand card starts lying about
  // who it has spoken to. Anything not yet sent moves with them, and the
  // drafts go: a note written for Celsius is wrong at Poppi.
  //
  // Previews first. Nothing changes until `apply` is set.
  async moveContact({ contactId, toBrandId, apply }: any) {
    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
      include: {
        brand: { select: { id: true, name: true } },
        targets: { select: { id: true, status: true, sentAt: true, shelved: true } },
      },
    })
    if (!contact) throw new Error('Person not found')
    const to = await prisma.brand.findUnique({ where: { id: toBrandId }, select: { id: true, name: true, tier: true, owner: true } })
    if (!to) throw new Error('Brand not found')
    if (to.id === contact.brandId) throw new Error(`${contact.name} is already at ${to.name}`)

    // Worked = an invite went out, or they answered. That belongs to the
    // old brand for good.
    const worked = contact.targets.filter(t => t.sentAt || ['sent', 'accepted', 'replied', 'converted', 'declined'].includes(t.status))
    const pending = contact.targets.filter(t => !worked.includes(t))
    const duplicate = await prisma.contact.findFirst({
      where: { brandId: to.id, name: { equals: contact.name, mode: 'insensitive' } },
      select: { id: true, name: true },
    })

    const summary = {
      contactId: contact.id,
      contactName: contact.name,
      fromBrandId: contact.brand.id,
      fromBrandName: contact.brand.name,
      toBrandId: to.id,
      toBrandName: to.name,
      // Stays on the old brand as history.
      historyStays: worked.length,
      // Comes off the queue: it was queued against the old company.
      queuedDropped: pending.length,
      duplicateAt: duplicate ? duplicate.name : null,
    }
    if (!apply) return { preview: true, ...summary }

    await prisma.$transaction(async tx => {
      // Un-sent work was aimed at the old company — shelve it rather
      // than delete it, and bin the drafts that named the old brand.
      if (pending.length) {
        const ids = pending.map(t => t.id)
        await tx.draft.deleteMany({ where: { targetId: { in: ids } } })
        await tx.target.updateMany({ where: { id: { in: ids } }, data: { shelved: true, queuedFor: null } })
      }
      await tx.contact.update({
        where: { id: contact.id },
        data: { brandId: to.id, source: 'manual' },
      })
    })
    return { moved: true, ...summary }
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
  // stamp:false queues into the pool without the today-stamp, so the
  // brand waits for its category day instead of jumping into Today.
  async queueBrandTargets({ brandId, force, stamp = true }: any) {
    const brand = await prisma.brand.findUnique({
      where: { id: brandId },
      include: {
        // Reachable = has an email OR a LinkedIn URL. The LinkedIn-only
        // gate was a holdover from when outreach was LinkedIn messages;
        // for email outreach a work address is the thing that matters,
        // and most imported contacts have one without the other.
        contacts: {
          where: { OR: [{ email: { not: null } }, { linkedinUrl: { not: null } }] },
          orderBy: { isDecisionMaker: 'desc' },
        },
        targets: { include: { contact: { select: { name: true } } } },
      },
    })
    if (!brand) throw new Error('Brand not found')
    if (brand.passedAt) throw new Error(`${brand.name} is passed — bring it back from its brand page first.`)

    // Someone at this brand already wrote back: stop cold-pitching it.
    // A deliberate click (force) still goes through — that is a
    // follow-up, not a recommendation.
    const answered = brand.targets.find(t => ['replied', 'converted'].includes(t.status))
    if (answered && !force) {
      return {
        queued: false, reason: 'inconversation',
        contactName: answered.contact.name, status: answered.status,
        brandId: brand.id, brandName: brand.name,
      }
    }

    // Two people per brand can be in play at once (Leo's rule): a
    // second thread doubles the odds without reading as a blast. Queue
    // is a no-op only once both slots are taken.
    // force (the row's "+ Person" button) deliberately goes past the
    // brand's slot count — an explicit click, not an auto-pick. Leo's
    // explicit setting wins; otherwise the rules-based recommendation.
    const coldBrand = !brand.targets.some(t => t.sentAt)
    const WORK_PER_BRAND = brand.workPeople ?? recommendWorkPeople(brand, brand.contacts, coldBrand)
    // Queued is NOT contacted. Lumping the two together was the bug
    // behind "invite already sent out" on a brand nobody had written
    // to: one person merely sitting in the queue filled the brand's
    // only slot, and the search dead-ended instead of surfacing them.
    const live = brand.targets.filter(t => !t.shelved && ['queued', 'drafted', 'sent', 'accepted', 'replied'].includes(t.status))
    const pending = live.filter(t => ['queued', 'drafted'].includes(t.status))
    const contacted = live.filter(t => ['sent', 'accepted', 'replied'].includes(t.status))

    // Already queued but waiting in the pool (no today stamp): asking
    // for this brand again means "I want them today" — promote them
    // instead of refusing. This is what makes a brand added from the
    // Schedule show up when you search for it.
    const startOfDay = startOfLocalDay()
    const pooled = pending.filter(t => !t.queuedFor || t.queuedFor < startOfDay)
    const promotedNames: string[] = []
    if (stamp && pooled.length) {
      await prisma.target.updateMany({
        where: { id: { in: pooled.map(t => t.id) } },
        data: { queuedFor: new Date() },
      })
      promotedNames.push(...pooled.map(t => t.contact.name))
    }
    // Everyone this brand works is already in today's list — say so
    // plainly, and never call a queued person "sent".
    if (!force && live.length >= WORK_PER_BRAND) {
      if (promotedNames.length) {
        return { queued: true, promoted: true, count: promotedNames.length, contactName: joinNames(promotedNames) }
      }
      return {
        queued: false,
        reason: contacted.length >= WORK_PER_BRAND ? 'contacted' : 'already',
        contactName: live.map(t => t.contact.name).join(' and '),
        pending: pending.length, contacted: contacted.length,
        brandId: brand.id, brandName: brand.name,
        status: contacted.length ? contacted[0].status : 'in today’s list',
      }
    }
    const second = live.length === 1

    // How many more this brand should have in play. A cold brand's
    // recommendation is three or four people, but this used to add one
    // per call and nothing called it again — so every brand opened with
    // a single thread no matter what the recommendation said. Fill the
    // slots in one go. "+ Person" (force) still adds exactly one,
    // because that is a deliberate click past the brand's count.
    const room = force ? 1 : Math.max(0, WORK_PER_BRAND - live.length)
    if (room === 0) {
      return promotedNames.length
        ? { queued: true, promoted: true, count: promotedNames.length, contactName: joinNames(promotedNames) }
        : { queued: false, reason: 'already', contactName: live.map(t => t.contact.name).join(' and '), brandId: brand.id, brandName: brand.name }
    }

    // Shelved targets come back before new ones are made — they were
    // picked once already and reviving costs nothing.
    const revivable = brand.targets
      .filter(t => t.shelved && ['queued', 'drafted'].includes(t.status))
      .sort((a, b) => b.fitScore - a.fitScore)
      .slice(0, room)
    if (revivable.length) {
      await prisma.target.updateMany({
        where: { id: { in: revivable.map(t => t.id) } },
        data: { shelved: false, queuedFor: stamp ? new Date() : null },
      })
    }

    // Then fill what's left from the best reachable contacts nobody has
    // a target for. Best fit first, but anyone with an email address
    // outranks anyone without one — a target we can't email can't enter
    // the email queue.
    const targeted = new Set(brand.targets.map(t => t.contactId))
    const picks = dropExecsAtBigBrands(brand.contacts.filter(c => !targeted.has(c.id)), brand.tier)
      .sort((a, b) =>
        (b.email ? 1 : 0) - (a.email ? 1 : 0) ||
        scoreFit(b.title, brand.tier) - scoreFit(a.title, brand.tier))
      .slice(0, room - revivable.length)

    for (const pick of picks) {
      await prisma.target.create({
        data: {
          brandId, contactId: pick.id,
          fitScore: scoreFit(pick.title, brand.tier),
          assignedTo: brand.owner ?? null,
          queuedFor: stamp ? new Date() : null,
        },
      })
    }

    const names = [...promotedNames, ...revivable.map(t => t.contact.name), ...picks.map(p => p.name)]
    if (!names.length) {
      // Not an error: the UI opens the add-person form on 'nocontact'
      // so "queue this brand" always leads somewhere actionable.
      return {
        queued: false,
        reason: brand.contacts.length === 0 ? 'nocontact' : 'exhausted',
        brandId: brand.id, brandName: brand.name,
      }
    }
    // Queued, but the email drafter will skip anyone without an
    // address. Say so now rather than later.
    const noEmail = picks.filter(p => !p.email).map(p => p.name)
    return {
      queued: true,
      count: names.length,
      contactName: joinNames(names),
      second,
      revived: revivable.length > 0 && !picks.length,
      ...(noEmail.length
        ? { warning: `${joinNames(noEmail)} ${noEmail.length === 1 ? 'has' : 'have'} no email address yet — add one on the contact or the email drafter will skip ${brand.name}.` }
        : {}),
    }
  },

  // "Put them in" (Schedule tab): queue a list of brands into the pool
  // in one call. No today-stamp — each brand surfaces on its category
  // day through the normal rotation.
  async queueBrands({ brandIds }: any) {
    const ids = (Array.isArray(brandIds) ? brandIds : []).slice(0, 40)
    // Names up front, so every result can say which brand it is about
    // even on the paths that throw before reading one.
    const named = new Map(
      (await prisma.brand.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }))
        .map(b => [b.id, b.name]),
    )
    const results: any[] = []
    for (const bid of ids) {
      try {
        const r = await (handlers.queueBrandTargets as Handler)({ brandId: bid, stamp: false })
        results.push({ brandName: named.get(bid) ?? 'brand', ...r })
      } catch (e: any) {
        results.push({ queued: false, reason: e?.message || 'error', brandId: bid, brandName: named.get(bid) ?? 'brand' })
      }
    }
    // Grouped so "0 of 3" can say what actually stopped it rather than
    // leaving Leo to click each brand to find out.
    const failed: Record<string, string[]> = {}
    for (const r of results) {
      if (r?.queued) continue
      const key = String(r?.reason ?? 'unknown')
      ;(failed[key] ??= []).push(r?.brandName ?? 'brand')
    }
    return {
      queued: results.filter(r => r?.queued).length,
      // People, not brands: a cold brand now opens three or four
      // threads, so "4 brands queued" undercounts the day badly.
      people: results.reduce((n, r) => n + (r?.queued ? (r.count ?? 1) : 0), 0),
      total: results.length,
      failed,
      results,
    }
  },

  // Pass a whole brand: it disappears from the queue, auto-picks and
  // next-best until brought back. Queued people are shelved (not
  // deleted) so cancelling the pass restores them; threads already in
  // motion (sent/accepted/replied) keep tracking in Reached.
  async setBrandPassed({ brandId, passed }: any) {
    const brand = await prisma.brand.update({
      where: { id: brandId },
      data: { passedAt: passed ? new Date() : null },
    })
    if (passed) {
      await prisma.target.updateMany({
        where: { brandId, status: { in: ['queued', 'drafted'] } },
        data: { shelved: true, queuedFor: null },
      })
    }
    return { id: brand.id, name: brand.name, passed: !!brand.passedAt }
  },

  // -------- outreach schedule --------

  // The plan lives in Setting `outreachPlan` as { "YYYY-MM-DD":
  // { category, brandIds } }. getTodayQueue reads today's entry:
  // category overrides the rotation, brandIds are auto-queued.
  async getOutreachPlan() {
    const row = await prisma.setting.findUnique({ where: { key: 'outreachPlan' } })
    let plan: Record<string, any> = {}
    try { plan = row ? JSON.parse(row.value) : {} } catch { plan = {} }
    const ids = [...new Set(Object.values(plan).flatMap((d: any) => d?.brandIds ?? []))] as string[]
    const brands = ids.length
      ? await prisma.brand.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
      : []

    // Preview the week: for each of the next 7 days, the category that
    // day will actually run (planned beats rotation — same formula as
    // getTodayQueue) and the specific brands it would work, so the
    // Schedule tab can offer Add / Pass on each before the day arrives.
    // coldPoolBrand, not NOT_IN_CONVERSATION: these rows are the day's
    // suggestions, so a brand passed for today has to drop out of them.
    // Without it Pass only removed the row on screen and the next
    // refresh put it straight back.
    // Not coldPoolBrand(): "passed for today" wears off at midnight, so
    // it must not hold a brand out of TOMORROW's preview. It is applied
    // per day below, to today only.
    const candidates = await prisma.target.findMany({
      where: { status: { in: ['queued', 'drafted'] }, queuedFor: null, shelved: false, brand: NOT_IN_CONVERSATION },
      orderBy: [{ fitScore: 'desc' }, { createdAt: 'asc' }],
      take: 300,
      select: { fitScore: true, brand: { select: { id: true, name: true, category: true, website: true, linkedinUrl: true, passedTodayAt: true } } },
    })
    const byBrand = new Map<string, { id: string; name: string; category: string | null; website: string | null; linkedinUrl: string | null; people: number; fit: number }>()
    for (const c of candidates) {
      const b = byBrand.get(c.brand.id)
      if (b) { b.people += 1; b.fit = Math.max(b.fit, c.fitScore) }
      else byBrand.set(c.brand.id, { id: c.brand.id, name: c.brand.name, category: c.brand.category, website: c.brand.website, linkedinUrl: c.brand.linkedinUrl, people: 1, fit: c.fitScore })
    }
    const cats = [...new Set([...byBrand.values()].map(b => b.category).filter(Boolean))].sort() as string[]
    const planned = new Set(Object.values(plan).flatMap((d: any) => d?.brandIds ?? []))
    const totalPool = candidates.length

    // Every brand, filtered in JS rather than in the query. The same
    // rows answer two questions: which brands a day can still offer,
    // and — for the ones it can't — what is stopping each of them.
    // "Only 1 of 20 ready" with nothing underneath is unanswerable from
    // the screen when you know the roster has more brands than that.
    const everyBrand = await prisma.brand.findMany({
      select: {
        id: true, name: true, category: true, website: true, linkedinUrl: true,
        passedAt: true, passedTodayAt: true, doNotEmail: true,
        // tier and workPeople decide how many threads this brand runs at
        // once, which is the other reason a queue can refuse.
        tier: true, workPeople: true,
        _count: { select: { contacts: true } },
        // Reachability, not just a headcount: queueBrandTargets can only
        // pick someone with an email or a LinkedIn URL, so counting every
        // contact made "Add more" offer brands it could not queue —
        // "3 people" then came back as 0 of 3.
        contacts: { select: { id: true, title: true, email: true, linkedinUrl: true } },
        targets: { select: { status: true, shelved: true, sentAt: true, contactId: true } },
      },
    })
    const dayStart = startOfLocalDay()
    const inConversation = (b: (typeof everyBrand)[number]) =>
      b.targets.some(t => ['replied', 'converted'].includes(t.status))
    const passedToday = (b: (typeof everyBrand)[number]) =>
      !!b.passedTodayAt && b.passedTodayAt >= dayStart
    // What the query used to filter out.
    // passedToday is NOT filtered here: it is a today-only state, and
    // these rows feed every day's preview.
    const allBrands = everyBrand.filter(b =>
      !b.passedAt && !inConversation(b) && !b.doNotEmail && b.contacts.length > 0)
    const untouched = allBrands.filter(b =>
      !planned.has(b.id) && !byBrand.has(b.id) &&
      !b.targets.some(t => t.sentAt ||
        (!t.shelved && ['queued', 'drafted', 'sent', 'accepted', 'replied', 'converted'].includes(t.status))))

    // "Add more" means the REST of the category, not only brands with
    // nothing queued: a category whose brands each hold one queued
    // person still has spare people to add, and those brands belong in
    // the day's Add-more list too. `spare` = people not yet targeted.
    const reachableSpare = (b: (typeof allBrands)[number]) => {
      const taken = new Set(b.targets.map(t => t.contactId))
      return b.contacts.filter(c => (c.email || c.linkedinUrl) && !taken.has(c.id)).length
    }
    // A brand is only worth offering if queueBrandTargets would actually
    // take it. Spare people are not enough: a brand already running its
    // full number of threads refuses the next one, so it was being
    // listed and then answering "Could not queue" on the click.
    const hasRoomToWork = (b: (typeof allBrands)[number]) => {
      const live = b.targets.filter(t =>
        !t.shelved && ['queued', 'drafted', 'sent', 'accepted', 'replied'].includes(t.status))
      const limit = b.workPeople ?? recommendWorkPeople(b, b.contacts, !alreadyContacted(b))
      return live.length < limit
    }
    const addable = allBrands
      .map(b => ({ ...b, spare: reachableSpare(b) }))
      .filter(b => !planned.has(b.id) && b.spare > 0 && !alreadyContacted(b) && hasRoomToWork(b))

    // The one gate each brand is stuck behind, in the order the queue
    // itself would hit them. Null means the brand is available.
    // `forToday` decides whether "passed for today" counts as a gate:
    // it blocks today and nothing after it, and a brand can be stuck
    // behind a second gate underneath it, so the two cases are computed
    // separately rather than one being patched into the other.
    const blockedBy = (b: (typeof everyBrand)[number], forToday: boolean): string | null => {
      if (b.passedAt) return 'archived'
      if (b.doNotEmail) return 'donotemail'
      if (!b.contacts.length) return 'nopeople'
      if (!b.contacts.some(c => c.email || c.linkedinUrl)) return 'unreachable'
      if (inConversation(b)) return 'inconversation'
      if (b.targets.some(t => t.sentAt)) return 'contacted'
      if (forToday && passedToday(b)) return 'passedtoday'
      const taken = new Set(b.targets.map(t => t.contactId))
      if (!b.contacts.some(c => (c.email || c.linkedinUrl) && !taken.has(c.id))) return 'exhausted'
      if (!hasRoomToWork(b)) return 'full'
      return null
    }
    // Per category: how many brands it holds, and why the unavailable
    // ones are unavailable. Computed once, read by whichever day picked
    // that category.
    type HealthBrand = { id: string; name: string; contacts: number }
    type CatHealth = Map<string, { total: number; blocked: Record<string, HealthBrand[]> }>
    const buildHealth = (forToday: boolean): CatHealth => {
      const out: CatHealth = new Map()
      for (const b of everyBrand) {
        if (!b.category) continue
        const h = out.get(b.category) ?? { total: 0, blocked: {} }
        h.total += 1
        const why = blockedBy(b, forToday)
        if (why) (h.blocked[why] ??= []).push({ id: b.id, name: b.name, contacts: b.contacts.length })
        out.set(b.category, h)
      }
      return out
    }
    const healthToday = buildHealth(true)
    const healthLater = buildHealth(false)

    // True preview of each day's sends: the same picking order the real
    // queue uses (day's category first by fit, then the best of the
    // rest to top up to the cap), simulated forward so a person shown
    // on Monday is not shown again on Wednesday. The count is exactly
    // the people that would go out.
    // Today is special: people the LinkedIn tab already moved into the
    // queue (stamped today) and invites already sent both count, so the
    // Schedule's Today row always matches the actual queue.
    const startToday = startOfLocalDay()
    // What actually went out, per day, for the last two weeks — the
    // Schedule shows plan AND actuals so it never drifts from the
    // LinkedIn tab.
    const sinceLog = new Date(startToday.getTime() - 13 * 864e5)
    const [sentTodayN, stampedToday, sentLog] = await Promise.all([
      prisma.target.count({ where: { sentAt: { gte: startToday } } }),
      prisma.target.findMany({
        where: { queuedFor: { gte: startToday }, status: { in: ['queued', 'drafted'] }, shelved: false, brand: { passedAt: null } },
        orderBy: [{ fitScore: 'desc' }, { createdAt: 'asc' }],
        select: { fitScore: true, brand: { select: { id: true, name: true, category: true, website: true, linkedinUrl: true } } },
      }),
      prisma.target.findMany({
        where: { sentAt: { gte: sinceLog } },
        orderBy: { sentAt: 'desc' },
        select: {
          id: true, status: true, sentAt: true, repliedAt: true, dmSentAt: true,
          brand: { select: { id: true, name: true, category: true } },
          contact: { select: { name: true, title: true } },
        },
      }),
    ])
    // dayKey -> the invites logged that day.
    const sentByDay: Record<string, any[]> = {}
    for (const t of sentLog) {
      (sentByDay[localDayKey(t.sentAt!)] ??= []).push({
        id: t.id, status: t.status, brandId: t.brand.id, brand: t.brand.name,
        category: t.brand.category, person: t.contact.name, title: t.contact.title,
        repliedAt: t.repliedAt, dmSentAt: t.dmSentAt,
      })
    }
    let available = candidates.filter(c => !planned.has(c.brand.id))
    const todayKey = localDayKey(new Date())
    const days = planningDays(3).map(at => {
      const key = localDayKey(at)
      // Not "the first row" any more: on a Monday or Friday none of the
      // planned days is today, and today's queue must not be charged
      // against Tuesday.
      const isToday = key === todayKey
      const theme = plan[key]?.category
        ?? (cats.length ? cats[Math.floor(at.getTime() / 86400000) % cats.length] : null)
      // Hand-planned brands send that day too — their queued people
      // count toward the 20 but render as chips, not preview rows.
      const dayPlannedIds = new Set<string>(plan[key]?.brandIds ?? [])
      const plannedCount = candidates.filter(c => dayPlannedIds.has(c.brand.id)).length
      // Today only: what's already stamped into the queue and what
      // already went out both take up room before the simulation fills.
      const sentUsed = isToday ? sentTodayN : 0
      const alreadyIn = isToday ? stampedToday.filter(t => !dayPlannedIds.has(t.brand.id)) : []
      const alreadyPlanned = isToday ? stampedToday.length - alreadyIn.length : 0
      const room = Math.max(0, DAILY_SEND_LIMIT - plannedCount - sentUsed - (isToday ? stampedToday.length : 0))
      // Strictly the day's category — no cross-category top-ups (Leo).
      // A brand passed for today is out of today's preview and back in
      // every later day's.
      const usable = isToday
        ? available.filter(c => !(c.brand.passedTodayAt && c.brand.passedTodayAt >= dayStart))
        : available
      const inTheme = theme ? usable.filter(c => c.brand.category === theme) : usable
      const take = inTheme.slice(0, room)
      // The rest of the category. It used to be cut here and vanish, so
      // a day with thirty ready people looked like it had twenty and
      // the other ten were nowhere. They are shown as their own section
      // instead — and deliberately NOT consumed, so a later day with
      // the same category still gets them.
      const spill = inTheme.slice(room)
      const taken = new Set(take)
      available = available.filter(c => !taken.has(c))
      type DayRow = { id: string; name: string; people: number; later?: number; website: string | null; linkedinUrl: string | null; topUp: boolean; inQueue: boolean; category: string | null }
      const rows: DayRow[] = []
      const rowByBrand = new Map<string, DayRow>()
      for (const t of [...alreadyIn.map(a => ({ ...a, _inQueue: true })), ...take.map(c => ({ ...c, _inQueue: false }))]) {
        const r = rowByBrand.get(t.brand.id)
        if (r) r.people += 1
        else {
          const row = {
            id: t.brand.id, name: t.brand.name, people: 1,
            website: t.brand.website, linkedinUrl: t.brand.linkedinUrl,
            topUp: !!theme && t.brand.category !== theme,
            inQueue: t._inQueue, category: t.brand.category,
          }
          rowByBrand.set(t.brand.id, row)
          rows.push(row)
        }
      }
      // Same shape as the day's own rows, one entry per brand. People are
      // picked by fit, so a brand's first two can make the 20 and its
      // third miss it — that brand then showed twice, once going out and
      // once under "the rest". Its leftover people ride on its day row as
      // `later` instead; only brands wholly past the cap get a row here.
      const spillRows: DayRow[] = []
      const spillByBrand = new Map<string, DayRow>()
      for (const t of spill) {
        const going = rowByBrand.get(t.brand.id)
        if (going) { going.later = (going.later ?? 0) + 1; continue }
        const r = spillByBrand.get(t.brand.id)
        if (r) { r.people += 1; continue }
        const row: DayRow = {
          id: t.brand.id, name: t.brand.name, people: 1,
          website: t.brand.website, linkedinUrl: t.brand.linkedinUrl,
          topUp: false, inQueue: false, category: t.brand.category,
        }
        spillByBrand.set(t.brand.id, row)
        spillRows.push(row)
      }
      return {
        date: key,
        // The client used to assume day one was today; now it's told.
        today: isToday,
        category: theme,
        auto: !plan[key]?.category,
        ready: Math.min(DAILY_SEND_LIMIT, sentUsed + alreadyIn.length + alreadyPlanned + plannedCount + take.length),
        sent: sentUsed,
        sentPeople: sentByDay[key] ?? [],
        brands: rows,
        // Ready and in this category, but past the day's 20. Shown, not
        // hidden — the day is full, the people are real, and they carry
        // over to the next day in this category on their own.
        overflow: spillRows,
        // Why this category can't fill the day. Only sent when it
        // can't: a full day needs no explanation.
        // Named, not counted. Picking a category and seeing one brand
        // when the roster holds a dozen reads as the category not having
        // transferred — so the day lists every brand in it, and the ones
        // it can't work say what is wrong with them.
        health: theme && (isToday ? healthToday : healthLater).has(theme) ? (() => {
          const h = (isToday ? healthToday : healthLater).get(theme)!
          // A brand the day is already showing is not a brand the day
          // can't use. Zyn appeared as the day's one row AND under
          // "everyone reachable is already queued", which made the panel
          // contradict itself and inflated the count.
          const onScreen = new Set<string>([
            ...rowByBrand.keys(),
            ...spillByBrand.keys(),
            ...(theme ? addable.filter(b => b.category === theme && !(isToday && passedToday(b))).map(b => b.id) : []),
          ])
          const blocked: Record<string, { count: number; brands: HealthBrand[] }> = {}
          let blockedTotal = 0
          for (const [why, brands] of Object.entries(h.blocked)) {
            const rest = brands.filter(b => !onScreen.has(b.id))
            if (!rest.length) continue
            blocked[why] = { count: rest.length, brands: rest.slice(0, 25) }
            blockedTotal += rest.length
          }
          return { total: h.total, shown: h.total - blockedTotal, blockedTotal, blocked }
        })() : null,
        // Same-category brands whose people are NOT in the queue yet —
        // the day's Add-more section offers to put them in.
        missing: theme
          ? addable.filter(b => b.category === theme && !rowByBrand.has(b.id) && !spillByBrand.has(b.id) &&
              !(isToday && passedToday(b))).slice(0, 30)
              .map(b => ({ id: b.id, name: b.name, people: b.spare, website: b.website, linkedinUrl: b.linkedinUrl }))
          : [],
      }
    })

    const bench: { id: string; name: string; category: string | null; website: string | null; linkedinUrl: string | null; people: number; inQueue: boolean }[] = []
    for (const b of [...byBrand.values()].sort((a, b) => b.fit - a.fit)) {
      if (!planned.has(b.id)) bench.push({ id: b.id, name: b.name, category: b.category, website: b.website, linkedinUrl: b.linkedinUrl, people: b.people, inQueue: true })
    }
    for (const b of untouched) {
      bench.push({ id: b.id, name: b.name, category: b.category, website: b.website, linkedinUrl: b.linkedinUrl, people: reachableSpare(b), inQueue: false })
    }

    const past = Array.from({ length: 7 }, (_, i) => {
      const key = localDayKey(new Date(startToday.getTime() - (i + 1) * 864e5))
      return { date: key, people: sentByDay[key] ?? [] }
    }).filter(d => d.people.length)

    // How long each category can keep feeding days before it runs dry.
    // The Schedule could say a day was short but never why, and never
    // which category to go capture more of — so the answer was always
    // "run the sweep and hope". Two sources of people: those already
    // queued and waiting in the pool, and the spare people on brands
    // that would accept another thread (addable already applies the same
    // rules the queue does, so this cannot promise people the queue
    // would refuse).
    const runwayBy = new Map<string, { todo: Map<string, { id: string; name: string; people: number }>; people: number }>()
    const bump = (cat: string | null, brandId: string, name: string, people: number) => {
      const key = cat ?? 'uncategorised'
      const row = runwayBy.get(key) ?? { todo: new Map<string, { id: string; name: string; people: number }>(), people: 0 }
      const had = row.todo.get(brandId)
      if (had) had.people += people
      else row.todo.set(brandId, { id: brandId, name, people })
      row.people += people
      runwayBy.set(key, row)
    }
    for (const b of byBrand.values()) bump(b.category, b.id, b.name, b.people)
    for (const b of addable) bump(b.category, b.id, b.name, b.spare)

    // The other half of the picture: brands in this category we have
    // already written to. A category is not only "how much is left" —
    // opening one should show what has been done as well as what has
    // not, which is the question "have we worked this category yet".
    // Queried on its own because allBrands deliberately drops anyone in
    // conversation, and those are the most worked of all.
    const contacted = await prisma.brand.findMany({
      where: { targets: { some: { sentAt: { not: null } } } },
      select: {
        id: true, name: true, category: true,
        targets: { where: { sentAt: { not: null } }, select: { status: true, repliedAt: true } },
      },
      orderBy: { name: 'asc' },
    })
    const doneBy = new Map<string, Array<{ id: string; name: string; replied: boolean }>>()
    for (const b of contacted) {
      const key = b.category ?? 'uncategorised'
      const list = doneBy.get(key) ?? []
      list.push({ id: b.id, name: b.name, replied: b.targets.some(t => t.repliedAt) })
      doneBy.set(key, list)
    }
    for (const key of doneBy.keys()) {
      if (!runwayBy.has(key)) runwayBy.set(key, { todo: new Map(), people: 0 })
    }

    const runway = [...runwayBy.entries()]
      .map(([category, v]) => {
        const done = doneBy.get(category) ?? []
        return {
          category: category === 'uncategorised' ? null : category,
          brands: v.todo.size,
          people: v.people,
          // Whole sending days this category could fill on its own.
          days: Math.floor(v.people / DAILY_SEND_LIMIT),
          doneCount: done.length,
          // Capped: these only fill a panel someone opened, and a
          // category with two hundred brands does not need all of them
          // in every schedule load.
          todo: [...v.todo.values()].sort((a, b) => b.people - a.people).slice(0, 40),
          done: done.slice(0, 40),
        }
      })
      .sort((a, b) => a.people - b.people)

    return {
      plan, brands, today: localDayKey(), days, past,
      pool: { total: totalPool, cap: DAILY_SEND_LIMIT },
      runway,
      bench: bench.slice(0, 120),
    }
  },

  // Adding a brand to a day from the Schedule used to only write the
  // plan; the actual queueing happened later inside getTodayQueue's
  // try/catch, so a brand that could not be queued (nobody on file,
  // slots taken, archived) vanished with no explanation. Now the add
  // queues straight away when the day is today and hands back the
  // reason when it can't.
  async planAddBrand({ date, brandId }: any) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error('Bad date')
    const brand = await prisma.brand.findUnique({ where: { id: brandId }, select: { id: true, name: true } })
    if (!brand) throw new Error('Brand not found')

    const row = await prisma.setting.findUnique({ where: { key: 'outreachPlan' } })
    let plan: Record<string, any> = {}
    try { plan = row ? JSON.parse(row.value) : {} } catch { plan = {} }
    const day = plan[date] ?? { category: null, brandIds: [] }
    if (!day.brandIds.includes(brandId)) day.brandIds = [...day.brandIds, brandId].slice(0, 30)
    plan[date] = day
    const today = localDayKey()
    for (const k of Object.keys(plan)) if (k < today) delete plan[k]
    const value = JSON.stringify(plan)
    await prisma.setting.upsert({
      where: { key: 'outreachPlan' },
      create: { key: 'outreachPlan', value },
      update: { value },
    })

    // A future day is just a plan — it queues itself on the morning.
    if (date !== today) return { planned: true, forToday: false, brandName: brand.name }

    const queued: any = await (handlers.queueBrandTargets as Handler)({ brandId })
    return { planned: true, forToday: true, brandName: brand.name, ...queued }
  },

  async setOutreachPlanDay({ date, category, brandIds }: any) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error('Bad date')
    const row = await prisma.setting.findUnique({ where: { key: 'outreachPlan' } })
    let plan: Record<string, any> = {}
    try { plan = row ? JSON.parse(row.value) : {} } catch { plan = {} }
    const clean = {
      category: category || null,
      brandIds: Array.isArray(brandIds) ? brandIds.slice(0, 30) : [],
    }
    if (!clean.category && !clean.brandIds.length) delete plan[date]
    else plan[date] = clean
    // Past days age out so the setting never grows unbounded.
    const today = localDayKey()
    for (const k of Object.keys(plan)) if (k < today) delete plan[k]
    const value = JSON.stringify(plan)
    await prisma.setting.upsert({
      where: { key: 'outreachPlan' },
      create: { key: 'outreachPlan', value },
      update: { value },
    })
    return { ok: true, plan }
  },

  // The Passed tab: every brand currently passed, newest first, so a
  // pass is always one click from being cancelled.
  async listPassedBrands() {
    const brands = await prisma.brand.findMany({
      where: { passedAt: { not: null } },
      orderBy: { passedAt: 'desc' },
      include: { _count: { select: { contacts: true, targets: true } } },
    })
    return {
      brands: brands.map(b => ({
        id: b.id, name: b.name, category: b.category, tier: b.tier,
        passedAt: b.passedAt, contacts: b._count.contacts,
      })),
    }
  },

  // Brand page (Leo): pick exactly WHO goes into the queue. Queue one
  // specific person into today, whatever the auto-pick would have done.
  async queueContact({ contactId }: any) {
    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
      include: { brand: true, targets: true },
    })
    if (!contact) throw new Error('Person not found')
    if (contact.brand.passedAt) throw new Error(`${contact.brand.name} is passed — bring it back first.`)
    const t = contact.targets[0]
    if (t && ['sent', 'accepted', 'replied', 'converted'].includes(t.status)) {
      return { queued: false, reason: 'inplay', contactName: contact.name, status: t.status }
    }
    if (t) {
      await prisma.target.update({
        where: { id: t.id },
        data: {
          status: ['queued', 'drafted'].includes(t.status) ? t.status : 'queued',
          shelved: false, queuedFor: new Date(),
        },
      })
      return { queued: true, contactName: contact.name, revived: true }
    }
    const created = await prisma.target.create({
      data: {
        brandId: contact.brandId, contactId: contact.id,
        fitScore: scoreFit(contact.title, contact.brand.tier),
        assignedTo: contact.brand.owner ?? null,
        queuedFor: new Date(),
      },
    })
    return { queued: true, contactName: contact.name, targetId: created.id }
  },

  // Skip one specific person: their target goes to status 'passed' (or
  // is created that way), so the auto-pick never suggests them again.
  // Queue on the brand page brings them back.
  async passContact({ contactId }: any) {
    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
      include: { brand: true, targets: true },
    })
    if (!contact) throw new Error('Person not found')
    const t = contact.targets[0]
    if (t && ['sent', 'accepted', 'replied', 'converted'].includes(t.status)) {
      return { passed: false, reason: 'inplay', contactName: contact.name, status: t.status }
    }
    if (t) {
      await prisma.target.update({
        where: { id: t.id },
        data: { status: 'passed', queuedFor: null },
      })
    } else {
      await prisma.target.create({
        data: {
          brandId: contact.brandId, contactId: contact.id,
          fitScore: scoreFit(contact.title, contact.brand.tier),
          status: 'passed',
        },
      })
    }
    return { passed: true, contactName: contact.name }
  },

  // "Fill queue to 20": when today's category can't reach the cap from
  // the existing pool, queue the best untouched same-category brands
  // (one person each, straight into today) until it can. Strictly the
  // day's category — a shortfall is reported, never topped up from
  // elsewhere.
  // Change today's category and the people already stamped into today
  // stay stamped — they are the real queue, so the Schedule shows them
  // whatever category is picked. That is right, but it left no way to
  // actually change today's mind: the header said "Nicotine only" over
  // six Betting rows. This unstamps the ones outside today's category.
  //
  // Nothing is deleted and nothing is shelved: queuedFor goes back to
  // null, which returns those people to the pool to come up on their own
  // category's day. Anyone already written to (sent/accepted/replied) is
  // never touched — that thread is running.
  async clearTodayOffCategory({ preview = false }: any = {}) {
    const startOfDay = startOfLocalDay()
    const planRow = await prisma.setting.findUnique({ where: { key: 'outreachPlan' } })
    let planDay: any = null
    try { planDay = planRow ? (JSON.parse(planRow.value)[localDayKey()] ?? null) : null } catch { planDay = null }
    const theme: string | null = planDay?.category ?? null
    if (!theme) return { cleared: 0, theme: null, brands: [], reason: 'no category set for today' }

    // Hand-pinned brands are an explicit choice for today — leave them.
    const pinned = new Set<string>(planDay?.brandIds ?? [])
    const stamped = await prisma.target.findMany({
      where: {
        queuedFor: { gte: startOfDay },
        status: { in: ['queued', 'drafted'] },
        shelved: false,
      },
      select: { id: true, brand: { select: { id: true, name: true, category: true } } },
    })
    const off = stamped.filter(t => t.brand.category !== theme && !pinned.has(t.brand.id))
    const brands = [...new Set(off.map(t => t.brand.name))]
    if (preview || !off.length) return { cleared: 0, theme, brands, people: off.length, preview: true }

    await prisma.target.updateMany({
      where: { id: { in: off.map(t => t.id) } },
      data: { queuedFor: null },
    })
    return { cleared: off.length, theme, brands }
  },

  async fillToday() {
    // Monday and Friday are not sending days, so there is no "today" to
    // fill — say which day is next instead of quietly queueing people
    // for a day nothing goes out on.
    if (!isOutreachDay(new Date())) {
      return { added: 0, shortBy: 0, theme: null, offDay: true, nextDay: localDayKey(planningDays(1)[0]) }
    }
    const startOfDay = startOfLocalDay()
    const [sentToday, stamped, planRow, candidates] = await Promise.all([
      prisma.target.count({ where: { sentAt: { gte: startOfDay } } }),
      prisma.target.count({ where: { queuedFor: { gte: startOfDay }, status: { in: ['queued', 'drafted'] }, shelved: false, brand: { passedAt: null } } }),
      prisma.setting.findUnique({ where: { key: 'outreachPlan' } }),
      prisma.target.findMany({
        where: { status: { in: ['queued', 'drafted'] }, queuedFor: null, shelved: false, brand: NOT_IN_CONVERSATION },
        select: { brand: { select: { category: true } } },
      }),
    ])
    let planDay: any = null
    try { planDay = planRow ? (JSON.parse(planRow.value)[localDayKey()] ?? null) : null } catch { planDay = null }
    const cats = [...new Set(candidates.map(c => c.brand.category).filter(Boolean))].sort() as string[]
    const theme = planDay?.category
      ?? (cats.length ? cats[Math.floor(Date.now() / 86400000) % cats.length] : null)
    const themePool = theme ? candidates.filter(c => c.brand.category === theme).length : candidates.length
    let need = DAILY_SEND_LIMIT - sentToday - stamped - themePool
    if (need <= 0) return { added: 0, shortBy: 0, theme, already: true }

    const brands = await prisma.brand.findMany({
      where: {
        passedAt: null, ...notPassedToday(), doNotEmail: false, contacts: { some: {} },
        ...(theme ? { category: theme } : {}),
      },
      select: {
        id: true,
        targets: { select: { status: true, shelved: true, sentAt: true } },
      },
    })
    const untouched = brands.filter(b =>
      !b.targets.some(t => t.sentAt ||
        (!t.shelved && ['queued', 'drafted', 'sent', 'accepted', 'replied', 'converted'].includes(t.status))))
    let added = 0
    for (const b of untouched) {
      if (added >= need) break
      try {
        const r: any = await (handlers.queueBrandTargets as Handler)({ brandId: b.id })
        if (r?.queued) added += r.count ?? 1
      } catch { /* one bad brand never stops the fill */ }
    }
    return { added, shortBy: Math.max(0, need - added), theme }
  },

  // Which build is serving — the client compares on window focus and
  // shows a "site updated, reload" bar, so an open tab never keeps
  // running yesterday's UI silently.
  async appVersion() {
    return { sha: process.env.VERCEL_GIT_COMMIT_SHA || 'dev' }
  },

  // An accept is an email waiting to be written. Logged by hand ("Emailed
  // ✓" on Zach's list or the Results tab): the mail goes out of Zach's
  // own inbox, so nothing here touches the email machine or its cap.
  // on: false is the Done list's Undo.
  async markEmailed({ targetId, on = true }: any) {
    const t = await prisma.target.update({
      where: { id: targetId },
      data: { emailedAt: on ? new Date() : null },
      include: { contact: { select: { name: true } } },
    })
    return { emailedAt: t.emailedAt, contactName: t.contact.name }
  },

  // -------- For Zach to do (Home) --------

  // Zach's list, grouped by brand: a card per person, brands in the
  // order of their oldest invite (an accept going cold is the expensive
  // kind of nothing). Carries the template, the Done list for the last
  // HAND_DONE_DAYS, and whatever brand rule held back.
  async zachTodo() {
    const since = new Date(Date.now() - HAND_DONE_DAYS * 24 * 60 * 60 * 1000)
    const [template, rows, doneRows] = await Promise.all([
      readHandTemplate(),
      prisma.target.findMany({
        where: HAND_WAITING,
        include: {
          brand: { select: { id: true, name: true, category: true, about: true, website: true, linkedinUrl: true, passedAt: true, doNotEmail: true, notes: true } },
          contact: { select: { id: true, name: true, title: true, email: true, linkedinUrl: true } },
          // An automatic intro that already reached this person: Zach
          // should answer in that thread rather than start a second one.
          emails: { where: { direction: 'out', status: 'sent' }, orderBy: { sentAt: 'desc' }, take: 1, select: { sentAt: true, subject: true } },
          events: { where: { toStatus: 'accepted' }, orderBy: { createdAt: 'asc' }, take: 1, select: { createdAt: true } },
        },
        orderBy: [{ sentAt: 'asc' }, { createdAt: 'asc' }],
        take: 300,
      }),
      prisma.target.findMany({
        where: { OR: [{ emailedAt: { gte: since } }, { handSkippedAt: { gte: since } }] },
        select: {
          id: true, emailedAt: true, handSkippedAt: true,
          brand: { select: { id: true, name: true } },
          contact: { select: { name: true, email: true } },
        },
        take: 200,
      }),
    ])

    const brands: any[] = []
    const byBrand = new Map<string, any>()
    const held = new Map<string, { brandId: string; brandName: string; reason: string; people: number }>()
    for (const t of rows) {
      const hold = handBrandHold(t.brand)
      if (hold) {
        const h = held.get(t.brand.id) ?? { brandId: t.brand.id, brandName: t.brand.name, reason: hold, people: 0 }
        h.people += 1
        held.set(t.brand.id, h)
        continue
      }
      let g = byBrand.get(t.brand.id)
      if (!g) {
        g = {
          id: t.brand.id, name: t.brand.name, category: t.brand.category, about: t.brand.about,
          website: t.brand.website, linkedinUrl: t.brand.linkedinUrl, people: [],
        }
        byBrand.set(t.brand.id, g)
        brands.push(g)
      }
      const auto = t.emails[0]
      g.people.push({
        targetId: t.id,
        status: t.status,
        contactId: t.contact.id,
        name: t.contact.name,
        title: t.contact.title,
        email: t.contact.email,
        linkedinUrl: t.contact.linkedinUrl,
        invitedAt: t.sentAt,
        acceptedAt: t.events[0]?.createdAt ?? null,
        repliedAt: t.repliedAt,
        dmSentAt: t.dmSentAt,
        autoEmailedAt: auto?.sentAt ?? null,
        autoSubject: auto?.subject ?? null,
        handSubject: t.handSubject,
        handBody: t.handBody,
        handNote: t.handNote,
      })
    }

    // Emailed wins over skipped when a row carries both.
    const done = doneRows
      .map(t => ({
        targetId: t.id,
        brandId: t.brand.id,
        brandName: t.brand.name,
        name: t.contact.name,
        email: t.contact.email,
        kind: t.emailedAt ? 'emailed' : 'skipped',
        at: (t.emailedAt ?? t.handSkippedAt) as Date,
      }))
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, 50)

    const people = brands.reduce((n, g) => n + g.people.length, 0)
    return {
      template,
      brands,
      people,
      noAddress: brands.reduce((n, g) => n + g.people.filter((p: any) => !p.email).length, 0),
      held: [...held.values()],
      done,
      doneDays: HAND_DONE_DAYS,
    }
  },

  async handTemplate() {
    return readHandTemplate()
  },

  // The one template every untouched card follows. Cards someone edited
  // keep their own version until "Reset to template" on that card.
  async saveHandTemplate({ subject, body, __user }: any) {
    const text = String(body ?? '').replace(/\r\n/g, '\n')
    if (!text.trim()) throw new Error('The email is empty, nothing to save')
    const value = JSON.stringify({
      subject: String(subject ?? '').trim().slice(0, 200),
      body: text.slice(0, 8000),
      savedAt: new Date().toISOString(),
      savedBy: __user ?? null,
    })
    await prisma.setting.upsert({
      where: { key: HAND_TEMPLATE_KEY },
      create: { key: HAND_TEMPLATE_KEY, value },
      update: { value },
    })
    return readHandTemplate()
  },

  // One card's own version of the email, and the note for Zach. Every
  // field is optional: a subject-only edit leaves the body following the
  // template, and null hands one field back to it. reset hands back both.
  async saveHandEmail({ targetId, subject, body, note, reset }: any) {
    if (!targetId) throw new Error('Missing person')
    const data: Prisma.TargetUpdateInput = {}
    if (reset) { data.handSubject = null; data.handBody = null }
    if (subject === null) data.handSubject = null
    else if (typeof subject === 'string') data.handSubject = subject.slice(0, 300)
    if (body === null) data.handBody = null
    else if (typeof body === 'string') data.handBody = body.replace(/\r\n/g, '\n').slice(0, 10000)
    if (note !== undefined) data.handNote = String(note ?? '').trim().slice(0, 2000) || null
    return prisma.target.update({
      where: { id: targetId },
      data,
      select: { id: true, handSubject: true, handBody: true, handNote: true },
    })
  },

  // The address typed on Zach's card IS the person's email on file, so
  // the brand page sees it too. A different address replaces the old one
  // only after the old one is written into the person's notes, so nothing
  // on file just vanishes. Blank is refused: clearing the box never wipes
  // an address.
  async setHandTo({ targetId, email }: any) {
    const clean = String(email ?? '').trim()
    if (!clean) throw new Error('Type an address. Clearing the box never removes the one on file.')
    if (!/^[^\s@<>(),;:]+@[^\s@<>(),;:]+\.[a-z]{2,}$/i.test(clean)) throw new Error('That doesn’t look like an email address')
    const t = await prisma.target.findUnique({ where: { id: targetId }, include: { contact: true } })
    if (!t) throw new Error('Person not found')
    const old = t.contact.email
    if (old && old.toLowerCase() === clean.toLowerCase()) {
      return { email: old, contactName: t.contact.name, replaced: null }
    }
    const stamp = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })
    const notes = old
      ? [`Email was ${old} (replaced on Zach's list, ${stamp})`, t.contact.notes].filter(Boolean).join('\n')
      : undefined
    const c = await prisma.contact.update({
      where: { id: t.contactId },
      data: { email: clean, ...(notes !== undefined ? { notes } : {}) },
      select: { email: true, name: true },
    })
    return { email: c.email, contactName: c.name, replaced: old }
  },

  // "No email needed" (a call already booked on LinkedIn, say): off
  // Zach's list without pretending an email went out. on: false undoes.
  async skipHandEmail({ targetId, on = true }: any) {
    const t = await prisma.target.update({
      where: { id: targetId },
      data: { handSkippedAt: on ? new Date() : null },
      include: { contact: { select: { name: true } } },
    })
    return { handSkippedAt: t.handSkippedAt, contactName: t.contact.name }
  },

  // Everyone who wrote back, plus the brand-level rollup: how many of
  // the people invited at a brand have answered ("1 of 3 from Yerba").
  async repliedOverview() {
    const replied = await prisma.target.findMany({
      where: { status: { in: ['replied', 'converted'] } },
      orderBy: [{ repliedAt: 'desc' }, { updatedAt: 'desc' }],
      select: {
        id: true, status: true, sentAt: true, repliedAt: true,
        nextStep: true, followUpAt: true,
        brand: { select: { id: true, name: true, category: true } },
        contact: { select: { name: true, title: true, linkedinUrl: true } },
      },
    })

    // Invited-per-brand for the denominator: anyone an invite went to.
    const invited = await prisma.target.findMany({
      where: { sentAt: { not: null } },
      select: { brandId: true },
    })
    const invitedBy: Record<string, number> = {}
    for (const t of invited) invitedBy[t.brandId] = (invitedBy[t.brandId] ?? 0) + 1

    const byBrand = new Map<string, { id: string; name: string; category: string | null; replied: number; invited: number; lastAt: Date | null }>()
    for (const t of replied) {
      const row = byBrand.get(t.brand.id) ?? {
        id: t.brand.id, name: t.brand.name, category: t.brand.category,
        replied: 0, invited: invitedBy[t.brand.id] ?? 0, lastAt: null,
      }
      row.replied += 1
      const at = t.repliedAt
      if (at && (!row.lastAt || at > row.lastAt)) row.lastAt = at
      byBrand.set(t.brand.id, row)
    }

    return {
      people: replied.map(t => ({
        id: t.id, status: t.status,
        brandId: t.brand.id, brand: t.brand.name,
        person: t.contact.name, title: t.contact.title,
        linkedinUrl: t.contact.linkedinUrl,
        sentAt: t.sentAt, repliedAt: t.repliedAt,
        nextStep: t.nextStep, followUpAt: t.followUpAt,
      })),
      brands: [...byBrand.values()].sort((a, b) =>
        b.replied - a.replied || (b.lastAt?.getTime() ?? 0) - (a.lastAt?.getTime() ?? 0)),
    }
  },

  // -------- SponsorUnited profile lookup --------
  //
  // The dashboard cannot search SponsorUnited itself — that is their
  // private API and off limits. So a search here is a question left for
  // the capture script running in Leo's logged-in tab, which answers it
  // and writes the matches back. These handlers are just the two ends
  // of that exchange plus the picking.

  // Ask. Replaces any earlier question: only the latest one matters.
  async suFindStart({ q, brandId }: any) {
    const query = String(q || '').trim()
    if (query.length < 2) throw new Error('Type at least two letters')
    const id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
    await writeSearch(prisma, {
      id, q: query, status: 'pending', at: Date.now(), brandId: brandId || null,
    })
    return { id, q: query }
  },

  // Poll. 'waiting' means no SponsorUnited tab has picked it up yet —
  // the UI says so rather than spinning forever.
  async suFindPoll({ id }: any) {
    const req = await readSearch(prisma)
    if (!req || req.id !== String(id || '')) return { status: 'gone' }
    const stale = Date.now() - req.at > 60_000
    if (req.status === 'pending') return { status: stale ? 'timeout' : 'waiting', q: req.q }
    return { status: req.status, q: req.q, results: req.results ?? [], error: req.error ?? null }
  },

  // Pick one of the matches: attach it to the brand the search came
  // from, or create the brand when the search was for something new.
  // Either way the brand is queued for an immediate capture, so its
  // people arrive without anyone starting a sweep.
  async suPick({ externalId, suName, brandId, name, category, tier }: any) {
    const extId = String(externalId || '').trim()
    const spelled = String(suName || '').trim()
    if (!extId) throw new Error('No profile id on that result')

    const clash = await prisma.brand.findFirst({
      where: { externalId: extId },
      select: { id: true, name: true },
    })
    if (clash && clash.id !== brandId) {
      return { ok: false, reason: 'taken', by: clash.name, brandId: clash.id }
    }

    let brand = brandId
      ? await prisma.brand.findUnique({ where: { id: brandId } })
      : await prisma.brand.findFirst({ where: { name: { equals: String(name || spelled), mode: 'insensitive' } } })

    if (!brand) {
      brand = await prisma.brand.create({
        data: {
          name: String(name || spelled),
          category: category || null,
          tier: tier || null,
          source: 'sponsorunited',
        },
      })
    }

    // SponsorUnited's spelling becomes an "also known as" so a later
    // capture under that name lands on this brand too.
    const akaList = String(brand.aka || '').split(/[,;]/).map((x: string) => x.trim()).filter(Boolean)
    if (spelled && spelled.toLowerCase() !== brand.name.toLowerCase() &&
        !akaList.some((a: string) => a.toLowerCase() === spelled.toLowerCase())) {
      akaList.push(spelled)
    }
    await prisma.brand.update({
      where: { id: brand.id },
      data: { externalId: extId, aka: akaList.length ? akaList.join(', ') : null },
    })

    const queue = await readCaptureQueue(prisma)
    await writeCaptureQueue(prisma, queueCapture(queue, {
      brandId: brand.id, externalId: extId, brandName: brand.name, at: Date.now(),
    }))

    // The question is answered; clear it so the script stops offering it.
    const req = await readSearch(prisma)
    if (req) await writeSearch(prisma, null)

    return { ok: true, brandId: brand.id, brandName: brand.name, created: !brandId }
  },

  // The sweep's leftovers: brands it searched but could not call.
  async suMatchQueue() {
    const [proposals, missing, queue] = await Promise.all([
      readProposals(prisma),
      prisma.brand.count({ where: { externalId: null, doNotEmail: false, passedAt: null } }),
      readCaptureQueue(prisma),
    ])
    return { proposals, missing, capturePending: queue.length }
  },

  // Resolve one: attach the chosen candidate, or drop the proposal.
  async suResolveMatch({ brandId, externalId, suName, dismiss }: any) {
    const list = await readProposals(prisma)
    const rest = list.filter(p => p.brandId !== brandId)
    if (dismiss) {
      await writeProposals(prisma, rest)
      return { ok: true, dismissed: true }
    }
    const picked: any = await (handlers.suPick as Handler)({ externalId, suName, brandId })
    if (picked && picked.ok === false) return picked
    await writeProposals(prisma, rest)
    return picked
  },

  // Daily send counts for the LinkedIn tab strip — invites logged per
  // local day (undo/withdraw uncounts them, since sentAt is cleared).
  async sentByDay({ days = 14 }: any = {}) {
    const n = Math.max(1, Math.min(31, days))
    const since = new Date(startOfLocalDay().getTime() - (n - 1) * 864e5)
    const rows = await prisma.target.findMany({
      where: { sentAt: { gte: since } },
      select: { sentAt: true },
    })
    const counts: Record<string, number> = {}
    for (const r of rows) {
      const k = localDayKey(r.sentAt!)
      counts[k] = (counts[k] ?? 0) + 1
    }
    return {
      cap: DAILY_SEND_LIMIT,
      days: Array.from({ length: n }, (_, i) => {
        const key = localDayKey(new Date(Date.now() - (n - 1 - i) * 864e5))
        return { date: key, count: counts[key] ?? 0 }
      }),
    }
  },

  // "Off queue" is company-wide (Leo): every queued/drafted person at
  // the brand is shelved in one go. Nothing deleted — the brand page
  // promotes them back, and the brand returns to next-best.
  async unqueueBrand({ brandId }: any) {
    const brand = await prisma.brand.findUnique({ where: { id: brandId }, select: { name: true } })
    if (!brand) throw new Error('Brand not found')
    const r = await prisma.target.updateMany({
      where: { brandId, status: { in: ['queued', 'drafted'] }, shelved: false },
      data: { shelved: true, queuedFor: null },
    })
    return { brandName: brand.name, count: r.count }
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

  // Pass for today: keep a brand out of today's suggestions without
  // archiving it. Nothing to undo — it comes back by itself tomorrow.
  async passBrandToday({ brandId, on = true }: any) {
    const brand = await prisma.brand.update({
      where: { id: brandId },
      data: { passedTodayAt: on ? new Date() : null },
    })
    // Passing has to actually empty the day, not just stop suggesting.
    // People already stamped into today's queue are what the Schedule
    // reads back as "in today's queue", so leaving them stamped meant a
    // passed brand reappeared on the next refresh — and would still have
    // been written to. Un-stamping returns them to the pool: nothing is
    // shelved, nothing deleted, and they come up again another day.
    let unqueued = 0
    if (on) {
      const r = await prisma.target.updateMany({
        where: {
          brandId,
          status: { in: ['queued', 'drafted'] },
          queuedFor: { gte: startOfLocalDay() },
        },
        data: { queuedFor: null },
      })
      unqueued = r.count
    }
    return { id: brand.id, name: brand.name, passedToday: !!brand.passedTodayAt, unqueued }
  },

  // -------- follow-ups that nothing else surfaces --------

  // Results already shows "they accepted, send the DM" and "they
  // replied". The gap is the middle: a thread where the DM went out and
  // nobody answered just goes quiet, and an invite that was never
  // accepted sits forever. Both are invisible until someone goes
  // looking, which is how a warm lead dies.
  //
  // Read-only: this only surfaces rows. Every action on them already
  // exists on the brand card and the Results list.
  async followUpsDue({ nudgeAfterDays = 7, staleAfterDays = 14 }: any = {}) {
    const now = Date.now()
    const nudgeBefore = new Date(now - nudgeAfterDays * 864e5)
    const staleBefore = new Date(now - staleAfterDays * 864e5)
    const days = (d: Date) => Math.floor((now - d.getTime()) / 864e5)

    const [nudge, stale] = await Promise.all([
      // DM'd and no answer. The nudge is already written on the draft.
      prisma.target.findMany({
        where: {
          status: 'accepted',
          dmSentAt: { not: null, lte: nudgeBefore },
          repliedAt: null,
        },
        orderBy: { dmSentAt: 'asc' },
        take: 60,
        include: {
          brand: { select: { id: true, name: true } },
          contact: { select: { name: true, title: true, linkedinUrl: true } },
          drafts: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      }),
      // Invited and never accepted.
      prisma.target.findMany({
        where: { status: 'sent', sentAt: { not: null, lte: staleBefore } },
        orderBy: { sentAt: 'asc' },
        take: 60,
        include: {
          brand: { select: { id: true, name: true } },
          contact: { select: { name: true, title: true, linkedinUrl: true } },
        },
      }),
    ])

    return {
      nudgeAfterDays, staleAfterDays,
      nudge: nudge.map(t => ({
        id: t.id, brandId: t.brand.id, brandName: t.brand.name,
        contactName: t.contact.name, title: t.contact.title,
        linkedinUrl: t.contact.linkedinUrl,
        dmSentAt: t.dmSentAt, days: days(t.dmSentAt!),
        nudge: t.drafts[0]?.nudge ?? null,
      })),
      stale: stale.map(t => ({
        id: t.id, brandId: t.brand.id, brandName: t.brand.name,
        contactName: t.contact.name, title: t.contact.title,
        linkedinUrl: t.contact.linkedinUrl,
        sentAt: t.sentAt, days: days(t.sentAt!),
      })),
    }
  },

  // -------- brands with no contacts --------

  // The "Needs contact info" tab: brands where we have nobody to reach.
  // These are the gaps to fill by hand or by another SponsorUnited pull.
  async listNeedsContact() {
    const brands = await prisma.brand.findMany({
      include: {
        _count: {
          select: {
            contacts: true,
            activations: true,
            // Only real business counts — a deal still at conversation or
            // proposal stage means we're chasing them, so a missing
            // contact is still a gap worth flagging.
            deals: { where: { stage: { in: ['verbal', 'closed'] } } },
          },
        },
      },
      orderBy: { name: 'asc' },
    })
    // A brand is only a "gap" if it has no contact AND we're not already
    // doing business with it (activation or verbal/closed deal) AND it's
    // not our own/internal record or one excluded from outreach.
    const missing = brands
      .filter(b =>
        b._count.contacts === 0 &&
        b._count.activations === 0 &&
        b._count.deals === 0 &&
        !b.doNotEmail &&
        !/internal/i.test(b.name))
      .map(b => ({
        id: b.id, name: b.name, category: b.category, tier: b.tier,
        website: b.website, linkedinUrl: b.linkedinUrl,
        externalId: b.externalId, aka: b.aka,
      }))
    return { count: missing.length, total: brands.length, brands: missing }
  },

  // One box on the Needs-contacts row takes either thing someone has to
  // hand: the name SponsorUnited uses, or a link to the brand's profile.
  // The link is the better answer — it carries SponsorUnited's own id for
  // the brand, so once it's saved the spelling never matters again — but
  // asking Leo to know the difference is a worse product than working it
  // out here. Each kind only writes its own field, so pasting a link
  // never wipes a name that was already right.
  async setBrandSponsorUnitedRef({ brandId, input }: any) {
    const brand = await prisma.brand.findUnique({ where: { id: brandId } })
    if (!brand) throw new Error('Brand not found')
    const ref = parseSponsorUnitedRef(input)

    if (ref.kind === 'id') {
      const clash = await prisma.brand.findFirst({
        where: { externalId: ref.value, NOT: { id: brandId } },
      })
      if (clash) throw new Error(`That SponsorUnited profile is already linked to ${clash.name} — they may be the same brand.`)
      await prisma.brand.update({ where: { id: brandId }, data: { externalId: ref.value } })
      return { kind: 'id', externalId: ref.value, aka: brand.aka }
    }

    await prisma.brand.update({ where: { id: brandId }, data: { aka: ref.value || null } })
    return { kind: 'name', aka: ref.value, externalId: brand.externalId }
  },

  // -------- SponsorUnited names we don't recognise --------

  // Captures whose brand name matched nothing of ours are parked in
  // Setting["brandMisses"] with the people that came with them (see
  // src/lib/brand-match.ts). This is the worklist: each unknown name with
  // our best guesses at which brand it really is.
  async listBrandMisses() {
    const misses = await readMisses(prisma)
    if (!misses.length) return { misses: [], brands: [] }
    const brands = await prisma.brand.findMany({
      select: { id: true, name: true, aka: true },
      orderBy: { name: 'asc' },
    })
    return {
      misses: misses.map(m => ({
        name: m.name,
        externalId: m.externalId,
        people: m.rows.length,
        lastAt: m.lastAt,
        suggestions: suggestBrands(m.name, brands),
      })),
      brands: brands.map(b => ({ id: b.id, name: b.name })),
    }
  },

  // "This SponsorUnited name is actually that brand." Adds the name to
  // the brand's "also known as" so future captures land by themselves,
  // then replays the people held with the miss — same rules as a live
  // capture, so nothing arrives differently for having waited.
  async attachBrandMiss({ missName, brandId }: any) {
    const misses = await readMisses(prisma)
    const miss = misses.find(m => m.name.toLowerCase() === String(missName).trim().toLowerCase())
    if (!miss) throw new Error('That name is no longer in the list — reload the page.')
    const brand = await prisma.brand.findUnique({ where: { id: brandId } })
    if (!brand) throw new Error('Brand not found')

    const data: Record<string, any> = { aka: addAka(brand.aka, miss.name, brand.name) || null }
    // Also keep the SponsorUnited profile ID when we learn it here, so
    // the brand's "SponsorUnited" button deep-links from now on. Never
    // overwrite one we already have, and a clash on the unique column
    // must not lose the attach.
    if (miss.externalId && !brand.externalId) data.externalId = miss.externalId
    try {
      await prisma.brand.update({ where: { id: brand.id }, data })
    } catch {
      await prisma.brand.update({ where: { id: brand.id }, data: { aka: data.aka } })
    }

    const landed = await landMissRows(brand, miss.rows)

    await writeMisses(prisma, misses.filter(m => m !== miss))
    return { brandName: brand.name, aka: data.aka, ...landed }
  },

  // The other answer to "which brand is this?": none of them, it's new.
  // Creates the brand under the name SponsorUnited used and lands the
  // held people on it. Deliberately a button someone presses rather than
  // something an import does by itself — that's what used to leave two
  // records for the same brand side by side.
  // Where the fill-to-25 actually stands. Built because the answer was
  // otherwise unknowable from outside the database: the sweep runs in
  // Leo's browser, and "is it working" has to be answerable by looking
  // at the dashboard, not by asking.
  //
  // The number that matters is contacts created recently: the sweep only
  // ever adds people, so a day with nothing new means it is not running.
  async fillProgress() {
    const CAP = 25
    const now = Date.now()
    const dayAgo = new Date(now - 864e5)
    const weekAgo = new Date(now - 7 * 864e5)
    const [brands, addedToday, addedWeek, lastContact, sweepLog] = await Promise.all([
      prisma.brand.findMany({
        where: { passedAt: null, doNotEmail: false },
        select: { id: true, name: true, externalId: true, _count: { select: { contacts: true } } },
      }),
      prisma.contact.count({ where: { source: 'sponsorunited', createdAt: { gte: dayAgo } } }),
      prisma.contact.count({ where: { source: 'sponsorunited', createdAt: { gte: weekAgo } } }),
      prisma.contact.findFirst({
        where: { source: 'sponsorunited' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, brand: { select: { name: true } } },
      }),
      readSweepLog(prisma),
    ])
    const atCap = brands.filter(b => b._count.contacts >= CAP)
    const under = brands.filter(b => b._count.contacts < CAP)
    // The sweep can only visit a brand whose SponsorUnited profile id we
    // know. Everything else has to go through the lookup first, which is
    // the half that stalls.
    const underNoId = under.filter(b => !b.externalId)
    const empty = brands.filter(b => b._count.contacts === 0)
    const peopleOnFile = brands.reduce((n, b) => n + b._count.contacts, 0)
    // How many people the fill would add if it finished everything it
    // can currently reach.
    // Reachable, under the cap, but the last visit found nobody new —
    // the sweep leaves these alone for a fortnight and moves on. Their
    // empty seats are not "reachable right now": SponsorUnited has
    // nobody to fill them with.
    const resting = under.filter(b => b.externalId && isResting(sweepLog[b.id]))
    const roomReachable = under.filter(b => b.externalId && !isResting(sweepLog[b.id])).reduce((n, b) => n + (CAP - b._count.contacts), 0)
    return {
      resting: resting.length,
      restDays: SWEEP_REST_DAYS,
      cap: CAP,
      brands: brands.length,
      atCap: atCap.length,
      under: under.length,
      underNoId: underNoId.length,
      empty: empty.length,
      peopleOnFile,
      roomReachable,
      addedToday,
      addedWeek,
      lastAt: lastContact?.createdAt ?? null,
      lastBrand: lastContact?.brand?.name ?? null,
      // The emptiest reachable brands — what the sweep would do next.
      nextUp: under.filter(b => b.externalId && !isResting(sweepLog[b.id]))
        .sort((a, b) => a._count.contacts - b._count.contacts)
        .slice(0, 6)
        .map(b => ({ id: b.id, name: b.name, contacts: b._count.contacts })),
    }
  },

  // Adding brands one modal at a time is the slowest thing on the site:
  // a list of thirty names off a spreadsheet, a conference roster or a
  // newsletter is thirty round trips. Paste the list instead.
  //
  // Categories are guessed from keywords only — never a model call, so a
  // 200-name paste costs nothing. Anything the keywords can't place
  // lands in "unresolved", which is the honest answer and is already
  // where the Brands tab expects to find work to do.
  //
  // Previews first. Nothing is written until `apply` is set, so the
  // confirm can show exactly which names are new and which are already
  // on the roster under that name or an "also known as".
  async addBrandsBulk({ text, apply, category, tier }: any) {
    const MAX = 200
    // One name per line. A comma or tab splits off a website, which is
    // what a paste from a spreadsheet usually carries.
    const parsed: { name: string; website: string | null }[] = []
    const seen = new Set<string>()
    for (const raw of String(text ?? '').split(/[\r\n]+/)) {
      const line = raw.trim().replace(/^[-•*\d.)\s]+/, '').trim()
      if (!line) continue
      const parts = line.split(/\s*[,\t|]\s*/)
      const name = (parts[0] ?? '').trim().slice(0, 120)
      if (!name) continue
      const key = name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const maybeSite = parts.slice(1).find(x => /\.[a-z]{2,}(\/|$)/i.test(x))
      parsed.push({ name, website: maybeSite ? maybeSite.replace(/^https?:\/\//, '').slice(0, 300) : null })
      if (parsed.length >= MAX) break
    }
    if (!parsed.length) throw new Error('Nothing to add — paste one brand name per line.')

    // Match the way a capture matches: the name, or any "also known as".
    const all = await prisma.brand.findMany({ select: { id: true, name: true, aka: true } })
    const byName = new Map<string, { id: string; name: string }>()
    for (const b of all) {
      byName.set(b.name.trim().toLowerCase(), b)
      for (const a of String(b.aka ?? '').split(/[,;]/)) {
        const k = a.trim().toLowerCase()
        if (k) byName.set(k, b)
      }
    }

    const existing: { name: string; asName: string; id: string }[] = []
    const fresh: { name: string; website: string | null; category: string }[] = []
    for (const row of parsed) {
      const hit = byName.get(row.name.toLowerCase())
      if (hit) existing.push({ name: row.name, asName: hit.name, id: hit.id })
      else fresh.push({ ...row, category: category || guessCategory(row.name, row.website) })
    }

    if (!apply) {
      return {
        preview: true,
        create: fresh,
        existing,
        // Worth calling out: these are the ones that will need a category
        // set by hand before a day can offer them.
        unresolved: fresh.filter(f => f.category === 'unresolved').length,
      }
    }

    const created: { id: string; name: string; category: string }[] = []
    const failed: { name: string; reason: string }[] = []
    for (const row of fresh) {
      try {
        const b = await prisma.brand.create({
          data: {
            name: row.name,
            category: row.category,
            tier: tier || null,
            website: row.website,
            source: 'manual',
          },
        })
        created.push({ id: b.id, name: b.name, category: b.category ?? 'unresolved' })
      } catch (e: any) {
        // A name that clashes on the unique index between preview and
        // apply is not a failure worth stopping the batch for.
        failed.push({ name: row.name, reason: e?.message ?? 'could not create' })
      }
    }
    return { created, existing, failed, unresolved: created.filter(c => c.category === 'unresolved').length }
  },

  async createBrandFromMiss({ missName, category, tier }: any) {
    const misses = await readMisses(prisma)
    const miss = misses.find(m => m.name.toLowerCase() === String(missName).trim().toLowerCase())
    if (!miss) throw new Error('That name is no longer in the list — reload the page.')

    // A brand by that name appearing between the miss and this click
    // means attach, not create — never end up with two.
    const clash = await prisma.brand.findFirst({
      where: { name: { equals: miss.name, mode: 'insensitive' } },
    })
    if (clash) throw new Error(`"${clash.name}" already exists — use Attach instead.`)

    const brand = await prisma.brand.create({
      data: {
        name: miss.name,
        category: category ?? null,
        tier: tier ?? null,
        source: 'sponsorunited',
        externalId: miss.externalId ?? null,
      },
    })
    const landed = await landMissRows(brand, miss.rows)

    await writeMisses(prisma, misses.filter(m => m !== miss))
    return { brandName: brand.name, brandId: brand.id, created: true, ...landed }
  },

  // "Not one of ours" — drop the name and the people held with it. Only
  // the parked copy goes; nothing in the brand or contact tables is
  // touched, and a later capture of the same name simply re-parks it.
  async dismissBrandMiss({ missName }: any) {
    const misses = await readMisses(prisma)
    const want = String(missName).trim().toLowerCase()
    const left = misses.filter(m => m.name.toLowerCase() !== want)
    await writeMisses(prisma, left)
    return { removed: misses.length - left.length }
  },

  // -------- LinkedIn work view --------

  // One flat list built for a LinkedIn session: every brand with its
  // people and their saved profile links, plus each person's outreach
  // status so already-contacted people are visible at a glance. The
  // company-People-page and title-search URLs are built client-side.
  async linkedinPeople() {
    const brands = await prisma.brand.findMany({
      include: {
        contacts: {
          select: {
            id: true, name: true, title: true, linkedinUrl: true,
            isDecisionMaker: true,
            // One target per contact (unique constraint), so take 1 is exact.
            targets: { select: { status: true, shelved: true }, take: 1 },
          },
          orderBy: [{ isDecisionMaker: 'desc' }, { name: 'asc' }],
        },
      },
      orderBy: { name: 'asc' },
    })
    const rows = brands.map(b => ({
      id: b.id, name: b.name, category: b.category, tier: b.tier,
      linkedinUrl: b.linkedinUrl,
      contacts: b.contacts.map(c => ({
        id: c.id, name: c.name, title: c.title, linkedinUrl: c.linkedinUrl,
        isDecisionMaker: c.isDecisionMaker,
        status: c.targets[0]?.status ?? null,
        shelved: c.targets[0]?.shelved ?? false,
      })),
    }))
    // Workable brands first: saved profile links, then any contact at
    // all, then the brands where someone still has to be found.
    const rank = (b: (typeof rows)[number]) =>
      b.contacts.some(c => c.linkedinUrl) ? 0 : b.contacts.length ? 1 : 2
    rows.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    return { brands: rows }
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

  // Recent Show Board opens through the access gate, newest first, plus
  // the headline numbers and the most-picked shows for the overview.
  async listBoardActivity({ limit }: any) {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    // "Today" in Eastern time — the team and the schools run on it.
    const now = new Date()
    const ny = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
    const dayStart = new Date(now.getTime() -
      (ny.getHours() * 3600e3 + ny.getMinutes() * 60e3 + ny.getSeconds() * 1e3))
    const [visits, brandsTodayRows, last7, requestCount, picked] = await Promise.all([
      prisma.boardVisit.findMany({
        orderBy: { createdAt: 'desc' },
        take: Math.min(Number(limit) || 50, 200),
        include: { brand: { select: { id: true, name: true } } },
      }),
      prisma.boardVisit.findMany({
        where: { createdAt: { gte: dayStart }, brandId: { not: null } },
        select: { brandId: true },
        distinct: ['brandId'],
      }),
      prisma.boardVisit.count({ where: { createdAt: { gt: weekAgo } } }),
      prisma.deal.count({ where: { source: 'request' } }),
      // Every show a brand ever picked on the board (the request marker
      // lives in the row's notes), whatever its status is today.
      prisma.showSponsor.findMany({
        where: { notes: { contains: 'sponsor page' } },
        select: { crmLeadId: true, artist: true, school: true, eventDate: true },
      }),
    ])
    const byShow = new Map<string, { artist: string; school: string | null; eventDate: string | null; count: number }>()
    for (const s of picked) {
      const k = s.crmLeadId || `${s.artist}|${s.school}|${s.eventDate}`
      const row = byShow.get(k) || { artist: s.artist, school: s.school, eventDate: s.eventDate, count: 0 }
      row.count++
      byShow.set(k, row)
    }
    const topShows = [...byShow.values()].sort((a, b) => b.count - a.count).slice(0, 10)
    return { visits, brandsToday: brandsTodayRows.length, last7, requestCount, topShows }
  },

  // The "In talks" cards: every brand holding a board code, with its
  // engagement — who opened the board, how often, roughly how long
  // (heartbeat-timed sessions only), and which shows they picked.
  async listTalks() {
    const brands = await prisma.brand.findMany({
      where: { boardCode: { not: null } },
      select: { id: true, name: true, boardCode: true, about: true },
    })
    const ids = brands.map(b => b.id)
    const [visits, picks] = await Promise.all([
      prisma.boardVisit.findMany({ where: { brandId: { in: ids } }, orderBy: { createdAt: 'desc' } }),
      prisma.showSponsor.findMany({
        where: { brandId: { in: ids }, notes: { contains: 'sponsor page' } },
        orderBy: { eventDate: 'asc' },
        select: { brandId: true, artist: true, school: true, eventDate: true },
      }),
    ])
    const minutes = (v: { createdAt: Date; lastSeenAt: Date | null }) =>
      v.lastSeenAt ? Math.max(1, Math.round((+v.lastSeenAt - +v.createdAt) / 60000)) : null
    const talks = brands.map(b => {
      const v = visits.filter(x => x.brandId === b.id)
      const timed = v.filter(x => x.lastSeenAt)
      return {
        brand: { id: b.id, name: b.name, about: b.about },
        code: b.boardCode,
        opens: v.length,
        viewers: [...new Set(v.map(x => x.email).filter(Boolean))] as string[],
        lastOpenAt: v[0]?.createdAt ?? null,
        minutesTracked: timed.reduce((a, x) => a + (minutes(x) || 0), 0),
        sessionsTimed: timed.length,
        shows: picks.filter(p => p.brandId === b.id),
        log: v.slice(0, 12).map(x => ({ at: x.createdAt, email: x.email, minutes: minutes(x) })),
      }
    })
    talks.sort((a, b) => (b.lastOpenAt ? +new Date(b.lastOpenAt) : 0) - (a.lastOpenAt ? +new Date(a.lastOpenAt) : 0))
    return { talks }
  },

  // Access requests from the gate's "Request the show list" form.
  async listAccessRequests() {
    const rows = await prisma.boardAccessRequest.findMany({ orderBy: { createdAt: 'desc' }, take: 50 })
    return { pending: rows.filter(r => r.status === 'pending'), decided: rows.filter(r => r.status !== 'pending').slice(0, 10) }
  },

  // Approve: brand found-or-created, requester saved as a contact, a
  // board code minted if the brand has none, and the code + link emailed
  // to the requester from the ops mailbox.
  async approveAccessRequest({ id }: any) {
    const reqRow = await prisma.boardAccessRequest.findUnique({ where: { id } })
    if (!reqRow) throw new Error('Request not found')
    if (reqRow.status !== 'pending') throw new Error('Already ' + reqRow.status)

    let brand = await prisma.brand.findFirst({ where: { name: { equals: reqRow.company, mode: 'insensitive' } } })
    if (!brand) brand = await prisma.brand.create({ data: { name: reqRow.company, source: 'board-access', notes: `Asked for Show Board access on ${new Date().toISOString().slice(0, 10)}.` } })
    if (!brand.boardCode) {
      for (let i = 0; i < 5; i++) {
        const code = newBoardCode()
        if (await prisma.brand.findFirst({ where: { boardCode: code } })) continue
        brand = await prisma.brand.update({ where: { id: brand.id }, data: { boardCode: code } })
        break
      }
      if (!brand.boardCode) throw new Error('Could not generate a unique code — try again')
    }
    const existing = await prisma.contact.findFirst({ where: { brandId: brand.id, email: reqRow.email } })
    if (!existing) await prisma.contact.create({ data: { brandId: brand.id, name: reqRow.name, email: reqRow.email, source: 'board-access' } })

    const boardUrl = process.env.SPONSOR_HOST
      ? 'https://' + process.env.SPONSOR_HOST + '/'
      : (process.env.SITE_URL || 'https://sb-digitaldashboard.vercel.app') + '/partnerships'
    const link = boardUrl + '?code=' + encodeURIComponent(brand.boardCode!)
    const subject = 'Your access to the SB Agency Show Board'
    const text = `Hi ${reqRow.name},\n\nHere's your access to the SB Agency Show Board:\n${link}\n\nAccess code: ${brand.boardCode}\n\nPick the shows you want your brand at and send the request — we'll come back with options and pricing.\n\nSB Agency`
    let emailed = false
    try {
      const st = await opsStatus()
      if (st.connected) { await opsSend({ from: `SB Agency <${st.address || 'ops@sboyagency.com'}>`, to: reqRow.email, subject, text }); emailed = true }
      else { await sendPlainEmail({ to: reqRow.email, subject, body: text }); emailed = true }
    } catch { emailed = false }

    await prisma.boardAccessRequest.update({ where: { id }, data: { status: 'approved', brandId: brand.id, decidedAt: new Date() } })
    return { brandId: brand.id, code: brand.boardCode, emailed }
  },

  async denyAccessRequest({ id }: any) {
    await prisma.boardAccessRequest.update({ where: { id }, data: { status: 'denied', decidedAt: new Date() } })
    return { ok: true }
  },

  // Every request that came in through the public Show Board (one deal
  // per submit, source "request"), newest first, with the person who
  // asked and the shows still marked "requested" for that brand.
  async listRequests() {
    const deals = await prisma.deal.findMany({
      where: { source: 'request' },
      include: { brand: { select: { id: true, name: true, category: true } } },
      orderBy: { createdAt: 'desc' },
    })
    const brandIds = [...new Set(deals.map(d => d.brandId))]
    const [contacts, sponsors] = await Promise.all([
      prisma.contact.findMany({ where: { brandId: { in: brandIds }, source: 'sponsor-page' }, orderBy: { createdAt: 'desc' } }),
      prisma.showSponsor.findMany({ where: { brandId: { in: brandIds }, status: 'requested' }, orderBy: { eventDate: 'asc' } }),
    ])
    return {
      count: deals.length,
      requests: deals.map(d => ({
        id: d.id, createdAt: d.createdAt, name: d.name, stage: d.stage, notes: d.notes, eventRef: d.eventRef,
        brand: d.brand,
        contact: contacts.find(c => c.brandId === d.brandId) || null,
        shows: sponsors.filter(s => s.brandId === d.brandId)
          .map(s => ({ id: s.id, school: s.school, chapter: s.chapter, artist: s.artist, eventDate: s.eventDate })),
      })),
    }
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

  // Everyone we've actually reached out to, on either channel, grouped
  // by brand for the Reached tab. LinkedIn: targets whose invite went
  // out (sentAt stamped, or a post-send status). Email: sent messages.
  async listReached() {
    const [targets, emails] = await Promise.all([
      prisma.target.findMany({
        where: {
          OR: [
            { sentAt: { not: null } },
            { status: { in: ['sent', 'accepted', 'replied', 'converted'] } },
          ],
        },
        include: {
          brand: { select: { id: true, name: true, category: true, tier: true } },
          contact: { select: { id: true, name: true, title: true, linkedinUrl: true } },
        },
      }),
      prisma.emailMessage.findMany({
        where: { direction: 'out', status: 'sent' },
        select: {
          sentAt: true, createdAt: true, opens: true, toEmail: true,
          target: {
            select: {
              brand: { select: { id: true, name: true, category: true, tier: true } },
              contact: { select: { id: true, name: true, title: true, linkedinUrl: true } },
            },
          },
        },
      }),
    ])

    type Person = {
      id: string; name: string; title: string | null; linkedinUrl: string | null
      linkedin: { targetId: string; status: string; sentAt: string | null; repliedAt: string | null } | null
      email: { count: number; lastAt: string | null; opened: boolean } | null
      lastAt: string | null
    }
    const brands: Record<string, { brand: any; people: Record<string, Person>; lastAt: string | null }> = {}
    const touch = (b: any) => (brands[b.id] ??= { brand: b, people: {}, lastAt: null })
    const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b)

    for (const t of targets) {
      const g = touch(t.brand)
      const p = (g.people[t.contact.id] ??= { id: t.contact.id, name: t.contact.name, title: t.contact.title, linkedinUrl: t.contact.linkedinUrl, linkedin: null, email: null, lastAt: null })
      p.linkedin = {
        targetId: t.id,
        status: t.status,
        sentAt: t.sentAt ? t.sentAt.toISOString() : null,
        repliedAt: t.repliedAt ? t.repliedAt.toISOString() : null,
      }
      p.lastAt = later(p.lastAt, p.linkedin.repliedAt || p.linkedin.sentAt)
    }
    for (const m of emails) {
      const g = touch(m.target.brand)
      const c = m.target.contact
      const p = (g.people[c.id] ??= { id: c.id, name: c.name, title: c.title, linkedinUrl: c.linkedinUrl, linkedin: null, email: null, lastAt: null })
      const at = (m.sentAt || m.createdAt).toISOString()
      p.email = {
        count: (p.email?.count || 0) + 1,
        lastAt: later(p.email?.lastAt || null, at),
        opened: (p.email?.opened || false) || m.opens > 0,
      }
      p.lastAt = later(p.lastAt, at)
    }

    // The brand's deal, so the Reached card can move it through the
    // pipeline directly. Latest deal wins; sponsorship/Notion-sourced
    // ones render read-only (their stage is synced elsewhere).
    const deals = await prisma.deal.findMany({
      where: { brandId: { in: Object.keys(brands) } },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, brandId: true, stage: true, source: true, valueCents: true },
    })
    const dealByBrand: Record<string, (typeof deals)[number]> = {}
    for (const d of deals) dealByBrand[d.brandId] ??= d

    // LinkedIn funnel across everyone invited: accepted counts anyone
    // at accepted or beyond, replied anyone at replied or beyond.
    const totals = {
      invited: targets.length,
      accepted: targets.filter(t => ['accepted', 'replied', 'converted'].includes(t.status)).length,
      replied: targets.filter(t => ['replied', 'converted'].includes(t.status)).length,
    }

    const rows = Object.values(brands).map(g => {
      const people = Object.values(g.people).sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''))
      const lastAt = people.reduce<string | null>((m, p) => later(m, p.lastAt), null)
      return { brand: g.brand, people, lastAt, deal: dealByBrand[g.brand.id] ?? null }
    }).sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''))
    return { brands: rows, totals }
  },

  // -------- deal room --------

  // One screen per deal: the brand's people, the show and its
  // deliverables, live board heat, and a follow-up that can't lapse.
  async getDealRoom({ dealId }: any) {
    const deal = await prisma.deal.findUnique({
      where: { id: dealId },
      include: {
        brand: { include: { contacts: { orderBy: [{ isDecisionMaker: 'desc' }, { name: 'asc' }], take: 8 } } },
        showSponsor: { include: { deliverableItems: { orderBy: { createdAt: 'asc' } } } },
      },
    })
    if (!deal) throw new Error('Deal not found')
    const twoWeeks = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
    const [boardViews14d, lastVisit] = await Promise.all([
      prisma.boardVisit.count({ where: { brandId: deal.brandId, createdAt: { gte: twoWeeks } } }),
      prisma.boardVisit.findFirst({ where: { brandId: deal.brandId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    ])
    return { deal, boardViews14d, lastBoardVisit: lastVisit?.createdAt ?? null }
  },

  // Follow-up fields work on every deal, sponsorship-sourced included —
  // the syncs never write these, so nothing gets clobbered.
  async setDealFollowUp({ dealId, nextStep, followUpAt }: any) {
    return prisma.deal.update({
      where: { id: dealId },
      data: {
        ...(nextStep !== undefined ? { nextStep: nextStep || null } : {}),
        ...(followUpAt !== undefined ? { followUpAt: followUpAt ? new Date(followUpAt) : null } : {}),
      },
    })
  },

  // -------- next best brands --------

  // Rules-only ranking (no model calls) of brands nobody has contacted:
  // tier, reachable decision makers, and how the brand's category has
  // actually replied to us so far. Feeds the list under the queue.
  async nextBestBrands({ take = 15 }: any = {}) {
    const [brands, sent, replies] = await Promise.all([
      prisma.brand.findMany({
        where: { doNotEmail: false, passedAt: null, ...notPassedToday() },
        include: {
          contacts: { select: { title: true, linkedinUrl: true, email: true, isDecisionMaker: true } },
          targets: { select: { status: true, sentAt: true, shelved: true } },
          _count: { select: { contacts: true } },
        },
      }),
      prisma.emailMessage.findMany({
        where: { direction: 'out', status: 'sent' },
        select: { target: { select: { brandId: true, brand: { select: { category: true } } } } },
      }),
      prisma.emailMessage.findMany({
        where: { direction: 'in' },
        select: { target: { select: { brandId: true, brand: { select: { category: true } } } } },
      }),
    ])

    // Brand-level reply rate per category.
    const emailedByCat: Record<string, Set<string>> = {}
    const repliedByCat: Record<string, Set<string>> = {}
    for (const m of sent) (emailedByCat[m.target.brand.category ?? ''] ??= new Set()).add(m.target.brandId)
    for (const m of replies) (repliedByCat[m.target.brand.category ?? ''] ??= new Set()).add(m.target.brandId)

    // A brand already in the queue (an active queued/drafted target)
    // is in play — it must not show up here as "not contacted yet".
    // Shelved targets don't count: taking a brand off the queue puts
    // it back in this pool.
    const touched = (b: (typeof brands)[number]) =>
      b.targets.some(t => t.sentAt ||
        (!t.shelved && ['queued', 'drafted', 'sent', 'accepted', 'replied', 'converted'].includes(t.status)))

    // Freshly added brands with nobody on file yet surface FIRST with an
    // "add their person" prompt — otherwise a brand added from the
    // LinkedIn tab vanished until someone remembered Needs Contacts.
    const twoWeeks = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
    const fresh = brands
      .filter(b => !b.contacts.length && !touched(b) && b.createdAt >= twoWeeks)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(b => ({
        id: b.id, name: b.name, category: b.category, tier: b.tier,
        contacts: 0, score: 0, why: ['just added — add their person'], needsPerson: true,
      }))

    const rows = brands
      .filter(b => b.contacts.length && !touched(b))
      .map(b => {
        let score = 0
        const why: string[] = []
        const tierPts: Record<string, number> = { emerging: 30, growth: 20, established: 8 }
        score += tierPts[b.tier ?? ''] ?? 12
        if (b.tier) why.push(b.tier)
        if (b.contacts.some(c => c.isDecisionMaker && c.linkedinUrl)) { score += 30; why.push('decision-maker on LinkedIn') }
        else if (b.contacts.some(c => c.linkedinUrl)) { score += 15; why.push('contact on LinkedIn') }
        if (b.contacts.some(c => c.email)) { score += 8; why.push('email on file') }
        const cat = b.category ?? ''
        const emailed = emailedByCat[cat]?.size ?? 0
        const replied = repliedByCat[cat]?.size ?? 0
        if (emailed >= 3) {
          const rate = Math.round((replied / emailed) * 100)
          score += Math.min(25, rate)
          if (rate > 0) why.push('category replies at ' + rate + '%')
        }
        why.push(b.workPeople ? 'work ' + b.workPeople : 'suggest working ' + recommendWorkPeople(b, b.contacts))
        return { id: b.id, name: b.name, category: b.category, tier: b.tier, contacts: b._count.contacts, score, why }
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(Number(take) || 15, 50))
    return { brands: [...fresh.slice(0, 10), ...rows] }
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
    if (NO_PAID_APIS) throw new Error('Discovery search is turned off — this site makes no paid API calls. Add brands by hand or via SponsorUnited.')

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
      `[{"name": "...", "category": "one of: ${CATS}", "reason": "one line on why it fits the search AND why college students matter to them", "activation": "one line naming a CONCRETE activation SB Agency could sell them at a show \u2014 e.g. sampling at the door, a stage banner, product seeding into Greek houses, an ambassador program, a QR moment, a photo activation \u2014 specific to THIS brand's product", "website": "https://... or null", "linkedinUrl": "https://www.linkedin.com/company/..."}]`,
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
          activation: r.activation ? String(r.activation).slice(0, 300) : null,
          website: r.website ? String(r.website).slice(0, 300) : null,
          linkedinUrl: String(r.linkedinUrl).slice(0, 300),
          ...(existing ? { status: 'added', brandId: existing.id } : {}),
        },
        update: {
          reason: r.reason ? String(r.reason).slice(0, 300) : undefined,
          activation: r.activation ? String(r.activation).slice(0, 300) : undefined,
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
          source: 'discover',
          notes: [d.reason ? `Discover: ${d.reason}` : '', (d as any).activation ? `Activation idea: ${(d as any).activation}` : ''].filter(Boolean).join('\n') || null,
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
          activation: r.activation ? String(r.activation).slice(0, 300) : null,
          website: r.website ? String(r.website).slice(0, 300) : null,
          linkedinUrl: String(r.linkedinUrl).slice(0, 300),
          ...(existing ? { status: 'added', brandId: existing.id } : {}),
        },
        update: {
          reason: r.reason ? String(r.reason).slice(0, 300) : undefined,
          activation: r.activation ? String(r.activation).slice(0, 300) : undefined,
        },
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

  // -------- activations (signed deals being delivered) --------
  //
  // Cost side of a closed deal. Kept strictly apart from Deal.valueCents
  // (sponsorship revenue) and from sb-crm booking revenue. All cents.

  async listActivations() {
    const rows = await prisma.activation.findMany({
      include: {
        brand: { select: { id: true, name: true } },
        events: {
          include: {
            lines: { select: { id: true, section: true, item: true, qty: true, estimateCents: true, finalCents: true, ordered: true } },
            staff: { select: { kind: true, confirmed: true, status: true, lineId: true } },
          },
          orderBy: { eventDate: 'asc' },
        },
      },
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
    })
    const now = Date.now()
    return rows.map(a => {
      const ev = a.events.map(e => {
        const estimate = e.lines.reduce((s, l) => s + l.estimateCents, 0)
        // "Current cost" is committed money only: lines with a final amount.
        const current = e.lines.reduce((s, l) => s + (l.finalCents ?? 0), 0)
        const finalised = e.lines.filter(l => l.finalCents != null).length
        const peopleLines = e.lines.filter(isPeopleLine)
        const slots = peopleLines.reduce((s, l) => s + Math.max(1, l.qty ?? 1), 0)
        const lineIds = new Set(peopleLines.map(l => l.id))
        const people = e.staff.length
        const confirmed = e.staff.filter(s => s.lineId && lineIds.has(s.lineId) && (s.status === 'confirmed' || s.status === 'done')).length
        return {
          id: e.id, name: e.name, venue: e.venue, city: e.city, eventDate: e.eventDate,
          budgetCents: e.budgetCents, agencyFeeCents: e.agencyFeeCents,
          estimateCents: estimate, currentCents: current, finalCents: current,
          linesTotal: e.lines.length, linesFinal: finalised, linesOrdered: e.lines.filter(l => l.ordered).length,
          slots, people, peopleConfirmed: confirmed,
          ambassadors: e.staff.filter(s => s.kind === 'ambassador').length,
          ambassadorsConfirmed: e.staff.filter(s => s.kind === 'ambassador' && (s.confirmed || s.status === 'confirmed')).length,
          platformCampaignId: e.platformCampaignId, inviteUrl: e.inviteUrl,
          daysOut: e.eventDate ? Math.ceil((e.eventDate.getTime() - now) / 86400000) : null,
        }
      })
      return {
        id: a.id, name: a.name, status: a.status, owner: a.owner, notes: a.notes, dealId: a.dealId,
        sheetUrl: a.sheetUrl, docUrl: a.docUrl, driveFolderId: a.driveFolderId,
        brand: a.brand, events: ev,
        budgetCents: ev.reduce((s, e) => s + e.budgetCents, 0),
        estimateCents: ev.reduce((s, e) => s + e.estimateCents, 0),
        currentCents: ev.reduce((s, e) => s + e.currentCents, 0),
        finalCents: ev.reduce((s, e) => s + e.finalCents, 0),
        slots: ev.reduce((s, e) => s + e.slots, 0),
        people: ev.reduce((s, e) => s + e.people, 0),
        peopleConfirmed: ev.reduce((s, e) => s + e.peopleConfirmed, 0),
        linesOrdered: ev.reduce((s, e) => s + e.linesOrdered, 0),
        linesTotal: ev.reduce((s, e) => s + e.linesTotal, 0),
        nextDate: ev.map(e => e.eventDate).filter(Boolean).sort()[0] ?? null,
        daysOut: (() => { const d = ev.map(e => e.daysOut).filter((x): x is number => x != null); return d.length ? Math.min(...d) : null })(),
      }
    })
  },

  async getActivation({ id }: any) {
    const a = await prisma.activation.findUnique({
      where: { id },
      include: {
        brand: { select: { id: true, name: true, category: true } },
        events: {
          include: {
            lines: { orderBy: [{ section: 'asc' }, { sortOrder: 'asc' }] },
            tasks: { orderBy: [{ status: 'asc' }, { dueDate: 'asc' }, { sortOrder: 'asc' }], include: { line: { select: { item: true, section: true } } } },
            staff: { orderBy: [{ lineId: 'asc' }, { name: 'asc' }] },
          },
          orderBy: { eventDate: 'asc' },
        },
      },
    })
    if (!a) throw new Error('Activation not found')
    const deal = a.dealId ? await prisma.deal.findUnique({ where: { id: a.dealId }, select: { id: true, name: true, valueCents: true, stage: true } }) : null
    return { ...a, deal }
  },

  async upsertActivation({ id, brandId, brandName, dealId, name, status, owner, notes, sheetUrl, docUrl }: any) {
    let bid = brandId
    if (!bid && brandName) {
      const b = await prisma.brand.upsert({
        where: { name: String(brandName).trim() },
        create: { name: String(brandName).trim(), source: 'manual' },
        update: {},
      })
      bid = b.id
    }
    if (!id && !bid) throw new Error('A brand is required')
    if (!id && !name) throw new Error('A name is required')
    const data: any = {}
    if (bid) data.brandId = bid
    if (dealId !== undefined) data.dealId = dealId || null
    if (name !== undefined) data.name = String(name).trim()
    if (status !== undefined) data.status = status
    if (owner !== undefined) data.owner = owner || null
    if (notes !== undefined) data.notes = notes || null
    if (sheetUrl !== undefined) data.sheetUrl = sheetUrl || null
    if (docUrl !== undefined) data.docUrl = docUrl || null
    return id
      ? prisma.activation.update({ where: { id }, data })
      : prisma.activation.create({ data: { brandId: bid, name: data.name, dealId: data.dealId ?? null, status: data.status ?? 'planning', owner: data.owner ?? null, notes: data.notes ?? null } })
  },

  async deleteActivation({ id }: any) {
    await prisma.activation.delete({ where: { id } })
    return { ok: true }
  },

  async upsertActivationEvent({ id, activationId, name, venue, city, eventDate, loadIn, eventTime, loadOut, notes, budgetCents, agencyFeeCents }: any) {
    const data: any = {}
    for (const [k, v] of Object.entries({ name, venue, city, loadIn, eventTime, loadOut, notes })) {
      if (v !== undefined) data[k] = v === '' ? null : v
    }
    if (eventDate !== undefined) data.eventDate = eventDate ? new Date(eventDate) : null
    if (budgetCents !== undefined) data.budgetCents = Math.round(Number(budgetCents) || 0)
    if (agencyFeeCents !== undefined) data.agencyFeeCents = Math.round(Number(agencyFeeCents) || 0)
    if (id) return prisma.activationEvent.update({ where: { id }, data })
    if (!activationId || !name) throw new Error('activationId and name are required')
    return prisma.activationEvent.create({ data: { activationId, ...data, name } })
  },

  async deleteActivationEvent({ id }: any) {
    await prisma.activationEvent.delete({ where: { id } })
    return { ok: true }
  },

  async upsertBudgetLine({ id, eventId, section, item, description, qty, unitCents, estimateCents, finalCents, notes, ordered, sortOrder }: any) {
    const data: any = {}
    if (section !== undefined) data.section = section
    if (item !== undefined) data.item = String(item).trim()
    if (description !== undefined) data.description = description || null
    if (qty !== undefined) data.qty = qty === '' || qty == null ? null : Math.round(Number(qty))
    if (unitCents !== undefined) data.unitCents = unitCents === '' || unitCents == null ? null : Math.round(Number(unitCents))
    if (estimateCents !== undefined) data.estimateCents = Math.round(Number(estimateCents) || 0)
    if (finalCents !== undefined) data.finalCents = finalCents === '' || finalCents == null ? null : Math.round(Number(finalCents))
    if (notes !== undefined) data.notes = notes || null
    if (ordered !== undefined) data.ordered = !!ordered
    if (sortOrder !== undefined) data.sortOrder = Math.round(Number(sortOrder) || 0)
    if (id) return prisma.budgetLine.update({ where: { id }, data })
    if (!eventId || !data.section || !data.item) throw new Error('eventId, section and item are required')
    const last = await prisma.budgetLine.findFirst({ where: { eventId, section: data.section }, orderBy: { sortOrder: 'desc' } })
    return prisma.budgetLine.create({ data: { eventId, sortOrder: (last?.sortOrder ?? 0) + 1, ...data } })
  },

  async deleteBudgetLine({ id }: any) {
    await prisma.budgetLine.delete({ where: { id } })
    return { ok: true }
  },

  async upsertActivationTask({ id, eventId, lineId, text, owner, ownerKind, dueDate, status, notes }: any) {
    const data: any = {}
    if (text !== undefined) data.text = String(text).trim()
    if (owner !== undefined) data.owner = owner || null
    if (ownerKind !== undefined) data.ownerKind = ownerKind
    if (dueDate !== undefined) data.dueDate = dueDate ? new Date(dueDate) : null
    if (status !== undefined) data.status = status
    if (notes !== undefined) data.notes = notes || null
    if (lineId !== undefined) data.lineId = lineId || null
    const t = id
      ? await prisma.activationTask.update({ where: { id }, data })
      : await prisma.activationTask.create({ data: { eventId, ...data, text: data.text || 'Untitled' } })
    // Finishing an ordering task ticks the budget line's checkbox too.
    if (t.lineId && status === 'done') {
      await prisma.budgetLine.update({ where: { id: t.lineId }, data: { ordered: true } }).catch(() => {})
    }
    return t
  },

  async deleteActivationTask({ id }: any) {
    await prisma.activationTask.delete({ where: { id } })
    return { ok: true }
  },

  async upsertEventStaff({ id, eventId, name, role, kind, externalRef, email, phone, rateCents, confirmed, notes, status, lineId }: any) {
    const data: any = {}
    for (const [k, v] of Object.entries({ role, externalRef, email, phone, notes, lineId })) {
      if (v !== undefined) data[k] = v === '' ? null : v
    }
    if (status !== undefined) {
      data.status = status
      if (status === 'confirmed' || status === 'done') data.confirmed = true
      if (status === 'declined' || status === 'no_show' || status === 'invited') data.confirmed = false
    }
    if (name !== undefined) data.name = String(name).trim()
    if (kind !== undefined) data.kind = kind
    if (rateCents !== undefined) data.rateCents = rateCents === '' || rateCents == null ? null : Math.round(Number(rateCents))
    if (confirmed !== undefined) { data.confirmed = !!confirmed; if (confirmed && !status) data.status = 'confirmed' }
    if (id) return prisma.eventStaff.update({ where: { id }, data })
    if (!eventId || !data.name) throw new Error('eventId and name are required')
    return prisma.eventStaff.create({ data: { eventId, ...data, status: data.status ?? (data.kind === 'team' ? 'confirmed' : 'invited') } })
  },

  async deleteEventStaff({ id }: any) {
    const st = await prisma.eventStaff.findUnique({ where: { id }, include: { event: { select: { platformCampaignId: true } } } })
    if (!st) return { ok: true }
    // Best effort: also take them off the platform campaign.
    if (st.externalRef?.startsWith('sboy:') && st.event.platformCampaignId && platformConfigured()) {
      try { await platformFetch(`/api/integrations/campaigns/${st.event.platformCampaignId}/members/${st.externalRef.slice(5)}/remove`, { method: 'POST' }) } catch {}
    }
    await prisma.eventStaff.delete({ where: { id } })
    return { ok: true }
  },

  // Turn the production sheet into a to-do list. Every line that has to
  // be ordered/booked becomes a task; a lead time in the notes ("2-week
  // lead time", "2-3 week production") sets the due date back from the
  // event. Idempotent: lines that already have a task are skipped.
  async generateEventTasks({ eventId }: any) {
    const e = await prisma.activationEvent.findUnique({
      where: { id: eventId },
      include: { lines: true, tasks: { select: { lineId: true } } },
    })
    if (!e) throw new Error('Event not found')
    const have = new Set(e.tasks.map(t => t.lineId).filter(Boolean))
    const eventMs = e.eventDate?.getTime() ?? null
    const week = 7 * 86400000
    let created = 0
    for (const l of e.lines) {
      if (have.has(l.id) || l.ordered) continue
      const note = (l.notes ?? '').toLowerCase()
      let weeksBack: number | null = null
      const m = note.match(/(\d+)\s*(?:-\s*(\d+))?\s*week/)
      if (m) weeksBack = Math.max(Number(m[1]), m[2] ? Number(m[2]) : 0)
      // Nothing stated: assume vendors need ~2 weeks, talent ~3.
      if (weeksBack == null) weeksBack = l.section === 'talent' ? 3 : 2
      const verb = l.section === 'talent' ? 'Confirm' : l.section === 'staff' ? 'Book' : 'Order'
      const detail = l.description ? ` — ${l.description}` : ''
      await prisma.activationTask.create({
        data: {
          eventId, lineId: l.id,
          text: `${verb} ${l.item}${detail}`,
          dueDate: eventMs ? new Date(eventMs - weeksBack * week) : null,
          notes: l.notes ?? null,
        },
      })
      created++
    }
    return { created, skipped: e.lines.length - created }
  },

  // One-shot import of the Underdog x A&M production sheet (Sept 2026).
  // Safe to re-run: skips if the activation already exists.
  async seedUnderdogActivation() {
    const existing = await prisma.activation.findFirst({ where: { name: 'Underdog x A&M — Venue Takeover' } })
    if (existing) return { ok: true, id: existing.id, seeded: false }

    const brand = await prisma.brand.upsert({
      where: { name: 'Underdog' },
      create: { name: 'Underdog', category: 'betting', source: 'manual' },
      update: {},
    })
    const deal = await prisma.deal.findFirst({ where: { brandId: brand.id }, orderBy: { updatedAt: 'desc' } })

    const a = await prisma.activation.create({
      data: {
        brandId: brand.id, dealId: deal?.id ?? null,
        name: 'Underdog x A&M — Venue Takeover', status: 'in_progress',
        notes: 'Imported from PRODUCTION BUDGET: Underdogs x AM (Sheet1). Agency fee on the sheet is $60,000; 15% of $359,000 is $53,850 — confirm which is intended.',
      },
    })
    const ev = await prisma.activationEvent.create({
      data: {
        activationId: a.id,
        name: 'Underdog Venue Takeover', venue: 'Good Bull Ice House', city: 'College Station, TX',
        eventDate: new Date('2026-09-26T12:00:00-05:00'),
        loadIn: '6:00 AM', eventTime: 'TBD', loadOut: '2:00 AM – 4:00 AM',
        budgetCents: 35900000, agencyFeeCents: 6000000,
      },
    })

    const $ = (d: number) => Math.round(d * 100)
    type L = [string, string, string | null, number | null, number | null, number, string | null]
    const rows: L[] = [
      // section, item, description, qty, unit$, estimate$, notes
      ['venue', 'Venue Rental', 'N/A', 1, 50000, 50000, null],

      ['production', 'Furniture Rental', 'TBD on walkthrough', null, null, 0, null],
      ['production', 'Branded Games', 'Underdog branded lawn games', null, null, 5000, null],
      ['production', 'Activation #1', 'Threader Challenge', null, null, 25000, null],
      ['production', 'Activation #2', 'Custom Cards', null, null, 18000, null],
      ['production', 'Activation #3', 'Hot dog cart for 500 guests', null, null, 10000, null],
      ['production', 'DJ Booth Rental & Staging', null, null, null, 10000, null],
      ['production', 'A/V: DJ Equipment', null, null, null, 2500, 'Final needs based on talent selection'],
      ['production', 'LED Wall', null, 8, 1750, 14000, null],
      ['production', 'Wireless Microphone', null, null, null, 500, null],
      ['production', 'Wristbands', null, null, null, 1000, '2-3 week production'],
      ['production', 'Photo/Video', null, null, null, 4500, 'Hire local'],
      ['production', 'Napkins', null, null, null, 500, '2-week lead time'],

      ['print', 'Co-branded Collateral', 'Merch for staff', null, null, 3000, 'Based on final creative timing'],
      ['print', 'Consumer Giveaways', 'Hats, phone chargers, etc.', null, null, 12000, 'Based on final creative timing'],
      ['print', 'Step & Repeat', 'SEG material', null, null, 4000, '2-week lead time'],
      ['print', 'Glass Decals', 'Placed throughout venue where allowed', null, null, 5000, null],
      ['print', 'Large Banners', 'TBD final number', null, null, 20000, null],
      ['print', 'Gift Cards', '200 people @ $25', 200, 25, 5000, null],

      ['staff', 'Brand Ambassadors', 'Working all stations', 6, 500, 3000, null],
      ['staff', 'Local Production Lead', 'Max', null, null, 5000, null],
      ['staff', 'Venue Manager', 'Liz', null, null, 5000, null],
      ['staff', 'Travel', 'Hotel / airfare / per diem', null, null, 10000, null],
      ['staff', 'Install', 'Load-in 6:00 AM – 2:00 PM', 1, 9000, 9000, null],
      ['staff', 'Strike', 'Load-out 8:00 PM – 9:00 PM', 1, 5000, 5000, null],
      ['staff', 'Trucking / Shipping', 'Round trip', 1, 2000, 2000, null],
      ['staff', 'Pre-production', 'Covers all requests until event', 1, 5000, 5000, null],

      ['talent', 'Host', null, null, null, 30000, null],
      ['talent', 'Influencer Talent', null, 8, 2000, 16000, null],
      ['talent', 'Support DJ #1', null, null, null, 2000, null],
      ['talent', 'Support DJ #2', null, null, null, 2000, null],
      ['talent', 'Headliner DJ', null, null, null, 60000, null],
      ['talent', 'Local Frat Promotion', null, null, null, 15000, null],
    ]
    let i = 0
    for (const [section, item, description, qty, unit, est, notes] of rows) {
      await prisma.budgetLine.create({
        data: {
          eventId: ev.id, section, item, description, qty,
          unitCents: unit == null ? null : $(unit), estimateCents: $(est), notes, sortOrder: i++,
        },
      })
    }
    // Named people on the sheet go straight onto the staff list.
    await prisma.eventStaff.createMany({
      data: [
        { eventId: ev.id, name: 'Max', role: 'Local Production Lead', kind: 'team', rateCents: $(5000) },
        { eventId: ev.id, name: 'Liz', role: 'Venue Manager', kind: 'team', rateCents: $(5000) },
      ],
    })
    return { ok: true, id: a.id, seeded: true, lines: rows.length }
  },

  // -------- ambassador platform (Sboy Vision) --------
  //
  // Read-only pull from the ambassador platform's integration endpoint.
  // Configured by two env vars; without them the feature just reports
  // "not connected" instead of failing. Nothing here writes to the
  // platform, and the platform returns no identity or tax fields.

  async getRosterStatus() {
    return {
      configured: !!(process.env.AMBASSADOR_PLATFORM_URL && process.env.AMBASSADOR_PLATFORM_TOKEN),
      url: process.env.AMBASSADOR_PLATFORM_URL || null,
    }
  },

  async listRoster({ q, university, onboardedOnly }: any) {
    const j: any = await platformFetch('/api/integrations/ambassadors')
    let rows: any[] = j.ambassadors ?? []
    if (onboardedOnly) rows = rows.filter(r => r.onboarded)
    if (university) rows = rows.filter(r => (r.university || '').toLowerCase() === String(university).toLowerCase())
    if (q) {
      const needle = String(q).toLowerCase()
      rows = rows.filter(r => [r.name, r.email, r.university, r.instagram, ...(r.campaigns || []).map((c: any) => c.name)]
        .filter(Boolean).some(v => String(v).toLowerCase().includes(needle)))
    }
    const universities = [...new Set((j.ambassadors ?? []).map((r: any) => r.university).filter(Boolean))].sort()
    return { total: j.count ?? rows.length, rows, universities, generatedAt: j.generatedAt }
  },

  // Put chosen roster members on an event's staff list. Idempotent on
  // the platform id, so picking someone twice doesn't duplicate them.
  async addRosterToEvent({ eventId, ambassadors, lineId }: any) {
    if (!eventId || !Array.isArray(ambassadors)) throw new Error('eventId and ambassadors[] required')
    const ev = await prisma.activationEvent.findUnique({ where: { id: eventId }, select: { platformCampaignId: true, lines: { where: { section: 'staff' }, select: { id: true, item: true, unitCents: true } } } })
    if (!ev) throw new Error('Event not found')
    const line = lineId ? ev.lines.find(l => l.id === lineId) : ev.lines.find(l => /ambassador/i.test(l.item)) ?? null
    const existing = await prisma.eventStaff.findMany({ where: { eventId, externalRef: { not: null } }, select: { externalRef: true } })
    const have = new Set(existing.map(s => s.externalRef))
    let added = 0
    const newIds: string[] = []
    for (const a of ambassadors) {
      const ref = 'sboy:' + a.id
      if (!a.id || have.has(ref)) continue
      await prisma.eventStaff.create({
        data: {
          eventId, kind: 'ambassador', externalRef: ref, lineId: line?.id ?? null,
          name: a.name || 'Ambassador',
          role: line?.item ?? [a.university, a.instagram ? '@' + a.instagram : null].filter(Boolean).join(' · ') ?? null,
          email: a.email || null, phone: a.phone || null,
          rateCents: line?.unitCents ?? null,
          confirmed: false, status: a.onboarded ? 'ready' : 'invited', invitedAt: new Date(),
          notes: [a.university, a.instagram ? '@' + a.instagram : null].filter(Boolean).join(' · ') || null,
        },
      })
      newIds.push(String(a.id))
      added++
    }
    // Mirror onto the platform campaign so they see it in their portal.
    let platform: any = null
    if (newIds.length && ev.platformCampaignId && platformConfigured()) {
      try {
        platform = await platformFetch(`/api/integrations/campaigns/${ev.platformCampaignId}/members`, { method: 'POST', body: JSON.stringify({ userIds: newIds }) })
        await handlers.syncEventRoster({ eventId })
      } catch (e: any) { platform = { error: String(e?.message || e) } }
    }
    return { added, skipped: ambassadors.length - added, platform: platform ? { added: platform.added, error: platform.error } : null }
  },

  // -------- ambassador platform: campaign per event --------

  // Creates (or re-links) the platform campaign that recruits and pays
  // this event's ambassadors. Idempotent on the event id.
  async createEventCampaign({ eventId }: any) {
    const ev = await prisma.activationEvent.findUnique({
      where: { id: eventId },
      include: { activation: { include: { brand: { select: { name: true } }, _count: { select: { events: true } } } }, lines: { where: { section: 'staff' } } },
    })
    if (!ev) throw new Error('Event not found')
    const amb = ev.lines.find(l => /ambassador/i.test(l.item)) ?? null
    const date = ev.eventDate ? ev.eventDate.toISOString().slice(0, 10) : null
    // Noon, not midnight: a bare date renders as the evening before in US time zones.
    const dateNoon = date ? `${date}T12:00:00` : null
    // One event → the activation's name is the campaign name; several → qualify it.
    const campaignName = ev.activation._count.events > 1 ? `${ev.activation.name} — ${ev.name}` : ev.activation.name
    const when = [ev.loadIn ? `Load-in ${ev.loadIn}` : null, ev.eventTime ? `Event ${ev.eventTime}` : null, ev.loadOut ? `Load-out ${ev.loadOut}` : null].filter(Boolean).join(' · ')
    const body = {
      externalRef: 'sb-event:' + ev.id,
      clientName: ev.activation.brand.name,
      name: campaignName,
      brief: [
        `${ev.activation.brand.name} activation${ev.venue ? ` at ${ev.venue}` : ''}${ev.city ? `, ${ev.city}` : ''}${date ? ` on ${date}` : ''}.`,
        when || null,
        amb?.description ? `Ambassadors: ${amb.description}.` : null,
        ev.notes || null,
      ].filter(Boolean).join('\n'),
      targetAmbassadors: amb ? Math.max(1, amb.qty ?? 1) : null,
      startDate: dateNoon, endDate: dateNoon,
      payoutCents: amb?.unitCents ?? 0,
      budgetCents: amb ? amb.estimateCents : 0,
      deliverableType: 'Event shift',
      deliverableTitle: `Work the event${ev.venue ? ` — ${ev.venue}` : ''}`,
      deliverableDescription: when || null,
    }
    const r: any = await platformFetch('/api/integrations/campaigns', { method: 'POST', body: JSON.stringify(body) })
    const c = r.campaign
    await prisma.activationEvent.update({ where: { id: ev.id }, data: { platformCampaignId: c.id, inviteUrl: c.inviteUrl, rosterSyncedAt: new Date() } })
    await handlers.syncEventRoster({ eventId })
    return { created: r.created, campaignId: c.id, inviteUrl: c.inviteUrl, agencyUrl: c.agencyUrl }
  },

  // Pull the campaign's members into the event's people list and refresh
  // each person's stage. Local decisions (confirmed / declined / no-show)
  // are never overwritten by the platform.
  async syncEventRoster({ eventId }: any) {
    const ev = await prisma.activationEvent.findUnique({ where: { id: eventId }, include: { staff: true, lines: { where: { section: 'staff' } } } })
    if (!ev) throw new Error('Event not found')
    if (!ev.platformCampaignId) return { synced: 0, note: 'No platform campaign yet' }
    const r: any = await platformFetch(`/api/integrations/campaigns/${ev.platformCampaignId}`)
    const c = r.campaign
    const line = ev.lines.find(l => /ambassador/i.test(l.item)) ?? null
    const stageToStatus = (m: any) => {
      if (m.stage === 'removed') return 'declined'
      if (m.stage === 'completed') return 'done'
      if (m.stage === 'active' || m.stage === 'clearance_ready' || m.onboarded) return 'ready'
      if (m.stage === 'onboarding') return 'onboarding'
      return 'invited'
    }
    const sticky = new Set(['confirmed', 'declined', 'no_show', 'done'])
    let synced = 0, created = 0
    for (const m of c.members ?? []) {
      const ref = 'sboy:' + m.id
      const local = ev.staff.find(s => s.externalRef === ref)
      const status = stageToStatus(m)
      if (local) {
        await prisma.eventStaff.update({ where: { id: local.id }, data: {
          platformStage: m.stage,
          email: local.email || m.email || null, phone: local.phone || m.phone || null,
          ...(sticky.has(local.status) ? {} : { status }),
        } })
      } else {
        await prisma.eventStaff.create({ data: {
          eventId, kind: 'ambassador', externalRef: ref, lineId: line?.id ?? null,
          name: m.name || 'Ambassador', role: line?.item ?? 'Brand Ambassador',
          email: m.email || null, phone: m.phone || null, rateCents: line?.unitCents ?? null,
          status, platformStage: m.stage, invitedAt: m.joinedAt ? new Date(m.joinedAt) : new Date(),
          notes: [m.university, m.instagram ? '@' + m.instagram : null].filter(Boolean).join(' · ') || null,
        } })
        created++
      }
      synced++
    }
    await prisma.activationEvent.update({ where: { id: eventId }, data: { rosterSyncedAt: new Date(), inviteUrl: c.inviteUrl ?? ev.inviteUrl } })
    return { synced, created, inviteUrl: c.inviteUrl, campaign: { id: c.id, name: c.name, status: c.status, agencyUrl: c.agencyUrl, target: c.targetAmbassadors } }
  },

  // Email the invite link to one person on the list (or a fresh address).
  async sendEventInvite({ staffId, eventId, email, name }: any) {
    let st = staffId ? await prisma.eventStaff.findUnique({ where: { id: staffId }, include: { event: { include: { activation: { include: { brand: true } } } } } }) : null
    const ev = st ? st.event : await prisma.activationEvent.findUnique({ where: { id: eventId }, include: { activation: { include: { brand: true } } } })
    if (!ev) throw new Error('Event not found')
    if (!ev.inviteUrl) throw new Error('Create the platform campaign first (People → Set up on platform).')
    const to = (st?.email || email || '').trim()
    if (!to) throw new Error('No email address for this person')
    const first = String(st?.name || name || '').split(' ')[0] || 'there'
    const date = ev.eventDate ? ev.eventDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) : 'TBD'
    const rate = st?.rateCents ? ` Pay is $${Math.round(st.rateCents / 100).toLocaleString('en-US')} for the day.` : ''
    const subject = `${ev.activation.brand.name} event — ${date}${ev.city ? ` in ${ev.city}` : ''}`
    const body = `Hi ${first},

We're staffing the ${ev.activation.brand.name} activation${ev.venue ? ` at ${ev.venue}` : ''}${ev.city ? ` in ${ev.city}` : ''} on ${date}${ev.eventTime ? ` (${ev.eventTime})` : ''}.${rate}

If you're in, sign up here — it takes about five minutes and gets you set up for payment:
${ev.inviteUrl}

Reply to this email with any questions.

Best,`
    const r = await sendPlainEmail({ to, subject, body })
    if (st) await prisma.eventStaff.update({ where: { id: st.id }, data: { invitedAt: new Date(), status: st.status === 'invited' || !st.status ? 'invited' : st.status } })
    else await prisma.eventStaff.create({ data: { eventId: ev.id, kind: 'ambassador', name: name || to, email: to, status: 'invited', invitedAt: new Date() } })
    return r
  },

  // -------- Google Drive working docs --------

  async getDriveStatus() { return driveStatus() },
  async disconnectDrive() { return driveDisconnect() },

  async createActivationDocs({ activationId }: any) {
    const a = await prisma.activation.findUnique({
      where: { id: activationId },
      include: { brand: { select: { name: true } }, events: { include: { lines: { orderBy: [{ section: 'asc' }, { sortOrder: 'asc' }] }, staff: true }, orderBy: { eventDate: 'asc' } } },
    })
    if (!a) throw new Error('Activation not found')
    if (a.sheetUrl && a.docUrl) return { sheetUrl: a.sheetUrl, docUrl: a.docUrl, existing: true }
    const $ = (c: number | null | undefined) => c == null ? '' : Math.round(c) / 100
    const secName: Record<string, string> = { venue: 'Venue', production: 'Vendors / Production', print: 'Print', staff: 'Staff / Travel / Labor', talent: 'Talent & Promo' }
    const budgetRows: any[][] = [['Section', 'Item', 'Description', 'Qty', 'Unit', 'Estimate', 'Final', 'Ordered', 'Notes']]
    for (const e of a.events) {
      if (a.events.length > 1) budgetRows.push([e.name])
      for (const l of e.lines) budgetRows.push([secName[l.section] ?? l.section, l.item, l.description ?? '', l.qty ?? '', $(l.unitCents), $(l.estimateCents), $(l.finalCents), l.ordered ? 'Yes' : '', l.notes ?? ''])
      budgetRows.push(['', 'Total', '', '', '', `=SUM(F2:F${budgetRows.length})`, `=SUM(G2:G${budgetRows.length})`, '', ''])
      budgetRows.push(['', 'Approved budget', '', '', '', $(e.budgetCents), '', '', ''])
    }
    const peopleRows: any[][] = [['Event', 'Name', 'Role', 'Type', 'Status', 'Email', 'Phone', 'Rate', 'Notes']]
    for (const e of a.events) for (const s of e.staff) peopleRows.push([e.name, s.name, s.role ?? '', s.kind, s.status, s.email ?? '', s.phone ?? '', $(s.rateCents), s.notes ?? ''])
    const schedRows: any[][] = [['Event', 'Venue', 'City', 'Date', 'Load-in', 'Event', 'Load-out', 'Notes']]
    for (const e of a.events) schedRows.push([e.name, e.venue ?? '', e.city ?? '', e.eventDate ? e.eventDate.toISOString().slice(0, 10) : '', e.loadIn ?? '', e.eventTime ?? '', e.loadOut ?? '', e.notes ?? ''])
    const docText = [
      `${a.name}`, `Brand: ${a.brand.name}`, `Owner: ${a.owner ?? '—'}`, '',
      ...a.events.flatMap(e => [
        `EVENT: ${e.name}`,
        `Venue: ${e.venue ?? '—'}${e.city ? `, ${e.city}` : ''}`,
        `Date: ${e.eventDate ? e.eventDate.toDateString() : 'TBD'}`,
        `Load-in: ${e.loadIn ?? '—'}   Event: ${e.eventTime ?? '—'}   Load-out: ${e.loadOut ?? '—'}`,
        `Approved budget: $${Math.round(e.budgetCents / 100).toLocaleString('en-US')}`,
        '', 'RUN OF SHOW', '(fill in)', '', 'ON-SITE TEAM',
        ...e.staff.filter(s => s.kind === 'team').map(s => `- ${s.name}${s.role ? ` — ${s.role}` : ''}${s.phone ? ` — ${s.phone}` : ''}`),
        '', 'AMBASSADORS',
        ...e.staff.filter(s => s.kind === 'ambassador').map(s => `- ${s.name} (${s.status})${s.phone ? ` — ${s.phone}` : ''}`),
        '', 'VENDORS & CONTACTS', '(fill in)', '', 'NOTES', e.notes ?? '', '',
      ]),
      a.notes ?? '',
    ].join('\n')
    const r = await driveCreateActivationDocs({
      name: `${a.brand.name} — ${a.name}`,
      sheetTabs: [
        { title: 'Budget', rows: budgetRows, widths: [150, 200, 260, 50, 90, 100, 100, 70, 240] },
        { title: 'People', rows: peopleRows, widths: [160, 160, 160, 90, 90, 200, 130, 80, 240] },
        { title: 'Schedule', rows: schedRows, widths: [200, 200, 120, 100, 120, 120, 120, 300] },
      ],
      docText,
    })
    await prisma.activation.update({ where: { id: a.id }, data: { sheetUrl: r.sheetUrl, docUrl: r.docUrl, driveFolderId: r.folderId } })
    return { ...r, existing: false }
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
  async getGoogleStatus() { return googleStatus() },
  async disconnectGoogle() { return googleDisconnect() },
  async getSendingPaused() { return { paused: await sendingPaused() } },
  async setSendingPaused({ paused }: any) { return setSendingPaused(!!paused) },
  async approveAllDrafts() { return approveAllDrafts() },
  async resignDrafts() { return resignDrafts() },
  async getWarmupStatus({ days }: any) { return warmupStatus(days ?? 14) },
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

  // -------- operations inbox (ops@) --------
  async getOpsStatus() { return opsStatus() },
  async disconnectOps() { return opsDisconnect() },
  async scanOps({ max }: any) { return scanOps({ max }) },
  async listOps(args: any) { return listOps(args || {}) },
  async getOpsItem({ id }: any) { return getOps(id) },
  async updateOpsItem(args: any) { return updateOps(args) },
  async deleteOpsItem({ id }: any) { return deleteOps(id) },
  async replyOps({ id, body, to, cc }: any) { return replyOps({ id, body, to, cc }) },
  async forwardOps({ id, to, note, withAttachments }: any) { return forwardOps({ id, to, note, withAttachments }) },
  // Small pick-lists for linking an item to the rest of the system.
  async opsLinkOptions() {
    const [activations, deals] = await Promise.all([
      prisma.activation.findMany({ where: { status: { not: 'recapped' } }, select: { id: true, name: true, brandId: true, brand: { select: { name: true } }, events: { select: { id: true, name: true, lines: { select: { id: true, item: true, section: true, estimateCents: true, finalCents: true }, orderBy: [{ section: 'asc' }, { sortOrder: 'asc' }] } } } }, orderBy: { updatedAt: 'desc' } }),
      prisma.deal.findMany({ select: { id: true, name: true, brandId: true, stage: true }, orderBy: { updatedAt: 'desc' }, take: 100 }),
    ])
    return { activations, deals }
  },

  async upsertTodo({ id, text, category, owner, done }: any) {
    if (id) return prisma.todo.update({ where: { id }, data: { text, category, owner, done } })
    return prisma.todo.create({ data: { text, category, owner } })
  },

  // -------- audience (attendees + events, sponsorship Phase 1) --------
  // Logic lives in lib/audience.ts; these are thin dispatch entries.
  async listAudienceEvents() { return listAudienceEvents() },
  async saveAudienceEvent(args: any) { return saveAudienceEvent(args) },
  async deleteAudienceEvent({ id }: any) { return deleteAudienceEvent(id) },
  async regenStaffPin({ id }: any) { return regenStaffPin(id) },
  async audienceEventStats({ id }: any) { return audienceEventStats(id) },
  async listAttendees(args: any) { return listAttendees(args || {}) },
  async listDupCandidates() { return listDupCandidates() },
  async mergeAttendees({ fromId, intoId }: any) { return mergeAttendees(fromId, intoId) },
  async deleteAttendee({ id }: any) { return deleteAttendee(id) },
  async importAttendees(args: any) { return importAttendees(args || {}) },
  async segmentsOverview() { return segmentsOverview() },
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
      } else if ((req.headers.get('authorization') ?? '').startsWith('Bearer ')) {
        a.__user = 'CLI'   // bearer-token caller (Claude Code / scripts), let through by middleware
      }
    } catch {}
    const data = await handler(a)
    return NextResponse.json({ ok: true, data })
  } catch (err: any) {
    console.error('[api/data]', err)
    return NextResponse.json({ ok: false, error: err?.message ?? 'Server error' }, { status: 500 })
  }
}
