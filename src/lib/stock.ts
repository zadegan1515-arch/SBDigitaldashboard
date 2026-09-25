// src/lib/stock.ts
//
// Brands → Stock take, and the categories Leo sells by.
//
// Leo (Sep 2026): "I want to hit every category — electrolyte companies,
// alcohol, nicotine, clothing, athletic wear, all of that", then "yes" to
// making those lanes real categories so the Schedule can run an
// Electrolytes day or an Athletic wear day. The old categories were
// coarser: Energy Drinks & Beverages held electrolytes, energy and soda
// (and Liquid I.V. and LMNT were seeded under Health & Wellness), Alcohol
// & RTD held beer and tequila, Apparel held gym wear and fashion.
//
// So each lane below IS a category: its key is what Brand.category holds.
// A brand still sitting in one of the old broad categories gets a
// suggested one (by its name first, then by what it sells), and
// refileMoves lists every brand that would move, for Leo to confirm on
// the Stock take page before anything is written. A brand filed under a
// specific category is never second-guessed: Leo's filing wins.
//
// Pure — no database, no network. route.ts counts and writes; this
// decides. scripts/test-stock.mjs pins where brands land.

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
  // The category key — what Brand.category holds for this lane.
  key: string
  name: string
  // Old broad categories whose brands can move here by what they sell
  // (the words). A brand's name moves it from any old broad category.
  from: string[]
  // Words in the name, aka, about or top products that put a brand here.
  words?: RegExp
  // Brands that belong here by name. "A|B" = also known as. Doubles as
  // the "not on your list yet" ideas on the priority lanes.
  known: string[]
  // A lane Leo named. These lead the Stock take and carry ideas.
  priority?: boolean
  // 21: the brand's own marketing code keeps it away from under-21
  // crowds, so these get pitched on 21+ shows.
  ageGate?: number
}

// How many brands a priority lane should have in play (not archived,
// not do-not-email) before it can carry its share of the schedule. A
// working number, not a rule: twenty invites a day at up to four people
// per brand is about five brands a sending day, so fifteen is three
// days of one lane before it repeats.
export const LANE_GOAL = 15

// The old broad categories — the only ones brands are ever sorted out
// of. Every other category (the new specific ones, and betting, snacks,
// beauty...) is a filing that stays as it is.
export const SORTABLE = ['beverage', 'alcohol', 'apparel', 'wellness', 'nightlife', 'unresolved']

// Order matters: a brand takes the first lane that fits. Names before
// words, then electrolytes before energy (Prime makes both and sells as
// hydration), cans before spirits (Cutwater and High Noon are vodka in a
// can, and read as spirits by their words).
export const LANES: Lane[] = [
  {
    key: 'electrolytes', name: 'Electrolytes & Hydration', priority: true,
    from: ['beverage', 'wellness'],
    words: /electrolyte|hydrat|sports drink/i,
    known: [
      'Liquid I.V.', 'LMNT', 'Prime Hydration|Prime', 'Electrolit', 'Gatorade',
      'BodyArmor', 'Pedialyte', 'DripDrop', 'Nuun', 'Waterboy',
      'Cure Hydration|Cure', 'Propel', 'Skratch Labs', 'Ultima Replenisher|Ultima',
      'Humantra', 'Leisure Hydration',
      // Added Sep 2026 as the LinkedIn run's research list (it looks each up).
      'Powerade', 'Vitaminwater', 'Vita Coco', 'CORE Hydration|Core Water', 'Essentia Water|Essentia',
      'Hydralyte', 'Hydrant', 'Tailwind Nutrition|Tailwind', 'Precision Fuel & Hydration',
      'Redmond Re-Lyte|Re-Lyte', 'Buoy Hydration|Buoy', 'Recover 180', 'Cirkul',
      'GoodSport Nutrition|GoodSport', 'SaltStick', 'Nooma', 'MiO',
    ],
  },
  {
    key: 'energy', name: 'Energy Drinks', priority: true,
    from: ['beverage'],
    words: /\benergy\b|caffeine/i,
    known: [
      'Celsius', 'Red Bull', 'Monster Energy|Monster', 'Ghost Energy|Ghost', 'Alani Nu',
      'Bloom Nutrition|Bloom', 'C4 Energy|C4', 'Reign|Reign Total Body Fuel',
      'Rockstar Energy|Rockstar', '5-hour Energy', 'Bang Energy|Bang',
      '3D Energy', 'ZOA Energy|ZOA', 'Raze Energy|Raze', 'Gorgie', 'Update',
      'G Fuel|GFUEL', 'Bucked Up', 'Gorilla Mind', 'Kill Cliff', 'Jocko Fuel',
      'Guayakí Yerba Mate|Guayaki', 'Yerbaé|Yerbae', 'NOS Energy|NOS', 'Uptime Energy|Uptime', 'Rip It',
      'Proper Wild', 'Hiball Energy|Hiball', 'Xyience',
    ],
  },
  {
    // What is left of the old Energy Drinks & Beverages keeps its key.
    key: 'beverage', name: 'Soda, Water & Other Drinks',
    from: [],
    known: [
      'Poppi', 'Olipop', 'Culture Pop Soda|Culture Pop', 'Recess', 'Liquid Death',
      'Waterloo', 'Topo Chico', 'Spindrift', 'Zevia', 'AriZona|Arizona Iced Tea', 'A1R Water',
    ],
  },
  {
    key: 'rtd', name: 'Beer, Seltzers & Canned Cocktails', priority: true, ageGate: 21,
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
      'Vizzy', 'Smirnoff Ice', 'Pabst Blue Ribbon|PBR', 'Athletic Brewing', 'Lagunitas', 'Sierra Nevada',
      'Goose Island', 'Kona Brewing|Kona', 'Dogfish Head', 'JuneShine', 'Arnold Palmer Spiked',
      'Guinness', 'Samuel Adams|Sam Adams', 'Rolling Rock', 'Tecate', 'Estrella Jalisco',
    ],
  },
  {
    key: 'spirits', name: 'Spirits', priority: true, ageGate: 21,
    from: ['alcohol'],
    words: /tequila|vodka|whiske?y|bourbon|\brum\b|\bgin\b|mezcal|spirits|liqueur|cognac|scotch/i,
    known: [
      '818 Tequila|818 Spirits|818', 'Casamigos', 'Teremana', 'Espolòn', 'Patrón',
      'Don Julio', 'Jose Cuervo', "Tito's Handmade Vodka|Tito's", 'New Amsterdam', 'Smirnoff',
      'Absolut', 'Grey Goose', 'Svedka', 'Malibu', 'Captain Morgan', 'Bacardi',
      "Jack Daniel's", 'Jim Beam', 'Fireball', 'Jägermeister', 'Crown Royal',
      'Jameson', 'Lobos 1707',
      'Cîroc|Ciroc', 'Ketel One', "Maker's Mark", 'Hennessy', 'Rémy Martin|Remy Martin', 'Tanqueray',
      "Hendrick's Gin|Hendrick's", 'Aperol', 'Campari', 'DeLeón Tequila|DeLeon', 'Clase Azul', 'Cincoro',
      'Hornitos', '1800 Tequila|1800', 'Kraken Rum|Kraken', 'Deep Eddy Vodka|Deep Eddy', 'Buffalo Trace',
      'Bulleit', 'Skrewball Whiskey|Skrewball', 'RumChata', 'Pink Whitney', 'Dos Hombres', 'Aviation Gin',
      'Sauza', 'Pinnacle Vodka|Pinnacle', 'UV Vodka',
    ],
  },
  {
    // Leo: nicotine means pouches (Sep 2026).
    key: 'nicotine', name: 'Nicotine Pouches', priority: true, ageGate: 21,
    from: [],
    known: [
      'Zyn', 'Velo', 'On!|On! Nicotine', 'Rogue', 'Lucy|Lucy Nicotine', 'Sesh+', 'FRE',
      'Juice Head', 'Black Buffalo',
      'JUUL|Juul Labs', 'Vuse', 'NJOY', 'Grizzly', 'Copenhagen', 'ALP|Alp Pouch',
    ],
  },
  {
    key: 'athletic', name: 'Athletic Wear', priority: true,
    from: ['apparel'],
    words: /athletic|activewear|athleisure|sportswear|\bgym\b|fitness apparel|workout|training apparel|\byoga\b|running shoes|performance (apparel|polos?|wear)/i,
    known: [
      'Nike', 'Adidas', 'Lululemon', 'Gymshark', 'Under Armour', 'New Balance', 'Vuori',
      'Alo Yoga|Alo', 'Rhoback', 'Rhone', 'Ten Thousand', 'On Running', 'Hoka', 'Puma',
      'Fabletics', 'Set Active', 'Outdoor Voices', 'Buffbunny', 'Alphalete', 'Young LA', 'Nobull',
      'Reebok', 'ASICS', 'Brooks Running|Brooks', 'Saucony', 'Champion', 'Russell Athletic', 'Athleta',
      'Beyond Yoga', 'Girlfriend Collective', 'Sweaty Betty', 'Jordan Brand', 'Darc Sport', 'Oner Active',
      'Tracksmith',
    ],
  },
  {
    // What is left of the old Apparel & Fashion keeps its key.
    key: 'apparel', name: 'Clothing & Fashion', priority: true,
    from: [],
    known: [
      'Chubbies', 'True Classic', 'Vineyard Vines', 'Kulani Kinis', 'Revolve', 'Guess', 'Skims',
      'goodr', 'Fashion Nova', 'Princess Polly', 'White Fox|White Fox Boutique', 'Edikted',
      'Crocs', 'Hey Dude', 'Comfort Colors', 'Rowdy Gentleman', 'Shinesty', 'Tipsy Elves',
      'Birddogs', 'Southern Tide', 'Lilly Pulitzer', 'Show Me Your Mumu', 'Kendra Scott',
      'Hello Molly', 'American Eagle', 'Aerie', 'Hollister', 'PacSun',
      'Abercrombie & Fitch|Abercrombie', 'Urban Outfitters', 'Madhappy',
      'Brandy Melville', 'Aritzia', 'Free People', 'Lulus', 'Meshki', 'Oh Polly', 'Nasty Gal',
      'PrettyLittleThing', 'Boohoo', "Tilly's", 'Zumiez', 'Stüssy|Stussy', 'Carhartt', "Levi's",
      'Ralph Lauren', 'Tommy Hilfiger', 'Aviator Nation', 'Kith', 'Supreme', 'Fear of God',
      'UGG', 'Dr. Martens', 'Vans', 'Converse', 'Birkenstock', 'Ray-Ban', 'Zara', 'H&M', 'Uniqlo',
      'Garage Clothing|Garage',
    ],
  },
]

// Brands Leo asked for by name that don't sit in a lane (Huel is meal
// shakes, not any of the seven). The LinkedIn run's research list looks
// these up first, and files them under \`category\` when LinkedIn clearly
// has them. Add a line to add a brand.
export const RESEARCH_EXTRA: Array<{ name: string; category: string }> = [
  { name: 'Huel', category: 'wellness' },
]

export const LANE_KEYS = LANES.map(l => l.key)

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

type Placeable = Pick<StockBrand, 'name' | 'aka' | 'category' | 'about' | 'topProducts'>

// Where a brand belongs, and why: "filed" (its own filing stands),
// "name" (a brand this lane knows by name) or "words" (what it sells —
// `match` is the words that decided it).
export function placeBrand(b: Placeable): { to: string | null; why: 'filed' | 'name' | 'words'; match: string | null } {
  const cat = b.category || 'unresolved'
  if (!SORTABLE.includes(cat)) return { to: b.category, why: 'filed', match: null }
  const keys = keysOf(b)
  for (const l of LANES) {
    if (keys.some(k => KNOWN[l.key].has(k))) {
      return l.key === b.category ? { to: b.category, why: 'filed', match: null } : { to: l.key, why: 'name', match: null }
    }
  }
  // Words only for brands someone filed somewhere: an unfiled brand's
  // description is too thin a reason to file it.
  if (cat !== 'unresolved') {
    const text = [b.name, b.aka, b.about, b.topProducts].filter(Boolean).join(' · ')
    for (const l of LANES) {
      if (!l.words || !l.from.includes(cat)) continue
      const m = text.match(l.words)
      if (m) return { to: l.key, why: 'words', match: m[0] }
    }
  }
  return { to: b.category, why: 'filed', match: null }
}

export type RefileMove = {
  id: string; name: string; from: string | null; to: string
  why: 'name' | 'words'; match: string | null
}

// Every brand whose category would change, grouped by where it goes.
// Applying these and asking again gives nothing: placeBrand keeps a
// brand where these moves put it.
export function refileMoves(brands: Array<Placeable & { id: string }>): RefileMove[] {
  const out: RefileMove[] = []
  for (const b of brands) {
    const p = placeBrand(b)
    if (p.why === 'filed' || !p.to || p.to === b.category) continue
    out.push({ id: b.id, name: b.name, from: b.category ?? null, to: p.to, why: p.why, match: p.match })
  }
  const order = (k: string) => { const i = LANE_KEYS.indexOf(k); return i < 0 ? 99 : i }
  return out.sort((a, b) => order(a.to) - order(b.to) || a.name.localeCompare(b.name))
}

// A planned Schedule day keeps meaning what Leo meant: a day set to a
// category that is being split follows its biggest share, when more of
// its brands leave for one category than stay behind (Alcohol & RTD →
// Beer, Seltzers & Canned Cocktails; Apparel mostly stays Clothing).
export function remapPlanDays(
  plan: Record<string, { category: string | null }>,
  moves: Array<{ from: string | null; to: string }>,
  totals: Record<string, number>,
  today: string,
): Array<{ day: string; from: string; to: string; moving: number; staying: number }> {
  const out: Array<{ day: string; from: string; to: string; moving: number; staying: number }> = []
  for (const day of Object.keys(plan).sort()) {
    const from = plan[day]?.category
    if (day < today || !from) continue
    const leaving: Record<string, number> = {}
    let left = 0
    for (const m of moves) if (m.from === from) { leaving[m.to] = (leaving[m.to] ?? 0) + 1; left++ }
    const best = Object.entries(leaving).sort((a, b) => b[1] - a[1])[0]
    const staying = (totals[from] ?? 0) - left
    if (best && best[1] > staying) out.push({ day, from, to: best[0], moving: best[1], staying })
  }
  return out
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
  // The category key the row holds ("uncategorised" for unfiled brands).
  key: string
  // Lane name; null on a plain category row (the page labels those).
  name: string | null
  priority: boolean
  ageGate: number | null
  // Category that brands added from this row's ideas are filed under.
  file: string | null
  counts: Counts
  brands: Array<{
    id: string; name: string; category: string | null; tier: string | null; state: StockState
    people: number; invited: number; accepted: number; emailed: number; replied: number; queued: number
    dealStage: string | null; linkedinUrl: string | null; archived: boolean; doNotEmail: boolean
  }>
  ideas: string[]
}

// Every brand in exactly one row: the category it belongs in (its own
// filing, or where placeBrand would move it — the page tags those with
// where they are filed today). Lanes lead, in Leo's order.
export function buildStock(brands: StockBrand[]) {
  const rows = new Map<string, StockRow>()
  const row = (key: string) => {
    let r = rows.get(key)
    if (!r) {
      const l = LANES.find(x => x.key === key)
      r = {
        key, name: l?.name ?? null, priority: !!l?.priority, ageGate: l?.ageGate ?? null,
        file: key === 'uncategorised' ? null : key, counts: zero(), brands: [], ideas: [],
      }
      rows.set(key, r)
    }
    return r
  }
  // Lanes first and always, so an empty lane still shows as empty.
  for (const l of LANES) row(l.key)

  const totals = zero()
  const categories = new Set<string>()
  const onRoster = new Set<string>()
  let refile = 0
  for (const b of brands) {
    for (const k of keysOf(b)) onRoster.add(k)
    if (b.category) categories.add(b.category)
    const state = stateOf(b)
    const p = placeBrand(b)
    if (p.why !== 'filed' && p.to !== b.category) refile++
    const r = row(p.to || 'uncategorised')
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
  const laneRows = LANES.filter(l => l.priority).map(l => rows.get(l.key)!)
  // Everything else: the other categories, biggest first; "Needs
  // Clarification" and unfiled brands last.
  const tail = (r: StockRow) => (r.key === 'unresolved' || r.key === 'uncategorised' ? 1 : 0)
  const otherRows = all.filter(r => !r.priority && r.counts.total > 0)
    .sort((a, b) => tail(a) - tail(b) || b.counts.total - a.counts.total)

  return {
    goal: LANE_GOAL,
    // How many brands the re-file would move (the list comes from
    // refileCategories when Leo opens it).
    refile,
    totals: { ...totals, categories: categories.size },
    lanes: laneRows,
    others: otherRows,
  }
}
