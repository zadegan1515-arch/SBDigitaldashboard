// Gate everything behind sign-in — including public/app.html.
//
// This is the fix for the hole sb-crm has: there, app.html is served
// straight off the CDN, so the UI shell and internal copy are readable
// by anyone who knows the URL. Middleware runs before static files are
// served, so matching app.html here closes that.
//
// One exception: /api/data also accepts `Authorization: Bearer
// <DASHBOARD_TOKEN>` so Claude Code / scripts on Leo's Mac can call the
// same functions the UI uses (warmup status, ops scan, test sends…)
// without a browser session. No token set in Vercel → no bearer access.

import { withAuth } from 'next-auth/middleware'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// The brand hostname (partnerships.sboyagency.com) only ever serves the
// sponsor page and what it needs. Anything else on that host goes to the page.
const SPONSOR_HOST = (process.env.SPONSOR_HOST || 'partnerships.sboyagency.com').toLowerCase()
const SPONSOR_OK = /^\/(sponsor\.html|partnerships$|api\/public\/|materials\/)/

const auth = withAuth({
  pages: { signIn: '/signin' },
  callbacks: {
    authorized: ({ req, token }) => {
      if (token) return true
      if (req.nextUrl.pathname !== '/api/data') return false
      const expected = process.env.DASHBOARD_TOKEN
      const given = req.headers.get('authorization') ?? ''
      return !!expected && expected.length >= 24 && given === `Bearer ${expected}`
    },
  },
})

export default function middleware(req: NextRequest, ev: any) {
  const host = (req.headers.get('host') || '').toLowerCase().split(':')[0]
  if (host === SPONSOR_HOST) {
    if (SPONSOR_OK.test(req.nextUrl.pathname) || req.nextUrl.pathname === '/') return NextResponse.next()
    return NextResponse.redirect(new URL('/', req.url))
  }
  // Normal host: only the paths that were always gated go through
  // next-auth; everything else (public page, OAuth callbacks, crons,
  // static assets) passes as before.
  const p = req.nextUrl.pathname
  const gated = p === '/app.html' || p === '/api/data' || p === '/' || p.startsWith('/data/')
  return gated ? (auth as any)(req, ev) : NextResponse.next()
}

export const config = {
  matcher: [
    // The UI itself
    '/app.html',
    // The only data endpoint
    '/api/data',
    // Seed data — contains the full brand list
    '/data/:path*',
    // Root, which redirects into the app
    '/',
    // Everything the brand host must never serve
    '/((?!_next/|favicon\\.ico).*)',
  ],
}
