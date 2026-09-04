// src/lib/email.ts
//
// The email outreach engine. Runs beside the LinkedIn queue, never through
// it: email sends don't touch LinkedIn statuses or its 10/day budget.
//
// Flow: draftDailyEmails() writes a personalized intro (or a 4-day
// follow-up) for the day's best targets who have a work email — capped by
// a deliverability ramp (10/day at first, +5 per week, ceiling 40). The
// drafts wait for a human: sendApprovedEmails() is wired to the morning
// "Send all" button. checkReplies() reads the inbox over IMAP and marks
// targets replied, which drops them into "Needs action today".
//
// The mailbox is whatever EMAIL_USER/EMAIL_APP_PASSWORD point at (a Gmail
// address + app password). Swapping in marketing@sboyagency.com later is
// changing those two env vars in Vercel — nothing here changes.

import { PrismaClient } from '@prisma/client'
import Anthropic from '@anthropic-ai/sdk'
import nodemailer from 'nodemailer'
import { ImapFlow } from 'imapflow'
import { resolveMx } from 'dns/promises'
import { sendViaGmail, googleStatus, type OutgoingMail, gmailListReplies, gmailScan } from '@/lib/google'

const prisma = new PrismaClient()

// ---- config ----------------------------------------------------

// Volume is deliberately small. Google's bulk-sender rules bite at
// 5,000 messages/day, so we are nowhere near them — the real constraint
// is Gmail's spam-rate ceiling (0.30%, target under 0.10%), which at
// this volume a single "report spam" click can blow past. Slow ramp,
// low ceiling, human-reviewed drafts.
// Ramp per the back-office brief: 5-10/day for two weeks, ~20 by week
// three, 30-40 from week five. The cap grows automatically from the
// date sending first turns on; nobody has to remember to raise it.
const DAILY_START = 5        // week one on a freshly warmed mailbox
const DAILY_MAX = 40         // ceiling — Leo + Zach's call
const RAMP_PER_WEEK = 8      // 5 → 13 → 21 → 29 → 37 → 40
const FOLLOWUP_AFTER_DAYS = 3   // intro -> follow-up 1
const FOLLOWUP2_AFTER_DAYS = 4  // follow-up 1 -> follow-up 2 (day ~7 overall)
const EXHAUSTED_AFTER_DAYS = 3  // follow-up 2 -> flagged "went quiet"
const WORK_TZ = 'America/New_York'
const SITE_URL = 'https://sb-digitaldashboard.vercel.app'
// Who the emails are from and who signs them. When the mailbox swaps to
// Zach: change EMAIL_USER/EMAIL_APP_PASSWORD and set EMAIL_SENDER_NAME=Zach.
const SENDER_NAME = process.env.EMAIL_SENDER_NAME || 'Leo'
// Teammates copied on every outreach email (not tests), on top of any
// per-draft CCs.
const AUTO_CC = ['elizabeth@sboyagency.com', 'jackson@sboyagency.com']

// Two ways to send, in priority order:
//   1. Google OAuth, scope gmail.send only — cannot read the mailbox.
//      This is how we send as Zach without holding his inbox.
//   2. SMTP with an app password (EMAIL_USER/EMAIL_APP_PASSWORD) — only
//      for a mailbox whose owner is fine with full access, e.g. Leo's.
export async function sendMode(): Promise<{ mode: 'gmail' | 'smtp' | 'none'; address: string | null }> {
  const g = await googleStatus()
  if (g.connected) return { mode: 'gmail', address: g.address ?? null }
  if (process.env.EMAIL_USER && process.env.EMAIL_APP_PASSWORD) return { mode: 'smtp', address: process.env.EMAIL_USER }
  return { mode: 'none', address: null }
}

export function emailConfigured(): boolean {
  return !!(process.env.EMAIL_USER && process.env.EMAIL_APP_PASSWORD)
}
export function emailAddress(): string | null {
  return process.env.EMAIL_USER ?? null
}

// A hard stop that outranks everything: while this is on, nothing leaves
// the building — not the per-card Send button, not "Send all", not the
// morning cron. Drafting, discovery and every other feature keep running.
export async function sendingPaused(): Promise<boolean> {
  return (await getSetting('sendingPaused')) !== '0'   // default: PAUSED
}
export async function setSendingPaused(paused: boolean) {
  await setSetting('sendingPaused', paused ? '1' : '0')
  // Turning sending ON is day one of the ramp. The ramp clock had been
  // ticking since the code first ran, days before any real send — left
  // alone it would open at week-two volume on a mailbox with no history.
  // Only reset when nothing has ever been sent, so a pause/unpause
  // mid-campaign doesn't knock the cap back to 5.
  if (!paused) {
    const everSent = await prisma.emailMessage.count({ where: { direction: 'out', status: 'sent', kind: { not: 'test' } } })
    if (everSent === 0) await setSetting('emailRampStart', new Date().toISOString())
  }
  return { paused }
}

// One door for every outgoing message, whichever transport is live.
async function deliver(mail: OutgoingMail) {
  const { mode } = await sendMode()
  if (mode === 'gmail') return sendViaGmail(mail)
  if (mode === 'smtp') return makeTransport().sendMail(mail as any)
  throw new Error('No sending account connected — connect Google on the Outreach page.')
}

// The From header follows whichever account is actually sending.
// The display name recipients see in their inbox list. Kept separate
// from SENDER_NAME (which signs the body) because they want different
// forms: "Zach Goldstein" reads as a person in a From line, while the
// sign-off wants the first name alone.
const FROM_NAME = process.env.EMAIL_FROM_NAME || `${SENDER_NAME} — SB Agency`

// The block that closes every outreach email, reply and follow-up.
// Defined once so a title, number or address change is a single edit
// (or a single Vercel variable) instead of a hunt through templates.
// Kept as plain text: the HTML twin is generated from it, so the two
// versions can never drift apart.
const SIGNATURE = process.env.EMAIL_SIGNATURE || [
  'Zach Goldstein | Co-CEO',
  'Direct: +1 (561) 716-8734 | sboyagency.com',
  'Email: zach@sboyagency.com',
].join('\n')

async function fromHeader(): Promise<string> {
  const { address } = await sendMode()
  return `${FROM_NAME} <${address ?? process.env.EMAIL_USER}>`
}

function startOfLocalDay(): Date {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: WORK_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now).reduce((acc: any, p) => { acc[p.type] = p.value; return acc }, {})
  const asIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second)
  const offset = asIfUtc - now.getTime()
  const localMidnightAsIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day)
  return new Date(localMidnightAsIfUtc - offset)
}

async function getSetting(key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } })
  return row?.value ?? null
}
async function setSetting(key: string, value: string) {
  await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

// The ramp: starts the first day anything is drafted, grows weekly.
export async function currentDailyCap(): Promise<number> {
  let start = await getSetting('emailRampStart')
  if (!start) {
    start = new Date().toISOString()
    await setSetting('emailRampStart', start)
  }
  const weeks = Math.floor((Date.now() - new Date(start).getTime()) / (7 * 24 * 60 * 60 * 1000))
  return Math.min(DAILY_MAX, DAILY_START + weeks * RAMP_PER_WEEK)
}

// ---- Claude (same fallback dance as /api/data) -----------------

const DRAFT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'
const MODEL_FALLBACKS = ['claude-sonnet-5', 'claude-haiku-4-5']

async function askClaude(prompt: string, maxTokens: number): Promise<string> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const candidates = [DRAFT_MODEL, ...MODEL_FALLBACKS.filter(m => m !== DRAFT_MODEL)]
  let lastErr: any = null
  for (const model of candidates) {
    try {
      const res = await anthropic.messages.create({
        model, max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      })
      const block = res.content.find(b => b.type === 'text')
      return block && 'text' in block ? block.text : ''
    } catch (err: any) {
      lastErr = err
      if (!(err?.status === 404 || /model/i.test(err?.message ?? ''))) throw err
    }
  }
  throw lastErr ?? new Error('No usable Claude model')
}

function parseEmailJson(text: string): { subject: string; body: string } | null {
  try {
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) return null
    const j = JSON.parse(m[0])
    if (!j.subject || !j.body) return null
    return { subject: String(j.subject).slice(0, 150), body: String(j.body).slice(0, 3000) }
  } catch { return null }
}

// ---- no-credit fallbacks ---------------------------------------
//
// Every AI feature tries Claude first. When the API account is out of
// credits (or the call fails), these hand-written templates take over,
// filled with the brand's real data — the machine never stops.

function isBillingError(err: any): boolean {
  return /credit balance|billing|purchase credits|invalid_request_error.*credit/i.test(String(err?.message ?? ''))
}

function firstNameOf(t: any): string {
  return String(t.contact?.name || '').trim().split(/\s+/)[0] || 'there'
}

// Deterministic pick so the same brand always gets the same variant.
function pick<T>(arr: T[], seed: string): T {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return arr[h % arr.length]
}

export function templateFollowup1(t: any, intro: any): { subject: string; body: string } {
  const first = firstNameOf(t)
  const brand = t.brand.name
  const bodies = [
    `Hi ${first},\n\nWanted to float this back to the top of your inbox. We're locking in partners for the semester now, and I think ${brand} would land really well on campus.\n\nWorth a quick 15 minutes this week?\n\n${SIGNATURE}`,
    `Hi ${first},\n\nJust circling back — we're routing 500+ shows this year and still have room for a partner like ${brand} in a few big markets.\n\nOpen to a quick call?\n\n${SIGNATURE}`,
    `Hi ${first},\n\nFollowing up in case this got buried. Spring calendars are filling in, and campus feels like a strong fit for ${brand}.\n\nHappy to share a one-pager or hop on a 15-minute call — whatever's easiest.\n\n${SIGNATURE}`,
  ]
  return { subject: `re: ${intro?.subject ?? `SB Agency x ${brand}`}`, body: pick(bodies, brand) }
}

export function templateFollowup2(t: any, intro: any): { subject: string; body: string } {
  const first = firstNameOf(t)
  const brand = t.brand.name
  const bodies = [
    `Hi ${first},\n\nLast note from me — I'll stop filling your inbox. If campus ever makes sense for ${brand}, the door's open and I'd love to build something together.\n\nEither way, keep crushing it.\n\n${SIGNATURE}`,
    `Hi ${first},\n\nClosing the loop on this one. If the timing's ever right for ${brand} to get in front of students, just say the word — we'll make it easy.\n\nAll the best,\n${SIGNATURE}`,
  ]
  return { subject: `re: ${intro?.subject ?? `SB Agency x ${brand}`}`, body: pick(bodies, brand + '2') }
}

// Per-category angles for the ✦ suggestion box — {brand} gets substituted.
const CATEGORY_ANGLES: Record<string, { tip: string; insert: string }> = {
  beverage:  { tip: 'Sampling is the natural play — cold product in hands at peak energy is exactly what beverage brands buy.', insert: 'Concerts are a natural sampling moment for {brand} — thousands of students with product in hand at peak energy, plus all the content that follows.' },
  alcohol:   { tip: 'Lead with compliant 21+ sampling — the compliance angle is usually their first question.', insert: 'Our 21+ events give {brand} a compliant way to put product in hands in exactly the setting where trial converts.' },
  cpg:       { tip: 'Product seeding and house drops before show day put the product into daily student life, not just one night.', insert: 'Beyond show night, house drops across our Greek chapters would put {brand} into students\u2019 daily routines all semester.' },
  beauty:    { tip: 'The getting-ready moment before shows is where beauty routines and content happen — pitch sorority house seeding.', insert: 'Sorority house drops and the getting-ready moments before every show are a perfect fit for {brand} — that\u2019s where routines form and content gets made.' },
  betting:   { tip: 'College-age sports fans are their exact acquisition demo — talk signups per event, not impressions.', insert: 'Our crowds are exactly the demo {brand} is acquiring, and on-site signup activations convert while the energy is high.' },
  fintech:   { tip: 'Students opening their first accounts are a decade-long customer — frame campus as early acquisition.', insert: 'Students setting up their financial lives are {brand}\u2019s next decade of customers — campus is where that relationship starts.' },
  tech:      { tip: 'Device/app trial spreads fast through Greek networks — pitch hands-on demos plus a student-exclusive offer.', insert: 'Hands-on trial at our shows plus a student-exclusive offer would let {brand} ride word-of-mouth through the tightest networks on campus.' },
  software:  { tip: 'Student plans and campus ambassadors are the proven playbook for software on campus.', insert: 'A student offer seeded through our ambassadors would put {brand} in front of exactly the early adopters who spread it.' },
  apps:      { tip: 'Downloads happen in the room — QR moments at peak energy beat any paid install campaign.', insert: 'A QR moment on the big screen at peak energy is the cheapest install {brand} will ever buy — and it comes with a story.' },
  qsr:       { tip: 'Late-night after-show hunger is their moment — pitch vouchers and sampling at the exits.', insert: 'The after-show rush is prime {brand} territory — vouchers and sampling at the exits land right when cravings peak.' },
  apparel:   { tip: 'Front-row outfits are content — pitch ambassador seeding so the brand gets photographed all night.', insert: 'Show nights are the most photographed nights on campus — {brand} on our ambassadors gets seen, tagged, and shared all night.' },
  wellness:  { tip: 'Recovery and hydration around show weekends is the native use case.', insert: 'Show weekends are exactly when students reach for what {brand} makes — sampling before and after slots right into the routine.' },
  retail:    { tip: 'A student-exclusive discount pushed through Greek networks drives measurable store/site traffic.', insert: 'A student-exclusive {brand} offer pushed through our chapters would drive traffic you can actually measure.' },
  transport: { tip: 'Every show ends with thousands needing a ride — ride codes at the exits are an easy, measurable win.', insert: 'Every one of our shows ends with thousands of students needing a ride home — {brand} codes at the exits are an easy, measurable win.' },
  nightlife: { tip: 'They live in this exact culture — pitch co-branded moments, not just logos.', insert: '{brand} lives in exactly this culture — a co-branded moment inside the show would feel native, not sponsored.' },
  entertainment: { tip: 'Cross-promotion to a captive Gen Z audience is the pitch — trailers, activations, talent moments.', insert: 'Our shows put {brand} in front of a captive Gen Z audience at full attention — perfect for a launch or cross-promotion moment.' },
}
const DEFAULT_ANGLE = { tip: 'Make the first idea concrete — name the one thing this brand wants from students (trial, signups, or content) and pitch that.', insert: 'We\u2019d come with concrete ideas for how {brand} shows up — sampling, signage, or seeded product — matched to what you\u2019re trying to grow this year.' }

function templateSuggestion(t: any): string {
  const a = CATEGORY_ANGLES[t.brand.category ?? ''] ?? DEFAULT_ANGLE
  return JSON.stringify({
    tip: a.tip,
    insert: a.insert.replace(/\{brand\}/g, t.brand.name),
  })
}

export function templateReplyResponse(contactName: string, brandName: string, replySubject: string | null): { subject: string; body: string } {
  const first = String(contactName || '').trim().split(/\s+/)[0] || 'there'
  return {
    subject: `re: ${replySubject ?? `SB Agency x ${brandName}`}`,
    body: `Hi ${first},\n\nGreat to hear from you! I'd love to grab 15 minutes to walk through how we'd put ${brandName} inside our shows this semester \u2014 we run 500+ a year across 100+ college markets, so there's a lot to pick from.\n\nWould Tuesday or Wednesday afternoon work? Happy to flex to your calendar.\n\nBest,\n${SIGNATURE}`,
  }
}

// ---- drafting --------------------------------------------------

// "Pickle's goals" but "Kulani Kinis' goals" — names already ending in
// s take a bare apostrophe.
function possessive(name: string): string {
  return /s$/i.test(name.trim()) ? `${name}'` : `${name}'s`
}

// Leo's outreach template, used verbatim for every intro — (NAME) and
// (BRAND) filled in, nothing AI-written. His voice, every time.
function introEmail(t: any): { subject: string; body: string } {
  const firstName = String(t.contact.name || '').trim().split(/\s+/)[0] || 'there'
  const brand = t.brand.name
  const body = [
    `Hi ${firstName},`,
    ``,
    `Hope you're having a good week!`,
    ``,
    `I'm reaching out from SB Agency. We are the largest producer of collegiate events and live entertainment activations in North America.`,
    ``,
    `Our experiential team puts brands directly inside the room at hundreds of major college events each year. We help partners tap into our established live audience on campus, giving them high-impact reach without having to build crowds from the ground up.`,
    ``,
    `We'd love to jump on a quick call to better understand ${possessive(brand)} goals for the upcoming year and brainstorm a few ways we might collaborate.`,
    ``,
    `Let me know your availability next week, and we can set up a call.`,
    ``,
    `If this isn't relevant for you, just say the word and I won't follow up.`,
    ``,
    `Best,`,
    SIGNATURE,
  ].join('\n')
  return { subject: `SB Agency x ${brand}`, body }
}

// One sharp, brand-specific angle per draft — different for every brand
// because it's built from THAT brand's category, tier, and discovery
// notes. Returns {tip, insert} or null if generation fails (a draft
// without a suggestion is still a perfectly good draft).
async function generateSuggestion(t: any): Promise<string | null> {
  try {
    const prompt = [
      `You advise a sponsorship rep at SB Agency, which produces large fraternity/sorority concerts at US colleges and sells brands activations there (sampling, banners, product seeding, ambassadors).`,
      `SB AGENCY FACTS you may use: 500+ shows/year; 100+ tier-1 college markets; 100+ Greek life campus networks; fully customizable programs; in-house photo/video production on every show.`,
      `The rep is about to email this brand a templated intro. Give ONE angle that is SPECIFIC to this brand — never generic advice that could apply to anyone.`,
      ``,
      `BRAND: ${t.brand.name}`,
      t.brand.category ? `CATEGORY: ${t.brand.category}` : ``,
      t.brand.tier ? `STAGE: ${t.brand.tier}` : ``,
      t.brand.goals ? `WHAT THEY WANT (discovery notes): ${t.brand.goals}` : ``,
      t.brand.notes ? `NOTES: ${t.brand.notes}` : ``,
      `CONTACT: ${t.contact.name}${t.contact.title ? `, ${t.contact.title}` : ''}`,
      ``,
      `Return ONLY JSON:`,
      `{"tip": "one sentence telling the rep the angle and why it fits this brand", "insert": "one natural, friendly sentence ready to paste into the email that uses that angle — mentions the brand or its product specifically, fits before 'We'd love to jump on a quick call', no placeholder brackets"}`,
    ].filter(Boolean).join('\n')
    // 800 tokens: at 400 the model's answer was getting cut mid-JSON and
    // every suggestion "failed". Also strip markdown fences before parsing.
    const text = (await askClaude(prompt, 800)).replace(/```(?:json)?/g, '')
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) return null
    const j = JSON.parse(m[0])
    if (!j.tip || !j.insert) return templateSuggestion(t)
    return JSON.stringify({ tip: String(j.tip).slice(0, 400), insert: String(j.insert).slice(0, 400) })
  } catch { return templateSuggestion(t) }
}

// Generate (or regenerate) the suggestion for an existing draft.
export async function suggestForDraft(emailId: string) {
  const d = await prisma.emailMessage.findUnique({
    where: { id: emailId },
    include: { target: { include: { brand: true, contact: true } } },
  })
  if (!d) throw new Error('Draft not found')
  const s = await generateSuggestion(d.target)
  if (!s) throw new Error('Could not generate a suggestion — try again')  // unreachable: template fallback always answers
  await prisma.emailMessage.update({ where: { id: emailId }, data: { suggestion: s } })
  return JSON.parse(s)
}

// One demo email so Leo can see exactly what a recipient gets — same
// template, same attachment, sent to an address he chooses. Uses the
// first waiting draft as the sample (untouched), or a filled template
// if the queue is empty. Never counts against the daily cap.
export async function sendTestEmail(to: string) {
  if (await sendingPaused()) throw new Error('Sending is paused — turn it on in Outreach → ✉ Email when you\'re ready to go live.')
  const { mode } = await sendMode()
  if (mode === 'none') throw new Error('No sending account connected')
  if (!to || !/@/.test(to)) throw new Error('Valid address required')

  const sample = await prisma.emailMessage.findFirst({
    where: { direction: 'out', status: 'draft' },
    orderBy: { createdAt: 'asc' },
    include: { target: { include: { brand: true, contact: true } } },
  })
  const subject = sample ? `[TEST] ${sample.subject}` : '[TEST] SB Agency outreach preview'
  const body = sample?.body ?? 'This is a preview of the SB Agency outreach email.'

  // The preview has to look like the real thing, logo included, or it
  // isn't a preview. 'test' as the tracking id is a dead reference on
  // purpose — a test open shouldn't move any real open count.
  const attachment = await onePagerAttachment()
  const mark = await logoAttachment()
  const files = [attachment, ...(await signatureAssets())].filter(Boolean)
  await deliver({
    from: await fromHeader(),
    to, subject, text: body,
    html: htmlBody(body, 'test', !!mark),
    ...(files.length ? { attachments: files } : {}),
  })
  return { ok: true, to, subject, attached: !!attachment }
}

function followupPrompt(t: any, firstEmail: any): string {
  return [
    `Write a short FOLLOW-UP email (the first one got no reply) for SB Agency (books artists/DJs for college greek-life events; sells brands sponsorship at those shows).`,
    `TO: ${t.contact.name} at ${t.brand.name}.`,
    `FIRST EMAIL SUBJECT: ${firstEmail?.subject ?? ''}`,
    ``,
    `Rules: under 60 words, plain text. Friendly, zero pressure, adds one small new angle (timing, a specific school region, or momentum), then a soft ask. No guilt-tripping. Sign off exactly:\n${SIGNATURE}`,
    ``,
    `Return ONLY JSON: {"subject": "...", "body": "..."} — subject should be "re:" + the first subject.`,
  ].join('\n')
}

function followup2Prompt(t: any, firstEmail: any): string {
  return [
    `Write the LAST follow-up email in a sequence (two earlier emails got no reply) for SB Agency (produces large fraternity/sorority concerts at US colleges; sells brands activations there).`,
    `TO: ${t.contact.name} at ${t.brand.name}.`,
    `FIRST EMAIL SUBJECT: ${firstEmail?.subject ?? ''}`,
    ``,
    `Rules: under 45 words, plain text. "Closing the loop" style — graceful, zero pressure, makes clear this is the last note, leaves the door open ("if the timing's ever right..."). Optionally offer to send a one-pager or intro to whoever owns campus partnerships. Sign off exactly:\n${SIGNATURE}`,
    ``,
    `Return ONLY JSON: {"subject": "...", "body": "..."} — subject should be "re:" + the first subject.`,
  ].join('\n')
}

// Drafts up to `limit` emails per call (Claude calls are slow; callers
// loop until done=true). Follow-ups first — momentum beats new names.
export async function draftDailyEmails(limit = 5) {
  const { mode } = await sendMode()
  if (mode === 'none') return { configured: false, drafted: 0, done: true }
  // No API key just means templates do the writing — never a hard stop.

  const cap = await currentDailyCap()
  const sentToday = await prisma.emailMessage.count({
    where: { direction: 'out', status: 'sent', sentAt: { gte: startOfLocalDay() } },
  })
  const pendingDrafts = await prisma.emailMessage.count({
    where: { direction: 'out', status: { in: ['draft', 'approved'] } },
  })
  let room = Math.max(0, cap - sentToday - pendingDrafts)
  if (room === 0) return { configured: true, drafted: 0, done: true, cap, sentToday, pendingDrafts }

  let drafted = 0

  // 1. Follow-ups due. Two rungs: follow-up 1 (intro sent >= 3 days ago)
  //    and follow-up 2 (follow-up 1 sent >= 4 more days ago, the last
  //    touch). A reply at any point stops the ladder.
  const cutoff1 = new Date(Date.now() - FOLLOWUP_AFTER_DAYS * 24 * 60 * 60 * 1000)
  const followCandidates = await prisma.target.findMany({
    where: {
      status: { notIn: ['replied', 'converted', 'declined', 'dead'] },
      emails: { some: { direction: 'out', kind: 'intro', status: 'sent', sentAt: { lte: cutoff1 } } },
    },
    include: {
      brand: true, contact: true,
      emails: { orderBy: { createdAt: 'asc' } },
    },
    take: 50,
  })
  const cutoff2 = new Date(Date.now() - FOLLOWUP2_AFTER_DAYS * 24 * 60 * 60 * 1000)
  for (const t of followCandidates) {
    if (drafted >= limit || room === 0) break
    if (t.emails.some(e => e.direction === 'in') || !t.contact.email) continue
    if ((t.brand as any).doNotEmail || /skip/i.test(t.brand.notes ?? '')) continue
    const intro = t.emails.find(e => e.kind === 'intro' && e.status === 'sent')
    const f1 = t.emails.find(e => e.kind === 'followup')
    const hasF2 = t.emails.some(e => e.kind === 'followup2')
    if (!f1) {
      // Rung 1 due. AI first, template if the account can't pay for it.
      let parsed: any = null
      try { parsed = parseEmailJson(await askClaude(followupPrompt(t, intro), 800)) } catch (err) { if (!isBillingError(err)) throw err }
      if (!parsed) parsed = templateFollowup1(t, intro)
      await prisma.emailMessage.create({
        data: {
          targetId: t.id, direction: 'out', kind: 'followup', status: 'draft',
          toEmail: t.contact.email, fromEmail: (await sendMode()).address,
          subject: parsed.subject, body: parsed.body,
        },
      })
      drafted++; room--
    } else if (!hasF2 && f1.status === 'sent' && f1.sentAt && f1.sentAt <= cutoff2) {
      // Rung 2 due — the closing-the-loop note. Same fallback rule.
      let parsed: any = null
      try { parsed = parseEmailJson(await askClaude(followup2Prompt(t, intro), 800)) } catch (err) { if (!isBillingError(err)) throw err }
      if (!parsed) parsed = templateFollowup2(t, intro)
      await prisma.emailMessage.create({
        data: {
          targetId: t.id, direction: 'out', kind: 'followup2', status: 'draft',
          toEmail: t.contact.email, fromEmail: (await sendMode()).address,
          subject: parsed.subject, body: parsed.body,
        },
      })
      drafted++; room--
    }
  }

  // 2. Fresh intros: best-fit active targets with an email and no email
  //    history at all. Template-filled, not AI-written — instant.
  if (drafted < limit && room > 0) {
    // One email per BRAND, not per person: a brand that has ever been
    // emailed (any contact, draft or sent) is skipped, and only its
    // best-fit person gets the intro.
    const emailedBrands = new Set(
      (await prisma.emailMessage.findMany({
        where: { direction: 'out' },
        select: { target: { select: { brandId: true } } },
      })).map(m => m.target.brandId)
    )
    const fresh = await prisma.target.findMany({
      where: {
        status: { in: ['queued', 'drafted', 'sent'] },
        shelved: false,
        contact: { email: { not: null } },
        emails: { none: {} },
        // A "do not email" flag — or the word "skip" in the brand's
        // notes — keeps the whole brand out of the machine.
        brand: {
          doNotEmail: false,
          NOT: { notes: { contains: 'skip', mode: 'insensitive' } },
        } as any,
      },
      include: { brand: true, contact: true },
      orderBy: [{ fitScore: 'desc' }, { createdAt: 'asc' }],
      take: 100,
    })
    for (const t of fresh) {
      if (drafted >= limit || room === 0) break
      if (emailedBrands.has(t.brandId)) continue
      emailedBrands.add(t.brandId)
      const filled = introEmail(t)
      // Brand-specific angle, generated per draft — different for every
      // brand by construction. A failed generation never blocks the draft.
      const suggestion = await generateSuggestion(t)
      await prisma.emailMessage.create({
        data: {
          targetId: t.id, direction: 'out', kind: 'intro', status: 'draft',
          toEmail: t.contact.email, fromEmail: (await sendMode()).address,
          subject: filled.subject, body: filled.body,
          suggestion,
        },
      })
      drafted++; room--
    }
  }

  return { configured: true, drafted, done: room === 0 || drafted < limit, cap, sentToday }
}

// ---- sending ---------------------------------------------------

// The SBA one-pager, attached to every outreach email. Lives in the
// repo at public/materials/ so it's versioned with the site; fetched
// once per send batch so a missing file never blocks sending.
const ONE_PAGER_URL = 'https://sb-digitaldashboard.vercel.app/materials/sba-one-pager.pdf'
const ONE_PAGER_NAME = 'SBA One Pager.pdf'

async function onePagerAttachment(): Promise<{ filename: string; content: Buffer } | null> {
  try {
    const res = await fetch(ONE_PAGER_URL)
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 1000) return null
    return { filename: ONE_PAGER_NAME, content: buf }
  } catch { return null }
}

// The SB Agency mark, shown under the sign-off in the HTML version of
// every email. It rides along as an INLINE (cid) attachment rather than
// a plain remote <img src>, because Gmail and Outlook block remote
// images by default on a first email from an unknown sender — exactly
// the case every one of these emails is. Inline always renders.
//
// Fetched once per process and cached: the plain-text copy of the email
// is unchanged, so a client that shows text-only loses nothing.
const SITE_ASSETS = 'https://sb-digitaldashboard.vercel.app/materials/'
const LOGO_CID = 'sblogo'
const LI_CID = 'iconli'
const IG_CID = 'iconig'

// Both from the company signature doc / Leo.
const LINKEDIN_URL = process.env.SIGNATURE_LINKEDIN_URL
  || 'https://www.linkedin.com/company/sboy-agency/'
const INSTAGRAM_URL = process.env.SIGNATURE_INSTAGRAM_URL || 'https://www.instagram.com/sboyagency/'

async function fetchAsset(file: string, cid: string, min = 200): Promise<any | null> {
  try {
    const res = await fetch(SITE_ASSETS + file)
    if (!res.ok) return null
    const content = Buffer.from(await res.arrayBuffer())
    if (content.length < min) return null
    return { filename: file, content, cid, contentDisposition: 'inline' }
  } catch { return null }
}

// All three signature images, fetched once per process. Returned as one
// array so callers can't accidentally attach the logo without the icons
// and end up with a half-rendered signature.
// Signature images are now referenced by URL from the site rather than
// embedded as cid: attachments. Embedded ones showed up as three loose
// "attachments" (logo, two icons) in Apple Mail / Outlook / some Gmail
// views, which looked odd next to the one-pager. Hosted images render
// in place and the only attachment left is the PDF. (fetchAsset stays
// so this can be flipped back with SIGNATURE_EMBED=1.)
const EMBED_SIGNATURE = process.env.SIGNATURE_EMBED === '1'
let assetCache: any[] | undefined
async function signatureAssets(): Promise<any[]> {
  if (!EMBED_SIGNATURE) return []
  if (assetCache === undefined) {
    const [logo, li, ig] = await Promise.all([
      fetchAsset('sb-logo.png', LOGO_CID),
      fetchAsset('icon-linkedin.png', LI_CID, 100),
      fetchAsset('icon-instagram.png', IG_CID, 100),
    ])
    assetCache = [logo, li, ig].filter(Boolean)
  }
  return assetCache
}

// Truthy when the HTML signature should render with images. Hosted mode
// always can; embedded mode only when the logo bytes actually arrived.
async function logoAttachment(): Promise<any | null> {
  if (!EMBED_SIGNATURE) return { hosted: true }
  const a = await signatureAssets()
  return a.find(x => x.cid === LOGO_CID) ?? null
}
function imgSrc(cid: string, file: string): string {
  return EMBED_SIGNATURE ? 'cid:' + cid : SITE_ASSETS + file + '?v=2026-09-03'
}

function makeTransport() {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_APP_PASSWORD },
  })
}

// Bounce protection: a domain with no mail servers means a guaranteed
// bounce, and bounces are what get a sending address flagged as spam.
// Checked once per domain per batch.
const mxCache = new Map<string, boolean>()
async function domainAcceptsMail(address: string): Promise<boolean> {
  const domain = (address.split('@')[1] || '').toLowerCase()
  if (!domain) return false
  if (mxCache.has(domain)) return mxCache.get(domain)!
  let ok = false
  try {
    const mx = await resolveMx(domain)
    ok = Array.isArray(mx) && mx.length > 0
  } catch { ok = false }
  mxCache.set(domain, ok)
  return ok
}

// The HTML twin of the plain-text body: same words, plus the open-
// tracking pixel. Gmail shows this version; text-only clients get the
// plain version untouched.
function esc(t: string): string {
  return t
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/\n/g, '<br>\n')
}

// The styled twin of the plain-text SIGNATURE block: logo on top, name
// bold with the title in regular weight, then contact lines and the
// social marks — matching the company signature doc. Everything is a
// cid: reference, so it renders with remote images blocked, which is
// the default state for a first email from an unknown sender.
function signatureHtml(): string {
  const icon = (src: string, alt: string, href: string) => {
    const img = '<img src="' + src + '" alt="' + alt +
      '" width="20" height="20" style="width:20px;height:20px;border:0;vertical-align:middle">'
    return href ? '<a href="' + href + '" style="text-decoration:none;margin-right:6px">' + img + '</a>'
                : '<span style="margin-right:6px;display:inline-block">' + img + '</span>'
  }
  return '' +
    '<div style="margin-top:18px">' +
      '<img src="' + imgSrc(LOGO_CID, 'sb-logo.png') + '" alt="SB Agency" width="130" ' +
        'style="width:130px;height:auto;display:block;border:0;margin-bottom:8px">' +
      '<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#1a1a1a;line-height:1.55">' +
        '<span style="font-weight:700">Zach Goldstein</span> | Co-CEO<br>' +
        'Direct: <a href="tel:+15617168734" style="color:#1a1a1a;text-decoration:none">+1 (561) 716-8734</a>' +
        ' | <a href="https://sboyagency.com" style="color:#1a1a1a;font-weight:700">sboyagency.com</a><br>' +
        'Email: <a href="mailto:zach@sboyagency.com">zach@sboyagency.com</a>' +
      '</div>' +
      '<div style="margin-top:8px">' +
        icon(imgSrc(LI_CID, 'icon-linkedin.png'), 'LinkedIn', LINKEDIN_URL) +
        icon(imgSrc(IG_CID, 'icon-instagram.png'), 'Instagram', INSTAGRAM_URL) +
      '</div>' +
    '</div>'
}

// The HTML twin of the plain-text body: same words, plus the open-
// tracking pixel. The trailing SIGNATURE is lifted out and re-rendered
// as signatureHtml() so the two versions can never drift — the draft
// stays editable as plain text, the email still looks designed.
function htmlBody(text: string, emailId: string, withLogo = false): string {
  const at = text.lastIndexOf(SIGNATURE)
  const hasSig = at >= 0 && withLogo
  const main = at >= 0 && withLogo ? text.slice(0, at) : text
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.55">' +
    esc(main.replace(/\n+$/, '')) +
    (hasSig ? signatureHtml() : '') +
    '</div><img src="' + SITE_URL + '/api/track?e=' + encodeURIComponent(emailId) + '" width="1" height="1" alt="" style="display:none">'
}


// Send exactly one draft: to + any CC, marked sent, one-pager attached.
// Shared by "Send all", the per-card Send button, and the 9am cron.
async function deliverDraft(d: any, _transporter: any, attachment: { filename: string; content: Buffer } | null) {
  const to = d.toEmail || d.target.contact.email
  if (!to) throw new Error('No recipient address on this draft')
  if (!(await domainAcceptsMail(to))) throw new Error(`${to} — domain has no mail server (bounce protection)`)
  let cc: string[] = []
  try { cc = JSON.parse(d.ccEmails ?? '[]') } catch {}
  cc = [...cc, ...AUTO_CC]
  const seenCc = new Set<string>()
  cc = cc.filter(a => {
    if (typeof a !== 'string' || !/@/.test(a) || a.toLowerCase() === to.toLowerCase()) return false
    const k = a.toLowerCase()
    if (seenCc.has(k)) return false
    seenCc.add(k); return true
  })
  // The one-pager rides on every email, per Leo's call. The logo rides
  // inline underneath the sign-off.
  const attach = attachment
  const mark = await logoAttachment()
  const files = [attach, ...(await signatureAssets())].filter(Boolean)
  const from = await fromHeader()
  await deliver({
    from, to,
    ...(cc.length ? { cc } : {}),
    subject: d.subject ?? '',
    text: d.body ?? '',
    html: htmlBody(d.body ?? '', d.id, !!mark),
    ...(files.length ? { attachments: files } : {}),
  })
  const { address } = await sendMode()
  await prisma.emailMessage.update({
    where: { id: d.id },
    data: { status: 'sent', sentAt: new Date(), toEmail: to, fromEmail: address },
  })
  return { to, cc }
}

// The open-tracking pixel calls this (via /api/track?e=<id>).
export async function recordOpen(emailId: string) {
  try {
    const d = await prisma.emailMessage.findUnique({ where: { id: emailId } })
    if (!d || d.direction !== 'out' || d.status !== 'sent') return
    await prisma.emailMessage.update({
      where: { id: emailId },
      data: { opens: { increment: 1 }, ...(d.openedAt ? {} : { openedAt: new Date() }) },
    })
  } catch {}
}

// One email, by draft id — the per-card Send button.
export async function sendOneEmail(emailId: string) {
  if (await sendingPaused()) throw new Error('Sending is paused — turn it on in Outreach → ✉ Email when you\'re ready to go live.')
  const { mode } = await sendMode()
  if (mode === 'none') throw new Error('No sending account connected — connect Google on the Outreach page.')
  const d = await prisma.emailMessage.findUnique({
    where: { id: emailId },
    include: { target: { include: { contact: true, brand: true } } },
  })
  if (!d) throw new Error('Draft not found')
  if (d.direction !== 'out' || !['draft', 'approved'].includes(d.status)) throw new Error('Only unsent drafts can be sent')

  // The per-card Send button counts against the same daily cap. Without
  // this, clicking through the queue one by one would bypass it.
  const { cap, sentToday, room } = await roomToday()
  if (room === 0) throw new Error(`Daily cap reached (${sentToday}/${cap}) — this one goes out tomorrow.`)

  const transporter = makeTransport()
  const attachment = await onePagerAttachment()
  try {
    const r = await deliverDraft(d, transporter, attachment)
    return { ok: true, brand: d.target.brand.name, to: r.to, cc: r.cc, attached: !!attachment }
  } catch (err: any) {
    await prisma.emailMessage.update({
      where: { id: d.id },
      data: { status: 'failed', error: String(err?.message ?? 'send failed').slice(0, 300) },
    })
    throw new Error(`${d.target.brand.name}: ${err?.message ?? 'send failed'}`)
  }
}

// "Approve for 9am": marks every waiting draft approved; the Tue–Thu
// morning cron picks them up and sends in the best reply window.
export async function approveAllDrafts() {
  const r = await prisma.emailMessage.updateMany({
    where: { direction: 'out', status: 'draft' },
    data: { status: 'approved' },
  })
  return { approved: r.count }
}

// The auto-send cron: sends ONLY approved emails (drafts Leo hasn't
// approved stay put).
// The drip. The cron fires hourly through business hours; each firing
// sends a random 1-3 approved emails and sometimes none at all, so the
// day's volume lands in a human-looking pattern instead of one 9am blast
// (which is what tips spam filters off to bulk sending).
export async function sendScheduledEmails() {
  if (Math.random() < 0.25) {
    return { configured: true, sent: 0, failed: 0, skippedThisHour: true }
  }
  const n = 1 + Math.floor(Math.random() * 3)
  return sendBatch(['approved'], n)
}

// "Send all now": sends everything waiting — drafts and approved alike.
export async function sendApprovedEmails() {
  return sendBatch(['draft', 'approved'])
}

// How many more emails may go out today. The cap is enforced HERE, at
// the moment of sending, not only when drafts are created — because
// drafts accumulate (per-brand intros, a few days of drafting, a
// re-run) and "Send all" would otherwise fire every one of them at once.
// A hard stop at send time is what makes a whole-list blast impossible,
// whatever is queued.
async function roomToday(): Promise<{ cap: number; sentToday: number; room: number }> {
  const cap = await currentDailyCap()
  const sentToday = await prisma.emailMessage.count({
    where: { direction: 'out', status: 'sent', sentAt: { gte: startOfLocalDay() } },
  })
  return { cap, sentToday, room: Math.max(0, cap - sentToday) }
}

async function sendBatch(statuses: string[], limit?: number) {
  if (await sendingPaused()) return { configured: true, paused: true, sent: 0, failed: 0, errors: ['Sending is paused'] }
  const { mode } = await sendMode()
  if (mode === 'none') return { configured: false, sent: 0, failed: 0 }

  const { cap, sentToday, room } = await roomToday()
  if (room === 0) {
    return { configured: true, sent: 0, failed: 0, cap, sentToday, capped: true,
      errors: [`Daily cap reached (${sentToday}/${cap}). The rest goes out tomorrow.`] }
  }
  const take = limit ? Math.min(limit, room) : room

  const transporter = makeTransport()
  const attachment = await onePagerAttachment()

  const drafts = await prisma.emailMessage.findMany({
    where: { direction: 'out', status: { in: statuses } },
    include: { target: { include: { contact: true, brand: true } } },
    orderBy: { createdAt: 'asc' },
    take,
  })
  const queued = await prisma.emailMessage.count({ where: { direction: 'out', status: { in: statuses } } })
  const held = Math.max(0, queued - drafts.length)

  let sent = 0, failed = 0
  const errors: string[] = []
  for (const d of drafts) {
    try {
      await deliverDraft(d, transporter, attachment)
      sent++
    } catch (err: any) {
      failed++
      if (errors.length < 5) errors.push(`${d.target.brand.name}: ${err?.message ?? 'send failed'}`)
      await prisma.emailMessage.update({
        where: { id: d.id },
        data: { status: 'failed', error: String(err?.message ?? 'send failed').slice(0, 300) },
      }).catch(() => {})
    }
  }
  if (held > 0) errors.push(`${held} held for tomorrow — daily cap is ${cap}.`)
  return { configured: true, sent, failed, errors, cap, sentToday: sentToday + sent, held }
}

// ---- replies ---------------------------------------------------

// Reads the inbox over IMAP and matches senders against people we've
// emailed. A match marks the target replied (which surfaces it in
// "Needs action today") and stops any future follow-up to them.
// Replies are detected by reading a dedicated TRACKING mailbox — never
// the sending account's inbox. The sender sets one Gmail filter that
// forwards outreach replies there; they keep every reply themselves, and
// this app never holds read access to a personal inbox.
//   REPLY_IMAP_USER / REPLY_IMAP_APP_PASSWORD  → the tracking mailbox
// Falls back to EMAIL_USER/EMAIL_APP_PASSWORD only when those are the
// same mailbox we already send from with an app password.
function replyMailbox(): { user: string; pass: string } | null {
  const user = process.env.REPLY_IMAP_USER || process.env.EMAIL_USER
  const pass = process.env.REPLY_IMAP_APP_PASSWORD || process.env.EMAIL_APP_PASSWORD
  return user && pass ? { user, pass } : null
}

// Logs a single inbound reply against the target it belongs to.
// Shared by both readers so the Gmail and IMAP paths can't drift.
async function recordReply(targetId: string, from: string, subject: string | null, when: Date) {
  // One record per target per subject — a thread that gets several
  // messages shouldn't show up as several separate replies.
  const dupe = await prisma.emailMessage.findFirst({
    where: { targetId, direction: 'in', subject },
  })
  if (dupe) return false

  await prisma.emailMessage.create({
    data: {
      targetId, direction: 'in', kind: 'reply', status: 'received',
      fromEmail: from, subject, sentAt: when,
    },
  })

  const t = await prisma.target.findUnique({ where: { id: targetId } })
  if (t && !['replied', 'converted', 'declined', 'dead'].includes(t.status)) {
    await prisma.target.update({
      where: { id: targetId },
      data: { status: 'replied', repliedAt: t.repliedAt ?? new Date() },
    })
    await prisma.targetEvent.create({
      data: { targetId, kind: 'status', fromStatus: t.status, toStatus: 'replied', detail: 'email reply' },
    })
    await prisma.partner.upsert({
      where: { brandId: t.brandId },
      create: { brandId: t.brandId, lifecycle: 'in_network' },
      update: {},
    })
  }
  return true
}

export async function checkReplies() {
  // Everyone we've emailed, keyed by address.
  const sentOut = await prisma.emailMessage.findMany({
    where: { direction: 'out', status: 'sent', toEmail: { not: null } },
    select: { targetId: true, toEmail: true },
  })
  const byEmail = new Map<string, string>()
  for (const m of sentOut) byEmail.set(m.toEmail!.toLowerCase(), m.targetId)

  const lastCheck = await getSetting('emailLastCheck')
  const since = lastCheck ? new Date(lastCheck) : new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)

  // Preferred path: the connected Google account, read through the Gmail
  // API on the gmail.readonly scope. No password anywhere, and the app
  // can't modify or delete anything in the mailbox.
  const g = await googleStatus()
  if (g.connected) {
    if (sentOut.length === 0) return { configured: true, via: 'gmail', replies: 0 }
    let replies = 0
    try {
      for (const msg of await gmailListReplies(since)) {
        const targetId = byEmail.get(msg.from)
        if (!targetId) continue
        if (await recordReply(targetId, msg.from, msg.subject, msg.date)) replies++
      }
    } catch (err: any) {
      return { configured: true, via: 'gmail', replies, error: String(err?.message ?? 'Gmail read failed').slice(0, 200) }
    }
    await setSetting('emailLastCheck', new Date().toISOString())
    return { configured: true, via: 'gmail', replies }
  }

  // Fallback: IMAP with an app password, for a mailbox connected that way.
  const box = replyMailbox()
  if (!box) {
    return {
      configured: false, replies: 0,
      hint: 'Connect the Google account on the Outreach page, or set REPLY_IMAP_USER / REPLY_IMAP_APP_PASSWORD.',
    }
  }
  if (sentOut.length === 0) return { configured: true, via: 'imap', replies: 0 }

  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user: box.user, pass: box.pass },
    logger: false,
  })

  let replies = 0
  try {
    await client.connect()
    const lock = await client.getMailboxLock('INBOX')
    try {
      for await (const msg of client.fetch({ since }, { envelope: true })) {
        const from = msg.envelope?.from?.[0]?.address?.toLowerCase()
        if (!from) continue
        const targetId = byEmail.get(from)
        if (!targetId) continue
        const ok = await recordReply(targetId, from, msg.envelope?.subject ?? null, msg.envelope?.date ?? new Date())
        if (ok) replies++
      }
    } finally {
      lock.release()
    }
    await client.logout()
  } catch (err: any) {
    try { await client.logout() } catch {}
    return { configured: true, via: 'imap', replies, error: String(err?.message ?? 'IMAP failed').slice(0, 200) }
  }

  await setSetting('emailLastCheck', new Date().toISOString())
  return { configured: true, via: 'imap', replies }
}


// Draft an intro for ONE specific brand, on demand (the brand page's
// "✉ Draft intro email" button). Respects the one-email-per-brand rule.
export async function draftBrandIntro(brandId: string) {
  const { mode } = await sendMode()
  if (mode === 'none') throw new Error('No sending account connected — connect Google on the Outreach page.')
  const b = await prisma.brand.findUnique({ where: { id: brandId } })
  if (b && ((b as any).doNotEmail || /skip/i.test(b.notes ?? ''))) {
    throw new Error('This brand is marked do-not-email (flag or "skip" in notes). Clear that first.')
  }
  const prior = await prisma.emailMessage.findFirst({
    where: { direction: 'out', target: { brandId } },
  })
  if (prior) throw new Error('This brand already has an email drafted or sent — one thread per brand.')
  const t = await prisma.target.findFirst({
    where: {
      brandId, shelved: false,
      status: { in: ['queued', 'drafted', 'sent'] },
      contact: { email: { not: null } },
    },
    include: { brand: true, contact: true },
    orderBy: [{ fitScore: 'desc' }, { createdAt: 'asc' }],
  })
  if (!t) throw new Error('No queued contact with an email at this brand — add or promote one first.')
  const filled = introEmail(t)
  const suggestion = await generateSuggestion(t)
  const draft = await prisma.emailMessage.create({
    data: {
      targetId: t.id, direction: 'out', kind: 'intro', status: 'draft',
      toEmail: t.contact.email, fromEmail: (await sendMode()).address,
      subject: filled.subject, body: filled.body, suggestion,
    },
  })
  return { ok: true, draftId: draft.id, to: t.contact.email, contact: t.contact.name }
}

// ---- exhausted sequences ---------------------------------------

// Brands that got the full ladder — intro, follow-up, closing note —
// and stayed silent. Each comes back flagged with a recommendation:
// the brand's next-best un-emailed contact if there is one, otherwise
// one last follow-up.
export async function listExhausted() {
  const cutoff = new Date(Date.now() - EXHAUSTED_AFTER_DAYS * 24 * 60 * 60 * 1000)
  const ts = await prisma.target.findMany({
    where: {
      status: { notIn: ['replied', 'converted', 'declined', 'dead'] },
      emails: { some: { direction: 'out', kind: 'followup2', status: 'sent', sentAt: { lte: cutoff } } },
    },
    include: {
      brand: { select: { id: true, name: true, contacts: { select: { id: true, name: true, title: true, email: true }, where: { email: { not: null } } } } },
      contact: { select: { id: true, name: true, title: true, email: true } },
      emails: { orderBy: { sentAt: 'desc' } },
    },
    take: 30,
  })
  const silent = ts.filter(t => !t.emails.some(e => e.direction === 'in'))
  if (silent.length === 0) return []

  // Every address the BRAND has already been emailed at (any target),
  // so we never recommend someone who's already been hit.
  const brandIds = Array.from(new Set(silent.map(t => t.brandId)))
  const priorOut = await prisma.emailMessage.findMany({
    where: { direction: 'out', toEmail: { not: null }, target: { brandId: { in: brandIds } } },
    select: { toEmail: true, target: { select: { brandId: true } } },
  })
  const emailedByBrand = new Map<string, Set<string>>()
  for (const m of priorOut) {
    const set = emailedByBrand.get(m.target.brandId) ?? new Set<string>()
    set.add(m.toEmail!.toLowerCase())
    emailedByBrand.set(m.target.brandId, set)
  }

  return silent.map(t => {
    const emailed = emailedByBrand.get(t.brandId) ?? new Set<string>()
    const next = t.brand.contacts.find(c => c.email && !emailed.has(c.email.toLowerCase())) ?? null
    const lastOut = t.emails.find(e => e.direction === 'out' && e.status === 'sent')
    return {
      targetId: t.id,
      brand: { id: t.brand.id, name: t.brand.name },
      contact: { name: t.contact.name, title: t.contact.title, email: t.contact.email },
      lastTouch: lastOut?.sentAt ?? null,
      opened: t.emails.some(e => e.direction === 'out' && (e as any).opens > 0),
      nextContact: next,
      recommendation: next
        ? `Try ${next.name}${next.title ? ` (${next.title})` : ''} — a fresh intro to a new person restarts the clock.`
        : `No other contact on file — one last short follow-up, or mark it cold and revisit next semester.`,
    }
  })
}

// "Email the other person": retires the silent target and starts a
// fresh intro (template + suggestion) to a different contact at the
// same brand — waits in the draft queue like everything else.
export async function emailDifferentContact(targetId: string, contactId: string) {
  const old = await prisma.target.findUnique({ where: { id: targetId }, include: { brand: true } })
  if (!old) throw new Error('Target not found')
  const contact = await prisma.contact.findUnique({ where: { id: contactId } })
  if (!contact || contact.brandId !== old.brandId) throw new Error('That contact is not at this brand')
  if (!contact.email) throw new Error('That contact has no email address')

  await prisma.target.update({ where: { id: targetId }, data: { status: 'dead' } })
  await prisma.targetEvent.create({
    data: { targetId, kind: 'status', fromStatus: old.status, toStatus: 'dead', detail: 'no response after full email sequence — switching contacts' },
  })

  let t = await prisma.target.findFirst({ where: { brandId: old.brandId, contactId } })
  if (!t) {
    t = await prisma.target.create({ data: { brandId: old.brandId, contactId, status: 'queued', fitScore: old.fitScore } })
  } else if (['declined', 'dead'].includes(t.status as any)) {
    await prisma.target.update({ where: { id: t.id }, data: { status: 'queued', shelved: false } })
  }
  const full = await prisma.target.findUnique({ where: { id: t.id }, include: { brand: true, contact: true } })
  const filled = introEmail(full)
  const suggestion = await generateSuggestion(full)
  const draft = await prisma.emailMessage.create({
    data: {
      targetId: t.id, direction: 'out', kind: 'intro', status: 'draft',
      toEmail: contact.email, fromEmail: (await sendMode()).address,
      subject: filled.subject, body: filled.body, suggestion,
    },
  })
  return { ok: true, draftId: draft.id, to: contact.email }
}

// "One more follow-up" on an exhausted thread — a very short, final nudge.
export async function draftFinalNudge(targetId: string) {
  const t = await prisma.target.findUnique({
    where: { id: targetId },
    include: { brand: true, contact: true, emails: { orderBy: { createdAt: 'asc' } } },
  })
  if (!t) throw new Error('Target not found')
  if (!t.contact.email) throw new Error('No email on this contact')
  const intro = t.emails.find(e => e.kind === 'intro' && e.status === 'sent')
  let parsed: any = null
  try { parsed = parseEmailJson(await askClaude(followup2Prompt(t, intro), 800)) } catch (err) { if (!isBillingError(err)) throw err }
  if (!parsed) parsed = templateFollowup2(t, intro)
  const draft = await prisma.emailMessage.create({
    data: {
      targetId: t.id, direction: 'out', kind: 'followup3', status: 'draft',
      toEmail: t.contact.email, fromEmail: (await sendMode()).address,
      subject: parsed.subject, body: parsed.body,
    },
  })
  return { ok: true, draftId: draft.id }
}

// ---- reply assistant -------------------------------------------

// A brand wrote back — draft Leo's response for him to edit and send.
export async function draftReplyResponse(emailId: string) {
  const reply = await prisma.emailMessage.findUnique({
    where: { id: emailId },
    include: { target: { include: { brand: true, contact: true, emails: { orderBy: { createdAt: 'asc' } } } } },
  })
  if (!reply || reply.direction !== 'in') throw new Error('That is not an incoming reply')
  const t = reply.target
  const thread = t.emails.filter(e => e.direction === 'out' && e.status === 'sent')
    .map(e => `[${e.kind}] ${e.subject}`).join('\n')
  const prompt = [
    `You are drafting a reply for ${SENDER_NAME} at SB Agency (produces large fraternity/sorority concerts at US colleges; sells brands activations there: sampling, banners, product seeding, ambassadors).`,
    `${reply.target.contact.name}${t.contact.title ? ` (${t.contact.title})` : ''} at ${t.brand.name} just replied to ${SENDER_NAME}'s outreach.`,
    `THEIR REPLY SUBJECT: ${reply.subject ?? '(unknown)'}`,
    `WHAT WE'VE SENT THEM SO FAR:\n${thread}`,
    t.brand.goals ? `BRAND DISCOVERY NOTES: ${t.brand.goals}` : '',
    ``,
    `Write ${SENDER_NAME}'s response. Rules: warm, concise (under 110 words), plain text. Assume the reply was interested-or-curious unless the subject clearly says otherwise. Goal: lock a 15-minute call this week or next — propose two concrete windows (e.g. "Tue or Wed afternoon"). Offer to tailor ideas to their goals. Sign off exactly:\nBest,\n${SIGNATURE}`,
    ``,
    `Return ONLY JSON: {"subject": "...", "body": "..."} — subject "re:" + their subject.`,
  ].filter(Boolean).join('\n')
  let parsed: any = null
  try { parsed = parseEmailJson(await askClaude(prompt, 600)) } catch (err) { if (!isBillingError(err)) throw err }
  if (!parsed) parsed = templateReplyResponse(t.contact.name, t.brand.name, reply.subject)
  return { subject: parsed.subject, body: parsed.body, to: reply.fromEmail ?? t.contact.email }
}

// Send that response (or Leo's edited version of it).
export async function sendReplyEmail(targetId: string, to: string, subject: string, body: string) {
  if (await sendingPaused()) throw new Error('Sending is paused — turn it on in Outreach → ✉ Email when you\'re ready to go live.')
  const { mode } = await sendMode()
  if (mode === 'none') throw new Error('No sending account connected')
  if (!to || !/@/.test(to)) throw new Error('Valid address required')
  if (!(await domainAcceptsMail(to))) throw new Error(`${to} — domain has no mail server`)
  const rec = await prisma.emailMessage.create({
    data: {
      targetId, direction: 'out', kind: 'response', status: 'draft',
      toEmail: to, fromEmail: (await sendMode()).address, subject, body,
    },
  })
  const replyCc = AUTO_CC.filter(a => a.toLowerCase() !== to.toLowerCase())
  const replyMark = await logoAttachment()
  const replyFiles = await signatureAssets()
  await deliver({
    from: await fromHeader(),
    to, ...(replyCc.length ? { cc: replyCc } : {}),
    subject, text: body, html: htmlBody(body, rec.id, !!replyMark),
    ...(replyFiles.length ? { attachments: replyFiles } : {}),
  })
  await prisma.emailMessage.update({ where: { id: rec.id }, data: { status: 'sent', sentAt: new Date() } })
  return { ok: true, to }
}

// Drafts store their sign-off as literal text, written at draft time.
// So changing EMAIL_SENDER_NAME renames future drafts but leaves the
// queue signed by whoever was configured when it was generated. This
// rewrites just that one line on drafts that haven't gone out — the
// body copy is never touched, so any hand edits survive.
export async function resignDrafts() {
  const drafts = await prisma.emailMessage.findMany({
    where: { direction: 'out', status: { in: ['draft', 'approved'] } },
    select: { id: true, body: true },
  })
  let changed = 0
  for (const d of drafts) {
    const body = d.body ?? ''
    // Two shapes to catch, both anchored to the very end of the body:
    //   1. the original "<name>\nSB Agency" sign-off
    //   2. any earlier version of the block itself (name/title, Direct:,
    //      Email:) — so a change to the title, number or address can be
    //      pushed onto drafts that were already re-signed once.
    // Anchoring to the end keeps a stray "SB Agency" mid-paragraph safe,
    // and re-running is a no-op once a draft already matches.
    const next = body
      .replace(/\n[^\n]*\|[^\n]*\nDirect:[^\n]*\nEmail:[^\n]*\s*$/, '\n' + SIGNATURE)
      .replace(/\n([^\n]{1,40})\nSB Agency\s*$/, '\n' + SIGNATURE)
    if (next !== body) {
      await prisma.emailMessage.update({ where: { id: d.id }, data: { body: next } })
      changed++
    }
  }
  return { scanned: drafts.length, changed, signedAs: SENDER_NAME }
}

// ---- status ----------------------------------------------------

export async function emailStatus() {
  const { mode, address } = await sendMode()
  const paused = await sendingPaused()
  const google = await googleStatus()
  if (mode === 'none') return { configured: false, paused, google }
  const cap = await currentDailyCap()
  const sentToday = await prisma.emailMessage.count({
    where: { direction: 'out', status: 'sent', sentAt: { gte: startOfLocalDay() } },
  })
  const drafts = await prisma.emailMessage.count({ where: { direction: 'out', status: 'draft' } })
  const approved = await prisma.emailMessage.count({ where: { direction: 'out', status: 'approved' } })
  const totalSent = await prisma.emailMessage.count({ where: { direction: 'out', status: 'sent' } })
  const totalReplies = await prisma.emailMessage.count({ where: { direction: 'in' } })
  const totalOpened = await prisma.emailMessage.count({ where: { direction: 'out', status: 'sent', opens: { gt: 0 } } })
  return {
    configured: true, address, mode, paused, google,
    // Where replies are read from: the connected Google account when
    // there is one, otherwise whatever IMAP mailbox is configured.
    replyBox: google.connected ? google.address : (process.env.REPLY_IMAP_USER || process.env.EMAIL_USER || null),
    replyVia: google.connected ? 'gmail' : (replyMailbox() ? 'imap' : null),
    cap, sentToday, drafts, approved, totalSent, totalReplies, totalOpened,
    lastCheck: await getSetting('emailLastCheck'),
  }
}

// Point a draft at a different person (and/or CC extras). Switching the
// main recipient also rewrites the "Hi <name>," greeting so the email
// never opens with the wrong first name.
export async function setDraftRecipients(emailId: string, args: { toEmail?: string; toName?: string; cc?: string[] }) {
  const d = await prisma.emailMessage.findUnique({ where: { id: emailId } })
  if (!d) throw new Error('Draft not found')
  if (d.status !== 'draft') throw new Error('Only unsent drafts can be re-addressed')

  const data: any = {}
  if (args.toEmail !== undefined) {
    const to = String(args.toEmail).trim()
    if (!/@/.test(to)) throw new Error('Valid recipient address required')
    data.toEmail = to
    // Fix the greeting to match the new person.
    if (args.toName && d.body) {
      const first = String(args.toName).trim().split(/\s+/)[0]
      if (first) data.body = d.body.replace(/^Hi [^,\n]{0,60},/, `Hi ${first},`)
    }
  }
  if (args.cc !== undefined) {
    const clean = (Array.isArray(args.cc) ? args.cc : [])
      .map(a => String(a).trim()).filter(a => /@/.test(a))
    const seen = new Set<string>()
    const deduped = clean.filter(a => {
      const k = a.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k); return true
    })
    data.ccEmails = deduped.length ? JSON.stringify(deduped) : null
  }
  if (Object.keys(data).length === 0) return d
  return prisma.emailMessage.update({ where: { id: emailId }, data })
}

export async function listEmailQueue() {
  const include = { target: { include: { brand: { select: { id: true, name: true, category: true } }, contact: { select: { name: true, title: true, email: true } } } } }
  // Drafts also carry every contact we have at the brand, so the UI can
  // offer "send to someone else / add someone" without a second call.
  const draftInclude = { target: { include: {
    brand: { select: { id: true, name: true, category: true,
      contacts: { select: { id: true, name: true, title: true, email: true }, where: { email: { not: null } }, orderBy: { name: 'asc' as const } } } },
    contact: { select: { name: true, title: true, email: true } },
  } } }
  const drafts = await prisma.emailMessage.findMany({
    where: { direction: 'out', status: { in: ['draft', 'approved'] } },
    include: draftInclude, orderBy: { createdAt: 'asc' },
  })
  const recent = await prisma.emailMessage.findMany({
    where: { direction: 'out', status: { in: ['sent', 'failed'] } },
    include, orderBy: { sentAt: 'desc' }, take: 20,
  })
  const replies = await prisma.emailMessage.findMany({
    where: { direction: 'in' },
    include, orderBy: { createdAt: 'desc' }, take: 20,
  })
  const exhausted = await listExhausted().catch(() => [])
  return { drafts, recent, replies, exhausted }
}


// ---- warmup monitor --------------------------------------------------

// Before cold outreach starts, the new mailbox needs a history of real
// two-way conversation — that's the signal Gmail weighs most heavily.
// This reads the connected mailbox (metadata only: who, when, which
// thread — never message bodies) and reports whether that history is
// actually being built.
//
// The number that matters is TWO-WAY THREADS: threads containing both a
// message we sent and a message we received. A thread that only ever
// goes one direction is not a conversation and does almost nothing for
// reputation.
const OUR_DOMAIN = 'sboyagency.com'

export async function warmupStatus(days = 14) {
  const g = await googleStatus()
  if (!g.connected) {
    return { connected: false, hint: 'Connect the Google account on the Outreach page first.' }
  }

  const me = (g.address || '').toLowerCase()
  const q = `newer_than:${days}d -in:chats -in:spam -in:trash`
  let msgs: any[] = []
  try {
    msgs = await gmailScan(q, 300)
  } catch (err: any) {
    return { connected: true, error: String(err?.message ?? 'Gmail scan failed').slice(0, 200) }
  }

  const threads = new Map<string, { sent: number; recv: number; who: Set<string> }>()
  const partners = new Set<string>()
  const domains = new Set<string>()
  const byDay = new Map<string, { sent: number; recv: number }>()
  let sent = 0, received = 0

  for (const m of msgs) {
    const outbound = m.from === me
    const other = outbound ? m.to : m.from
    if (!other || !other.includes('@')) continue

    const day = m.date.toISOString().slice(0, 10)
    const d = byDay.get(day) ?? { sent: 0, recv: 0 }
    if (outbound) { sent++; d.sent++ } else { received++; d.recv++ }
    byDay.set(day, d)

    // Internal mail is weighted differently by Gmail and teaches it very
    // little — count it, but never as a warmup partner.
    const dom = other.split('@')[1] || ''
    if (dom && dom !== OUR_DOMAIN) { partners.add(other); domains.add(dom) }

    const t = threads.get(m.threadId) ?? { sent: 0, recv: 0, who: new Set<string>() }
    if (outbound) t.sent++; else t.recv++
    if (dom !== OUR_DOMAIN) t.who.add(other)
    threads.set(m.threadId, t)
  }

  const twoWay = [...threads.values()].filter(t => t.sent > 0 && t.recv > 0)
  const twoWayExternal = [...threads.values()].filter(t => t.sent > 0 && t.recv > 0 && t.who.size > 0)
  const deep = twoWay.filter(t => t.sent + t.recv >= 4)

  // 20–30 real external exchanges over two weeks is the working target.
  const TARGET = 20
  const progress = Math.min(100, Math.round((twoWayExternal.length / TARGET) * 100))

  return {
    connected: true,
    mailbox: me,
    windowDays: days,
    sent, received,
    threads: threads.size,
    twoWayThreads: twoWay.length,
    twoWayExternal: twoWayExternal.length,
    deepThreads: deep.length,
    uniquePartners: partners.size,
    uniqueDomains: domains.size,
    target: TARGET,
    progress,
    ready: twoWayExternal.length >= TARGET && domains.size >= 4,
    byDay: [...byDay.entries()].sort().map(([day, v]) => ({ day, ...v })),
  }
}

// One-off transactional message (event invites to ambassadors). Not
// outreach, so the pause switch doesn't apply — but it still counts
// against the day's sending room so the mailbox never exceeds its ramp.
// Signed and branded like everything else that leaves this address.
export async function sendPlainEmail(args: { to: string; subject: string; body: string; cc?: string[] }) {
  const { to, subject, body } = args
  const { mode } = await sendMode()
  if (mode === 'none') throw new Error('No sending account connected')
  if (!to || !/@/.test(to)) throw new Error('Valid address required')
  const { room, cap } = await roomToday()
  if (room === 0) throw new Error(`Today's send cap (${cap}) is used up — copy the link instead, or send tomorrow.`)
  const text = body.trimEnd() + '\n\n' + SIGNATURE
  const mark = await logoAttachment()
  const files = await signatureAssets()
  await deliver({
    from: await fromHeader(),
    to, ...(args.cc?.length ? { cc: args.cc } : {}),
    subject, text, html: htmlBody(text, 'invite-' + Date.now(), !!mark),
    ...(files.length ? { attachments: files } : {}),
  })
  return { ok: true, to }
}
