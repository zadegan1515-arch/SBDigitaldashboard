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

export default withAuth({
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
  ],
}
