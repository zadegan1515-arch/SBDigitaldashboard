// src/app/api/discover-ingest/route.ts
//
// The delivery door for the daily brand hunt. A scheduled Claude session
// researches new/trending brands each morning (free — no API credits),
// verifies their LinkedIn company pages, and POSTs them here. Rows land
// on the Discover page under the hunt's query label, exactly like a
// search run from the page.
//
// Security mirrors /api/ingest: gated by the same INGEST_TOKEN shared
// secret; disabled entirely when the env var is missing. Write-only —
// it can only add DiscoveredBrand rows (never brands, contacts, or
// anything else) and reads nothing back beyond a save count.
//
// Novelty rule: this endpoint only accepts brands the system has NEVER
// seen — not in the Brand table, not in any previous discovery. That's
// what makes the daily feed "new brands", not reruns.

import { NextRequest, NextResponse } from 'next/server'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

export async function POST(req: NextRequest) {
  const configured = process.env.INGEST_TOKEN
  if (!configured) {
    return NextResponse.json({ ok: false, error: 'Ingest disabled — set INGEST_TOKEN in Vercel.' }, { status: 503 })
  }

  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ ok: false, error: 'Bad JSON' }, { status: 400 })
  }
  if (body?.token !== configured) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const query = String(body.query ?? '').trim().slice(0, 120)
  const rows: any[] = Array.isArray(body.rows) ? body.rows.slice(0, 30) : []
  if (!query || rows.length === 0) {
    return NextResponse.json({ ok: false, error: 'query and rows required' }, { status: 400 })
  }

  let saved = 0
  const skipped: string[] = []
  for (const r of rows) {
    const name = String(r?.name ?? '').trim().slice(0, 120)
    const linkedinUrl = String(r?.linkedinUrl ?? '').trim()
    // The house rule: no verified LinkedIn company page, no row.
    if (!name || !/linkedin\.com\/company\//i.test(linkedinUrl)) { if (name) skipped.push(name); continue }

    // Novelty check — already a brand, or already discovered under ANY
    // query? Then it isn't new; skip it.
    const asBrand = await prisma.brand.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } }, select: { id: true },
    })
    const asDiscovery = await (prisma as any).discoveredBrand.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } }, select: { id: true },
    })
    if (asBrand || asDiscovery) { skipped.push(name); continue }

    await (prisma as any).discoveredBrand.create({
      data: {
        query, name,
        category: r.category ? String(r.category).slice(0, 40) : null,
        reason: r.reason ? String(r.reason).slice(0, 300) : null,
        activation: r.activation ? String(r.activation).slice(0, 300) : null,
        website: r.website ? String(r.website).slice(0, 300) : null,
        linkedinUrl: linkedinUrl.slice(0, 300),
      },
    })
    saved++
  }

  return NextResponse.json({ ok: true, saved, skippedCount: skipped.length, skipped: skipped.slice(0, 20) })
}
