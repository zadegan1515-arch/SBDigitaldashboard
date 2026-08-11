// Google sign-in, restricted to an allowlist.
//
// Two layers:
//   1. ALLOWED_EMAILS in Vercel — the founding list (Leo, Zach,
//      Elizabeth). These people can also manage layer 2.
//   2. The AllowedEmail table — everyone added from the Team page in
//      the app. Granting access no longer needs a redeploy.
//
// Deliberately an allowlist rather than a domain check: sboyagency.com
// may have addresses that shouldn't see sponsor contact data, and a
// domain rule silently grants access to every future hire.

import GoogleProvider from 'next-auth/providers/google'
import type { NextAuthOptions } from 'next-auth'
import { PrismaClient } from '@prisma/client'

// Own client rather than importing from the API route — sign-in must
// not depend on request-handling code.
const prisma = new PrismaClient()

export function allowlist(): string[] {
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
      // should never be the thing that opens the door. The database
      // list is additive only; it cannot open this door by itself.
      if (list.length === 0) {
        console.warn('[auth] ALLOWED_EMAILS is empty — denying all sign-ins')
        return false
      }

      const email = user.email?.toLowerCase()
      if (!email) return false
      if (list.includes(email)) return true

      // Team-page invites.
      try {
        const invited = await prisma.allowedEmail.findUnique({ where: { email } })
        if (invited) return true
      } catch (err) {
        // A database hiccup should not silently admit anyone.
        console.error('[auth] AllowedEmail lookup failed', err)
        return false
      }

      console.warn('[auth] denied sign-in for', email)
      return false
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
