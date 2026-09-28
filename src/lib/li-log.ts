// src/lib/li-log.ts
//
// Logging a LinkedIn person by hand. Leo (Sep 2026): "I sometimes send
// invites straight from LinkedIn without logging them, so when they
// accept I have to add the person, put them in the queue, mark the invite
// sent, then accepted." Now one step, from Zach's list (+ Add from
// LinkedIn), the brand page, or the SB · Log pill on their LinkedIn profile
// (scripts/linkedin-log.user.js, Zach's browser):
//
//   · Invite sent — logged the day it goes out, dated now, so it counts
//     like any send (the day's 30, LinkedIn's weekly limit, accept rates).
//     "They accepted" is then one click wherever they show.
//   · Accepted — the invite went out unlogged on a day nobody knows. The
//     row goes straight to accepted with NO invite date: it stays out of
//     the weekly limit, coverage and accept rates (Leo's call — only the
//     people who accept ever get logged this way, so counting them would
//     make a category look better than it is). The brand still counts as
//     reached (status, not date), and Zach's list picks them up with
//     "Text them" due 24h after the log, as for any accept.
//
// Neither ever stamps a day's queue. The rules are pure here so
// node scripts/test-li-log.mjs can pin them; the writes are in
// li-log-db.ts.

import { cleanName, personKey, profileSlug } from './li-capture'

export type LogStage = 'sent' | 'accepted'

export function isLogStage(s: unknown): s is LogStage {
  return s === 'sent' || s === 'accepted'
}

// Letters after a name in a profile link: "jane-doe-mba".
const SLUG_TAIL = /^(mba|phd|cpa|pmp|msc|ms|ma|bs|ba|jd|md|cfa|esq|jr|sr|ii|iii)$/

// A name to start the form with, from a profile link:
//   linkedin.com/in/jane-doe-4b21a3/ → "Jane Doe"
// LinkedIn adds a code to common names (any part with a digit). One word
// ("janedoe") can't be split, and a very long slug is not a name, so
// those give nothing — the box stays empty rather than wrong.
export function nameFromSlug(input: string | null | undefined): string | null {
  const raw = String(input || '').trim()
  let slug = profileSlug(raw)
  if (!slug && /^[^\s\/?#]+$/.test(raw)) {
    slug = raw.toLowerCase()
    try { slug = decodeURIComponent(slug) } catch { /* keep as is */ }
  }
  if (!slug) return null
  const words = slug.split(/[-_.]+/).filter(w => w && !/\d/.test(w))
  while (words.length > 2 && SLUG_TAIL.test(words[words.length - 1])) words.pop()
  if (words.length < 2 || words.length > 5) return null
  const name = words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  return cleanName(name)
}

// Where someone's LinkedIn row stands, as far as a log is concerned.
export type TargetNow = { status: string; sentAt: Date | null; queuedFor: Date | null; shelved: boolean } | null

export type LogData = { status: LogStage; sentAt?: Date | null; queuedFor?: null; shelved?: false }

export type LogWrite =
  | { kind: 'none'; reason: 'already-sent' | 'already-accepted' | 'already-replied' | 'won'; status: string }
  | { kind: 'create' | 'update'; from: string | null; to: LogStage; data: LogData }

// What one log does to a person's row (null = they have none yet).
// Nothing is ever moved backwards: someone who already accepted or
// replied stays where they are, and so does an invite already logged.
export function logWrite(t: TargetNow, stage: LogStage, now: Date): LogWrite {
  if (t) {
    if (t.status === 'converted') return { kind: 'none', reason: 'won', status: t.status }
    if (t.status === 'replied') return { kind: 'none', reason: 'already-replied', status: t.status }
    if (t.status === 'accepted') return { kind: 'none', reason: 'already-accepted', status: t.status }
    if (t.status === 'sent' && stage === 'sent') return { kind: 'none', reason: 'already-sent', status: t.status }
  }
  if (stage === 'sent') {
    // Dated now, like a send out of the queue (setTargetStatus): a row
    // still carrying an earlier invite's date (Pass, or a withdrawn
    // invite) is a new invite. Whatever day's list they sat in stays.
    const data: LogData = { status: 'sent', sentAt: now, shelved: false }
    return t ? { kind: 'update', from: t.status, to: 'sent', data } : { kind: 'create', from: null, to: 'sent', data }
  }
  // Accepted. A logged invite keeps its date — it was counted, and this
  // is its accept.
  if (t && t.status === 'sent') return { kind: 'update', from: 'sent', to: 'accepted', data: { status: 'accepted' } }
  // Straight to accepted: no invite date is made up, an earlier one on
  // the row stays, and they leave any day's list (they're past it).
  const data: LogData = { status: 'accepted', queuedFor: null, shelved: false }
  return t
    ? { kind: 'update', from: t.status, to: 'accepted', data }
    : { kind: 'create', from: null, to: 'accepted', data: { ...data, sentAt: null } }
}

// The person a log is about, if they're already on file: the same
// profile link anywhere, else the same name at the brand being logged
// (never two people who share a name but have different links).
export type OnFile = { id: string; brandId: string; name: string; linkedinUrl: string | null }
export function findOnFile<T extends OnFile>(
  contacts: T[],
  want: { url?: string | null; name?: string | null; brandId?: string | null },
): { contact: T; by: 'link' | 'name' } | null {
  const slug = profileSlug(want.url)
  if (slug) {
    const hit = contacts.find(c => profileSlug(c.linkedinUrl) === slug)
    if (hit) return { contact: hit, by: 'link' }
  }
  const key = personKey(want.name)
  if (key && want.brandId) {
    const hit = contacts.find(c => {
      if (c.brandId !== want.brandId || personKey(c.name) !== key) return false
      const theirs = profileSlug(c.linkedinUrl)
      return !(slug && theirs && theirs !== slug)
    })
    if (hit) return { contact: hit, by: 'name' }
  }
  return null
}

// What a log can still do for someone, by the status of their row
// (null = no row yet). Drives which buttons show.
export function logChoices(status: string | null | undefined): LogStage[] {
  if (!status || ['queued', 'drafted', 'passed', 'withdrawn', 'declined', 'dead'].includes(status)) return ['sent', 'accepted']
  if (status === 'sent') return ['accepted']
  return []
}
