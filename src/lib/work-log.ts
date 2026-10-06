// Home → Today: what Leo's Claude Code chats did, pasted in (Leo, Oct 2026:
// "I did like eight chats today … I want to paste what they did today …
// and I want all that data to be stored so I can see what was done today").
//
// Pure rules, no database, no model call (Leo's no-API-spend rule): one
// paste is split into chats (a line of --- or === between them), and each
// chat's lines are sorted into what was done, what Leo has to do (the NEED
// blocks every report ends with — CLAUDE.md rule 8) and ideas for later.
// The raw text is always kept, so a line the rules put in the wrong pile
// is never lost. Tested by `node scripts/test-work-log.mjs`.

export type WorkNeed = { label: string; steps: string[] }
export type WorkChat = {
  title: string
  done: string[]
  needs: WorkNeed[]
  ideas: string[]
  raw: string
}

export const WORK_LOG_MAX_CHARS = 60000

type Section = 'done' | 'need' | 'idea'

const DEBRIEF = /^\s*(?:#+\s*)?(?:\*\*)?debrief\b/i
const SPLIT = /^\s*(?:-{3,}|={3,}|_{3,}|\*{3,})\s*$/
const BULLET = /^(\s*)(?:[-*•–]|\d+[.)])\s+(.*)$/
const NUMBERED = /^\s*\d+[.)]\s+/
// "NEED", "**NEED: …**", "NEED — …" — the label the reports put on
// anything Leo must do himself. Upper case on purpose: "we need to" in a
// sentence is not one.
const NEED_BLOCK = /^\s*(?:[#>]+\s*)?(?:\*\*|__)?\s*NEED\b/

// Markdown to plain words: bold/italic marks, code ticks, [text](url) →
// "text (url)", heading hashes, a trailing colon on a heading.
export function cleanLine(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_m, t, u) => (t === u ? u : `${t} (${u})`))
    .replace(/(\*\*|__)/g, '')
    .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|$|[.,;:!?])/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s*#+\s*/, '')
    .replace(/^\s*>\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isHeading(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  if (/^#{1,6}\s+\S/.test(t)) return true
  if (/^(\*\*|__)[^*_]{2,90}(\*\*|__):?$/.test(t)) return true
  // "What I fixed:" — a short line ending in a colon, no bullet.
  if (!BULLET.test(t) && t.length <= 70 && /:$/.test(t) && !/https?:\/\/\S*:$/.test(t)) return true
  // "WHAT I DID", "STILL OPEN — LEO", "4) DATA FIX (Leo approved)": a short
  // line in capitals (a number in front is fine).
  const words = t.replace(/^\d+[.)]\s*/, '').replace(/\([^)]*\)/g, '')
  if (!/^[-*•–]\s/.test(t) && t.length <= 70 && /[A-Z]{2}/.test(words) && !/[a-z]/.test(words)) return true
  return false
}

// Which pile a heading opens. Need first ("What you need to give me" also
// says "give"), then ideas, else what was done — most of a report is that.
export function classifyHeading(h: string): Section {
  // "(Leo approved)" says who signed off, not what the section is.
  const t = cleanLine(h).replace(/\([^)]*\)/g, '').toLowerCase()
  if (/\bneeds?\b|from (you|leo)|you (need|must|have) to|action (needed|required)|\bleo\b|for you to do|blocked|waiting on you|to give (me|you)|still open|open items|to do\b|todo/.test(t)) return 'need'
  if (/\bideas?\b|next steps?|suggest|could (also|next|add)|future|later|what'?s next|next up|recommend|possible|nice to have|backlog|follow[- ]?ups?\b/.test(t)) return 'idea'
  return 'done'
}

// "# Debrief: LinkedIn People tool (Sep 27 – Oct 4)" → "LinkedIn People tool (Sep 27 – Oct 4)".
function cleanTitle(line: string): string {
  return cleanLine(line).replace(/:$/, '').replace(/^debrief\b\s*[:—–-]?\s*/i, '').trim() || cleanLine(line)
}

function needLabel(line: string): string {
  const t = cleanLine(line).replace(/^NEED\b\s*[:—–-]?\s*/, '').trim()
  return t || 'Something for you to do'
}

function push(list: string[], s: string) {
  if (s && !list.includes(s)) list.push(s)
}

export function parseChat(text: string, fallbackTitle = 'Claude chat'): WorkChat {
  const raw = String(text || '').trim()
  const out: WorkChat = { title: '', done: [], needs: [], ideas: [], raw }
  let section: Section = 'done'
  let block: WorkNeed | null = null  // the NEED block numbered steps go under
  let title = ''
  let first = true

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    const lead = first
    first = false

    if (NEED_BLOCK.test(line)) {
      block = { label: needLabel(line), steps: [] }
      out.needs.push(block)
      section = 'need'
      continue
    }
    if (isHeading(line)) {
      const s = classifyHeading(line)
      // A first line that isn't a section name is the chat's title.
      if (lead && s === 'done' && !/fix|did|done|ship|change|built|summary|what i/i.test(line)) {
        title = cleanTitle(line)
        continue
      }
      section = s
      block = null
      continue
    }

    const b = line.match(BULLET)
    const text = cleanLine(b ? b[2] : line)
    if (!text) continue
    if (lead && !b && text.length <= 90) { title = cleanTitle(line); continue }

    if (section === 'need') {
      const indented = !!b && b[1].length >= 2
      const last = out.needs[out.needs.length - 1]
      if (block && (NUMBERED.test(line) || indented || !b)) block.steps.push(text)
      else if (!b && last) last.steps.push(text)
      else out.needs.push({ label: text, steps: [] })
    } else if (section === 'idea') push(out.ideas, text)
    else push(out.done, text)
  }

  out.title = (title || out.done[0] || out.needs[0]?.label || out.ideas[0] || fallbackTitle).slice(0, 90)
  return out
}

// One paste may hold several chats, a line of --- / === between them. A
// piece with no words is dropped.
export function parseWorkLog(text: string): WorkChat[] {
  const pieces: string[][] = [[]]
  for (const line of String(text || '').slice(0, WORK_LOG_MAX_CHARS).split(/\r?\n/)) {
    if (SPLIT.test(line)) { pieces.push([]); continue }
    // "Here's a debrief you can paste:" is chat, not work.
    if (/^\s*(here'?s|here is|below is) (a|the) debrief\b/i.test(line)) continue
    // A new "Debrief …" / "# Debrief: …" line starts the next chat.
    const cur = pieces[pieces.length - 1]
    if (DEBRIEF.test(line) && cur.some(l => /\w/.test(l))) pieces.push([line])
    else cur.push(line)
  }
  const seen = new Set<string>()
  return pieces
    .map(p => p.join('\n').trim())
    .filter(p => /\w/.test(p) && !/^[_*]*generated (by|with) \[?claude/i.test(p))
    .filter(p => (seen.has(p) ? false : (seen.add(p), true)))
    .map((p, i) => parseChat(p, `Claude chat ${i + 1}`))
}
