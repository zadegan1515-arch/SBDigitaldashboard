// Brands → Duplicates: which brands on the roster are probably the same
// company. Pure — the findDuplicates handler in src/app/api/data/route.ts
// loads the brands and the pairs Leo said are different, and hands them
// here. Tested by scripts/test-duplicates.mjs.
//
// Suggestions only. Nothing merges without Leo's click and the merge's own
// preview. Three signals: the same name (or a name matching another's
// "also known as"), the same LinkedIn company page, the same website.
// Never an email domain — brands under one parent company share one and
// stay separate (Leo's call) — and a website several brands share is a
// parent's or a platform's, so it is not a signal at all.

import { nameKey } from './brand-match'
import { companySlug } from './li-capture'

export type DupBrand = { id: string; name: string; aka: string | null; website: string | null; linkedinUrl: string | null }
export type DupWhy = 'name' | 'linkedin' | 'website'
export type DupGroup = { ids: string[]; pairs: Array<{ a: string; b: string; why: DupWhy[] }> }

// Hosts that are somebody else's platform, not the brand's own site.
const SHARED_HOSTS = new Set([
  'linktr.ee', 'instagram.com', 'facebook.com', 'linkedin.com', 'twitter.com', 'x.com', 'tiktok.com',
  'youtube.com', 'amazon.com', 'shopify.com', 'myshopify.com', 'wix.com', 'wixsite.com', 'squarespace.com',
  'etsy.com', 'walmart.com', 'target.com', 'google.com', 'bit.ly', 'beacons.ai', 'carrd.co', 'sponsorunited.com',
])
// A website this many brands share is a parent company's or a platform's.
const MAX_PER_WEBSITE = 3

// "https://www.Drinkpoppi.com/shop?x" → "drinkpoppi.com". Null for no
// site, a platform, or something that isn't a web address.
export function websiteDomain(url: string | null | undefined): string | null {
  let s = String(url || '').trim().toLowerCase()
  if (!s) return null
  if (!/^[a-z]+:\/\//.test(s)) s = 'https://' + s
  let host: string
  try { host = new URL(s).hostname } catch { return null }
  host = host.replace(/^www\d?\./, '').replace(/\.$/, '')
  if (!host.includes('.')) return null
  if (SHARED_HOSTS.has(host) || [...SHARED_HOSTS].some(h => host.endsWith('.' + h))) return null
  return host
}

// One key per unordered pair, so "a|b" and "b|a" are the same pair.
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

// The names a brand goes by: its own and each "also known as".
function namesOf(b: DupBrand): string[] {
  return [b.name, ...String(b.aka || '').split(/[,;]/)].map(s => s.trim()).filter(Boolean)
}

// Groups of brands that look like one company, each with the pairs that
// tie it together and why. `dismissed` = pair keys Leo marked "not the
// same"; those pairs never link, so a group only forms through pairs he
// hasn't ruled out. Strongest first: a name or LinkedIn match before a
// website-only one; then by the first name.
export function findDuplicateGroups(brands: DupBrand[], dismissed: ReadonlySet<string> = new Set()): DupGroup[] {
  const byKey = new Map<string, Set<string>>()
  const add = (key: string, id: string) => {
    const set = byKey.get(key) ?? new Set<string>()
    set.add(id)
    byKey.set(key, set)
  }
  for (const b of brands) {
    for (const n of namesOf(b)) {
      const k = nameKey(n)
      if (k.length >= 2) add('name:' + k, b.id)
    }
    const slug = companySlug(b.linkedinUrl)
    if (slug) add('linkedin:' + slug, b.id)
    const site = websiteDomain(b.website)
    if (site) add('website:' + site, b.id)
  }

  const edges = new Map<string, Set<DupWhy>>()
  for (const [key, set] of byKey) {
    if (set.size < 2) continue
    const why = key.slice(0, key.indexOf(':')) as DupWhy
    if (why === 'website' && set.size > MAX_PER_WEBSITE) continue
    const ids = [...set].sort()
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const pk = pairKey(ids[i], ids[j])
        if (dismissed.has(pk)) continue
        const w = edges.get(pk) ?? new Set<DupWhy>()
        w.add(why)
        edges.set(pk, w)
      }
    }
  }

  // Union-find over the pairs that are left.
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!
    parent.set(x, r)
    return r
  }
  for (const pk of edges.keys()) {
    const [a, b] = pk.split('|')
    if (!parent.has(a)) parent.set(a, a)
    if (!parent.has(b)) parent.set(b, b)
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb)
  }
  const groups = new Map<string, DupGroup>()
  for (const [pk, why] of edges) {
    const [a, b] = pk.split('|')
    const root = find(a)
    const g = groups.get(root) ?? { ids: [], pairs: [] }
    for (const id of [a, b]) if (!g.ids.includes(id)) g.ids.push(id)
    const order: DupWhy[] = ['name', 'linkedin', 'website']
    g.pairs.push({ a, b, why: order.filter(w => why.has(w)) })
    groups.set(root, g)
  }

  const nameOf = new Map(brands.map(b => [b.id, b.name]))
  const weakOnly = (g: DupGroup) => g.pairs.every(p => p.why.length === 1 && p.why[0] === 'website')
  const first = (g: DupGroup) => g.ids.map(id => nameOf.get(id) ?? '').sort((x, y) => x.localeCompare(y))[0] ?? ''
  return [...groups.values()]
    .map(g => ({ ...g, ids: g.ids.slice().sort((x, y) => (nameOf.get(x) ?? '').localeCompare(nameOf.get(y) ?? '')) }))
    .sort((x, y) => Number(weakOnly(x)) - Number(weakOnly(y)) || first(x).localeCompare(first(y)))
}
