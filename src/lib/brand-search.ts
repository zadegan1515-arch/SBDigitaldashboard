// The Schedule's "Find a brand" box (Leo, Oct 7 2026: "if I want to add a
// brand I should be able to search it up easily"). Pure ranking, no
// database: searchPlanBrands in src/app/api/data/route.ts reads every
// brand's name and also-known-as once and asks this how well each one
// matches what was typed. Spelling slips still find the brand — "redbull"
// finds Red Bull, "Liquid IV" finds Liquid I.V., "celcius" finds Celsius.
// Tested by `node scripts/test-brand-search.mjs`.

import { nameKey } from './brand-match'

// 0 = the exact name … 5 = a spelling slip; null = no match.
// via: which name matched — the brand's own, an also-known-as, or a guess.
export type SearchHit = { rank: number; via: 'name' | 'aka' | 'fuzzy'; aka?: string }

const squash = (s: string) => nameKey(s).replace(/ /g, '')

// Edit distance, stopping early once it passes `max`.
export function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (cur[j] < best) best = cur[j]
    }
    if (best > max) return max + 1
    prev = cur
  }
  return prev[b.length]
}

// How one name answers the query: 0 exact, 1 starts with it, 2 a word
// starts with it, 3 contains it; null = none of those.
function plainRank(q: { key: string; flat: string }, name: string): number | null {
  const key = nameKey(name)
  const flat = key.replace(/ /g, '')
  if (!flat || !q.flat) return null
  if (key === q.key || flat === q.flat) return 0
  if (flat.startsWith(q.flat)) return 1
  if (key.split(' ').some(w => w.startsWith(q.key)) || key.includes(' ' + q.key)) return 2
  if (flat.includes(q.flat)) return 3
  return null
}

// A spelling slip: one letter off for a short word, two for a longer one,
// against the whole name or its start (typing "celcius" for "Celsius
// Energy"). Four letters at least, so "ab" never guesses.
function fuzzy(q: { flat: string }, name: string): boolean {
  if (q.flat.length < 4) return false
  const flat = squash(name)
  if (!flat) return false
  const max = q.flat.length >= 7 ? 2 : 1
  if (editDistance(q.flat, flat, max) <= max) return true
  return flat.length > q.flat.length && editDistance(q.flat, flat.slice(0, q.flat.length), max) <= max
}

export function searchHit(query: string, name: string, aka: string | null | undefined): SearchHit | null {
  const key = nameKey(query)
  const q = { key, flat: key.replace(/ /g, '') }
  if (!q.flat) return null
  const own = plainRank(q, name)
  if (own !== null) return { rank: own, via: 'name' }
  const akas = String(aka ?? '').split(/[,;]/).map(s => s.trim()).filter(Boolean)
  for (const a of akas) {
    const r = plainRank(q, a)
    if (r !== null) return { rank: 4, via: 'aka', aka: a }
  }
  if (fuzzy(q, name)) return { rank: 5, via: 'fuzzy' }
  for (const a of akas) if (fuzzy(q, a)) return { rank: 5, via: 'fuzzy', aka: a }
  return null
}
