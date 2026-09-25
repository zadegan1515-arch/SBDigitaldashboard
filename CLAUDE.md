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
  `showView`): Home · Brands (All brands / Stock take / Discover / Needs contacts) · Outreach (LinkedIn / Results /
  Schedule / Email / People / Archived / Email stats) ·
  **Show Board** (Overview = code lookup + access-request approve/deny queue + view stats +
  who's-opened feed / **In talks** = per-brand engagement cards (code, viewers, opens, timed minutes
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
- **Home → For Zach to do** (`zachTodo` + `renderZachTodo`; deep link `app.html#zach`) — **everyone who
  accepted a LinkedIn invite** until they're finished (`HAND_WAITING` in `route.ts`: accepted/replied,
  no `callAt`, no `handSkippedAt`). Replied by email still shows (Email step ticked, "replied by
  email"); archived / do-not-email brands show with a tag, never hidden. Filters: To do / Waiting only.
  One-line rows under brand labels (avatar colour follows the brand,
  a 4-dot mini flow, the next step in words); one row open at a time shows the flow
  **Accepted → Text them on LinkedIn (due 24h after the accept; follow-up after 4 quiet days) →
  Replied → They want email → Email to send → Email sent, and/or They want LinkedIn → DM to send →
  DM sent (either or both; picking one logs the reply) →
  Call scheduled** (day picked; sets followUpAt so it shows in Needs action on the day; the end).
  "← Back a step" on an open card undoes the latest tick (`ztLastStep`). The stage is computed on
  the page (`ztStage`); every tick/undo is `handStep` (dm, nudge, replied,
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
- **Outreach → Schedule** (`getOutreachPlan` + the `sd*` / `renderSched*` code; plan in Setting
  `outreachPlan` = `{ "YYYY-MM-DD": { category, brandIds } }`, one brand on one day) — full width,
  today (if a sending day) + the next 3 sending days as columns. Every brand carries a **contacts label**
  (`contactLabel`, same on server and page): reachable = email OR LinkedIn; need = `workPeople` ??
  (established 4 : 3); Ready ≥ need, Thin 1..need-1, No one reachable 0. A brand goes out **whole**,
  opened to its thread count (`previewBrandPicks` mirrors `queueBrandTargets` without writing;
  `fillWholeBrands` is shared by the preview and `getTodayQueue`, so what the Schedule says is what
  the LinkedIn tab stamps; a day never passes 20). Pinned cards say who goes or exactly why not
  (`outreachGate` + `reasonText`). Adding: day search (`searchPlanBrands`), **Paste a list**
  (`matchBrandList`), the day's **Fill box** (`suggestForDay`, any category, Fill to 20 = whole brands
  that fit), category drill-in with multi-select (`categoryBrands`). Moving: drag onto a day or
  "Move to" (`planMoveBrand`; moving off today un-stamps unsent people, nothing shelved). Plan
  writes go through `planAddBrands` / `planMoveBrand` / `planRemoveBrand` / `planSetCategory`.
  Thin / no-one brands link "LinkedIn people ↗" (`liPeopleUrl`) for the LinkedIn capture script;
  the tab refreshes on focus so a capture shows up. "The rest of …" rows (past a day's 20) have
  **Add** (pins to that day; the fill makes room) and "Other day…". **Plan my week** (`planWeek`
  preview → apply, `undoPlanWeek` via Setting `planWeekLast`; the rules are pure in
  `src/lib/plan-week.ts`, `node scripts/test-plan-week.mjs`): the next 3 sending days — keeps pins
  and Leo's categories, gives each open day a category that can fill it (never the day before's,
  least recently worked first, then accept rate), fills to 20 with whole brands (category →
  `RELATED_CATEGORIES` → the rest), never takes a brand in today's queue; nothing is written until
  Apply. **LinkedIn weekly limit**: ~100 invites per rolling 7 days (`LINKEDIN_WEEK_LIMIT`, warns
  from 80; `getOutreachPlan.linkedinWeek`) — top-right line + a note on any day that would pass it;
  it only warns. **Coverage** (`categoryCoverage`): categories × the last 6 weeks (Mon–Sun, New York),
  invites per week + share accepted (accepted/replied, withdrawn uncounted); 90-day accept rates
  (smoothed, cached 10 min) also order the Fill box's other categories. **Outreach → LinkedIn** = one card per brand
  (sent people stay in their card, `getTodayQueue.sentList`; a finished brand folds to one line).
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
  script expands the contacts list (scroll / "load more") before reading it. Profile lookup
  (`needProfile` → `matched`, and the Brands → Find search) reads only profile links that appear
  after typing into their search (the dashboard's own cards are not results), first line = name,
  Property results dropped; `node scripts/test-capture.js` covers it. Proposals from script ≤4.1
  have no `v` and stay hidden (`PROPOSAL_VERSION`). Lookup calls must send `reader: 2`
  (`LOOKUP_READER`, script ≥4.4); older copies get a 426 "out of date — Check for userscript
  updates". The SB menu shows the version (`SCRIPT_VERSION`, keep = `@version`). The review list (Brands → "Which SponsorUnited
  page is theirs?") only shows brands with something to pick: a search with no results answers
  `none` and parks nothing. **None of these** remembers the pages turned down per brand (Setting
  `suRejected`, `candidatesToOffer`) so a later lookup can't offer them again;
  `node scripts/test-su-match.mjs`.
- `scripts/linkedin-capture.user.js` — **LinkedIn People capture** (second Tampermonkey script, same
  INGEST_TOKEN, kept in GM storage; requests go via `GM_xmlhttpRequest` because LinkedIn's CSP blocks
  page fetches). Leo's calls (Sep 2026): **Leo's LinkedIn account, never Zach's** (Zach's sends the
  connection requests); buyer titles only, **inside the same 25 cap**; no emails — people go to the
  LinkedIn queue (`source: 'linkedin'`, target created, `reconcileBrandTargets` applies).
  **By hand:** on a company's People tab the SB pill scrolls that one page (≤150 people,
  human-paced), posts `action:'liPreview'` (nothing saved; verdicts add/full/dupe/elsewhere/
  notBuyer), then `liCapture` on "Add". Brand match: `brandId` → typed name → saved
  `Brand.linkedinUrl` slug → page name/aka. A brand the dashboard lacks can be **added from the
  panel** ("Add … as a new brand" → `createIfMissing`; category guessed from name + page name +
  LinkedIn industry via `src/lib/category-hints.ts`). The page is saved fill-if-empty unless
  another brand has it.
  **By itself** (Leo asked for it after the one-click version worked, knowing LinkedIn restricts
  script-like browsing): pill → "Fill brands by itself" (also in the Tampermonkey menu). Worklist
  `liList`: brands under 25, not archived/do-not-email, not resting; a focus word first
  (`focusTerms` — "electrolyte" expands to the hydration shelf by name), then emptiest. Per brand:
  no page → LinkedIn company search → `liMatched` (`decideCompanyMatch`: exact name/aka, or a near
  miss only in the top 3 with a fitting industry; else "unclear" → skipped with a note), then the
  People tab (+ "marketing" and "partnerships" views if the tab never ran out), `liCapture` by
  brandId, `liSwept` → Setting `liSweepLog` (`src/lib/li-sweep.ts`; any brand read by a current
  reader rests 30 days, people or not, so a restarted run doesn't redo it; notes show red on
  Outreach → People). Pace (Leo, "faster without being sketchy"): **75 brands/day**, 35–75 s between
  brands, 8–18 s between a brand's pages, same scrolling; then waits for 9am next day. One tab owns the run
  (sessionStorage id); a click or key in it pauses; a login wall, check or "commercial use limit"
  pauses it before any save.
  **Finding new brands** (Leo, Sep 2026: straight into the dashboard, not Discover review): the
  run's setup has "Add brands LinkedIn shows as similar" (lookalike rail — "Pages people also
  viewed" etc. — read **only when the People tab shows it**; the extra company-home stop is gone) and "Search LinkedIn
  for new brands" words (company search, up to 3 result pages each, before the first brand).
  `liDiscover` judges each (`judgeDiscovery`: **5K+ followers**, consumer industry via
  `categoryFromIndustry`, wholesale/agency/software out; a lookalike takes the source brand's
  category when its industry fits), skips known brands (name/aka/page) and anything dismissed on
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
  Worklist in the dashboard: Outreach → People → "Under 25" (deep link `app.html#people`).
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
  starts a run in that tab with the panel's defaults. A run untouched for 10 min (`staleFill`; live
  tabs heartbeat `touchedAt` each minute) no longer blocks a new one (electrolyte first, research list + lookalikes on) — Claude can't run it from the
  cloud; it needs Leo's browser and LinkedIn login. Menu / preview link **"Copy a sample for Claude"** copies what the reader made of
  the first three cards (+ trimmed markup) for Leo to paste when LinkedIn changes its cards again.
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
board), CRM_SHEET_ID.

## Conventions
- **Outreach runs Tuesday / Wednesday / Thursday only** — no Mondays, no Fridays, no weekends —
  **plus one-off extra days** Leo opens with "+ Add a sending day" (Setting `outreachExtraDays`,
  `setExtraSendingDay`; past keys prune). `OUTREACH_DOWS = [2,3,4]` in `src/app/api/data/route.ts`
  (`isOutreachDay(d, extras)`, `planningDays`) — every caller passes the extras; the page reads the
  server's days / `getTodayQueue.sendingDay`, `OUTREACH_DOWS` in app.html is only a fallback. On an
  off day "today" is absent from the schedule, the auto-fill picks nobody and `fillToday` refuses.
  The email machine keeps its own Tue–Thu rule. Anything keyed off "today" compares day keys —
  never "the first row".
- **One category list:** `CATEGORY_KEYS` in `src/lib/category-hints.ts` (same keys, same order as
  `CAT_NAMES` in app.html; used by route.ts, ingest, Stock take). Every path that files a brand
  refuses an unknown key (`checkCategory`). Brands tab: "No category" chip (`listBrands({category:
  'none'})`) and tick-to-re-file with a from → to preview (`setBrandsCategory`, category/tier only).
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
