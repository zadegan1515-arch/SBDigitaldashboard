// src/lib/li-capture.ts
//
// The rules behind the LinkedIn People capture (scripts/linkedin-capture.user.js
// → /api/ingest, actions liPreview / liCapture). Pure and dependency-free
// so node scripts/test-li-capture.mjs can compile and check it on its own.
//
// What LinkedIn gives us is a name, a headline and a profile link — no
// email, no location. The headline is the person's own words ("Senior
// Brand Manager at Liquid Death | ex-Red Bull"), so the job here is to
// turn it into a title we can put in a template and decide whether the
// person buys sponsorships at all. Leo's call (Sep 2026): buyers only,
// inside the same 25-per-brand file cap as SponsorUnited.

// A company or showcase page slug from any LinkedIn company URL:
// linkedin.com/company/liquid-death/people/?keywords=x → "liquid-death".
export function companySlug(url: string | null | undefined): string | null {
  const m = String(url || '').match(/linkedin\.com\/(?:company|showcase)\/([^\/?#\s]+)/i)
    || String(url || '').match(/^\/(?:company|showcase)\/([^\/?#\s]+)/i)
  if (!m) return null
  let s = m[1]
  try { s = decodeURIComponent(s) } catch { /* keep as is */ }
  s = s.trim().toLowerCase()
  return s || null
}

export function companyPageUrl(slug: string): string {
  return 'https://www.linkedin.com/company/' + encodeURIComponent(slug) + '/'
}

// A person's profile slug: linkedin.com/in/jane-doe-12ab/?miniProfileUrn=… →
// "jane-doe-12ab". SponsorUnited stores the same links, so this is what
// tells us a LinkedIn card is someone already on file.
export function profileSlug(url: string | null | undefined): string | null {
  const m = String(url || '').match(/(?:linkedin\.com)?\/(?:in|pub)\/([^\/?#\s]+)/i)
  if (!m) return null
  let s = m[1]
  try { s = decodeURIComponent(s) } catch { /* keep as is */ }
  s = s.trim().toLowerCase()
  return s || null
}

export function profileUrl(slug: string): string {
  return 'https://www.linkedin.com/in/' + encodeURIComponent(slug) + '/'
}

// The name as LinkedIn shows it, tidied. Null for anything that is not a
// person's name: "LinkedIn Member" (out of network, no profile to open),
// an address, or a whole card's text.
export function cleanName(raw: string | null | undefined): string | null {
  const s = String(raw || '')
    .replace(/[​-‍﻿]/g, '')
    // Emoji and pictographs people put in their names.
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s || s.length > 80 || s.indexOf('@') !== -1) return null
  if (/^linkedin member$/i.test(s)) return null
  return s
}

// Two spellings of the same person: "Jane Doe, MBA" and "Jane Doe" on
// SponsorUnited, "José" and "Jose". Used only for "already on file".
export function personKey(name: string | null | undefined): string {
  return String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(',')[0]
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// The role out of a headline: the first segment, without " at Company".
//   "Senior Brand Manager at Liquid Death | ex-Red Bull" → "Senior Brand Manager"
//   "VP, Marketing @ Olipop"                             → "VP, Marketing"
//   "Head of Partnerships – Liquid Death"                → "Head of Partnerships" (company given)
export function roleFromHeadline(headline: string | null | undefined, companyName?: string | null): string | null {
  let s = String(headline || '').replace(/\s+/g, ' ').trim()
  if (!s) return null
  s = s.split(/\s*[|•·]\s*/)[0]
  s = s.replace(/\s+(?:at|@)\s+.+$/i, '').replace(/\s*@\s*\S.*$/, '')
  if (companyName) {
    const co = companyName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (co) s = s.replace(new RegExp('\\s*[-–—,]\\s*' + co + '.*$', 'i'), '')
  }
  s = s.replace(/[\s,;:-]+$/, '').trim()
  return s ? s.slice(0, 120) : null
}

// Who buys sponsorships. Judged on the role (the headline's first
// segment), because the rest of a headline is history and slogans:
// "Brand Manager | ex-Red Bull" is a buyer at this brand, not Red Bull's.
const BUYER = /marketing|ambassador programs?|student (?:engagement|programs?)|\bbrand|partnership|sponsor|experiential|activation|campus|college|universit|\bevents?\b|community|influencer|social media|\bcmo\b|chief (?:marketing|brand|growth|commercial|revenue)|\bgrowth\b|promotion|shopper|entertainment|communications|public relations|\bpr\b|creative director/i
// Small brands: the founder or CEO is who signs.
const LEADER = /\b(?:co-?founder|founder|ceo|chief executive|owner|(?<!vice[ -])president)\b/i
// A role this generic ("Director", "Senior Manager") says nothing on its
// own; let the rest of the headline decide it.
const GENERIC = /^(?:senior |sr\.? |associate |assistant |group |global |regional |national )*(?:director|manager|lead|head|vp|vice president|svp|evp|avp|coordinator|specialist|executive|strategist)$/i
// Never a buyer, whatever else the headline says. "Brand Ambassador" is
// a promo rep at a beverage brand; "People & Culture" is HR. Whoever
// RUNS the student or ambassador program is the opposite — that is the
// college buyer — so those two words only disqualify on their own.
const NOT_BUYER = /\bintern(?:ship)?\b|\bstudent\b(?!\s+(?:marketing|engagement|programs?|partnerships?|activation))|ambassador(?!\s+(?:programs?|marketing|manager|lead|director|coordinator))|recruit|talent acquisition|human resources|\bhr\b|people (?:&|and) culture|designer|engineer|developer|accountant|accounting|\bfinance\b|\blegal\b|counsel|attorney|paralegal|supply chain|logistics|warehouse|driver|merchandiser|cashier|retired|seeking|open to work|looking for|aspiring|volunteer/i

export function isBuyer(role: string | null | undefined, headline?: string | null): boolean {
  const r = String(role || '').trim()
  if (!r || NOT_BUYER.test(r)) return false
  if (BUYER.test(r) || LEADER.test(r)) return true
  const h = String(headline || '')
  return GENERIC.test(r) && BUYER.test(h) && !NOT_BUYER.test(h.split(/\s*[|•·]\s*/).slice(0, 2).join(' '))
}

// -------------------------------------------------------------------
// The unattended LinkedIn fill (Leo, Sep 2026: ~50 brands a day, saves
// by itself, and finds the company page for brands that have none).
// -------------------------------------------------------------------

// A company name reduced to what identifies it: "Liquid I.V., Inc." and
// "Liquid IV" are the same company; "The Coca-Cola Company" is "coca cola".
const CORP_WORDS = /\b(?:the|inc|llc|ltd|limited|co|corp|corporation|company|usa|us|official|hq|global|international|gmbh|sa|de cv)\b/g
export function normalizeCompany(s: string | null | undefined): string {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[.'’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(CORP_WORDS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// LinkedIn's industry line for a company that plausibly IS a brand of
// this category. Only used to accept a near-miss name ("Casamigos
// Tequila" for Casamigos); an exact name never needs it.
const INDUSTRY_FITS: Record<string, RegExp> = {
  beverage: /beverage|food|drink|consumer goods|consumer products|wellness|health|nutrition/i,
  alcohol: /beverage|wine|spirit|brew|distill|alcohol|liquor|food/i,
  nicotine: /tobacco|nicotine|consumer goods|consumer products/i,
  cpg: /food|beverage|consumer goods|consumer products|snack|retail/i,
  apparel: /apparel|fashion|retail|textile|sporting goods|luxury|footwear/i,
  beauty: /cosmetic|beauty|personal care|consumer goods|consumer products|wellness/i,
  wellness: /wellness|health|fitness|nutrition|supplement|pharma|consumer goods|beverage|food/i,
  qsr: /restaurant|food|hospitality/i,
  tech: /electronic|technology|computer|consumer goods|consumer products|appliance/i,
  software: /software|technology|internet|information/i,
  fintech: /financial|banking|fintech|investment|payment|insurance/i,
  betting: /gambling|casino|gaming|sports/i,
  apps: /internet|software|technology|online|social/i,
  entertainment: /entertainment|media|music|sports|broadcast|film|gaming/i,
  nightlife: /entertainment|events|music|hospitality|nightlife/i,
  home: /furniture|home|housewares|consumer goods|consumer products|retail/i,
  retail: /retail/i,
  transport: /travel|transport|airline|automotive|mobility/i,
}
export function industryFits(category: string | null | undefined, subtitle: string | null | undefined): boolean {
  const re = INDUSTRY_FITS[String(category || '')]
  return !!re && re.test(String(subtitle || ''))
}

export type LiCompany = { slug: string; name: string; subtitle?: string | null }

// Which search result is this brand's company page. Wrong is worse than
// none — a wrong page fills a brand with another company's people — so:
//   · an exact name (or "also known as") wins, the industry-fitting one
//     if several share the name;
//   · a near miss (one name starts with the other, "Casamigos" /
//     "Casamigos Tequila") only among the top three results, and only
//     when LinkedIn's industry fits the brand's category;
//   · anything else is "unclear" and left for Leo.
export function decideCompanyMatch(
  brand: { name: string; aka?: string | null; category?: string | null },
  candidates: LiCompany[],
): { pick: LiCompany | null; reason: 'exact' | 'near' | 'unclear' | 'none' } {
  const list = candidates.filter(c => c && c.slug && c.name)
  if (!list.length) return { pick: null, reason: 'none' }
  const names = [brand.name, ...String(brand.aka || '').split(/[,;]/)]
    .map(normalizeCompany).filter(n => n.length >= 2)
  const exact = list.filter(c => names.includes(normalizeCompany(c.name)))
  if (exact.length === 1) return { pick: exact[0], reason: 'exact' }
  if (exact.length > 1) {
    const fit = exact.filter(c => industryFits(brand.category, c.subtitle))
    if (fit.length >= 1) return { pick: fit[0], reason: 'exact' }
    return { pick: null, reason: 'unclear' }
  }
  const near = list.slice(0, 3).find(c => {
    const cn = normalizeCompany(c.name)
    const hit = names.some(n => n.length >= 4 && (cn.startsWith(n + ' ') || n.startsWith(cn + ' ')))
    return hit && industryFits(brand.category, c.subtitle)
  })
  if (near) return { pick: near, reason: 'near' }
  return { pick: null, reason: 'unclear' }
}

// "Start with electrolyte companies": a focus word matches a brand's
// name, "also known as", description, products or notes. Some words
// stand for a whole shelf of brands whose descriptions may be empty.
const FOCUS_SYNONYMS: Record<string, string[]> = {
  electrolyte: ['electrolyte', 'hydration', 'hydrate', 'lmnt', 'liquid i.v', 'liquid iv', 'electrolit', 'pedialyte',
    'nuun', 'dripdrop', 'drip drop', 'bodyarmor', 'body armor', 'gatorade', 'prime hydration', 'waterboy',
    'cure hydration', 'ultima replenisher', 'skratch', 'hydrant', 'liquidiv', 'powerade', 'propel'],
}
FOCUS_SYNONYMS.electrolytes = FOCUS_SYNONYMS.electrolyte
FOCUS_SYNONYMS.hydration = FOCUS_SYNONYMS.electrolyte

export function focusTerms(q: string | null | undefined): string[] {
  const out: string[] = []
  for (const raw of String(q || '').toLowerCase().split(/[,;]/)) {
    const w = raw.trim()
    if (!w) continue
    for (const t of FOCUS_SYNONYMS[w] || [w]) if (!out.includes(t)) out.push(t)
  }
  return out
}

export function matchesFocus(
  b: { name?: string | null; aka?: string | null; about?: string | null; topProducts?: string | null; notes?: string | null },
  terms: string[],
): boolean {
  if (!terms.length) return false
  const text = [b.name, b.aka, b.about, b.topProducts, b.notes].filter(Boolean).join(' ').toLowerCase()
  return terms.some(t => text.includes(t))
}

// -------------------------------------------------------------------
// Finding new brands (Leo, Sep 2026): LinkedIn's lookalikes on each
// brand page the run visits ("Pages people also viewed") and company
// searches for words he gives. Straight into the dashboard — so the bar
// is here: consumer industries only, and at least 5,000 followers.
// -------------------------------------------------------------------

export const DISCOVER_MIN_FOLLOWERS = 5000

// "250,512 followers" / "12K followers" / "1.2M followers" → a number.
export function parseFollowers(text: string | null | undefined): number | null {
  const m = String(text || '').match(/([\d.,]+)\s*([KkMm])?\+?\s*followers/)
  if (!m) return null
  const n = parseFloat(m[1].replace(/,/g, ''))
  if (!Number.isFinite(n)) return null
  const mult = /k/i.test(m[2] || '') ? 1e3 : /m/i.test(m[2] || '') ? 1e6 : 1
  return Math.round(n * mult)
}

// The industry is the first part of the line under a company's name:
// "Food and Beverage Services • Austin, TX • 40K followers".
export function industryOf(subtitle: string | null | undefined): string {
  const first = String(subtitle || '').split(/\s*[•·]\s*/)[0].trim()
  return /followers/i.test(first) ? '' : first
}

// LinkedIn industry → our category, for consumer industries only. Order
// matters: spirits before the general beverage line. Anything not here
// (software, agencies, wholesale, finance…) is not a brand we'd add
// from a suggestion.
const INDUSTRY_CATEGORY: Array<[RegExp, string]> = [
  [/wine|spirit|brewer|distiller|alcohol/i, 'alcohol'],
  [/beverage/i, 'beverage'],
  [/tobacco/i, 'nicotine'],
  [/food|dairy|bakery|snack|confection/i, 'cpg'],
  [/apparel|fashion|footwear|textile|sporting goods|luxury goods|jewelry/i, 'apparel'],
  [/cosmetic|personal care|beauty/i, 'beauty'],
  [/wellness|fitness|nutrition|supplement/i, 'wellness'],
  [/restaurant/i, 'qsr'],
  [/gambling|casino/i, 'betting'],
  [/furniture|home furnishing|housewares|appliance/i, 'home'],
  [/consumer electronics/i, 'tech'],
  [/entertainment|spectator sports|musicians|music|video games|computer games|movies/i, 'entertainment'],
  [/consumer goods|consumer products|consumer services/i, 'cpg'],
  [/^retail(?! .*wholesale)/i, 'retail'],
]
const NOT_A_BRAND = /wholesale|distribut|advertising|marketing services|public relations|staffing|recruit|consult|logistics|packaging|machinery|venture capital|investment|real estate/i

export function categoryFromIndustry(industry: string | null | undefined): string | null {
  const s = String(industry || '')
  if (!s || NOT_A_BRAND.test(s)) return null
  for (const [re, cat] of INDUSTRY_CATEGORY) if (re.test(s)) return cat
  return null
}

// Whether a suggested company goes into the dashboard, and under which
// category. A lookalike of a brand we have may take that brand's
// category when its industry fits it ("Jose Cuervo" next to Clase Azul
// is alcohol, not just "Beverage Manufacturing").
export function judgeDiscovery(
  c: { name: string; subtitle?: string | null },
  sourceCategory?: string | null,
): { ok: true; category: string; followers: number; industry: string } | { ok: false; reason: 'small' | 'industry' } {
  const followers = parseFollowers(c.subtitle)
  const industry = industryOf(c.subtitle)
  if (followers == null || followers < DISCOVER_MIN_FOLLOWERS) return { ok: false, reason: 'small' }
  if (!industry || NOT_A_BRAND.test(industry)) return { ok: false, reason: 'industry' }
  if (sourceCategory && industryFits(sourceCategory, industry)) return { ok: true, category: sourceCategory, followers, industry }
  const cat = categoryFromIndustry(industry)
  if (!cat) return { ok: false, reason: 'industry' }
  return { ok: true, category: cat, followers, industry }
}
