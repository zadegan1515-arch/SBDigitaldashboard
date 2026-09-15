// /api/public/rsvp — the public RSVP page's only endpoint.
//
// GET  ?e=<slug>            → brand-safe event info + the consent text
// GET  ?t=<token>           → the caller's own ticket (token = proof)
// POST {slug, email, name…} → create the RSVP, return the ticket token
//
// Public, so: strict input checks (in lib/audience), a honeypot field,
// and a per-IP limit. Responses never contain another person's data.

import { NextResponse } from 'next/server'
import { publicEvent, createRsvp, ticketByToken } from '@/lib/audience'

export const dynamic = 'force-dynamic'
export const maxDuration = 15

const hits = new Map<string, number[]>()
function limited(ip: string) {
  const now = Date.now()
  const arr = (hits.get(ip) || []).filter(t => now - t < 60 * 60 * 1000)
  arr.push(now); hits.set(ip, arr)
  return arr.length > 30
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const token = url.searchParams.get('t')
    if (token) {
      const ticket = await ticketByToken(token)
      if (!ticket) return NextResponse.json({ ok: false, error: 'Ticket not found' }, { status: 404 })
      return NextResponse.json({ ok: true, ticket })
    }
    const ev = await publicEvent(url.searchParams.get('e') || '')
    if (!ev) return NextResponse.json({ ok: false, error: 'Event not found' }, { status: 404 })
    return NextResponse.json({ ok: true, event: ev })
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 400 })
  }
}

export async function POST(req: Request) {
  try {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown'
    if (limited(ip)) return NextResponse.json({ ok: false, error: 'Too many requests — try again in an hour.' }, { status: 429 })
    const body = await req.json().catch(() => ({}))
    if (body.website_url) return NextResponse.json({ ok: true, token: 'ok' })   // honeypot: bots fill it, people never see it
    const r = await createRsvp(body)
    return NextResponse.json({ ok: true, ...r })
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 400 })
  }
}
