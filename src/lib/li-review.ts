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

// Already answered? Leo said "None of these" (confirmed "none"), or picked
// the page this entry is about. Such an entry is a leftover (Oct 18 2026:
// two answers written at once each put back the brand the other had just
// cleared) and never shows again. `page` = the brand's saved page now,
// when the caller knows it: a search entry for a brand that has since got
// the page Leo picked is a leftover too.
const slugOf = (u: string | null | undefined) => {
  const m = String(u || '').match(/\/company\/([^/?#]+)/i)
  if (!m) return ''
  try { return decodeURIComponent(m[1]).toLowerCase() } catch { return m[1].toLowerCase() }
}
export function answered(entry: ReviewEntry | undefined, confirmed: string | undefined | null, page?: string | null): boolean {
  if (!entry || !confirmed) return false
  if (confirmed === 'none') return true
  const pick = confirmed.toLowerCase()
  if (entry.why === 'wrong') return slugOf(entry.saved) === pick
  return page !== undefined && slugOf(page) === pick
}

// The list without its answered leftovers.
export function openReview(review: Review, confirmed: Confirmed, pageOf?: (id: string) => string | null | undefined): Review {
  const out: Review = {}
  for (const [id, e] of Object.entries(review || {})) {
    if (e && !answered(e, confirmed[id], pageOf ? pageOf(id) ?? null : undefined)) out[id] = e
  }
  return out
}

// Every change to the list and to Leo's answers goes through here: one
// writer at a time (advisory lock), both settings read fresh inside it,
// answered leftovers pruned on the way out. Before this each writer read
// the whole list, changed one brand and wrote the whole list back, so two
// "None of these" clicks close together (or a click while the fill was
// saving) put back the brand the other had cleared.
export async function updateReviewState<T>(
  db: SettingStore & { $transaction?: any },
  fn: (review: Review, confirmed: Confirmed) => T,
): Promise<T> {
  let out: T
  const work = async (tx: any) => {
    if (tx.$queryRaw) await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${LI_REVIEW_KEY}))::text`
    const review = await readJsonSetting<Review>(tx, LI_REVIEW_KEY, {})
    const confirmed = await readJsonSetting<Confirmed>(tx, LI_CONFIRMED_KEY, {})
    const r0 = JSON.stringify(review), c0 = JSON.stringify(confirmed)
    out = fn(review, confirmed)
    const next = openReview(review, confirmed)
    if (JSON.stringify(next) !== r0) await writeJsonSetting(tx, LI_REVIEW_KEY, next)
    if (JSON.stringify(confirmed) !== c0) await writeJsonSetting(tx, LI_CONFIRMED_KEY, confirmed)
  }
  if (typeof db.$transaction === 'function') await db.$transaction(work, { maxWait: 10000, timeout: 20000 })
  else await work(db)
  return out!
}

// A finding the fill wants Leo to look at — unless he already said the
// brand has no page. Returns whether it went on the list.
export async function putOnReview(
  db: SettingStore & { $transaction?: any },
  brandId: string,
  found: Parameters<typeof addToReview>[2],
): Promise<boolean> {
  return updateReviewState(db, (review, confirmed) => {
    if (confirmed[brandId] === 'none') return false
    const next = addToReview(review, brandId, found)
    review[brandId] = next[brandId]
    return !answered(review[brandId], confirmed[brandId])
  })
}
