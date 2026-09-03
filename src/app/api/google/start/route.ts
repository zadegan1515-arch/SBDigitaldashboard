// GET /api/google/start — kicks off the send-only Gmail connect flow.
// Sign-in required: without this guard a stranger could point the app's
// sending at their own mailbox.
//
// ?debug=1 reports which credential the running build actually sees.
// It never returns a secret — only presence flags and the public,
// non-sensitive prefix of the client ID (which Google puts in the URL
// anyway). This exists because a stale deployment is invisible from the
// outside: the only way to know which build is live is to ask it.

import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { googleAuthUrl, googleConfigured } from '@/lib/google'

export const dynamic = 'force-dynamic'

// Bumped on every deploy that touches this file, so /api/google/start?debug=1
// tells us at a glance whether the build we think is live actually is.
const BUILD_MARKER = 'gmail-oauth-v4-drive'

export async function GET(req: Request) {
  const session: any = await getServerSession(authOptions)
  if (!session?.user?.email) {
    return NextResponse.json({ ok: false, error: 'Sign in first' }, { status: 401 })
  }

  if (new URL(req.url).searchParams.get('debug') === '1') {
    const id = process.env.GMAIL_CLIENT_ID || ''
    return NextResponse.json({
      build: BUILD_MARKER,
      reads: 'GMAIL_CLIENT_ID',
      gmailClientIdPresent: !!process.env.GMAIL_CLIENT_ID,
      gmailClientSecretPresent: !!process.env.GMAIL_CLIENT_SECRET,
      gmailClientIdPrefix: id ? id.slice(0, 14) : null,
      authUrlClientIdPrefix: new URL(googleAuthUrl()).searchParams
        .get('client_id')?.slice(0, 14) ?? null,
      redirectUri: new URL(googleAuthUrl()).searchParams.get('redirect_uri'),
    })
  }

  if (!googleConfigured()) {
    return NextResponse.json(
      { ok: false, error: 'Add GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in Vercel first.' },
      { status: 503 },
    )
  }
  // ?drive=1 starts the Drive grant (activation docs) instead of Gmail.
  const kind = new URL(req.url).searchParams.get('drive') === '1' ? 'drive' : 'gmail'
  return NextResponse.redirect(googleAuthUrl(kind))
}
