// Gate everything behind sign-in — including public/app.html.
//
// This is the fix for the hole sb-crm has: there, app.html is served
// straight off the CDN, so the UI shell and internal copy are readable
// by anyone who knows the URL. Middleware runs before static files are
// served, so matching app.html here closes that.

import { withAuth } from 'next-auth/middleware'

export default withAuth({
  pages: { signIn: '/signin' },
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
