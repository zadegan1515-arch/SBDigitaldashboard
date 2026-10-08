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

// Turned-away sign-ins (Oct 8 2026: Leo's sboyagency.com sign-in came back
// "doesn't have access" with nothing to say why). The last 20, so the Team
// page can show who tried — with the exact address Google gave, which for a
// Workspace alias is the account's main address — and a founding member can
// add them in one click. Best effort: it never decides a sign-in.
export const DENIED_KEY = 'signInDenied'
export type DeniedSignIn = { email: string; name: string | null; at: string }

export async function readDenied(): Promise<DeniedSignIn[]> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: DENIED_KEY } })
    const list = row ? JSON.parse(row.value) : []
    return Array.isArray(list) ? list.filter(x => x && typeof x.email === 'string') : []
  } catch {
    return []
  }
}

async function noteDenied(email: string, name?: string | null) {
  try {
    const list = (await readDenied()).filter(x => x.email !== email)
    const v = JSON.stringify([{ email, name: name ? String(name).slice(0, 120) : null, at: new Date().toISOString() }, ...list].slice(0, 20))
    await prisma.setting.upsert({ where: { key: DENIED_KEY }, create: { key: DENIED_KEY, value: v }, update: { value: v } })
  } catch { /* never in the way of the answer */ }
}

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
        return '/signin?error=Unavailable'
      }

      console.warn('[auth] denied sign-in for', email)
      await noteDenied(email, user.name)
      // The sign-in page names the address Google gave, so a person whose
      // Google account signs in under another address can see it.
      return '/signin?error=AccessDenied&email=' + encodeURIComponent(email)
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
