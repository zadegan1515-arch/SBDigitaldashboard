// POST /api/public/ping — the Show Board's once-a-minute heartbeat while
// a gated visit's tab stays open. Bumps BoardVisit.lastSeenAt so the
// In-talks cards can show how long a brand looked. The visit id is an
// unguessable cuid returned by /api/public/shows; nothing is readable
// from here and stale ids are ignored.

import { NextResponse } from 'next/server'
import { touchBoardVisit } from '@/lib/board-access'

export const dynamic = 'force-dynamic'
export const maxDuration = 10

export async function POST(req: Request) {
  try {
    const body = await req.text()
    let visitId = ''
    try { visitId = JSON.parse(body || '{}').visitId || '' } catch { /* sendBeacon may ship odd content types */ }
    if (visitId) await touchBoardVisit(visitId)
  } catch { /* always 200 — a heartbeat can't be worth an error */ }
  return NextResponse.json({ ok: true })
}
