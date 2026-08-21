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

  for (const row of rows) {
    try {
      if (!row.brandName || !row.name) { result.skipped++; continue }

      // Brands must already exist — this endpoint does not invent brands,
      // so a typo can't silently create a junk brand.
      const brand = await prisma.brand.findUnique({ where: { name: row.brandName } })
      if (!brand) {
        if (!result.brandsMissing.includes(row.brandName)) result.brandsMissing.push(row.brandName)
        result.skipped++
        continue
      }
      touched.add(brand.id)

      const dupe = await prisma.contact.findFirst({ where: { brandId: brand.id, name: row.name } })
      if (dupe) { result.skipped++; continue }

      const dm = looksLikeDecisionMaker(row.title ?? null)
      const contact = await prisma.contact.create({
        data: {
          brandId: brand.id,
          name: row.name,
          title: row.title ?? null,
          email: row.email ?? null,
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

  return NextResponse.json({ ok: true, ...result }, { headers: cors })
}
