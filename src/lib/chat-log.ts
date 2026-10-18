// Home → Your chats (Leo, Oct 17 2026: "i usually use more than 4 chats a day
// in claude code … i sometimes forget what each one is about, can we do a
// review … that tells me what chat did what, and what each chat needs from me").
//
// Every claude.ai chat gets one WorkLog row a day (source "session"), kept up
// to date as it goes: what Leo asked it, what its last reply says it did, the
// NEED blocks in that reply (CLAUDE.md rule 8) and the question it ended on.
// /api/data's chatLog writes it; Claude's day and Home read it.
//
// Pure here, no database, no model call (rule 4). The reply is sorted by the
// same rules as a pasted chat (work-log.ts). node scripts/test-chat-log.mjs

import { parseChat, cleanLine, type WorkNeed } from './work-log'

export const CHAT_ASK_MAX = 400
export const CHAT_ASKS_KEEP = 20
export const CHAT_REPLY_MAX = 20000
export const CHAT_QUESTION_MAX = 300
// A chat "working" this long with no reply logged is shown as stalled.
export const CHAT_STALL_MIN = 120

export type ChatStatus = 'working' | 'needs' | 'done'
export type ChatAsk = { at: string; ask: string }

// "session_01Ab…" (claude.ai) or "cse_01Ab…" (the container's name for the
// same chat) → "session_01Ab…". Anything else that looks like an id is kept
// as given (a local Claude Code chat); junk → null.
export function sessionKey(id: unknown): string | null {
  const s = String(id ?? '').trim()
  const m = s.match(/^(?:session|cse)_([A-Za-z0-9]{10,64})$/)
  if (m) return 'session_' + m[1]
  return /^[A-Za-z0-9_-]{8,80}$/.test(s) ? s : null
}

// The link that opens the chat on claude.ai; null for a local chat.
export function sessionUrl(id: unknown): string | null {
  const k = sessionKey(id)
  return k && k.startsWith('session_') ? 'https://claude.ai/code/' + k : null
}

// Rule 2: a key or password pasted into a chat never lands in the dashboard.
// Known key shapes, "Bearer …", NAME_TOKEN=value and "password: …" are hidden.
export function redactSecrets(text: unknown): string {
  return String(text ?? '')
    .replace(/\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|ya29\.[0-9A-Za-z_-]{20,}|npg_[A-Za-z0-9]{8,})/g, '[hidden]')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 [hidden]')
    .replace(/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY))(\s*=\s*)["']?[^\s"'`]{6,}["']?/gi, '$1$2[hidden]')
    .replace(/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|API_?KEY))(\s*:\s*)["']?(?=[^\s"'`]*\d)(?=[^\s"'`]*[A-Za-z])[^\s"'`]{16,}["']?/gi, '$1$2[hidden]')
    .replace(/\b((?:app\s+)?password)(\s*(?:is|=|:)\s*)[^\s,;]+/gi, '$1$2[hidden]')
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, '$1[hidden]@')
}

function cut(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t
}

// A message the system put in the chat, not Leo: a scheduled task's wake-up,
// a background task finishing, a subagent's report, a webhook.
const MACHINE = /^\s*<(task-notification|agent-message|system-reminder|webhook-payload|other-session|wake|child-session-event|teammate-message|scheduled-[a-z-]+|local-command-[a-z]+|command-[a-z]+|bash-[a-z]+)\b/i
export function isMachineText(s: unknown): boolean {
  return MACHINE.test(String(s ?? ''))
}

// What Leo typed, as one short line (no secrets); '' for a system message.
export function askLine(ask: unknown, n = CHAT_ASK_MAX): string {
  return isMachineText(ask) ? '' : cut(redactSecrets(ask), n)
}

// The chat's name: the title Leo gave it, else the first thing he asked.
export function chatTitle(given: unknown, firstAsk: unknown, fallback = 'Claude chat'): string {
  const g = cleanLine(redactSecrets(given))
  if (g) return cut(g, 90)
  const a = isMachineText(firstAsk) ? '' : cleanLine(redactSecrets(String(firstAsk ?? '').split(/\r?\n/).find(l => l.trim()) ?? ''))
  return a ? cut(a, 80) : fallback
}

const paragraphs = (text: string) => text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
const linesOf = (p: string) => p.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
// A "Sources:" list or a paragraph of links only — never the reply's end.
function isLinkList(p: string): boolean {
  const lines = linesOf(p)
  const link = (l: string) => /^(?:[-*•]\s*)?(?:\[[^\]]*\]\([^)]*\)|https?:\/\/\S+)\s*$/.test(l)
  if (lines.every(l => link(l) || /^(?:\*\*)?sources?:?(?:\*\*)?:?$/i.test(l))) return true
  return /^(?:\*\*)?sources?\b/i.test(lines[0]) && lines.slice(1).every(l => /\]\(|https?:\/\//.test(l))
}

// The question a reply ends on ("Want me to write the pitch next?"), or null.
// Trailing "Sources:" lists and link-only lines don't count as the end.
export function lastQuestion(reply: unknown): string | null {
  const paras = paragraphs(String(reply ?? ''))
  for (let i = paras.length - 1; i >= 0; i--) {
    if (isLinkList(paras[i])) continue
    const lines = linesOf(paras[i])
    const text = cleanLine(lines[lines.length - 1])
    if (!/\?\s*$/.test(text)) return null
    // The sentence holding the last "?".
    const parts = text.match(/[^.!?]*[.!?]+/g) || [text]
    const q = parts[parts.length - 1].trim() || text
    return cut(q.length < 12 ? text : q, CHAT_QUESTION_MAX)
  }
  return null
}

const NEED_START = /^\s*(?:[#>]+\s*)?(?:\*\*|__)?\s*NEED\b/
const LIST_START = /^\s*(?:[-*•–]|\d+[.)])\s+/

// A reply as the work-log rules should read it: no trailing Sources list,
// no closing question (it's kept on its own), and a plain paragraph after a
// NEED block's steps starts a new section instead of joining the steps.
function replyForParse(text: string): string {
  const paras = paragraphs(text)
  while (paras.length && isLinkList(paras[paras.length - 1])) paras.pop()
  if (paras.length && lastQuestion(paras[paras.length - 1])) {
    const lines = linesOf(paras[paras.length - 1])
    lines.pop()
    if (lines.length) paras[paras.length - 1] = lines.join('\n')
    else paras.pop()
  }
  const out: string[] = []
  let inNeed = false
  for (const p of paras) {
    const first = linesOf(p)[0] || ''
    if (NEED_START.test(first)) { inNeed = true; out.push(p); continue }
    if (inNeed && !LIST_START.test(first)) { out.push('Also:\n' + p); inNeed = false; continue }
    out.push(p)
  }
  return out.join('\n\n')
}

export type ChatDigest = { done: string[]; needs: WorkNeed[]; ideas: string[]; question: string | null }

// A reply sorted like a pasted chat: done lines, NEED blocks, ideas, plus the
// question it ends on. The reply's first line is never taken as a title
// (the chat has its own name), so a one-line reply stays what it did.
export function digestReply(reply: unknown): ChatDigest {
  const text = redactSecrets(String(reply ?? '').slice(0, CHAT_REPLY_MAX))
  const p = parseChat('Claude chat reply\n' + replyForParse(text), 'Claude chat')
  return { done: p.done, needs: p.needs, ideas: p.ideas, question: lastQuestion(text) }
}

// A summary written by the hourly review (structured already): cleaned and capped.
export function digestSummary(s: { did?: unknown; needs?: unknown; ideas?: unknown; question?: unknown }): ChatDigest {
  const lines = (v: unknown, n: number) => (Array.isArray(v) ? v : [])
    .map(x => cut(cleanLine(redactSecrets(x)), 400)).filter(Boolean).slice(0, n)
  const needs: WorkNeed[] = (Array.isArray(s.needs) ? s.needs : []).slice(0, 10).map((n: any) =>
    typeof n === 'string'
      ? { label: cut(cleanLine(redactSecrets(n)), 200), steps: [] }
      : { label: cut(cleanLine(redactSecrets(n?.label)), 200), steps: lines(n?.steps, 12) })
    .filter(n => n.label)
  const q = cleanLine(redactSecrets(s.question))
  return { done: lines(s.did, 20), needs, ideas: lines(s.ideas, 10), question: q ? cut(q, CHAT_QUESTION_MAX) : null }
}

// Ticks Leo made on the chat's needs carry over when its summary changes:
// the same need (by its words) stays ticked, wherever it now sits.
export function carryTicks(oldNeeds: WorkNeed[], oldDone: number[], newNeeds: WorkNeed[]): number[] {
  const key = (n: WorkNeed) => cleanLine(n?.label ?? '').toLowerCase()
  const ticked = new Set((oldNeeds || []).filter((_, i) => (oldDone || []).includes(i)).map(key))
  return (newNeeds || []).map((n, i) => (ticked.has(key(n)) ? i : -1)).filter(i => i >= 0)
}

// The day's messages to the chat, oldest first; the same message twice in a
// row is one (a retried post).
export function addAsk(asks: ChatAsk[], at: string, ask: string): ChatAsk[] {
  const list = Array.isArray(asks) ? asks.filter(a => a && typeof a.ask === 'string' && !isMachineText(a.ask)) : []
  const t = askLine(ask)
  if (!t) return list
  if (list.length && list[list.length - 1].ask === t) return list
  return [...list, { at, ask: t }].slice(-CHAT_ASKS_KEEP)
}

// Needs you = an open NEED or a question waiting for Leo's answer.
export function chatStatus(openNeeds: number, question: string | null, working: boolean): ChatStatus {
  if (working) return 'working'
  return openNeeds > 0 || !!question ? 'needs' : 'done'
}

// "working" with nothing logged for CHAT_STALL_MIN minutes: it may have
// stopped (an error, a closed tab) — the page says to open it.
export function isStalled(status: string | null | undefined, lastAt: Date | string | null | undefined, now = new Date()): boolean {
  if (status !== 'working' || !lastAt) return false
  const t = new Date(lastAt).getTime()
  return Number.isFinite(t) && now.getTime() - t > CHAT_STALL_MIN * 60000
}
