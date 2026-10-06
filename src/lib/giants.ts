// Leo, Oct 6 2026: "giants we should reject". The brand finders (the
// daily Claude hunt and the LinkedIn run's lookalikes) never add a
// household-name giant: their sponsorship budgets go through big agencies,
// not a college-show agency. Brands already on the roster are untouched —
// this only stops new ones coming in.
//
// A giant is any of:
//  - a household name below (one spelling per entry, 'A|B' = also known as),
//  - a brand owned by one of the big parent companies in parents.ts
//    (Diageo, Pernod Ricard, Bacardi, Monster…) or the parent itself,
//  - $1B+ a year in sales (when the finder reports it),
//  - 1M+ LinkedIn followers.
// node scripts/test-giants.mjs

import { brandKey } from './stock'
import { PARENTS } from './parents'

export const GIANT_SALES_USD = 1_000_000_000
export const GIANT_LI_FOLLOWERS = 1_000_000

export const GIANT_NAMES: string[] = [
  // energy / sports drinks / electrolytes
  'Red Bull', 'Monster Energy|Monster', 'Rockstar Energy|Rockstar', 'Celsius', 'Gatorade', 'Powerade', 'BodyArmor|Body Armor',
  'Propel', 'Vitaminwater|Vitamin Water', 'Pedialyte', 'Liquid I.V.|Liquid IV', 'Prime Hydration|Prime',
  // soda / water / coffee
  'Coca-Cola|Coca Cola|Coke', 'Pepsi', 'Sprite', 'Mountain Dew', 'Dr Pepper', 'Fanta', '7UP|7 Up', 'Dasani', 'Aquafina',
  'smartwater|Smart Water', 'Poland Spring', 'Starbucks', 'Dunkin|Dunkin\'',
  // beer / seltzer / RTD
  'Budweiser', 'Bud Light', 'Michelob Ultra|Michelob', 'Busch', 'Natural Light', 'Coors|Coors Light', 'Miller Lite|Miller',
  'Corona', 'Modelo', 'Pacifico', 'Heineken', 'Stella Artois', 'Blue Moon', 'White Claw', 'Truly', 'Twisted Tea',
  'Mike\'s Hard Lemonade|Mikes Hard Lemonade', 'High Noon', 'Anheuser-Busch|AB InBev', 'Molson Coors', 'Constellation Brands',
  // spirits not under a parent below
  'Tito\'s|Titos|Tito\'s Handmade Vodka', 'Fireball',
  // apparel / athletic / beauty
  'Nike', 'Adidas', 'Under Armour', 'Puma', 'New Balance', 'Reebok', 'Lululemon', 'Skechers', 'Champion', 'The North Face|North Face',
  'Levi\'s|Levis', 'Gap', 'Old Navy', 'H&M', 'Zara', 'Shein', 'Abercrombie & Fitch|Abercrombie', 'American Eagle', 'Victoria\'s Secret',
  'L\'Oréal|L\'Oreal|Loreal', 'Maybelline', 'Dove', 'Axe', 'Old Spice', 'Gillette', 'Procter & Gamble|P&G', 'Unilever',
  // nicotine / betting
  'Zyn', 'Juul', 'Marlboro', 'Altria', 'Philip Morris', 'Copenhagen', 'Skoal', 'DraftKings', 'FanDuel',
]

let KEYS: Map<string, string> | null = null
function keys(): Map<string, string> {
  if (KEYS) return KEYS
  const m = new Map<string, string>()
  const add = (spellings: string, why: string) => {
    for (const n of spellings.split('|')) { const k = brandKey(n); if (k && !m.has(k)) m.set(k, why) }
  }
  for (const g of GIANT_NAMES) add(g, 'a household name')
  for (const p of PARENTS) {
    add([p.name, ...(p.aka || [])].join('|'), 'a parent company')
    for (const b of [...p.brands, ...(p.others || [])]) add(b, 'owned by ' + p.name)
  }
  KEYS = m
  return m
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? n : null
}

// Why this is a giant, or null. Names are matched on brandKey, so
// "Monster Energy Co." / "monster-energy" find "Monster Energy".
export function giantWhy(
  name: string | null | undefined,
  opts: { aka?: string | null; salesUsd?: unknown; followers?: unknown } = {},
): string | null {
  const m = keys()
  for (const n of [name, ...String(opts.aka ?? '').split(/[,;]/)]) {
    const k = brandKey(n || '')
    if (k && m.has(k)) return m.get(k)!
  }
  const sales = num(opts.salesUsd)
  if (sales != null && sales >= GIANT_SALES_USD) return '$1B+ in sales'
  const f = num(opts.followers)
  if (f != null && f >= GIANT_LI_FOLLOWERS) return '1M+ LinkedIn followers'
  return null
}
