// "Add a brand" chat (Leo, Oct 2026: "if i find a brand that is not on the
// command center … send a picture of a brand from instagram or type in a
// name and it will find the brand … and add it"). A saved Claude session
// reads the picture or name, looks the brand up on the open web (free —
// Claude's subscription, no API spend), shows Leo what it found, and on
// his yes calls chatAddBrand in src/app/api/data/route.ts. The playbook
// it follows is docs/add-a-brand-chat.md.
//
// Pure: the row the chat sends, cleaned, and which brands on the roster it
// could already be. Same signals as Brands → Duplicates — a name or
// also-known-as, the LinkedIn page, the website (never a platform link or
// a site 4+ brands share). node scripts/test-chat-add.mjs

import { brandKey } from './stock'
import { websiteDomain } from './duplicates'
import { companySlug, companyPageUrl } from './li-capture'

export type ChatBrand = {
  name: string
  category: string | null       // a CATEGORY_KEYS key; checked by the handler
  tier: 'emerging' | 'growth' | 'established' | null
  website: string | null
  linkedinUrl: string | null    // a company page, else nothing
  aka: string[]
  about: string | null          // what they sell, one line
  instagram: string | null      // "@handle"
  sourceUrl: string | null      // where Leo or Claude found it
  note: string | null           // why it's worth a look
}

export type RosterBrand = { id: string; name: string; aka: string | null; website: string | null; linkedinUrl: string | null; passedAt?: Date | string | null }
export type ChatMatch = { id: string; name: string; why: Array<'name' | 'linkedin' | 'website'>; archived: boolean }

const TIERS = ['emerging', 'growth', 'established'] as const
// A website more brands than this share is a parent's or a platform's.
const MAX_PER_WEBSITE = 3

function text(v: unknown, max: number): string | null {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, max) : null
}

function url(v: unknown): string | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s)
    return /\./.test(u.hostname) ? u.toString().slice(0, 300) : null
  } catch { return null }
}

// "instagram.com/drinkpoppi/", "@drinkpoppi", "drinkpoppi" → "@drinkpoppi".
export function igHandle(v: unknown): string | null {
  let s = String(v ?? '').trim()
  if (!s) return null
  const m = s.match(/instagram\.com\/([^\/?#\s]+)/i)
  if (m) s = m[1]
  s = s.replace(/^@+/, '')
  return /^[A-Za-z0-9._]{1,30}$/.test(s) ? '@' + s : null
}

export function cleanChatBrand(raw: any): { row: ChatBrand | null; error: string | null } {
  if (!raw || typeof raw !== 'object') return { row: null, error: 'Send the brand as an object' }
  const name = text(raw.name, 120)
  if (!name || !brandKey(name)) return { row: null, error: 'The brand needs a name' }
  const tier = String(raw.tier ?? '').trim().toLowerCase()
  const slug = companySlug(raw.linkedinUrl)
  const aka = (Array.isArray(raw.aka) ? raw.aka : String(raw.aka ?? '').split(/[,;]/))
    .map((a: unknown) => text(a, 120)).filter((a: string | null): a is string => !!a && brandKey(a) !== brandKey(name))
  return {
    row: {
      name,
      category: text(raw.category, 40)?.toLowerCase() ?? null,
      tier: (TIERS as readonly string[]).includes(tier) ? tier as ChatBrand['tier'] : null,
      // An Instagram or Linktree link is not the brand's own site.
      website: websiteDomain(raw.website) ? url(raw.website) : null,
      linkedinUrl: slug ? companyPageUrl(slug) : null,
      aka: [...new Set(aka)] as string[],
      about: text(raw.about, 300),
      instagram: igHandle(raw.instagram),
      sourceUrl: url(raw.sourceUrl ?? raw.source),
      note: text(raw.note, 500),
    },
    error: null,
  }
}

// Brands on the roster this could already be, strongest first.
export function matchRoster(b: ChatBrand, roster: RosterBrand[]): ChatMatch[] {
  const keys = new Set([b.name, ...b.aka].map(brandKey).filter(Boolean))
  const slug = companySlug(b.linkedinUrl)
  const domain = websiteDomain(b.website)
  const perDomain = new Map<string, number>()
  for (const r of roster) {
    const d = websiteDomain(r.website)
    if (d) perDomain.set(d, (perDomain.get(d) ?? 0) + 1)
  }
  const out: ChatMatch[] = []
  for (const r of roster) {
    const why: ChatMatch['why'] = []
    const names = [r.name, ...String(r.aka ?? '').split(/[,;]/)].map(brandKey).filter(Boolean)
    if (names.some(n => keys.has(n))) why.push('name')
    if (slug && companySlug(r.linkedinUrl) === slug) why.push('linkedin')
    const d = websiteDomain(r.website)
    if (domain && d === domain && (perDomain.get(d) ?? 0) <= MAX_PER_WEBSITE) why.push('website')
    if (why.length) out.push({ id: r.id, name: r.name, why, archived: !!r.passedAt })
  }
  const rank = (m: ChatMatch) => (m.why.includes('name') ? 0 : m.why.includes('linkedin') ? 1 : 2)
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

// The brand's notes: where it came from, so the brand page says it.
export function chatNotes(b: ChatBrand, day: string): string | null {
  const lines = [
    'Added from the "Add a brand" chat · ' + day,
    b.note,
    b.instagram ? 'Instagram: ' + b.instagram : null,
    b.sourceUrl ? 'Found in: ' + b.sourceUrl : null,
  ].filter(Boolean)
  return lines.join('\n').slice(0, 2000) || null
}
