// Where someone works — the US or abroad — and where a company is based,
// from what we have on file (Leo, Oct 18 2026, on Reach out again picking a
// "UK Partnerships Manager": skip people outside the US "unless the company
// is based outside the us").
//
//   • a title that names a region: "UK Partnerships Manager", "Director
//     Partnerships DACH", "General Manager APAC", "… - Canada & Latin
//     America" → abroad; "Head of Partnerships, North America" → the US;
//   • a person's location (the SponsorUnited capture: "Austin, Texas, United
//     States", "Tokyo, Japan", "Long Crendon, England, United Kingdom",
//     "San Diego, CA", "Greater Philadelphia");
//   • a company: its hq when it has one, else where its people on file are —
//     based abroad when more of them are abroad than in the US. Not known =
//     the US (most of the roster), so abroad people stay out.
//
// Pure. node scripts/test-abroad.mjs

export type Where = 'us' | 'abroad' | null

const US_STATES = [
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'florida', 'georgia',
  'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland',
  'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada',
  'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma',
  'oregon', 'pennsylvania', 'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas', 'utah',
  'vermont', 'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming', 'district of columbia', 'puerto rico',
]
const US_ABBR = new Set(('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY ' +
  'NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR').split(' '))
// Cities and areas a location names without its state ("Greater Philadelphia",
// "Los Angeles Metropolitan Area", "Tampa Bay", "Bay Area").
const US_PLACES = [
  'new york city', 'nyc', 'manhattan', 'brooklyn', 'los angeles', 'san francisco', 'bay area', 'silicon valley', 'chicago',
  'houston', 'dallas', 'fort worth', 'austin', 'san antonio', 'phoenix', 'philadelphia', 'san diego', 'san jose', 'seattle',
  'denver', 'boston', 'nashville', 'miami', 'atlanta', 'tampa', 'orlando', 'portland', 'las vegas', 'detroit',
  'minneapolis', 'charlotte', 'raleigh', 'salt lake', 'st. louis', 'saint louis', 'kansas city', 'pittsburgh',
  'cincinnati', 'cleveland', 'columbus', 'indianapolis', 'baltimore', 'new orleans', 'honolulu', 'sacramento',
  'hoboken', 'jersey city', 'orange county', 'scottsdale', 'boulder', 'park city', 'charleston', 'savannah',
]
// Countries, regions and the big cities abroad. (Not Georgia — a US state
// more often than not here — nor Jordan or Turkey, which are names and food.)
const ABROAD_WORDS = [
  'united kingdom', 'england', 'scotland', 'wales', 'northern ireland', 'ireland', 'germany', 'france', 'spain',
  'italy', 'netherlands', 'holland', 'belgium', 'switzerland', 'austria', 'sweden', 'norway', 'denmark', 'finland',
  'iceland', 'poland', 'portugal', 'greece', 'czech republic', 'czechia', 'hungary', 'romania', 'bulgaria', 'croatia',
  'serbia', 'ukraine', 'russia', 'luxembourg', 'canada', 'mexico', 'brazil', 'argentina', 'chile', 'colombia', 'peru',
  'venezuela', 'ecuador', 'uruguay', 'costa rica', 'panama', 'puerto vallarta', 'australia', 'new zealand', 'japan',
  'china', 'hong kong', 'taiwan', 'south korea', 'korea', 'singapore', 'india', 'pakistan', 'bangladesh', 'indonesia',
  'philippines', 'thailand', 'vietnam', 'malaysia', 'united arab emirates', 'saudi arabia', 'qatar', 'israel',
  'egypt', 'south africa', 'nigeria', 'kenya', 'morocco',
  'europe', 'european', 'latin america', 'south america', 'central america', 'asia', 'asia pacific', 'asia-pacific',
  'middle east', 'africa', 'nordics', 'nordic', 'benelux', 'iberia', 'scandinavia', 'oceania',
  'london', 'manchester', 'toronto', 'vancouver', 'montreal', 'calgary', 'ottawa', 'berlin', 'munich', 'hamburg',
  'cologne', 'frankfurt', 'paris', 'madrid', 'barcelona', 'lisbon', 'amsterdam', 'rotterdam', 'brussels', 'dublin',
  'zurich', 'geneva', 'vienna', 'stockholm', 'oslo', 'copenhagen', 'helsinki', 'milan', 'rome', 'warsaw', 'prague',
  'sydney', 'melbourne', 'brisbane', 'auckland', 'tokyo', 'osaka', 'shanghai', 'beijing', 'shenzhen', 'seoul',
  'mumbai', 'bangalore', 'bengaluru', 'delhi', 'dubai', 'abu dhabi', 'tel aviv', 'sao paulo', 'são paulo',
  'mexico city', 'guadalajara', 'bogota', 'bogotá', 'buenos aires', 'santiago', 'lima', 'kassel',
]
// Codes only as capitals ("UK", not "uk"): "CA" is never here — in a
// location it's California.
const ABROAD_CODES = /\b(?:UK|U\.K\.|EMEA|APAC|LATAM|LatAm|DACH|ANZ|UAE|EU|GB|CEE|MENA)\b/
const US_TITLE = /\b(?:US|U\.S\.|USA|U\.S\.A\.|United States|North America|North American|NA|Americas)\b/

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const wordsRe = (list: string[]) => new RegExp('\\b(?:' + list.map(esc).sort((a, b) => b.length - a.length).join('|') + ')\\b', 'i')
const ABROAD_RE = wordsRe(ABROAD_WORDS)
const US_STATE_RE = wordsRe(US_STATES)
const US_PLACE_RE = wordsRe(US_PLACES)
const US_WORD_RE = /\b(?:united states|usa|u\.s\.a?\.?|us)\b/i

// The region a title names, with the brand's own names taken out first
// ("Brand Manager, Canada Dry" names no country).
export function titleWhere(title: string | null | undefined, brandNames: string[] = []): Where {
  let t = String(title ?? '')
  for (const n of brandNames) if (n && n.length > 1) t = t.replace(new RegExp(esc(n), 'gi'), ' ')
  if (!t.trim()) return null
  if (US_TITLE.test(t)) return 'us'
  // "Latin America" names abroad even though it ends in "America".
  if (ABROAD_CODES.test(t) || ABROAD_RE.test(t)) return 'abroad'
  return null
}

// A location as people write it on LinkedIn / SponsorUnited.
export function locationWhere(loc: string | null | undefined): Where {
  const s = String(loc ?? '').trim()
  if (!s) return null
  if (US_WORD_RE.test(s)) return 'us'
  // "New Mexico" and "Georgia" are states; check the US first.
  if (US_STATE_RE.test(s) || US_PLACE_RE.test(s)) return 'us'
  const parts = s.split(',').map(p => p.trim())
  if (parts.length > 1 && US_ABBR.has(parts[parts.length - 1].toUpperCase()) && /^[A-Za-z]{2}$/.test(parts[parts.length - 1])) return 'us'
  if (ABROAD_RE.test(s) || ABROAD_CODES.test(s)) return 'abroad'
  return null
}

// Where one person works: a region in their title says it, else where they are.
export function personWhere(p: { title: string | null; location?: string | null }, brandNames: string[] = []): Where {
  return titleWhere(p.title, brandNames) ?? locationWhere(p.location)
}

// Whether a company is based outside the US: its hq, else more of its
// people on file abroad than in the US (by where they are, not their titles —
// a US company's "Director Partnerships DACH" doesn't move it abroad).
export function basedAbroad(b: { hq?: string | null }, people: Array<{ location?: string | null }>): boolean {
  const hq = locationWhere(b.hq)
  if (hq) return hq === 'abroad'
  let us = 0, abroad = 0
  for (const p of people) {
    const w = locationWhere(p.location)
    if (w === 'us') us++
    else if (w === 'abroad') abroad++
  }
  return abroad > us
}
