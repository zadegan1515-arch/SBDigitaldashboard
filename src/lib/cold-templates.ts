// The cold emails, by kind of brand (Leo, Nov 16 2026: "For energy drinks
// I'll have one template, for alcohol companies I'll have one template, for
// nicotine companies I'll have one template, and then we'll go from there …
// both on the dashboard and instantly, they should be connected").
//
// One template per group of categories — a subject and up to three emails —
// written and edited on the dashboard (Outreach → Instantly → Templates) and
// pushed to that group's own Instantly campaign, so what's on the page is
// what Instantly sends. The page also reads the campaign back and says when
// the two differ, either way round.
//
// Placeholders are the dashboard's own, as on Zach's list: (NAME) (BRAND)
// (TITLE) — and (BOARD), each person's own link to the Show Board. They
// become Instantly's {{firstName}} {{companyName}} {{jobTitle}}
// {{board_link}} on the way out and come back the same way.
//
// Pure. node scripts/test-cold-templates.mjs

import { sigOf } from './find-emails'

export const TEMPLATES_KEY = 'instantlyTemplates'      // Setting { signature?, groups?: { key: StoredTemplate } }
export const GROUP_CAMPAIGNS_KEY = 'instantlyCampaigns' // Setting { key: { id, name, at, by, sig } }
export const BOARD_VAR = 'board_link'
export const MAX_STEPS = 3

export type TemplateStep = { body: string; wait: number }   // wait = days after the email before it (0 on the first)
export type Template = { subject: string; steps: TemplateStep[] }
export type StoredTemplate = Template & { at?: string; by?: string | null }
export type TemplateGroup = { key: string; label: string; categories: string[] }

// Which template a brand's category gets. Leo's picks, Nov 16 2026: energy,
// alcohol and nicotine, then beauty and food / drinks / CPG; everyone else
// gets the general one. A category in no list is 'general'.
export const TEMPLATE_GROUPS: TemplateGroup[] = [
  { key: 'energy', label: 'Energy drinks', categories: ['energy'] },
  { key: 'alcohol', label: 'Alcohol', categories: ['alcohol', 'rtd', 'spirits'] },
  { key: 'nicotine', label: 'Nicotine', categories: ['nicotine'] },
  { key: 'beauty', label: 'Beauty', categories: ['beauty'] },
  { key: 'food', label: 'Food, drinks & CPG', categories: ['cpg', 'beverage', 'electrolytes', 'qsr'] },
  { key: 'general', label: 'Everyone else', categories: [] },
]
export const GENERAL = 'general'
const GROUP_OF = new Map<string, string>()
for (const g of TEMPLATE_GROUPS) for (const c of g.categories) GROUP_OF.set(c, g.key)
export const groupOfCategory = (category: unknown): string => GROUP_OF.get(String(category ?? '').trim().toLowerCase()) ?? GENERAL
export const groupLabel = (key: string) => TEMPLATE_GROUPS.find(g => g.key === key)?.label ?? 'Everyone else'
export const isGroup = (key: unknown): key is string => TEMPLATE_GROUPS.some(g => g.key === key)

// ---- the drafts ------------------------------------------------------
// Claude's first drafts, in the words of the dashboard's own intro email
// (email.ts introEmail and its category angles). Leo edits them on the page;
// a saved one replaces its draft. Short on purpose: one ask, one link — the
// Show Board, in the first email only (his pick).

export const DEFAULT_SIGNATURE = ['Zach Goldstein', 'Co-CEO, SB Agency'].join('\n')

const OPEN = [
  'Hi (NAME),',
  '',
  'I’m Zach, Co-CEO of SB Agency. We produce hundreds of college concerts and live events a year and put brands directly in the room with students.',
  '',
]
const BOARD_ASK = [
  '',
  'Here’s your link to our live show board, with every show we have coming up. You can browse by date, school or state and flag any that fit (BRAND):',
  '(BOARD)',
  '',
  'Worth a quick 15-minute call next week to talk it through?',
  '',
  'If this isn’t relevant, just say the word and I won’t follow up.',
  '',
  'Best,',
]
const first = (angle: string) => [...OPEN, angle, ...BOARD_ASK].join('\n')
const FOLLOW_1 = [
  'Hi (NAME),',
  '',
  'Floating this back up in case it got buried. If it’s easier than a call, I can send over two or three ideas for (BRAND) at our shows this semester.',
  '',
  'Worth a look?',
  '',
  'Best,',
].join('\n')
const FOLLOW_2 = [
  'Hi (NAME),',
  '',
  'Last note from me. If college isn’t a focus for (BRAND) right now, no problem at all, just let me know and I’ll close the loop. If the timing is better later in the year, I’m happy to circle back then.',
  '',
  'Best,',
].join('\n')
const draft = (angle: string): Template => ({
  subject: '(BRAND) x SB Agency',
  steps: [{ body: first(angle), wait: 0 }, { body: FOLLOW_1, wait: 3 }, { body: FOLLOW_2, wait: 4 }],
})

export const DEFAULT_TEMPLATES: Record<string, Template> = {
  energy: draft('Concerts are a natural sampling moment for (BRAND): thousands of students with a cold can in hand at peak energy, plus all the content that follows.'),
  alcohol: draft('Our 21+ events give (BRAND) a compliant way to put product in hands, in exactly the setting where trial converts.'),
  // No sampling promised here: free samples of nicotine products are tightly
  // restricted. Leo says what SB actually offers this category.
  nicotine: draft('We know this category has to be done carefully. Our 21+ events give (BRAND) a way to be in the room with adult consumers, on your compliance terms.'),
  beauty: draft('Sorority house drops and the getting-ready moments before every show are a natural fit for (BRAND). That’s where routines form and content gets made.'),
  food: draft('Show nights, and the houses around them, are where students try something new: sampling at the doors, drops across our Greek chapters, and everything they post after.'),
  general: draft('We help brands reach students in person: on-site activations, sampling, ambassador seeding and content at the shows they’re already going to.'),
}

// ---- reading and saving ------------------------------------------------

const text = (v: unknown, max: number) => String(v ?? '').replace(/\r\n?/g, '\n').slice(0, max)
const days = (v: unknown, fallback: number) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(60, Math.max(0, n)) : fallback
}
// What someone typed, made safe to keep: a subject on one line, one to
// three emails, each with words in it, the first with no wait. Throws in
// plain words when it can't be a template.
export function cleanTemplate(input: unknown): Template {
  const t = (input && typeof input === 'object' ? input : {}) as { subject?: unknown; steps?: unknown }
  const subject = text(t.subject, 200).replace(/\n+/g, ' ').trim()
  if (!subject) throw new Error('The subject is empty')
  const raw = Array.isArray(t.steps) ? t.steps : []
  const steps: TemplateStep[] = []
  for (const s of raw) {
    if (steps.length >= MAX_STEPS) break
    const body = text((s as any)?.body, 6000).replace(/[ \t]+\n/g, '\n').trim()
    if (!body) continue
    steps.push({ body, wait: steps.length ? Math.max(1, days((s as any)?.wait, 3)) : 0 })
  }
  if (!steps.length) throw new Error('The first email is empty')
  return { subject, steps }
}
export const cleanSignature = (v: unknown) => text(v, 600).replace(/[ \t]+\n/g, '\n').trim()

export type TemplatesState = { signature?: string; groups?: Record<string, StoredTemplate> }
// The template each group uses now: Leo's saved one, else the draft.
export function readTemplates(state: TemplatesState | null | undefined) {
  const saved = state?.groups ?? {}
  const signature = typeof state?.signature === 'string' ? state.signature : DEFAULT_SIGNATURE
  return {
    signature,
    groups: TEMPLATE_GROUPS.map(g => {
      const own = saved[g.key]
      let tpl: Template = DEFAULT_TEMPLATES[g.key]
      if (own) { try { tpl = cleanTemplate(own) } catch { tpl = DEFAULT_TEMPLATES[g.key] } }
      return { ...g, subject: tpl.subject, steps: tpl.steps, edited: !!own, at: own?.at ?? null, by: own?.by ?? null }
    }),
  }
}

// ---- placeholders ------------------------------------------------------

const TO_INSTANTLY: Array<[RegExp, string]> = [
  [/\(NAME\)|\[Name\]/g, '{{firstName}}'], [/\(BRAND\)|\[Brand\]/g, '{{companyName}}'],
  [/\(TITLE\)|\[Title\]/g, '{{jobTitle}}'], [/\(BOARD\)|\[Board\]/g, '{{' + BOARD_VAR + '}}'],
]
const FROM_INSTANTLY: Array<[RegExp, string]> = [
  [/\{\{\s*firstName\s*\}\}/g, '(NAME)'], [/\{\{\s*companyName\s*\}\}/g, '(BRAND)'],
  [/\{\{\s*jobTitle\s*\}\}/g, '(TITLE)'], [new RegExp('\\{\\{\\s*' + BOARD_VAR + '\\s*\\}\\}', 'g'), '(BOARD)'],
]
export const toInstantlyVars = (s: string) => TO_INSTANTLY.reduce((out, [re, to]) => out.replace(re, to), s)
export const fromInstantlyVars = (s: string) => FROM_INSTANTLY.reduce((out, [re, to]) => out.replace(re, to), s)
export const hasBoard = (s: string) => /\(BOARD\)|\[Board\]/.test(s)

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

// An email as it goes out: its words, then the signature under them.
export const withSignature = (body: string, signature: string) => (signature.trim() ? body.trimEnd() + '\n' + signature.trim() : body.trimEnd())
export function withoutSignature(body: string, signature: string): string {
  const sig = signature.trim()
  const b = body.trimEnd()
  return sig && b.endsWith(sig) ? b.slice(0, b.length - sig.length).trimEnd() : b
}

// ---- the Instantly sequence --------------------------------------------

export type InstantlyStep = { type: 'email'; delay: number; delay_unit?: string; variants: Array<{ subject: string; body: string; v_disabled?: boolean }> }
export type InstantlySequence = { steps: InstantlyStep[] }

// A template as Instantly's one sequence. A step's `delay` there is the wait
// before the NEXT email, so each step carries the wait of the one after it.
// Follow-ups go with no subject of their own: Instantly sends those in the
// first email's thread.
export function toSequence(t: Template, signature: string): InstantlySequence[] {
  return [{
    steps: t.steps.map((s, i) => ({
      type: 'email' as const,
      delay: t.steps[i + 1]?.wait ?? 0,
      delay_unit: 'days',
      variants: [{ subject: i === 0 ? toInstantlyVars(t.subject) : '', body: toHtml(withSignature(s.body, signature)) }],
    })),
  }]
}
// Instantly's sequence as a template (its first enabled variant of each
// step; a step's own wait is the delay of the one before it, in days).
export function fromSequence(sequences: unknown, signature: string): Template | null {
  const steps = Array.isArray(sequences) && sequences[0] && Array.isArray((sequences[0] as any).steps) ? ((sequences[0] as any).steps as any[]) : []
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
// spacing Instantly keeps.
const squeeze = (s: string) => s.replace(/\s+/g, ' ').trim()
export function templateSig(t: Template | null, signature: string): string {
  if (!t) return ''
  return sigOf([squeeze(t.subject), ...t.steps.map((s, i) => i + ':' + s.wait + ':' + squeeze(withoutSignature(s.body, signature)))])
}

export type SyncState = 'none' | 'gone' | 'match' | 'differs' | 'empty'
// Where a group's template stands against its Instantly campaign:
//   none — no campaign yet · gone — the campaign isn't in Instantly any more ·
//   empty — the campaign has no email written · match · differs (and whose
//   copy changed last: the dashboard's, or Instantly's own since the push).
export function syncState(args: { mine: Template; signature: string; linked: boolean; found: boolean; theirs: Template | null; pushedSig?: string | null }): { state: SyncState; newer: 'dashboard' | 'instantly' | null } {
  if (!args.linked) return { state: 'none', newer: null }
  if (!args.found) return { state: 'gone', newer: null }
  if (!args.theirs) return { state: 'empty', newer: 'dashboard' }
  const a = templateSig(args.mine, args.signature), b = templateSig(args.theirs, args.signature)
  if (a === b) return { state: 'match', newer: null }
  return { state: 'differs', newer: args.pushedSig && args.pushedSig === b ? 'dashboard' : args.pushedSig && args.pushedSig === a ? 'instantly' : null }
}

// ---- the campaign a group gets -----------------------------------------

// A new campaign for a group, as a draft: Leo attaches the inbox and starts
// it in Instantly. Tue–Thu, 9 to 5 Eastern (his outreach days); 30 a day;
// stops on a reply, and for the whole company once someone there answers;
// plain text, no open or link tracking (the Show Board logs its own opens).
// Days: 0 = Sunday … 6 = Saturday (unverified against Instantly — the page
// asks Leo to look at the days before he starts it).
export function campaignDraft(group: string, sequences: InstantlySequence[]) {
  return {
    name: 'SB cold · ' + groupLabel(group),
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

// ---- a preview ---------------------------------------------------------

// A template filled for one person, as they'd read it.
export function fillTemplate(s: string, who: { first?: string | null; brand?: string | null; title?: string | null; board?: string | null }): string {
  return s
    .replace(/\(NAME\)|\[Name\]/g, who.first || 'there')
    .replace(/\(BRAND\)|\[Brand\]/g, who.brand || 'your brand')
    .replace(/\(TITLE\)|\[Title\]/g, who.title || '')
    .replace(/\(BOARD\)|\[Board\]/g, who.board || '')
}
