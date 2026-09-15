// /api/public/checkin — self check-in and staff door mode.
//
// POST {token}                          → self check-in from a ticket link
// POST {mode:"list", slug, pin}         → guest list for door.html
// POST {mode:"checkin", slug, pin, ids} → batch door check-in (offline
//                                         queue syncs through here)
//
// Staff auth is the event's PIN — door staff aren't on the Google
// allowlist. Wrong PIN answers are rate-limited harder than the rest.

import { NextResponse } from 'next/server'
import { selfCheckin, doorList, doorCheckin } from '@/lib/audience'

export const dynamic = 'force-dynamic'
export const maxDuration = 15

const hits = new Map<string, number[]>()
function limited(ip: string, max: number) {
  const now = Date.now()
  const arr = (hits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000)
  arr.push(now); hits.set(ip, arr)
  return arr.length > max
}

export async function POST(req: Request) {
  try {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown'
    const body = await req.json().catch(() => ({}))
    if (body.mode === 'list') {
      if (limited(ip, 60)) return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 })
      return NextResponse.json({ ok: true, ...(await doorList(body.slug, body.pin)) })
    }
    if (body.mode === 'checkin') {
      if (limited(ip, 300)) return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 })
      return NextResponse.json({ ok: true, ...(await doorCheckin(body.slug, body.pin, body.ids)) })
    }
    if (limited(ip, 60)) return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 })
    return NextResponse.json({ ok: true, ...(await selfCheckin(body.token)) })
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 400 })
  }
}
