// src/lib/audience-core.ts
//
// Pure helpers for the audience module — no Prisma, no Next, no env.
// Kept dependency-free on purpose: scripts/test-audience.mjs compiles
// this one file and runs it under node:assert, so the dedupe rules that
// the repeat-attendance signal depends on are guarded by tests.

// Email is identity. One normalization, used by RSVP, check-in, and CSV
// import alike. Lowercase + trim only — deliberately NOT stripping dots
// or +tags: that's a Gmail-only convention, and applying it to every
// domain would merge people who are genuinely different.
export function normalizeEmail(raw: unknown): string {
  return String(raw ?? '').trim().toLowerCase()
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

// The consent copy shown on every collection point. Bump the version
// when the wording changes; old attendees keep the version they agreed
// to (the full text of every version lives in the ConsentText table).
export const CONSENT_VERSION = 'v1'
export const CONSENT_TEXT =
  'I agree that SBOY may store the details I submit and contact me about this and future events. ' +
  'My individual information is never sold or shared with sponsors or anyone else — sponsors only ' +
  'ever see combined, anonymous numbers. I can ask for my data to be deleted at any time by ' +
  'replying to any SBOY email.'

// Door PINs are read out loud and typed on a phone: digits only.
export function newStaffPin(): string {
  let s = ''
  for (let i = 0; i < 6; i++) s += Math.floor(Math.random() * 10)
  return s
}

export function clean(s: unknown, max: number): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

// "$12.50" / "12.5" / "12,50 USD"-ish junk → integer cents, or null when
// it isn't a number (same stance as the client's parseMoney: junk must
// refuse to import, not silently become zero).
export function parsePriceCents(raw: unknown): number | null {
  const s = String(raw ?? '').trim()
  if (!s) return 0
  const cleaned = s.replace(/[$,\s]/g, '')
  if (!/^(\d+\.?\d*|\.\d+)$/.test(cleaned)) return null
  const n = parseFloat(cleaned)
  if (!isFinite(n) || n < 0 || n > 100000) return null
  return Math.round(n * 100)
}

// Minimal CSV parser — quotes, escaped quotes, CR/LF. Box-office exports
// are simple files; anything this can't read should fail loudly in the
// preview, not import wrong.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', inQ = false
  const src = String(text ?? '')
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inQ) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++ } else inQ = false
      } else cell += c
    } else if (c === '"') inQ = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(cell); cell = ''
      if (row.some(v => v.trim() !== '')) rows.push(row)
      row = []
    } else cell += c
  }
  row.push(cell)
  if (row.some(v => v.trim() !== '')) rows.push(row)
  return rows
}

// Which import column is which. Matched on the lowercased header with
// spaces/underscores squashed, so "Buyer Email", "buyer_email" and
// "buyeremail" all land on email.
const HEADER_MATCHERS: [string, RegExp][] = [
  ['email', /email|e-?mail/],
  ['name', /^(full)?name$|attendee|buyer(name)?|purchaser|guest/],
  ['school', /school|campus|college|university/],
  ['classYear', /classyear|gradyear|graduation|year/],
  ['phone', /phone|mobile|cell/],
  ['ticketType', /tickettype|tier|type|level/],
  ['price', /price|paid|amount|total|cost/],
]

export function guessColumns(headers: string[]): Record<string, number> {
  const map: Record<string, number> = {}
  headers.forEach((h, i) => {
    const key = String(h ?? '').toLowerCase().replace(/[\s_-]+/g, '')
    for (const [field, re] of HEADER_MATCHERS) {
      if (map[field] === undefined && re.test(key)) { map[field] = i; break }
    }
  })
  return map
}

export type ImportRow = {
  email: string
  name: string | null
  school: string | null
  classYear: string | null
  phone: string | null
  ticketType: string
  priceCents: number
}

export type ImportResult = {
  rows: ImportRow[]
  // Rows that could not be imported, with the 1-based CSV line and why.
  skipped: { line: number; reason: string }[]
  // Emails that appeared more than once inside this file (kept once).
  dupesInFile: number
}

// CSV text → clean import rows, deduped by normalized email within the
// file. First occurrence wins; later duplicates only fill in fields the
// first left blank (a check-in row after a purchase row keeps the price).
export function mapImportRows(csvText: string, mapping?: Record<string, number>): ImportResult {
  const grid = parseCsv(csvText)
  if (grid.length < 2) return { rows: [], skipped: [], dupesInFile: 0 }
  const cols = mapping && mapping.email !== undefined ? mapping : guessColumns(grid[0])
  if (cols.email === undefined) {
    return { rows: [], skipped: [{ line: 1, reason: 'No email column found in the header row' }], dupesInFile: 0 }
  }
  const get = (r: string[], field: string) => (cols[field] === undefined ? '' : String(r[cols[field]] ?? ''))
  const byEmail = new Map<string, ImportRow>()
  const skipped: { line: number; reason: string }[] = []
  let dupesInFile = 0

  grid.slice(1).forEach((r, i) => {
    const line = i + 2
    const email = normalizeEmail(get(r, 'email'))
    if (!email) { skipped.push({ line, reason: 'Empty email' }); return }
    if (!isValidEmail(email)) { skipped.push({ line, reason: `Not a valid email: ${email.slice(0, 60)}` }); return }
    const price = parsePriceCents(get(r, 'price'))
    if (price === null) { skipped.push({ line, reason: `Unreadable price: ${get(r, 'price').slice(0, 30)}` }); return }

    const tt = clean(get(r, 'ticketType'), 40).toLowerCase()
    const row: ImportRow = {
      email,
      name: clean(get(r, 'name'), 120) || null,
      school: clean(get(r, 'school'), 120) || null,
      classYear: clean(get(r, 'classYear'), 20) || null,
      phone: clean(get(r, 'phone'), 40) || null,
      ticketType: /vip/.test(tt) ? 'vip' : /comp|free|guest/.test(tt) ? 'comp' : 'ga',
      priceCents: price,
    }
    const prev = byEmail.get(email)
    if (!prev) { byEmail.set(email, row); return }
    dupesInFile++
    prev.name = prev.name || row.name
    prev.school = prev.school || row.school
    prev.classYear = prev.classYear || row.classYear
    prev.phone = prev.phone || row.phone
    if (prev.priceCents === 0 && row.priceCents > 0) {
      prev.priceCents = row.priceCents
      prev.ticketType = row.ticketType
    }
  })
  return { rows: Array.from(byEmail.values()), skipped, dupesInFile }
}

// Ambassador refs come off a URL: accept only the platform's own shape.
export function cleanAmbassadorRef(raw: unknown): string | null {
  const s = String(raw ?? '').trim()
  return /^sboy:[A-Za-z0-9_-]{1,64}$/.test(s) ? s : null
}
