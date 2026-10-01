// src/app/api/ingest/route.ts
//
// A narrow, CORS-open ingest endpoint for bulk-loading contacts captured
// from SponsorUnited's own UI in the logged-in browser. It exists so the
// capture script can POST straight here instead of hand-carrying rows
// between tabs.
//
// Security:
//   - Gated by INGEST_TOKEN (a Vercel env var Leo sets). No token set →
//     endpoint is disabled (503). Wrong/absent token → 401. This is NOT
//     a login credential; it's a shared secret guarding a write path.
//   - It can ONLY create Contacts/Targets against brands that already
//     exist, and only in this app's own database. It never touches
//     sb-crm and cannot read anything back.
//
// This mirrors importContacts in /api/data exactly, so contacts and the
// auto-queued outreach targets come out identical either way.
//
// The LinkedIn People capture (scripts/linkedin-capture.user.js) posts
// here too, as actions liPreview / liCapture — see planLinkedin below.

import { NextRequest, NextResponse } from 'next/server'
import { PrismaClient } from '@prisma/client'
import { readMisses, writeMisses, addMiss, type HeldRow } from '@/lib/brand-match'
import {
  readSearch, writeSearch, readProposals, writeProposals, upsertProposal,
  readCaptureQueue, writeCaptureQueue, queueCapture, decideMatch,
  candidatesToOffer, readRejected,
  readSweepLog, markSwept, isResting, PROPOSAL_VERSION, LOOKUP_READER,
  type SuCandidate,
} from '@/lib/su-match'
import {
  companySlug, companyPageUrl, profileSlug, profileUrl, cleanName, personKey,
  roleFromHeadline, isBuyer, decideCompanyMatch, focusTerms, matchesFocus,
  normalizeCompany, judgeDiscovery, industryFits, decideResearchMatch, nearName, pageLooksWrong,
  type LiCompany,
} from '@/lib/li-capture'
import { readLiLog, markLiSwept, liResting, readLiResearch, markLiResearch, researchResting, LI_READER, LI_SCRIPT_VERSION } from '@/lib/li-sweep'
import { recordRun } from '@/lib/li-report'
import { PARENTS, parentOf, decideParentPage, LI_PARENT_PAGES_KEY } from '@/lib/parents'
import {
  addToReview, sameMember, readJsonSetting, writeJsonSetting,
  LI_REVIEW_KEY, LI_CONFIRMED_KEY, LI_OWNER_KEY, type Review, type Confirmed, type LiOwner,
} from '@/lib/li-review'
import { LANES, RESEARCH_EXTRA, brandKey } from '@/lib/stock'
import { logLinkedInPerson, personOnFile, undoLinkedInLog, checkNewPerson } from '@/lib/li-log-db'
import { nameFromSlug, isLogStage } from '@/lib/li-log'
import { guessCategory } from '@/lib/category-hints'
import { dueDays, shortOnPeople, plannedFirst } from '@/lib/planned-first'

const prisma = new PrismaClient()

function looksLikeDecisionMaker(title: string | null): boolean {
  if (!title) return false
  return /college|campus|field marketing|experiential|sponsorship|partnerships|sports marketing|brand marketing|founder|ceo|cmo|marketing|brand|community|influencer/i.test(title)
}

const TITLE_SIGNALS: Array<[RegExp, number]> = [
  [/college|campus|university|greek/i, 40],
  [/field marketing|experiential|activation/i, 35],
  [/sponsorship|partnerships/i, 30],
  [/sports marketing|entertainment marketing/i, 25],
  [/brand marketing|brand director/i, 15],
  [/^(cmo|chief marketing)/i, 12],
  [/marketing/i, 8],
  [/founder|co-founder|ceo/i, 10],
]
const TIER_BONUS: Record<string, number> = { emerging: 20, growth: 15, established: 5 }

function scoreFit(title: string | null, tier: string | null): number {
  let score = 30
  if (title) for (const [p, pts] of TITLE_SIGNALS) { if (p.test(title)) { score += pts; break } }
  if (tier && TIER_BONUS[tier] !== undefined) score += TIER_BONUS[tier]
  return Math.max(0, Math.min(100, score))
}

// Find the brand a captured row belongs to. SponsorUnited often lists a
// brand under a different name than the dashboard ("818 Tequila" vs
// "818 Spirits"), so beyond the case-insensitive name match we also try
// the SponsorUnited profile ID (saved on first successful capture) and
// the brand's comma-separated "also known as" names (Brand.aka, edited
// on the brand page). Mirrored in importContacts in /api/data.
async function findBrandForCapture(name: string, externalId: string | null) {
  let brand = await prisma.brand.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
  })
  if (!brand && externalId) {
    brand = await prisma.brand.findFirst({ where: { externalId } })
  }
  if (!brand) {
    const want = name.trim().toLowerCase()
    const withAka = await prisma.brand.findMany({ where: { aka: { not: null } } })
    brand = withAka.find(b =>
      (b.aka ?? '').split(/[,;]/).some(a => a.trim().toLowerCase() === want)
    ) ?? null
  }
  return brand
}

// Mirror of reconcileBrandTargets in /api/data: keep only the top few
// (by fit) queued per brand, shelving the rest. Already-contacted people
// count against the cap. Nothing is deleted.
// Four per brand in the send queue, matching /api/data — a cold brand now
// opens with up to four threads. Not the 25-contact file cap above.
const TARGET_CAP_PER_BRAND = 4
async function reconcileBrandTargets(brandId: string, perBrand = TARGET_CAP_PER_BRAND) {
  // Anyone written to — an accept logged with no invite date too.
  const worked = await prisma.target.count({
    where: { brandId, OR: [{ sentAt: { not: null } }, { status: { in: ['sent', 'accepted', 'replied', 'converted'] } }] },
  })
  const room = Math.max(0, perBrand - worked)
  const active = await prisma.target.findMany({
    where: { brandId, status: { in: ['queued', 'drafted'] }, shelved: false },
    orderBy: [{ fitScore: 'desc' }, { createdAt: 'asc' }],
    select: { id: true },
  })
  const shelve = active.slice(room).map(t => t.id)
  if (shelve.length) await prisma.target.updateMany({ where: { id: { in: shelve } }, data: { shelved: true } })
  return shelve.length
}

// How many people we keep per brand. Leo's rule (Sep 2026): a brand
// with fewer than 25 people listed comes in whole — take everyone. A
// brand with 25 or more comes in 25 deep, best-fit titles first, so a
// company like Amazon contributes its partnership people instead of
// seven hundred engineers. Nothing already in the database is removed
// by this; the cap only stops new rows once a brand is at 25.
const CONTACT_CAP_PER_BRAND = 25

// New brands the LinkedIn run may add in a day (lookalikes and keyword
// searches together). Lookalikes of lookalikes never end; this keeps the
// roster growing at a pace outreach can use.
const DISCOVER_CAP_PER_DAY = 50

// Save a brand's SponsorUnited profile id, and remember SponsorUnited's
// own spelling as an "also known as" so later captures match by name as
// well as by id. Queues the brand for an immediate capture: an id with
// nobody behind it is the whole problem we are solving.
async function attachProfileId(
  brandId: string,
  brandName: string,
  aka: string | null,
  pick: { externalId: string; name: string },
) {
  const akaList = String(aka || '').split(/[,;]/).map(s => s.trim()).filter(Boolean)
  const known = new Set(akaList.map(s => s.toLowerCase()))
  if (pick.name.toLowerCase() !== brandName.toLowerCase() && !known.has(pick.name.toLowerCase())) {
    akaList.push(pick.name)
  }
  await prisma.brand.update({
    where: { id: brandId },
    data: { externalId: pick.externalId, aka: akaList.length ? akaList.join(', ') : null },
  })
  const queue = await readCaptureQueue(prisma)
  await writeCaptureQueue(prisma, queueCapture(queue, {
    brandId, externalId: pick.externalId, brandName, at: Date.now(),
  }))
}

// A capture Leo ran by hand, on a brand the dashboard doesn't have yet.
// The unattended sweep must never invent brands — a misread name would
// litter the roster — but a name Leo typed and confirmed in the panel is
// a decision, so `createIfMissing` makes the brand there and then and the
// people land on it instead of sitting in Needs-contacts waiting for the
// same decision to be made twice.
async function createBrandForCapture(name: string, externalId: string | null) {
  const clean = String(name || '').trim().slice(0, 120)
  if (!clean) return null
  // The profile id is unique across brands: if another brand already
  // claims it, this is the same company under a second spelling — use
  // that brand rather than creating a near-duplicate.
  if (externalId) {
    const owner = await prisma.brand.findFirst({ where: { externalId } })
    if (owner) return owner
  }
  try {
    return await prisma.brand.create({
      data: { name: clean, externalId: externalId || null, source: 'sponsorunited' },
    })
  } catch {
    // Lost a race, or the name clashes case-differently — take whatever
    // is there now rather than failing the capture.
    return await findBrandForCapture(clean, externalId)
  }
}

// -------------------------------------------------------------------
// LinkedIn People capture (scripts/linkedin-capture.user.js).
//
// Leo opens a brand's People page on LinkedIn and presses the button;
// the script reads the cards on screen and asks here what would happen.
// Nothing browses LinkedIn on its own — that is deliberate, because a
// flagged account is worse than a thin brand.
//
// Leo's rules (Sep 2026): buyer titles only, inside the same 25-per-brand
// file cap SponsorUnited uses, and no emails — LinkedIn people go into
// the LinkedIn connection queue. Only brands that already exist; a
// LinkedIn page never creates one.
// -------------------------------------------------------------------

type LiVerdict = 'add' | 'full' | 'dupe' | 'elsewhere' | 'notBuyer' | 'noBrand'
type LiRow = { name: string; role: string | null; linkedinUrl: string; slug: string; verdict: LiVerdict; fit: number; at?: string }

// Which dashboard brand a LinkedIn company is — for a People page, and
// for the person on a profile page (their current company).
async function resolveLinkedinBrand(body: any) {
  const slug = companySlug(body.companyUrl)
  const companyName = String(body.companyName || '').trim().slice(0, 120)
  const typed = String(body.brandName || '').trim().slice(0, 120)

  // Which brand. The unattended fill names it outright (brandId); a
  // name Leo typed is a decision and wins next; otherwise the company
  // page we saved for the brand, then the page's own name (including
  // "also known as" names).
  let brand: Awaited<ReturnType<typeof findBrandForCapture>> = null
  let matchedBy: 'id' | 'typed' | 'page' | 'name' | null = null
  if (body.brandId) {
    brand = await prisma.brand.findUnique({ where: { id: String(body.brandId) } })
    if (brand) matchedBy = 'id'
  } else if (typed) {
    brand = await findBrandForCapture(typed, null)
    if (brand) matchedBy = 'typed'
  } else {
    if (slug) {
      const withPage = await prisma.brand.findMany({ where: { linkedinUrl: { not: null } } })
      brand = withPage.find(b => companySlug(b.linkedinUrl) === slug) ?? null
      if (brand) matchedBy = 'page'
    }
    if (!brand && companyName) {
      brand = await findBrandForCapture(companyName, null)
      if (brand) matchedBy = 'name'
    }
  }

  // Close names to offer when nothing matched, so Leo picks rather than
  // guesses at how the dashboard spells it.
  let suggestions: string[] = []
  if (!brand) {
    const word = (typed || companyName).toLowerCase().split(/\s+/).find(w => w.replace(/[^a-z0-9]/g, '').length >= 3) || ''
    if (word) {
      const hits = await prisma.brand.findMany({
        where: {
          passedAt: null,
          OR: [
            { name: { contains: word, mode: 'insensitive' } },
            { aka: { contains: word, mode: 'insensitive' } },
          ],
        },
        select: { name: true }, take: 6, orderBy: { name: 'asc' },
      })
      suggestions = hits.map(h => h.name)
    }
    // Leo typed a name we don't have, but this very page is saved on a
    // brand under another name — that brand is the likeliest answer.
    if (slug && typed) {
      const withPage = await prisma.brand.findMany({ where: { linkedinUrl: { not: null } }, select: { name: true, linkedinUrl: true } })
      const owner = withPage.find(b => companySlug(b.linkedinUrl) === slug)
      if (owner && !suggestions.includes(owner.name)) suggestions.unshift(owner.name)
    }
  }
  return { brand, matchedBy, suggestions, slug, companyName, typed }
}

async function planLinkedin(body: any) {
  const { brand, matchedBy, suggestions, slug, companyName, typed } = await resolveLinkedinBrand(body)

  // The cards: a real profile link and a real name, once each.
  const seen = new Set<string>()
  const cards: Array<{ name: string; headline: string; slug: string }> = []
  for (const r of (Array.isArray(body.rows) ? body.rows : []).slice(0, 500)) {
    const name = cleanName(r?.name)
    const ps = profileSlug(r?.linkedinUrl)
    if (!name || !ps || seen.has(ps)) continue
    seen.add(ps)
    cards.push({ name, headline: String(r?.headline || '').replace(/\s+/g, ' ').trim().slice(0, 300), slug: ps })
  }

  // Already on file: here by profile link or name, or at another brand
  // by profile link (one person, one thread — and usually a job move
  // or a parent company, which Leo should see rather than duplicate).
  const mine = brand
    ? await prisma.contact.findMany({ where: { brandId: brand.id }, select: { name: true, linkedinUrl: true } })
    : []
  const mineSlugs = new Set(mine.map(c => profileSlug(c.linkedinUrl)).filter(Boolean) as string[])
  // An empty key (a name with no Latin letters) matches nothing.
  const mineKeys = new Set(mine.map(c => personKey(c.name)).filter(Boolean))
  const elsewhere = new Map<string, string>()
  if (cards.length) {
    const others = await prisma.contact.findMany({
      where: {
        ...(brand ? { brandId: { not: brand.id } } : {}),
        OR: cards.map(c => ({ linkedinUrl: { contains: '/in/' + c.slug, mode: 'insensitive' as const } })),
      },
      select: { linkedinUrl: true, brand: { select: { name: true } } },
    })
    for (const o of others) {
      const s = profileSlug(o.linkedinUrl)
      if (s && seen.has(s)) elsewhere.set(s, o.brand.name)
    }
  }

  const rows: LiRow[] = cards.map(c => {
    const role = roleFromHeadline(c.headline, companyName || brand?.name || null)
    const row: LiRow = { name: c.name, role, linkedinUrl: profileUrl(c.slug), slug: c.slug, verdict: 'add', fit: scoreFit(role, brand?.tier ?? null) }
    const key = personKey(c.name)
    if (mineSlugs.has(c.slug) || (key && mineKeys.has(key))) row.verdict = 'dupe'
    else if (elsewhere.has(c.slug)) { row.verdict = 'elsewhere'; row.at = elsewhere.get(c.slug) }
    else if (!isBuyer(role, c.headline)) row.verdict = 'notBuyer'
    else if (!brand) row.verdict = 'noBrand'
    return row
  })

  // The cap: best titles take the room first.
  const have = mine.length
  const room = Math.max(0, CONTACT_CAP_PER_BRAND - have)
  const adds = rows.filter(r => r.verdict === 'add').sort((a, b) => b.fit - a.fit)
  adds.slice(room).forEach(r => { r.verdict = 'full' })
  const order: Record<LiVerdict, number> = { add: 0, noBrand: 0, full: 1, dupe: 2, elsewhere: 3, notBuyer: 4 }
  rows.sort((a, b) => order[a.verdict] - order[b.verdict] || b.fit - a.fit || a.name.localeCompare(b.name))

  const savedSlug = brand ? companySlug(brand.linkedinUrl) : null
  return {
    brand,
    matchedBy,
    notFound: !brand && typed ? typed : null,
    suggestions,
    // What "add it as a new brand" would call it: the name Leo typed,
    // else the page's own name.
    createName: !brand ? (typed || companyName || null) : null,
    slug,
    // The brand already has a different company page saved — a parent
    // company or a sister brand. Shown, never overwritten.
    pageMismatch: !!(slug && savedSlug && savedSlug !== slug),
    have,
    room,
    rows,
  }
}

function liSummary(plan: Awaited<ReturnType<typeof planLinkedin>>) {
  const b = plan.brand
  return {
    brand: b ? { id: b.id, name: b.name, linkedinUrl: b.linkedinUrl } : null,
    matchedBy: plan.matchedBy,
    notFound: plan.notFound,
    suggestions: plan.suggestions,
    createName: plan.createName,
    pageMismatch: plan.pageMismatch,
    cap: CONTACT_CAP_PER_BRAND,
    have: plan.have,
    room: plan.room,
    rows: plan.rows.map(r => ({ name: r.name, role: r.role, linkedinUrl: r.linkedinUrl, verdict: r.verdict, at: r.at ?? null })),
  }
}

// A brand made from a LinkedIn page: the name Leo confirmed, the page
// saved on it, and a category guessed from the name and LinkedIn's
// industry line (outreach is scheduled by category, so "unresolved" is
// better than nothing, and fixable on the brand page).
async function createBrandFromLinkedin(name: string, slug: string | null, hint: string) {
  const clean = name.trim().slice(0, 120)
  if (!clean) return null
  const existing = await findBrandForCapture(clean, null)
  if (existing) return { brand: existing, created: false }
  if (slug) {
    const withPage = await prisma.brand.findMany({ where: { linkedinUrl: { not: null } } })
    const owner = withPage.find(b => companySlug(b.linkedinUrl) === slug)
    if (owner) return { brand: owner, created: false }
  }
  try {
    const brand = await prisma.brand.create({
      data: {
        name: clean,
        linkedinUrl: slug ? companyPageUrl(slug) : null,
        source: 'linkedin',
        category: guessCategory(clean, hint),
      },
    })
    return { brand, created: true }
  } catch {
    // Lost a race, or the name clashes case-differently.
    const b = await findBrandForCapture(clean, null)
    return b ? { brand: b, created: false } : null
  }
}

// CORS so the SponsorUnited tab (a different origin) can POST here.
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: cors })
}

export async function POST(req: NextRequest) {
  const configured = process.env.INGEST_TOKEN
  if (!configured) {
    return NextResponse.json({ ok: false, error: 'Ingest disabled — set INGEST_TOKEN in Vercel.' }, { status: 503, headers: cors })
  }

  let body: any
  try { body = await req.json() } catch { body = null }
  if (!body || body.token !== configured) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401, headers: cors })
  }

  // LinkedIn calls from an out-of-date script are refused (script 1.6
  // and older read LinkedIn's "• 3rd+" badge as people's titles, so it
  // added nobody and rested every brand it visited). The panel shows
  // this message; the fix is pasting in the current script.
  if (typeof body.action === 'string' && /^li[A-Z]/.test(body.action) && (Number(body.reader) || 0) < LI_READER) {
    return NextResponse.json({
      ok: false,
      error: 'Your LinkedIn script is out of date — it misread people\'s titles. Paste in the latest version: Tampermonkey → Dashboard → the script → select all → paste → save.',
    }, { status: 426, headers: cors })
  }

  // The People capture and the fill run on Leo's LinkedIn only (his call,
  // Sep 2026). The script says who's signed in (`me`); the first run
  // remembers that account (Setting liOwner) and any other is refused
  // before anything is read or saved. Zach's log script (liPerson*) is
  // not part of this. A script that can't tell who's signed in isn't
  // blocked on a guess.
  const OWNED_ACTIONS = ['liList', 'liPreview', 'liCapture', 'liMatched', 'liSwept', 'liDiscover', 'liResearch', 'liRun', 'liParent']
  if (OWNED_ACTIONS.includes(body.action) && body.me && (body.me.slug || body.me.name)) {
    const me = {
      slug: String(body.me.slug || '').trim().slice(0, 100) || null,
      name: String(body.me.name || '').replace(/\s+/g, ' ').trim().slice(0, 100) || null,
    }
    const owner = await readJsonSetting<LiOwner | null>(prisma, LI_OWNER_KEY, null)
    if (!owner || (!owner.slug && !owner.name)) {
      await writeJsonSetting(prisma, LI_OWNER_KEY, { ...me, at: new Date().toISOString() })
    } else {
      const same = sameMember(owner, me)
      if (same === false) {
        return NextResponse.json({
          ok: false, notOwner: true,
          error: `This isn't the LinkedIn account the fill runs on — it runs only on ${owner.name || owner.slug}'s${me.name ? `, and this is ${me.name}'s` : ''}. Nothing was read or saved.`,
        }, { status: 403, headers: cors })
      }
      // Remember the profile link once it's known.
      if (same && !owner.slug && me.slug) await writeJsonSetting(prisma, LI_OWNER_KEY, { ...owner, slug: me.slug })
    }
  }

  // -----------------------------------------------------------------
  // action: "list" — the worklist for an unattended run. The capture
  // script asks which brands to visit rather than being told by hand,
  // so a whole sweep is one click instead of one click per brand.
  //
  // Only brands whose SponsorUnited profile id we already know can be
  // visited directly. Every successful capture saves that id, so the
  // list grows itself: the brands Leo captures by hand today are the
  // ones the sweep can do on its own tomorrow.
  // -----------------------------------------------------------------
  // -----------------------------------------------------------------
  // The profile-id half of the script. Brands without a SponsorUnited
  // profile id can never be swept, and the id can only be found inside
  // the logged-in tab, so these four actions let the script do the
  // looking and hand back what it saw.
  // -----------------------------------------------------------------

  // An old copy of the script still in a browser (it updates itself only
  // about once a day, and runs the lookup by itself when the tab is idle)
  // would park its page-link junk again. Turn its lookups away with the
  // fix, which the script shows as "Could not start: …".
  const LOOKUP_ACTIONS = ['needProfile', 'matched', 'searchResults']
  if (LOOKUP_ACTIONS.includes(body.action) && Number(body.reader) !== LOOKUP_READER) {
    const error = 'This copy of the SB script is out of date. Tampermonkey → Check for userscript updates, then reload this tab.'
    if (body.action === 'searchResults') {
      const req = await readSearch(prisma)
      if (req && req.id === String(body.id || '')) await writeSearch(prisma, { ...req, status: 'failed', results: [], error })
    }
    return NextResponse.json({ ok: false, error, outdated: true }, { status: 426, headers: cors })
  }

  // action: "needProfile" — brands we cannot reach yet. Emptiest first,
  // so a run that stops early spent itself on the brands with nobody.
  if (body.action === 'needProfile') {
    const limit = Math.max(1, Math.min(300, Number(body.limit) || 50))
    const rows = await prisma.brand.findMany({
      where: { externalId: null, doNotEmail: false, passedAt: null },
      select: { id: true, name: true, aka: true, _count: { select: { contacts: true } } },
      orderBy: { name: 'asc' },
    })
    const items = rows
      .sort((a, b) => a._count.contacts - b._count.contacts || a.name.localeCompare(b.name))
      .slice(0, limit)
      .map(b => ({ brandId: b.id, name: b.name, aka: b.aka, contacts: b._count.contacts }))
    return NextResponse.json({ ok: true, items, total: rows.length }, { headers: cors })
  }

  // action: "matched" — what the script saw when it searched one brand.
  // It does not decide anything itself: the server applies the rule, so
  // the same judgement holds however the search was started. One clean
  // name match is attached; anything else waits for Leo.
  if (body.action === 'matched') {
    const brandId = String(body.brandId || '')
    const candidates: SuCandidate[] = (Array.isArray(body.candidates) ? body.candidates : [])
      .map((c: any) => ({ externalId: String(c?.externalId || ''), name: String(c?.name || '') }))
      .filter((c: SuCandidate) => c.externalId && c.name)
    const brand = await prisma.brand.findUnique({
      where: { id: brandId },
      select: { id: true, name: true, aka: true, externalId: true },
    })
    if (!brand) return NextResponse.json({ ok: false, error: 'Brand not found' }, { status: 404, headers: cors })
    if (brand.externalId) {
      return NextResponse.json({ ok: true, outcome: 'already', externalId: brand.externalId }, { headers: cors })
    }

    // Pages Leo already turned down for this brand ("None of these") are
    // never offered or attached again.
    const offered = candidatesToOffer(candidates, (await readRejected(prisma))[brand.id])
    const { pick, reason } = decideMatch(brand.name, brand.aka, offered)
    if (!pick) {
      // Nothing came back (or only pages he turned down): no question
      // for Leo, so nothing is parked — the next lookup tries again.
      if (!offered.length) {
        return NextResponse.json({ ok: true, outcome: 'none', candidates: 0, ignored: candidates.length }, { headers: cors })
      }
      // Nothing obvious — park it for Leo rather than guessing. A wrong
      // id quietly fills a brand with another company's people.
      const list = await readProposals(prisma)
      await writeProposals(prisma, upsertProposal(list, {
        brandId: brand.id, brandName: brand.name, candidates: offered, at: Date.now(), v: PROPOSAL_VERSION,
      }))
      return NextResponse.json({ ok: true, outcome: reason, candidates: offered.length }, { headers: cors })
    }

    // externalId is unique — another brand may already hold this one.
    const taken = await prisma.brand.findFirst({ where: { externalId: pick.externalId }, select: { name: true } })
    if (taken) {
      return NextResponse.json({ ok: true, outcome: 'taken', by: taken.name }, { headers: cors })
    }
    await attachProfileId(brand.id, brand.name, brand.aka, pick)
    // Settled: an older proposal for this brand has nothing left to ask.
    const left = await readProposals(prisma)
    if (left.some(p => p.brandId === brand.id)) await writeProposals(prisma, left.filter(p => p.brandId !== brand.id))
    return NextResponse.json({ ok: true, outcome: 'attached', externalId: pick.externalId, name: pick.name }, { headers: cors })
  }

  // action: "searchJob" — the script's poll. Returns the one thing it
  // should do next: answer a search the dashboard asked for, or capture
  // a brand whose id was just attached ("pull their people now").
  if (body.action === 'searchJob') {
    const req = await readSearch(prisma)
    if (req && req.status === 'pending') {
      return NextResponse.json({ ok: true, job: { kind: 'search', id: req.id, q: req.q } }, { headers: cors })
    }
    const queue = await readCaptureQueue(prisma)
    if (queue.length) {
      return NextResponse.json({ ok: true, job: { kind: 'capture', ...queue[0] } }, { headers: cors })
    }
    return NextResponse.json({ ok: true, job: null }, { headers: cors })
  }

  // action: "searchResults" — the answer to a dashboard search.
  if (body.action === 'searchResults') {
    const req = await readSearch(prisma)
    if (!req || req.id !== String(body.id || '')) {
      return NextResponse.json({ ok: true, stale: true }, { headers: cors })
    }
    const results: SuCandidate[] = (Array.isArray(body.results) ? body.results : [])
      .map((c: any) => ({ externalId: String(c?.externalId || ''), name: String(c?.name || '') }))
      .filter((c: SuCandidate) => c.externalId && c.name)
    await writeSearch(prisma, {
      ...req,
      status: body.error ? 'failed' : 'done',
      results,
      error: body.error ? String(body.error).slice(0, 200) : undefined,
    })
    return NextResponse.json({ ok: true }, { headers: cors })
  }

  // action: "captureDone" — take a brand off the capture queue once the
  // script has read its people (or found none).
  if (body.action === 'captureDone') {
    const brandId = String(body.brandId || '')
    const queue = await readCaptureQueue(prisma)
    await writeCaptureQueue(prisma, queue.filter(x => x.brandId !== brandId))
    return NextResponse.json({ ok: true }, { headers: cors })
  }

  // action: "swept" — the script visited a brand and found nothing to
  // send (no contacts listed). Recorded so the brand rests instead of
  // being opened again on the next run; a visit that sends rows is
  // recorded on the rows POST below.
  if (body.action === 'swept') {
    const brandId = String(body.brandId || '')
    if (brandId) {
      try { await markSwept(prisma, brandId, Number(body.seen) || 0, Number(body.added) || 0) } catch { /* non-fatal */ }
    }
    return NextResponse.json({ ok: true }, { headers: cors })
  }

  // -----------------------------------------------------------------
  // The unattended LinkedIn fill. The script asks for its worklist,
  // hands back the company-search results for brands with no page, and
  // records each visit; saving people goes through liCapture above with
  // the brandId, so every rule (buyers only, 25 cap, no duplicates)
  // holds exactly as it does by hand.
  // -----------------------------------------------------------------

  // action: "liList" — every brand under the cap, off-outreach brands and
  // resting ones left out. Brands matching `focus` ("electrolyte") come
  // first, then emptiest first, like the SponsorUnited sweep.
  if (body.action === 'liList') {
    const terms = focusTerms(body.focus)
    const log = await readLiLog(prisma)
    const all = await prisma.brand.findMany({
      where: { doNotEmail: false, passedAt: null },
      select: {
        id: true, name: true, aka: true, about: true, topProducts: true, notes: true,
        category: true, linkedinUrl: true, _count: { select: { contacts: true } },
      },
    })
    const underCap = all.filter(b => b._count.contacts < CONTACT_CAP_PER_BRAND)
    const ignoreRest = body.ignoreRest === true
    // Brands whose people are under a parent company (parents.ts): the run
    // looks there when the brand's own page gives nobody. One read before
    // that existed, with nobody added, doesn't rest the brand.
    const parentPages = await readJsonSetting<Record<string, string>>(prisma, LI_PARENT_PAGES_KEY, {})
    const parentFor = (name: string, aka: string | null) => {
      const p = parentOf(name, aka)
      return p ? { name: p.name, search: p.search, slug: parentPages[p.name] || null } : null
    }
    const restsNow = (b: { id: string; name: string; aka: string | null }) => {
      const m = log[b.id]
      if (!liResting(m)) return false
      // A parent whose page wasn't found (script ≤1.20 marked it tried anyway).
      if (m && !m.added && /could not find .+ on LinkedIn/.test(m.note || '') && parentOf(b.name, b.aka)) return false
      return !(m && !m.added && !m.parentTried && parentOf(b.name, b.aka))
    }
    const resting = underCap.filter(restsNow).length
    // Brands Leo said have no LinkedIn page ("None of these") aren't searched again.
    const confirmed = await readJsonSetting<Confirmed>(prisma, LI_CONFIRMED_KEY, {})
    const items = underCap
      .filter(b => ignoreRest || !restsNow(b))
      .filter(b => b.linkedinUrl || confirmed[b.id] !== 'none' || parentOf(b.name, b.aka))
      .map(b => ({
        brandId: b.id, name: b.name, aka: b.aka, category: b.category,
        linkedinUrl: b.linkedinUrl, contacts: b._count.contacts, focus: matchesFocus(b, terms),
        parent: parentFor(b.name, b.aka),
      }))
      .sort((a, b) => Number(b.focus) - Number(a.focus) || a.contacts - b.contacts || a.name.localeCompare(b.name))

    // The research list: Stock take's lane ideas — known brand names not
    // on the roster under any name — for the run to look up on LinkedIn.
    // A lane the focus word names goes first ("electrolyte" → the
    // Electrolytes & hydration lane), ahead of the focus brands we have.
    const research: any[] = []
    let researchWaiting = 0
    if (body.research === true) {
      const rlog = await readLiResearch(prisma)
      const roster = await prisma.brand.findMany({ select: { name: true, aka: true } })
      const onRoster = new Set<string>()
      for (const b of roster) for (const n of [b.name, ...String(b.aka || '').split(/[,;]/)]) if (n.trim()) onRoster.add(brandKey(n))
      const words = String(body.focus || '').toLowerCase().split(/[,;]/).map(w => w.trim()).filter(Boolean)
      for (const l of LANES) {
        if (!l.priority) continue
        const laneFocus = words.some(w => l.key.includes(w) || l.name.toLowerCase().includes(w) || !!(l.words && l.words.test(w)))
        for (const k of l.known) {
          const names = k.split('|').map(n => n.trim()).filter(Boolean)
          if (!names.length || names.some(n => onRoster.has(brandKey(n)))) continue
          const akaList = names.slice(1).join(', ') || null
          // A name that found no page of its own before the parent route
          // existed gets its parent looked at now.
          const mark = rlog[brandKey(names[0])]
          if (researchResting(mark) && !(parentOf(names[0], akaList) && mark?.note === 'no clear LinkedIn page')) { researchWaiting++; continue }
          research.push({
            research: true, name: names[0], aka: akaList,
            category: l.key, lane: l.name, linkedinUrl: null, contacts: 0, focus: laneFocus,
            parent: parentFor(names[0], akaList),
          })
        }
      }
    }
    // Brands Leo asked for by name go before everything else.
    if (body.research === true) {
      const rlog = await readLiResearch(prisma)
      const roster = await prisma.brand.findMany({ select: { name: true, aka: true } })
      const onRoster = new Set<string>()
      for (const b of roster) for (const n of [b.name, ...String(b.aka || '').split(/[,;]/)]) if (n.trim()) onRoster.add(brandKey(n))
      const asked: any[] = []
      for (const x of RESEARCH_EXTRA) {
        const names = x.name.split('|').map(n => n.trim()).filter(Boolean)
        if (!names.length || names.some(n => onRoster.has(brandKey(n)))) continue
        if (researchResting(rlog[brandKey(names[0])])) { researchWaiting++; continue }
        asked.push({
          research: true, name: names[0], aka: names.slice(1).join(', ') || null,
          category: x.category, lane: 'Asked for by name', linkedinUrl: null, contacts: 0, focus: true,
        })
      }
      research.unshift(...asked)
    }
    // First of all: brands the Schedule has on its coming days that are
    // short on people (Leo: "planned brands first"), so they have
    // someone to invite by their day — soonest day first. `planned` is
    // that day.
    const [planRow, shownRow] = await Promise.all([
      prisma.setting.findUnique({ where: { key: 'outreachPlan' } }),
      prisma.setting.findUnique({ where: { key: 'outreachShownDays' } }),
    ])
    const parse = (row: { value: string } | null) => { try { return row ? JSON.parse(row.value) : null } catch { return null } }
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    const due = dueDays({ plan: parse(planRow), shown: parse(shownRow), today })
    const dueIds = items.map(i => i.brandId).filter(id => due.has(id))
    const dueBrands = dueIds.length
      ? await prisma.brand.findMany({
          where: { id: { in: dueIds } },
          select: { id: true, tier: true, workPeople: true, contacts: { select: { email: true, linkedinUrl: true } } },
        })
      : []
    const short = new Set(dueBrands.filter(shortOnPeople).map(b => b.id))
    const { first: planned, rest } = plannedFirst(items, due, short)
    const ordered = [
      ...planned,
      ...research.filter(r => r.focus), ...rest.filter(i => i.focus),
      ...research.filter(r => !r.focus), ...rest.filter(i => !i.focus),
    ]
    return NextResponse.json({
      ok: true,
      items: ordered,
      research: research.length,
      researchFocus: research.filter(r => r.focus).length,
      researchWaiting,
      focusCount: ordered.filter(i => i.focus).length,
      planned: planned.length,
      noPage: items.filter(i => !i.linkedinUrl).length,
      resting,
      underCap: underCap.length,
      cap: CONTACT_CAP_PER_BRAND,
      latest: LI_SCRIPT_VERSION,
    }, { headers: cors })
  }

  // action: "liMatched" — LinkedIn's company-search results for a brand
  // with no page saved. The server decides (decideCompanyMatch): an exact
  // name, or a near miss whose industry fits; anything unclear is left.
  if (body.action === 'liMatched') {
    const brand = await prisma.brand.findUnique({
      where: { id: String(body.brandId || '') },
      select: { id: true, name: true, aka: true, category: true, linkedinUrl: true },
    })
    if (!brand) return NextResponse.json({ ok: false, error: 'Brand not found' }, { status: 404, headers: cors })
    // recheck: the saved page's People tab showed another industry
    // (liCapture's pageMismatch), and the run searched again.
    const recheck = body.recheck === true
    if (brand.linkedinUrl && !recheck) return NextResponse.json({ ok: true, outcome: 'already', linkedinUrl: brand.linkedinUrl }, { headers: cors })
    const candidates: LiCompany[] = (Array.isArray(body.candidates) ? body.candidates : []).slice(0, 20)
      .map((c: any) => ({
        slug: companySlug(String(c?.url || '')) || '',
        name: String(c?.name || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        subtitle: String(c?.subtitle || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      }))
      .filter((c: LiCompany) => c.slug && c.name)
    const { pick, reason } = decideCompanyMatch(brand, candidates)
    const review = async (why: 'unclear' | 'none' | 'wrong') => {
      const list = await readJsonSetting<Review>(prisma, LI_REVIEW_KEY, {})
      await writeJsonSetting(prisma, LI_REVIEW_KEY, addToReview(list, brand.id, {
        why, saved: recheck ? brand.linkedinUrl : null,
        candidates: (pick ? [pick, ...candidates.filter(c => c.slug !== pick.slug)] : candidates)
          .slice(0, 6).map(c => ({ slug: c.slug, name: c.name, subtitle: c.subtitle || '' })),
      }))
    }
    // A saved page is never swapped by the run itself: the results go on
    // Leo's list, the one that fits first.
    if (recheck) {
      await review('wrong')
      return NextResponse.json({ ok: true, outcome: 'review', suggested: pick?.name || null, candidates: candidates.length }, { headers: cors })
    }
    if (!pick) {
      await review(reason === 'none' ? 'none' : 'unclear')
      return NextResponse.json({ ok: true, outcome: reason, candidates: candidates.length }, { headers: cors })
    }
    // Another brand already has this page: a sister brand or a duplicate.
    // Not attached twice — the page would then match either.
    const withPage = await prisma.brand.findMany({ where: { linkedinUrl: { not: null }, id: { not: brand.id } }, select: { name: true, linkedinUrl: true } })
    const owner = withPage.find(b => companySlug(b.linkedinUrl) === pick.slug)
    if (owner) return NextResponse.json({ ok: true, outcome: 'taken', by: owner.name }, { headers: cors })
    const linkedinUrl = companyPageUrl(pick.slug)
    await prisma.brand.update({ where: { id: brand.id }, data: { linkedinUrl } })
    // Found under its other name after the first try went on the list.
    const list = await readJsonSetting<Review>(prisma, LI_REVIEW_KEY, {})
    if (list[brand.id]) { delete list[brand.id]; await writeJsonSetting(prisma, LI_REVIEW_KEY, list) }
    return NextResponse.json({ ok: true, outcome: 'attached', how: reason, name: pick.name, linkedinUrl }, { headers: cors })
  }

  // action: "liDiscover" — companies LinkedIn put in front of the run:
  // the lookalikes next to a brand ("Pages people also viewed") or a
  // company search for a word Leo gave. Leo's call (Sep 2026): straight
  // into the dashboard, consumer industries and 5K+ followers only
  // (judgeDiscovery). Anything already a brand, or dismissed on the
  // Discover page before, is left alone. Each one also gets a Discover
  // row (status "added") so the page shows where it came from.
  if (body.action === 'liDiscover') {
    const source = body.source === 'search' ? 'search' : 'lookalike'
    const from = String(body.from || '').trim().slice(0, 80)
    const fromBrand = body.fromBrandId
      ? await prisma.brand.findUnique({ where: { id: String(body.fromBrandId) }, select: { name: true, category: true } })
      : null
    const label = source === 'search' ? `LinkedIn search: ${from}` : `LinkedIn: similar to ${fromBrand?.name || from}`

    // Rolling day, so a run that crosses midnight can't add 100.
    let room = DISCOVER_CAP_PER_DAY - await prisma.brand.count({
      where: { source: 'linkedin-discover', createdAt: { gte: new Date(Date.now() - 864e5) } },
    })

    const brands = await prisma.brand.findMany({ select: { name: true, aka: true, linkedinUrl: true } })
    const knownNames = new Set<string>()
    const knownSlugs = new Set<string>()
    for (const b of brands) {
      knownNames.add(normalizeCompany(b.name))
      for (const a of String(b.aka || '').split(/[,;]/)) if (a.trim()) knownNames.add(normalizeCompany(a))
      const sl = companySlug(b.linkedinUrl)
      if (sl) knownSlugs.add(sl)
    }
    const dismissed = await prisma.discoveredBrand.findMany({ where: { status: 'dismissed' }, select: { name: true, linkedinUrl: true } })
    const dismissedNames = new Set(dismissed.map(d => normalizeCompany(d.name)))
    const dismissedSlugs = new Set(dismissed.map(d => companySlug(d.linkedinUrl)).filter(Boolean) as string[])

    const tally = { known: 0, dismissed: 0, small: 0, industry: 0, capped: 0 }
    const created: Array<{ brandId: string; name: string; category: string; linkedinUrl: string }> = []
    const seen = new Set<string>()
    for (const raw of (Array.isArray(body.companies) ? body.companies : []).slice(0, 40)) {
      const slug = companySlug(String(raw?.url || ''))
      const name = String(raw?.name || '').replace(/\s+/g, ' ').trim().slice(0, 120)
      const subtitle = String(raw?.subtitle || '').replace(/\s+/g, ' ').trim().slice(0, 200)
      if (!slug || !name || seen.has(slug)) continue
      seen.add(slug)
      const key = normalizeCompany(name)
      // LinkedIn's name often carries what the brand sells ("Waterloo
      // Sparkling Water" for the roster's Waterloo): a near name counts as
      // known, or an archived brand would come back as a new one.
      const nearKnown = (set: Set<string>) => set.has(key) || Array.from(set).some(n => nearName(n, key))
      if (!key || knownSlugs.has(slug) || nearKnown(knownNames)) { tally.known++; continue }
      if (dismissedSlugs.has(slug) || nearKnown(dismissedNames)) { tally.dismissed++; continue }
      const verdict = judgeDiscovery({ name, subtitle }, fromBrand?.category ?? null)
      if ('reason' in verdict) { tally[verdict.reason]++; continue }
      if (room <= 0) { tally.capped++; continue }
      // The name can say more than LinkedIn's industry line ("Casamigos
      // Tequila" is alcohol, "Beverage Manufacturing" isn't specific) —
      // taken only when it agrees with the industry.
      const byName = guessCategory(name, '')
      const category = byName !== 'unresolved' && byName !== verdict.category && industryFits(byName, verdict.industry)
        ? byName : verdict.category
      const how = source === 'search' ? `LinkedIn search for "${from}"` : `LinkedIn, similar to ${fromBrand?.name || from}`
      let brand
      try {
        brand = await prisma.brand.create({
          data: {
            name,
            linkedinUrl: companyPageUrl(slug),
            source: 'linkedin-discover',
            category,
            notes: `Found by ${how} — ${verdict.industry}, ${verdict.followers.toLocaleString('en-US')} followers.`,
          },
        })
      } catch {
        // A name clash we didn't catch (different spelling, same name).
        tally.known++
        continue
      }
      knownNames.add(key); knownSlugs.add(slug); room--
      try {
        await prisma.discoveredBrand.upsert({
          where: { query_name: { query: label, name } },
          create: {
            query: label, name, category, linkedinUrl: brand.linkedinUrl, status: 'added', brandId: brand.id,
            reason: `${verdict.industry} · ${verdict.followers.toLocaleString('en-US')} followers`,
          },
          update: { status: 'added', brandId: brand.id },
        })
      } catch { /* the log row is a nicety */ }
      created.push({ brandId: brand.id, name, category, linkedinUrl: brand.linkedinUrl! })
    }
    return NextResponse.json({ ok: true, label, created, ...tally, cap: DISCOVER_CAP_PER_DAY }, { headers: cors })
  }

  // action: "liResearch" — a name from the research list, and LinkedIn's
  // company-search results for it. A clear match whose industry fits the
  // lane (decideResearchMatch) becomes a brand, and the run reads its
  // people next. A name that turns out to be a brand we have already
  // (another spelling) just points the run at it. `final` = the run has
  // no other spelling to try, so an unclear answer is logged and the
  // name rests a month.
  if (body.action === 'liResearch') {
    const name = String(body.name || '').trim().slice(0, 120)
    const aka = String(body.aka || '').trim().slice(0, 200) || null
    const category = String(body.category || '').trim().slice(0, 40) || 'unresolved'
    const lane = String(body.lane || '').trim().slice(0, 60)
    const key = brandKey(name)
    if (!name || !key) return NextResponse.json({ ok: false, error: 'No name' }, { status: 400, headers: cors })

    // Already ours under any spelling — the same loose key Stock take
    // uses to decide what's an idea ("Liquid IV" is "Liquid I.V.").
    const wanted = new Set([name, ...String(aka || '').split(/[,;]/)].map(x => brandKey(x.trim())).filter(Boolean))
    const roster = await prisma.brand.findMany({ select: { id: true, name: true, aka: true, linkedinUrl: true } })
    const have = roster.find(b => [b.name, ...String(b.aka || '').split(/[,;]/)].some(n => n.trim() && wanted.has(brandKey(n))))
    if (have) {
      await markLiResearch(prisma, key, { outcome: 'exists' })
      return NextResponse.json({ ok: true, outcome: 'exists', brandId: have.id, name: have.name, linkedinUrl: have.linkedinUrl }, { headers: cors })
    }

    const candidates: LiCompany[] = (Array.isArray(body.candidates) ? body.candidates : []).slice(0, 20)
      .map((c: any) => ({
        slug: companySlug(String(c?.url || '')) || '',
        name: String(c?.name || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        subtitle: String(c?.subtitle || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      }))
      .filter((c: LiCompany) => c.slug && c.name)
    const { pick, reason } = decideResearchMatch({ name, aka, category }, candidates)
    // No page of its own, but a parent we know (Ketel One → Diageo): it
    // becomes a brand anyway and the run reads its people at the parent.
    const parent = !pick && body.final === true ? parentOf(name, aka) : null
    if (parent) {
      let brand
      try {
        brand = await prisma.brand.create({
          data: {
            name, aka, linkedinUrl: null, source: 'research', category,
            notes: `From the research list (${lane || category}) — no LinkedIn page of its own; its people are under ${parent.name}.`,
          },
        })
      } catch {
        const b = await findBrandForCapture(name, null)
        if (!b) return NextResponse.json({ ok: false, error: `Could not add ${name}` }, { status: 409, headers: cors })
        return NextResponse.json({ ok: true, outcome: 'exists', brandId: b.id, name: b.name, linkedinUrl: b.linkedinUrl }, { headers: cors })
      }
      await markLiResearch(prisma, key, { outcome: 'added', note: `under ${parent.name}` })
      try {
        await prisma.discoveredBrand.upsert({
          where: { query_name: { query: `Research list: ${lane || category}`, name } },
          create: { query: `Research list: ${lane || category}`, name, category, linkedinUrl: null, status: 'added', brandId: brand.id, reason: `No page of its own — people under ${parent.name}` },
          update: { status: 'added', brandId: brand.id },
        })
      } catch { /* the log row is a nicety */ }
      const pages = await readJsonSetting<Record<string, string>>(prisma, LI_PARENT_PAGES_KEY, {})
      return NextResponse.json({
        ok: true, outcome: 'parent', brandId: brand.id, name,
        parent: { name: parent.name, search: parent.search, slug: pages[parent.name] || null },
      }, { headers: cors })
    }
    if (!pick) {
      if (body.final === true) await markLiResearch(prisma, key, { outcome: 'unclear', note: 'no clear LinkedIn page' })
      return NextResponse.json({ ok: true, outcome: reason, candidates: candidates.length }, { headers: cors })
    }

    // The page is already on a brand of ours under another name: that
    // brand is this one. Remember the list's spelling on it.
    const withPage = await prisma.brand.findMany({ where: { linkedinUrl: { not: null } }, select: { id: true, name: true, aka: true, linkedinUrl: true } })
    const owner = withPage.find(b => companySlug(b.linkedinUrl) === pick.slug)
    if (owner) {
      const akas = String(owner.aka || '').split(/[,;]/).map(x => x.trim()).filter(Boolean)
      if (!akas.some(a => brandKey(a) === key) && brandKey(owner.name) !== key) {
        try { await prisma.brand.update({ where: { id: owner.id }, data: { aka: [...akas, name].join(', ') } }) } catch { /* non-fatal */ }
      }
      await markLiResearch(prisma, key, { outcome: 'exists', note: `same page as ${owner.name}` })
      return NextResponse.json({ ok: true, outcome: 'exists', brandId: owner.id, name: owner.name, linkedinUrl: owner.linkedinUrl }, { headers: cors })
    }

    // LinkedIn's own spelling joins the list's other names, so later
    // captures and SponsorUnited both match it.
    const akas = String(aka || '').split(/[,;]/).map(x => x.trim()).filter(Boolean)
    if (normalizeCompany(pick.name) !== normalizeCompany(name) && !akas.some(a => normalizeCompany(a) === normalizeCompany(pick.name))) akas.push(pick.name)
    let brand
    try {
      brand = await prisma.brand.create({
        data: {
          name,
          aka: akas.length ? akas.join(', ') : null,
          linkedinUrl: companyPageUrl(pick.slug),
          source: 'research',
          category,
          notes: `From the research list (${lane || category}) — found on LinkedIn as ${pick.name}.`,
        },
      })
    } catch {
      const b = await findBrandForCapture(name, null)
      if (!b) return NextResponse.json({ ok: false, error: `Could not add ${name}` }, { status: 409, headers: cors })
      return NextResponse.json({ ok: true, outcome: 'exists', brandId: b.id, name: b.name, linkedinUrl: b.linkedinUrl }, { headers: cors })
    }
    await markLiResearch(prisma, key, { outcome: 'added' })
    try {
      await prisma.discoveredBrand.upsert({
        where: { query_name: { query: `Research list: ${lane || category}`, name } },
        create: { query: `Research list: ${lane || category}`, name, category, linkedinUrl: brand.linkedinUrl, status: 'added', brandId: brand.id, reason: `LinkedIn: ${pick.name}${pick.subtitle ? ' · ' + pick.subtitle : ''}`.slice(0, 300) },
        update: { status: 'added', brandId: brand.id },
      })
    } catch { /* the log row is a nicety */ }
    return NextResponse.json({ ok: true, outcome: 'added', how: reason, brandId: brand.id, name, linkedinUrl: brand.linkedinUrl }, { headers: cors })
  }

  // action: "liSwept" — one brand visited: how many people were read,
  // how many added, and a note when something stopped it ("no clear
  // LinkedIn page"). Drives the 30-day rest and the dashboard's note.
  if (body.action === 'liSwept') {
    const brandId = String(body.brandId || '')
    if (brandId) {
      try {
        await markLiSwept(prisma, brandId, {
          seen: Math.max(0, Number(body.seen) || 0),
          added: Math.max(0, Number(body.added) || 0),
          note: body.note ? String(body.note).slice(0, 160) : null,
          v: Number(body.reader) || 0,
          parentTried: body.parentTried === true,
        })
      } catch { /* non-fatal */ }
    }
    // The run's report (li-report.ts). Research names that never became
    // a brand come through here too, with no brandId.
    if (body.run) {
      try {
        await recordRun(prisma, {
          kind: 'brand', run: String(body.run), script: body.script, reader: Number(body.reader) || 0,
          name: body.name, brandId: brandId || null, seen: body.seen, added: body.added,
          note: body.note || null, problem: body.problem || null, sample: body.sample || null,
          ms: body.ms ?? null, hiddenMs: body.hiddenMs, via: body.via || null, members: body.members ?? null,
        })
      } catch { /* the report is a nicety; the sweep log above is what counts */ }
    }
    return NextResponse.json({ ok: true, latest: LI_SCRIPT_VERSION }, { headers: cors })
  }

  // action: "liRun" — a run started, paused, carried on or ended.
  if (body.action === 'liRun') {
    const kind = ['start', 'pause', 'resume', 'finish'].includes(body.kind) ? body.kind : null
    if (!kind || !body.run) return NextResponse.json({ ok: false, error: 'kind and run needed' }, { status: 400, headers: cors })
    try {
      await recordRun(prisma, {
        kind, run: String(body.run), script: body.script, reader: Number(body.reader) || 0,
        focus: body.focus, items: body.items, why: body.why, stopped: !!body.stopped, newBrands: body.newBrands,
      })
    } catch { /* non-fatal */ }
    return NextResponse.json({ ok: true, latest: LI_SCRIPT_VERSION }, { headers: cors })
  }

  // action: "liParent" — which search result is a parent company's own
  // page (parents.ts). Remembered in Setting liParentPages, so each parent
  // is searched for once.
  if (body.action === 'liParent') {
    const parent = PARENTS.find(p => p.name === String(body.parent || ''))
    if (!parent) return NextResponse.json({ ok: false, error: 'Unknown parent company' }, { status: 400, headers: cors })
    const candidates: LiCompany[] = (Array.isArray(body.candidates) ? body.candidates : []).slice(0, 20)
      .map((c: any) => ({
        slug: companySlug(String(c?.url || '')) || '',
        name: String(c?.name || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        subtitle: String(c?.subtitle || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      }))
      .filter((c: LiCompany) => c.slug && c.name)
    const pick = decideParentPage(parent, candidates)
    if (!pick) return NextResponse.json({ ok: true, slug: null, candidates: candidates.length, shown: candidates.slice(0, 3).map(c => c.name) }, { headers: cors })
    const pages = await readJsonSetting<Record<string, string>>(prisma, LI_PARENT_PAGES_KEY, {})
    pages[parent.name] = pick.slug
    await writeJsonSetting(prisma, LI_PARENT_PAGES_KEY, pages)
    return NextResponse.json({ ok: true, slug: pick.slug, name: pick.name }, { headers: cors })
  }

  // action: "liVersion" — the current script, so an older copy can offer
  // the update without waiting for Tampermonkey's daily check.
  if (body.action === 'liVersion') {
    return NextResponse.json({ ok: true, latest: LI_SCRIPT_VERSION }, { headers: cors })
  }

  // action: "liPreview" — what a LinkedIn People page would add, without
  // saving anything. The script shows this before Leo confirms.
  if (body.action === 'liPreview') {
    const plan = await planLinkedin(body)
    return NextResponse.json({ ok: true, ...liSummary(plan) }, { headers: cors })
  }

  // -----------------------------------------------------------------
  // The SB · Log pill (scripts/linkedin-log.user.js, Zach's browser) on
  // someone's LinkedIn profile (Leo, Sep 2026: invites
  // often go out straight from LinkedIn, unlogged). One click logs them
  // as "invite sent" or "accepted" — never through a day's queue. The
  // rules are src/lib/li-log.ts, the same as Zach's list and the brand
  // page use.
  // -----------------------------------------------------------------

  // action: "liPerson" — are they on file, and under which brand would
  // they go? Nothing is saved.
  if (body.action === 'liPerson') {
    const slug = profileSlug(body.url)
    if (!slug) return NextResponse.json({ ok: false, error: 'Open their LinkedIn profile first (linkedin.com/in/…).' }, { status: 400, headers: cors })
    const r = await resolveLinkedinBrand(body)
    const nameGuess = cleanName(body.name) ?? nameFromSlug(slug)
    const person = await personOnFile(prisma, { url: profileUrl(slug), name: nameGuess, brandId: r.brand?.id ?? null })
    const b = r.brand
    return NextResponse.json({
      ok: true,
      url: profileUrl(slug),
      person,
      brand: b ? { id: b.id, name: b.name, category: b.category, archived: !!b.passedAt } : null,
      matchedBy: r.matchedBy,
      notFound: !b && r.typed ? r.typed : null,
      suggestions: r.suggestions,
      createName: !b ? (r.typed || r.companyName || null) : null,
      nameGuess,
      titleGuess: roleFromHeadline(body.headline, r.companyName || b?.name || null),
    }, { headers: cors })
  }

  // action: "liPersonLog" — the log itself: { stage: 'sent' | 'accepted' }
  // for someone on file (contactId), or for the profile's person under a
  // brand (picked, typed, matched, or — Leo pressed "Add … as a new
  // brand" — created here).
  if (body.action === 'liPersonLog') {
    const helpers = { fit: scoreFit, decisionMaker: looksLikeDecisionMaker }
    try {
      if (body.contactId) {
        const done = await logLinkedInPerson(prisma, { contactId: String(body.contactId), stage: body.stage, actor: 'SB pill' }, helpers)
        return NextResponse.json({ ok: true, ...done, brandCreated: false }, { headers: cors })
      }
      const slug = profileSlug(body.url)
      if (!slug) return NextResponse.json({ ok: false, error: 'Open their LinkedIn profile first (linkedin.com/in/…).' }, { status: 400, headers: cors })
      const r = await resolveLinkedinBrand(body)
      let brand = r.brand
      let brandCreated = false
      const createName = r.typed || r.companyName
      if (!brand && body.createIfMissing === true && createName) {
        // The person first: a new brand only once they're sound.
        if (!isLogStage(body.stage)) throw new Error('Pick “Invite sent” or “They accepted”.')
        checkNewPerson({ name: body.name || nameFromSlug(slug), linkedinUrl: profileUrl(slug) })
        const made = await createBrandFromLinkedin(createName, r.slug, [body.companyName, body.headline].filter(Boolean).map(String).join(' '))
        if (made) { brand = made.brand; brandCreated = made.created }
      }
      if (!brand) {
        return NextResponse.json({ ok: false, error: r.typed ? `No brand called "${r.typed}" in the dashboard.` : 'Pick the dashboard brand first.' }, { status: 400, headers: cors })
      }
      const done = await logLinkedInPerson(prisma, {
        brandId: brand.id,
        name: body.name,
        title: body.title,
        linkedinUrl: profileUrl(slug),
        stage: body.stage,
        actor: 'SB pill',
      }, helpers)
      return NextResponse.json({ ok: true, ...done, brandCreated }, { headers: cors })
    } catch (err: any) {
      return NextResponse.json({ ok: false, error: err?.message ?? 'Could not log that.' }, { status: 400, headers: cors })
    }
  }

  // action: "liPersonUndo" — the panel's Undo, straight after a log.
  if (body.action === 'liPersonUndo') {
    try {
      const done = await undoLinkedInLog(prisma, body.undo, 'SB pill')
      return NextResponse.json({ ok: true, ...done }, { headers: cors })
    } catch (err: any) {
      return NextResponse.json({ ok: false, error: err?.message ?? 'Could not undo that.' }, { status: 400, headers: cors })
    }
  }

  // action: "liCapture" — the same plan, saved. Re-planned here rather
  // than trusting the preview, so two tabs or a stale panel can't push a
  // brand past 25 or add someone twice.
  if (body.action === 'liCapture') {
    // The run's reads (checkPage) first check the page is the brand's:
    // a saved page whose industry doesn't fit (Native had a home-care
    // agency's page) saves nobody and goes on Leo's list, unless he
    // picked that page himself.
    if (body.checkPage === true && body.brandId) {
      const b = await prisma.brand.findUnique({ where: { id: String(body.brandId) }, select: { id: true, category: true, linkedinUrl: true } })
      // The run reads the brand's saved page; its address says which.
      const pageSlug = companySlug(String(body.companyUrl || '')) || companySlug(b?.linkedinUrl)
      const confirmed = await readJsonSetting<Confirmed>(prisma, LI_CONFIRMED_KEY, {})
      if (b && pageSlug && confirmed[b.id] !== pageSlug && pageLooksWrong(b.category, body.companyIndustry)) {
        const industry = String(body.companyIndustry).replace(/\s+/g, ' ').trim().slice(0, 120)
        const list = await readJsonSetting<Review>(prisma, LI_REVIEW_KEY, {})
        await writeJsonSetting(prisma, LI_REVIEW_KEY, addToReview(list, b.id, { why: 'wrong', saved: b.linkedinUrl || companyPageUrl(pageSlug), pageIndustry: industry }))
        return NextResponse.json({ ok: true, pageMismatch: true, industry, added: 0, have: 0, cap: CONTACT_CAP_PER_BRAND }, { headers: cors })
      }
    }
    let plan = await planLinkedin(body)
    // A brand the dashboard doesn't have yet, added from the panel — Leo
    // pressed "Add … as a new brand", so the name is his decision (as a
    // hand-run SponsorUnited capture may create one; the unattended fill
    // only visits brands that exist, so it never creates any).
    let brandCreated = false
    if (!plan.brand && body.createIfMissing === true && plan.createName) {
      // The page's own name is a hint too: "Casamigos" says nothing,
      // "Casamigos Tequila" says alcohol.
      const hint = [body.companyName, body.companyIndustry].filter(Boolean).map(String).join(' ')
      const made = await createBrandFromLinkedin(plan.createName, plan.slug, hint)
      if (made) {
        brandCreated = made.created
        plan = await planLinkedin({ ...body, brandId: made.brand.id })
      }
    }
    const brand = plan.brand
    if (!brand) {
      return NextResponse.json({ ok: false, error: plan.notFound ? `No brand called "${plan.notFound}" in the dashboard.` : 'Pick the dashboard brand first.', ...liSummary(plan) }, { status: 400, headers: cors })
    }
    // Remember the company page, so the next visit matches on the page
    // itself. Fill-if-empty, like every other capture field — and not
    // when another brand already has this page (sister brands under one
    // parent page), or the next visit would match whichever came first.
    let savedPage = false
    if (plan.slug && !brand.linkedinUrl && body.viaParent !== true) {
      const others = await prisma.brand.findMany({
        where: { linkedinUrl: { not: null }, id: { not: brand.id } },
        select: { linkedinUrl: true },
      })
      if (!others.some(o => companySlug(o.linkedinUrl) === plan.slug)) {
        try {
          await prisma.brand.update({ where: { id: brand.id }, data: { linkedinUrl: companyPageUrl(plan.slug) } })
          savedPage = true
        } catch { /* non-fatal */ }
      }
    }
    let added = 0, targetsCreated = 0, failed = 0
    const errors: string[] = []
    for (const r of plan.rows) {
      if (r.verdict !== 'add') continue
      try {
        const contact = await prisma.contact.create({
          data: {
            brandId: brand.id,
            name: r.name,
            title: r.role,
            linkedinUrl: r.linkedinUrl,
            source: 'linkedin',
            // Only buyer titles get this far.
            isDecisionMaker: true,
          },
        })
        added++
        await prisma.target.create({
          data: { brandId: brand.id, contactId: contact.id, fitScore: r.fit, assignedTo: brand.owner ?? null },
        })
        targetsCreated++
      } catch (err: any) {
        failed++
        if (errors.length < 10) errors.push(`${r.name}: ${err?.message ?? 'error'}`)
      }
    }
    let targetsShelved = 0
    try { targetsShelved = await reconcileBrandTargets(brand.id) } catch { /* skip */ }
    const have = await prisma.contact.count({ where: { brandId: brand.id } })
    return NextResponse.json({
      ok: true,
      brand: { id: brand.id, name: brand.name },
      added, targetsCreated, targetsShelved, failed, errors,
      have, cap: CONTACT_CAP_PER_BRAND, brandCreated,
      savedPage,
    }, { headers: cors })
  }

  if (body.action === 'list') {
    const scope = body.scope === 'all' ? 'all' : 'thin'
    const limit = Math.max(1, Math.min(500, Number(body.limit) || 100))
    // "thin" = under the per-brand cap, i.e. a brand we can still add
    // people to. It used to mean "no contacts at all", which is why a
    // brand that got two people on its first capture was never visited
    // again: two is not zero, so the sweep skipped it forever. Under
    // the cap, a brand keeps coming back until it has its 25.
    // Prisma can't compare a relation count in `where`, so the count
    // comes back with each row and the filter happens here. Brand
    // count is in the hundreds — one query, no pagination worries.
    const all = await prisma.brand.findMany({
      where: { externalId: { not: null }, doNotEmail: false, passedAt: null },
      select: { id: true, name: true, externalId: true, aka: true, _count: { select: { contacts: true } } },
      orderBy: { name: 'asc' },
    })
    // Emptiest first, so a sweep that stops at the limit has spent its
    // run on the brands with the least, not on topping up a brand that
    // already has twenty.
    // A brand whose last visit found nobody new rests for a fortnight
    // (see su-match's sweep log) — otherwise the emptiest-first order
    // opens the same handful of stalled brands every single run.
    // Leo can override the rest: "nothing new last time" is a guess
    // about SponsorUnited, not a fact, and when he has just added
    // profile ids by hand he wants those brands walked now.
    const ignoreRest = body.ignoreRest === true
    const sweepLog = scope === 'all' || ignoreRest ? {} : await readSweepLog(prisma)
    const underCap = all.filter(x => x._count.contacts < CONTACT_CAP_PER_BRAND)
    // Reported even when overridden, so the panel can say what it just
    // chose to include.
    const restLog = scope === 'all' ? {} : await readSweepLog(prisma)
    const resting = scope === 'all' ? 0 : underCap.filter(x => isResting(restLog[x.id])).length
    const brands = (scope === 'all'
      ? all
      : underCap.filter(x => !isResting(sweepLog[x.id]))
           .sort((x, y) => x._count.contacts - y._count.contacts || x.name.localeCompare(y.name))
    ).slice(0, limit)
    // How many are out of reach for a sweep, so the panel can say so
    // instead of quietly capturing less than Leo expects.
    const withoutProfile = await prisma.brand.findMany({
      where: { externalId: null, doNotEmail: false, passedAt: null },
      select: { _count: { select: { contacts: true } } },
    })
    const noProfile = scope === 'all'
      ? withoutProfile.length
      : withoutProfile.filter(b => b._count.contacts < CONTACT_CAP_PER_BRAND).length
    return NextResponse.json({
      ok: true,
      scope,
      noProfile,
      // Under the cap but skipped this run: nothing new last time.
      resting,
      ignoredRest: ignoreRest,
      // Under the cap and eligible, before the limit trimmed the list —
      // so "2 of 240" can be explained rather than just shown.
      eligible: scope === 'all' ? all.length : underCap.filter(x => ignoreRest || !isResting(restLog[x.id])).length,
      underCap: underCap.length,
      cap: CONTACT_CAP_PER_BRAND,
      brands: brands.map(b => ({
        id: b.id,
        name: b.name,
        externalId: b.externalId,
        // The name SponsorUnited uses, when we know it differs.
        suName: (b.aka ?? '').split(/[,;]/)[0].trim() || b.name,
        contacts: b._count.contacts,
      })),
    }, { headers: cors })
  }

  // Best titles first. When a brand has room for only some of what was
  // captured, the people who stay are the partnership, campus and
  // marketing ones — not whoever SponsorUnited happened to render first.
  // Array.prototype.sort is stable, so rows for different brands keep
  // their relative order and each brand is still processed as a group.
  const rows: any[] = (Array.isArray(body.rows) ? body.rows : [])
    .slice()
    .sort((a: any, b: any) => scoreFit(b?.title ?? null, null) - scoreFit(a?.title ?? null, null))
  const result = { contactsCreated: 0, targetsCreated: 0, targetsShelved: 0, skipped: 0, capped: 0, failed: 0, brandsCreated: [] as string[], brandsMissing: [] as string[], errors: [] as string[] }
  // Only a hand-run capture from the panel may create a brand.
  const createIfMissing = body.createIfMissing === true
  const touched = new Set<string>()
  // brandId -> how many more people this brand can take in this batch.
  // Counted once per brand from what is already stored, then kept in
  // step as rows land, so a 40-person capture doesn't need 40 counts.
  const room = new Map<string, number>()
  // SponsorUnited name -> the people captured under it that matched no
  // brand of ours. Written to the miss log once, after the loop.
  const missed = new Map<string, { externalId: string | null; rows: HeldRow[] }>()

  for (const row of rows) {
    try {
      if (!row.brandName || !row.name) { result.skipped++; continue }

      // An unattended sweep may not invent brands, so a misread name
      // can't litter the roster; a hand-run capture (createIfMissing)
      // may, because Leo confirmed the name. Matches the name
      // (case-insensitive, so "ESPN BET" matches "ESPN Bet"), then the
      // SponsorUnited profile ID, then any "also known as" name.
      const suId = row.brandExternalId ?? body.brandExternalId ?? null
      let brand = await findBrandForCapture(row.brandName, suId)
      if (!brand && createIfMissing) {
        brand = await createBrandForCapture(row.brandName, suId)
        if (brand && !result.brandsCreated.includes(brand.name)) result.brandsCreated.push(brand.name)
      }
      if (!brand) {
        // Unknown name — hold the person rather than dropping them. The
        // Needs-contacts tab lists these; attaching one to a brand adds
        // the name as an "also known as" and replays these rows.
        if (!result.brandsMissing.includes(row.brandName)) result.brandsMissing.push(row.brandName)
        const held = missed.get(row.brandName) ?? { externalId: suId, rows: [] as HeldRow[] }
        held.externalId = held.externalId || suId
        held.rows.push({
          name: row.name,
          title: row.title ?? null,
          email: row.email ?? null,
          phone: row.phone ?? null,
          location: row.location ?? null,
          linkedinUrl: row.linkedinUrl ?? null,
        })
        missed.set(row.brandName, held)
        result.skipped++
        continue
      }
      touched.add(brand.id)

      // Save the brand's SponsorUnited profile ID the first time we see it,
      // so the dashboard's "SponsorUnited" button can deep-link straight to
      // this brand instead of the generic search. Only sets it if empty —
      // never overwrites a good ID with a bad one.
      if (suId && !brand.externalId) {
        try { await prisma.brand.update({ where: { id: brand.id }, data: { externalId: suId } }) }
        catch { /* a clash on the unique externalId shouldn't fail the import */ }
      }

      // Brand-level extras a capture may carry (website, what they do,
      // best sellers) — fill-if-empty only, hand data is never touched.
      const fill: Record<string, string> = {}
      const bw = row.brandWebsite ?? body.brandWebsite, ba = row.brandAbout ?? body.brandAbout, bp = row.brandProducts ?? body.brandProducts
      if (bw && !brand.website) fill.website = String(bw).slice(0, 300)
      if (ba && !brand.about) fill.about = String(ba).slice(0, 200)
      if (bp && !brand.topProducts) fill.topProducts = String(bp).slice(0, 200)
      if (Object.keys(fill).length) {
        try { await prisma.brand.update({ where: { id: brand.id }, data: fill }) } catch { /* non-fatal */ }
      }

      const dupe = await prisma.contact.findFirst({ where: { brandId: brand.id, name: row.name } })
      if (dupe) { result.skipped++; continue }

      // The cap. Checked after the duplicate check, so re-capturing a
      // brand we already hold doesn't report its own people as capped.
      if (!room.has(brand.id)) {
        const have = await prisma.contact.count({ where: { brandId: brand.id } })
        room.set(brand.id, Math.max(0, CONTACT_CAP_PER_BRAND - have))
      }
      if ((room.get(brand.id) ?? 0) <= 0) { result.capped++; continue }

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
      result.contactsCreated++
      room.set(brand.id, (room.get(brand.id) ?? 1) - 1)

      if (dm && contact.linkedinUrl) {
        await prisma.target.create({
          data: {
            brandId: brand.id,
            contactId: contact.id,
            fitScore: scoreFit(contact.title, brand.tier),
            assignedTo: brand.owner ?? null,
          },
        })
        result.targetsCreated++
      }
    } catch (err: any) {
      result.failed++
      if (result.errors.length < 20) result.errors.push(`${row.brandName} / ${row.name}: ${err?.message ?? 'error'}`)
    }
  }

  // Apply the per-brand cap to every brand this batch touched.
  for (const brandId of touched) {
    try { result.targetsShelved += await reconcileBrandTargets(brandId) } catch { /* skip */ }
  }

  // Park the unmatched names and their people for the dashboard. A
  // failure here must not fail a capture that otherwise worked.
  if (missed.size) {
    try {
      let misses = await readMisses(prisma)
      for (const [name, held] of missed) misses = addMiss(misses, name, held.externalId, held.rows)
      await writeMisses(prisma, misses)
    } catch (err: any) {
      result.errors.push(`miss log: ${err?.message ?? 'unknown error'}`)
    }
  }

  // A single-brand capture (the sweep and "Capture this brand" both send
  // one brand per POST, named by its profile id) goes in the sweep log,
  // so the next worklist knows whether this brand is worth opening again.
  if (body.brandExternalId && touched.size === 1) {
    const [brandId] = touched
    try { await markSwept(prisma, brandId, rows.length, result.contactsCreated) } catch { /* non-fatal */ }
  }

  return NextResponse.json({ ok: true, ...result }, { headers: cors })
}
