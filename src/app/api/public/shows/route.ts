// GET /api/public/shows — the brand-facing show list. No sign-in, but the
// whole board is gated: a valid per-brand access code (?code=, generated
// on the brand page) or SPONSOR_MASTER_CODE is required. Only the fields
// a brand may see leave here (see publicShow in lib/shows.ts): no reps,
// no statuses, no money.

import { NextResponse } from 'next/server'
import { allShows, publicShow } from '@/lib/shows'
import { brandForCode, gateEnabled, logBoardVisit } from '@/lib/board-access'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams
    const code = params.get('code')
    const who = await brandForCode(code)
    if (!who) return NextResponse.json({ ok: false, error: 'code' }, { status: 401 })
    // With the gate on, a work email is required too, and every open is
    // logged (who's viewing = that email + the code's brand).
    let visitId: string | null = null
    if (gateEnabled()) {
      const email = String(params.get('email') || '').trim()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return NextResponse.json({ ok: false, error: 'email' }, { status: 401 })
      const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || null
      visitId = await logBoardVisit({ brandId: who.brand?.id, email, code, ip })
    }
    const r = await allShows()
    const shows = r.shows.map(publicShow)
    return NextResponse.json(
      { ok: true, updatedAt: r.at, upcoming: r.upcoming, past: r.past, shows, brandName: who.brand?.name || null, visitId },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 })
  }
}
