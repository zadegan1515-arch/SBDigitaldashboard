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

import { NextRequest, NextResponse } from 'next/server'
import { PrismaClient } from '@prisma/client'
import { readMisses, writeMisses, addMiss, type HeldRow } from '@/lib/brand-match'
import {
  readSearch, writeSearch, readProposals, writeProposals, upsertProposal,
  readCaptureQueue, writeCaptureQueue, queueCapture, decideMatch,
  type SuCandidate,
} from '@/lib/su-match'

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
  const worked = await prisma.target.count({ where: { brandId, sentAt: { not: null } } })
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

    const { pick, reason } = decideMatch(brand.name, brand.aka, candidates)
    if (!pick) {
      // Nothing obvious — park it for Leo rather than guessing. A wrong
      // id quietly fills a brand with another company's people.
      const list = await readProposals(prisma)
      await writeProposals(prisma, upsertProposal(list, {
        brandId: brand.id, brandName: brand.name, candidates, at: Date.now(),
      }))
      return NextResponse.json({ ok: true, outcome: reason, candidates: candidates.length }, { headers: cors })
    }

    // externalId is unique — another brand may already hold this one.
    const taken = await prisma.brand.findFirst({ where: { externalId: pick.externalId }, select: { name: true } })
    if (taken) {
      return NextResponse.json({ ok: true, outcome: 'taken', by: taken.name }, { headers: cors })
    }
    await attachProfileId(brand.id, brand.name, brand.aka, pick)
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
    const brands = (scope === 'all'
      ? all
      : all.filter(x => x._count.contacts < CONTACT_CAP_PER_BRAND)
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
  const result = { contactsCreated: 0, targetsCreated: 0, targetsShelved: 0, skipped: 0, capped: 0, failed: 0, brandsMissing: [] as string[], errors: [] as string[] }
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

      // Brands must already exist — this endpoint does not invent brands,
      // so a typo can't silently create a junk brand. Matches the name
      // (case-insensitive, so "ESPN BET" matches "ESPN Bet"), then the
      // SponsorUnited profile ID, then any "also known as" name.
      const suId = row.brandExternalId ?? body.brandExternalId ?? null
      const brand = await findBrandForCapture(row.brandName, suId)
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

  return NextResponse.json({ ok: true, ...result }, { headers: cors })
}
