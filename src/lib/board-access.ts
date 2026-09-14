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

// The gate is off unless Leo sets SPONSOR_GATE=1 in Vercel. With it off
// the board is open to anyone with the link; a valid brand code in the
// link still attributes requests to that brand.
export function gateEnabled() {
  return process.env.SPONSOR_GATE === '1'
}

// null = no access. Otherwise who it is (brand: null for the master code
// or, with the gate off, an anonymous visitor).
export async function brandForCode(code: unknown): Promise<{ brand: Brand | null } | null> {
  const c = normalizeCode(code)
  if (c) {
    const master = normalizeCode(process.env.SPONSOR_MASTER_CODE)
    if (master && c === master) return { brand: null }
    const brand = await prisma.brand.findFirst({ where: { boardCode: c } })
    if (brand) return { brand }
  }
  return gateEnabled() ? null : { brand: null }
}

// Log a board open. One row per (brand/email/ip) per half hour, so a
// brand clicking around doesn't flood the feed. Never throws — a logging
// failure must not take the board down.
export async function logBoardVisit(v: { brandId?: string | null; email?: string | null; code?: string | null; ip?: string | null }) {
  try {
    const email = String(v.email || '').trim().toLowerCase().slice(0, 200) || null
    const since = new Date(Date.now() - 30 * 60 * 1000)
    const dupe = await prisma.boardVisit.findFirst({
      where: { brandId: v.brandId || null, email, ip: v.ip || null, createdAt: { gt: since } },
      select: { id: true },
    })
    if (dupe) return
    await prisma.boardVisit.create({
      data: { brandId: v.brandId || null, email, code: normalizeCode(v.code) || null, ip: v.ip || null },
    })
  } catch { /* never block the board on logging */ }
}
