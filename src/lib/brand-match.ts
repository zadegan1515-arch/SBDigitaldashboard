// src/lib/brand-match.ts
//
// The "SponsorUnited calls this brand something else" problem.
//
// SponsorUnited lists plenty of brands under a different name than we do
// ("818 Tequila" for our "818 Spirits"). A capture for a name we don't
// recognise is skipped by /api/ingest — which used to mean the people
// were simply lost, and nobody could tell which of our brands the name
// was supposed to be.
//
// So every miss is written down here, together with the people that came
// with it. The Needs-contacts tab shows the list; attaching a miss to a
// brand adds the name to that brand's "also known as" and replays the
// held rows, so the contacts land without going back to SponsorUnited.
//
// Stored as JSON in Setting["brandMisses"] rather than a table: it's a
// short-lived worklist, capped, and additive schema changes to a real
// table aren't worth it for something that empties as Leo works it.

export const MISS_KEY = 'brandMisses'

// Caps, so a runaway capture script can't grow the row without bound.
const MAX_MISSES = 60
const MAX_ROWS_PER_MISS = 30

// A person held back with a miss — the same shape /api/ingest accepts.
export type HeldRow = {
  name: string
  title?: string | null
  email?: string | null
  phone?: string | null
  location?: string | null
  linkedinUrl?: string | null
}

export type BrandMiss = {
  // The name exactly as SponsorUnited spelled it — this is what gets
  // written into Brand.aka on attach, so it must stay verbatim.
  name: string
  externalId: string | null
  count: number
  firstAt: string
  lastAt: string
  rows: HeldRow[]
}

// Loose comparison key for suggesting which brand a miss might be.
// Deliberately NOT used for matching captures: matching stays exact so a
// capture can never land on the wrong brand unattended. This only ranks
// what to show Leo, who makes the call.
export function nameKey(s: string): string {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(inc|llc|ltd|co|corp|company|the|brands?|group|holdings?)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// How alike two brand names are, 0–1. Token overlap (Dice) with a bump
// for a shared first word — "818 Tequila" vs "818 Spirits" shares the
// token that actually identifies the brand.
export function similarity(a: string, b: string): number {
  const ta = nameKey(a).split(' ').filter(Boolean)
  const tb = nameKey(b).split(' ').filter(Boolean)
  if (!ta.length || !tb.length) return 0
  if (ta.join(' ') === tb.join(' ')) return 1
  const setB = new Set(tb)
  const shared = ta.filter(t => setB.has(t)).length
  let score = (2 * shared) / (ta.length + tb.length)
  if (ta[0] === tb[0]) score += 0.25
  return Math.min(1, score)
}

// The brands a miss most likely belongs to, best first. Anything below
// the floor is left out — a bad suggestion is worse than none, because
// attaching writes an aka that then silently steers future captures.
export function suggestBrands(
  missName: string,
  brands: Array<{ id: string; name: string; aka: string | null }>,
  take = 3,
): Array<{ id: string; name: string; score: number }> {
  return brands
    .map(b => {
      const names = [b.name, ...(b.aka ?? '').split(/[,;]/)].map(s => s.trim()).filter(Boolean)
      return { id: b.id, name: b.name, score: Math.max(...names.map(n => similarity(missName, n))) }
    })
    .filter(s => s.score >= 0.34)
    .sort((x, y) => y.score - x.score)
    .slice(0, take)
}

type SettingStore = {
  setting: {
    findUnique(args: any): Promise<{ value: string } | null>
    upsert(args: any): Promise<any>
  }
}

export async function readMisses(db: SettingStore): Promise<BrandMiss[]> {
  try {
    const row = await db.setting.findUnique({ where: { key: MISS_KEY } })
    const parsed = row ? JSON.parse(row.value) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    // A corrupt value must not break a capture — start the list over.
    return []
  }
}

export async function writeMisses(db: SettingStore, misses: BrandMiss[]) {
  const value = JSON.stringify(misses.slice(0, MAX_MISSES))
  await db.setting.upsert({
    where: { key: MISS_KEY },
    create: { key: MISS_KEY, value },
    update: { value },
  })
}

// Record one unmatched capture. Same SponsorUnited name seen twice folds
// into one entry; its people accumulate, deduped by person name so a
// re-capture of the same page doesn't stack duplicates.
export function addMiss(
  misses: BrandMiss[],
  name: string,
  externalId: string | null,
  rows: HeldRow[],
): BrandMiss[] {
  const clean = String(name).trim().slice(0, 120)
  if (!clean) return misses
  const now = new Date().toISOString()
  const at = misses.findIndex(m => m.name.toLowerCase() === clean.toLowerCase())
  const existing = at >= 0 ? misses[at] : null
  const held = existing ? existing.rows.slice() : []
  for (const r of rows) {
    if (!r || !r.name) continue
    if (held.some(h => h.name.toLowerCase() === String(r.name).toLowerCase())) continue
    if (held.length >= MAX_ROWS_PER_MISS) break
    held.push({
      name: String(r.name).slice(0, 160),
      title: r.title ?? null,
      email: r.email ?? null,
      phone: r.phone ?? null,
      location: r.location ?? null,
      linkedinUrl: r.linkedinUrl ?? null,
    })
  }
  const entry: BrandMiss = {
    name: existing ? existing.name : clean,
    externalId: externalId || existing?.externalId || null,
    count: (existing?.count ?? 0) + rows.length,
    firstAt: existing?.firstAt ?? now,
    lastAt: now,
    rows: held,
  }
  const rest = misses.filter((_, i) => i !== at)
  return [entry, ...rest]
}

// Append a SponsorUnited name to a brand's comma-separated "also known
// as", leaving what's already there alone. Case-insensitive dedupe, and
// never adds the brand's own name.
export function addAka(current: string | null, name: string, brandName: string): string {
  const add = String(name).trim()
  const have = (current ?? '').split(/[,;]/).map(s => s.trim()).filter(Boolean)
  const taken = new Set([...have, brandName].map(s => s.toLowerCase()))
  if (!add || taken.has(add.toLowerCase())) return have.join(', ')
  return [...have, add].join(', ')
}
