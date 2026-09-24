# SB Command Center (repo: zadegan1515-arch/SBDigitaldashboard)

If `../CLAUDE.md` (the SB Agency workspace file) exists it applies too. The rules below are repeated here so this repo stands alone.

## Hard rules (never break these)
1. **Money is integer cents.** Never floats. Never sum sponsorship revenue, booking revenue and activation costs together — they are three separate lines.
2. **Credentials:** never type, print, log or commit passwords, app passwords, API keys, tokens or env-var values. Name the variable and tell Leo where to paste it (Vercel / Railway). Never ask Leo to send a secret in chat.
3. **sb-crm is read-only.** Never write to it.
4. **No Anthropic API spend** unless Leo explicitly approves it for a specific feature. Prefer rules/regex.
5. **Claude does not move real money.** Payouts on the platform run only when a human clicks; PayPal stays sandbox unless Leo sets `PAYPAL_ENV=live`.
6. **Never bulk-delete or overwrite data** without showing exactly what changes first.
7. **Email sending:** cap is enforced in code (start 5/day, +8/week, ceiling 40). Never raise it without Leo. Warmup / test emails from the app are fine.
8. Ask clarifying questions when the request is ambiguous. When reporting back: **what you fixed, what Leo needs to give you** — short, with links. No long explanations. Anything Leo must do himself is a labeled **NEED** block: a bold one-line label, numbered steps, only the info required — nothing extra.
9. **Attendee data (Audience module):** individual attendee records never leave the dashboard — sponsors and every public API get aggregates only. Email is identity: all attendee writes go through `normalizeEmail` in `src/lib/audience-core.ts`, guarded by `node scripts/test-audience.mjs`. Consent text is versioned (`ConsentText`); imports never claim consent the person didn't give. Deleting an attendee (the "remove my data" path) always shows what goes before it goes.

## Ways of working
- Leo chose: **push straight to `main`**. Both hosts auto-deploy, so after every push **check the build went green** (Vercel dashboard or `vercel` CLI; Railway deployments tab) and re-check the live page.
- Vercel Hobby limits: **2 cron jobs, daily only**; 1 concurrent build. Don't add crons — fold new scheduled work into `/api/cron/email` (11:00 UTC) or `/api/cron/send` (15:00 UTC).
- Prisma schema changes deploy themselves (`prisma db push` runs in the Vercel build). Still: additive changes only; never drop columns with data.
- Test before pushing: `npm run build` (Next) / `npx tsc --noEmit`, and for `public/app.html` a Playwright smoke run with mocked `/api/data`.
- Google OAuth: one Google Cloud client (`GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET`) serves three grants — outreach mailbox (`state=gmail`), Drive (`state=drive`), ops mailbox (`state=ops`). Scopes stay narrow: gmail.send + gmail.readonly, drive.file. Never request mail.google.com or modify/delete scopes.


Live: https://sb-digitaldashboard.vercel.app/app.html · Vercel Hobby, team `sbagency`.

## Stack
Next.js 14 App Router · Prisma 5 · Neon Postgres · NextAuth (Google sign-in, allowlist) ·
one vanilla-JS page `public/app.html` (no framework, no build step for the UI) ·
one API: `POST /api/data` with `{ fn, args }` dispatched from the `handlers` map in
`src/app/api/data/route.ts`.

## Where things live
- `public/app.html` — the whole UI. Top nav is six groups with sub-tabs (`SUBTABS`/`GROUP_OF` in
  `showView`): Home · Brands (All brands / Discover / Needs contacts) · Outreach (Queue / Results) ·
  **Show Board** (Overview = code lookup + access-request approve/deny queue + view stats +
  who's-opened feed / **In talks** = per-brand engagement cards (code, viewers, opens, timed minutes
  via the board's 60s heartbeat → `BoardVisit.lastSeenAt`, picked shows, visit log) / Requests /
  Shows) · **Deals** (Board = the old Pipeline / Sponsorships) · **Audience** (Events / Attendees —
  attendee capture, sponsorship module Phase 1) · Operations (Materials / Team —
  the ops@ inbox and contract/invoice UI are removed from the site per Leo; `src/lib/ops.ts`, its
  cron scan and the generateContract/Invoice handlers still exist server-side).
  **Activations** is its own workspace (sidebar + tabs swap in), entered from the left sidebar or the
  Home "Jump to" card — not in the top nav. Deep links: `#activations/<id>/<tab>`, `#operations/<id>`.
- **Home → For Zach to do** (`zachTodo` + `renderZachTodo`; deep link `app.html#zach`) — everyone who
  accepted a LinkedIn invite or answered there and still needs an email (`HAND_WAITING` in `route.ts`:
  accepted/replied, no `emailedAt`, no `handSkippedAt`, no inbound email; archived / do-not-email
  brands are held back and named). One-line rows under brand labels (avatar colour follows the brand,
  a 4-dot mini flow, the next step in words); one row open at a time shows the flow
  **Accepted → Text them on LinkedIn (due 24h after the accept; follow-up after 4 quiet days) →
  Replied → Email and/or LinkedIn DM (either or both, each its own ✓; picking one logs the reply) →
  Call scheduled** (day picked; sets followUpAt so it shows in Needs action on the day; the end).
  The stage is computed on the page (`ztStage`); every tick/undo is `handStep` (dm, nudge, replied,
  wantsEmail, liPath, liSent, emailed, call, skip). Fields: `dmSentAt`, `nudgedAt`,
  `handWantsEmailAt`/`emailedAt`, `handLiPathAt`/`handLiSentAt`, `callAt`/`callBookedAt`,
  `handSkippedAt`. Two templates (Settings `handEmailTemplate`, `handDmTemplate`; placeholders
  (NAME) (BRAND) (TITLE); stand-ins until Leo saves his), edited in one modal with tabs and a live
  preview; per-person edits in `Target.handSubject/handBody/handDm` (null = follow the template).
  The first LinkedIn message and follow-up are the queue's own drafts (`saveDraft`). Leo's note is
  `Target.handNote`; To writes `Contact.email` (old address kept in the contact's notes).
  Open in Gmail (compose URL, `authuser` = signed-in email) / Copy: **nothing sends from the site**,
  so the cap isn't involved. Done fold (30 days) and Calls booked, each with Undo. No CC (Leo's call); one-pager is a download button. The email
  machine skips brands with an accepted/replied/hand-emailed person, and skips follow-ups to accepted
  or hand-emailed people. Results → "To email" is now a pointer here.
- `src/app/api/data/route.ts` — every server function. Add a handler = add a key to `handlers`.
- `src/app/api/ingest/route.ts` + `scripts/sponsorunited-capture.user.js` — SponsorUnited contact
  capture (INGEST_TOKEN-gated, CORS-open). **Two different caps, don't confuse them:**
  `CONTACT_CAP_PER_BRAND = 25` (ingest + `importContacts`) is how many people we keep *on file* per
  brand — under 25 a brand imports whole, at 25 it stops taking new rows; best titles first, nothing
  existing is removed. `TARGET_CAP_PER_BRAND = 3` is how many we *write to* per brand. The sweep's
  worklist (`action:'list'`, scope `thin`, emptiest brand first) is every brand under the contact
  cap — it used to be brands with zero contacts, which permanently skipped any brand whose first
  capture found one or two people. Old userscripts sending scope `missing` get `thin` too. A brand
  whose last visit added nobody **rests 14 days** (Setting `suSweepLog`, `isResting` in
  `src/lib/su-match.ts`) so emptiest-first doesn't reopen the same stalled brands every run; the
  script expands the contacts list (scroll / "load more") before reading it.
- `src/lib/email.ts` — outreach: drafting, cap/ramp (`roomToday`), sending via Gmail API, replies, warmup stats, signature (hosted images, LinkedIn/IG as text links).
- `src/lib/google.ts` — OAuth (gmail / drive / ops grants), Gmail read+send, Drive/Sheets/Docs create.
- `src/lib/shows.ts` — **the show list** for the Shows tab and the public sponsor page. Reads the
  "SB AGENCY - FULL BUILT CRM" Google Sheet (read-only, tab gid 1397302046 preferred) via the Drive
  grant; a row is a confirmed show only with a booked status **and** date **and** artist **and** school.
  Past shows from `src/data/show-archive.json`. School abbreviations → name/city/state in `SCHOOL_TABLE`;
  genre auto-tags in `GENRE_ARTISTS` (overrides in Setting `artistGenres`). Cache in Setting `crmShows`
  (6 h; daily cron; ↻ Sheet button). Show ids: `sh_<hash>` / `ar_<hash>`. sb-crm's DB is no longer the source.
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
  set; until Leo attaches the custom domain in Vercel they fall back to `SITE_URL/partnerships`. A submit → `src/lib/sponsor-request.ts`:
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
board), CRM_SHEET_ID, CRM_SHEET_GID.

## Conventions
- **Outreach runs Tuesday / Wednesday / Thursday only** — no Mondays, no Fridays, no weekends.
  `OUTREACH_DOWS = [2,3,4]` in both `src/app/api/data/route.ts` (`planningDays`, `isOutreachDay`)
  and `public/app.html` (`schedDayKeys`); the planner shows the next three sending days, and on an
  off day "today" is absent from the schedule and `fillToday` refuses. Anything keyed off "today"
  compares day keys — never "the first row".
- Cents everywhere; `money()` formats on the client, `parseMoney()` parses "$1,750".
- Activations: "current cost" = sum of `finalCents` only; estimate is the sheet. A staff-section line is a people line (slots) unless it's travel/labour (`isPeopleLine`, same regex client+server).
- EventStaff `status`: invited · onboarding · ready · confirmed · declined · no_show · done. Local confirmed/declined/no_show/done are never overwritten by a platform sync.
- Ops: rules classify, a hand edit (`reviewedAt`) is never overwritten by rescan. Paid vendor invoice linked to a budget line → sets that line's final cost.
- UI edits save on `change`; re-render after money/status edits.

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
