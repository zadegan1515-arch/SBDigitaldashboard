// The cold emails Instantly sends, by kind of brand (Leo, Nov 16 2026: "For
// energy drinks I'll have one template, for alcohol companies I'll have one
// template, for nicotine companies I'll have one template, and then we'll go
// from there … both on the dashboard and instantly, they should be
// connected").
//
// The words live in one place: Email → Templates (email-templates.ts — a
// first email per category, and the Follow-up and Last follow-up every
// category shares). This file ties them to Instantly: one campaign per
// "campaign key", whose three emails are
//   [that key's first email, the Follow-up, the Last follow-up].
// A key is 'general' (the First email every category shares) or a category.
// Leo's picks have a campaign row from the start — energy, alcohol, nicotine,
// beauty, food / drinks / CPG, and everyone else — and the categories of a
// family go with their family's campaign (beer and spirits with alcohol;
// soda, electrolytes and food with CPG) until one is given a campaign of its
// own. The page reads each campaign back and says when it no longer says
// what the dashboard says, either way round.
//
// Placeholders are the dashboard's own, as on Zach's list: (NAME) (BRAND)
// (TITLE) — and (BOARD), each person's own link to the Show Board. They
// become Instantly's {{firstName}} {{companyName}} {{jobTitle}}
// {{board_link}} on the way out and come back the same way.
//
// Pure. node scripts/test-cold-templates.mjs

import { sigOf } from './find-emails'
import { CATEGORY_KEYS } from './category-hints'
import { catKey, templateRow, type Angles, type OwnTpl } from './email-templates'

export const TEMPLATES_KEY = 'instantlyTemplates'       // Setting { signature? } — the footer under every email in Instantly
export const GROUP_CAMPAIGNS_KEY = 'instantlyCampaigns' // Setting { key: { id, name, at, by, sig } }
export const BOARD_VAR = 'board_link'
export const MAX_STEPS = 3
// Days a follow-up waits after the email before it, in a campaign the
// dashboard makes. Leo changes them in Instantly; an update keeps his.
export const WAITS = [3, 4]

export type TemplateStep = { body: string; wait: number }   // wait = days after the email before it (0 on the first)
export type Template = { subject: string; steps: TemplateStep[] }

// ---- which campaign a brand's people go to ------------------------------

export const GENERAL = 'general'
// Leo's picks, Nov 16 2026 ("for energy drinks … alcohol companies …
// nicotine companies", then Beauty and Food, drinks, CPG; everyone else one
// general email). `also` = the categories that go with the family's campaign
// until they have one of their own.
export type Family = { key: string; label: string; also: string[] }
export const FAMILIES: Family[] = [
  { key: 'energy', label: 'Energy drinks', also: [] },
  { key: 'alcohol', label: 'Alcohol', also: ['rtd', 'spirits'] },
  { key: 'nicotine', label: 'Nicotine', also: [] },
  { key: 'beauty', label: 'Beauty', also: [] },
  { key: 'cpg', label: 'Food, drinks & CPG', also: ['beverage', 'electrolytes', 'qsr'] },
]
// The rows the page always shows.
export const MAIN_KEYS = [...FAMILIES.map(f => f.key), GENERAL]

// The site's names for its categories (CAT_NAMES in app.html — the test
// holds the two lists together).
export const CATEGORY_LABELS: Record<string, string> = {
  electrolytes: 'Electrolytes & Hydration', energy: 'Energy Drinks', beverage: 'Soda, Water & Other Drinks',
  rtd: 'Beer, Seltzers & Canned Cocktails', spirits: 'Spirits', alcohol: 'Alcohol (other)',
  nicotine: 'Nicotine Pouches', athletic: 'Athletic Wear', apparel: 'Clothing & Fashion',
  cpg: 'Snacks & CPG Food', tech: 'Tech & Gadgets', fintech: 'Fintech',
  software: 'AI & Software', beauty: 'Beauty & Grooming', apps: 'Dating & Social Apps',
  betting: 'Betting & DFS', nightlife: 'Nightlife & DJ Culture', wellness: 'Health & Wellness',
  qsr: 'Food & QSR', home: 'Home & Drinkware', entertainment: 'Entertainment & Sports',
  retail: 'Retail & Stores', transport: 'Travel & Transport', conglomerate: 'Conglomerates',
  unresolved: 'Needs Clarification',
}

const norm = (v: unknown) => String(v ?? '').trim().toLowerCase()
const isCategory = (k: string) => (CATEGORY_KEYS as readonly string[]).includes(k)
export const isCampaignKey = (key: unknown): key is string => key === GENERAL || isCategory(String(key ?? ''))
// A family's key for the category that leads it or goes with it; null for
// every other category.
export function familyOf(category: unknown): Family | null {
  const c = norm(category)
  return FAMILIES.find(f => f.key === c || f.also.includes(c)) ?? null
}
// What a campaign key is called: Leo's own word for a family, "Everyone
// else", or the category's name.
export function keyLabel(key: string): string {
  if (key === GENERAL) return 'Everyone else'
  return FAMILIES.find(f => f.key === key)?.label ?? CATEGORY_LABELS[key] ?? key
}
// Which template on Email → Templates is this key's first email.
export const firstKeyOf = (key: string) => (key === GENERAL ? 'intro' : catKey(key))

// The campaign a brand of this category sends through, given which keys
// have one (`has`): its own → its family's → for a category in no family,
// the general one. A family never falls through to the general email (Leo
// wants those brands to get their own words), so its people wait for it.
export function campaignKeyOf(category: unknown, has: (key: string) => boolean): string | null {
  const c = norm(category)
  if (isCategory(c) && has(c)) return c
  const fam = familyOf(c)
  if (fam) return has(fam.key) ? fam.key : null
  return has(GENERAL) ? GENERAL : null
}
// The key whose campaign a category waits for when it has none to go to.
export const waitsOn = (category: unknown): string => familyOf(category)?.key ?? GENERAL

// ---- the three emails of a key ------------------------------------------

// From Email → Templates as it stands (Leo's own versions, else the
// standard text): the key's first email, then the two every category shares.
export function sequenceTemplate(key: string, own: Record<string, OwnTpl>, angles: Angles = {}): Template {
  const first = templateRow(firstKeyOf(key), own, angles)
  const follow = templateRow('followup', own, angles)
  const last = templateRow('final', own, angles)
  return { subject: first.subject, steps: [{ body: first.body, wait: 0 }, { body: follow.body, wait: WAITS[0] }, { body: last.body, wait: WAITS[1] }] }
}

// ---- the footer ----------------------------------------------------------

// A few lines under every email in Instantly (a title, a mailing address).
// Empty until Leo writes one: the templates sign off themselves.
export const DEFAULT_SIGNATURE = ''
const text = (v: unknown, max: number) => String(v ?? '').replace(/\r\n?/g, '\n').slice(0, max)
export const cleanSignature = (v: unknown) => text(v, 600).replace(/[ \t]+\n/g, '\n').trim()
export type TemplatesState = { signature?: string }
export const readSignature = (state: TemplatesState | null | undefined) => (typeof state?.signature === 'string' ? state.signature : DEFAULT_SIGNATURE)

// ---- placeholders ------------------------------------------------------

const TO_INSTANTLY: Array<[RegExp, string]> = [
  [/\(NAME\)|\[Name\]/gi, '{{firstName}}'], [/\(BRAND\)|\[Brand\]/gi, '{{companyName}}'],
  [/\(TITLE\)|\[Title\]/gi, '{{jobTitle}}'], [/\(BOARD\)|\[Board\]/gi, '{{' + BOARD_VAR + '}}'],
]
const FROM_INSTANTLY: Array<[RegExp, string]> = [
  [/\{\{\s*firstName\s*\}\}/g, '(NAME)'], [/\{\{\s*companyName\s*\}\}/g, '(BRAND)'],
  [/\{\{\s*jobTitle\s*\}\}/g, '(TITLE)'], [new RegExp('\\{\\{\\s*' + BOARD_VAR + '\\s*\\}\\}', 'g'), '(BOARD)'],
]
export const toInstantlyVars = (s: string) => TO_INSTANTLY.reduce((out, [re, to]) => out.replace(re, to), s)
export const fromInstantlyVars = (s: string) => FROM_INSTANTLY.reduce((out, [re, to]) => out.replace(re, to), s)
export const hasBoard = (s: string) => /\(BOARD\)|\[Board\]/i.test(s)

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
// Plain text → the HTML Instantly wants (<br/> for a line break).
export const toHtml = (s: string) => toInstantlyVars(escHtml(s)).replace(/\n/g, '<br/>')
// And back: whatever HTML Instantly holds → plain text with our placeholders.
export function fromHtml(html: unknown): string {
  const s = String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p|li|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, '\'')
  return fromInstantlyVars(s).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

// An email as it goes out: its words, then the footer under them.
export const withSignature = (body: string, signature: string) => (signature.trim() ? body.trimEnd() + '\n\n' + signature.trim() : body.trimEnd())
export function withoutSignature(body: string, signature: string): string {
  const sig = signature.trim()
  const b = body.trimEnd()
  return sig && b.endsWith(sig) ? b.slice(0, b.length - sig.length).trimEnd() : b
}

// ---- the Instantly sequence --------------------------------------------

export type InstantlyStep = { type: 'email'; delay: number; delay_unit?: string; variants: Array<{ subject: string; body: string; v_disabled?: boolean }> }
export type InstantlySequence = { steps: InstantlyStep[] }

const stepsOf = (sequences: unknown): any[] =>
  Array.isArray(sequences) && sequences[0] && Array.isArray((sequences[0] as any).steps) ? ((sequences[0] as any).steps as any[]) : []

// A template as Instantly's one sequence. A step's `delay` there is the wait
// before the NEXT email, so each step carries the wait of the one after it.
// Follow-ups go with no subject of their own: Instantly sends those in the
// first email's thread. `keep` = the campaign's steps as they are now: their
// waits are Leo's to set in Instantly, so an update leaves them alone.
export function toSequence(t: Template, signature: string, keep?: unknown): InstantlySequence[] {
  const old = stepsOf(keep)
  return [{
    steps: t.steps.map((s, i) => {
      const was = old[i] && t.steps[i + 1] ? old[i] : null
      return {
        type: 'email' as const,
        delay: was && Number.isFinite(Number(was.delay)) ? Number(was.delay) : t.steps[i + 1]?.wait ?? 0,
        delay_unit: was?.delay_unit ? String(was.delay_unit) : 'days',
        variants: [{ subject: i === 0 ? toInstantlyVars(t.subject) : '', body: toHtml(withSignature(s.body, signature)) }],
      }
    }),
  }]
}
// Instantly's sequence as a template (its first enabled variant of each
// step; a step's own wait is the delay of the one before it, in days).
export function fromSequence(sequences: unknown, signature: string): Template | null {
  const steps = stepsOf(sequences)
  if (!steps.length) return null
  const out: TemplateStep[] = []
  let subject = ''
  let wait = 0
  for (const st of steps.slice(0, MAX_STEPS)) {
    const v = (Array.isArray(st?.variants) ? st.variants : []).find((x: any) => !x?.v_disabled) ?? st?.variants?.[0]
    if (!v) continue
    if (!out.length) subject = fromInstantlyVars(String(v.subject ?? '')).trim()
    out.push({ body: withoutSignature(fromHtml(v.body), signature), wait: out.length ? Math.max(1, wait) : 0 })
    const unit = String(st?.delay_unit ?? 'days')
    const d = Number(st?.delay) || 0
    wait = Math.round(unit === 'hours' ? d / 24 : unit === 'minutes' ? d / 1440 : d)
  }
  return out.length ? { subject, steps: out } : null
}

// What a template says, squeezed to its words: the same for the dashboard's
// copy and Instantly's when they'd send the same emails, whatever markup or
// spacing Instantly keeps. The waits aren't words: Leo sets those there.
const squeeze = (s: string) => s.replace(/\s+/g, ' ').trim()
const words = (t: Template, signature: string) => [squeeze(t.subject), ...t.steps.map(s => squeeze(withoutSignature(s.body, signature)))]
export function templateSig(t: Template | null, signature: string): string {
  if (!t) return ''
  return sigOf(words(t, signature).map((w, i) => i + ':' + w))
}

export type SyncState = 'none' | 'gone' | 'match' | 'differs' | 'empty'
export type Differs = { first: boolean; follow: boolean }
// Where a key's emails stand against its Instantly campaign:
//   none — no campaign yet · gone — the campaign isn't in Instantly any more ·
//   empty — the campaign has no email written · match · differs (which part —
//   the first email, the follow-ups, or both — and whose copy changed last:
//   the dashboard's, or Instantly's own since the dashboard last wrote it).
export function syncState(args: { mine: Template; signature: string; linked: boolean; found: boolean; theirs: Template | null; pushedSig?: string | null }): { state: SyncState; newer: 'dashboard' | 'instantly' | null; parts: Differs | null } {
  if (!args.linked) return { state: 'none', newer: null, parts: null }
  if (!args.found) return { state: 'gone', newer: null, parts: null }
  if (!args.theirs) return { state: 'empty', newer: 'dashboard', parts: null }
  const a = templateSig(args.mine, args.signature), b = templateSig(args.theirs, args.signature)
  if (a === b) return { state: 'match', newer: null, parts: null }
  const m = words(args.mine, args.signature), t = words(args.theirs, args.signature)
  const first = m[0] !== t[0] || m[1] !== t[1]
  const follow = m.length !== t.length || m.slice(2).some((w, i) => w !== t[i + 2])
  return {
    state: 'differs', parts: { first, follow },
    newer: args.pushedSig && args.pushedSig === b ? 'dashboard' : args.pushedSig && args.pushedSig === a ? 'instantly' : null,
  }
}

// ---- the campaign a key gets -------------------------------------------

// A new campaign, as a draft: Leo attaches the inbox and starts it in
// Instantly. Tue–Thu, 9 to 5 Eastern (his outreach days); 30 a day; stops on
// a reply, and for the whole company once someone there answers; plain text,
// no open or link tracking (the Show Board logs its own opens).
// Days: 0 = Sunday … 6 = Saturday (unverified against Instantly — the page
// asks Leo to look at the days before he starts it).
export function campaignDraft(key: string, sequences: InstantlySequence[]) {
  return {
    name: 'SB cold · ' + keyLabel(key),
    campaign_schedule: {
      schedules: [{
        name: 'Tue–Thu',
        timing: { from: '09:00', to: '17:00' },
        days: { '0': false, '1': false, '2': true, '3': true, '4': true, '5': false, '6': false },
        timezone: 'America/Detroit',
      }],
    },
    sequences,
    daily_limit: 30,
    stop_on_reply: true,
    stop_for_company: true,
    text_only: true,
    open_tracking: false,
    link_tracking: false,
    insert_unsubscribe_header: true,
  }
}
