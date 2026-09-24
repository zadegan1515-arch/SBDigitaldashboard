// src/lib/stock.ts
//
// Brands → Stock take: every brand on the site, sorted into the lanes SB
// sells, with where each one stands.
//
// Leo (Sep 2026): "I want to hit every category — electrolyte companies,
// alcohol, nicotine, clothing, athletic wear, all of that." The stored
// categories are coarser than that. Electrolytes sit in Energy Drinks &
// Beverages or in Health & Wellness (Liquid I.V. and LMNT were seeded
// there), athletic wear sits inside Apparel & Fashion, beer and tequila
// share Alcohol & RTD. The lanes split those without touching a record:
// this is a view, nothing here writes. Every brand lands in exactly one
// row, so the rows add up to the roster.
//
// Pure — no database, no network. route.ts (brandStock) counts, this
// sorts. scripts/test-stock.mjs pins where brands land.

export type StockState = 'business' | 'off' | 'replied' | 'reached' | 'ready' | 'needs'

// Pipeline order, furthest along first. "off" sits outside the pipeline.
export const STATES: StockState[] = ['business', 'replied', 'reached', 'ready', 'needs', 'off']

// One brand, already counted by route.ts.
export type StockBrand = {
  id: string
  name: string
  aka: string | null
  category: string | null
  tier: string | null
  about: string | null
  topProducts: string | null
  linkedinUrl: string | null
  externalId: string | null
  archived: boolean
  doNotEmail: boolean
  people: number        // contacts on file
  invited: number       // people whose LinkedIn invite went out
  accepted: number      // ...and who accepted it
  emailed: number       // people emailed, by the machine or by hand
  replied: number       // people who answered, on either channel
  queued: number        // waiting in the send queue, nothing sent yet
  dealStage: string | null
  activations: number
}

export type Lane = {
  key: string
  name: string
  // Categories a brand has to be filed under to land here — by name or
  // by words. Unfiled and "Needs Clarification" brands can land by name.
  from: string[]
  // Words in the name, aka, about or top products that put a brand here.
  words?: RegExp
  // Where whatever is left of this category goes once the lanes before
  // have taken theirs (apparel that isn't athletic is clothing).
  rest?: string
  // Brands that belong here by name. "A|B" = also known as. Doubles as
  // the "not on your list yet" ideas on the priority lanes.
  known: string[]
  // A lane Leo named. These lead the page and carry ideas.
  priority?: boolean
  // 21: the brand's own marketing code keeps it away from under-21
  // crowds, so these get pitched on 21+ shows.
  ageGate?: number
  // The category brands added from this lane's ideas are filed under.
  file: string
}

// How many brands a priority lane should have in play (not archived,
// not do-not-email) before it can carry its share of the schedule. A
// working number, not a rule: twenty invites a day at up to four people
// per brand is about five brands a sending day, so fifteen is three
// days of one lane before it repeats.
export const LANE_GOAL = 15

// Order matters: a brand takes the first lane that fits. Names before
// words, then electrolytes before energy (Prime makes both and sells as
// hydration), cans before spirits (Cutwater and High Noon are vodka in a
// can, and read as spirits by their words).
export const LANES: Lane[] = [
  {
    key: 'electrolytes', name: 'Electrolytes & hydration', priority: true, file: 'beverage',
    from: ['beverage', 'wellness'],
    words: /electrolyte|hydrat|sports drink/i,
    known: [
      'Liquid I.V.', 'LMNT', 'Prime Hydration|Prime', 'Electrolit', 'Gatorade',
      'BodyArmor', 'Pedialyte', 'DripDrop', 'Nuun', 'Waterboy',
      'Cure Hydration|Cure', 'Propel', 'Skratch Labs', 'Ultima Replenisher|Ultima',
      'Humantra', 'Leisure Hydration',
    ],
  },
  {
    key: 'energy', name: 'Energy drinks', priority: true, file: 'beverage',
    from: ['beverage'],
    words: /\benergy\b|caffeine/i,
    known: [
      'Celsius', 'Red Bull', 'Monster Energy|Monster', 'Ghost Energy|Ghost', 'Alani Nu',
      'Bloom Nutrition|Bloom', 'C4 Energy|C4', 'Reign|Reign Total Body Fuel',
      'Rockstar Energy|Rockstar', '5-hour Energy', 'Bang Energy|Bang',
      '3D Energy', 'ZOA Energy|ZOA', 'Raze Energy|Raze', 'Gorgie', 'Update',
    ],
  },
  {
    key: 'drinks', name: 'Soda, water & other drinks', file: 'beverage',
    from: ['beverage', 'wellness', 'nightlife'],
    rest: 'beverage',
    known: [
      'Poppi', 'Olipop', 'Culture Pop Soda|Culture Pop', 'Recess', 'Liquid Death',
      'Waterloo', 'Topo Chico', 'Spindrift', 'Zevia', 'AriZona|Arizona Iced Tea', 'A1R Water',
    ],
  },
  {
    key: 'rtd', name: 'Beer, seltzers & canned cocktails', priority: true, ageGate: 21, file: 'alcohol',
    from: ['alcohol', 'nightlife'],
    // Read against name/about/products. "Cocktails" alone isn't enough —
    // Malibu and Bacardi list canned cocktails among their products and
    // are spirits; they're caught by name first.
    words: /\bbeers?\b|\blager\b|\bales?\b|\bipa\b|brewing|brewery|hard seltzer|vodka seltzer|tequila seltzer|\bseltzers?\b|hard (iced )?tea|hard lemonade|hard cider|canned (agave |vodka |tequila |gin )?cocktails?|cocktail brand|\brtd\b|ready[- ]to[- ]drink|malt beverage|party punch|ranch water|long drink|spiked/i,
    known: [
      'White Claw', 'High Noon', 'Truly', 'Nutrl', 'Surfside', 'BuzzBallz', 'Mom Water',
      'SipMargs', 'Sprinter', 'Loverboy', 'Twisted Tea', 'Four Loko', 'BeatBox',
      'Happy Dad', 'Cutwater Spirits|Cutwater', 'Sun Cruiser', 'Carbliss',
      'Long Drink|The Finnish Long Drink', 'Cayman Jack', "Mike's Hard Lemonade|Mike's",
      'Lone River', 'Chica Chida', 'Simply Spiked',
      'Bud Light', 'Michelob Ultra', 'Coors Light', 'Miller Lite', 'Busch Light',
      'Natural Light|Natty Light', 'Keystone Light', 'Modelo', 'Corona', 'Pacifico',
      'Dos Equis', 'Heineken', 'Stella Artois', 'Blue Moon', 'Yuengling',
    ],
  },
  {
    key: 'spirits', name: 'Spirits', priority: true, ageGate: 21, file: 'alcohol',
    from: ['alcohol'],
    words: /tequila|vodka|whiske?y|bourbon|\brum\b|\bgin\b|mezcal|spirits|liqueur|cognac|scotch/i,
    known: [
      '818 Tequila|818 Spirits|818', 'Casamigos', 'Teremana', 'Espolòn', 'Patrón',
      'Don Julio', 'Jose Cuervo', "Tito's Handmade Vodka|Tito's", 'New Amsterdam', 'Smirnoff',
      'Absolut', 'Grey Goose', 'Svedka', 'Malibu', 'Captain Morgan', 'Bacardi',
      "Jack Daniel's", 'Jim Beam', 'Fireball', 'Jägermeister', 'Crown Royal',
      'Jameson', 'Lobos 1707',
    ],
  },
  {
    key: 'nicotine', name: 'Nicotine', priority: true, ageGate: 21, file: 'nicotine',
    from: ['nicotine'],
    rest: 'nicotine',
    known: [
      'Zyn', 'Velo', 'On!|On! Nicotine', 'Rogue', 'Lucy|Lucy Nicotine', 'Sesh+', 'FRE',
      'Juice Head', 'Black Buffalo',
    ],
  },
  {
    key: 'athletic', name: 'Athletic wear', priority: true, file: 'apparel',
    from: ['apparel'],
    words: /athletic|activewear|athleisure|sportswear|\bgym\b|fitness apparel|workout|training apparel|\byoga\b|running shoes|performance (apparel|polos?|wear)/i,
    known: [
      'Nike', 'Adidas', 'Lululemon', 'Gymshark', 'Under Armour', 'New Balance', 'Vuori',
      'Alo Yoga|Alo', 'Rhoback', 'Rhone', 'Ten Thousand', 'On Running', 'Hoka', 'Puma',
      'Fabletics', 'Set Active', 'Outdoor Voices', 'Buffbunny', 'Alphalete', 'Young LA', 'Nobull',
    ],
  },
  {
    key: 'clothing', name: 'Clothing & fashion', priority: true, file: 'apparel',
    from: ['apparel'],
    rest: 'apparel',
    known: [
      'Chubbies', 'True Classic', 'Vineyard Vines', 'Kulani Kinis', 'Revolve', 'Guess', 'Skims',
      'goodr', 'Fashion Nova', 'Princess Polly', 'White Fox|White Fox Boutique', 'Edikted',
      'Crocs', 'Hey Dude', 'Comfort Colors', 'Rowdy Gentleman', 'Shinesty', 'Tipsy Elves',
      'Birddogs', 'Southern Tide', 'Lilly Pulitzer', 'Show Me Your Mumu', 'Kendra Scott',
      'Hello Molly', 'American Eagle', 'Aerie', 'Hollister', 'PacSun',
      'Abercrombie & Fitch|Abercrombie', 'Urban Outfitters', 'Madhappy',
    ],
  },
]

// A leftover of a split category gets its own name, so "Alcohol & RTD"
// doesn't read as if it still held every beer and tequila.
const REST_NAMES: Record<string, string> = {
  alcohol: 'Alcohol — not sorted yet',
}

// Loose enough that "Liquid IV" meets "Liquid I.V." and "Nütrl" meets
// "Nutrl"; strips the corporate tail so "BeatBox Beverages" meets
// "BeatBox". Only ever compares whole names — never a substring.
export function brandKey(s: string | null | undefined): string {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\b(inc|llc|ltd|co|corp|company|the|brands?|group|holdings?|beverages?)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '')
}

const KNOWN: Record<string, Set<string>> = {}
for (const l of LANES) {
  KNOWN[l.key] = new Set(l.known.flatMap(k => k.split('|')).map(brandKey).filter(Boolean))
}

function keysOf(b: { name: string; aka: string | null }): string[] {
  return [b.name, ...String(b.aka ?? '').split(/[,;]/)].map(brandKey).filter(Boolean)
}

// The lane a brand sits in, or null when it stays in its category's row.
export function laneOf(b: Pick<StockBrand, 'name' | 'aka' | 'category' | 'about' | 'topProducts'>): string | null {
  const cat = b.category || 'unresolved'
  const byName = cat === 'unresolved'
  const keys = keysOf(b)
  for (const l of LANES) {
    if (!byName && !l.from.includes(cat)) continue
    if (keys.some(k => KNOWN[l.key].has(k))) return l.key
  }
  const text = [b.name, b.aka, b.about, b.topProducts].filter(Boolean).join(' · ')
  for (const l of LANES) {
    if (l.words && l.from.includes(cat) && l.words.test(text)) return l.key
  }
  for (const l of LANES) if (l.rest === cat) return l.key
  return null
}

// Where a brand stands. Doing business beats everything; then off
// outreach (archived, do-not-email — the same brands Needs contacts and
// the LinkedIn "Under 25" list leave out); then how far outreach got.
export function stateOf(b: Pick<StockBrand, 'name' | 'archived' | 'doNotEmail' | 'people' | 'invited' | 'emailed' | 'replied' | 'dealStage' | 'activations'>): StockState {
  if (b.activations > 0 || b.dealStage === 'verbal' || b.dealStage === 'closed') return 'business'
  if (b.archived || b.doNotEmail || /internal/i.test(b.name)) return 'off'
  if (b.replied > 0 || b.dealStage === 'conversation' || b.dealStage === 'proposal') return 'replied'
  if (b.invited > 0 || b.emailed > 0) return 'reached'
  if (b.people > 0) return 'ready'
  return 'needs'
}

// Furthest a brand's deals got. "lost" counts as nothing.
export function bestDealStage(stages: string[]): string | null {
  const order = ['closed', 'verbal', 'proposal', 'conversation']
  for (const s of order) if (stages.includes(s)) return s
  return null
}

type Counts = Record<StockState, number> & {
  total: number; people: number; under25: number; noProfile: number; touched: number
}

const zero = (): Counts => ({
  business: 0, replied: 0, reached: 0, ready: 0, needs: 0, off: 0,
  total: 0, people: 0, under25: 0, noProfile: 0, touched: 0,
})

function tally(c: Counts, b: StockBrand, state: StockState) {
  c[state] += 1
  c.total += 1
  c.people += b.people
  if (b.invited > 0 || b.emailed > 0) c.touched += 1
  if (state !== 'off' && state !== 'business') {
    if (b.people < 25) c.under25 += 1
    if (!b.externalId) c.noProfile += 1
  }
}

export type StockRow = {
  key: string
  // Lane name; null on a plain category row (the page labels those).
  name: string | null
  category: string | null
  priority: boolean
  ageGate: number | null
  file: string | null
  counts: Counts
  brands: Array<{
    id: string; name: string; category: string | null; tier: string | null; state: StockState
    people: number; invited: number; accepted: number; emailed: number; replied: number; queued: number
    dealStage: string | null; linkedinUrl: string | null; archived: boolean; doNotEmail: boolean
  }>
  ideas: string[]
}

export function buildStock(brands: StockBrand[]) {
  const rows = new Map<string, StockRow>()
  const row = (key: string, init: () => Omit<StockRow, 'counts' | 'brands' | 'ideas'>) => {
    let r = rows.get(key)
    if (!r) { r = { ...init(), counts: zero(), brands: [], ideas: [] }; rows.set(key, r) }
    return r
  }
  // Lanes first and always, so an empty lane still shows as empty.
  for (const l of LANES) {
    row(l.key, () => ({
      key: l.key, name: l.name, category: null, priority: !!l.priority,
      ageGate: l.ageGate ?? null, file: l.file,
    }))
  }

  const totals = zero()
  const categories = new Set<string>()
  const onRoster = new Set<string>()
  for (const b of brands) {
    for (const k of keysOf(b)) onRoster.add(k)
    if (b.category) categories.add(b.category)
    const state = stateOf(b)
    const lane = laneOf(b)
    const cat = b.category || 'uncategorised'
    const r = lane
      ? rows.get(lane)!
      : row('cat:' + cat, () => ({
          key: 'cat:' + cat, name: REST_NAMES[cat] ?? null, category: cat, priority: false,
          ageGate: null, file: cat === 'uncategorised' ? null : cat,
        }))
    tally(r.counts, b, state)
    tally(totals, b, state)
    r.brands.push({
      id: b.id, name: b.name, category: b.category, tier: b.tier, state,
      people: b.people, invited: b.invited, accepted: b.accepted, emailed: b.emailed,
      replied: b.replied, queued: b.queued, dealStage: b.dealStage,
      linkedinUrl: b.linkedinUrl, archived: b.archived, doNotEmail: b.doNotEmail,
    })
  }

  // Ideas: the priority lanes' known brands that aren't on the roster
  // under any name or aka.
  for (const l of LANES) {
    if (!l.priority) continue
    rows.get(l.key)!.ideas = l.known
      .filter(k => !k.split('|').some(a => onRoster.has(brandKey(a))))
      .map(k => k.split('|')[0])
  }

  const rank = (s: StockState) => STATES.indexOf(s)
  for (const r of rows.values()) {
    r.brands.sort((a, b) => rank(a.state) - rank(b.state) || a.name.localeCompare(b.name))
  }

  const all = [...rows.values()]
  const laneRows = all.filter(r => r.priority)
  // Everything else: the non-priority lanes and category rows, biggest
  // first; "Needs Clarification" and unfiled brands last.
  const tail = (r: StockRow) => (r.category === 'unresolved' || r.category === 'uncategorised' ? 1 : 0)
  const otherRows = all.filter(r => !r.priority && r.counts.total > 0)
    .sort((a, b) => tail(a) - tail(b) || b.counts.total - a.counts.total)

  return {
    goal: LANE_GOAL,
    totals: { ...totals, categories: categories.size },
    lanes: laneRows,
    others: otherRows,
  }
}
