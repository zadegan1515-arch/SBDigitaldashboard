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
8. Ask clarifying questions when the request is ambiguous. When reporting back: **what you fixed, what Leo needs to give you** — short, with links. No long explanations.

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
- `public/app.html` — the whole UI. Sections: Home, Brands, Discover, Outreach, Shows, Results,
  Sponsorships, Needs contacts, Pipeline, **Activations** (own workspace: sidebar + tabs swap in),
  **Operations** (ops@ inbox), Materials, Team. Deep links: `#activations/<id>/<tab>`, `#operations/<id>`.
- `src/app/api/data/route.ts` — every server function. Add a handler = add a key to `handlers`.
- `src/lib/email.ts` — outreach: drafting, cap/ramp (`roomToday`), sending via Gmail API, replies, warmup stats, signature (hosted images, LinkedIn/IG as text links).
- `src/lib/google.ts` — OAuth (gmail / drive / ops grants), Gmail read+send, Drive/Sheets/Docs create.
- `src/lib/ops.ts` — Operations inbox: rules classifier (contract / invoice_payable / invoice_receivable / other), 90-day backfill scan, reply/forward as "SB Agency Operations".
- `src/app/api/google/{start,callback}` — OAuth entry/return. `?drive=1`, `?ops=1` pick the grant.
- `src/app/api/ops/attachment` — streams a Gmail attachment to a signed-in user.
- `src/app/api/cron/email` (11:00 UTC: draft, replies, Notion sync, ops scan) · `src/app/api/cron/send` (15:00 UTC).
- `prisma/schema.prisma` — Brand, Contact, OutreachTarget, EmailMessage, Deal, Activation → ActivationEvent → BudgetLine / EventStaff, OpsMessage, Setting (key/value, holds refresh tokens).
- `public/materials/` — one-pager PDF, logo, icons (served, referenced by URL in emails).

## Env vars (names only — Leo sets values in Vercel)
DATABASE_URL · NEXTAUTH_SECRET · GOOGLE_CLIENT_ID/SECRET (sign-in) · GMAIL_CLIENT_ID/SECRET (mail+drive+ops OAuth) ·
EMAIL_SENDER_NAME=Zach · SITE_URL · ANTHROPIC_API_KEY (optional; avoid spend) · NOTION_* ·
AMBASSADOR_PLATFORM_URL · AMBASSADOR_PLATFORM_TOKEN (= platform INTEGRATION_TOKEN) · INGEST_TOKEN · CRON_SECRET ·
optional: SIGNATURE_LINKEDIN_URL, SIGNATURE_INSTAGRAM_URL, SIGNATURE_EMBED=1, SIGNATURE_ICONS=1, OPS_BACKFILL_DAYS.

## Conventions
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
