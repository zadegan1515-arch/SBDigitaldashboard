// The daily brand hunt's rules (Leo, Oct 2026: "a process for Claude to
// find new brands … it shouldn't necessarily be through LinkedIn").
// A scheduled Claude session searches the open web — launch and funding
// news, sponsorship announcements, retailer shelves, trend coverage — and
// posts what it finds to /api/discover-ingest. Every row waits on
// Brands → Discover for Leo to Add or Dismiss; nothing here makes a brand.
// Leo's picks: priority lanes only, 50 a day, and each brand shows which
// of his three signs it has (sponsors college / music, aims at 18–24s,
// mid-size and growing). No LinkedIn page needed: a website or the source
// it was found in is enough proof it's real.
// node scripts/test-claude-hunt.mjs

import { LANES, brandKey } from './stock'

export const HUNT_PER_DAY = 50
export const HUNT_PER_POST = 50
export const HUNT_LABEL = 'Claude hunt'   // query prefix: "Claude hunt · Oct 5"

export const HUNT_LANES: string[] = LANES.filter(l => l.priority).map(l => l.key)

export const HUNT_SIGNALS = {
  sponsors: 'Sponsors college / music',
  genz: 'Aims at 18–24',
  midsize: 'Mid-size, growing',
} as const
export type HuntSignal = keyof typeof HUNT_SIGNALS

export type HuntRow = {
  name: string
  category: string
  signals: HuntSignal[]
  reason: string | null
  activation: string | null
  website: string | null
  sourceUrl: string | null
  linkedinUrl: string | null
}

export type HuntVerdict = { ok: true; row: HuntRow } | { ok: false; name: string; why: string }

function url(v: unknown): string | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  const withScheme = /^https?:\/\//i.test(s) ? s : 'https://' + s
  try {
    const u = new URL(withScheme)
    if (!/\./.test(u.hostname)) return null
    return u.toString().slice(0, 300)
  } catch { return null }
}

function text(v: unknown, max: number): string | null {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, max) : null
}

// Names already on the roster (name or any also-known-as) or already
// found before (any status — a dismissed brand stays dismissed).
export function knownKeys(brands: { name: string; aka: string | null }[], found: { name: string }[]): Set<string> {
  const out = new Set<string>()
  for (const b of brands) {
    for (const n of [b.name, ...String(b.aka ?? '').split(/[,;]/)]) {
      const k = brandKey(n)
      if (k) out.add(k)
    }
  }
  for (const d of found) { const k = brandKey(d.name); if (k) out.add(k) }
  return out
}

// One posted row → a row to save, or why not. `known` grows as rows are
// accepted, so the same brand twice in one post saves once.
export function judgeHuntRow(r: any, known: Set<string>): HuntVerdict {
  const name = text(r?.name, 120)
  if (!name) return { ok: false, name: '(no name)', why: 'no name' }
  const key = brandKey(name)
  if (!key) return { ok: false, name, why: 'no name' }
  if (known.has(key)) return { ok: false, name, why: 'already known' }

  const category = String(r?.category ?? '').trim().toLowerCase()
  if (!HUNT_LANES.includes(category)) {
    return { ok: false, name, why: 'not a priority lane (' + (category || 'none') + ')' }
  }

  const signals = (Array.isArray(r?.signals) ? r.signals : [])
    .map((s: unknown) => String(s).trim().toLowerCase())
    .filter((s: string): s is HuntSignal => s in HUNT_SIGNALS)
  const uniq = [...new Set(signals)] as HuntSignal[]
  if (!uniq.length) return { ok: false, name, why: 'no signal (sponsors, genz or midsize)' }

  const website = url(r?.website)
  const sourceUrl = url(r?.sourceUrl ?? r?.source)
  // Real-world proof: its own website or where it was found. A guessed
  // LinkedIn link proves nothing, so it never counts on its own.
  if (!website && !sourceUrl) return { ok: false, name, why: 'no website or source link' }
  const li = url(r?.linkedinUrl)
  const linkedinUrl = li && /linkedin\.com\/company\//i.test(li) ? li : null

  known.add(key)
  return {
    ok: true,
    row: {
      name, category, signals: uniq,
      reason: text(r?.reason, 300),
      activation: text(r?.activation, 300),
      website, sourceUrl, linkedinUrl,
    },
  }
}

// "Claude hunt · Oct 5" in New York time.
export function huntLabel(now: Date = new Date()): string {
  const d = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })
  return HUNT_LABEL + ' · ' + d
}
