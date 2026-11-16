// src/app/api/instantly/webhook/route.ts
//
// Where Instantly tells the dashboard what it did, as it happens: an email
// sent, a reply, a bounce, an unsubscribe (src/lib/instantly.ts). No
// sign-in — Instantly calls it — so every delivery must carry the secret
// the dashboard made when live updates were turned on (Outreach → Email →
// Instantly). It rides in the `x-sb-hook` header; a request without it, or
// before live updates were ever turned on, changes nothing.
//
// Answers 200 to anything properly signed, applied or not: Instantly turns a
// webhook off after failed deliveries, and the daily sync is the net under
// this for anything missed.

import '@/lib/bigint-json'
import { createHash, timingSafeEqual } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { PrismaClient } from '@prisma/client'
import { HOOK_HEADER, readEvent } from '@/lib/instantly'
import { applyEvent, hookInfo } from '@/lib/instantly-db'

const prisma = new PrismaClient()
export const maxDuration = 30

const same = (a: string, b: string) => {
  const ha = createHash('sha256').update(a).digest(), hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

export async function POST(req: NextRequest) {
  const given = req.headers.get(HOOK_HEADER) ?? ''
  const hook = await hookInfo(prisma).catch(() => null)
  if (!hook?.secret || !given || !same(given, hook.secret)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  let body: unknown = null
  try { body = await req.json() } catch { body = null }
  const ev = readEvent(body)
  if (!ev) return NextResponse.json({ ok: true, applied: null })
  try {
    const r = await applyEvent(prisma, ev)
    return NextResponse.json({ ok: true, applied: r.what })
  } catch (err: any) {
    // Kept quiet for Instantly; the sync reads the same thing again later.
    console.error('instantly webhook:', ev.type, String(err?.message ?? err).slice(0, 200))
    return NextResponse.json({ ok: true, applied: null, later: true })
  }
}
