// POST /api/public/request — a brand picked shows on /sponsor.html.
//
// Creates (or finds) the brand, one ShowSponsor row per picked show with
// status "requested", one pipeline deal summarising the request, and
// emails the team. Public, so: strict input checks, a honeypot field,
// a per-IP limit, and nothing is ever deleted or overwritten.

import { NextResponse } from 'next/server'
import { createSponsorRequest } from '@/lib/sponsor-request'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const hits = new Map<string, number[]>()
function limited(ip: string) {
  const now = Date.now()
  const arr = (hits.get(ip) || []).filter(t => now - t < 60 * 60 * 1000)
  arr.push(now); hits.set(ip, arr)
  return arr.length > 10
}

export async function POST(req: Request) {
  try {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown'
    if (limited(ip)) return NextResponse.json({ ok: false, error: 'Too many requests — try again in an hour.' }, { status: 429 })
    const body = await req.json().catch(() => ({}))
    if (body.website_url) return NextResponse.json({ ok: true, id: 'ok' })     // honeypot: bots fill it, people never see it
    const r = await createSponsorRequest({ ...body, ip })
    return NextResponse.json({ ok: true, ...r })
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 400 })
  }
}
