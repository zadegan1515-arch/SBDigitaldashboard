// src/lib/parents.ts
//
// Brands whose people work under their parent company's LinkedIn page
// (Leo, Sep 30, after a run where 26 research names — Ketel One,
// Tanqueray, Jameson, Fireball… — had no page of their own, and Smirnoff
// or Captain Morgan showed nobody). The LinkedIn fill looks such a brand
// up on its parent's People tab with the brand's name as the keyword
// ("Captain Morgan" at Diageo) — its brand managers — whenever the
// brand's own page gives nobody. The people are saved under the brand.
//
// Only ownership we're sure of goes here: a wrong parent costs a search
// that finds nobody, never a wrong person — the keyword is the brand's
// own name. Names match loosely (brandKey): "Ciroc" is "Cîroc".

import { normalizeCompany, parseFollowers, type LiCompany } from './li-capture'

export type Parent = {
  name: string          // how it reads in the dashboard
  search: string        // what to type into LinkedIn's company search
  aka?: string[]        // other names its page may have
  brands: string[]      // 'Name|Other name'
}

export const PARENTS: Parent[] = [
  { name: 'Diageo', search: 'Diageo', brands: [
    'Smirnoff', 'Smirnoff Ice', 'Captain Morgan', 'Ketel One', 'Tanqueray', 'Crown Royal', 'Cîroc|Ciroc',
    'Bulleit', 'Don Julio', 'Casamigos', 'DeLeón Tequila|DeLeon', 'Aviation Gin', 'Johnnie Walker', 'Guinness', 'Baileys'] },
  { name: 'Pernod Ricard', search: 'Pernod Ricard', brands: ['Jameson', 'Absolut', 'Malibu', 'Kahlúa|Kahlua', 'Beefeater', 'Avión|Avion'] },
  { name: 'Bacardi', search: 'Bacardi', brands: ['Bacardi', 'Grey Goose', 'Patrón', 'Bombay Sapphire', "Dewar's", 'Cazadores'] },
  { name: 'Brown-Forman', search: 'Brown-Forman', brands: ["Jack Daniel's", 'Woodford Reserve', 'Old Forester', 'el Jimador', 'Herradura'] },
  { name: 'Suntory Global Spirits', search: 'Suntory Global Spirits', aka: ['Beam Suntory'], brands: [
    'Jim Beam', "Maker's Mark", 'Hornitos', 'Sauza', 'Knob Creek', 'Basil Hayden'] },
  { name: 'Campari Group', search: 'Campari Group', brands: ['Aperol', 'Campari', 'Espolòn|Espolon', 'Wild Turkey', 'SKYY'] },
  { name: 'Proximo Spirits', search: 'Proximo Spirits', brands: ['Jose Cuervo', '1800 Tequila|1800', 'Kraken Rum|Kraken', 'Hangar 1'] },
  { name: 'Sazerac', search: 'Sazerac Company', aka: ['Sazerac'], brands: ['Fireball', 'Buffalo Trace', 'Pinnacle Vodka|Pinnacle', 'Southern Comfort'] },
  { name: 'E. & J. Gallo', search: 'E. & J. Gallo Winery', aka: ['E&J Gallo Winery', 'Gallo'], brands: ['New Amsterdam', 'Pink Whitney', 'High Noon'] },
  { name: 'Moët Hennessy', search: 'Moët Hennessy', aka: ['Moet Hennessy'], brands: ['Hennessy', 'Belvedere'] },
  { name: 'Rémy Cointreau', search: 'Rémy Cointreau', aka: ['Remy Cointreau'], brands: ['Rémy Martin|Remy Martin', 'Cointreau'] },
  { name: 'William Grant & Sons', search: 'William Grant & Sons', brands: ["Hendrick's Gin|Hendrick's", 'Glenfiddich', 'Sailor Jerry', 'Monkey Shoulder'] },
  { name: 'Heaven Hill', search: 'Heaven Hill Brands', aka: ['Heaven Hill Distillery'], brands: ['Deep Eddy Vodka|Deep Eddy', 'Evan Williams', 'Elijah Craig'] },
  { name: 'Mark Anthony Brands', search: 'Mark Anthony Brands', brands: ['White Claw', "Mike's Hard Lemonade|Mike's"] },
  { name: 'Anheuser-Busch', search: 'Anheuser-Busch', brands: ['Bud Light', 'Michelob Ultra', 'Busch Light', 'Natural Light|Natty Light', 'Stella Artois', 'Cutwater Spirits|Cutwater', 'Goose Island'] },
  { name: 'Molson Coors', search: 'Molson Coors Beverage Company', aka: ['Molson Coors'], brands: ['Coors Light', 'Miller Lite', 'Keystone Light', 'Blue Moon', 'Vizzy'] },
  { name: 'Constellation Brands', search: 'Constellation Brands', brands: ['Modelo', 'Corona', 'Pacifico'] },
  { name: 'HEINEKEN USA', search: 'HEINEKEN USA', aka: ['Heineken'], brands: ['Heineken', 'Dos Equis', 'Tecate'] },
  { name: 'Boston Beer Company', search: 'The Boston Beer Company', aka: ['Boston Beer'], brands: ['Truly', 'Twisted Tea', 'Samuel Adams|Sam Adams', 'Dogfish Head'] },
  { name: 'Monster Beverage', search: 'Monster Beverage Corporation', aka: ['Monster Beverage', 'Monster Energy'], brands: ['Monster Energy|Monster', 'Reign|Reign Total Body Fuel', 'NOS Energy|NOS', 'Bang Energy|Bang'] },
  { name: 'PepsiCo', search: 'PepsiCo', brands: ['Rockstar Energy|Rockstar', 'Gatorade', 'Propel'] },
  { name: 'The Coca-Cola Company', search: 'The Coca-Cola Company', aka: ['Coca-Cola'], brands: ['Powerade', 'BodyArmor', 'Vitaminwater', 'Smartwater'] },
  { name: 'Keurig Dr Pepper', search: 'Keurig Dr Pepper', brands: ['CORE Hydration|Core Water', 'Ghost Energy|Ghost'] },
  { name: 'National Beverage Corp.', search: 'National Beverage Corp.', aka: ['National Beverage'], brands: ['Rip It', 'LaCroix'] },
]

// The same loose key Stock take uses (kept here so this file stays pure).
function looseKey(s: string | null | undefined): string {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\b(inc|llc|ltd|co|corp|company|the|brands?|group|holdings?|beverages?)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '')
}

const BY_KEY = new Map<string, Parent>()
for (const p of PARENTS) {
  for (const b of p.brands) for (const n of b.split('|')) {
    const k = looseKey(n)
    if (k && !BY_KEY.has(k)) BY_KEY.set(k, p)
  }
}

// The parent whose page a brand's people are under, by its name or any
// "also known as". A brand that IS the parent's namesake (Bacardi) has its
// own page first; the parent is only where it looks when that gives nobody.
export function parentOf(name: string | null | undefined, aka?: string | null): Parent | null {
  for (const n of [name, ...String(aka || '').split(/[,;]/)]) {
    const p = BY_KEY.get(looseKey(n))
    if (p) return p
  }
  return null
}

// Which search result is the parent's own page: its name (or another name
// it goes by) exactly — the most followed when several share it, since
// the company's real page dwarfs fan pages and namesakes.
export function decideParentPage(parent: Parent, candidates: LiCompany[]): LiCompany | null {
  const names = [parent.search, parent.name, ...(parent.aka || [])].map(normalizeCompany).filter(Boolean)
  const exact = candidates.filter(c => c && c.slug && names.includes(normalizeCompany(c.name)))
  if (!exact.length) return null
  let best = exact[0], bestN = parseFollowers(best.subtitle) ?? -1
  for (const c of exact.slice(1)) {
    const n = parseFollowers(c.subtitle) ?? -1
    if (n > bestN) { best = c; bestN = n }
  }
  return best
}

export const LI_PARENT_PAGES_KEY = 'liParentPages'
