// src/app/api/discover-ingest/route.ts
//
// The delivery door for the daily brand hunt (Leo, Oct 2026: "a process
// for Claude to find new brands … it shouldn't necessarily be through
// LinkedIn"). A scheduled Claude session searches the open web each
// morning (free — no API credits) and POSTs what it found here. Rows land
// on Brands → Discover under "Claude hunt · <date>" for Leo to Add or
// Dismiss — this door can only add DiscoveredBrand rows, never brands,
// contacts or anything else. Rules in src/lib/claude-hunt.ts: priority
// lanes only, a website or source link (no LinkedIn page needed), at
// least one of Leo's signs, never a brand already known, 50 a day.
//
// Auth: Bearer REPORT_TOKEN (the Claude cloud environment's token, 24+
// characters). The old body `token` = INGEST_TOKEN still works so an
// older routine prompt doesn't fail. No token configured → closed.
//
// GET (same auth) = what the hunt needs before it searches: the lanes,
// how many it may still add today, and every name already known (brand
// names, also-known-as, earlier finds) so it doesn't research repeats.
// Brand names only — no contacts, no notes.

import { NextRequest, NextResponse } from 'next/server'
import { PrismaClient } from '@prisma/client'
import { timingSafeEqual } from 'crypto'
import { HUNT_LANES, HUNT_PER_DAY, HUNT_PER_POST, HUNT_SIGNALS, HUNT_LABEL, huntLabel, judgeHuntRow, knownKeys, type HuntRow } from '@/lib/claude-hunt'

export const dynamic = 'force-dynamic'

const prisma = new PrismaClient()

function same(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function allowed(req: NextRequest, bodyToken?: unknown): boolean {
  const report = process.env.REPORT_TOKEN || ''
  if (report.length >= 24 && same(req.headers.get('authorization') || '', `Bearer ${report}`)) return true
  const ingest = process.env.INGEST_TOKEN || ''
  return !!ingest && typeof bodyToken === 'string' && same(bodyToken, ingest)
}

async function usedToday(): Promise<number> {
  return (prisma as any).discoveredBrand.count({
    where: {
      createdAt: { gte: new Date(Date.now() - 864e5) },
      OR: [{ query: { startsWith: HUNT_LABEL } }, { query: { startsWith: '🔥' } }],
    },
  })
}

async function known() {
  const [brands, found] = await Promise.all([
    prisma.brand.findMany({ select: { name: true, aka: true } }),
    (prisma as any).discoveredBrand.findMany({ select: { name: true } }) as Promise<{ name: string }[]>,
  ])
  return { brands, found }
}

export async function GET(req: NextRequest) {
  if (!allowed(req)) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  const [used, k] = await Promise.all([usedToday(), known()])
  const names = new Set<string>()
  for (const b of k.brands) {
    names.add(b.name)
    for (const a of String(b.aka ?? '').split(/[,;]/)) if (a.trim()) names.add(a.trim())
  }
  for (const d of k.found) names.add(d.name)
  return NextResponse.json({
    ok: true,
    lanes: HUNT_LANES,
    signals: HUNT_SIGNALS,
    perDay: HUNT_PER_DAY,
    leftToday: Math.max(0, HUNT_PER_DAY - used),
    label: huntLabel(),
    known: [...names].sort((a, b) => a.localeCompare(b)),
  })
}

export async function POST(req: NextRequest) {
  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ ok: false, error: 'Bad JSON' }, { status: 400 })
  }
  if (!process.env.REPORT_TOKEN && !process.env.INGEST_TOKEN) {
    return NextResponse.json({ ok: false, error: 'Closed — set REPORT_TOKEN in Vercel.' }, { status: 503 })
  }
  if (!allowed(req, body?.token)) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const rows: any[] = Array.isArray(body?.rows) ? body.rows.slice(0, HUNT_PER_POST) : []
  if (!rows.length) return NextResponse.json({ ok: false, error: 'rows required' }, { status: 400 })

  const query = huntLabel()
  let left = Math.max(0, HUNT_PER_DAY - await usedToday())
  const k = await known()
  const keys = knownKeys(k.brands, k.found)

  const saved: string[] = []
  const skipped: { name: string; why: string }[] = []
  for (const r of rows) {
    const verdict = judgeHuntRow(r, keys)
    if (!verdict.ok) { const no = verdict as { name: string; why: string }; skipped.push({ name: no.name, why: no.why }); continue }
    const v = verdict as { ok: true; row: HuntRow }
    if (left <= 0) { skipped.push({ name: v.row.name, why: 'daily limit of ' + HUNT_PER_DAY + ' reached' }); continue }
    try {
      await (prisma as any).discoveredBrand.create({
        data: {
          query, name: v.row.name, category: v.row.category,
          reason: v.row.reason, activation: v.row.activation,
          website: v.row.website, linkedinUrl: v.row.linkedinUrl,
          sourceUrl: v.row.sourceUrl, signals: v.row.signals.join(','),
        },
      })
      saved.push(v.row.name)
      left -= 1
    } catch (err: any) {
      // Same name under today's label already (a second run): not new.
      if (err?.code === 'P2002') { skipped.push({ name: v.row.name, why: 'already known' }); continue }
      // Anything else: say what failed (never a bare 500) and stop — the
      // same error would hit every row after it.
      const msg = String(err?.message || err).split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300)
      console.error('discover-ingest save failed', err?.code, msg)
      return NextResponse.json({
        ok: false, error: 'Save failed' + (err?.code ? ' (' + err.code + ')' : '') + ': ' + msg,
        label: query, saved: saved.length, savedNames: saved, leftToday: left, skipped,
      }, { status: 500 })
    }
  }

  return NextResponse.json({ ok: true, label: query, saved: saved.length, savedNames: saved, leftToday: left, skipped })
}
