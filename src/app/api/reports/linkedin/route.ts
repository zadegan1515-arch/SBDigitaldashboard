// GET /api/reports/linkedin — the LinkedIn run reports, read-only.
//
// For Claude's morning check (Leo, Sep 2026: "check daily, fix and
// push"): the cloud session can't see Leo's browser, so it reads what
// the script reported instead. Bearer REPORT_TOKEN (Vercel env, 24+
// characters); no token set → closed. This route only ever reads: the
// run reports, the script version the dashboard expects, which brands
// the fill left a note on, and how many brands still have no marketing /
// partnerships person (counts only) — no contacts, no emails.

import '@/lib/bigint-json'
import { NextRequest, NextResponse } from 'next/server'
import { PrismaClient } from '@prisma/client'
import { timingSafeEqual } from 'crypto'
import { readRuns } from '@/lib/li-report'
import { readLiLog, readLiResearch, LI_SCRIPT_VERSION, LI_READER } from '@/lib/li-sweep'
import { readCoverCounts } from '@/lib/coverage-db'

export const dynamic = 'force-dynamic'

const prisma = new PrismaClient()

function allowed(req: NextRequest): boolean {
  const expected = process.env.REPORT_TOKEN || ''
  if (expected.length < 24) return false
  const given = Buffer.from(req.headers.get('authorization') || '')
  const want = Buffer.from(`Bearer ${expected}`)
  return given.length === want.length && timingSafeEqual(given, want)
}

export async function GET(req: NextRequest) {
  if (!allowed(req)) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const [runs, sweep, research, coverage] = await Promise.all([readRuns(prisma), readLiLog(prisma), readLiResearch(prisma), readCoverCounts(prisma)])
  const since = Date.now() - 14 * 864e5
  const noted = Object.entries(sweep).filter(([, m]) => m && m.note && Date.parse(m.at) >= since)
  const names = noted.length
    ? await prisma.brand.findMany({ where: { id: { in: noted.map(([id]) => id) } }, select: { id: true, name: true } })
    : []
  const nameOf = new Map(names.map(b => [b.id, b.name]))

  return NextResponse.json({
    ok: true,
    latest: LI_SCRIPT_VERSION,
    reader: LI_READER,
    runs,
    // The last two weeks of brands the fill couldn't do, and why.
    notes: noted
      .sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at))
      .slice(0, 100)
      .map(([id, m]) => ({ brand: nameOf.get(id) || id, at: m.at, note: m.note, v: m.v ?? null })),
    // Every brand a buyer (coverage.ts): brands in play, how many have a
    // marketing / partnerships person, and what stands in the way of the
    // rest — next in the fill, page to pick, read lately with nobody, no
    // LinkedIn page, full. Counts only.
    coverage,
    research: Object.entries(research)
      .filter(([, m]) => m && m.outcome === 'unclear' && Date.parse(m.at) >= since)
      .slice(0, 100)
      .map(([key, m]) => ({ key, at: m.at, note: m.note ?? null })),
  })
}
