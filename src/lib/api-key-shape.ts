// src/lib/api-key-shape.ts
//
// What a key made on Operations → Team looks like. No imports: middleware
// (the Edge runtime, no database, no node:crypto) reads this to let a
// key-shaped request through to /api/data, which then checks it against the
// stored list (src/lib/api-keys.ts). The shape alone opens nothing.

export const KEY_PREFIX = 'sbk_'
// sbk_ + 32 random bytes, base64url (43 characters).
export const KEY_SHAPE = /^sbk_[A-Za-z0-9_-]{43}$/

export const isKeyShaped = (s: unknown): boolean => typeof s === 'string' && KEY_SHAPE.test(s)

// The dashboard token (Claude's own sessions) may also arrive in a header of
// its own (Leo, Nov 16 2026: "can u set it up so i only have to paste the
// key"). A Claude cloud environment's saved key is added by its proxy to every
// request for this host; saved under Authorization it would replace the
// REPORT_TOKEN bearer the daily brand hunt and the LinkedIn run check send to
// the same host. Under this header it rides beside whatever Authorization
// says. The same token, the same 24-character floor.
export const DASH_HEADER = 'x-dashboard-token'
export function dashTokenOk(given: string | null | undefined, expected: string | null | undefined): boolean {
  const want = String(expected ?? '')
  if (want.length < 24) return false
  return String(given ?? '').trim().replace(/^Bearer\s+/i, '') === want
}

// "Bearer <token>" → the token, else ''.
export function bearerOf(header: string | null | undefined): string {
  const m = /^Bearer\s+(\S+)$/.exec(String(header ?? ''))
  return m ? m[1] : ''
}
