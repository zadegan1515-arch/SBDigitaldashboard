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

// "Bearer <token>" → the token, else ''.
export function bearerOf(header: string | null | undefined): string {
  const m = /^Bearer\s+(\S+)$/.exec(String(header ?? ''))
  return m ? m[1] : ''
}
