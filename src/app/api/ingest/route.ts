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
const TARGET_CAP_PER_BRAND = 3
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

  const rows: any[] = Array.isArray(body.rows) ? body.rows : []
  const result = { contactsCreated: 0, targetsCreated: 0, targetsShelved: 0, skipped: 0, failed: 0, brandsMissing: [] as string[], errors: [] as string[] }
  const touched = new Set<string>()
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
