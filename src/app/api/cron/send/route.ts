// src/app/api/cron/send/route.ts
//
// The auto-send window. Fired by Vercel Cron Tue–Thu at 14:00 UTC
// (~9–10am ET, the best cold-email reply window). Sends ONLY emails
// Leo has explicitly approved ("Approve for 9am send") — plain drafts
// are never touched, so nothing goes out without a human deciding it
// should.
//
// Auth matches /api/cron/email: CRON_SECRET bearer when set, otherwise
// Vercel's cron user-agent.

import { NextRequest, NextResponse } from 'next/server'
import { sendScheduledEmails } from '@/lib/email'

export const maxDuration = 60

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  const auth = req.headers.get('authorization') ?? ''
  const ua = req.headers.get('user-agent') ?? ''
  const authorized = secret
    ? auth === `Bearer ${secret}`
    : /vercel-cron/i.test(ua)
  if (!authorized) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const r = await sendScheduledEmails()
    return NextResponse.json({ ok: true, ...r })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? 'cron failed' }, { status: 500 })
  }
}
