// src/lib/li-hidden.ts
//
// People LinkedIn hides from Leo's account (Leo, Oct 7 2026: "if i run the
// fill i dont want to miss out on people if i do it from my own account").
// Leo's LinkedIn is free, so anyone outside his network shows on a
// company's People tab as "LinkedIn Member": no name, no profile link —
// only their headline. The fill can't save them, but it can count them
// and read those headlines. A brand where some of them look like buyers
// goes on "Read on Zach's LinkedIn": Zach's network is the big one, so his
// SB · Read people (scripts/linkedin-log.user.js) sees them by name.
//
// Setting "liHidden": brandId → what Leo's last read saw, and when Zach's
// account read the brand. Pure here; /api/ingest writes it (the fill's
// liSwept, Leo's own hand reads, Zach's reads) and /api/data lists it.
// node scripts/test-li-hidden.mjs

import { isBuyer, roleFromHeadline } from './li-capture'

export const LI_HIDDEN_KEY = 'liHidden'
// After Zach's account reads a brand it stays off his list this long.
// Leo's account still can't see those people (some now saved), so the
// fill's next read would count them again.
export const ZACH_REST_DAYS = 120
const KEEP_DAYS = 180
const MAX_VIEWS = 8
const MAX_HEADS = 60
const MAX_TITLES = 6

// One People view the reader looked at: q = its keyword ('' = the whole
// People tab; a parent company's tab searched for the brand's name),
// heads = the headline of each "LinkedIn Member" card on it ('' when the
// card showed none).
export type HiddenView = { q: string; url: string; heads: string[] }

export type HiddenEntry = {
  at: string
  by: 'fill' | 'hand'
  // Hidden people, views merged (a person can turn up in several views;
  // with no name to go on, the same headline counts once per view at most).
  n: number
  // Of them, the ones who look like buyers: a buyer headline, or no
  // headline at all in a marketing / partnerships search.
  likely: number
  // The buyer-looking titles, for the list.
  titles: string[]
  // Where Zach should read: the view with the most likely buyers.
  url: string | null
  q: string
  zachAt?: string | null
  zachAdded?: number | null
}
export type HiddenLog = Record<string, HiddenEntry>

const clip = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

// A company People page, cleaned: the page and its keyword, nothing else
// LinkedIn adds to the address. Always rebuilt on www.linkedin.com from
// the path (as companySlug reads any host), so what the dashboard links
// is LinkedIn whatever the script sent. null = not a People page.
export function peopleViewUrl(raw: unknown): string | null {
  let u: URL
  try { u = new URL(String(raw || '')) } catch { return null }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const m = u.pathname.match(/^\/(company|showcase)\/([^/?#]+)\/people\/?$/i)
  if (!m) return null
  const kw = clip(u.searchParams.get('keywords'), 80)
  return 'https://www.linkedin.com/' + m[1].toLowerCase() + '/' + m[2] + '/people/' + (kw ? '?keywords=' + encodeURIComponent(kw) : '')
}

// What a script sent, made safe to keep: People pages only, short strings,
// views with nobody hidden left out.
export function cleanViews(raw: unknown): HiddenView[] {
  if (!Array.isArray(raw)) return []
  const out: HiddenView[] = []
  for (const v of raw.slice(0, MAX_VIEWS)) {
    const url = peopleViewUrl((v as any)?.url)
    const heads = Array.isArray((v as any)?.heads) ? (v as any).heads.slice(0, MAX_HEADS).map((h: unknown) => clip(h, 200)) : []
    if (!url || !heads.length) continue
    out.push({ q: clip((v as any)?.q, 80), url, heads })
  }
  return out
}

const headKey = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
// The searches whose cards are marketers whatever their headline says:
// the People views the fill and the hand scan open (marketing,
// partnerships, sponsorship, brand manager). A parent's tab searched for
// the brand's name is not one — anyone who mentions the brand turns up.
const BUYER_SEARCH = /market|partner|sponsor|brand|event|experiential/i

// How many hidden people, how many look like buyers, and where Zach
// should look. `names` = the brand's own names and its parent's (the
// same list the save uses), so "CEO of <another company>" stays out;
// `notBuyer` = the save's other refusals (someone on a sister brand).
export function summarizeHidden(views: HiddenView[], names?: string[] | null, notBuyer?: (headline: string) => boolean) {
  const merged = new Map<string, { head: string; count: number }>()
  let blanksAll = 0, blanksKeyword = 0
  const buyerHead = new Map<string, boolean>()
  const judge = (h: string) => {
    const k = headKey(h)
    if (!buyerHead.has(k)) buyerHead.set(k, isBuyer(roleFromHeadline(h, null), h, names) && !(notBuyer && notBuyer(h)))
    return buyerHead.get(k)!
  }
  let best: { url: string; q: string; score: number } | null = null
  for (const v of views) {
    const counts = new Map<string, { head: string; count: number }>()
    let blanks = 0
    for (const h of v.heads) {
      if (!h) { blanks++; continue }
      const k = headKey(h)
      if (!k) { blanks++; continue }
      const c = counts.get(k) || { head: h, count: 0 }
      c.count++
      counts.set(k, c)
    }
    for (const [k, c] of counts) {
      const m = merged.get(k)
      if (!m || c.count > m.count) merged.set(k, { head: m?.head || c.head, count: Math.max(c.count, m?.count || 0) })
    }
    blanksAll = Math.max(blanksAll, blanks)
    const buyerSearch = BUYER_SEARCH.test(v.q)
    if (buyerSearch) blanksKeyword = Math.max(blanksKeyword, blanks)
    let score = buyerSearch ? blanks : 0
    for (const c of counts.values()) if (judge(c.head)) score += c.count
    // Ties go to a searched view: it's the shorter page for Zach to read.
    if (score > 0 && (!best || score > best.score || (score === best.score && v.q && !best.q))) best = { url: v.url, q: v.q, score }
  }
  let n = blanksAll, likely = blanksKeyword
  const titles: string[] = []
  const seenTitle = new Set<string>()
  for (const c of merged.values()) {
    n += c.count
    if (!judge(c.head)) continue
    likely += c.count
    const role = roleFromHeadline(c.head, null) || c.head
    const k = headKey(role)
    if (titles.length < MAX_TITLES && !seenTitle.has(k)) { seenTitle.add(k); titles.push(clip(role, 80)) }
  }
  return { n, likely, titles, url: best ? best.url : null, q: best ? best.q : '' }
}

const fresh = (log: HiddenLog, now: number) => {
  const kept: HiddenLog = {}
  for (const [id, e] of Object.entries(log)) {
    const last = Math.max(Date.parse(e?.at) || 0, Date.parse(e?.zachAt || '') || 0)
    if (e && now - last < KEEP_DAYS * 864e5) kept[id] = e
  }
  return kept
}

// The log after Leo's account read a brand. A fill read is the whole
// brand (its views), so it replaces what was there — and one that saw
// nobody hidden clears it. A hand read is often one view: it replaces
// only a finding with fewer likely buyers, and seeing nobody says nothing
// about the other views. Zach's read is kept either way.
export function recordHidden(
  log: HiddenLog, brandId: string, rawViews: unknown,
  opts: { by: 'fill' | 'hand'; names?: string[] | null; notBuyer?: (headline: string) => boolean; now?: number },
): HiddenLog {
  const now = opts.now ?? Date.now()
  const out = fresh({ ...log }, now)
  const views = cleanViews(rawViews)
  const prev = out[brandId]
  if (!views.length) {
    if (opts.by === 'fill' && prev) delete out[brandId]
    return out
  }
  const s = summarizeHidden(views, opts.names, opts.notBuyer)
  if (opts.by === 'hand' && prev && prev.likely > s.likely) return out
  out[brandId] = {
    at: new Date(now).toISOString(), by: opts.by,
    n: s.n, likely: s.likely, titles: s.titles, url: s.url, q: s.q,
    zachAt: prev?.zachAt ?? null, zachAdded: prev?.zachAdded ?? null,
  }
  return out
}

// Zach's account read the brand (added = how many it saved). Only a brand
// on the log is marked — anything else was never waiting on him.
export function markZachRead(log: HiddenLog, brandId: string, added: number, now = Date.now()): HiddenLog {
  const prev = log[brandId]
  if (!prev) return log
  return { ...log, [brandId]: { ...prev, zachAt: new Date(now).toISOString(), zachAdded: Math.max(0, Number(added) || 0) } }
}

// Back on Zach's list (the Undo of "Done").
export function clearZachRead(log: HiddenLog, brandId: string): HiddenLog {
  const prev = log[brandId]
  if (!prev) return log
  return { ...log, [brandId]: { ...prev, zachAt: null, zachAdded: null } }
}

// Waiting on Zach's account: likely buyers hidden from Leo, and Zach
// hasn't read it in the last ZACH_REST_DAYS.
export function zachDue(e: HiddenEntry | undefined | null, now = Date.now()): boolean {
  if (!e || !(e.likely > 0) || !e.url) return false
  const z = Date.parse(e.zachAt || '')
  return !(Number.isFinite(z) && now - z < ZACH_REST_DAYS * 864e5)
}

// ---- the Setting ----

type SettingStore = {
  setting: {
    findUnique(args: any): Promise<{ value: string } | null>
    upsert(args: any): Promise<any>
  }
}

export async function readHiddenLog(db: SettingStore): Promise<HiddenLog> {
  try {
    const row = await db.setting.findUnique({ where: { key: LI_HIDDEN_KEY } })
    const parsed = row ? JSON.parse(row.value) : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    // A corrupt value must never stop a run or a save.
    return {}
  }
}

// One writer at a time (the fill's visit and Zach's read can land
// together), the way li-report's recordRun does it.
export async function updateHiddenLog(db: SettingStore & { $transaction?: any }, change: (log: HiddenLog) => HiddenLog) {
  const write = async (tx: any) => {
    if (tx.$queryRaw) await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${LI_HIDDEN_KEY}))::text`
    const before = await readHiddenLog(tx)
    const next = change(before)
    if (next === before) return
    const v = JSON.stringify(next)
    await tx.setting.upsert({ where: { key: LI_HIDDEN_KEY }, create: { key: LI_HIDDEN_KEY, value: v }, update: { value: v } })
  }
  if (typeof db.$transaction === 'function') await db.$transaction(write, { maxWait: 10000, timeout: 20000 })
  else await write(db)
}
