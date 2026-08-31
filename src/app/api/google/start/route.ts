// GET /api/google/start — kicks off the send-only Gmail connect flow.
// Sign-in required: without this guard a stranger could point the app's
// sending at their own mailbox.

import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { googleAuthUrl, googleConfigured } from '@/lib/google'

export const dynamic = 'force-dynamic'

export async function GET() {
  const session: any = await getServerSession(authOptions)
  if (!session?.user?.email) {
    return NextResponse.json({ ok: false, error: 'Sign in first' }, { status: 401 })
  }
  if (!googleConfigured()) {
    return NextResponse.json(
      { ok: false, error: 'Add GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in Vercel first.' },
      { status: 503 },
    )
  }
  return NextResponse.redirect(googleAuthUrl())
}
