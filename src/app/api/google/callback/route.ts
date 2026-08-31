// GET /api/google/callback — Google sends the user back here with a code.
// We trade it for a refresh token (stored server-side only) and bounce
// them to the Outreach page with a friendly result.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { googleExchangeCode } from '@/lib/google'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const session: any = await getServerSession(authOptions)
  if (!session?.user?.email) {
    return NextResponse.json({ ok: false, error: 'Sign in first' }, { status: 401 })
  }

  const url = req.nextUrl
  const err = url.searchParams.get('error')
  if (err) {
    return NextResponse.redirect(new URL('/app.html?google=' + encodeURIComponent(err), url.origin))
  }
  const code = url.searchParams.get('code')
  if (!code) {
    return NextResponse.redirect(new URL('/app.html?google=missing_code', url.origin))
  }

  try {
    const { address } = await googleExchangeCode(code)
    return NextResponse.redirect(new URL('/app.html?google=connected&as=' + encodeURIComponent(address || ''), url.origin))
  } catch (e: any) {
    return NextResponse.redirect(new URL('/app.html?google=' + encodeURIComponent(String(e?.message ?? 'failed').slice(0, 120)), url.origin))
  }
}
