// A person's own Show Board link (Leo, Nov 16 2026: "on each email for each
// brand … attach the scoreboard with the brand's own personal link. That way
// we can see if they go and look"; his pick: which person, not only which
// brand).
//
//   https://shows.sboyagency.com/?code=ABCD-EFGH&p=K7Q2MX
//
// `code` is the brand's board code (Brand.boardCode — what makes a visit the
// brand's). `p` is a short key worked out from the person's id: nothing is
// stored for it. The board finds the person by trying the brand's people (25
// at most) and logs the visit with their email, which is how the dashboard
// knows who opened it. A link passed on to a colleague still reads as the
// person it was sent to — a personal link can't know better.
//
// Pure. node scripts/test-cold-templates.mjs

import { createHash } from 'crypto'

// No 0/O/1/I/L, as in board codes (board-access.ts).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const PERSON_KEY_LEN = 6

export function personKey(contactId: unknown): string {
  const id = String(contactId ?? '')
  if (!id) return ''
  const h = createHash('sha256').update('sb-board-person:' + id).digest()
  let s = ''
  for (let i = 0; i < PERSON_KEY_LEN; i++) s += ALPHABET[h[i] % ALPHABET.length]
  return s
}
export const cleanPersonKey = (v: unknown) => String(v ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12)

// The brand's board address, the brand's code and the person's key.
export function personBoardLink(base: string, code: string, contactId: string): string {
  const b = String(base || '').trim()
  return b + (b.includes('?') ? '&' : '?') + 'code=' + encodeURIComponent(code) + '&p=' + personKey(contactId)
}
// Which of a brand's people a key belongs to, or null.
export function personOfKey<T extends { id: string }>(people: T[], key: unknown): T | null {
  const k = cleanPersonKey(key)
  if (k.length !== PERSON_KEY_LEN) return null
  return people.find(p => personKey(p.id) === k) ?? null
}
