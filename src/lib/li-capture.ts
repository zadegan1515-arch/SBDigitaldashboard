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
    // LinkedIn's connection badge and pronouns, when they ride along.
    .replace(/\s*[·•]\s*(1st|2nd|3rd\+?)\s*$/i, '')
    .replace(/\s*\((she|he|they)\s*\/\s*(her|him|them)\)\s*$/i, '')
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
// What the Sep 30 run let in through the big-company searches (Leo, Oct
// 2026: "is it getting the right people"): students and new grads whose
// headline is their degree ("Marketing Major", "Recent graduate from…"),
// store staff, investors / board members / advisers on the brand's page,
// HR's "people partners", campus recruiting, wholesale, creators.
const anyOf = (parts: string[]) => new RegExp(parts.join('|'), 'i')
// studying, or just finished
const STUDENT = anyOf([
  String.raw`\bmajor(?:ing)?\b(?!\s+(?:league|accounts?|gifts?|brands?|events?))`,
  String.raw`\bminor\b`, String.raw`\bgraduate\b`, String.raw`\b(?:recent|new) grad\b`, String.raw`\bgrad student\b`,
  String.raw`\balum(?:na|nus|nae|ni)?\b`, String.raw`\bpursuing\b`, String.raw`\bcandidate\b`, String.raw`\bscholar\b`,
  String.raw`\bbachelor'?s?\b`, String.raw`\bb\.?\s?[sa]\.?\s+in\b`, String.raw`\b(?:bba|bsba|msc|m\.sc|phd)\b`, String.raw`\bclass of\b`,
  String.raw`\b(?:first|second|third|fourth|final)[- ]year\b`, String.raw`\b(?:freshman|sophomore|undergrad(?:uate)?)\b`,
  String.raw`\bpre-?(?:med|law|business|dental|pharmacy|health)\b`, String.raw`\bco-?chair\b`,
])
// store and front-line retail
const STORE = anyOf([
  String.raw`\b(?:co-?|assistant |general )?store (?:manager|lead|associate|supervisor|director|employee|team)\b`,
  String.raw`\bsales associate\b`, String.raw`\bstylist\b`, String.raw`\bkey ?holder\b`, String.raw`\bleasing\b`,
  String.raw`\bassistant (?:general )?manager\b(?!\s*[,\-–—]\s*\w)`,
])
// on the brand's page, but not working there. A firm or a board seat is
// never the brand's buyer; investor / adviser / partner / consultant is
// only an outsider when nothing else says they run the brand ("Founder,
// CEO, Advisor, Investor" is the founder; "CEO Ten Thousand, Strategic
// Advisor & Angel Investor" is Ten Thousand's CEO).
const OUTSIDE_FIRM = anyOf([
  String.raw`\b(?:growth|private) equity\b`, String.raw`\bventures?\b`, String.raw`\bcapital\b`, String.raw`\bfund\b`,
  String.raw`\bboard (?:member|chair|director|of directors|advis[oe]r)\b`, String.raw`\badvis[oe]ry? board\b`,
])
const OUTSIDE_SOFT = anyOf([
  String.raw`\b(?:general|managing|venture|limited) partner\b`, String.raw`\binvest(?:or|ment|ing)\b`, String.raw`\badvis[oe]r\b`,
  String.raw`\bconsult(?:ant|ing)\b`, String.raw`\bfractional\b`, String.raw`^(?:i help|helping)\b`,
])
// at the brand, not in marketing: HR's "people partners", campus
// recruiting, wholesale, the CEO's office, creators
const OTHER_JOB = anyOf([
  String.raw`\bpeople (?:partner|partnerships?|operations|ops|experience|business partner)\b`,
  String.raw`\buniversity relations\b`, String.raw`\bearly careers?\b`, String.raw`\bwholesale\b`,
  String.raw`\bexecutive assistant\b`, String.raw`\bassistant to\b`, String.raw`\boffice of the\b`,
  String.raw`\bcontent creator\b`, String.raw`\bugc\b`,
])
// A headline that is only a school ("Chapman University", "Pamplin
// College of Business") — no job in it — is a student's.
const SCHOOL = /\buniversity\b|\b(?:school|college|institute) of\b/i
const JOB = /\b(?:manager|director|head|lead|vp|vice president|president|officer|chief|coordinator|specialist|associate|executive|strategist|analyst|partner|founder|owner|marketer|producer|planner|supervisor|representative|rep)\b/i
// "Founder & CEO of Lendi", "CEO of Sleep Number", "Co-founder of Rapha":
// a leader somewhere else, sitting on this brand's page as an investor or
// board member. Only judged when the brand's names are known.
const LEADER_OF = /\b(?:co-?founder|founder|ceo|chief executive(?: officer)?|owner|(?<!vice[ -])president)\b(?:\s*(?:&|and|\/)\s*(?:co-?founder|founder|ceo|chief executive(?: officer)?|owner|president))*\s+(?:of|at|@)\s+([^,|•·✦/]+)/i
const NOT_A_COMPANY = /\b(?:sales|operations|division|region|north america|americas|emea|apac|international|global|us|usa|the board)\b/i

export type NotBuyerWhy = 'student' | 'store' | 'outside' | 'notMarketing'
function whyNot(r: string, names?: string[] | null): NotBuyerWhy | null {
  if (STUDENT.test(r) || (SCHOOL.test(r) && !JOB.test(r))) return 'student'
  if (STORE.test(r)) return 'store'
  const theirs = !!names && names.length > 0 && namesThis(r, names)
  if (OUTSIDE_FIRM.test(r) && !theirs) return 'outside'
  if (OUTSIDE_SOFT.test(r) && !LEADER.test(r) && !theirs) return 'outside'
  if (OTHER_JOB.test(r)) return 'notMarketing'
  return null
}
function notBuyerRole(r: string, names?: string[] | null): boolean {
  return NOT_BUYER.test(r) || !!whyNot(r, names)
}

// Names that are the brand's own: its name, also-known-as, its parent —
// either way round ("CEO of Liquid Death Mountain Water" for Liquid Death,
// "Co-founder of PRIME" for Prime Hydration).
function namesThis(text: string, names: string[]): boolean {
  const tk = normalizeCompany(text), t = ' ' + tk + ' '
  return names.some(n => {
    const k = normalizeCompany(n)
    return !!k && (t.includes(' ' + k + ' ') || (tk.length >= 3 && (' ' + k + ' ').includes(t)))
  })
}

export function leaderElsewhere(role: string, names?: string[] | null): string | null {
  if (!names || !names.length) return null
  const m = String(role || '').match(LEADER_OF)
  if (!m) return null
  const co = m[1].trim()
  if (!co || BUYER.test(co) || NOT_A_COMPANY.test(co) || namesThis(co, names)) return null
  return co
}

// Why the October rules turn a saved title away — for the clean-up of
// people saved before them (a title alone; the headline isn't kept).
// null = these rules have nothing against it.
export function refusedWhy(title: string | null | undefined, names?: string[] | null): NotBuyerWhy | null {
  const r = String(title || '').trim()
  if (!r) return null
  return whyNot(r, names) || (leaderElsewhere(r, names) ? 'outside' : null)
}

export function isBuyer(role: string | null | undefined, headline?: string | null, names?: string[] | null): boolean {
  const r = String(role || '').trim()
  if (!r || notBuyerRole(r, names)) return false
  if (leaderElsewhere(r, names)) return false
  if (BUYER.test(r) || LEADER.test(r)) return true
  const h = String(headline || '')
  return GENERIC.test(r) && BUYER.test(h) && !notBuyerRole(h.split(/\s*[|•·]\s*/).slice(0, 2).join(' '), names)
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
    .replace(/\.(?:com|net|io)\b/g, ' ')
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
  electrolytes: /beverage|food|drink|consumer goods|consumer products|wellness|health|nutrition/i,
  energy: /beverage|food|drink|consumer goods|consumer products|wellness|health|nutrition/i,
  beverage: /beverage|food|drink|consumer goods|consumer products|wellness|health|nutrition/i,
  rtd: /beverage|wine|spirit|brew|distill|alcohol|liquor|food/i,
  spirits: /beverage|wine|spirit|brew|distill|alcohol|liquor|food/i,
  alcohol: /beverage|wine|spirit|brew|distill|alcohol|liquor|food/i,
  athletic: /apparel|fashion|retail|textile|sporting goods|sports|fitness|footwear/i,
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
//   · an exact name (or "also known as") wins only in an industry that
//     fits the brand's category (Leo, Sep 2026: "Native" the deodorant
//     brand had been given a home-care agency's page); several fitting →
//     the most followed;
//   · a near miss (one name starts with the other, "Casamigos" /
//     "Casamigos Tequila") only among the top three results, and only
//     when LinkedIn's industry fits the brand's category;
//   · anything else is "unclear" and goes on the dashboard's "Which
//     LinkedIn page is theirs?" list for Leo.
// A brand filed where industries can't be checked (unresolved, other…)
// keeps the old rule: one exact name, or unclear.
export function decideCompanyMatch(
  brand: { name: string; aka?: string | null; category?: string | null },
  candidates: LiCompany[],
): { pick: LiCompany | null; reason: 'exact' | 'near' | 'unclear' | 'none' } {
  const list = candidates.filter(c => c && c.slug && c.name)
  if (!list.length) return { pick: null, reason: 'none' }
  const names = [brand.name, ...String(brand.aka || '').split(/[,;]/)]
    .map(normalizeCompany).filter(n => n.length >= 2)
  const checkable = industryCheckable(brand.category)
  const fits = (c: LiCompany) => industryFits(brand.category, industryOf(c.subtitle))
  const exact = list.filter(c => names.includes(normalizeCompany(c.name)))
  if (exact.length) {
    if (!checkable) return exact.length === 1 ? { pick: exact[0], reason: 'exact' } : { pick: null, reason: 'unclear' }
    const fit = exact.filter(fits)
    return fit.length ? { pick: mostFollowed(fit), reason: 'exact' } : { pick: null, reason: 'unclear' }
  }
  const near = list.slice(0, 3).filter(c => {
    const cn = normalizeCompany(c.name)
    const hit = names.some(n => n.length >= 4 && (cn.startsWith(n + ' ') || n.startsWith(cn + ' ')))
    return hit && fits(c)
  })
  if (near.length) return { pick: mostFollowed(near), reason: 'near' }
  return { pick: null, reason: 'unclear' }
}

// The first of the most-followed; results with no count lose to any count.
export function mostFollowed(list: LiCompany[]): LiCompany {
  let best = list[0], bestN = parseFollowers(best.subtitle) ?? -1
  for (const c of list.slice(1)) {
    const n = parseFollowers(c.subtitle) ?? -1
    if (n > bestN) { best = c; bestN = n }
  }
  return best
}

// Whether a brand's category says which LinkedIn industries fit it.
export function industryCheckable(category: string | null | undefined): boolean {
  return !!INDUSTRY_FITS[String(category || '')]
}

// A saved page, checked on its own People tab: wrong only when the
// category can be checked, LinkedIn shows an industry, and it doesn't fit.
export function pageLooksWrong(category: string | null | undefined, industry: string | null | undefined): boolean {
  const ind = String(industry || '').trim()
  return industryCheckable(category) && !!ind && !industryFits(category, ind)
}

// Discovery's "already on the roster" test: one name is the other plus
// words ("Waterloo" / "Waterloo Sparkling Water"). Takes normalizeCompany'd
// names; the shorter must be 4+ letters so "Red" doesn't claim "Red Bull".
export function nearName(a: string, b: string): boolean {
  if (!a || !b || a === b) return !!a && a === b
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  return short.length >= 4 && long.startsWith(short + ' ')
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
// Breweries, distilleries and sporting goods go straight to Leo's lanes
// (rtd, spirits, athletic — src/lib/stock.ts); wine has no lane of its own.
const INDUSTRY_CATEGORY: Array<[RegExp, string]> = [
  [/brewer/i, 'rtd'],
  [/spirit|distiller/i, 'spirits'],
  [/wine|alcohol/i, 'alcohol'],
  [/beverage/i, 'beverage'],
  [/tobacco/i, 'nicotine'],
  [/food|dairy|bakery|snack|confection/i, 'cpg'],
  [/sporting goods/i, 'athletic'],
  [/apparel|fashion|footwear|textile|luxury goods|jewelry/i, 'apparel'],
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
// Leagues, teams and sports agencies sell sponsorships; they don't buy
// them. The Sep 30 run took NFL, NBA, NHL, Athletes Unlimited and Excel
// Sports Management as "similar to MLB".
const SELLS_SPONSORSHIP = /spectator sports|sports teams|talent (?:agenc|management)|athlete management/i
const SELLER_NAME = /\b(?:league|association|federation|conference|ncaa|sports management|talent agency|athletes unlimited)\b/i

// A brand on the roster that is really a seller (a league, a sports
// agency): by name, or by the industry its discovery note recorded.
export function looksLikeSeller(name: string | null | undefined, notes?: string | null): boolean {
  return SELLER_NAME.test(String(name || '')) || /(?:—|,)\s*(?:spectator sports|sports teams)/i.test(String(notes || ''))
}

export function judgeDiscovery(
  c: { name: string; subtitle?: string | null },
  sourceCategory?: string | null,
): { ok: true; category: string; followers: number; industry: string } | { ok: false; reason: 'small' | 'industry' } {
  const followers = parseFollowers(c.subtitle)
  const industry = industryOf(c.subtitle)
  if (followers == null || followers < DISCOVER_MIN_FOLLOWERS) return { ok: false, reason: 'small' }
  if (!industry || NOT_A_BRAND.test(industry)) return { ok: false, reason: 'industry' }
  if (SELLS_SPONSORSHIP.test(industry) || SELLER_NAME.test(c.name)) return { ok: false, reason: 'industry' }
  if (sourceCategory && industryFits(sourceCategory, industry)) return { ok: true, category: sourceCategory, followers, industry }
  const cat = categoryFromIndustry(industry)
  if (!cat) return { ok: false, reason: 'industry' }
  return { ok: true, category: cat, followers, industry }
}

// A LinkedIn page name as a brand name: without its company suffix or
// web address ("Abercrombie & Fitch Co." → "Abercrombie & Fitch",
// "PrettyLittleThing.com" → "PrettyLittleThing").
export function cleanBrandName(name: string | null | undefined): string {
  let s = String(name || '').replace(/\s+/g, ' ').trim()
  for (let i = 0; i < 3; i++) {
    const t = s.replace(/,?\s+(?:inc\.?|llc\.?|ltd\.?|co\.|corp\.?)$/i, '').replace(/\.(?:com|net|io)$/i, '').trim()
    if (t === s) break
    s = t
  }
  return s || String(name || '').trim()
}

// A name from the research list (Stock take's lane ideas) looked up on
// LinkedIn. Stricter than a brand we already have: the page's industry
// must fit the lane's category even for an exact name, because a list
// name is only a word until LinkedIn shows it's the brand ("NOS" is also
// a telecom; "Hydrant" also sells fire hydrants).
export function decideResearchMatch(
  item: { name: string; aka?: string | null; category: string },
  candidates: LiCompany[],
): { pick: LiCompany | null; reason: 'exact' | 'near' | 'unclear' | 'none' } {
  if (!candidates.length) return { pick: null, reason: 'none' }
  const fitting = candidates.filter(c => industryFits(item.category, c.subtitle))
  if (!fitting.length) return { pick: null, reason: 'unclear' }
  return decideCompanyMatch(item, fitting)
}
