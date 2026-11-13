# Keys for other tools

Leo, Nov 13 2026: "give me the backend for the command center so people can add
things to it". His picks: a key for another tool, and anything on the site.

A key lets another app, script or Claude chat call the Command Center without
signing in. It calls the same address the site's own buttons call
(`POST /api/data` with `{ "fn": "...", "args": { ... } }`), with the key in the
`Authorization: Bearer sbk_…` header.

## Making one (founding members only)

1. Open **Operations → Team**, scroll to **Keys for other tools**.
2. Type who or what it's for ("Maya", "Zapier"), press **Create key**.
3. **Copy key**. It is shown this once; the site keeps only a fingerprint of it.
4. **Copy instructions** and give both to the person. The key goes in their
   tool's API-key / secret setting, never in a chat or a shared file. The
   instructions tell the tool what to call.

**Revoke** switches a key off at once. What it already added stays. A revoked
key stays listed, with what it changed, for 90 days.

## What a key can do

Whatever a signed-in team member can do on the site: find, add and edit
brands, people, notes, stages, deals, the Schedule, and so on. Every change is
signed with the key's name and listed under the key on Team ("What it
changed"). Reads and previews aren't listed.

## What a key can never do

These stay with a person signed in on the site (`keyBlocked` in
`src/lib/api-keys.ts`):

- change who has access: Team, keys, Show Board access approvals, the LinkedIn
  account lock
- disconnect Google
- send email (sending is off in code as well, rule 7)
- open the operations mailbox
- read, import, merge or delete attendees, or an event's door PIN (rule 9);
  event totals are fine
- open the site itself: a key works on `/api/data` only

Paid AI calls are off for the whole site, a key included.

## The instructions

The text behind **Copy instructions** is `apiGuideText` in
`src/lib/api-guide.ts`. A key can ask for it too: `{"fn":"apiGuide"}` answers
with the text and the name of every function a key may call.
`{"fn":"whoAmI"}` says whether a key works and whose it is.

## Claude's own token

`DASHBOARD_TOKEN` (what `node scripts/cc.mjs` and Claude's cloud sessions use)
is separate and unchanged. It is not one of these keys, isn't listed on Team,
and its changes show on Home → Claude's day.

## Tests

```
node scripts/test-api-keys.mjs
NODE_PATH=$(npm root -g) node scripts/test-api-keys.js
E2E_DATABASE_URL=$(bash scripts/e2e-postgres.sh) node scripts/test-api-keys-e2e.js
```
