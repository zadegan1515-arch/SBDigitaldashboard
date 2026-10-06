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
import { LI_REVIEW_KEY, type Review } from '@/lib/li-review'

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

  const [runs, sweep, research, coverage, reviewRow] = await Promise.all([
    readRuns(prisma), readLiLog(prisma), readLiResearch(prisma), readCoverCounts(prisma),
    prisma.setting.findUnique({ where: { key: LI_REVIEW_KEY } }),
  ])
  const since = Date.now() - 14 * 864e5
  const noted = Object.entries(sweep).filter(([, m]) => m && m.note && Date.parse(m.at) >= since)
  // "Which LinkedIn page is theirs?": the brands the search couldn't place
  // and the public company results it saw — so the morning check can tell
  // a brand with no clear page from a matching rule that's off.
  let review: Review = {}
  try { review = reviewRow ? JSON.parse(reviewRow.value) : {} } catch { review = {} }
  const reviewed = Object.entries(review).filter(([, e]) => e && Date.parse(e.at) >= since)
  const ids = Array.from(new Set([...noted.map(([id]) => id), ...reviewed.map(([id]) => id)]))
  const names = ids.length
    ? await prisma.brand.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, category: true } })
    : []
  const nameOf = new Map(names.map(b => [b.id, b.name]))
  const categoryOf = new Map(names.map(b => [b.id, b.category]))

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
    pageReview: reviewed
      .sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at))
      .slice(0, 60)
      .map(([id, e]) => ({
        brand: nameOf.get(id) || id, category: categoryOf.get(id) ?? null, at: e.at, why: e.why, pageIndustry: e.pageIndustry ?? null,
        results: (e.candidates || []).slice(0, 3).map(c => ({ name: c.name, subtitle: c.subtitle })),
      })),
    research: Object.entries(research)
      .filter(([, m]) => m && m.outcome === 'unclear' && Date.parse(m.at) >= since)
      .slice(0, 100)
      .map(([key, m]) => ({ key, at: m.at, note: m.note ?? null })),
  })
}
