// src/lib/shows.ts
//
// The sellable show list — what the Shows tab and the public sponsor
// page (/sponsor.html) both read.
//
// Source of truth is the team's "SB AGENCY - FULL BUILT CRM" Google
// Sheet, read-only through the Drive grant. A row counts as a confirmed
// show only when it has ALL of: a real date, an artist, and a school —
// and a status that means booked (Offer Confirmed / Signed / Show
// Confirmed). That rule is what keeps half-filled "confirmed" leads out.
//
// Past shows come from the website archive (src/data/show-archive.json,
// the same 450+ shows the Past Shows map on sboyagency.com uses).
//
// Nothing here writes to the sheet or to sb-crm.

import { createHash } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { sheetsReadAll, driveStatus } from '@/lib/google'
import ARCHIVE from '@/data/show-archive.json'

const prisma = new PrismaClient()

export const CRM_SHEET_ID = process.env.CRM_SHEET_ID || '1MFMIiI65SBKb51mqtHqT72S5mjUJf4p0jVf9QWovRyo'
// The tab Leo pointed at (…#gid=1397302046). Other tabs with the same
// table shape are still read, but this one wins when a show is in both.
const PREFERRED_GID = Number(process.env.CRM_SHEET_GID || 1397302046)
const CACHE_KEY = 'crmShows'
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

export type Show = {
  id: string
  past: boolean
  date: string            // YYYY-MM-DD
  season: string          // "25–26"
  artist: string
  type: 'DJ' | 'Live act' | ''
  genre: string           // edm | hip-hop | country | pop | band | other
  school: string          // label as the team writes it ("UTK")
  schoolName: string      // "University of Tennessee"
  city: string
  state: string           // "TN"
  chapter: string         // "Sigma Chi" — shown to brands by Leo's choice
  status: string          // sheet status (internal only)
  rep: string             // internal only
  source: 'sheet' | 'archive'
}

// ---- schools -------------------------------------------------------------
// Reps write schools as abbreviations. This maps every spelling seen in the
// sheet and the archive to a proper name + city + state.
type SchoolInfo = { name: string; city: string; state: string }
const S = (name: string, city: string, state: string, ...aliases: string[]) => ({ name, city, state, aliases })
const SCHOOL_TABLE = [
  S('University of Tennessee', 'Knoxville', 'TN', 'utk', 'tennessee', 'ut knoxville'),
  S('University of South Carolina', 'Columbia', 'SC', 'sc', 'south carolina', 'usc-sc', 'uofsc'),
  S('University of Miami', 'Coral Gables', 'FL', 'umiami', 'miami', 'u miami'),
  S('Georgia Tech', 'Atlanta', 'GA', 'gatech', 'georgia tech', 'gt'),
  S('University of Oklahoma', 'Norman', 'OK', 'ou', 'oklahoma'),
  S('University of Texas', 'Austin', 'TX', 'ut', 'ut austin', 'texas', 'utexas'),
  S('Wake Forest University', 'Winston-Salem', 'NC', 'wfu', 'wake forest', 'wake'),
  S('University of Arkansas', 'Fayetteville', 'AR', 'uark', 'arkansas'),
  S('University of Tampa', 'Tampa', 'FL', 'utampa', 'tampa'),
  S('University of Cincinnati', 'Cincinnati', 'OH', 'cincinnati', 'cincinnatti', 'uc'),
  S('University of Colorado', 'Boulder', 'CO', 'boulder', 'colorado', 'cu', 'cu boulder'),
  S('James Madison University', 'Harrisonburg', 'VA', 'jmu'),
  S('East Carolina University', 'Greenville', 'NC', 'ecu'),
  S('NC State', 'Raleigh', 'NC', 'ncsu', 'nc state'),
  S('Colgate University', 'Hamilton', 'NY', 'colgate'),
  S('Clemson University', 'Clemson', 'SC', 'clemson'),
  S('Auburn University', 'Auburn', 'AL', 'auburn'),
  S('University of Arizona', 'Tucson', 'AZ', 'arizona', 'uofa', 'ua', 'u of a'),
  S('Arizona State University', 'Tempe', 'AZ', 'arizona state', 'asu'),
  S('Ole Miss', 'Oxford', 'MS', 'ole miss', 'olemiss', 'mississippi'),
  S('SMU', 'Dallas', 'TX', 'smu'),
  S('Michigan State University', 'East Lansing', 'MI', 'michigan state', 'msu'),
  S('University of Michigan', 'Ann Arbor', 'MI', 'michigan', 'umich'),
  S('University of Georgia', 'Athens', 'GA', 'uga', 'georgia'),
  S('Florida State University', 'Tallahassee', 'FL', 'fsu', 'florida state'),
  S('University of Florida', 'Gainesville', 'FL', 'uf', 'florida'),
  S('University of South Florida', 'Tampa', 'FL', 'usf'),
  S('University of Wisconsin', 'Madison', 'WI', 'wisconsin', 'uw madison'),
  S('University of Alabama', 'Tuscaloosa', 'AL', 'alabama', 'bama'),
  S('San Diego State University', 'San Diego', 'CA', 'sdsu', 'san diego state', 'san diego state university'),
  S('University of San Diego', 'San Diego', 'CA', 'usd'),
  S('UNC', 'Chapel Hill', 'NC', 'unc', 'north carolina'),
  S('LSU', 'Baton Rouge', 'LA', 'lsu'),
  S('Tulane University', 'New Orleans', 'LA', 'tulane'),
  S('Mississippi State', 'Starkville', 'MS', 'mississippi state', 'msstate'),
  S('Indiana University', 'Bloomington', 'IN', 'indiana', 'iu'),
  S('USC', 'Los Angeles', 'CA', 'usc', 'southern california'),
  S('UCLA', 'Los Angeles', 'CA', 'ucla'),
  S('UC Santa Barbara', 'Santa Barbara', 'CA', 'ucsb'),
  S('Chapman University', 'Orange', 'CA', 'chapman'),
  S('Santa Clara University', 'Santa Clara', 'CA', 'santa clara', 'scu'),
  S('Miami University', 'Oxford', 'OH', 'miami oh', 'miami ohio', 'miami (oh)'),
  S('Ohio State University', 'Columbus', 'OH', 'ohio state', 'osu'),
  S('Ohio University', 'Athens', 'OH', 'ohio'),
  S('Cornell University', 'Ithaca', 'NY', 'cornell'),
  S('Syracuse University', 'Syracuse', 'NY', 'syracuse', 'cuse'),
  S('University of Virginia', 'Charlottesville', 'VA', 'uva', 'virginia'),
  S('Virginia Tech', 'Blacksburg', 'VA', 'virginia tech', 'vt'),
  S('Texas Tech', 'Lubbock', 'TX', 'texas tech', 'ttu'),
  S('Texas A&M', 'College Station', 'TX', 'texas a&m', 'tamu', 'a&m', 'texas am'),
  S('TCU', 'Fort Worth', 'TX', 'tcu'),
  S('University of Washington', 'Seattle', 'WA', 'washington', 'uw'),
  S('Sewanee', 'Sewanee', 'TN', 'sewanee'),
  S('Georgia Southern', 'Statesboro', 'GA', 'georgia southern'),
  S('Georgia College', 'Milledgeville', 'GA', 'gcsu'),
  S('University of Missouri', 'Columbia', 'MO', 'mizzou', 'missouri'),
  S('Bucknell University', 'Lewisburg', 'PA', 'bucknell'),
  S('UPenn', 'Philadelphia', 'PA', 'upenn', 'penn'),
  S('Central Michigan', 'Mount Pleasant', 'MI', 'central michigan', 'cmu'),
  S('Dartmouth College', 'Hanover', 'NH', 'dartmouth'),
  S('Illinois State', 'Normal', 'IL', 'illinois state'),
  S('Wofford College', 'Spartanburg', 'SC', 'wofford'),
  S('Duke University', 'Durham', 'NC', 'duke'),
  S('Western University', 'London, ON', 'ON', 'western (ontario)', 'western', 'uwo'),
  S("Queen's University", 'Kingston, ON', 'ON', 'kingston on', 'queens'),
  S('Wilfrid Laurier', 'Waterloo, ON', 'ON', 'wilfrid laurier', 'laurier'),
  S('Baylor University', 'Waco', 'TX', 'baylor'),
  S('University of Kentucky', 'Lexington', 'KY', 'kentucky', 'uk'),
  S('Vanderbilt', 'Nashville', 'TN', 'vanderbilt', 'vandy'),
  S('Penn State', 'State College', 'PA', 'penn state', 'psu'),
  S('Purdue', 'West Lafayette', 'IN', 'purdue'),
  S('University of Iowa', 'Iowa City', 'IA', 'iowa'),
  S('Kansas', 'Lawrence', 'KS', 'kansas', 'ku'),
  S('Oklahoma State', 'Stillwater', 'OK', 'oklahoma state', 'okstate'),
  S('Ohio Wesleyan', 'Delaware', 'OH', 'ohio wesleyan'),
]
const SCHOOL_INDEX = new Map<string, SchoolInfo>()
for (const s of SCHOOL_TABLE) {
  const info = { name: s.name, city: s.city, state: s.state }
  for (const a of [s.name.toLowerCase(), ...s.aliases]) SCHOOL_INDEX.set(a, info)
}
export function schoolInfo(label: string, fallbackState = ''): SchoolInfo {
  const raw = String(label || '').trim()
  const k = raw.toLowerCase().replace(/\s+/g, ' ').replace(/^university of /, '').replace(/ university$/, '')
  return SCHOOL_INDEX.get(raw.toLowerCase()) || SCHOOL_INDEX.get(k) ||
    { name: raw, city: '', state: fallbackState }
}

// ---- genre ----------------------------------------------------------------
// Rough auto-tag from the artist name. Leo can override per artist in the
// Shows tab; overrides live in Setting "artistGenres" {name: genre}.
const GENRE_HINTS: [RegExp, string][] = [
  [/\b(band|orchestra|quartet|the [a-z]+s)\b/i, 'band'],
  [/\b(dj|b2b|remix)\b/i, 'edm'],
]
const GENRE_ARTISTS: Record<string, string> = {
  // hip-hop / rap
  'soulja boy': 'hip-hop', 'dababy': 'hip-hop', 'da baby': 'hip-hop', 'lil mosey': 'hip-hop', 'fetty wap': 'hip-hop',
  'waka flocka': 'hip-hop', 'famous dex': 'hip-hop', 'bobby shmurda': 'hip-hop', 'tee grizzley': 'hip-hop', 'sheck wes': 'hip-hop',
  'big x tha plug': 'hip-hop', 'slim jxmmi': 'hip-hop', 'a boogie wit da hoodie': 'hip-hop', 'a boogie': 'hip-hop', 'mike sherm': 'hip-hop',
  'zaytoven': 'hip-hop', 'silva bumpa': 'hip-hop', 'rossi': 'hip-hop', 'bossman dlo': 'hip-hop', 'roddy lima': 'hip-hop', 'cousin jay': 'hip-hop',
  // country
  'dustin lynch': 'country', 'easton corbin': 'country', 'gavin adcock': 'country', 'josh meloy': 'country', 'the castellows': 'country',
  'the damn quails': 'country', 'penelope road': 'country', 'tucker wyatt': 'country', 'arden jones': 'pop', 'blake whitten': 'country',
  'warren hallow': 'country', 'sterling elza': 'country', 'jake shore': 'country', 'jakeshore': 'country',
  // pop
  'chainsmokers': 'pop', 'the chainsmokers': 'pop', 'loud luxury': 'pop', 'surf mesa': 'pop', 'daniel allan': 'pop', 'ship wrek': 'edm',
  'cash cash': 'pop', 'cashcash': 'pop', 'notd': 'pop', 'imanbek': 'edm', 'borns': 'pop',
  // edm / house / dance
  'acraze': 'edm', 'kettama': 'edm', 'chris lorenzo': 'edm', 'twin diplomacy': 'edm', 'twinsick': 'edm', 'luco': 'edm', 'avello': 'edm',
  'riordan': 'edm', 'devault': 'edm', 'ian asher': 'edm', 'matroda': 'edm', 'noizu': 'edm', 'wuki': 'edm', 'gudfella': 'edm', 'distant matter': 'edm',
  'gravagerz': 'edm', 'goo': 'edm', 'congress': 'band', 'omar +': 'edm', 'omar+': 'edm', 'dod': 'edm', 'd.o.d': 'edm', 'd.o.d.': 'edm', 'ad blanco': 'edm',
  'sidequest': 'edm', 'fallon': 'edm', 'jigitz': 'edm', 'mph': 'edm', 'ipc': 'edm', 'bynx': 'edm', 'dennett': 'edm', 'odd mob': 'edm', 'gkat': 'edm',
  'cheyenne giles': 'edm', 'lavern': 'edm', 'kyle cooke': 'edm', 'proppa': 'edm', 'dzeko': 'edm', 'levity': 'edm', 'ayybo': 'edm', 'loofy': 'edm',
  'john summit': 'edm', 'biscits': 'edm', 'max victory': 'edm', 'bunt': 'edm', 'josh baker': 'edm', 'prospa': 'edm', 'max styler': 'edm',
  'mita gami': 'edm', 'rafael': 'edm', 'obskur': 'edm', 'san pancho': 'edm', 'joshwa': 'edm', 'marco strous': 'edm', 'omnom': 'edm', 'discip': 'edm',
  'sosa': 'edm', 'hills': 'edm', 'chasewest': 'edm', 'costa': 'edm', 'breakbomb': 'edm', 'truth x lies': 'edm', 'always friday': 'edm', 'arlo': 'edm',
  'slamm': 'edm', 'oden and fatzo': 'edm', 'jay pryor': 'edm', 'afternooners': 'band', 'ricky retro': 'edm', 'joey boretti': 'edm', 'lsdj': 'edm',
  'local dj': 'edm', 'superstar': 'edm', 'superstars': 'edm', 'rachii': 'edm', 'gringos': 'band', 'moonlight': 'edm', 'ashes': 'band', 'the ashes': 'band',
  'midknighters': 'band', 'banjo': 'band', 'tobacco road': 'band', 'the bends': 'band', 'bends': 'band', 'first class band': 'band', 'wallabees': 'band',
  'harvey street': 'band', 'harvey street co': 'band', 'club de combat': 'band', 'the crowns': 'band', 'room for error': 'band', 'tomorrow\'s problem': 'band',
  'tomorrows problem': 'band', 'smoked honey': 'band', 'jackie hollander': 'band', 'grandville': 'band', 'half step': 'band', 'balistic berry': 'band',
  'ballistic berry': 'band', 'ocho': 'band', 'sgr': 'band', 'ugsh': 'band', 'chefs kiss': 'band', 'carolina kin': 'band', 'pageant band': 'band',
  'third floor band': 'band', 'the simplicity': 'band', 'jacoozy': 'band', 'to be honest': 'band', 'tobehonest': 'band', 'broken hill': 'band',
  'beau cruz': 'country', 'down hazy': 'band', 'kinahau': 'edm', 'fort knox': 'band', 'nate band': 'band', 'lost kings': 'edm', 'stews': 'band',
  'dan molinari': 'band', 'stella lefty': 'band', 'the bends - production': 'band', 'broncos n bulletholes': 'band', 'broncos n bullethols': 'band',
  'superstar + broncos n bullethols': 'band', 'james kennedy': 'edm', 'mike sherm ': 'hip-hop', 'lp rhythm': 'edm', 'ben sterling': 'edm', 'morgan seatree': 'edm',
  'dean turnley': 'edm', 'locky': 'edm', 'no thanks': 'edm', 'lil pump': 'hip-hop', 'meduza': 'edm', 'martin ikin': 'edm', 'sheckwes': 'hip-hop',
  'cid': 'edm', 'bob': 'hip-hop', 'b.o.b': 'hip-hop', 'two friends': 'edm', 'robbie doherty': 'edm', 'jamo': 'edm', 'lostboyjay': 'edm', 'papajay': 'edm', 'papa jay': 'edm',
  'smokes': 'edm', 'dune dogs': 'band', 'the ocho': 'band', 'future birds': 'band', 'chad frick band': 'band', 'saturday school band': 'band', 'coral bank hollow': 'band',
  'olympic blvd': 'band', 'vegabonds': 'band', 'the forgotten space': 'band', 'niiko x swae': 'edm', 'laszewo': 'edm', 'skilah': 'edm', 'genisi': 'edm',
}
export function genreFor(artist: string, type: string, overrides: Record<string, string> = {}): string {
  const a = String(artist || '').trim().toLowerCase()
  if (!a) return 'other'
  if (overrides[a]) return overrides[a]
  if (GENRE_ARTISTS[a]) return GENRE_ARTISTS[a]
  // multi-artist bills: first known name wins
  const parts = a.split(/\s*(?:\+|,|&|\band\b|b2b|\/)\s*/).map(x => x.trim()).filter(Boolean)
  for (const p of parts) { if (overrides[p]) return overrides[p]; if (GENRE_ARTISTS[p]) return GENRE_ARTISTS[p] }
  for (const [rx, g] of GENRE_HINTS) if (rx.test(a)) return g
  if (/live/i.test(type)) return 'band'
  if (/dj/i.test(type)) return 'edm'
  return 'other'
}
export const GENRES = ['edm', 'hip-hop', 'country', 'pop', 'band', 'other'] as const

// What kind of act is on stage — the split brands actually think in.
// Derived from genre (which Leo can already override per artist) plus the
// sheet's Live act / DJ column, so an override fixes both at once.
export type Performer = 'dj' | 'singer' | 'rapper' | 'band'
export function performerFor(s: { type: string; genre: string }): Performer {
  if (s.genre === 'hip-hop') return 'rapper'
  if (s.genre === 'band') return 'band'
  if (s.genre === 'country') return 'singer'
  if (/live/i.test(s.type)) return 'singer'   // pop/other live acts front a singer
  return 'dj'                                  // edm, pop DJ-producers, unknowns
}

// ---- dates ------------------------------------------------------------------
const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 }
export function parseShowDate(s: string): string | null {
  const t = String(s || '').trim().replace(/^[A-Za-z]+,\s*/, '')      // "Friday, August 21, 2026"
  if (!t) return null
  let m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?$/.exec(t)   // August 21, 2026 · Aug 21 2026
  if (m && MONTHS[m[1].slice(0, 4).toLowerCase()] != null) {
    const y = m[3] ? +m[3] : new Date().getFullYear()
    return iso(y, MONTHS[m[1].slice(0, 4).toLowerCase()], +m[2])
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(t)                     // 9/11/2026 · 9/11/26
  if (m) return iso(+m[3] < 100 ? 2000 + +m[3] : +m[3], +m[1] - 1, +m[2])
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t)                              // 2026-09-11
  if (m) return iso(+m[1], +m[2] - 1, +m[3])
  const d = new Date(t)
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}
function iso(y: number, mo: number, d: number) {
  if (mo < 0 || mo > 11 || d < 1 || d > 31) return null
  return `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}
export function seasonOf(date: string): string {
  const y = +date.slice(0, 4), m = +date.slice(5, 7)
  const start = m >= 7 ? y : y - 1
  return `${String(start).slice(2)}–${String(start + 1).slice(2)}`
}
export function showId(school: string, chapter: string, date: string, prefix = 'sh') {
  const key = [school, chapter, date].map(x => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).join('|')
  return prefix + '_' + createHash('sha1').update(key).digest('hex').slice(0, 12)
}

// ---- the sheet ---------------------------------------------------------------
const BOOKED = /^(offer confirmed|signed|show confirmed|confirmed|completed|contract signed)$/i
const HEADER_HINT = (cells: string[]) => {
  const l = cells.map(c => c.trim().toLowerCase())
  return l.includes('confirmed artist') && l.includes('school') && l.some(c => /show date/.test(c)) && l.includes('status')
}
function col(hdr: string[], ...names: string[]) {
  const l = hdr.map(c => c.trim().toLowerCase())
  for (const n of names) { const i = l.indexOf(n.toLowerCase()); if (i >= 0) return i }
  return -1
}

export type SheetParse = { shows: Show[]; tables: number; rowsSeen: number; rejected: { reason: string; row: string }[] }

export function parseSheet(tabs: { title: string; gid?: number; rows: string[][] }[], overrides: Record<string, string> = {}): SheetParse {
  const byKey = new Map<string, Show>()
  const fromPreferred = new Set<string>()
  const rejected: SheetParse['rejected'] = []
  let tables = 0, rowsSeen = 0
  const ordered = [...tabs].sort((a, b) => Number(b.gid === PREFERRED_GID) - Number(a.gid === PREFERRED_GID))
  for (const tab of ordered) {
    const preferred = tab.gid === PREFERRED_GID
    for (let r = 0; r < tab.rows.length; r++) {
      const hdr = tab.rows[r]
      if (!hdr || !HEADER_HINT(hdr)) continue
      tables++
      const cDate = col(hdr, 'show date'), cStatus = col(hdr, 'status'), cType = col(hdr, 'live act / dj', 'type')
      const cSchool = col(hdr, 'school'), cChapter = col(hdr, 'chapter/venue', 'chapter', 'venue'), cArtist = col(hdr, 'confirmed artist', 'artist')
      const cRep = col(hdr, 'company rep', 'ae', 'rep')
      for (let i = r + 1; i < tab.rows.length; i++) {
        const row = tab.rows[i] || []
        if (HEADER_HINT(row)) { r = i - 1; break }                     // next table starts
        const get = (c: number) => (c >= 0 ? String(row[c] ?? '').trim() : '')
        const rawDate = get(cDate), status = get(cStatus), artist = get(cArtist), school = get(cSchool), chapter = get(cChapter)
        if (!rawDate && !status && !artist && !school) continue        // blank spacer row
        rowsSeen++
        const label = [rawDate, school, chapter, artist].filter(Boolean).join(' · ')
        if (!BOOKED.test(status)) { rejected.push({ reason: `status "${status || '—'}"`, row: label }); continue }
        const date = parseShowDate(rawDate)
        if (!date) { rejected.push({ reason: 'no date', row: label }); continue }
        if (!artist) { rejected.push({ reason: 'no artist', row: label }); continue }
        if (!school) { rejected.push({ reason: 'no school', row: label }); continue }
        const info = schoolInfo(school)
        const typeRaw = get(cType).toLowerCase()
        const type: Show['type'] = /live/.test(typeRaw) ? 'Live act' : /dj/.test(typeRaw) ? 'DJ' : ''
        const id = showId(info.name, chapter, date)
        const show: Show = {
          id, past: date < today(), date, season: seasonOf(date), artist, type,
          genre: genreFor(artist, type, overrides),
          school, schoolName: info.name, city: info.city, state: info.state, chapter,
          status, rep: get(cRep), source: 'sheet',
        }
        const prev = byKey.get(id)
        // the preferred tab always wins; otherwise keep the copy that has the type column
        if (!prev || (!fromPreferred.has(id) && (preferred || (!prev.type && show.type)))) { byKey.set(id, show); if (preferred) fromPreferred.add(id) }
      }
    }
  }
  return { shows: [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date)), tables, rowsSeen, rejected }
}

function today() { return new Date().toISOString().slice(0, 10) }

// ---- archive ------------------------------------------------------------------
export function archiveShows(overrides: Record<string, string> = {}): Show[] {
  const out: Show[] = []
  for (const a of ARCHIVE as any[]) {
    const date = parseShowDate(a.date)
    if (!date || !a.artist || !a.school || /^(n\/a|greekfest|still life|jampack|neurips|juscollege|thaw out|almost famous|rushlink|the burg)$/i.test(a.school)) continue
    const info = schoolInfo(a.school, a.state || '')
    out.push({
      id: showId(info.name, '', date, 'ar') + '_' + createHash('sha1').update(String(a.artist).toLowerCase()).digest('hex').slice(0, 4),
      past: true, date, season: a.season || seasonOf(date), artist: a.artist, type: '',
      genre: genreFor(a.artist, '', overrides),
      school: a.school, schoolName: info.name, city: info.city, state: info.state || a.state || '', chapter: '',
      status: 'Completed', rep: '', source: 'archive',
    })
  }
  return out
}

// ---- cache + public API ---------------------------------------------------------
async function getSetting(key: string) {
  const r = await prisma.setting.findUnique({ where: { key } })
  return r?.value ?? null
}
export async function genreOverrides(): Promise<Record<string, string>> {
  try { return JSON.parse((await getSetting('artistGenres')) || '{}') } catch { return {} }
}
export async function setGenreOverride(artist: string, genre: string) {
  const o = await genreOverrides()
  const k = String(artist || '').trim().toLowerCase()
  if (!k) return o
  if (genre) o[k] = genre; else delete o[k]
  await prisma.setting.upsert({ where: { key: 'artistGenres' }, create: { key: 'artistGenres', value: JSON.stringify(o) }, update: { value: JSON.stringify(o) } })
  return o
}

export async function refreshShows(): Promise<{ ok: boolean; at: string; count: number; tables: number; rowsSeen: number; rejected: SheetParse['rejected']; error?: string }> {
  const st = await driveStatus()
  if (!st.connected) return { ok: false, at: new Date().toISOString(), count: 0, tables: 0, rowsSeen: 0, rejected: [], error: 'Google Drive is not connected (Activations → Connect Google Drive, then approve the read-only Sheets permission).' }
  const tabs = await sheetsReadAll(CRM_SHEET_ID)
  const parsed = parseSheet(tabs, await genreOverrides())
  if (parsed.tables === 0) return { ok: false, at: new Date().toISOString(), count: 0, tables: 0, rowsSeen: 0, rejected: [], error: 'No deals table found in the sheet (looked for a header with Show Date · Status · School · Confirmed Artist).' }
  const at = new Date().toISOString()
  const value = JSON.stringify({ at, shows: parsed.shows, rejected: parsed.rejected.slice(0, 200), tables: parsed.tables, rowsSeen: parsed.rowsSeen })
  await prisma.setting.upsert({ where: { key: CACHE_KEY }, create: { key: CACHE_KEY, value }, update: { value } })
  return { ok: true, at, count: parsed.shows.length, tables: parsed.tables, rowsSeen: parsed.rowsSeen, rejected: parsed.rejected }
}

export async function cachedShows(): Promise<{ at: string | null; shows: Show[]; rejected: SheetParse['rejected']; stale: boolean }> {
  let cache: any = null
  try { cache = JSON.parse((await getSetting(CACHE_KEY)) || 'null') } catch { cache = null }
  const stale = !cache || Date.now() - new Date(cache.at).getTime() > CACHE_TTL_MS
  if (stale) {
    // refresh in the request when we can; fall back to whatever we had
    try { const r = await refreshShows(); if (r.ok) cache = JSON.parse((await getSetting(CACHE_KEY)) || 'null') } catch { /* keep old */ }
  }
  const t = today()
  const shows: Show[] = (cache?.shows || []).map((s: Show) => ({ ...s, past: s.date < t }))
  return { at: cache?.at || null, shows, rejected: cache?.rejected || [], stale: !cache }
}

// Everything a brand may browse: upcoming confirmed shows from the sheet,
// past shows from the sheet (once played) plus the website archive,
// de-duplicated on school + date + artist.
export async function allShows(): Promise<{ at: string | null; shows: Show[]; upcoming: number; past: number }> {
  const [c, overrides] = await Promise.all([cachedShows(), genreOverrides()])
  const seen = new Set<string>()
  const out: Show[] = []
  const key = (s: Show) => [s.schoolName, s.date, s.artist].join('|').toLowerCase().replace(/[^a-z0-9|]+/g, '')
  for (const s of c.shows) { seen.add(key(s)); out.push({ ...s, genre: genreFor(s.artist, s.type, overrides) }) }
  for (const s of archiveShows(overrides)) { const k = key(s); if (seen.has(k)) continue; seen.add(k); out.push(s) }
  out.sort((a, b) => a.date.localeCompare(b.date))
  return { at: c.at, shows: out, upcoming: out.filter(s => !s.past).length, past: out.filter(s => s.past).length }
}

// What the public page is allowed to see. No rep, no status, no money.
export function publicShow(s: Show) {
  return { id: s.id, past: s.past, date: s.date, season: s.season, artist: s.artist, type: s.type, performer: performerFor(s), genre: s.genre, school: s.schoolName, schoolShort: s.school, city: s.city, state: s.state, chapter: s.chapter }
}
