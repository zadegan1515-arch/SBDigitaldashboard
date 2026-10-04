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

import { normalizeCompany, parseFollowers, refusedWhy, type LiCompany, type NotBuyerWhy } from './li-capture'

export type Parent = {
  name: string          // how it reads in the dashboard
  search: string        // what to type into LinkedIn's company search
  aka?: string[]        // other names its page may have
  brands: string[]      // 'Name|Other name'
  // More of its brands, only to recognise someone who works on one of
  // them ("Brand Manager, Crown Royal" in Diageo's search for Ketel One).
  others?: string[]
}

export const PARENTS: Parent[] = [
  { name: 'Diageo', search: 'Diageo', brands: [
    'Smirnoff', 'Smirnoff Ice', 'Captain Morgan', 'Ketel One', 'Tanqueray', 'Crown Royal', 'Cîroc|Ciroc',
    'Bulleit', 'Don Julio', 'Casamigos', 'DeLeón Tequila|DeLeon', 'Aviation Gin', 'Johnnie Walker', 'Guinness', 'Baileys'],
    others: ["Buchanan's", 'Old Parr', 'Zacapa', "Seagram's", 'J&B', 'Astral', '21Seeds', 'Lagavulin', 'Talisker', "Gordon's", 'Rumple Minze', 'Ketel One Botanical'] },
  { name: 'Pernod Ricard', search: 'Pernod Ricard', brands: ['Jameson', 'Absolut', 'Malibu', 'Kahlúa|Kahlua', 'Beefeater', 'Avión|Avion'],
    others: ['Glenlivet', 'Chivas', 'Martell', 'Monkey 47', 'Lillet', 'Altos', 'Código|Codigo', 'Skrewball', 'Mumm', 'Perrier-Jouët|Perrier Jouet', 'Rabbit Hole'] },
  { name: 'Bacardi', search: 'Bacardi', brands: ['Bacardi', 'Grey Goose', 'Patrón', 'Bombay Sapphire', "Dewar's", 'Cazadores'],
    others: ["D'USSÉ|DUSSE", 'Martini', 'St-Germain|St Germain', "Angel's Envy", 'Teeling', 'Corazón|Corazon', 'Santa Teresa', 'Ilegal', 'Bombay'] },
  { name: 'Brown-Forman', search: 'Brown-Forman', brands: ["Jack Daniel's", 'Woodford Reserve', 'Old Forester', 'el Jimador', 'Herradura'],
    others: ['Gentleman Jack', 'Diplomático|Diplomatico', 'Chambord', 'Fords Gin', 'Glendronach', 'Benriach', 'Gin Mare'] },
  { name: 'Suntory Global Spirits', search: 'Suntory Global Spirits', aka: ['Beam Suntory'], brands: [
    'Jim Beam', "Maker's Mark", 'Hornitos', 'Sauza', 'Knob Creek', 'Basil Hayden'],
    others: ['Laphroaig', 'Hibiki', 'Yamazaki', 'Toki', 'Roku', 'Haku', 'Canadian Club', "Teacher's", 'Effen', 'On The Rocks', '-196', 'Midori', 'Sipsmith', 'Legent', "Booker's", 'Old Grand-Dad', 'Larios', 'Tres Generaciones', 'DeKuyper', 'Cruzan'] },
  { name: 'Campari Group', search: 'Campari Group', brands: ['Aperol', 'Campari', 'Espolòn|Espolon', 'Wild Turkey', 'SKYY'],
    others: ['Appleton', 'Grand Marnier', 'Courvoisier', 'Montelobos', 'Cinzano', 'Cynar', 'Averna', 'Bulldog Gin', "Russell's Reserve"] },
  { name: 'Proximo Spirits', search: 'Proximo Spirits', brands: ['Jose Cuervo', '1800 Tequila|1800', 'Kraken Rum|Kraken', 'Hangar 1'],
    others: ['Dobel', 'Gran Centenario', 'Bushmills', 'Three Olives', "Stranahan's", 'Proper No. Twelve|Proper 12', 'Pendleton', 'Boodles'] },
  { name: 'Sazerac', search: 'Sazerac Company', aka: ['Sazerac'], brands: ['Fireball', 'Buffalo Trace', 'Pinnacle Vodka|Pinnacle', 'Southern Comfort'],
    others: ['BuzzBallz', 'Svedka', 'Paul Masson', "Myers's", 'Eagle Rare', 'Pappy Van Winkle', "Blanton's", 'Weller', 'Taaka', 'Wheatley', '99 Brand|99 Schnapps'] },
  { name: 'E. & J. Gallo', search: 'E. & J. Gallo Winery', aka: ['E&J Gallo Winery', 'Gallo'], brands: ['New Amsterdam', 'Pink Whitney', 'High Noon'],
    others: ['Barefoot', 'Apothic', 'Dark Horse', 'La Marca', 'Familia Camarena', 'Hoxie', 'Black Box'] },
  { name: 'Moët Hennessy', search: 'Moët Hennessy', aka: ['Moet Hennessy'], brands: ['Hennessy', 'Belvedere'],
    others: ['Moët|Moet', 'Dom Pérignon|Dom Perignon', 'Veuve Clicquot', 'Glenmorangie', 'Ardbeg', 'Volcán De Mi Tierra|Volcan', 'Chandon', 'Whispering Angel', 'Krug', 'Ruinart'] },
  { name: 'Rémy Cointreau', search: 'Rémy Cointreau', aka: ['Remy Cointreau'], brands: ['Rémy Martin|Remy Martin', 'Cointreau'],
    others: ['Louis XIII', 'Mount Gay', 'The Botanist', 'Bruichladdich', 'St-Rémy|St Remy'] },
  { name: 'William Grant & Sons', search: 'William Grant & Sons', brands: ["Hendrick's Gin|Hendrick's", 'Glenfiddich', 'Sailor Jerry', 'Monkey Shoulder'],
    others: ["Grant's", 'Balvenie', 'Tullamore D.E.W.|Tullamore Dew', 'Reyka', 'Drambuie', 'Milagro'] },
  { name: 'Heaven Hill', search: 'Heaven Hill Brands', aka: ['Heaven Hill Distillery'], brands: ['Deep Eddy Vodka|Deep Eddy', 'Evan Williams', 'Elijah Craig'],
    others: ['Larceny', 'Pikesville', 'Christian Brothers', 'Hpnotiq', 'PAMA', "Burnett's", 'Admiral Nelson', 'Lunazul', 'Rittenhouse'] },
  { name: 'Mark Anthony Brands', search: 'Mark Anthony Brands', brands: ['White Claw', "Mike's Hard Lemonade|Mike's"],
    others: ['Cayman Jack', "Mike's Harder"] },
  { name: 'Anheuser-Busch', search: 'Anheuser-Busch', brands: ['Bud Light', 'Michelob Ultra', 'Busch Light', 'Natural Light|Natty Light', 'Stella Artois', 'Cutwater Spirits|Cutwater', 'Goose Island'],
    others: ['Budweiser', 'Michelob', 'Busch', 'Stella', 'NÜTRL|Nutrl', 'Golden Road', 'Elysian', 'Shock Top', 'Babe Wine', 'Kona'] },
  { name: 'Molson Coors', search: 'Molson Coors Beverage Company', aka: ['Molson Coors'], brands: ['Coors Light', 'Miller Lite', 'Keystone Light', 'Blue Moon', 'Vizzy'],
    others: ['Coors Banquet', 'Miller High Life', 'Miller Genuine Draft', "Leinenkugel's", 'Topo Chico Hard Seltzer', 'Simply Spiked', 'ZOA', 'Peroni', "Hamm's"] },
  { name: 'Constellation Brands', search: 'Constellation Brands', brands: ['Modelo', 'Corona', 'Pacifico'],
    others: ['Modelo Especial', 'Corona Extra', 'Corona Premier', 'Victoria', 'Casa Noble', 'High West', 'Kim Crawford', 'Meiomi', 'The Prisoner', 'Robert Mondavi'] },
  { name: 'HEINEKEN USA', search: 'HEINEKEN USA', aka: ['Heineken'], brands: ['Heineken', 'Dos Equis', 'Tecate'],
    others: ['Amstel', 'Lagunitas', 'Strongbow', 'Bohemia'] },
  { name: 'Boston Beer Company', search: 'The Boston Beer Company', aka: ['Boston Beer'], brands: ['Truly', 'Twisted Tea', 'Samuel Adams|Sam Adams', 'Dogfish Head'],
    others: ['Angry Orchard', 'Sun Cruiser', 'Hard Mountain Dew', "Jack's Abby"] },
  { name: 'Monster Beverage', search: 'Monster Beverage Corporation', aka: ['Monster Beverage', 'Monster Energy'], brands: ['Monster Energy|Monster', 'Reign|Reign Total Body Fuel', 'NOS Energy|NOS', 'Bang Energy|Bang'],
    others: ['Full Throttle', 'Predator', 'The Beast Unleashed', 'Nasty Beast'] },
  { name: 'PepsiCo', search: 'PepsiCo', brands: ['Rockstar Energy|Rockstar', 'Gatorade', 'Propel'],
    others: ['Mountain Dew|MTN DEW', 'Pepsi', 'Starry', 'bubly', 'Lipton', 'Pure Leaf', 'Doritos', "Lay's", 'Cheetos', 'Tostitos', 'Quaker', 'Sabra', 'Muscle Milk', 'Poppi', 'Siete'] },
  { name: 'The Coca-Cola Company', search: 'The Coca-Cola Company', aka: ['Coca-Cola'], brands: ['Powerade', 'BodyArmor', 'Vitaminwater', 'Smartwater'],
    others: ['Coca-Cola|Coke', 'Sprite', 'Fanta', 'Dasani', 'Minute Maid', 'Topo Chico', 'Fairlife', 'Gold Peak'] },
  { name: 'Keurig Dr Pepper', search: 'Keurig Dr Pepper', brands: ['CORE Hydration|Core Water', 'Ghost Energy|Ghost'],
    others: ['Dr Pepper', 'Canada Dry', '7UP|7 Up', 'Snapple', 'Bai', 'A&W', 'Sunkist', 'Squirt', 'Green Mountain', "Mott's", 'Clamato', 'Hawaiian Punch'] },
  { name: 'National Beverage Corp.', search: 'National Beverage Corp.', aka: ['National Beverage'], brands: ['Rip It', 'LaCroix'],
    others: ['Shasta', 'Faygo', 'Everfresh'] },
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

// The words of a name, for whole-word finding ("Sol" isn't in "Solutions").
function words(s: string | null | undefined): string {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// Someone at the parent who works on a different one of its brands:
// their title names that brand and not this one ("Brand Manager, Crown
// Royal" in Diageo's search for Ketel One — LinkedIn's keyword search
// matches anywhere on a profile, so past work brings them up). Returns
// the other brand's name, or null. A name inside this brand's own
// ("Busch" in "Busch Light") never counts against it.
export function siblingNamed(text: string | null | undefined, brandName: string, aka?: string | null): string | null {
  const parent = parentOf(brandName, aka)
  if (!parent) return null
  const t = ' ' + words(text) + ' '
  if (t.trim() === '') return null
  const ours = [brandName, ...String(aka || '').split(/[,;]/)].map(words).filter(Boolean)
  const has = (k: string) => t.includes(' ' + k + ' ')
  for (const o of ours) if (has(o)) return null
  // "Bacardi" or "Campari" in a title is the company as much as the
  // brand of that name: never held against a sister brand.
  const company = [parent.name, parent.search, ...(parent.aka || [])].map(words).filter(Boolean)
  for (const b of [...parent.brands, ...(parent.others || [])]) {
    for (const n of b.split('|')) {
      const k = words(n)
      if (!k || ours.some(o => o.includes(k) || k.includes(o)) || company.some(c => (' ' + c + ' ').includes(' ' + k + ' '))) continue
      if (has(k)) return b.split('|')[0]
    }
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

// A saved title the October rules would have left on LinkedIn, and why:
// student / store / outside (investor, board, adviser, another company's
// leader) / notMarketing, or sibling = works on another of the parent's
// brands (named in `other`). For the clean-up on Outreach → People.
export function whyLeaveOut(
  title: string | null | undefined, brandName: string, aka?: string | null,
): { why: NotBuyerWhy | 'sibling'; other?: string } | null {
  const parent = parentOf(brandName, aka)
  const names = [brandName, ...String(aka || '').split(/[,;]/).map(x => x.trim()).filter(Boolean),
    ...(parent ? [parent.name, parent.search, ...(parent.aka || [])] : [])]
  const why = refusedWhy(title, names)
  if (why) return { why }
  const other = siblingNamed(title, brandName, aka)
  return other ? { why: 'sibling', other } : null
}
