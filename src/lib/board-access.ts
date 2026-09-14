// Access codes for the public Show Board.
//
// The whole board is gated: every brand Leo invites gets its own code,
// generated on the brand page. SPONSOR_MASTER_CODE (env, optional) is a
// team code that always works and belongs to no brand.

import { PrismaClient, type Brand } from '@prisma/client'

const prisma = new PrismaClient()

// No 0/O/1/I/L — codes get read out loud on calls.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function newBoardCode() {
  let s = ''
  for (let i = 0; i < 8; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  return s.slice(0, 4) + '-' + s.slice(4)
}

export function normalizeCode(code: unknown) {
  return String(code ?? '').trim().toUpperCase()
}

// null = not a valid code. Otherwise who it belongs to (brand: null for
// the master code).
export async function brandForCode(code: unknown): Promise<{ brand: Brand | null } | null> {
  const c = normalizeCode(code)
  if (!c) return null
  const master = normalizeCode(process.env.SPONSOR_MASTER_CODE)
  if (master && c === master) return { brand: null }
  const brand = await prisma.brand.findFirst({ where: { boardCode: c } })
  return brand ? { brand } : null
}
