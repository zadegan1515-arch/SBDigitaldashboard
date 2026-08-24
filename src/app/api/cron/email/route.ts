// src/app/api/cron/email/route.ts
//
// Fired by Vercel Cron every morning (see vercel.json): drafts the day's
// email batch so it's waiting for approval, and sweeps the inbox for
// replies. Deliberately does NOT send anything — sending stays behind the
// human "Send all" button.
//
// Auth: when CRON_SECRET is set in Vercel, callers must present it as a
// bearer token (Vercel Cron does this automatically). Without the secret,
// only requests bearing Vercel's cron user-agent are accepted.

import { NextRequest, NextResponse } from 'next/server'
import { draftDailyEmails, checkReplies } from '@/lib/email'

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
    // Draft in bounded chunks; ~12 keeps us inside the function time limit.
    let drafted = 0
    for (let i = 0; i < 3; i++) {
      const r = await draftDailyEmails(4)
      drafted += r.drafted
      if (r.done || !r.configured) break
    }
    const replies = await checkReplies()
    return NextResponse.json({ ok: true, drafted, replies })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? 'cron failed' }, { status: 500 })
  }
}
