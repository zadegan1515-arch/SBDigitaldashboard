// src/lib/claude-day.ts
//
// Claude's day (Leo, Oct 14 2026: "at the end of each day i want a review of
// everything that was updated through claude"). Home → Claude's day: what
// Claude shipped to the site (its commits on main), what it changed in the
// data (every write a Claude session made through /api/data with the
// dashboard token, logged as a ClaudeAction), what the sessions logged, and
// what they need from Leo. Opens by itself after 5pm New York.
//
// Pure here: which calls are changes and how they read, and how a commit
// reads. /api/data logs and reads. node scripts/test-claude-day.mjs

// Reads, never logged (a preview or stale answer isn't a change either):
// a read verb followed by a capital (getBrand — not mergePeople), or one of
// the read-only handlers by its whole name.
const READ_VERB = /^(?:get|list|search|find|read|load|preview|count)[A-Z]/
const READ_NAMES = new Set(['claudeDay', 'dayRecap', 'weeklyScore', 'staleDeals', 'todaySendList', 'zachTodo', 'categoryReach', 'categoryBrands',
  'categoryCoverage', 'outcomeTable', 'fillSchedule', 'liRunDetail', 'linkedinPeople', 'suggestForDay', 'sentByCompany', 'secondTryBrands',
  'boardCodeLookup', 'sponsorUrl', 'segmentsOverview', 'audienceEventStats', 'appVersion', 'researchList', 'planDayChoices', 'nextBestBrands',
  'staleInvites', 'repliedOverview', 'buyerCoverage', 'brandLookup', 'brandTimeline', 'brandStock', 'brandPlanLine', 'scheduleStamp',
  'suMatchQueue', 'sheetStatus', 'whoAmI', 'me', 'findDuplicates', 'sponsorReport', 'search', 'checkEmailReplies',
  'weekBank', 'weekBankBrowse'])
const isRead = (fn: string) => READ_VERB.test(fn) || READ_NAMES.has(fn)

// Calls that change only with confirm / apply; without it they preview.
const NEEDS_YES: Record<string, string[]> = {
  planWeek: ['apply'], fitArchive: ['apply', 'confirm'], refileCategories: ['apply', 'confirm'],
  deleteBrand: ['confirm'], mergeBrands: ['confirm'], weekSpread: ['apply'],
}
// Calls that preview unless told preview: false.
const PREVIEW_BY_DEFAULT = new Set(['researchImport', 'researchUndo'])

// The work-log itself shows on the review as "What Claude did"; a chat
// logging where it stands (chatLog) is the "Your chats" card.
const NOT_SHOWN = new Set(['addWorkLog', 'chatLog'])

const s = (v: unknown, n = 60) => {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}
const count = (v: unknown) => (Array.isArray(v) ? v.length : 0)
const plural = (n: number, one: string, many = one + 's') => n + ' ' + (n === 1 ? one : many)

// camelCase handler name → words ("setCategoryPriority" → "Set category priority").
export function fnWords(fn: string): string {
  const w = String(fn || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().trim()
  return w ? w.charAt(0).toUpperCase() + w.slice(1) : 'Did something'
}

// What a Claude call changed, in words; null = nothing to show (a read, a
// preview, a refusal, the work log).
export function actionText(fn: string, args: any, result: any): string | null {
  if (!fn || isRead(fn) || NOT_SHOWN.has(fn)) return null
  const a = args && typeof args === 'object' ? args : {}
  const r = result && typeof result === 'object' ? result : {}
  if (a.preview === true || a.dryRun === true || r.preview === true || r.applied === false || r.stale === true || r.noop) return null
  // Refusals and previews that say so in their own words.
  if (r.ok === false || r.deleted === false || r.merged === false || r.queued === false) return null
  if (PREVIEW_BY_DEFAULT.has(fn) && a.preview !== false) return null
  const yes = NEEDS_YES[fn]
  if (yes && !yes.some(k => a[k])) return null
  const brand = s(r.brand?.name || r.brandName || r.name || a.name || a.brandName || '')
  switch (fn) {
    case 'combineParent': return `Combined ${s(a.parent)}'s brands into one${count(r.brands) ? ' (' + plural(count(r.brands), 'brand') + ')' : ''}`
    case 'undoCombineParent': return `Took back the ${s(a.parent || r.parent || '')} combine`.replace(/ {2,}/g, ' ')
    case 'mergePeople': return `Merged people on file twice${brand ? ' at ' + brand : ''}`
    case 'undoMergePeople': return 'Took back a merge of people on file twice'
    case 'chatAddBrand': return `Added ${s(r.brand?.name || a.brand?.name || 'a brand')} from the Add a brand chat${r.factsWritten ? ' (with its facts)' : ''}`
    case 'researchStage': return `Staged Brand Fit research for ${plural(count(a.rows), 'brand')} — waiting for your review`
    case 'researchImport': return `Saved reviewed Brand Fit facts for ${plural(Number(r.updated ?? r.applied ?? r.saved ?? count(a.brands)) || 0, 'brand')}`
    case 'importContacts': return `Added ${plural(Number(r.added ?? r.created ?? count(a.rows)) || 0, 'person', 'people')}${a.source ? ' (' + s(a.source, 20) + ')' : ''}`
    case 'reviewNewBrands': return `${a.action === 'archive' ? 'Archived' : 'Kept'} ${plural(count(a.ids), 'brand')} from New from LinkedIn`
    case 'saveHandTemplate': return `Saved the ${s(a.kind || 'email')} message template on Zach's list`
    case 'setCategoryPriority': return 'Changed the category priority'
    case 'liPageRetry': return `Sent ${brand || 'a brand'} back to the LinkedIn fill`
    case 'addDiscoveredBulk': return `Added ${plural(Number(r.added) || 0, 'brand')} from Discover`
    case 'addDiscoveredBrand': return 'Added a brand from Discover'
    case 'createBrand': return `Added ${s(a.name || brand || 'a brand')}`
    case 'updateBrand': return `Edited ${brand || 'a brand'}${a.facts ? ' (facts)' : ''}`
    case 'upsertContact': return `${a.id ? 'Edited' : 'Added'} ${s(a.name || 'a person')}`
    case 'weekBankAdd': return `Put ${plural(count(r.added), 'brand')} on the week list`
    case 'weekBankRemove': return `Took ${plural(count(a.brandIds), 'brand')} off the week list`
    case 'weekBankPutBack': return `Put ${plural(count(a.brandIds), 'brand')} back on the week list`
    case 'weekBankSize': return `Set the week list to ${Number(r.size ?? a.size) || 0} brands`
    case 'weekSpread': return `Spread the week list onto ${plural(count(a.days), 'day')} (${Array.isArray(r.days) ? r.days.reduce((n: number, d: any) => n + (Number(d?.added) || 0), 0) : 0} brands)`
    case 'undoWeekSpread': return 'Took back the last week list spread'
    case 'setListDay': return `${a.on === false ? 'Let Best fit fill' : 'Kept to the week list:'} ${s(a.date)}`
    case 'planAddBrands': return `Put ${plural(count(a.brandIds) || count(r.added), 'brand')} on ${s(a.date || 'a day')}`
    case 'setBrandPassed': return `${a.passed === false ? 'Brought back' : 'Archived'} ${brand || 'a brand'}`
    case 'notSamePerson': return a.undo ? 'Took back a "not the same person"' : 'Marked two people as not the same person'
    // A second click on a stop that already stands changed nothing.
    case 'stopContact': return r.already ? null : stopText(a, r, true)
    case 'undoStopContact': return r.already ? null : stopText(a, r, false)
    // In talks (the top tab).
    case 'setInTalks': return `${a.on === false ? 'Took' : 'Put'} ${brand || 'a brand'} ${a.on === false ? 'off' : 'on'} In talks`
    case 'saveTalksProfile': return Array.isArray(r.saved) && r.saved.length ? `Wrote ${brand || 'a brand'}'s In talks ${r.saved.join(', ')}` : null
    case 'addBrandNote': return `Added a note on ${brand || 'a brand'} (In talks)`
    case 'editBrandNote': return `Edited a note on ${brand || 'a brand'} (In talks)`
    case 'deleteBrandNote': return `Deleted a note on ${brand || 'a brand'} (In talks)`
    case 'handStep':
      if (a.step === 'declined') return r.already ? null : stopText(a, r, a.on !== false)
      return `Zach's list: ${s(a.step, 20)}${a.on === false ? ' undone' : ''}${r.contactName ? ' — ' + s(r.contactName) : ''}`
  }
  // Anything else: its name, with the one thing it was about.
  const about = s(a.parent || a.name || a.category || a.kind || a.day || a.date || '', 40)
  return fnWords(fn) + (about ? ' — ' + about : '')
}

// "Doesn't want to continue" (Zach's list): who, and whether the whole brand.
function stopText(a: any, r: any, on: boolean): string {
  const who = s(r.contactName || 'someone')
  const brand = (r.scope || a.scope) === 'brand'
  return on
    ? `Marked ${who}: doesn't want to continue${brand ? ` — the whole brand${r.brandName ? ' (' + s(r.brandName) + ')' : ''}` : ''}`
    : `Took back "doesn't want to continue" for ${who}${brand ? ' (whole brand)' : ''}`
}

// The part of a call worth keeping beside its words: short values only,
// never whole lists or long text (rows of people, pasted chats).
export function argsBrief(args: any): string {
  const a = args && typeof args === 'object' ? args : {}
  const parts: string[] = []
  for (const [k, v] of Object.entries(a)) {
    if (k.startsWith('__')) continue
    if (typeof v === 'string' && v.length <= 60) parts.push(k + '=' + v)
    else if (typeof v === 'number' || typeof v === 'boolean') parts.push(k + '=' + v)
    else if (Array.isArray(v)) parts.push(k + '=[' + v.length + ']')
    if (parts.length >= 6) break
  }
  return parts.join(' ').slice(0, 300)
}

// Commits on main: Claude's (they all carry its trailer), merges left out.
export type DayCommit = { sha: string; at: string; title: string; lines: string[]; url: string }
export const CLAUDE_TRAILER = /Claude-Session:|Co-Authored-By: Claude|Generated with \[Claude Code\]/i

export function readCommit(c: { sha: string; html_url?: string; commit: { message: string; committer?: { date?: string } | null; author?: { date?: string } | null } }): DayCommit | null {
  const msg = String(c.commit?.message || '')
  const [title, ...rest] = msg.split('\n')
  if (/^Merge (?:branch|remote-tracking|pull request|main|origin)/i.test(title) || !CLAUDE_TRAILER.test(msg)) return null
  const lines: string[] = []
  let cur = ''
  for (const raw of rest) {
    const l = raw.trim()
    if (!l) { if (cur) { lines.push(cur); cur = '' } continue }
    if (/^(Co-Authored-By|Claude-Session|Signed-off-by):/i.test(l) || /Generated with \[Claude Code\]/i.test(l)) continue
    if (/^[-*•]\s+/.test(l)) { if (cur) lines.push(cur); cur = l.replace(/^[-*•]\s+/, '') }
    else cur = cur ? cur + ' ' + l : l
  }
  if (cur) lines.push(cur)
  return {
    sha: String(c.sha || '').slice(0, 7), at: String(c.commit?.committer?.date || c.commit?.author?.date || ''),
    title: title.trim(), lines: lines.slice(0, 5).map(x => (x.length > 260 ? x.slice(0, 259) + '…' : x)), url: c.html_url || '',
  }
}
