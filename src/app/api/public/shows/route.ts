// GET /api/public/shows — the brand-facing show list. No sign-in: this is
// what /sponsor.html reads. Only the fields a brand may see leave here
// (see publicShow in lib/shows.ts): no reps, no statuses, no money.

import { NextResponse } from 'next/server'
import { allShows, publicShow } from '@/lib/shows'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET() {
  try {
    const r = await allShows()
    const shows = r.shows.map(publicShow)
    return NextResponse.json(
      { ok: true, updatedAt: r.at, upcoming: r.upcoming, past: r.past, shows },
      { headers: { 'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=3600' } },
    )
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 })
  }
}
