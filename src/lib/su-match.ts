// src/lib/su-match.ts
//
// Finding a brand's SponsorUnited profile id.
//
// A brand's people can only be captured if we know its SponsorUnited
// profile id — the capture script opens /profile/<id>/contacts and reads
// the page. Brands without that id are invisible to a sweep, which is
// why 220 of them have never been filled.
//
// The id can only be discovered inside Leo's logged-in SponsorUnited
// tab: their search is an autocomplete in the app, and we are not
// allowed to call their private API. So this file is the message board
// between the two halves:
//
//   dashboard  -> writes a search request ("who is 'Yerba Madre'?")
//   userscript -> reads the request, searches in its own tab, writes back
//                 the matches it saw
//   dashboard  -> shows the matches, Leo picks one, the id is attached
//
// The batch sweep uses the same board in reverse: the script asks for
// brands missing an id, searches each one, attaches the obvious ones
// itself, and leaves anything ambiguous here as a proposal for Leo.
//
// All of it lives in Setting rows as JSON rather than tables: these are
// short-lived worklists that empty as they are worked, and a schema
// change is not worth it. Same reasoning as brand-match.ts.

export const SEARCH_KEY = 'suSearchRequest'
export const MATCH_KEY = 'suMatchProposals'
export const CAPTURE_KEY = 'suCaptureQueue'

// Caps so a misbehaving script can't grow a row without bound.
const MAX_CANDIDATES = 8
const MAX_PROPOSALS = 300
const MAX_CAPTURE_QUEUE = 50

// A SponsorUnited search result, exactly as the page showed it.
export type SuCandidate = {
  // The profile id from the result's own link — this is the thing we
  // are actually after.
  externalId: string
  // SponsorUnited's spelling, kept verbatim: on attach it becomes the
  // brand's "also known as" so future captures match by name too.
  name: string
}

// One question from the dashboard, and the answer when it arrives.
export type SuSearchRequest = {
  id: string
  q: string
  // pending = waiting for the tab · done = results below · none = no tab
  // answered in time, so the dashboard can say so instead of spinning.
  status: 'pending' | 'done' | 'failed'
  at: number
  results?: SuCandidate[]
  error?: string
  // Set when the request came from a brand that already exists, so
  // picking a result attaches rather than creating a duplicate.
  brandId?: string | null
}

// A brand the sweep searched but could not decide on its own.
export type SuProposal = {
  brandId: string
  brandName: string
  candidates: SuCandidate[]
  at: number
  // Script 4.1 and older read the page's own profile links as results
  // (every brand got the same eight "matches"); their proposals carry no
  // v and stay hidden. Kept, not deleted: a re-search replaces each one.
  v?: number
}
export const PROPOSAL_VERSION = 2

// A brand whose people should be captured on the script's next pass —
// written when a profile id is attached, so "pull their people now"
// happens without Leo starting a sweep by hand.
export type SuCaptureItem = {
  brandId: string
  externalId: string
  brandName: string
  at: number
}

type SettingStore = {
  setting: {
    findUnique(args: any): Promise<{ value: string } | null>
    upsert(args: any): Promise<any>
  }
}

async function readJson<T>(db: SettingStore, key: string, fallback: T): Promise<T> {
  try {
    const row = await db.setting.findUnique({ where: { key } })
    if (!row) return fallback
    const parsed = JSON.parse(row.value)
    return (parsed ?? fallback) as T
  } catch {
    // A corrupt value must never break a capture or a search.
    return fallback
  }
}

async function writeJson(db: SettingStore, key: string, value: unknown) {
  const v = JSON.stringify(value)
  await db.setting.upsert({ where: { key }, create: { key, value: v }, update: { value: v } })
}

// ---------------- the live search request ----------------

export async function readSearch(db: SettingStore): Promise<SuSearchRequest | null> {
  return readJson<SuSearchRequest | null>(db, SEARCH_KEY, null)
}

export async function writeSearch(db: SettingStore, req: SuSearchRequest | null) {
  await writeJson(db, SEARCH_KEY, req)
}

// ---------------- proposals waiting on Leo ----------------

export async function readProposals(db: SettingStore): Promise<SuProposal[]> {
  const list = await readJson<SuProposal[]>(db, MATCH_KEY, [])
  return Array.isArray(list) ? list : []
}

export async function writeProposals(db: SettingStore, list: SuProposal[]) {
  await writeJson(db, MATCH_KEY, list.slice(0, MAX_PROPOSALS))
}

// One brand's proposal replaces any earlier one for the same brand —
// a re-search should correct the list, not stack another copy on it.
export function upsertProposal(list: SuProposal[], p: SuProposal): SuProposal[] {
  const rest = list.filter(x => x.brandId !== p.brandId)
  return [{ ...p, candidates: p.candidates.slice(0, MAX_CANDIDATES) }, ...rest]
}

// ---------------- brands queued for an immediate capture ----------------

export async function readCaptureQueue(db: SettingStore): Promise<SuCaptureItem[]> {
  const list = await readJson<SuCaptureItem[]>(db, CAPTURE_KEY, [])
  return Array.isArray(list) ? list : []
}

export async function writeCaptureQueue(db: SettingStore, list: SuCaptureItem[]) {
  await writeJson(db, CAPTURE_KEY, list.slice(0, MAX_CAPTURE_QUEUE))
}

export function queueCapture(list: SuCaptureItem[], item: SuCaptureItem): SuCaptureItem[] {
  const rest = list.filter(x => x.brandId !== item.brandId)
  return [...rest, item]
}

// ---------------- deciding whether a match is obvious ----------------

// Names as people type them vs as SponsorUnited stores them: strip the
// company suffixes, punctuation and spacing that differ without changing
// which company is meant. "Yerba Madre, Inc." and "yerba madre" are the
// same brand; "Red Bull" and "Red Bull Racing" are not.
export function normalizeBrandName(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(inc|llc|ltd|co|corp|corporation|company|holdings|group|brands|usa|us)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// The sweep may only attach a profile id on its own when exactly one
// candidate is an unambiguous name match. Anything else — several
// equally good hits, or only a partial one — is Leo's call, because a
// wrong id silently fills a brand with another company's people.
export function decideMatch(
  brandName: string,
  aka: string | null,
  candidates: SuCandidate[],
): { pick: SuCandidate | null; reason: 'exact' | 'ambiguous' | 'none' } {
  if (!candidates.length) return { pick: null, reason: 'none' }
  const wanted = new Set(
    [brandName, ...String(aka || '').split(/[,;]/)]
      .map(normalizeBrandName)
      .filter(Boolean),
  )
  const exact = candidates.filter(c => wanted.has(normalizeBrandName(c.name)))
  if (exact.length === 1) return { pick: exact[0], reason: 'exact' }
  return { pick: null, reason: 'ambiguous' }
}

// ---------------- the sweep log ----------------
//
// What the last capture of each brand found. The sweep's worklist is
// "emptiest brand first", and a brand SponsorUnited has nothing new for
// stays emptiest forever — so every run opened the same few brands,
// added nobody, and never got to the rest. A brand that yielded nothing
// new now rests for a fortnight before the sweep offers it again.
// Stored as JSON in Setting["suSweepLog"], brandId -> last outcome.

export const SWEEP_KEY = 'suSweepLog'
export const SWEEP_REST_DAYS = 14
const SWEEP_KEEP_DAYS = 60

export type SweepMark = { at: string; seen: number; added: number }
export type SweepLog = Record<string, SweepMark>

export async function readSweepLog(db: SettingStore): Promise<SweepLog> {
  const log = await readJson<SweepLog>(db, SWEEP_KEY, {})
  return log && typeof log === 'object' && !Array.isArray(log) ? log : {}
}

export async function writeSweepLog(db: SettingStore, log: SweepLog) {
  const cutoff = Date.now() - SWEEP_KEEP_DAYS * 864e5
  const kept: SweepLog = {}
  for (const [id, m] of Object.entries(log)) {
    if (m && Date.parse(m.at) >= cutoff) kept[id] = m
  }
  await writeJson(db, SWEEP_KEY, kept)
}

export async function markSwept(db: SettingStore, brandId: string, seen: number, added: number) {
  const log = await readSweepLog(db)
  log[brandId] = { at: new Date().toISOString(), seen, added }
  await writeSweepLog(db, log)
}

// Resting = the last visit found nobody new, and it was recent. A visit
// that added someone never rests the brand: there may be more.
export function isResting(mark: SweepMark | undefined, now = Date.now()): boolean {
  if (!mark || mark.added > 0) return false
  const at = Date.parse(mark.at)
  return Number.isFinite(at) && now - at < SWEEP_REST_DAYS * 864e5
}
