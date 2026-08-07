// Google sign-in, restricted to an allowlist.
//
// ALLOWED_EMAILS is a comma-separated env var, e.g.
//   leo@sboyagency.com,zach@sboyagency.com
//
// Deliberately an allowlist rather than a domain check: sboyagency.com
// may have addresses that shouldn't see sponsor contact data, and a
// domain rule silently grants access to every future hire.

import GoogleProvider from 'next-auth/providers/google'
import type { NextAuthOptions } from 'next-auth'

function allowlist(): string[] {
  return (process.env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean)
}

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    }),
  ],

  callbacks: {
    async signIn({ user }) {
      const list = allowlist()

      // Fail closed. An empty or missing ALLOWED_EMAILS locks everyone
      // out rather than letting everyone in — a misconfigured env var
      // should never be the thing that opens the door.
      if (list.length === 0) {
        console.warn('[auth] ALLOWED_EMAILS is empty — denying all sign-ins')
        return false
      }

      const email = user.email?.toLowerCase()
      if (!email || !list.includes(email)) {
        console.warn('[auth] denied sign-in for', email)
        return false
      }
      return true
    },

    async session({ session }) {
      return session
    },
  },

  pages: {
    signIn: '/signin',
    error: '/signin',
  },

  session: { strategy: 'jwt' },
}
