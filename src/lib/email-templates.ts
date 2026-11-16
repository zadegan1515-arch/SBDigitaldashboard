// Email → Templates (Leo, Nov 16 2026: "a Template tab under the Email tab
// with templates and I want you to separate by category"). Pure rules: which
// templates there are, what each says until Leo writes his own, and how a
// save reads. /api/data stores Leo's own versions in Setting `emailTemplates`
// ({ key: { subject, body, at, by } }); a template with no entry follows its
// default. node scripts/test-email-templates.mjs
//
// (NAME) = first name, (BRAND) = the brand — the same placeholders as Zach's
// list. Nothing here sends or drafts anything: the page copies the text
// (as it is, or with Instantly's own tags) for Leo to paste.

import { CATEGORY_KEYS } from './category-hints'

export const EMAIL_TEMPLATES_KEY = 'emailTemplates'
export const SUBJECT_MAX = 200
export const BODY_MAX = 8000

export type Tpl = { subject: string; body: string }
export type OwnTpl = Tpl & { at?: string | null; by?: string | null }
export type Angles = Record<string, { insert: string } | undefined>

// The templates every category shares.
export const GENERAL_KEYS = ['intro', 'followup', 'final'] as const
export const GENERAL_LABELS: Record<string, string> = {
  intro: 'First email',
  followup: 'Follow-up',
  final: 'Last follow-up',
}

const SIGN_OFF = 'Best,\nZach'

// Leo's intro, word for word (introEmail in email.ts), with the placeholders.
// `angle` is one extra paragraph for a category, after the second.
export function introText(angle?: string): Tpl {
  const lines = [
    'Hi (NAME),',
    '',
    "Hope you're having a good week!",
    '',
    "I'm reaching out from SB Agency. We are the largest producer of collegiate events and live entertainment activations in North America.",
    '',
    'Our experiential team puts brands directly inside the room at hundreds of major college events each year. We help partners tap into our established live audience on campus, giving them high-impact reach without having to build crowds from the ground up.',
    '',
  ]
  if (angle && angle.trim()) lines.push(angle.trim(), '')
  lines.push(
    "We'd love to jump on a quick call to better understand (BRAND)'s goals for the upcoming year and brainstorm a few ways we might collaborate.",
    '',
    'Let me know your availability next week, and we can set up a call.',
    '',
    "If this isn't relevant for you, just say the word and I won't follow up.",
    '',
    SIGN_OFF,
  )
  return { subject: 'SB Agency x (BRAND)', body: lines.join('\n') }
}

const GENERAL_DEFAULTS: Record<string, Tpl> = {
  intro: introText(),
  followup: {
    subject: 're: SB Agency x (BRAND)',
    body: [
      'Hi (NAME),',
      '',
      "Wanted to float this back to the top of your inbox. We're locking in partners for the semester now, and I think (BRAND) would land really well on campus.",
      '',
      'Worth a quick 15 minutes this week?',
      '',
      SIGN_OFF,
    ].join('\n'),
  },
  final: {
    subject: 're: SB Agency x (BRAND)',
    body: [
      'Hi (NAME),',
      '',
      "Last note from me — I'll stop filling your inbox. If campus ever makes sense for (BRAND), the door's open and I'd love to build something together.",
      '',
      SIGN_OFF,
    ].join('\n'),
  },
}

export const catKey = (category: string) => 'cat:' + category
export function isTemplateKey(key: string): boolean {
  if ((GENERAL_KEYS as readonly string[]).includes(key)) return true
  return key.startsWith('cat:') && (CATEGORY_KEYS as readonly string[]).includes(key.slice(4))
}

// What a template says until Leo saves his own. A category's first email is
// the intro with that category's angle ("{brand}" → (BRAND)).
export function defaultTemplate(key: string, angles: Angles = {}): Tpl {
  if (GENERAL_DEFAULTS[key]) return GENERAL_DEFAULTS[key]
  const a = angles[key.slice(4)] ?? angles['']
  return introText(a ? a.insert.replace(/\{brand\}/g, '(BRAND)') : '')
}

export function cleanText(s: unknown, max: number): string {
  return String(s ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim().slice(0, max)
}

// Leo's saved versions, as stored: only known keys, only real text.
export function parseOwn(raw: unknown): Record<string, OwnTpl> {
  const out: Record<string, OwnTpl> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, v] of Object.entries(raw as Record<string, any>)) {
    if (!isTemplateKey(key) || !v || typeof v !== 'object') continue
    const body = cleanText(v.body, BODY_MAX)
    if (!body) continue
    out[key] = { subject: cleanText(v.subject, SUBJECT_MAX), body, at: v.at ?? null, by: v.by ?? null }
  }
  return out
}

export type TemplateRow = Tpl & { key: string; own: boolean; at: string | null; by: string | null; def: Tpl }

export function templateRow(key: string, own: Record<string, OwnTpl>, angles: Angles = {}): TemplateRow {
  const def = defaultTemplate(key, angles)
  const o = own[key]
  return o
    ? { key, subject: o.subject, body: o.body, own: true, at: o.at ?? null, by: o.by ?? null, def }
    : { key, subject: def.subject, body: def.body, own: false, at: null, by: null, def }
}

// A save: the cleaned text, or null when it is the default again (the entry
// goes, so the template follows the default from then on).
export function ownFromSave(key: string, subject: unknown, body: unknown, angles: Angles = {}): Tpl | null {
  const s = cleanText(subject, SUBJECT_MAX)
  const b = cleanText(body, BODY_MAX)
  if (!b) throw new Error('The email is empty, nothing to save')
  if (!s) throw new Error('Give it a subject line')
  const def = defaultTemplate(key, angles)
  return s === def.subject && b === def.body ? null : { subject: s, body: b }
}

// The text with Instantly's own tags, for pasting into a campaign there.
export function forInstantly(text: string): string {
  return String(text ?? '')
    .replace(/\((?:NAME)\)|\[Name\]/gi, '{{firstName}}')
    .replace(/\((?:BRAND)\)|\[Brand\]/gi, '{{companyName}}')
}

// The text filled in for one person, for the preview.
export function fillTemplate(text: string, name: string, brand: string): string {
  return String(text ?? '')
    .replace(/\((?:NAME)\)|\[Name\]/gi, name)
    .replace(/\((?:BRAND)\)|\[Brand\]/gi, brand)
}
