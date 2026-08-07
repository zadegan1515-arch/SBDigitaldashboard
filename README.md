# SB Command Center

Sponsor prospecting and LinkedIn outreach for SB Agency.
Standalone — does not touch the sb-crm database.

## Deploying (no terminal needed)

1. Upload **everything in this folder** to the `SBDigitaldashboard` GitHub repo.
   Drag the contents, not the folder itself — `package.json` must sit at the
   repo root, not inside a subfolder. This is the single most common way
   this goes wrong.
2. Vercel → Add New → Project → import the repo → Deploy. **This first
   deploy fails.** No database yet. Expected.
3. Vercel → Storage → Create Database → Neon → Connect Project (tick
   Production). Sets `DATABASE_URL` and `DATABASE_URL_UNPOOLED` for you.
4. Settings → Environment Variables → add these five:

       ANTHROPIC_API_KEY      draft generation
       GOOGLE_CLIENT_ID       reuse sb-crm's
       GOOGLE_CLIENT_SECRET   reuse sb-crm's
       NEXTAUTH_SECRET        any long random string
       ALLOWED_EMAILS         comma-separated, e.g. leo@x.com,zach@x.com

   In Google Cloud Console, add this app's callback as an authorised
   redirect URI on the existing OAuth client:

       https://<your-vercel-url>/api/auth/callback/google

   ALLOWED_EMAILS fails closed — empty or missing means nobody can sign
   in. That is deliberate: a misconfigured variable should never be the
   thing that opens the door.

5. Deployments → Redeploy.

Tables are created automatically. `prisma db push` runs as part of the
build script, so nothing has to be run by hand.

## Files

    prisma/schema.prisma          data model
    src/app/api/data/route.ts     the entire backend, one POST endpoint
    src/app/page.tsx              redirects / to /app.html
    public/app.html               the entire UI, vanilla JS, no build step
    data/brands.json              151 brands in 17 categories, for seeding

## How it talks to itself

The UI calls one endpoint with a function name, same as sb-crm's
`/api/gs` bridge:

    api('getTodayQueue')
    api('setTargetStatus', { targetId, status: 'sent' })

POST `/api/data` with `{fn, args}` → a switch in `route.ts`.
To add a feature, add a handler there and call it from `app.html`.

## Loading data

Once deployed, seed the brands:

    fetch('/api/data', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        fn: 'importBrands',
        args: await fetch('/data/brands.json').then(r => r.json())
      })
    })

Run that in the browser console on the live site. Idempotent — safe to
re-run, it skips brands that already exist.

Contacts come in through `importContacts` with rows shaped like:

    { brandName, name, title, email, location, linkedinUrl, externalId }

Anyone whose title looks like a decision maker AND has a LinkedIn URL
gets a queued target automatically.

## Things that will bite you

**Verify deploys against the live file.** A green Vercel build only means
something compiled, not the right something. Fetch the deployed file and
check.

**esbuild does not type-check.** A wrong Prisma field name compiles clean
locally and fails on Vercel. Check names against `schema.prisma` before
pushing.

**Syntax-check `app.html`** by extracting the `<script>` block and running
`new Function()` on it.

**`DATABASE_URL` is pooled.** Schema changes need `DATABASE_URL_UNPOOLED`,
which is why `directUrl` is set in the schema. Don't remove it.

**LinkedIn caps outreach** near 100 connection requests a week per account.
The daily queue is capped at 10 in `route.ts` (`DAILY_SEND_LIMIT`).
Raising it risks the account being restricted.

## Not done yet

- Voice profile is empty. Until Zach's real messages are loaded via
  `saveVoice`, drafts fall back to a generic tone.
- Accent colour is a placeholder borrowed from a reference design.
  Swap `--accent` in `app.html`.
- No auth. Add NextAuth before this holds anything sensitive.
- Chat tab not built.
