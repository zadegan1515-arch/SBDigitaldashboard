# SB Command Center (repo: zadegan1515-arch/SBDigitaldashboard)

If `../CLAUDE.md` (the SB Agency workspace file) exists it applies too. The rules below are repeated here so this repo stands alone.

## Hard rules (never break these)
1. **Money is integer cents.** Never floats. Never sum sponsorship revenue, booking revenue and activation costs together — they are three separate lines.
2. **Credentials:** never type, print, log or commit passwords, app passwords, API keys, tokens or env-var values. Name the variable and tell Leo where to paste it (Vercel / Railway). Never ask Leo to send a secret in chat.
3. **sb-crm is read-only.** Never write to it.
4. **No Anthropic API spend** unless Leo explicitly approves it for a specific feature. Prefer rules/regex.
5. **Claude does not move real money.** Payouts on the platform run only when a human clicks; PayPal stays sandbox unless Leo sets `PAYPAL_ENV=live`.
6. **Never bulk-delete or overwrite data** without showing exactly what changes first.
7. **No emails go out** (Leo, Oct 6 2026: "no emails should be sent out"). `EMAIL_SENDING_OFF = true` in `src/lib/no-send.ts` stops every send path at its last step (`deliver`, `sendViaGmail`, `opsSend`) — outreach, test/warmup, ops replies, Show Board access codes and team notifications. Drafting, Copy and Open in Gmail still work. Never flip it without Leo's explicit yes; `node scripts/test-no-send.mjs` fails if it's off or a send path skips the guard. (If Leo turns sending back on: the cap is in code — start 5/day, +8/week, ceiling 40; never raise it without him.)
8. Ask clarifying questions when the request is ambiguous. When reporting back: **what you fixed, what Leo needs to give you** — short, with links. No long explanations. Anything Leo must do himself is a labeled **NEED** block: a bold one-line label, numbered steps, only the info required — nothing extra.
9. **Attendee data (Audience module):** individual attendee records never leave the dashboard — sponsors and every public API get aggregates only. Email is identity: all attendee writes go through `normalizeEmail` in `src/lib/audience-core.ts`, guarded by `node scripts/test-audience.mjs`. Consent text is versioned (`ConsentText`); imports never claim consent the person didn't give. Deleting an attendee (the "remove my data" path) always shows what goes before it goes.

## Ways of working
- Leo chose: **push straight to `main`**. Both hosts auto-deploy, so after every push **check the build went green** (Vercel dashboard or `vercel` CLI; Railway deployments tab) and re-check the live page.
- Vercel Hobby limits: **2 cron jobs, daily only**; 1 concurrent build. Don't add crons — fold new scheduled work into `/api/cron/email` (11:00 UTC) or `/api/cron/send` (15:00 UTC).
- Prisma schema changes deploy themselves (`prisma db push` runs in the Vercel build — **production builds only**, `scripts/db-push.mjs`: previews share the production database, and on Oct 12 2026 a branch preview without `Brand.kind` dropped it and broke every brand page). The Vercel project's **Build Command** is set to the same rule (`prisma generate && if [ "$VERCEL_ENV" = "production" ]; then prisma db push --skip-generate; …; fi && next build`) so a branch that hasn't merged main can't undo it either. Still: additive changes only; never drop columns with data. A branch with a new column works in its preview only once main has it.
- Test before pushing: `npm run build` (Next) / `npx tsc --noEmit`, and for `public/app.html` a Playwright smoke run with mocked `/api/data` (`NODE_PATH=$(npm root -g) node scripts/test-keep-place.js` is one).
- Google OAuth: one Google Cloud client (`GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET`) serves three grants — outreach mailbox (`state=gmail`), Drive (`state=drive`), ops mailbox (`state=ops`). Scopes stay narrow: gmail.send + gmail.readonly, drive.file. Never request mail.google.com or modify/delete scopes.


Live: https://sb-digitaldashboard.vercel.app/app.html · Vercel Hobby, team `sbagency`.

## Stack
Next.js 14 App Router · Prisma 5 · Neon Postgres · NextAuth (Google sign-in, allowlist) ·
one vanilla-JS page `public/app.html` (no framework, no build step for the UI) ·
one API: `POST /api/data` with `{ fn, args }` dispatched from the `handlers` map in
`src/app/api/data/route.ts`.

## Where things live
- `public/app.html` — the whole UI. Top nav is six groups with sub-tabs (`SUBTABS`/`GROUP_OF` in
  `showView`): Home · Brands (All brands / Discover / Clarify — Stock take and Needs contacts are buttons on All brands) · Outreach (LinkedIn / Results /
  Week plan / Schedule / Email / People / Archived / Email stats) ·
  **Show Board** (Overview = code lookup (`boardCodeLookup`: the whole roster by name / aka, people and archived too — it used to filter listBrands' first 500; `test-board-lookup.js`) + access-request approve/deny queue + stat tiles (total visits,
  today, 7 days, unique, avg time, requests) + 30-day visits chart + who's-opened feed grouped by day with
  exact NY times and time on board; **every** board open is logged, gate on or off (anonymous = "Visitor") / **In talks** = per-brand engagement cards (code, viewers, opens, timed minutes
  via the board's 60s heartbeat → `BoardVisit.lastSeenAt`, picked shows, visit log) / Requests /
  Shows) · **Deals** (Board = the old Pipeline / Sponsorships) · **Audience** (Events / Attendees —
  attendee capture, sponsorship module Phase 1) · Operations (Materials / Team —
  the ops@ inbox and contract/invoice UI are removed from the site per Leo; `src/lib/ops.ts`, its
  cron scan and the generateContract/Invoice handlers still exist server-side).
  **Activations** is its own workspace (sidebar + tabs swap in), entered from the left sidebar or the
  Home "Jump to" card — not in the top nav. Deep links: `#activations/<id>/<tab>`, `#operations/<id>`.
- **Brand page people/outreach wording** (`liWords`, `emailWords` in app.html): never a bare status
  word. LinkedIn and email are separate lines — "LinkedIn · invite sent Sep 16" (logged by hand with
  **Invite sent on LinkedIn ✓**), "LinkedIn · not sent yet", "Email · intro drafted, not sent" /
  "sent <date> · opened". `getBrand` returns each target's outbound emails and fills the free template
  notes for anyone not yet contacted, so a newly added person gets Note · M/W instead of only the log
  button. **Draft intro email** only drafts; the card reloads and the header shows that email's state.
- **Home → Today** (Leo, Oct 6 2026: "a screen of what has been done today … who we reached out to,
  what should we do today, what brands did we find, what you need from me, ideas"). Home's top is the date,
  **+ Paste what Claude did** / **Today's recap ▸**, and four tiles (Reached out / To do / Brands found /
  Needs you — a click opens the recap at that card); the old KPI rows, revenue and category cards fold into
  "Numbers & categories" at the bottom. **The recap** (`openRecap`, `rc*` in app.html, `#recap`) opens by
  itself on the first visit of each **Tue–Fri** (per browser, localStorage `sb.recapSeen`; `RC_DAYS`), from
  the button, a tile, or `app.html#today`: full screen, one card per section (who we reached · what to do
  today (today only; Zach's list counted on the page with `ztFilterOf`) · brands found · what Claude did (when
  chats were logged) · what I need from you · ideas), scroll / arrows / dots / a click on the card move on,
  the last click (Done) or Esc closes. **Today's log** (`renderDayLog`, `dl*`; **not shown on Home** — Leo, Oct 7 2026: "get rid of this"; `#day-log` is hidden until **+ Paste what Claude did** or the recap's Open Today's log sets `DL_SHOW`, × closes it): any day (‹ › and a day list),
  the day's numbers, **paste box** and the pasted chats. Data = `dayRecap({ day })` (read-only: invites by
  sentAt, accept events, emails, Zach's list steps, Discover rows + brands created that day, the review
  queues as counts, the day's chats, `BUILD_IDEAS` + Leo's picks). **Pasted chats** = table `WorkLog` (one
  row per chat, raw text kept): `addWorkLog({ text, day })` splits on a line of `---` or a new "Debrief …"
  line, drops a chat already saved that day, and sorts lines with rules (`src/lib/work-log.ts`, no model call):
  NEED blocks / need-ish headings → Leo's to-do (ticked via `setWorkNeedDone`), idea / next-step headings →
  ideas, the rest → done. `deleteWorkLog` previews first. A Claude session can log itself:
  `node scripts/cc.mjs addWorkLog '{"text":"…"}'`. **Ideas** live in `src/lib/build-ideas.ts` (retire one there
  once built); **Build this** = `pickBuildIdea` → Setting `buildIdeaPicks` — read them with
  `node scripts/cc.mjs dayRecap` before choosing what to build. Tests: `node scripts/test-work-log.mjs`,
  `NODE_PATH=$(npm root -g) node scripts/test-today.js` (page, fake /api/data),
  `E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-today-e2e.js` (real handlers).
- **Home → Claude's day** (Leo, Oct 14 2026: "at the end of each day i want a review of everything that was updated
  through claude"; his picks: on the dashboard, opens itself; site changes, data Claude changed, what Claude needs).
  **Claude’s day ▸** in Home's header (before Today's recap), and by itself on the first visit after **5pm New York**
  (per browser, localStorage `sb.claudeDaySeen`; it also marks the morning recap seen so it doesn't open on a second
  evening visit). Same full-screen cards as the recap (`drawCards`, `openClaudeDay`, `cd*` in app.html), ‹ › for other
  days. Data = `claudeDay({ day })` (read-only): **What Claude changed on the site** = Claude's commits on `main` that day
  (GitHub's public API, trailers / merges out, `readCommit`; cached in Setting `claudeCommits`, 10 min today, for good
  once the day is over; optional `GITHUB_TOKEN`); **in the data** = table `ClaudeAction` — every `/api/data` write made
  with the dashboard token (`a.__user === 'CLI'`, i.e. `node scripts/cc.mjs …` from a Claude session), worded by
  `actionText` (reads, previews, refusals and addWorkLog are never logged) — plus the brand hunt's Discover finds;
  **what the sessions said** = the day's WorkLog chats; **what Claude needs from you** = their NEED blocks (ticked here,
  `setWorkNeedDone`), open needs from the 6 days before, and review queues (research to review, Discover finds). Rules
  pure in `src/lib/claude-day.ts`: `node scripts/test-claude-day.mjs`; page: `NODE_PATH=$(npm root -g) node
  scripts/test-claude-day.js`. **Every Claude session that changes something should end by logging itself**
  (`node scripts/cc.mjs addWorkLog '{"text":"…"}'`, NEED blocks for Leo's to-dos) — that's the "sessions said" card.
- **Home → Your chats** (Leo, Oct 17 2026: "i usually use more than 4 chats a day … i sometimes forget what each one is
  about … tells me what chat did what, and what each chat needs from me"). One `WorkLog` row per claude.ai chat per New
  York day (`source: 'session'`, `sessionId`, `url`, `about`, `ask`/`asks` = Leo's messages that day, `status` working ·
  needs · done, `question` = what its last reply asks, `lastAt`), written only by `chatLog({ session, event: prompt |
  reply | question | summary, … })` — rules pure in `src/lib/chat-log.ts` (a reply sorted by work-log.ts's rules, the
  question it ends on, secrets masked, Leo's ticks carried by the need's words, an older post never winds a chat back).
  Shown as Home's **Claude chats today** tile (`data-cd-open="chats"`) and **Claude's day → Your chats**, its first card
  (`chCard`/`chRow`/`chState` in app.html: Needs you → Working → No reply yet (working 2 h+) → Done; the title opens
  the chat); their NEEDs and questions are on the Needs card too; a chat's older days' needs give way to its latest day.
  Pasted logs keep the "sessions said" card. `chatLog` is never a ClaudeAction. Fed by **the chat itself**
  (`scripts/chat-log-hook.mjs` from Claude Code hooks — UserPromptSubmit / Stop / PreToolUse AskUserQuestion|ExitPlanMode;
  detached post, nothing on stdout, quiet without `DASHBOARD_TOKEN`) and/or **the chat review** (`docs/chat-review.md`:
  a chat reads Leo's other chats with list_sessions / list_events and posts `summary`; `listChatLogs` = what's logged).
  `node scripts/cc.mjs <fn> @file.json` reads args from a file. Tests: `node scripts/test-chat-log.mjs`,
  `node scripts/test-chat-log-hook.mjs`, `E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-chat-log-e2e.js`,
  page in `test-claude-day.js` (4).
- **Leo's picked ideas, built Oct 6 2026** (retired from `build-ideas.ts`): **Weekly scoreboard** on Home (`#hm-score`,
  `weeklyScore` / `setWeeklyGoals`, Setting `weeklyGoals`, defaults `WEEKLY_GOALS_DEFAULT`): invites / accepted /
  replied / calls booked / deals / brands added per New York week (Mon–Sun), this week vs goal + 8 weeks of bars.
  **Deals gone quiet** (`#hm-stale`, `staleDeals`): open deals with nothing at the brand (deal update, outreach
  step, email, board visit) for 14+ days; also an ask on the recap. **Friday wrap-up**: `dayRecap({ day, to })`
  is a range (no to-do); **This week ▸** on Home and Friday's auto-recap open Monday..today with **Copy the week for
  Zach** (`weekText`). **Brand timeline** (brand page, `#brand-timeline`, `brandTimeline`): every touch newest first,
  loaded when the fold opens. **Zach's list on a phone**: `app.html#zach` on a ≤820px screen = `zach-only` (list only,
  "Show the whole Home"). **Sponsor report** (Audience → an event → Sponsor report, `sponsorReport`): print page from
  `audienceEventStats` (now also `byClassYear`, `byAgeBand`) — totals only, rule 9.
- **Home → Today's list for Zach** (Leo, Oct 6 2026: "a button on the home page that can copy a list of what is
  supposed to be sent out today so i can send to zach" + flag queued people who "do not fit a role or there is
  someone who should replace them"). Button in Home's header (and on the recap's To do card) opens `#hm-send`
  (`sl*` in app.html): `todaySendList` = today's LinkedIn queue (the same `getTodayQueue` read the LinkedIn tab
  does) by company, each person with title + link, plus the **queue check** (`src/lib/queue-check.ts`, rules only:
  `personProblem` = no title / not a buyer title (buyers.ts) / refused by the LinkedIn rules (student, store,
  investor…); `checkBrandQueue` offers an uncontacted person at the same brand with a LinkedIn link and a stronger
  title — partnerships > events > marketing = founder — one candidate per person, weakest first). **Copy for Zach**
  = plain text (company, • name — title, link), flagged people left out unless "send anyway" is ticked — **no invite
  notes** (Leo sends the invites himself; format unchanged). **Swap** =
  `queueContact` (the better person) + `passContact` (the flagged one); **Leave out** = `passContact`; Queue on the
  brand page undoes either. **Flagged people stop holding spots** (copy-flagged, Oct 12 2026): the header counts
  "N flagged" (problem only — `todaySendList.flagged`) and "N could swap" (a better person alone, `swaps`); the copy
  button says "Copy for Zach (27) — 3 flagged still hold spots today"; **Leave out the N flagged** (`slHeld` = flagged,
  not "send anyway") = `leaveOutPeople` (preview names each one and why → confirm: one transaction, status passed +
  out of today, so the next load fills their room; Setting `sendListLeftOut`) and "left out N · Undo" the same day
  (`undoLeaveOutPeople`: back with the status and stamp they had). `getTodayQueue` attaches `problem` to everyone
  still to send, so the LinkedIn tab's rows show the same ⚠ (`targetRow`). `node scripts/test-queue-check.mjs`; page +
  e2e in test-today*, the LinkedIn-tab flag in test-outreach-lists.
- **Home → For Zach to do** (`zachTodo` + `renderZachTodo`; deep link `app.html#zach`) — **everyone who
  accepted a LinkedIn invite** until they're finished (`HAND_WAITING` in `route.ts`: accepted/replied,
  no `callAt`, no `handSkippedAt`). Replied by email still shows (Email step ticked, "replied by
  email"); archived / do-not-email brands show with a tag, never hidden. Filters: To do / Waiting only. **Call to book sits under Waiting, not To do** (Leo, Oct 6: not urgent; the status board counts it — `ztIsWait`).
  One-line rows under brand labels (avatar colour follows the brand,
  a 4-dot mini flow, the next step in words), **earliest step first** (Leo: "the earlier the stage,
  the higher up it should be" — `ztCompare`: text back → follow-up → reply to answer → email/DM to
  send → call; longest-waiting first within a step; a brand sits where its earliest person sits and
  keeps its people together); one row open at a time shows the flow
  **Accepted → Text them on LinkedIn (due 2 days after the accept, calendar days, **Tue–Thu only** — Leo, Oct 12 2026: a due day on Fri–Mon moves to Tuesday, `ZT_MSG_DOWS`; waits until then as
  "Text them <day>", late after) → no answer 10 days after that message: Send the final reach-out → still
  quiet 7 days after the final: No response → Replied → They want email → Email to send → Email sent,
  and/or They want LinkedIn → DM to send → DM sent (either or both; picking one logs the reply) →
  Call scheduled** (day picked; sets followUpAt so it shows in Needs action on the day; the end).
  **Cadence** (Leo, Oct 5 2026): `HAND_DM_DAYS = 2`, `HAND_NUDGE_DAYS = 10`, `HAND_QUIET_DAYS = 7` in
  route.ts, sent with zachTodo (`ZT_DAYS` on the page: `ztMsgDue` / `ztFinalDue` / `ztQuietDay`,
  `ztDaysTo`). **No response** is worked out on the page (stage `noreply`, nothing written): off To do
  and Waiting into its own filter chip; a reply any time brings them back. Results → "DM'd, no answer"
  (`followUpsDue`) uses the same 10 days and the same final text, and drops anyone already sent the final.
  **Where every brand stands** (Leo: "view where we are at with our outreach and what status all the
  brands are at so we dont forget to maintain comms"): a full-width board at the top of Home, above
  Zach's list (`zs*` in app.html; Leo, Oct 6: "more defined ... lines between the categories ... move it
  higher up"): one bordered card per stage side by side (`.zs-board` grid, colour edge per stage, "N late"
  in the card head), 5 rows a stage (3 on a phone) then "N more". Every brand with someone on
  the list + every call booked, grouped Accepted (first message due) / Messaged (final reach-out due) /
  Final sent / Replied-emailed / Call booked / No response; a row per brand per stage (a brand with people
  at two stages shows under both), its most urgent person leads, countdown "in 3d / today / 2d late";
  "N late · N due today · N brands" on top. A click opens that person on the left under their filter
  (`zsOpen`); a call opens the brand page. Read-only. `node scripts/test-zach-status.js`.
  **On the brand page too** (Leo, Oct 13 2026: "you should be able to do the steps after they accept an invite on a
  company's card"): under each person whose outreach is accepted / replied, the same card (`.b-zt` slot, `bzt*` in
  app.html; `zachTodo({ brandId })` = one brand's people, booked calls and done steps), one person object shared with
  Home's list (`bztAdopt`, `ZT_BY_ID`), the same handlers (`ztOnClick`… bound on `#brand-body` inside `.b-zt`;
  `ztItemEl` takes the copy on screen, `ztInBrand`/`ztAfter` redraw the card); a finished person (call booked / Not
  needed) is one line with Undo. A step redraws **in place only** — the card, the People pill (`bztSyncRow`) and the
  Outreach row's pill + Accepted/Replied part (`bOutreachStep`, `bztSyncOutreach`) — never the whole page (a reload cut
  off typing in the card); `bztFill` never redraws a card with a focused box. The Outreach row's Replied? moves the card
  on; its Accepted? reloads (the person needs a card). Copy DM copies the card's message. A read sent before a tick never
  undoes it (`ztFresher`, `p._at`). `NODE_PATH=$(npm root -g) node scripts/test-brand-zach.js`.
  "← Back a step" on an open card undoes the latest tick (`ztLastStep`). The stage is computed on
  the page (`ztStage`); every tick/undo is `handStep` (dm, nudge, replied,
  wantsEmail, liPath, liSent, emailed, call, skip). Fields: `dmSentAt`, `nudgedAt`,
  `handWantsEmailAt`/`emailedAt`, `handLiPathAt`/`handLiSentAt`, `callAt`/`callBookedAt`,
  `handSkippedAt`. Two templates (Settings `handEmailTemplate`, `handDmTemplate`; placeholders
  (NAME) (BRAND) (TITLE); the email one is Leo's text by default (`HAND_EMAIL_TEMPLATE_DEFAULT`), the DM one a stand-in until he saves his), edited in one modal with tabs and a live
  preview; per-person edits in `Target.handSubject/handBody/handDm` (null = follow the template).
  The first LinkedIn message ("Text them on LinkedIn") follows a third template, Setting
  `handFirstDmTemplate` (Leo's pasted text is the default; "Edit template" on the card or the modal's
  First LinkedIn message tab); a card keeps its own text only when someone really rewrote it (draft
  `firstMessage` edited and ≠ the queue's stock text; Reset to template clears it). The **final
  reach-out** follows a fourth, Setting `handFinalTemplate` (stand-in until Leo saves his; the modal's
  Final reach-out tab); a card's edit is `Target.handFinal` (null = the template; `saveHandEmail`
  `final`), no longer the queue draft's nudge. Leo's note is
  `Target.handNote`; To writes `Contact.email` (old address kept in the contact's notes).
  Open in Gmail (compose URL, `authuser` = signed-in email) / Copy: **nothing sends from the site**,
  so the cap isn't involved. Done fold (30 days) and Calls booked, each with Undo. No CC (Leo's call); one-pager is a download button. The email
  machine skips brands with an accepted/replied/hand-emailed person, and skips follow-ups to accepted
  or hand-emailed people. Results → "To email" is now a pointer here.
- **Doesn't want to continue** (Leo, Oct 15 2026: "some people respond but i want to make sure we dont reach out
  to them again"; his call: the step asks **just this person or the whole brand**). On every open card of Zach's list
  (Home and the brand page), beside Not needed (now only "handled somewhere else"; `ZT_STOP`, `ztDecline` in app.html).
  **Just <first>** = one click, `handStep({ step: 'declined', scope: 'person' })` → `stopContact`: `Target.handDeclinedAt`
  / `handDeclinedScope` + `Contact.doNotContactAt` / `doNotContactBy`. Their status stays accepted / replied (they were
  reached — never `declined`, which reads as never reached). **Their other copies** (`src/lib/do-not-contact.ts`,
  `stopTwins` / `stoppedMatch`: the same LinkedIn profile — typed or percent-encoded — or personal email anywhere, the
  same full name at the brand; copies of copies too, a few hops) are marked in the same moment and their waiting rows set
  aside (Setting `personStopLog`); the toast names them.
  **Everyone at <brand>** = a preview on the card first (the others on Zach's list, today's list, the pool and next in
  line, coming Schedule days, their other copies; left as they are: calls booked, invites still out, open deals, email
  drafts — those never send) → Stop sends its `expect` (changed since → `stale`, shown again): `Brand.stoppedAt` /
  `stoppedBy` + archived + do not email, everyone not yet contacted set aside on purpose, off coming days, Setting
  `brandStopLog` for the Undo. A person stopped on their own can still **widen** to their brand (the brand's Undo then
  leaves them stopped, `targetBefore`). Nobody is reached again, by the system or by hand: `HAND_WAITING` / `NOT_STOPPED`
  (Zach's list, Needs action, follow-ups due, Results' "They accepted — send the DM" via `listTargets`, "They replied —
  keep it moving"), `assertNotStopped` (handStep, markEmailed, queueContact, setTargetStatus incl. DM sent,
  setTargetShelved's Promote), queueBrandTargets (never promotes a marked copy's row), reason `stopped` (outreachGate /
  planRefusal), `isReachable`, the email machine (send and draft paths), Archive's Bring back / Emails on refused while it
  stands, **mergeBrands / combineParent / undoCombineParent refuse** a stopped brand (a merge would end or spread it),
  a marked person's row still waiting is set aside on the stop's record wherever one appears (`setAsideMarked`: a
  merge that carries the mark, a merge's Undo), undoLeaveOutPeople skips them, undoLinkedInLog refuses, and today's
  list, the pool, the queue's count (`reconcileBrandTargets`) and the Schedule's preview (`previewBrandPicks`) leave them
  out (`NOT_MARKED`) — and
  new copies are refused by upsertContact, importContacts (`optedOut`), the LinkedIn capture (a dupe), the SponsorUnited
  capture and SB · Log (`assertLoggable`; 1.3 and + Add from LinkedIn say "doesn't want to continue", never "on Zach's
  list"). The LinkedIn tab's rows say it with nothing to send (`targetRow`); the recap lists a stop but never counts it as
  outreach (`steps[].stop`). A **call booked** there stays in Calls booked marked "Said they don't want to continue —
  cancel it" (`calls[].stopped`, off the status board; the brand page's line too, with **Cancelled**). The brand page: the
  person's card becomes one line with Undo, the pill says "doesn't want to continue", a stopped brand has a banner
  (`#b-stopped`), no → Queue / log / Promote buttons. **Undo** (the bar, the Done fold — "(whole brand)" — the card's line,
  the banner; `ztUndoStop`; through a person it only takes back their own mark — a brand stopped through someone else
  stays, said in the toast) asks `undoStopContact({ preview: true })` first and, for a whole brand, names what comes back
  in a confirm (rule 6); it reads its record inside the stop's locks (`brandStopLog` then `personStopLog`), puts back
  exactly what changed — the person and every copy marked at that moment (cleared by its time), people set aside, the
  Schedule days (one the stop emptied comes back as Best fit while still a sending day) — and names what stays
  (`stays`: changed since, a day gone by or taken off, no record). Merging the person's copies keeps the mark on the
  copy that stays, and its Undo gives every copy the mark as it stands then (`undoSamePerson`). Claude's day words it
  (`stopText`; a stop that already stood is no change). `node scripts/test-do-not-contact.mjs`, `NODE_PATH=$(npm root
  -g) node scripts/test-do-not-contact.js`, `E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-stop-e2e.js`.
- **Invites sent straight from LinkedIn** (Leo, Sep 2026: an unlogged invite that got accepted meant
  Add person → Queue → Invite sent → Accepted). Now one step, **never through a day's queue**: rules pure
  in `src/lib/li-log.ts` (`node scripts/test-li-log.mjs`), writes in `src/lib/li-log-db.ts` (shared by
  /api/data and /api/ingest). **Invite sent** = sentAt now (counts in the day's 30, the weekly limit,
  accept rates; They accepted later). **They accepted** = status accepted with **no sentAt** (Leo's call:
  only accepts get logged this way, so they stay out of the weekly limit, coverage and accept rates);
  its TargetEvent is Zach's list's acceptedAt ("Text them" due 2 days after the log, `HAND_DM_DAYS`). Because of that,
  "was this brand/person contacted" must use `wasInvited` / `INVITED_WHERE` in route.ts (sentAt OR status
  sent/accepted/replied/converted), **never sentAt alone**. A log never moves anyone backwards; the person
  is found by profile link anywhere or by name at the brand (no second copy; on file at another brand →
  refused, naming it); a new brand always gets a category (keyword `guessCategory`, never a model call).
  Where: Home → Zach's list **+ Add from LinkedIn** (`findLinkedInPerson`, `brandLookup`,
  `logLinkedInPerson`; a pasted link fills the name via `nameFromSlug`), brand page People rows
  (**Invite sent ✓ / They accepted ✓**), **+ Add person**'s "On LinkedIn" chips, and the **SB · Log**
  pill on a LinkedIn profile (`scripts/linkedin-log.user.js`, Zach's browser — below). Every log has an Undo (`undoLinkedInLog`: 30 min, only while nothing happened since;
  removes a person the log made). The brand card says "invited outside the queue" for an accept with no
  invite date, and a draft written after the send is "The first DM, ready to copy", never "the note that
  went out".
- **Outreach → Week plan** (Leo, Oct 18 2026: "a page that fills up to around 100 brands … the top 100 ranked … a search
  bar to add brands … add brands … by filtering through categories … have the brands i want to reach out to in a week set
  up before … then … randomly put them into the days for the week which i should be able to move between days"; his picks:
  a **bank spent week by week**, an **even mix of rank**, a spread day takes **only brands from the list**). Rules pure in
  `src/lib/week-bank.ts` (`node scripts/test-week-bank.mjs`); `wp*` / `WP` in app.html (`#weekplan`, tab between Results
  and Schedule). **The list** (Setting `weekBank` = { size, hand, removed }; `buildBank` in route.ts) = brands Leo added
  (search box = `searchPlanBrands` for the week's first day; Browse a category = `weekBankBrowse`, Add the top N / ticks;
  a giant's Add anyway OKs it, `okGiants`) + the brands a Best fit day would pick by itself (`bestFitEligible`, someone
  would go out, not going out today), **best Brand Fit first** (`compareBank`: fit, then ready, then name — not Ready
  before short), up to its number (`weekBankSize`, 10–300, default 100; hand adds count toward it). It is worked out on
  every read: a brand reached drops out and the next one comes in. × = `weekBankRemove` (remembered — the list never puts
  it back; on a row already on a day it asks and takes it off that day too, `offDays`); Put back = `weekBankPutBack`. A
  hand add leaves once something goes out to it after it was added (`handSpent`) or it's archived / do-not-email / not US /
  in talks / stopped (pruned on the next `weekBank` read). Advisory-locked writes (`updateBankState`). **The week**:
  `planWeeks` = this week (Mon–Sun, New York) while it has a sending day after today, and next week; today is never a
  column. Each day's room = `weekRooms` (30, or what LinkedIn's 100 in 7 days leaves — days counted full in date order)
  less its pins going (`weekColumns`, from getOutreachPlan's cards). **Spread** (`weekSpread`, preview → apply,
  `seed` = the shuffle; Shuffle again = a new seed): `spreadWeek` deals the list's waiting brands in rank order, each
  whole, onto the fitting day dealt the fewest brands so far (ties at random) — #1–#3 on three different days, #4–#6 the
  same — never past a day's room, one big company a day (`BIG_PER_BEST_FIT_DAY`); a brand too big for every room left is
  passed over (named) and waits for next week. Apply writes exactly the preview's days through `planAddCore` (a brand
  pinned elsewhere since is left there, named), marks every spread day **list-only** (Setting `outreachListDays` = { day:
  { at, by } }) and logs Setting `weekSpreadLast` for `undoWeekSpread` (preview → confirm: off what still sits where it put
  it, a moved one stays, days it marked go back; today's never touched). **A list-only day** has no automatic picks:
  getOutreachPlan's rows (`list: true`, offTheme 0), getTodayQueue (`listDay`; its fill only for Fill to 30 — `__fill`
  from fillToday — and then from the list, its order; Ready if you have room = the list), Plan my week (`WeekDayIn.list`
  → source `list`, nothing added), the morning roll treats it like a Best fit day (what was only shown goes back);
  its Fill box / suggestForDay offer the list (`bankSuggestRows`, `data.list`). `setListDay` = **Keep it to my list** /
  **Let Best fit fill open spots** (Week plan's columns; the Schedule's day ⋯). Moving on the page = the Schedule's
  handlers: Move to… / drag between days (`planMoveBrand`), × and Off the days (`planRemoveBrand`), Put on… / drag a list
  row onto a day (`planAddBrands`). The Schedule shows a list day with a **Week list** tag and no category menu; the
  LinkedIn tab says "Today takes only your week list". Tests: `node scripts/test-week-bank.mjs`, `NODE_PATH=$(npm root -g)
  node scripts/test-week-plan.js` (page), `E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-week-plan-e2e.js`.
- **Outreach → Schedule** (`getOutreachPlan` + the `sd*` / `renderSched*` code; plan in Setting
  `outreachPlan` = `{ "YYYY-MM-DD": { category, brandIds } }`, one brand on one day) — full width,
  today (if a sending day) + the next 3 sending days as columns. Every brand carries a **contacts label**
  (`contactLabel`, same on server and page): reachable = email OR LinkedIn; need = `workPeople` ??
  (big company 10 : established 4 : 3 — `workNeed`; every reply that labels reads `LABEL_BRAND_SELECT`, and
  `isBigBrand` / `contactLabel` require name, aka and liMembers so a short select fails tsc — the LinkedIn tab
  used to call a 120-person established brand "big, works 10" while the Schedule said 4); Ready ≥ need,
  Thin 1..need-1, No one reachable 0. A brand goes out **whole**,
  opened to its thread count (`previewBrandPicks` mirrors `queueBrandTargets` without writing;
  `fillWholeBrands` is shared by the preview and `getTodayQueue`, so what the Schedule says is what
  the LinkedIn tab stamps; a day never passes 30 — `DAILY_SEND_LIMIT` in route.ts, Leo's call Sep 28
  2026, up from 20; the page shows the server's number via `sdCap()` / `SENT_TODAY.cap`, never a literal;
  the system's own picks stop sooner when LinkedIn's week leaves less — `days[].cap` / `sdCap(key)`, below). Pinned cards say who goes or exactly why not
  (`outreachGate` + `reasonText`). **Kept simple** (Leo, Oct 7 2026: "a little clunky there's a lot going on"):
  on screen = Plan for Zach / What went out / **More ▾** (Plan my week, Undo week plan, Category priority,
  + Add a sending day, Hide too small), the LinkedIn weekly line only when it warns, the find box, the
  contacts check as one line (nothing when every brand is ready), the day columns, Categories & coverage
  folded (`#sched-catfold`, remembered in localStorage `sb.schedCats`; drawn and read only while open). A card is one row — name, contacts
  dot, tags, × (Unpin; on any day's automatic row Not now = a two-week Pass, `passBrandToday`) and ⋯ (up / down, ⤒ Move to top, Move to, Send today anyway,
  LinkedIn people, SponsorUnited, Archive, links); a day's ⋯ has Move what's left (today) / **Move this day to…** and
  **Lock this day** (later days, below) / Remove this sending day / See every brand; Invited today is a fold.
  **Lock the days** (lock-days; Leo, Oct 12 2026: **only when he clicks Lock** — his Oct 7 rule that open days
  re-rank stays): a later day's automatic rows re-rank on every load as people are found and brands are added, so
  they're tagged "Best fit · may change" ("may change" on a category day; today's aren't — its rows go into the
  LinkedIn list as they are). **Lock this day** (day ⋯) and Plan for Zach's **Lock these days** (`lockDays`,
  `lockRows`) name every brand first, then pin exactly the rows on screen in order = `planWeek({ apply, lock: true,
  days })` — same Undo as Plan my week (More ▾ "Undo the lock"; `planWeekLast.lock`). A brand pinned nowhere but
  shown on a day is "Shown on Thu (not locked)" on the brand page (`planDayChoices.brand.shownOn`), "Shown on Thu,
  not locked · Add moves it to Wed" in the add boxes (`planBrandRow.shownOn`) and in Put on a day's preview
  (`planAddPreview` results `shownOn`) — read from Setting `outreachShownDays` (`readShownOn`). Plan my week also
  leaves out every brand in **today's column** (pins and automatic rows, stamped or not — it used to move today's
  top picks to tomorrow on a sending morning). **Move this day to…** (skip-day; Thanksgiving, Dec 24, Dec 31 are
  Thursdays this year): a later day's ⋯ → a later day, the next off day (opens it) or "No day — take it off" →
  `moveDay` preview card in the day (each planned brand: going / waits past the 30 / can't go there and why → back
  to waiting; the category: onto a day with nothing planned the whole plan moves — category and pins in order —
  else the pins go at the end and the day's category stays behind, named; hand pins outside the target's category
  named) → **Move the day** sends the preview's `expect` (changed since = `stale`, shown again). The day goes **off**:
  Setting `outreachSkipDays` = { day: SkipLog } (`src/lib/skip-day.ts`, `node scripts/test-skip-day.mjs`), folded
  into `readExtraDays()` as `.skips`, so `isSendingKey` / `planningDays` / `scheduleDays` / `nextSendingAfter` / the
  queue rules' next sending day / the morning roll all skip it: no column, no automatic picks, Plan my week leaves it
  out, nothing is put on it (an extra day moved is closed too). The toolbar shows "Thu off · Undo"
  (`getOutreachPlan.skipDays`) = `undoMoveDay` (preview, then: the day back with its category and the brands still
  where the move put them or pinned nowhere now; ones Leo moved since stay, named; the target's category back if
  unchanged; a day the move opened closes once empty; onto a target that has since become today, those brands'
  unsent people come out of today's list — named in the confirm — a brand that sent today stays there, and today
  never closes). The move's preview judges by the calendar its apply makes (the day off, the target open —
  `planAddPreview(…, ctx)`), so a part-sent brand's sitting reads the same in both. Wherever a menu offers "(adds it as a sending day)" a day
  taken off reads "(send on it after all)" (`sdOffWord`, `planDayChoices.offDay.skipped`) and picking it reopens it
  — `openDay(key, extras)`, used by setExtraSendingDay / planAddBrands / moveUnsent / moveCarried / moveDay (its
  Undo goes; the plan that moved stays). undoPlanWeek never puts a brand back on a day taken off, and on a day that has since become today keeps a
  brand that already sent today there (its rest) and names whose people leave today's list (`stay`, `unqueue` in the
  preview, as undoMoveDay does); undoDayTheme
  refuses one. **A calendar change re-sits part-sent brands** (second review, Oct 13 2026): a day opened (or a day
  off taken back, an Undo of Move this day) between a part-sent brand's first day and the day it was pinned to for
  its rest made that day "rests two weeks" and the rest never went — `resitPinned(plan, before, after)` moves a brand
  pinned on its old second sitting day to the front of its new one, in setExtraSendingDay / planAddBrands /
  moveUnsent / moveCarried (adding a day) and moveDay / undoMoveDay; `resat` in the reply and in their previews
  (`resitPreview`; the page's `sdResatText` / `sdResatLine`). **Taking a day off re-sits too** (third review, Oct 13
  2026): Remove this sending day (`setExtraSendingDay` off — today or a later extra day) and Move this day to… with no
  target (or a pin refused at the target) run resitPinned **before** the day's plan goes, so a brand pinned there for
  its rest (carried in by the roll, or by Off queue / ×) moves first onto its new second day instead of "back to
  unscheduled", where it then rested — `restOn` / `resat`, the moveDay card's row says "the rest of its first outreach
  goes <day>", and Remove this sending day asks the server first (`setExtraSendingDay({ on: false, preview: true })`)
  so its confirm names them. The rest of a closing extra day's pins still go back to unscheduled, named — and today's
  that already sent some on their first day go first on the next sending day (pinRestOfSitting). **A preview for a move
  that opens a day reads the calendar with it open** (planAddBrands and moveUnsent with addDay: `openedDays`, the
  resat plan; `carryBrands(…, { q })`), as their applies do — it used to say "rests two weeks" for a half-sent brand
  the apply then moved. Adding: **Find a brand** box above the days (`renderSchedFind`,
  `sf*`; never redrawn, so focus and text survive refreshes): day chips (last pick in localStorage
  `sb.schedFindDay`), rows from `searchPlanBrands` = the whole roster ranked in memory by
  `src/lib/brand-search.ts` (exact → starts with → word → contains → aka → spelling slip "did you mean";
  `node scripts/test-brand-search.mjs`), then addable first, then Brand Fit; each row says what Add does on
  that day (incl. "N in today's queue — Add moves them"); ↑ ↓ Enter adds a plain add only ("Add anyway" and a
  spelling guess = click or Shift+Enter; an Enter before the rows land adds only an exact addable match, and only
  for exactly that text); a query of only dropped words ("co", "the") searches the plain name; **Paste a list**
  (`matchBrandList`; a list pasted into the box opens it for the chosen day). The day's **Fill box** = "N open
  spots · Fill to 30" + a "Suggestions" fold (`suggestForDay`; follows the day's category — no menu of its own;
  Best fit = every category, best fit first; on a category day Fill to 30 takes only that category, other
  categories listed under it with + Add). **Rows stay under the mouse** (fillbox-misclick: a quick second + Add
  landed on the next brand, or on a name): going busy only greys Fill to 30 (`sdFillBtnState`, no redraw), the
  "Adds …" line is always one line (greyed while stale), a clicked row turns "Adding…" → "Added ✓" in place and
  keeps its slot (`SCHED.adding`, `sdKeepAdding`, ~8 s after the list drops it), the + Add button has a fixed
  width, and `sdRefresh` holds the clicked row on screen (keepPlace; `SCHED.fillHit` when a redraw replaced the
  button) as the added brand's card lands above the box; tick rows → **Add N ticked** = one `planAddBrands`
  (`SCHED.fillSel`). Category drill-in with multi-select (`categoryBrands`). Moving: drag onto a
  day or "Move to" (`planMoveBrand`; moving off today un-stamps unsent people, nothing shelved). Plan
  writes go through `planAddBrands` / `planMoveBrand` / `planRemoveBrand` / `planSetCategory`.
  **Put on a day outside the Schedule** (Leo: "make sure adding brands to days is easy"): the brand
  page's Schedule line (`bpLoad`: where it stands — on a day and who goes, in today's queue, or why
  it can't — plus Put on a day / Move to… / Take off; off today also passes it for today), the
  Brands list's tick bar and Stock take's lanes ("Put on a day (N ready)", a day's worth pre-ticked)
  share one picker (`pdCtx`/`pdHtml`): pick a day → `planAddBrands({ preview: true })` shows who
  goes, what moves off another day or out of today's queue, and a warning past the day's 30 → Add
  sends exactly the previewed ids. Days = `planDayChoices` = the Schedule's columns
  (`scheduleDays`, shared with `getOutreachPlan`) + the next off weekday, which `addDay` opens as
  a sending day; `planAddBrands` refuses a non-sending day without it.
  **Best fit is the default day** (Leo, Oct 7 2026: "from now on … just put the best fit brands that we haven't
  reached out to there"; replaced the category rotation by date): a day without a category = `BEST_FIT_DAY`
  ('bestfit'; `dayTheme(cat) = cat || 'bestfit'`, `isCategoryTheme` / `autoDayRanked` in route.ts) — in getTodayQueue,
  getOutreachPlan, fillToday (hands every day to getTodayQueue), suggestForDay ('bestfit' = every category,
  fit first, Skip left out) and Plan my week (an open day stays Best fit, `source: 'bestfit'`; "Let the plan pick
  a category" = the old rules via `__pick` / `openDays: 'pick'`). **A day Leo gives a category** reads the
  whole of that category the same way (`autoDayRanked` — getTodayQueue, the Schedule's day rows, fillToday; it used
  to read only the 300 best people waiting in the pool, across categories, so a category day came up short and
  disagreed with Plan my week): never reached, best Brand Fit first, too small and out of business out like
  everywhere, but a **Skip** category still goes on its own day (Leo's default, Oct 12 2026: he chose it —
  `bestFitEligible(…, { allowSkip })`). **Fill to 30** (`fillToday`) asks getTodayQueue for every theme: whole
  brands while they fit the day's room, never a 10-person brand into 2 spots, "already" only when the day is full;
  it answers `brands` and, when spots stay open, `smallest` ("nothing in Energy fits whole — the smallest needs 4");
  a today closed by Move what's left adds nobody. getTodayQueue reads the day's ranking on a full day too, so
  Ready if you have room offers the next whole brands. Who: `bestFitRanked` / `bestFitEligible` /
  `BEST_FIT_BRAND_WHERE` — brands **never reached** (no invite, no email; a "Withdrew" doesn't count), not archived /
  do-not-email / not US / in talks / out of business, not too small, not a **Skip** category; read from brands,
  not the waiting pool (a brand with nobody queued yet is still a pick — queueBrandTargets opens it), best
  Brand Fit first; a brand already in today's list only takes its waiting people (never topped up). The menu:
  "★ Best fit — not reached yet" first, then categories grouped Top → Skip (`sdCatOptions`, from
  `getOutreachPlan.priority`). `CAT_NAMES.bestfit` is added after `CAT_KEYS` so it never files a brand.
  **The category menu replaces the day's list** (Leo, Oct 6–7: "the drop down menu sometimes doesn't replace the
  entire list so make sure that happens"): `planApplyCategory({ date, category })` previews (writes nothing) via
  `dayThemeChanges` — planned brands outside the new category (on Best fit: planned brands it would never pick),
  today's unsent queued people at other such brands, a today closed by Move what's left. Nothing to take off →
  applied at once; else the day shows a card naming each (Replace the list / Just change the category / Cancel).
  Apply sends `expect` (the preview's signature; anything changed since → `stale`, shown again), writes the
  category, unpins back to the pool (never onto the next day), un-stamps (queuedFor null, nothing shelved), reopens
  today, refills today's queue; Best fit keeps its remaining pins in fit order. Brands that sent today are never
  touched, nor a part-sent brand finishing its first sitting that day (the roll carries it there first; Best fit
  never picks a reached brand, so "Make the day match" used to take it off and rest it — `finishingSitting` in
  dayThemeChanges and the day's `offTheme`); a planned brand coming off today takes its queued people with it (named on the card). The new order of
  the pins Best fit keeps is shown before it's written ("Use this order"). Taking a brand off today (× /
  `planRemoveBrand`) also passes it for today, or Best fit would pick it straight back up. A brand in today's
  queue is never shown on a later day. Undo = `undoDayTheme` (Setting `dayThemeLast`, incl. `refilled` = who today's
  queue took in for the new category, taken back out; never re-queues a brand passed today, archived or planned
  elsewhere; preview, then puts category, pins and queued people back;
  the toolbar's "Undo" link via `getOutreachPlan.themeUndo`). `offTheme` per day = what a re-pick would take off →
  "N brands don't fit … Make the day match". **Category priority** (Setting `categoryPriority` over
  `DEFAULT_CATEGORY_PRIORITY`, `getCategoryPriority` / `setCategoryPriority`, More ▾ → Category priority… modal
  `#cp-scrim`): Top +30 / Middle +15 / Low 0 / Skip 0 and never picked by itself (a hand add still works).
  **Pass = two weeks off** (Leo, Oct 7 2026: "when i pass on a brand it should not show up in the outreach tab again for at least two weeks"): `passBrandToday` (LinkedIn card **Pass brand**, Brands not reached yet **Pass**, the Schedule's × **Not now** on any day's automatic row, brand page Take off today) sets `passedTodayAt` + `Brand.passedUntil` = now + `PASS_DAYS` (14), un-stamps today's people and unpins it from coming days; `notPassedToday()` / `passedNow()` / `notOnPass()` keep it out of Best fit, category rotation, every Schedule day's rows, the morning roll (`CarryFacts.passedUntil` → "Passed until …"), `queuePlannedToday`, Fill to 30, Plan my week, suggestForDay and nextBestBrands until then (a brand shown on a later day used to carry in and have its Pass ended by the queue). A hand add (planAddBrands, queueBrandTargets) clears it. **Off queue** (a LinkedIn row's company-wide button, `unqueueBrand`) is **today only** (Leo, Oct 12 2026): off today's plan, unsent people back to waiting (nothing shelved), `passedTodayAt` — back tomorrow. A brand that already sent someone today, on its first day, is pinned **first on the next sending day** (its one day for the rest — `restOn`, named in the toast); before, nothing ever sent its rest. The same for every way off today (second review, Oct 13 2026 — `pinRestOfSitting`): the Schedule's × (`planRemoveBrand`; the toast says "the rest of it goes out <day>", not "back tomorrow"), Move to → off the schedule (`planMoveBrand`), and closing today as an extra sending day (`setExtraSendingDay`, `restOn` in the reply). `E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-pass-e2e.js`.
  **Betting set aside** (Leo, Oct 7 2026: "put all the betting aside for now and not have them in any outreach"): `betting: 'skip'` in `DEFAULT_CATEGORY_PRIORITY` (brand-fit.ts) — never auto-picked, and nextBestBrands leaves Skip categories out; a hand add still works. Put it back with Category priority.
  **Queue rules** (Leo, Oct 12 2026: "i dont want brand i have already reached out to to be in the queue
  and i also dont want to reach out to super big brands yet"; rules pure in `src/lib/queue-rules.ts`,
  `node scripts/test-queue-rules.mjs`). **Whatever the system picks by itself** — a category day
  (getTodayQueue, the Schedule's day rows, fillToday), Best fit, Add more / the bench, the Fill box,
  Plan my week, next best — takes **only brands nobody has reached out to** (an invite ever, logged
  outside the queue or withdrawn; an accept/reply; a hand or machine email — `notReachedBefore(dayStart)`
  in SQL, `brandGate(b, q, true)` in code; the old category-day pool only skipped replied brands, so it
  re-pitched invited ones). **By hand** (planAddBrands, planMoveBrand, the brand page, queueBrandTargets,
  queueContact, Send today anyway, today's planned brands, the morning roll) a reached brand **rests 14
  days from its first outreach** (New York day keys; a later Schedule day is judged as of that day; the
  day a brand opens is its own sitting, so the rest of its people that day still go; an accept logged
  without an invite date counts from the row's last change and is never a sitting). **Part-sent brands**
  (Leo, Oct 12 2026: "If Zach sends only some of a brand's people one day, the rest go out on the next
  sending day"): by hand the sitting runs on to the next sending day after its first day (`sittingOf`,
  `nextSending` from `QueueCtx.extras` — extra days count), so the morning roll carries the rest there,
  queuePlannedToday stamps them and the gate, gatedStampBrands and the Schedule let them through — that
  one day only (a day later it rests); the 14 days then count from the sitting's last day anything went
  out. The system's own picks still never take it. The next sending day is **the calendar as it was**
  (review fix, Oct 13 2026 — sitting-history): days opened or taken off stay stored `DAY_HISTORY_DAYS`
  (REST_DAYS + 7) after they pass (`readExtraDays().past`, `wasSendingKey` in `nextSendingOf`; writeExtraDays /
  writeSkipDays keep them; every forward check still sees today on only) — rebuilt from today's list, Thanksgiving's
  day off vanished on Dec 1 and the brand carried there "rested". Machine emails count in queueBrandTargets'
  read too (`SENT_EMAIL` from plan-brands.ts), so the queue and its preview agree on a brand's first outreach.
  **Giants**
  (`giantOf` in queue-rules.ts: giants.ts — household names, the big parents' brands, $1B+ sales — or
  **1,500+ people on LinkedIn**, `VERY_BIG_LI` / `veryBigWhy`; Leo, Oct 12 2026) are held back: nothing
  picks them, and a hand add asks — **Add anyway**. **Conglomerates are never held** (Leo: "yes except
  for congomerates"; `isConglomerate` = `isParentCompany`, parents.ts: Diageo, Molson Coors, PepsiCo,
  Coca-Cola, Monster Energy, Heineken, Bacardi, Brown-Forman, Campari, Gallo on the roster) — he works them
  as one account; their brands (Smirnoff, Bud Light…) still are giants. Brand Fit's giant points use the
  same `giantOf`. **Add anyway** (`allowGiants` on planAddBrands, `allowGiant` on
  queueBrandTargets/queueContact, the giant card's button → `allowGiant`) OKs that brand for good.
  Setting `outreachGiants` = { on, ok: [brandId] }; the Schedule's toolbar line "New brands only ·
  Giants: held back (N) Allow" is `setGiantsOn` (`getOutreachPlan.queueRules`). People already stamped
  at a resting brand or held giant are **skipped, never removed** (`gatedStampBrands`: not shown, not
  counted). Reasons `reached` / `resting` / `giant` in `reasonText` + `SD_SHORT`. The LinkedIn fill
  (`liList`) reads brands already reached, then held giants (brands and research names), **last** —
  their people are ready for later, but they never take a day's visits first (`reachedLast`, `giantsLast`;
  the Schedule's brands and names Leo asked for keep their place). The email machine keeps its own rules.
  **Each brand opens with exactly its number** (picks, Leo's yes Oct 12 2026): `workPeople ?? recommendWorkPeople`
  (3, 4 at an established brand, 10 at a big company; the narrower 3/2/1 only once written to — a brand inside its
  first sitting, part-sent next day included, keeps the opening number, and everyone still waiting from it goes
  — the part-sent rule wins over the trim: `brandWork` / `finishingSitting` in route.ts). Best LinkedIn
  buyers first — `comparePicks` / `sortPicks` in `src/lib/queue-check.ts`: a title the rules don't flag → a LinkedIn
  link (an email-only contact no longer takes a slot first; it used to be email first) → partnerships > events >
  marketing = founder → person fit → email; flagged people stay out while anyone unflagged is reachable
  (`leaveOutFlagged`; "+ Person" excepted) — **flags first, then executives** (review fix, Oct 13 2026: the other
  way round a founder who was the only real buyer was dropped and the flagged staff went), and a flagged person
  already waiting in the pool or next in line is held back too (set aside next in line, never anyone in today's
  list) instead of going ahead of unflagged buyers with no target yet — only people the system pooled and nobody
  chose (second review, Oct 13 2026): never someone **chosen** for a day's list (`src/lib/chosen.ts`, Setting
  `outreachChosen` = { targetId: day }, 30 days: queued by hand — queueContact, Swap, **+ Add person** (upsertContact) —
  Send to dashboard on a profile, or put back in the pool by the morning roll so their day stamps them again,
  `carryBrands`), never while the brand
  finishes its first sitting (its rest goes whole), and only an unflagged person who could still go counts as the
  reason (people already invited don't): the hold-back set aside the person Leo queued on Tuesday once Wednesday's
  roll had put them back in the pool, and a part-sent brand's flagged rest because of the two buyers already sent.
  `readQueueCtx().chosen`; previewBrandPicks reads the same. **Chosen people go first and all go** (third review, Oct
  13 2026: `chosenFirst`): the brand's number holds only the system's own picks — it used to rank Leo's pick (a weaker
  or flagged title) last and cut them for the buyers waiting beside them, or set aside a fourth he added past the number
  once the roll carried them. Same order in queueBrandTargets, previewBrandPicks (so the Schedule's
  "3 going" is what goes), and the limit: `reconcileBrandTargets` (both copies) = `workCount` / `keepInPlay` in
  `src/lib/brand-work.ts` (`node scripts/test-brand-work.mjs`) — it used to keep at least 4, so a brand that works 3
  sent 4 and "work 1" kept 4; it keeps chosen people like today's (never next in line, counted first; both copies
  read `readChosenIds` — fourth review, Oct 13 2026: Send to dashboard's pick was set aside next in line by the
  capture's own reconcile, and a later fill or capture parked carried and hand-queued people); `updateBrand` re-runs
  it only when the number or tier really changes (the page sends its tier on every Save). A brand already holding more is
  trimmed **as it comes up** (Leo's default): queueBrandTargets promotes only its number, the rest of the pool →
  next in line (`shelvedHow 'cap'`); no bulk change, never anyone out of today's list (keepInPlay keeps today's
  stamps first); fillSize and the gated stamp stop at the number too. A queued person with no LinkedIn link: the
  add warns "no LinkedIn link yet" and the row has **Find on LinkedIn ↗** (a people search).
  **Big = measured** (big-brand-size, Oct 12 2026): `isBigBrand` (brand-work.ts) = 500+ on LinkedIn or a parents.ts
  link; an unmeasured established brand is "size not known" (works 4, 15 size points; the fill measures it sooner).
  **One big company a Best fit day** (Leo's yes): `bigFits` / `BIG_PER_BEST_FIT_DAY` in plan-week.ts, one rule for
  getTodayQueue's fill, getOutreachPlan's day preview (`fillWholeBrands(…, { bestFit, onDay })` — moved to
  plan-week.ts with `orderFillGroups`) and planWeekDays: a big one already on the day (pins going, today's list,
  sent today) counts, a second waits like a brand that doesn't fit; category days and hand adds aren't held to
  it. A big brand already in today's list (`held`) is that day's own — topped up, never refused as a second, in
  the preview as in the queue. The Fill box's **Fill to 30** follows it too (`days[].bigs`, suggestion rows'
  `big`, `sdFitPick`); a row's own + Add stays a hand add. Each day's header says "N brands" beside the invites (`sdDayBrandCount`). **Ready before short** (thin,
  Leo's default: ranked below, not held back): `compareAuto` — every automatic pick (bestFitRanked, autoDayRanked,
  orderFillGroups, Plan my week's Best fit, the Fill box's Best fit list) takes Ready brands before Thin ones,
  then Brand Fit; the LinkedIn fill can still find a thin brand people before its turn.
  **Who goes first** (Leo, Sep 2026): a day's planned brands go out in their plan order
  (`plan[day].brandIds`) — numbered on the cards, ↑ ↓ or drag a card within its day
  (`planReorderDay`). Whole brands in that order while they fit in the day's 30 (after anyone sent
  or already in today's list); one that doesn't fit **waits** (a smaller one after it can still go)
  and the morning roll moves it to the next sending day like anything unsent. The same cut is in
  the day preview (`waits` on pinned cards, not counted in the day), add results and previews
  (`waitingOnDay` — an add goes last, except a part-sent brand added to the day for its rest, which goes first:
  `secondSittingDay`, planAddCore / planAddPreview, so Move this day onto a planned day and Put on a day keep its
  deadline; a card waiting on that day says "the rest of its first outreach — move it up, or it rests until …",
  `sittingEnds` / `restsUntil`), the brand page line, and today's queue:
  `queuePlannedToday` (getTodayQueue, and after a reorder of today; `dryRun` for the brand page)
  stamps today's planned brands in order and never takes anyone out — nor tops up a brand **opened today**
  already (Setting `outreachOpenedToday` = { day, ids }: the plan, a hand add to today; a reload adds nobody: it
  used to push a 30-person day to 35, refill a Leave out and let the CEO step in). A planned brand with one person
  listed or sent before it opened (queued from its brand page, an invite logged with SB · Log) still opens up to its
  number once — the review fix, Oct 13 2026: "anyone listed or sent today" used to keep the rest from ever going;
  the Schedule's today card says so first (`pendingAdds`). One opened today whose people were all left out since
  says so (reason `leftout`, nobody more today) instead of a preview of "N going", and getTodayQueue's fill leaves
  today's planned brands to queuePlannedToday alone — on a Best fit day it reopened one with its next people (second
  review, Oct 13 2026). Executives fill a brand's count only when no non-executive there is
  untargeted or in play — `dropExecsAtBigBrands(…, inPlayNonExec)`, "+ Person" excepted). **One order for
  today** (`src/lib/today-order.ts`, `node scripts/test-today-order.mjs`): planned brands in plan order, then
  hand-adds newest first, then the fill's brands in `outreachAutoQueued` order (best first) — getTodayQueue,
  Today's list for Zach and the Schedule's today column; a reload used to list the fill worst-first. The
  LinkedIn tab names who waits (`plannedWaiting`, `waitingTo`). A waiting card on today has **Send today
  anyway** (queueBrandTargets). Adding to today still goes straight in — after today's earlier pins are
  stamped (planAddCore runs queuePlannedToday first; the preview counts them), so an add never pushes a pin
  to tomorrow; today's note says move a brand or send anyway (a reorder frees nothing there). Today's queue
  end to end (the roll's part-sent / Pass cases, one order, reloads, Leave out, Off queue, Withdrew, adds,
  ready if you have room, and the Oct 13 review fixes: the sitting's calendar, Off queue part-sent, a planned brand
  opened after a hand queue, machine emails, flags before executives, Undo onto today, Move this day's preview, a deal
  in the stamp, a held big brand, the week used up; the second review's: chosen people carried, × / Move off on a
  part-sent brand, own part-sent pins ahead of carried work, an opened brand left out, a finishing brand fits the day,
  Plan my week's Undo onto today, the day for a brand's rest, Category priority fresh; the third review's: chosen
  people past the number and beside pooled buyers, a half-sent brand planned later, a day taken off or an extra day
  removed with a brand's rest on it, previews onto a day they open; the fourth review's: Send to dashboard through
  /api/ingest at a brand with its number waiting, + Add person, a notes-only Save): `E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-queue-e2e.js`.
  **Faster page** (Leo, Oct 12 2026: "make the schedule as efficient as possible" — the same answers, fewer and
  lighter reads; at 1,500 brands getOutreachPlan ~1.1 s → ~0.33 s, its reply ~200 → ~50 KB; a refresh with an open
  Fill box ~1.6 s in two requests → ~0.37 s in one; Plan my week ~1.55 s → ~0.4 s; the LinkedIn tab's first open
  ~0.9 s → ~0.4 s): the roster loads through
  `loadPlanBrands` (`src/lib/plan-brands.ts`, home of `PLAN_BRAND_SELECT`: the nested read's own brand / contact /
  target statements, flat, its per-target contact and first-email parts rebuilt in memory — the same rows in the same
  order — `E2E_DATABASE_URL=… node scripts/test-plan-brands-e2e.js`); getOutreachPlan's other reads go
  in one `Promise.all`, `labels` only for brands on screen, no bench / runway / per-day health (unread since
  f2ffc10); parents.ts looks names up in a map built once. `stamp` on every reply; `since` = the page's last stamp
  → `{ unchanged }` (`scheduleStamp`: the day, a 10-minute tick, count + latest updatedAt of Brand / Contact /
  Target / EmailMessage / Deal and the outreach settings it reads — a setting it starts to read goes in that list; Deal
  because the stamp also decides whether a tab return reads Ready for a second try again, which drops brands with a
  deal; Category priority is read fresh with it, `loadCategoryPriority(true)` — the memo is per server, and another
  server's change came back under the new stamp with the old priorities), so a
  tab return with nothing changed reads and redraws nothing; Categories & coverage is drawn, and Coverage / What
  gets answered / an open category read, only while its fold is open (`sdCatsCatchUp`). `suggest: true` puts each
  open day's Fill box list on the day (`days[].suggest`, `suggestionsFor` = suggestForDay's answer). Quick clicks
  share one refresh (`SCHED.planPending` / `refAfter`); the category menu is one call (`applyIfNone`), Off today
  is `passBrandToday` alone, a card's Archive `setBrandPassed({ unpin })`; Plan my week hands its roster to
  getOutreachPlan (`__roster` — POST drops every `__` argument from the wire). Every /api/data reply has
  `Server-Timing: <fn>;dur=<ms>` for measuring the live site. `E2E_DATABASE_URL=… node scripts/test-schedule-reads-e2e.js`.
  **Categories chart** (Leo: "a chart that shows what category of brands we have reached out
  to and u can click on it"): replaced the tiles. One bar per category, length = brands in play
  (set aside left out), steps Replied / Accepted / Invited or emailed / Not reached (one blue
  ramp, validated as ordinal on #14141a; grey track) from `getOutreachPlan.categories[].stages`
  (`brandStage`, shared with the `categoryBrands` drill-in). Sort Most reached / Most brands /
  Least reached, a Table view, tooltips on hover and focus; a click opens the drill-in, whose
  header also gives the last invite and the 6-week accept rate (from Coverage).
  Thin / no-one brands link "LinkedIn people ↗" (`liPeopleUrl`) for the LinkedIn capture script;
  the tab checks on focus (the stamp) and redraws when a capture or anything else changed. "The rest of …" rows (past a day's 30) have
  **Add** (pins to that day; the fill makes room) and "Other day…". **Plan my week** (`planWeek`
  preview → apply, `undoPlanWeek` via Setting `planWeekLast`; the rules are pure in
  `src/lib/plan-week.ts`, `node scripts/test-plan-week.mjs`): the next 3 sending days — keeps pins
  and Leo's categories, an open day stays Best fit (highest fit first, any category, Skip left out); "Let the plan
  pick a category" gives it one that can fill it (never the day before's,
  least recently worked first, then accept rate), fills to 30 with whole brands (category →
  `RELATED_CATEGORIES` → the rest), never takes a brand in today's queue; nothing is written until
  Apply. A day's pins are counted the Schedule's way (plan-week-waits): one past the day's 30 **waits →
  <day>** and counts on the next planned day, first (it used to read "Over by 5" for a day the Schedule showed
  at 30); each day fills only to what LinkedIn's week leaves it (`counts` → `weekCap`, `days[].cap`).
  **LinkedIn weekly limit**: ~100 invites per rolling 7 days (`LINKEDIN_WEEK_LIMIT`, warns past 90 —
  `LINKEDIN_WEEK_NEAR`; a normal Tue–Thu at 30 is 90 and warns about nothing; `getOutreachPlan.linkedinWeek`) —
  top-right line + a note on any day that would pass it, saying the real choice ("this week goes over by 6; Fri
  can take 10 — take a brand off it": a later day is in the same seven days). **Extra days are sized to what's
  left** (Leo, Oct 12 2026): the system's own picks fill each day only to `weekCap` = min(30, 100 − invites in the
  6 days before it), in date order (pure in plan-week.ts; getTodayQueue `dayCap` via `todayWeekCap`, fillToday,
  getOutreachPlan `days[].cap`, Plan my week) — an extra Friday after a full week takes ~10, and the page's
  "Fill to N", open spots and "/ N · week limit" read it (`sdCap(key)`; the LinkedIn tab's Fill reads
  `SENT_TODAY.day`). Hand pins, adds and Send today anyway stay on the flat 30 with the warning (Plan my week's
  "Over by" is against the 30 too; a week used up = Fill says "LinkedIn's weekly limit leaves nothing today",
  `fillToday.weekFull` — a 0 used to read as 30 open). Opening a
  day says its room ("with room for 10", `openingRoom`: Put on a day's addDay preview, Move what's left). **Coverage** (`categoryCoverage`): categories × the last 6 weeks (Mon–Sun, New York),
  invites per week + share accepted (accepted/replied, withdrawn uncounted); 90-day accept rates
  (smoothed, cached 10 min) also order the Fill box's other categories. **What gets answered** (outcome-table,
  Oct 12 2026 — Leo: results only suggest, he approves): under Coverage, read-only (`outcomeTable`, pure in
  `src/lib/outcomes.ts`, `node scripts/test-outcomes.mjs`): the last 6 months of LinkedIn invites old enough to
  answer (accepts after 7 days, replies — a reply or a call booked — after 19 = 2 + 10 + 7, Zach's list's cadence)
  by category, company size, buyer type and people invited per brand (per brand); smoothed (5 invites of the
  average), n on every cell, "too few to tell" under 30. Suggestions name a category's priority one step
  ("accepts 1.9× the average — make it Top?", Skip never) and change it only on **Make it …** + a confirm
  (`setCategoryPriority`); Brand Fit's weights and stored fitScore are never touched. **People per brand** (Oct 18 2026 — Leo: "when we do more than 3 people do we have a higher probability of getting an acceptance"; accepts only, his call): under it, `outcomeTable.depth` (`depthTable`, outcomes.ts): each person by place in the brand's line (send order), brands by people invited the first day / in all, by Brand Fit today, and "if separate chances" (1 − (1 − p)^k at the overall per-person rate) beside them; raw rates, too few to tell under 30. **Outreach → LinkedIn** = one card per brand
  (sent people stay in their card, `getTodayQueue.sentList`; a finished brand folds to one line). **Ready if you have
  room** = whole brands (`getTodayQueue.moreBrands` + `handSpots`, `oqMoreCard`): **Add to today (N)** when it fits the
  open spots — a hand add, so against the flat 30 (`handSpots`), not what LinkedIn's week leaves the automatic picks
  (`openSpots`; the hint says when the week is what binds) — else the Put on a day picker — never one person to Mark sent (one send made the brand reached and
  stranded its rest for two weeks). Its first open of a sending day drafts everyone in one transaction
  (`ensureTemplateDrafts`, man then woman a millisecond apart; `queueBrandTargets` makes a brand's new people in one
  insert, in pick order) and Going stale asks `listTargets({ status: 'sent', sentBefore })` — the same top 200, cut
  on the server. **Brands not reached yet** (`nextBestBrands` → `renderNextBest`, `#nextbest`) sits under the queue in the main column (Leo, Oct 7 2026 — it was in the right rail, off screen); **+ Add to today** = `queueBrandTargets`.
  **Add a brand from the queue** (Leo, Oct 8 2026: "i should be able to add a brand from the queue"): the LinkedIn tab's
  add box (`#oq-addbar`) sticks just under the header (`--head-h`, measured from `.header-stick`; the rail uses it too)
  and uses the Schedule's search (`searchPlanBrands` for today: spelling slips, aka, contacts label, what Add does);
  ↑ ↓ Enter adds a plain add, **Add anyway** (already reached / nobody reachable) is a click (`force`), then
  `queueBrandTargets`; "+ Add “…” as a new brand" is always the last row.
  **Old invites** (rail card + clean-up panel; `staleInvites` = still "sent" after 21 days, by brand,
  with who the brand would try next; `markInvitesWithdrawn` preview → one transaction + a
  TargetEvent each): withdrawn on Zach's LinkedIn, ticked here. They keep `sentAt` (coverage and
  accept rates still count them; the brand stays reached) — so does the row's **Withdrew** on an invite
  from before today (since Oct 12 2026; logged "Invite from <date> withdrawn on LinkedIn"); only one
  sent today is a mistake taken back and uncounts the send. "Plan them" pins brands with someone new to the
  next sending day. A send out of the queue is always dated now (`setTargetStatus`), even on a row
  carrying an earlier invite's date. **Ready for a second try** (second-try, Oct 12 2026 — hand only, the queue
  rules still keep every reached brand out of the automatic picks): a fold under Categories & coverage, its count
  on the summary (`secondTryBrands`; rule `secondTryOf` in queue-rules.ts): reached before, nobody accepted,
  replied or said no, no deal, the 14 days over, not set aside / a held giant — and a buyer there the first try
  didn't invite (previewBrandPicks as if its old invites were withdrawn), best Brand Fit first. An invite still
  out 21+ days → **Log it withdrawn…** (markInvitesWithdrawn, previewed) first; one under 21 days keeps the brand
  off (it may still be accepted). Then the usual Put on a day picker (planAddBrands preview → Add).
- **Brand Fit** (Leo, Oct 2026: "a filter process to determine which brands we should reach out to").
  Rules pure in `src/lib/brand-fit.ts` (`node scripts/test-brand-fit.mjs`), computed on the fly (never
  stored; `Target.fitScore` is the per-person score, a different thing). Score 0–100, every point with a
  reason: **money weighs most** — annual sales or venture money, whichever
  says more ($5M+ raised = "a lot"; a round in the last 2 years adds); **money to spend, not too big** (Leo, Oct 12
  2026: "i want brands to have money to spend but not be too big"): sales **$10M–$500M = the sweet spot** (40),
  $1M–$10M 22, $500M–$1B 24, a **giant** (`giantOf`, giants.ts — household name, big parent's brand, $1B+) 8 whatever
  its money says, $500M+ raised 24; no money known → LinkedIn size (`brand-size.ts`) stands in — **mid-size 20–499 = 26** (a guess stays under real money),
  500+ = 18, unknown 15, under 20 = 6; then **Leo's category priority** (Oct 7 2026: betting, alcohol, drinks,
  nicotine, electrolytes Top +30; clothing, athletic, tech, AI, fintech Low 0; the rest Middle +15; Skip = 0 and never
  auto-picked; `priorityOf`, editable per category — replaced the flat 18–24 bonus, so a Top brand with money
  unknown beats a Low brand with $50M raised, and only a $100M+ Low brand beats a tiny Top one), already sponsors
  college / music (15), people we can reach (10), the category's 90-day accept rate (5); while sales aren't known the stronger of funding and the size
  estimate counts (a parent company's brand keeps the parent's size). **Ruled out** = confirmed not sold
  in the US only (Leo's one hard no): nobody there is ever queued or emailed — `SOLD_IN_US` guard in
  `NOT_IN_CONVERSATION` (the rotation's pool), `fillToday`, `nextBestBrands`, today's list, the email
  machine (`draftDailyEmails`); `queueBrandTargets` refuses (`notus`, even a click), `outreachGate` /
  `planRefusal` / `queuePlannedToday` skip it, category drill-in sets it aside. To reach out, change "Sold
  in the US" on the brand page. US unknown = kept, tagged "US?". Out of business / acquired (`bizNote`) only go on suggest Archive — Leo decides. **Too small** =
  sales under $1M, or (sales not known) under 20 people on LinkedIn **measured** — a size guessed from tier
  never hides, and a brand with a parent company (`parentOf`) is never small by its own page. **Hide too small**
  is one per-browser switch (`HIDE_SMALL`, localStorage `sb.hideSmall`, on by default) on Brands, Stock
  take, the Fill box and Plan my week (the Brands roster table asks `listBrands({ fit: true })`, has a
  Fit column and a "Best fit first" sort, and hides rows the server flags `hideSmall` — too small and
  untouched, the same rule as Stock take; a search still finds them; New from LinkedIn never hides; `brandStock`, `suggestForDay`, `planWeek` take `hideSmall`); it
  only hides brands nobody has contacted (invited, emailed or replied). `compareOpenBrands` puts the
  higher fit first after the contacts label (replaced "small brands first"). Facts live on Brand
  (`salesCents`/`fundingCents` **BigInt** cents — `src/lib/bigint-json.ts` makes them JSON numbers and is
  imported by every API route; `lastRoundAt`, `usStatus`, `sponsorsCollege`, `sponsorNote`, `bizStatus`,
  `acquiredBy`, `researchedAt`, `researchNote`); edited on the brand page (`updateBrand({ facts })` — the
  page sends only the facts Leo changed; same parser as the import; it stamps `researchedAt` once money
  and college / music are both known). **Research** ("Claude researches once"):
  `researchList` (the Schedule's next 2 weeks first, `scope:'more'` = the rest by fit; skips brands
  researched in 90 days) gives text to paste to Claude; Claude can also pull it with
  `node scripts/cc.mjs researchList` and put findings in with `researchStage({ rows })` (a Setting only,
  `researchStaged`; rows join a batch Leo hasn't reviewed, a brand's newer row replacing its older one);
  Leo reviews on Stock take → Brand Fit (each from → to, ticked; a ticked brand with nothing new is
  marked researched; Dismiss = `researchDismiss`) → `researchImport` apply writes only what he saw: the
  page sends the batch stamp (`stagedAt`) and each brand's change signature (`expect`, `changeSig` =
  [field, value now, new value] — a hand edit after the review counts as a change), and anything that
  changed since is skipped, named, and left waiting in the batch. Rows match by id, else exact name / aka
  (`researchMatcher`); a brand listed twice — the later row wins. One transaction, Undo `researchUndo` (only fields
  still as the import left them). Never write facts without that review — the one exception is a brand the "Add a
  brand" chat makes, where Leo sending the brand is his yes (Oct 18 2026) and the card it shows after names every fact written. **Suggest Archive**
  (`fitArchive` preview → apply, Undo `fitArchiveUndo`; Setting `fitArchiveLast`): confirmed not US,
  closed/acquired, or researched with every signal known to be absent (sales AND funding looked up and
  under the bars, no college / music found, not a Top category) and a low score; never a brand in talks (reply, deal,
  activation); apply = the usual archive (passedAt + queued people shelved) and takes them off upcoming
  Schedule days. Tests: `test-brand-fit.mjs`, `test-stock.mjs`, `test-brand-fit-ui.js` (page, fake
  /api/data), `test-brand-fit-e2e.js` (real handlers, throwaway Postgres:
  `E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-brand-fit-e2e.js`); GitHub Actions
  **Brand Fit** runs them.
- **Outreach lists** (Leo, Sep 2026: "the list i have planned out so i can send to zach for approval" +
  "a list of companies and the number of people i reached"): **Plan for Zach** / **What went out** buttons
  on Outreach → LinkedIn's header and the Schedule's top row open one window (`olOpen`, `ol*` in app.html)
  that only builds text to copy — **Leo sends it himself** (his call; no email, no approve button). Plan =
  the Schedule's days read fresh (`getOutreachPlan`; `olPlanDay`: pinned brands going + the rotation's
  rows, and on today the invites already sent (`sentPeople`), noted as sent; a brand that waits is named,
  a blocked one left out), day chips tick days in/out; a later day with automatic rows reads "(not locked)" in the
  text, and **Lock these days** pins the ticked days' rows (lock-days, under Outreach → Schedule; "Locked … · Undo"
  in the window). What went out = `sentByCompany({ from, to })`:
  LinkedIn invites dated in those New York days, any status (the LinkedIn tab's "sent today" count;
  a same-day Withdrew clears the date, an older one keeps it), by company in send order — **LinkedIn only** (his call); Today / Yesterday /
  This week / Last week or typed dates. `node scripts/test-outreach-lists.js`.
- **Brands → Stock take** (`brandStock` + `src/lib/stock.ts`; deep link `app.html#stock`; linked from
  Home → Categories) — the whole roster in one read, every brand in exactly one row. **Leo's lanes are
  real categories** (his yes, Sep 2026): `electrolytes`, `energy`, `rtd` (beer/seltzers/canned
  cocktails), `spirits`, `athletic` split out of the old broad `beverage` / `alcohol` / `apparel`,
  which keep what's left (Soda, Water & Other Drinks / Alcohol (other) / Clothing & Fashion);
  `nicotine` = pouches. The vocabulary lives in `CATEGORY_KEYS` (route.ts), `CAT_NAMES` (app.html),
  `category-hints.ts`, `LI_HOOKS`, email `CATEGORY_ANGLES` and li-capture `INDUSTRY_FITS` — a new
  category needs all six. `placeBrand` only ever sorts brands out of the old broad buckets (`SORTABLE`:
  beverage, alcohol, apparel, wellness, nightlife, unresolved) by known name, then words; a specific
  filing is never second-guessed. **Re-file**: `refileCategories` previews every move (+ planned
  Schedule days whose category splits, `remapPlanDays`); apply moves only ticked moves a fresh preview
  still makes the same way, one transaction, logged in Setting `categoryRefileLast`;
  `undoCategoryRefile` puts it back. Brand state: deal > off (archived / do-not-email) > replied >
  reached > has people > needs contacts. Priority lanes carry ideas (known names not on the roster
  under any name or aka) that add through `addBrandsBulk`'s preview, filed under the lane.
  `LANE_GOAL = 15` in play per lane. `node scripts/test-stock.mjs`.
- **Brands → All brands = the one roster table** (Leo, Oct 2026: "aggregate all the brands … make sure
  we have sufficient contacts for each brand"; `brRender`, `BR_*` in app.html). Kept lean (Leo, Oct 2026: "too
  much going on"): search + one **More ▾** menu (Brand Fit, SponsorUnited worklist, Lanes & re-file,
  Duplicates, Fill summaries — same ids `bq-*`), one **category dropdown** (`brCatSelect`, `data-brcat`;
  the chip row is gone), filters on one line, archived hidden by default. One row per brand:
  Category · Tier · Fit · **Buyers** (the edit row shows everyone else on file). **Buyers** = people on file
  whose title is partnerships/sponsorship, events/experiential, marketing/brand or founder/CEO
  (`src/lib/buyers.ts`, counted in `listBrands` → `buyers`, `buyerPeople`; `node scripts/test-buyers.mjs`);
  a brand is covered at **1** (`BR_TARGET`, Leo's call). Filters All / Needs people / Has enough,
  Hide too small, Hide archived, sort (fewest buyers first by default), search by name or aka. A row opens in place:
  category, tier, website, LinkedIn page, aka, notes save on change (`updateBrand`); **Add a person**
  (`upsertContact`); the name opens the brand page. The tick bar (re-file, Put on a day) is unchanged.
  Stock take (lanes, ideas, re-file) and Needs contacts (SponsorUnited worklist) left the sub-tabs and
  are header buttons; their views and deep links still work. `node scripts/test-brands-table.js`.
  **Every brand a buyer** (Leo, Oct 2026: "how can we get all brands … to have sufficient contacts"):
  the card at the top of All brands (`renderCoverage`, `cv*`). **One line** (Leo, Oct 12 2026: "clean up the brands tab"): bar, this
  week, and only the buttons that need someone (Start the fill ↗, Pick N LinkedIn pages →, N for Zach to read →);
  **Details ▸** (`CV_OPEN`) opens the per-reason rows, the last run and the People on file fold (`#fill-progress`,
  hidden while folded); a run that needs a look (idle / old script) shows while folded. The table has no Edit
  column (the row or its ▸ opens it), Select all is the header's tick box (`bbAllBox`), Clear sits in the tick
  bar, and the note under a name is one short grey line (the long story in its tooltip). Counts are of brands **in play** (archived /
  do-not-email are "off" and never need anyone — the header, Needs people and the card all say so). Each
  brand with no buyer is in one state (rules pure in `src/lib/coverage.ts`, `node scripts/test-coverage.mjs`;
  DB side `src/lib/coverage-db.ts`; `listBrands({ coverage: true })` → `cover` per row, so a count and
  the rows its **Show them** opens are one list): **next** — the LinkedIn fill reads it next (Start the
  LinkedIn fill ↗; "about N days" at `LI_PER_DAY` = the script's DAILY_CAP); **page** — on "Which LinkedIn
  page is theirs?" (Pick their pages → Outreach → People's card); **resting** — read, nobody with a buyer title (since 1.38 a clean read has no day back — "read in full" on the row;
  a stuck issue or a no-page read: "back on the fill <date>", a month on; the fill's note); **zach** — LinkedIn hid
  their buyer-looking people from Leo's account (li-hidden.ts; "Read on Zach's LinkedIn"); **noPage** — Leo said
  None of these and there's no parent; **full** — 25 on file, none a buyer. Same rest rule as the
  worklist (`liRestsNow`, li-sweep.ts). Needs people splits by these reasons (`BR.why` chips); rows that
  need Leo say why under the name (`brCoverLine`). `buyerCoverage` adds people added this week by source,
  brands that got their first buyer this week, and the fill's last run (idle 36 h+ or an old script →
  amber). The "People on file" card (`renderFillProgress` — brands with anyone on file, the SponsorUnited
  sweep) is folded to one line under it (`FP_OPEN`).
  `node scripts/test-coverage-e2e.js` (real handlers, throwaway Postgres).
- **Daily Claude brand hunt** (Leo, Oct 2026: "a process for Claude to find new brands … it shouldn't
  necessarily be through LinkedIn"). Routine "Discover: daily brand hunt" (5:52 New York) wakes the cloud
  session "Brand hunt (daily)" — repo attached, `REPORT_TOKEN` in its environment; a fresh empty session
  gets its call blocked by the safety check, and the old Cowork routine had no token (both paused);
  subscription, no API spend) searches the open web (launch / funding news, sponsorship
  announcements, retailer shelves, trend coverage) and posts to `/api/discover-ingest` (Bearer
  `REPORT_TOKEN`; the old body `token` = INGEST_TOKEN still accepted). `GET` = lanes, `leftToday`, every
  known name (brands + aka + earlier finds; names only) + `sources` = Leo's sites to search first
  (`HUNT_SOURCES`: bevnet.com, brewbound.com, frontofficesports.com, cpglatest.com — add one there). Rules pure in `src/lib/claude-hunt.ts`
  (`node scripts/test-claude-hunt.mjs`): **priority lanes only**, a website or source link (LinkedIn
  page optional), at least one sign — `sponsors` college/music, `genz` 18–24, `midsize` growing —
  never a known brand, **never a giant** (Leo, Oct 6 2026: `src/lib/giants.ts` — household names, brands of the big parents in parents.ts, $1B+ sales via the row's `salesUsd`; GET sends the list as `reject`; the LinkedIn lookalikes skip them too, plus 1M+ followers — roster brands are untouched), **50 a rolling day**. A failed save answers 500 with the database's reason. Rows land on Brands → Discover under "Claude hunt · <date>"
  (sign tags + Source ↗) for Leo to Add / Dismiss; it never makes a Brand itself.
  **Brands → Discover** (Leo, Oct 2026: "more simple and clean"; `loadDiscover`/`dcRender`, `DC` in
  app.html): one list — To review / Added tabs, a source dropdown (Claude hunt / LinkedIn / Research
  list / Search, from `listDiscoveries`' `source`) and a category dropdown; one row per brand (name,
  category · source, sign tags, the why on one line) with **Add** and **×**; a row opens for the pitch
  and links (Source, Website, LinkedIn, SponsorUnited). The old "describe a niche" search box is gone
  (it needed paid API calls). **Every find is scored and graded** (Leo, Oct 12 + Oct 15 2026: "grade each brand that is found in the
  discover brands" … "have a score presented for each of the brands that i have to accept or deny"; `src/lib/discover-grade.ts`
  + `src/lib/find-evidence.ts`, `node scripts/test-discover-grade.mjs`). A find not on the roster gets the **find score** (0–100,
  every point with a reason): category priority (Top 25 / Middle 12 / Low 0) + what its write-up proves, read by rules
  (`readFind`, no model call) — sales in the $10M–$500M sweet spot 25 ($1M–$10M 12, $500M–$1B 10) or raised $5M+ 20 / $1M+ 10
  (a parent named or a giant = 0, too big for now), stores (1,000+ 15 / 300+ 10 / fewer 5 / "growing" sign 6, +5 for a big
  retailer named), already pays for college / music (official partner, licensed, NIL, sponsor, tour, festival 20 · the hunt's
  sign 12 · only popular with students 6), growing fast 10, 18–24 sign 5. A find on the roster grades on its brand's own Brand
  Fit. Letters **A 65+ / B 50+ / C 40+ / D** (Skip / not US / closed = D, too small caps at C) — on Oct 15 the 171 finds split
  ~17 / 52 / 63 / 39 (Brand Fit alone had made 137 of them A). The page: a score box per row (number + letter; a click opens every
  point), the points as chips under the why, big **Accept** / **Deny** buttons (`addDiscoveredBrand` / `dismissDiscovered`), a
  heading per grade under **Best grade first** (default; Newest first) and a grade filter. **Add all A's** (Leo, Oct 13 2026 — 88 of 106 waiting finds were A): the To review bar's button (`dcBulkOpen`,
  `#dc-bulk`) → `addDiscoveredBulk({ grade: 'A' })` preview = every A waiting, each as it'd be filed (`discoveryCategory`,
  same as one Add), and the ones held back because they may already be on the roster (chat-add's `matchRoster`: name /
  aka, LinkedIn page, website) — and any other find with a held one's name / website / LinkedIn page (`sameAs`) → ticks
  → Add sends the preview's `expect` + ticked `ids` (one transaction through `promoteDiscovery`, the single Add's own path).
  Finds that are one brand (same name, website or LinkedIn page, in the batch) share a `group`: the best scored names
  it, the others "same brand as …" join it and fill its empty links. A stale answer reopens it with Leo's unticks kept
  and anything new unticked. Undo for a day on the bar (`listDiscoveries.bulkUndo`; `undoDiscoverBulk`, Setting
  `discoverBulkLast` with each brand's `stamp` = its updatedAt after the add): a brand goes only if nothing touched it —
  no edit (updatedAt moved: facts, notes, a merge into it, the fill saving its page), Show Board code, partner record,
  people, outreach, deal, show, activation, document, board visit or request, ops mail, Schedule day; touched ones stay,
  named. Every find linked to a brand that goes returns to To review (also those linked by name since). Confirm sends
  the preview's `expect`; the delete only takes brands still bare (else `stale`, nothing changes). `node scripts/test-discover.js`,
  `E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-discover-bulk-e2e.js`.
- **"Add a brand" chat** (Leo, Oct 2026: "send a picture of a brand from instagram or type in a name
  and it will find the brand … and add it"). A saved Claude cloud session ("Add a brand", repo attached,
  `DASHBOARD_TOKEN` in its environment — no API spend) follows `docs/add-a-brand-chat.md`: reads the
  screenshot / name, `brandLookup`, researches the open web (site, LinkedIn page, what they sell, money,
  college / music), previews `chatAddBrand` (rules pure in `src/lib/chat-add.ts`: possible matches by
  name / aka, LinkedIn page, website — the Duplicates signals; `node scripts/test-chat-add.mjs`) and applies.
  **Every brand Leo sends is a yes** once real information is found — its own website or checked LinkedIn page, and
  what it sells (Leo, Oct 18 2026: "every brand Leo sends is a yes when real info is found. Ask only when it might
  match a brand already on the dashboard"); no info → nothing added, the chat says what's missing. Brand
  `source: 'chat'`, notes say where it came from. A possible match stops the chat to ask; apply refuses it unless Leo
  says it's a different company (`notSame`; an exact name never). After adding it shows Leo the card with every fact
  and the link; a fact he corrects is fixed on that brand alone (`updateBrand({ brandId, facts })`).
  **Facts: Leo sending it is the review** (Oct 12 2026: "my yes is the review, so skip Stock take"; Oct 18: the send is
  the yes): the preview returns `facts` = each fact as it'll be written (`factChanges` against a blank brand,
  `{ label, value }`), and apply (with the preview's `expect`; other facts are refused) writes them onto the
  brand it makes in the same transaction (+ `researchedAt`; `factsWritten`). Never onto a brand that was already there — those still go to `researchStage`. It can't
  sign in to SponsorUnited or LinkedIn — the LinkedIn fill and SU sweep pick the brand up from there.
- **One brand per parent company** (Leo, Oct 8 2026: "make all of the brands under Diageo one big brand on the site and
  move all of the contacts there"): `combineParent({ parent })` previews (writes nothing) every brand `parentOf` puts under
  that parent in `src/lib/parents.ts` → one brand named for the company (the one on the roster, else a new one: the
  brands' most common category, established, LinkedIn page from Setting `liParentPages`). Apply (`confirm` + the
  preview's `expect`, else `stale`) moves contacts, targets, deals, shows, documents, activations, board visits,
  requests, ops mail and Discover rows in one transaction; the company's aka gets every name and spelling of the brands
  that went in plus every brand parents.ts lists for it (so a capture, paste or the research list under "Ketel One"
  finds Diageo), and **nothing that describes one label** (about, products, website, its LinkedIn page, headcount,
  facts) lands on the company — unlike `mergeBrands`. **The same person under two of them is merged** (Leo: "merge if two
  people appear" — `planSamePeople`/`applySamePerson`, below). Named, never fixed by itself: an aka that's another company
  (Crown Royal's coffee-shop page), LinkedIn pages not kept. Refuses a show / partner /
  board code on two of them. Past the company's number (10, or Leo's Work number) the people waiting become next in
  line (`shelvedHow: 'cap'`), never anyone in today's list. Undo `undoCombineParent` (Setting `parentCombineLast`):
  same ids, everything still on the company goes back; the company is deleted only if it was made by the combine and
  nothing new landed on it. A parent company has no parent itself (`parentCompanyOf` → `parentOf` null), so a
  combined Diageo never refuses people on its own labels as "sister brands". No button: Claude runs it with
  `node scripts/cc.mjs combineParent '{"parent":"Diageo"}'`. `E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-combine-e2e.js`.
  Done for **Diageo** Oct 8 2026 (13 brands, 36 people; Setting `parentCombineLast` holds its Undo).
- **The same person twice at one brand** (Leo, Oct 8 2026: "merge if two people appear"; rules pure in
  `src/lib/same-person.ts`, `node scripts/test-same-person.mjs`): same LinkedIn profile, the same full name (2+ words), or
  the same personal email with names that agree ("R. Zalis" / "Rachel Zalis") — never when both rows have different
  emails, never through a **shared inbox** (partnerships@, info@… `isRoleInbox`), never a pair Leo marked **Not the same
  person** (`notSamePerson({ ids, undo })`, Setting `peopleNotSame`); a different LinkedIn link alone never separates them
  (Ari Anderman changed his). The row whose outreach got furthest stays (`targetRank` / `targetBeats`: replied >
  **declined** > accepted > sent > dead > withdrawn > passed > drafted > queued — a "no" is never replaced by a waiting copy,
  a live invite beats a copy gone cold by email, and a pass vs a queued copy goes to the later of the two; then the one
  with a LinkedIn link, then the newest); it takes what it's missing (email, phone, city, links, SponsorUnited id) and
  notes everything that didn't fit (another title, name, link, phone, city, id). Two outreach rows become one: the
  further stays and takes the other's missing fields (invite date, DM, call, Leo's note — notes joined; never its
  Zach's-list "Not needed", `handSkippedAt`) plus its drafts
  (dated just before its own, so its own stay newest), emails and history. Brand page: "X is on file twice — Merge…"
  (`getBrand.samePeople`, `#b-same`, `openSamePeople`) → each person with a tick, what stays / goes (name, title, email,
  link, status) / takes, **Not the same person** (two rows) or **someone else** on one row of three+ (`one`) → Merge
  ticked (`mergePeople({ brandId, confirm, expect, only })`, stale-checked), "Merged … — Undo" for a day, shown even
  while others still wait (`undoMergePeople({ brandId })` = that brand's newest merge; Setting `peopleMergeLog`, the
  last 50 merges, advisory-locked; same ids back; **a field edited since the merge stays**, named in the preview as
  `staysAsIs`; `undoCheck` refuses a kept row that's gone or a copy already back). combineParent runs the same merge
  after its move (its `expect` covers who'd be merged) and its Undo puts them back first — and every later Merge… on
  the company that touched rows the combine moved (those log entries go with it).
- **Brands → New from LinkedIn** (chip after All; `listBrands({ category: 'new' })`, count from
  `categoryReach.newFromLinkedIn`): brands the LinkedIn run added itself (`source` linkedin-discover /
  research) in the last 14 days that nobody has looked at. Tick → **Keep** (off the list, nothing
  changes), **Archive…** (named first; same as Archive: passedAt + queued people shelved, one
  transaction) or re-file with the usual bar — each leaves the list (`reviewNewBrands`; looked-at ids in
  Setting `newBrandsReviewed`). **Brands → Duplicates** (`findDuplicates`, rules in
  `src/lib/duplicates.ts`, `node scripts/test-duplicates.mjs`): the same name / also-known-as, LinkedIn
  page or website — never an email domain (parent companies share one; Leo's call), and a website 4+
  brands share or a platform link (linktr.ee, Instagram…) is no signal. Suggestions only: Merge runs the
  brand page's `mergeBrands` preview + confirm (the keeper now takes the merged brand's names as
  also-known-as); **Not duplicates** is remembered per pair (Setting `dupNotSame`).
- **Sign-in** (`src/lib/auth.ts`): founding list = `ALLOWED_EMAILS` in Vercel (can manage Operations → Team) +
  the `AllowedEmail` table (added on Team). A turned-away sign-in is kept (Setting `signInDenied`, last 20) and listed
  on Team under "Tried to sign in" with **Add** (founding members only); `/signin` says what went wrong by error code
  (Oct 8 2026 — every error used to read "doesn't have access"): AccessDenied names the address Google gave
  (`?email=`; a Workspace alias signs in as its main address), OAuthCallback/OAuthSignin/Callback = Google didn't
  finish (try again, or the sboyagency.com Google admin blocks the app), Unavailable = the list couldn't be read.
- **+ Add brand → Person** (Leo, Oct 12 2026: "sometimes we want to send the show board to individual people"):
  the Add box has a Brand / Person switch (`nbSetKind`, `NB_KIND`). A person = `Brand.kind = 'person'`
  (`createBrand({ kind: 'person', name, email, phone })` → `addPerson` in route.ts): archived + do-not-email from
  birth (so every outreach path skips them), no category, board code minted, email / phone on a Contact (no
  Target); a name already on file is refused. Left out of `listBrands`, `categoryReach` and Coverage (`categoryCoverage`); found by search and
  on Show Board → In talks ("· person"). Their page (`.b-person` on `#brand-body`) leads with Show Board access
  open; Schedule / Brand Fit / outreach buttons hidden. **This is a person…** / **It's a brand, not a person** on
  the brand page = `setBrandKind` (preview, then `confirm`; to person also archives, shelves queued people,
  do-not-email; back only drops the mark). `node scripts/test-add-person.js` (page),
  `E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-person-e2e.js`.
- `src/app/api/data/route.ts` — every server function. Add a handler = add a key to `handlers`. Arguments named
  `__…` are the server's own (`__user`, `__roster`) and never taken from a request; replies carry `Server-Timing`.
- `src/app/api/ingest/route.ts` + `scripts/sponsorunited-capture.user.js` — SponsorUnited contact
  capture (INGEST_TOKEN-gated, CORS-open). **Two different caps, don't confuse them:**
  `CONTACT_CAP_PER_BRAND = 25` (ingest + `importContacts`) is how many people we keep *on file* per
  brand — under 25 a brand imports whole, at 25 it stops taking new rows; best titles first, nothing
  existing is removed. `TARGET_CAP_PER_BRAND = 4` is how many we keep *in the queue* per brand — **10 at a big
  company** (Leo, Oct 7 2026: "for bigger brands we should expand the limit to 10 a day"; `isBigBrand` = 500+ on
  LinkedIn measured, owned by a parent in parents.ts, or that parent itself (`isParentCompany`) — an established
  tier alone no longer counts (Oct 12 2026); shared by both routes in `src/lib/brand-work.ts`;
  `BIG_BRAND_WORK` in brand-size.ts; the limit itself is now each brand's own number (`workCount`), not at least 4; a cold big brand opens with 10 (`recommendWorkPeople`), its contacts label needs
  10 (`workNeed({ big })`), the brand page's Work menu goes 1–4, 6, 8, 10). People past the limit are **next in line**,
  not shelved (Leo: "people should only be shelved if they're actually shelved"): `Target.shelvedHow = 'cap'` (set by
  `reconcileBrandTargets` in /api/data and /api/ingest) reads "next in line" / **Queue now** on the brand page and comes
  back by itself when a spot opens; `shelvedHow` null = set aside on purpose (Shelve, Archive) — "shelved",
  never revived alone. `markCapShelved({ preview, before })` labelled the rows shelved before this existed.
  `importContacts({ rows, source: 'research' })` = people Claude found on the open web (each row's `notes` says where). The sweep's
  worklist (`action:'list'`, scope `thin`, emptiest brand first) is every brand under the contact
  cap — it used to be brands with zero contacts, which permanently skipped any brand whose first
  capture found one or two people. Old userscripts sending scope `missing` get `thin` too. A brand
  whose last visit added nobody **rests 14 days** (Setting `suSweepLog`, `isResting` in
  `src/lib/su-match.ts`) so emptiest-first doesn't reopen the same stalled brands every run; the
  script expands the contacts list (scroll / "load more") before reading it. Profile lookup
  (`needProfile` → `matched`, and the Brands → Find search) reads only profile links that appear
  after typing into their search (the dashboard's own cards are not results), first line = name,
  Property results dropped; `node scripts/test-capture.js` covers it. Proposals from script ≤4.1
  have no `v` and stay hidden (`PROPOSAL_VERSION`). Lookup calls must send `reader: 2`
  (`LOOKUP_READER`, script ≥4.4); older copies get a 426 "out of date — Check for userscript
  updates". The SB menu shows the version (`SCRIPT_VERSION`, keep = `@version`). The review list (**Brands → Clarify**, its own tab,
  deep link `#clarify`; "Which SponsorUnited page is theirs?") only shows brands with something to pick: a search
  with no results answers `none` and parks nothing; only pages whose name could be the brand are kept or offered
  (`resemblesBrand`, su-match.ts — at intake and in `suMatchQueue`), and a page saved on another brand is never
  offered (Oct 2026: the lookup parked SponsorUnited's own tiles for every brand, and Use this put Halfday on Notion). **None of these** remembers the pages turned down per brand (Setting
  `suRejected`, `candidatesToOffer`) so a later lookup can't offer them again;
  `node scripts/test-su-match.mjs`.
- `scripts/linkedin-capture.user.js` — **LinkedIn People capture** (second Tampermonkey script, same
  INGEST_TOKEN, kept in GM storage; requests go via `GM_xmlhttpRequest` because LinkedIn's CSP blocks
  page fetches). Leo's calls (Sep 2026): **Leo's LinkedIn account, never Zach's** (Zach's sends the
  connection requests; Zach's browser has only `linkedin-log.user.js` — Leo: "get rid of everything but
  the logging people on Zach's LinkedIn"); buyer titles only, **inside the same 25 cap**; no emails — people go to the
  LinkedIn queue (`source: 'linkedin'`, target created, `reconcileBrandTargets` applies).
  **Who's a buyer** (`isBuyer`, li-capture.ts; stricter since Oct 2026 after the Sep 30 run let in ~1 in 6
  wrong people): never students / new grads / a headline that's only a school, store staff, a firm or
  board seat (ventures, capital, growth equity, board member — `OUTSIDE_FIRM`), investors / advisers /
  partners / consultants unless the title also says founder/CEO or names the brand (`OUTSIDE_SOFT` —
  "Founder, CEO, Advisor, Investor" is the founder), HR's "people partners", campus recruiting,
  wholesale, creators (`STUDENT`/`STORE`/`OTHER_JOB`), nor "CEO of <another company>" on the brand's page
  (`leaderElsewhere`, given the brand's + parent's names). A brand with a parent never takes someone
  whose current title names a **sister brand** (`siblingNamed`, parents.ts — `brands` + `others` lists;
  "Bacardi"/"Campari" = the company, never held against a sister; "ex-…" ignored). **Clean-up**
  (top of Outreach → People, `liCleanup` preview → apply, `liCleanupUndo`; Setting `liCleanupLast`):
  saved LinkedIn people at brands in play that these rules now leave out (`whyLeaveOut`), grouped by
  why, all ticked; **never anyone written to** (invited/emailed/DM'd — counted as kept); plus roster
  brands that sell sponsorships (`looksLikeSeller`: league / association / sports management…, or a
  Spectator Sports discovery note) offered for Archive. Apply = only ticked ids a fresh preview still
  lists, one transaction, freed slots reconciled; Undo recreates them.
  **By hand:** on a company's People tab the SB pill scrolls the whole list (≤150 people,
  human-paced), then opens the tab's "marketing" and "partnerships" views itself (`HAND_PASSES`; state
  in sessionStorage `sbLiHand`, picked up on each load by `handHere`; a `?keywords=` view Leo opened is
  read alone), merges them (one row per profile) and posts one `action:'liPreview'` (nothing saved; verdicts add/full/dupe/elsewhere/
  notBuyer), then `liCapture` on "Add". Brand match: `brandId` → typed name → saved
  `Brand.linkedinUrl` slug → page name/aka. A brand the dashboard lacks can be **added from the
  panel** ("Add … as a new brand" → `createIfMissing`; category guessed from name + page name +
  LinkedIn industry via `src/lib/category-hints.ts`). The page is saved fill-if-empty unless
  another brand has it.
  **By itself** (Leo asked for it after the one-click version worked, knowing LinkedIn restricts
  script-like browsing): pill → "Fill brands by itself" (also in the Tampermonkey menu). Worklist
  `liList`: brands under 25, not archived/do-not-email, not resting; **first the brands the
  Schedule has on its coming days that are short on people** (plan pins from the last week +
  Setting `outreachShownDays`, written by `getOutreachPlan`; short = reachable < `workNeed`, the
  same rule as the Schedule's labels; soonest day first; `src/lib/planned-first.ts`,
  `node scripts/test-planned-first.mjs`; the Schedule's contacts check links "Start the LinkedIn
  fill ↗ — it does these first"), then (after any name Leo asked for, `RESEARCH_EXTRA`) **every brand
  with no buyer on file** (Leo, Oct 2026 — `noBuyerFirst` in `src/lib/coverage.ts`; items carry
  `noBuyer`, the reply `noBuyer` = how many; script ≥1.28 says so in the setup panel, the run's
  progress and `whyItem`), then the rest; within each group a focus word
  (`focusTerms` — "electrolyte" expands to the hydration shelf by name), then **by size** (Leo, Oct 2026: "classify
  mid-sized brands as target brands and do those"; `src/lib/brand-size.ts`, `node scripts/test-brand-size.mjs`):
  target brands → the research list → size unknown → small → big, emptiest first within each. Size =
  `Brand.liMembers` (the People tab's "N associated members", saved by every fill read and hand scan of the
  brand's own page, never a parent's; small < 20, target 20–499, big 500+), else a known parent → big, else
  tier (growth target / emerging small; established is a guess → unknown since Oct 12 2026, so it's measured
  sooner), else unknown. `liList` items carry `size` +
  `members`; the setup panel shows the counts, `whyItem` names the size. Per brand:
  no page → LinkedIn company search → `liMatched` (`decideCompanyMatch`: exact name/aka **in an industry
  that fits the category** — Native the deodorant had a home-care agency's page — most followers wins,
  so it's never just the first result; or a near miss only in the top 3 with a fitting industry; else
  "unclear" → skipped and put on Leo's list, below), then the
  People tab, then its "marketing" and "partnerships" views — **always** (Leo, Oct 2026: "make sure all
  partnerships/marketing people are accounted for"; a stalled scroll looks like the end), skipped only when the
  whole list showed nobody or the brand is full; `seen` counts each person once across views. **Big companies** (the tab's
  "N associated members" ≥ `BIG_COMPANY` = 100): not read whole — Leo, Sep 30, after the 1.17–1.19 skip lost
  Bang, Tito's, Bacardi and Nike — but searched: `BIG_PASSES` partnerships / sponsorship / brand manager
  (+ marketing only if those found < 3), a `SHORT_READ` of each; old "too big" marks don't rest
  (`isTooBig` → due). **Parent companies** (`src/lib/parents.ts`, `node scripts/test-li-capture.mjs`):
  brands whose people sit under a parent's page (Ketel One → Diageo, Jameson → Pernod Ricard, Fireball →
  Sazerac, Bang → Monster…; only ownership we're sure of — a wrong parent costs a search, never a wrong
  person). `liList` items carry `parent` {name, search, slug}; when a brand's own page gives nobody (no
  page, unclear, won't open, nobody readable, nobody new) the run searches the parent's People tab for the
  brand's name, once (`tryParent`/`endBrand`, mark `parentTried`); a research name with no page of its own
  but a parent becomes a brand (`liResearch` outcome `parent`, linkedinUrl null). The parent's page is found
  once (`liParent`, `decideParentPage`: exact name or aka — Monster Beverage's page is "Monster Energy" — most followed) and kept in Setting `liParentPages`;
  not found → the note names what LinkedIn showed (`shown`) and the brand stays due for the next run;
  parent reads send `viaParent` (never saved as the brand's page, no page check) and report `via`. A brand
  or research name read before this existed, with nobody added, is due again. Then `liCapture` by
  brandId, `liSwept` → Setting `liSweepLog` (`src/lib/li-sweep.ts`; any brand read by a current
  reader rests 30 days, people or not, so a restarted run doesn't redo it; notes show red on
  Outreach → People). Pace (Leo, Sep 30, on free LinkedIn — faster hits its monthly "commercial use
  limit" sooner): **100 brands/day**, 8–15 s between brands, 3–6 s between a brand's pages (Leo, Sep 30: "why are the
  steps so long"; a brand skipped as too big moves on after 3–6 s), shorter scroll pauses; then waits for 9am next day. One tab owns the run (sessionStorage id). **Clicks, keys and
  scrolling never pause it** (Leo: "it keeps stopping every time I click") — only its **Pause** button
  (`pauseByHand`) does; they're noted (`sbLiHuman`, per tab), and if Leo has taken the window to a page
  the run didn't open (`navPath` ≠ here) and used it in the last minute, the run waits
  (`leoIsElsewhere`), then goes back; a read whose page changed under it is dropped and redone
  (`readPath`). A login wall, check or "commercial use limit" pauses it before any save. The panel says
  why the current brand is next (`whyItem`: on the Schedule for <day> and short on people — Schedule
  brands go first, which is why Native came before the electrolyte brands — research list, focus word,
  emptiest), and the end of a run lists every brand and what happened ("What it did").
  **Finding a roster brand's page** (Leo, Oct 12 2026, after Arizona Beverages / Crodino / Ultra Pouches landed on his
  list; script 1.37): an empty company search is loaded once more before the run believes it (`searchLooksEmpty`; 30 s
  to draw while the window is hidden, `searchWait`); the second search is the aka, else `alsoSearch` from `liList` =
  `secondSearchName` (stock.ts: a spelling the lanes' known names have for it — "AriZona" for Arizona Beverages — else
  the name without "Skincare" / "Energy" / "Nutrition"…); `liMatched` also matches those known spellings
  (`knownSpellings`); one exact name whose own line says what the brand sells counts even in an industry that doesn't
  fit (`descriptionFits`, `PRODUCT_WORDS` in li-capture.ts — "in a pouch"). Crodino is under Campari Group. To send a
  brand back to the fill (forget "None of these" and its month's rest): `node scripts/cc.mjs liPageRetry '{"brandId":"…"}'`.
  **Which LinkedIn page is theirs?** (`src/lib/li-review.ts`, Setting `liPageReview`; top of Outreach →
  People): brands the search wasn't sure of (unclear / none, with the top results, the fitting one
  first) and brands whose **saved page is another company's** — the run sends `checkPage` +
  `companyIndustry` with every read, and `liCapture` saves nobody when the page's industry doesn't fit
  (`pageLooksWrong`), then the run searches again with `recheck` (never swaps a saved page itself).
  Leo picks a result, pastes a link, or "None of these" (`liPagePick` / `liPageNone`; Setting
  `liPageConfirmed` = slug the check never questions, or "none" = don't look again; a wrong saved
  page goes on None, named in the confirm). A pick clears the brand's rest so the next run reads it.
  **None sticks** (Leo, Oct 2026: "it should not be revisited on linkedin in a run"): `liList` leaves it out, or —
  with a parent — sends it with `noPage` and the script (≥1.29) goes straight to the parent's page, never its own
  name; a run that fetched its list before the mark gets `liMatched` → `markedNone` (nothing back on the list, no
  second-name search).
  **One writer at a time** (Oct 18 2026 — answered brands came back: each answer read the whole list, cleared one brand
  and wrote it all back, so two clicks close together undid each other): every change to `liPageReview` /
  `liPageConfirmed` goes through `updateReviewState` (li-review.ts, advisory lock, both read fresh), the fill's findings
  through `putOnReview` (never a brand marked none); `answered` / `openReview` drop leftovers on every read (People list,
  coverage, recap count, report) and prune them on the next write. The card goes the moment it's saved.
  **Leo's LinkedIn only** (his call, Sep 30): every call carries `me` (from LinkedIn's own
  `/voyager/api/me`, csrf = JSESSIONID, cached 30 min per tab; else the nav photo's alt); ingest
  claims the first account into Setting `liOwner` and answers 403 `notOwner` to any other on the fill /
  capture actions (not Zach's `liPerson*`); not knowing never blocks. Outreach → People names it, with
  "Wrong account? Reset" (`liOwnerReset`). **What it did**: the run card's "See everything it did" →
  `liRunDetail` (the run's brands, the contacts saved at each during the run, brands it made) with Copy.
  **Finding new brands** (Leo, Sep 2026: straight into the dashboard, not Discover review): the
  run's setup has "Add brands LinkedIn shows as similar" (lookalike rail — "Pages people also
  viewed" etc. — read **only when the People tab shows it**; the extra company-home stop is gone) and "Search LinkedIn
  for new brands" words (company search, up to 3 result pages each, before the first brand).
  `liDiscover` judges each (`judgeDiscovery`: **5K+ followers**, consumer industry via
  `categoryFromIndustry`, wholesale/agency/software out, leagues / teams / sports agencies out — they
  sell sponsorships (MLB's lookalikes were NFL, NBA, NHL); names lose ", Inc." / "Co." / ".com"
  (`cleanBrandName`; name keys treat "X.com" as X); a lookalike takes the source brand's
  category when its industry fits), skips known brands (name/aka/page; a longer LinkedIn name counts, "Waterloo Sparkling Water" = Waterloo — `nearName`) and anything dismissed on
  Discover, creates the Brand (`source: 'linkedin-discover'`, provenance in notes) plus a
  DiscoveredBrand row (status added, query "LinkedIn: similar to X" / "LinkedIn search: w"), and
  stops at **50 new brands per rolling day** (`DISCOVER_CAP_PER_DAY`). New brands join the same
  run: keyword finds next in line, lookalikes at the end. Keyword search is **off by default** (Leo:
  it surfaces small pages, not the big names).
  **Research list** (on by default; Leo: "generate a list of brands to research then it can go find
  them"): the priority lanes' `known` names in `src/lib/stock.ts` (expanded Sep 2026 — Stock take's
  ideas) that aren't on the roster under any spelling (`brandKey`). `liList` with `research: true`
  puts the focus lane's names first, then focus brands, other lanes' names, the rest. Per name: a
  LinkedIn company search → `liResearch` (`decideResearchMatch`: the page's industry must fit the
  lane even for an exact name — "NOS" the telecom isn't NOS Energy; second spelling tried before
  giving up) → creates the Brand (`source: 'research'`, filed under the lane's own category, LinkedIn's spelling added to
  aka, Discover row "Research list: <lane>") and the run reads its people next; a page already on
  another brand adds the name as that brand's aka instead. Outcomes in Setting `liResearchLog`
  (`li-sweep.ts`); unclear names rest 30 days and show their note on Stock take's ideas.
  Brands Leo names that fit no lane go in `RESEARCH_EXTRA` (stock.ts: `{ name, category }`, e.g.
  Huel → wellness); `liList` puts them first of all ("Asked for by name").
  Rules + matching in `src/lib/li-capture.ts` (`node scripts/test-li-capture.mjs`); script tested by
  `scripts/test-li-script.js` (fake People/search pages, incl. a run, pause/continue, limit page).
  **Updates, tests, reports** (Leo, Sep 2026: "a way for you to update and test runs"; yes to reports
  Claude can read + a daily check that fixes and pushes): **one version in three places** — `@version`,
  `VERSION` and `LI_SCRIPT_VERSION` (`li-sweep.ts`); the script test fails if they drift, so bump all three
  on every script change. Tampermonkey pulls `@downloadURL` (raw GitHub main; the repo is public) about
  daily; li replies carry `latest` (`liVersion` asked ≤ every 6 h), so an older copy turns the pill orange
  and every panel offers "Update now ↗". **Run reports** (`src/lib/li-report.ts`, Setting `liRunReports`,
  last 10 runs, `node scripts/test-li-report.mjs`): `liRun` start/pause/resume/finish + every item's
  `liSwept` (with `run`; research names too, brandId null); a page the reader gets wrong
  (`readingProblem`: people on screen but none read, every title blank/the same, badges in names) sends
  `problem` + a card `sample` (≤3 per run). Shown on Outreach → People ("Last LinkedIn run");
  read-only for Claude at `GET /api/reports/linkedin` (Bearer `REPORT_TOKEN`, no contacts; `coverage` =
  the Every-brand-a-buyer counts, numbers only). **Full chain**:
  `scripts/test-li-e2e.js` — the real script → real `/api/ingest` (`next dev`) → a throwaway local
  Postgres, fake LinkedIn (`E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) NODE_PATH=$(npm root -g) node
  scripts/test-li-e2e.js`; refuses any non-local database — it wipes it). GitHub Actions **LinkedIn tool**
  (`.github/workflows/linkedin-tool.yml`) runs types + all four on every push touching the tool. A daily
  Routine ("LinkedIn run check", 7:58 New York) wakes the cloud session "LinkedIn run check (daily)" —
  it has the repo attached; a session a routine makes fresh has no repo and can't push — which reads
  the reports and fixes/pushes LinkedIn-tool bugs only; needs `REPORT_TOKEN` +
  `sb-digitaldashboard.vercel.app` allowed in the cloud environment.
  **Script 1.38 — every brand through Sales Navigator, read again only when something went wrong** (Leo, Oct 14 2026:
  "make sure that each brand goes to the sales navigator and if a brand capture does not get all the people or … times
  out … make sure that it runs again and make sure that brands that have already been run don't run again unless there's
  an issue with the people that they got"). With the switch on (default) every brand ends in Sales Navigator: an empty
  People tab too, a big company, and a brand read under its parent (the parent's company id, keywords `"<brand>"` —
  `snUrl(…, brandKw)`, saved `viaParent`, via "Sales Navigator via <parent>"). **Nothing falls back to the People tab's
  views**: no company id → its page once more (`sn-id` phase) → issue `snNoId`; a results page that doesn't load / leaves
  the search → loaded once more (`snTrouble`) → `snNoLoad` / `snLeft`; another company's people → `snOtherCompany`; a page
  drawing fewer cards than Sales Navigator's own count says (`snTotal`, "28 results"; cards counted once each,
  `snRead().cards`) → loaded once more, then the rest is read and the brand is `partial`; a page that won't open → `noOpen`;
  the dashboard not saving → `save`. A brand whose own read went wrong still gets its parent's read (`brandIssue` →
  `tryParent`, which carries `issue` / `partial` / `problem` along). A brand with an issue goes **again at the end of the
  run** (`item.again`, once), and its liSwept carries `issue` / `issueNote` / `done` / `shown` / `read` / `again` / `key` /
  `snOn`; it waits in the run's `outbox` until the dashboard has it (`flushOutbox` at the top of `runFill`; down past the
  retries → pause, Continue sends it). A page 2 Sales Navigator doesn't have (it drops the number) ends that search
  (`snNextOrDone`); paging follows Sales Navigator's count when it shows one; "LinkedIn Member"-only pages aren't misreads. An account without Sales
  Navigator **pauses** the run (`snNoAccount`). The People tab's views (PASSES, BIG_PASSES) are only for a run with the
  switch off (test-li-script.js's suite). **The dashboard decides re-reads** (`src/lib/li-sweep.ts`): `sweptOutcome` turns
  a liSwept into the mark (`clean` = done with no issue; a misread page = issue `reading`; older copies: a Sales Navigator
  read is clean, `snMissed` an issue) and `liDue` decides: **clean → never by itself** (kept for good in `liSweepLog`;
  `liPageRetry` / `liPagePick` are the ways back, through the same lock — `updateLiLog`); **issue → first on the next run**
  (after the Schedule's and asked-for names; the Brand Fit floor still applies), for `LI_RETRY_MAX` = 3 runs (`tries`
  count runs — `nextTries`, the same run posting twice is one), then it waits a month ("stuck" on the report) — a brand with
  a parent too; no clear page / a People-tab-only read → the old month. A run with Sales Navigator off never clears a
  Sales Navigator issue (`nextMark`, `snOff`) and leaves it a month (`dueOf` in li-list-db) — a run with it on reads it first.
  The visit's save failing on the dashboard answers 500, so the run keeps the mark and pauses. Legacy marks (`markOutcome`):
  `sn` → clean; a People-tab read since Sales Navigator shipped (incl. a failed `snRetried`, which gets one more try) →
  issue `noSalesNav` (not a page problem — `PAGE_NOTE`); older reads that found people → clean. `markLiSwept` is
  advisory-locked. A very-big skip's headcount is kept only when its page passes the page check (else the page goes on
  Leo's list, `why: 'wrong'`). List items carry
  `retry`, `issue`, `issueText`, `tries`, `bigOk`; the reply `retry`, `stuck`, `skipBig`. **Skip very big brands mid-run**:
  the People tab's count ≥ `VERY_BIG` (1,500) with the switch on (`job.skipBig`) and `item.bigOk === false` → skipped, liSwept
  `skipped: 'veryBig'` + members (saved, so the next list leaves it out; the mark is never clean); `bigOk` = the Schedule's,
  asked-for, OK'd giants, conglomerates. **Similar pages → Discover** (Leo's pick): liDiscover `lookalike` writes
  DiscoveredBrand rows (status `new`, query "LinkedIn: similar to X", graded on Discover; one row per company — a waiting
  one isn't added twice; the 50-a-day cap counts those rows) and never a brand; the run never reads them (`created` is
  empty; keyword searches still make brands). `judgeDiscovery` also refuses `DISCOVER_NOT` industries (health care,
  hospitals, mental health, pharma, software, computers and electronics, textile manufacturing, groceries, hospitality,
  education…). The lookalike cap counts every row sent in the rolling day, added or dismissed since. **Dashboard retry**: the run's calls (`runPost`) wait 5 s → 1 min (`DASH_RETRY_MS`, ~4 min) on a dropped
  connection, a timeout or a 5xx before the run pauses. Run reports: brand events dedupe by `key`, carry `issue` / `again` /
  `review`; runs count `review` and `issues` (brands whose last try went wrong — `issueBy`); `/api/reports/linkedin` lists
  `issues` (brand, issue, tries, stuck / retry / back from `liDue`; stuck ones stay listed until they're back);
  `liRunDetail.toReview` = the Discover rows a run sent. Fill schedule: "Read again — <what went wrong>". Parents added
  Oct 14 (parents.ts, so their brands are giants too): Altria (NJOY), Reynolds American (Vuse, Grizzly), Kraft Heinz (MiO),
  Imperial Brands (ZONE X), Proximo (Gran Coramino), Anheuser-Busch (Estrella Jalisco, Rolling Rock). Tests:
  `test-li-capture.mjs` (liDue, sweptOutcome, nextTries, DISCOVER_NOT), `test-li-salesnav.js` (18), `test-li-script.js`,
  `test-li-e2e.js`, `test-li-report.mjs`, `test-coverage.mjs`, `test-fill-schedule.mjs`.
  **Sales Navigator** (Leo, Oct 12 2026: "build out the fill for a Sales Navigator page on my own account"; script
  1.31, still Leo's account only): with the setup panel's "Use Sales Navigator" on (default, GM `sbLiSalesNav`), a brand's
  People tab is read whole as before (headcount, page check, lookalikes — kept in the step as `look`), then **instead of**
  its marketing / partnerships views (or a big company's searches) the run opens Sales Navigator's lead search filtered
  to the brand's company id (`companyIdHere`: voyager `organization/companies?q=universalName`, else the id the page
  mentions most): `SN_SEARCHES` = function Marketing + Business Development (up to 3 pages of 25), then "partnership(s)
  OR sponsorship(s)" (up to 2). Results draw as they scroll (`snExpand` scrolls `#search-results-container`); cards are
  read by `data-anonymize` (person-name / title / company-name) with a lines fallback (`snReadCard`); a person is saved
  as `linkedin.com/in/<member id>` (the lead URL's ACw… id; `storedProfileUrl` keeps its case, `profileSlug` still
  compares case-blind) with "Title at Company", through the same `liCapture` by brandId (big company: `checkPage` on
  the first save). Mis-searches: no company id → the People tab views; results mostly at another company
  (`sameCompany`) → nobody saved from it, People tab views; one result at another company → left out; landing off the
  search (upsell / `/premium/`) → Sales Navigator off for the rest of the run (`snOff`, panel line `#sblisnline`);
  contract chooser → pause; twice failing to open → off for the run. `liSwept` carries `salesNav` (mark `sn`, via
  "Sales Navigator") and only the hidden people Sales Navigator still couldn't name, as People-tab views Zach can open.
  `liList({ salesNav: true })` brings back, **once** (`hiddenRetry`, right after the Schedule's and asked-for names),
  resting brands with no `sn` mark that were read since it shipped (`SN_SINCE`, Oct 12 2026), read on the People
  tab by a run that had it on (mark `snMissed`), or with likely hidden buyers and no Zach read; a retry still
  without it is marked `snRetried` and rests (Leo: "make sure it hits every brand that it skipped"). **Only an
  account without Sales Navigator switches it off for a run** (1.33; Leo: "i dont want the sales navigator to be
  off") — a page that doesn't load (30 s, 60 s while the window is hidden) or "No matches found" (an empty search)
  costs that brand only; a run an older copy switched off turns it back on at its next page load, and the panel has
  **Use Sales Navigator again** (`snTurnOn`). **Brand Fit floor** (1.34; Leo, Oct 12 2026: "can it only fill in the brands that
  score highly"): the setup panel's "Only brands with Brand Fit of at least [60]" (GM `sbLiMinFit`, 0 = every brand)
  → `liList({ minFit })` scores each brand with `scoreBrand` (brand-fit.ts, Leo's category priority, no accept rate)
  and leaves off brands under the floor, too small, not US, closed or Skip (`belowFit` counts them) — never the
  Schedule's brands or names Leo asked for; with a floor the list goes best fit first (items carry `fit`, the panel
  shows it). The Sales Navigator retry (`snRetry`) only applies when the run has Sales Navigator on.
  **Mid-size first** (1.36; Leo, Oct 12 2026: "i want to target the midsized brands mainly"): with a floor the list
  goes **size first** — target (20–499 on LinkedIn) → not measured → small → big — then, within a size, no buyer yet
  first, then best fit (`midFirst`; `noBuyerFirst` only without a floor). The floor defaults to **50** (`FIT_DEFAULT`):
  set while Brand Fit still gave big companies 30 size points vs mid-size 22 (at 60 only 14 of 49 mid-size brands
  passed, vs 100 of 207 big); since Oct 12 mid-size gets 26 and big 18. **Very big brands skipped** (1.35, "Skip very big brands", GM `sbLiSkipBig`, on by default →
  `skipGiants`): held giants (giants.ts) and anything with **1,500+ on LinkedIn** (`VERY_BIG_LI`; Leo: "not reach out
  to any brand with over 1500 employees"), unless Leo OK'd the brand — never a conglomerate (`veryBigWhy`, the
  Schedule's rule); giant research names too (`bigSkipped`).
  **Faster**: with Sales Navigator the People tab gets a glance only (`SN_GLANCE`, 2 scrolls / 40 people — Sales
  Navigator reads the people), a brand under 50 on LinkedIn (`SN_SMALL`) gets only the marketing search, and brands
  with a saved LinkedIn page go before the ones the run has to search for (`paged`). The worklist lives in `src/lib/li-list-db.ts` (`buildLiList`, shared by liList and
  Outreach → People's **Fill schedule**, `fillSchedule`, whose defaults match the run's: floor 50, very big skipped). Unverified against the real Sales Navigator pages
  until Leo's first run — "Copy a sample for Claude" works on a Sales Navigator search. `node scripts/test-li-salesnav.js`.
  **"LinkedIn Member" cards** (out of Leo's network, name + profile hidden by LinkedIn) can't be saved, but
  **they aren't lost** (Leo, Oct 7 2026: "i dont want to miss out on people if i do it from my own account"):
  since 1.30 the script reads each hidden card's headline (`hiddenCards` / `memberCardFor`), view by view
  (`st.hidViews` / `hs.hidViews` `{q, url, heads}`, carried across `tryParent`, dropped on a wrong page); the
  fill sends them with the brand's `liSwept` (`hidden`, only when a view was read), Leo's hand scan with
  `liPreview`/`liCapture`. Scrolling and the page-ready waits count them too (`listed()`), and a page of only
  hidden cards still opens its marketing / partnerships views. Rules pure in `src/lib/li-hidden.ts`
  (`node scripts/test-li-hidden.mjs`): headlines judged like a real card (`isBuyer` with the brand's own names +
  the sister-brand check from ingest's `hiddenJudge`); a headline counts once per view at most across views
  (`summarizeHidden`); "likely" = buyer headline, or none at all in a marketing / partnerships search (`BUYER_SEARCH`
  — not a parent's tab searched for the brand's name); the link = the view with the most likely buyers (`peopleViewUrl`, always rebuilt on www.linkedin.com). Setting `liHidden` (brandId →
  `{at, by fill|hand, n, likely, titles, url, q, zachAt, zachAdded}`, advisory-locked `updateHiddenLog`): a fill
  visit replaces it (one that saw nobody hidden clears it); a hand read replaces only a finding with fewer likely
  buyers and never clears; an older script (no `hidden`) leaves it. A hand scan's preview records only when the page
  says whose it is (matchedBy `page` / `keyword`); a name still being checked in the box waits for Add. The scroll's
  people cap counts readable people only (hidden ones only keep it scrolling).
  **Read on Zach's LinkedIn** (Outreach → People, `#li-zach`, `renderLiZach`; `linkedinPeople` → `zachList` /
  `zachDone`): brands with likely buyers hidden, not read on Zach's in `ZACH_REST_DAYS` (120), not archived /
  do-not-email / full — no buyer on file first; **Open on LinkedIn ↗** per brand, **Copy for Zach** (each brand +
  link + "SB · Read people → Read this page → Add"), **Done** / **Back on the list** (`zachRead`). Zach's own
  read (`liCapture` via `log`, incl. 1.2's "Nobody new") marks it (`markZachRead`, answered as `zachMarked`) — only a
  read that made out people, all saved. Leo's own pill with nobody new but people hidden offers "Nobody new — save
  the N hidden for Zach" (the same `liCapture`, adds 0, carries `hidden`). Coverage state **zach** (All
  brands' card "Hidden from your LinkedIn · Zach reads them", `cvZachList` jumps to the list), the brand page's
  People line (`getBrand.liHidden`, `#b-lihidden`), the recap ask `zachread`, the run card's hidden line and the
  run report's `hiddenPeople` / `hiddenLikely`. A People view searched for a brand on its parent's page
  (`/company/diageo/people/?keywords=Captain Morgan`) is that brand's read (`resolveLinkedinBrand` matchedBy
  `keyword` via `isParentPage`, ahead of the page's own slug) and never saves the parent's page or headcount on
  it (`liCapture` works `viaParent` out itself). `liPagePick` / `liPageNone` forget hidden people counted on a
  page that wasn't theirs.
  Worklist in the dashboard: Outreach → People → "Under 25" (deep link `app.html#people`).
  **Fill schedule** (Leo, Oct 12 2026: "make me a schedule for the brands that run in the linkedin fills"; card `#li-sched`
  on Outreach → People, `renderFillSched`): `fillSchedule({ minFit })` = the fill's own worklist — liList's logic lives in
  `buildLiList` (`src/lib/li-list-db.ts`), shared by /api/ingest and /api/data so the schedule is exactly what the run
  reads — with the script's defaults (focus electrolyte, research list, Sales Navigator) and a Brand Fit floor (default 60,
  per browser in localStorage `sb.fillFit`; Leo sets the same in the fill's setup panel), cut into calendar days at
  `LI_PER_DAY` (today = what's left after the brands the sweep / research logs show read today; `splitFillDays`,
  `fillWhy` in `src/lib/fill-schedule.ts`). Read-only forecast. `node scripts/test-fill-schedule.mjs`,
  `test-fill-schedule-ui.js` (page), and a check in `test-li-e2e.js` (same names, same order as liList).
  On a profile (`/in/<slug>/`) the pill is **Send to dashboard** (Leo, Oct 2026: "it should just be send
  this contact to dashboard"): reads name / headline / current company (the SB · Log reader), the company
  box is editable, one click → `liCapture` with `handPicked` (one row; skips the buyer-title filter, keeps
  dupe / elsewhere / the 25 cap) + `createIfMissing` → the brand's LinkedIn queue. Logs no invite — that
  stays SB · Log / Zach's list.
  Install by **paste** (Tampermonkey → + → paste over the sample; pasted under it, the sample's
  header wins and it never runs on LinkedIn — a copy without its @grant lines says "Reinstall").
  Chrome needs Tampermonkey's **Allow User Scripts** switch on. The pill shows on every LinkedIn page,
  **bottom-left** (Messaging owns bottom-right), on `<html>` with `all:initial`. Panels are built
  node by node (`h()`) — **never innerHTML**: LinkedIn allows only its own Trusted Types policy and
  it scrubs inserted HTML (stripped the panel's buttons on the first real run). Clicks are wrapped
  (`guard`) so a failure shows a message, never nothing. **Top page only** (`@noframes` + a
  `window.top` check): LinkedIn's same-origin frames each ran a copy that shared the tab's run and
  worked the same brand twice ("reading 'seen'" error). One page is in charge (`job.runner` =
  `PAGE_NONCE`, claimed by each page load in the run's tab / Start / Continue); every async step
  re-checks `sameStep` (same brand, still ours) before writing.
  **Card reader** (`readCard`): name = the profile link's text, headline = first real line after the
  name; LinkedIn's badge comes as "· 2nd" **or "• 3rd+"** (bullet) — reader 1 missed the bullet, read
  it as everyone's title and added nobody. Every call sends `reader` (`LI_READER = 2` in
  `li-sweep.ts`); ingest answers 426 "out of date" to older scripts, and visit marks from older readers
  never rest a brand. **One-click start**: Outreach → People's "Start the LinkedIn fill ↗" opens
  `linkedin.com/feed/#sb-fill`; the script runs at **document-start** only to catch that hash
  (LinkedIn rewrites its address while loading), the rest waits for DOM ready (`whenReady`), and it
  starts a run in that tab with the panel's defaults. **A window of its own** (Leo, Sep 29: "run when I'm
  not on LinkedIn but I can go through brands"): every `#sb-fill` link in app.html opens LinkedIn in one
  named popup (`LI_FILL_WINDOW`, 1100×820 at the right edge; `opener` kept — clearing it made the next
  click open a second window); a second click brings that window back to the feed, where the run picks up
  (the trip doesn't count against the brand's two page tries), and a `#sb-fill` arriving on an
  already-loaded feed is caught by `hashchange`. Chrome slows a minimized or fully covered window to ~a
  step a minute, so the script counts hidden time (`flushHidden` on every save → `hiddenMs` per brand
  and run, plus each brand's `ms`), warns in its panel from 2 min, and the "Last LinkedIn run" card shows
  minutes a brand and hidden minutes. It still needs Leo's computer awake with that window open. A run untouched for 10 min (`staleFill`; live
  tabs heartbeat `touchedAt` each minute) no longer blocks a new one (electrolyte first, research list + lookalikes on) — Claude can't run it from the
  cloud; it needs Leo's browser and LinkedIn login. Menu / preview link **"Copy a sample for Claude"** copies what the reader made of
  the first three cards (+ trimmed markup) for Leo to paste when LinkedIn changes its cards again.
- `scripts/linkedin-log.user.js` — **SB · Log**, the logging-only script for the browser signed in
  to **Zach's** LinkedIn (Leo, Sep 2026). Nothing but the section "Invites sent straight from LinkedIn":
  on a profile (`/in/<slug>/`, pill "SB · Log them") it reads the name (`<h1>`, else the tab title),
  headline and current company ("Current company" aria-label, else the first job's logo alt, else "at X"
  in the headline) → `liPerson` (who they are, which brand; nothing saved) → `liPersonLog` (by contactId,
  or under the brand; "New brand + …" = `createIfMissing`) → Undo = `liPersonUndo`. Only ever reads the
  one page that's open: no People capture, no fill, no `#sb-fill`, no scrolling — those stay in
  `linkedin-capture.user.js`, which must never be installed in Zach's browser. Same INGEST_TOKEN (its own
  GM storage), sends `reader: 2` so the li* gate lets it through, `@version` = `VERSION` (its own track,
  from 1.0; it ignores `latest`, Tampermonkey's daily update keeps it current). Pill bottom-left, or just
  above the People pill if both are installed. Same install by paste, same Trusted Types rules (`h()`,
  never innerHTML). **Since 1.1** (Leo, Oct 6 2026: Leo's LinkedIn hides out-of-network people as "LinkedIn Member", Zach's
  bigger network shows them; **1.3**, Oct 16 2026: someone who said they don't want to continue reads so, nothing to
  log): on a company's People page the pill is **SB · Read people** → **Read this page**
  (only on that click; scrolls that page + Show more, ≤150 people) → `liPreview` → **Add** → `liCapture` (`via: 'log'`,
  no `me` so the Leo-only lock doesn't apply; buyers only, 25 cap). Still no run, no fill, no navigation by itself.
  **1.2** (Oct 7 2026): nobody new → the button is "Nobody new — mark <brand> read" (sends the same `liCapture`, adds
  0), so the brand leaves "Read on Zach's LinkedIn" (a read that made out nobody can't: "Nobody read on this page"); links off that list open the right view (a parent's page searched
  for the brand is credited to the brand by its search word).
  Tests: `node scripts/test-li-log-script.js` (fake LinkedIn + fake dashboard: reads a People page only on
  Read, saves only on Add, never a run action) and `test-li-e2e.js` (real dashboard + throwaway
  Postgres: accepted, Undo, invite sent).
- `src/lib/email.ts` — outreach: drafting, cap/ramp (`roomToday`), sending via Gmail API, replies, warmup stats, signature (hosted images, LinkedIn/IG as text links).
- `src/lib/google.ts` — OAuth (gmail / drive / ops grants), Gmail read+send, Drive/Sheets/Docs create.
- `src/lib/shows.ts` — **the show list** for the Shows tab and the public sponsor page. Reads **only
  the CONTRACTING tab** (`DEALS_TAB`) of the "SB AGENCY - FULL BUILT CRM" Google Sheet (read-only)
  via the Drive grant — Leo's call; "OLD ACCOUNTING - DO NOT TOUCH" went stale and every other tab
  is ignored. A row is a confirmed show only with a booked status **and** date **and** artist **and**
  school (Declined Pivot never shows). Two acts at the same school + chapter + date are one listing
  ("A + B"). Bump `PARSER_VERSION` when the parse changes so the cache rebuilds on the next read.
  Past shows from `src/data/show-archive.json`. School abbreviations → name/city/state in `SCHOOL_TABLE`;
  genre auto-tags in `GENRE_ARTISTS` (overrides in Setting `artistGenres`). Cache in Setting `crmShows`
  (1 h — the first board open after that re-reads; daily cron; ↻ Sheet button on Shows; the Overview's
  ↻ Refresh re-reads the sheet too and its sheet line (`sheetStatus`) says when it was last read). Show ids: `sh_<hash>` / `ar_<hash>`. sb-crm's DB is no longer the source.
- `public/sponsor.html` + `src/app/api/public/{shows,request}` — **brand-facing Show Board**, no
  sign-in. Optional access-code gate: **on only when `SPONSOR_GATE=1`** (currently off — board is
  open). Per-brand codes (`Brand.boardCode`, minted on the brand page; `src/lib/board-access.ts`;
  team-wide `SPONSOR_MASTER_CODE` env) always attribute requests to their brand; with the gate on
  they're required. The page remembers the code per device; links copied from a brand page carry
  `?code=` so the brand skips the gate. No code → "Request the show list" on the gate
  (`/api/public/access` → `BoardAccessRequest` pending + email to `SPONSOR_REQUEST_TO`); approve on
  the Show Board tab creates brand+contact, mints a code and emails it from the ops mailbox. At
  `/partnerships` on every host (rewrite; the old `/sponsor.html` path still works) and served on
  `SPONSOR_HOST` (default shows.sboyagency.com; `/` rewrites to it, middleware blocks
  everything else on that host). Brands browse by date / college / state (`?group=college`), filter by
  performer (`?performer=dj|singer|rapper|band`, derived in `performerFor` from genre+type) and genre.
  Links: `/?state=TX&genre=edm`, hand-picked `/?for=Brand&pick=id,id` (built from the Shows tab
  checkboxes → "Copy link for this brand"). Copied links use `SPONSOR_HOST` only when that env var is
  set (it is: shows.sboyagency.com, attached in Vercel); unset, they fall back to `SITE_URL/partnerships`. One helper,
  `sponsorBoardUrl()` in route.ts; the page asks `sponsorUrl` on load and gets it with every `getBrand` (Oct 12 2026: a
  brand page's Copy link used the vercel.app address until the Shows tab had loaded). A submit → `src/lib/sponsor-request.ts`:
  Brand + Contact + ShowSponsor(status `requested`) per show + one Deal (source `request`) + email to
  `SPONSOR_REQUEST_TO`. Only brand-safe fields ever leave the public API (no reps, statuses, money).
- `src/lib/ops.ts` — Operations inbox: rules classifier (contract / invoice_payable / invoice_receivable / other), 90-day backfill scan, reply/forward as "SB Agency Operations".
- `src/app/api/google/{start,callback}` — OAuth entry/return. `?drive=1`, `?ops=1` pick the grant.
- `src/app/api/ops/attachment` — streams a Gmail attachment to a signed-in user.
- `src/app/api/cron/email` (11:00 UTC: draft, replies, Notion sync, ops scan) · `src/app/api/cron/send` (15:00 UTC).
- **Audience module (sponsorship Phase 1)** — `prisma`: Event / Attendee / Attendance (the join
  table — "same person, multiple events" is the product) / ConsentText. `src/lib/audience.ts` =
  server logic; `src/lib/audience-core.ts` = pure helpers (email normalization, CSV import mapping;
  tested by `node scripts/test-audience.mjs`). Public, no sign-in: `public/rsvp.html?e=<slug>`
  (RSVP + ticket + self check-in; ambassador links add `&ref=sboy:<userId>` — refs come from the
  Sboy Vision roster, no parallel one) and `public/door.html?e=<slug>` (staff check-in behind the
  event's `staffPin`; caches the list + queues check-ins in localStorage so a dead venue connection
  doesn't stop the line), served by `/api/public/rsvp` + `/api/public/checkin`. Dashboard: the
  Audience nav group (Events = CRUD, links, PIN, per-event stats; Attendees = search, CSV import
  with mandatory preview, merge tool, delete path; Segments = Phase 2, `segmentsOverview` derives
  repeat/VIP/first-timer/genre/campus segments on demand — nothing stored — plus the portfolio
  rollup and a print-ready one-pager per segment, aggregates only). Later phases (SponsorUnited
  matching, activations, sponsor reports) build on these tables — brands go in the existing Brand table.
- `prisma/schema.prisma` — Brand, Contact, OutreachTarget, EmailMessage, Deal, Activation → ActivationEvent → BudgetLine / EventStaff, OpsMessage, Setting (key/value, holds refresh tokens).
- `public/materials/` — one-pager PDF, logo, icons (served, referenced by URL in emails).

## Env vars (names only — Leo sets values in Vercel)
DATABASE_URL · NEXTAUTH_SECRET · GOOGLE_CLIENT_ID/SECRET (sign-in) · GMAIL_CLIENT_ID/SECRET (mail+drive+ops OAuth) ·
EMAIL_SENDER_NAME=Zach · SITE_URL · ANTHROPIC_API_KEY (optional; avoid spend) · NOTION_* ·
AMBASSADOR_PLATFORM_URL · AMBASSADOR_PLATFORM_TOKEN (= platform INTEGRATION_TOKEN) · INGEST_TOKEN · CRON_SECRET ·
optional: SIGNATURE_LINKEDIN_URL, SIGNATURE_INSTAGRAM_URL, SIGNATURE_EMBED=1, SIGNATURE_ICONS=1, OPS_BACKFILL_DAYS,
SPONSOR_HOST (brand page host), SPONSOR_REQUEST_TO (who gets sponsor requests), SPONSOR_GATE=1
(turn the Show Board access-code gate on), SPONSOR_MASTER_CODE (team code that always opens the
board), CRM_SHEET_ID, REPORT_TOKEN (Claude's cloud token: reads the LinkedIn run reports, and may add
Discover review rows for the daily brand hunt — never brands; 24+ characters, the same value in the Claude
cloud environment's settings).

## Conventions
- **Outreach runs Tuesday / Wednesday / Thursday only** — no Mondays, no Fridays, no weekends —
  **plus one-off extra days** Leo opens with "+ Add a sending day" (Setting `outreachExtraDays`,
  `setExtraSendingDay`; past keys prune), **minus days he takes off** with Move this day to… (Setting
  `outreachSkipDays`, read with the extras as `.skips`; skip-day under Outreach → Schedule). `OUTREACH_DOWS = [2,3,4]` in `src/app/api/data/route.ts`
  (`isOutreachDay(d, extras)`, `planningDays`) — every caller passes the extras; the page reads the
  server's days / `getTodayQueue.sendingDay`, `OUTREACH_DOWS` in app.html is only a fallback. On an
  off day "today" is absent from the schedule, the auto-fill picks nobody and `fillToday` refuses.
  The email machine keeps its own Tue–Thu rule. Anything keyed off "today" compares day keys —
  never "the first row".
- **Unsent work rolls forward** (Leo, Sep 26: "anything that i dont send out one day i want it to
  move to the next" — replaces the old rule that sent a day's unsent people back to the pool).
  `readPlan` runs `rollOverUnsent` once a day before anything reads the plan (`readPlanRaw` is the
  bare read): every brand due on a past day that didn't go out — people stamped into that day's
  queue and never sent, or a brand pinned there / shown there by the rotation (Setting
  `outreachDayRows`, written by `getOutreachPlan`) that sent nobody — is pinned to the next sending
  day and its stamped people go back to the pool so that day's queue stamps them again. Stays put,
  with why: archived / do-not-email / in talks, passed that day or inside a Pass's two weeks, planned for
  another day (not a half-sent brand: its rest goes on the next sending day and it leaves the later day — third
  review, Oct 13 2026; there it would only rest), nobody left, resting (a part-sent brand whose next sending day has
  gone by — queue rules).
  **Onto a Best fit day** (Oct 7 2026) only real commitments carry: brands planned by hand, people queued
  by hand, a brand that sent anyone that day (half-sent: its rest goes out on that next sending day, the same
  sitting — Leo, Oct 12 2026), and the automatic fill's picks Best fit
  would still pick. What the day only showed, and the fill's own picks at brands already reached / Skip / too
  small (Setting `outreachAutoQueued`, written by getTodayQueue), go back to waiting — so the day stays best fit.
  **Carried brands go first** (carry-front; Leo's default, Oct 12 2026 — on the end of a full day they waited
  and rolled again, the oldest never went): `carryOrder` puts half-sent brands first (their rest must finish that
  day or they rest), then brands planned (or queued by hand) on the day they missed — older day first, their plan
  order — then the day's own pins in Leo's order (except its own part-sent pins finishing their sitting there —
  pinned by Off queue / ×: they go with the half-sent, `carryOrder(…, first)`, `secondSittingOn`; second review, Oct
  13 2026), then what was only shown or picked by the fill (`CarryTier`
  0 / 1 / 3 from `findUnsent`, `auto` = outreachAutoQueued; unsentOn reads stamps in queue order); Leo can still
  reorder (⋯ → ⤒ Move to top). moveCarried uses the same order; Move what's left's question names the day's own
  brands that would then wait (`nowWait`, `movedWait`).
  Rules pure in `src/lib/carry.ts` (`node scripts/test-carry.mjs`); last roll in Setting
  `outreachCarry` (per brand `tier`, `since`, `times` — `carryTimes`; Schedule "Carried over" note + "From <day> ·
  carried 2×" tags, **Move them to…** = `moveCarried`), `outreachCarryDone` = { day, through, running } (one request claims the roll with a
  conditional write; others wait for it; a claim older than 30 s is taken over). Today's column has **Move what's left
  to…** (`moveUnsent`, previewed) — it closes today to automatic picks (Setting `outreachDayClosed`;
  hand-adds still go). Both menus offer the next off weekday "(adds it as a sending day)".
- **One category list:** `CATEGORY_KEYS` in `src/lib/category-hints.ts` (same keys, same order as
  `CAT_NAMES` in app.html; used by route.ts, ingest, Stock take). Every path that files a brand
  refuses an unknown key (`checkCategory`). Brands tab: "No category" chip (`listBrands({category:
  'none'})`) and tick-to-re-file with a from → to preview (`setBrandsCategory`, category/tier only).
- **Full width** (Leo, Oct 6 2026: "every space is taken up on the screen"): `.page` has no max-width on any view; don't cap a page's width again (narrow inputs / modals are fine).
- **Home is the front door** (Leo, Oct 6 2026): the SB logo (`#logo-home`) goes Home from anywhere; opening,
  reloading or a bookmark always starts on Home (the hash is dropped on load) — only a link clicked from another
  site keeps its deep link. **Readable text**: no font size under 11.5px; small print is 12.5–13.5px. Keep help
  text to one short line.
- Cents everywhere; `money()` formats on the client, `parseMoney()` parses "$1,750".
- Activations: "current cost" = sum of `finalCents` only; estimate is the sheet. A staff-section line is a people line (slots) unless it's travel/labour (`isPeopleLine`, same regex client+server).
- EventStaff `status`: invited · onboarding · ready · confirmed · declined · no_show · done. Local confirmed/declined/no_show/done are never overwritten by a platform sync.
- Ops: rules classify, a hand edit (`reviewedAt`) is never overwritten by rescan. Paid vendor invoice linked to a budget line → sets that line's final cost.
- UI edits save on `change`; re-render after money/status edits.
- **Keep my place** (Leo, Sep 2026: buttons "reload the page"): a loader re-run for the screen already
  showing is a refresh — `showView(id)` returns true, so skip the "Loading…" placeholder and guard the
  draw with `viewTurn(id)`. `keepPlace` (showView runs it) holds the clicked thing where it was on
  screen, re-opens `<details>`, keeps the cursor and typed text, and keeps `[data-scroll]` boxes'
  sideways scroll. Only navigation starts at the top: `gotoView`, or `showView(id, true)` for new
  content in the same view (another brand / category / query). Cards opened by hand keep their open
  state in page state (`OPEN_DRAFTS`, `EM_OPEN`, `BRAND_EDIT_OPEN`, `ST_OPEN`…). `node scripts/test-keep-place.js`.

## Dev loop
```
npm install
npx prisma generate
npm run dev            # http://localhost:3000/app.html
npx tsc --noEmit       # types
npm run build          # what Vercel runs (includes prisma db push!) — use a dev DATABASE_URL
```
Push to `main`, then confirm the deployment is READY on Vercel and reload the live page.
Superseded QUEUED builds can be cancelled from the Vercel deployments list.
