// src/lib/li-review.ts
//
// Two things the LinkedIn fill asks Leo instead of guessing (Sep 2026):
//
//   · "Which LinkedIn page is theirs?" — a brand whose search found no
//     page that clearly fits (an exact name in the wrong industry, only
//     near misses, nothing), or whose saved page turns out to be another
//     company's (Native had a home-care agency's page). The run skips it
//     and leaves the top results here; Leo picks one (or pastes the link,
//     or says there's none) on Outreach → People.
//     Setting "liPageReview": brandId → entry.
//     Setting "liPageConfirmed": brandId → the page slug Leo picked (the
//     industry check never second-guesses it) or "none".
//
//   · Whose LinkedIn the fill runs on — Leo's only. The first run
//     remembers the signed-in account; any other account is refused.
//     Setting "liOwner": { slug, name, at }.

export const LI_REVIEW_KEY = 'liPageReview'
export const LI_CONFIRMED_KEY = 'liPageConfirmed'
export const LI_OWNER_KEY = 'liOwner'
const KEEP_CANDIDATES = 6

export type ReviewCandidate = { slug: string; name: string; subtitle: string }
export type ReviewEntry = {
  at: string
  // unclear: results, none that clearly fits · none: no results ·
  // wrong: the saved page's industry doesn't fit the brand
  why: 'unclear' | 'none' | 'wrong'
  saved: string | null
  pageIndustry: string | null
  candidates: ReviewCandidate[]
}
export type Review = Record<string, ReviewEntry>
export type Confirmed = Record<string, string>
export type LiMember = { slug?: string | null; name?: string | null }
export type LiOwner = { slug: string | null; name: string | null; at: string }

// Pure: the list after one more finding for a brand. The run may look a
// brand up twice (its name, then its other name), so candidates add up
// (no repeats, best first as LinkedIn gave them) and "wrong" — the saved
// page is someone else's — stays the reason once it's known.
export function addToReview(
  review: Review,
  brandId: string,
  found: { why: ReviewEntry['why']; saved?: string | null; pageIndustry?: string | null; candidates?: ReviewCandidate[] },
  now = new Date(),
): Review {
  const prev = review[brandId]
  const seen = new Set<string>()
  const candidates: ReviewCandidate[] = []
  for (const c of [...(prev?.candidates || []), ...(found.candidates || [])]) {
    if (!c || !c.slug || seen.has(c.slug)) continue
    seen.add(c.slug)
    candidates.push({ slug: c.slug, name: String(c.name || '').slice(0, 120), subtitle: String(c.subtitle || '').slice(0, 200) })
  }
  const why = prev?.why === 'wrong' || found.why === 'wrong' ? 'wrong'
    : found.why === 'unclear' || prev?.why === 'unclear' ? 'unclear' : 'none'
  return {
    ...review,
    [brandId]: {
      at: now.toISOString(),
      why: candidates.length && why === 'none' ? 'unclear' : why,
      saved: found.saved ?? prev?.saved ?? null,
      pageIndustry: found.pageIndustry ?? prev?.pageIndustry ?? null,
      candidates: candidates.slice(0, KEEP_CANDIDATES),
    },
  }
}

const cleanName = (s: string | null | undefined) =>
  String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

// Same LinkedIn member? Profile slugs when both are known, else names.
// null when there's nothing to compare — the lock never blocks on a guess.
export function sameMember(a: LiMember | null | undefined, b: LiMember | null | undefined): boolean | null {
  const sa = String(a?.slug || '').toLowerCase(), sb = String(b?.slug || '').toLowerCase()
  if (sa && sb) return sa === sb
  const na = cleanName(a?.name), nb = cleanName(b?.name)
  if (na && nb) return na === nb
  return null
}

type SettingStore = {
  setting: {
    findUnique(args: any): Promise<{ value: string } | null>
    upsert(args: any): Promise<any>
  }
}

export async function readJsonSetting<T>(db: SettingStore, key: string, fallback: T): Promise<T> {
  try {
    const row = await db.setting.findUnique({ where: { key } })
    const v = row ? JSON.parse(row.value) : null
    return v && typeof v === 'object' ? v as T : fallback
  } catch {
    return fallback
  }
}

export async function writeJsonSetting(db: SettingStore, key: string, value: unknown) {
  const v = JSON.stringify(value)
  await db.setting.upsert({ where: { key }, create: { key, value: v }, update: { value: v } })
}
