// GET /api/google/callback — Google sends the user back here with a code.
// We trade it for a refresh token (stored server-side only) and bounce
// them to the Outreach page with a friendly result.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { googleExchangeCode, driveExchangeCode, opsExchangeCode } from '@/lib/google'

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

  const state = url.searchParams.get('state')
  const kind = state === 'drive' ? 'drive' : state === 'ops' ? 'ops' : 'gmail'
  try {
    if (kind === 'ops') {
      const { address } = await opsExchangeCode(code)
      return NextResponse.redirect(new URL('/app.html?ops=connected&as=' + encodeURIComponent(address || '') + '#operations', url.origin))
    }
    if (kind === 'drive') {
      const { address } = await driveExchangeCode(code)
      return NextResponse.redirect(new URL('/app.html?drive=connected&as=' + encodeURIComponent(address || '') + '#activations', url.origin))
    }
    const { address } = await googleExchangeCode(code)
    return NextResponse.redirect(new URL('/app.html?google=connected&as=' + encodeURIComponent(address || ''), url.origin))
  } catch (e: any) {
    const key = kind === 'drive' ? 'drive' : kind === 'ops' ? 'ops' : 'google'
    const hash = kind === 'drive' ? '#activations' : kind === 'ops' ? '#operations' : ''
    return NextResponse.redirect(new URL(`/app.html?${key}=` + encodeURIComponent(String(e?.message ?? 'failed').slice(0, 120)) + hash, url.origin))
  }
}
