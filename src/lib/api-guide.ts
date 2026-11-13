// src/lib/api-guide.ts
//
// The instructions that go with a key (src/lib/api-keys.ts): what Leo copies
// from Operations → Team ("Copy instructions") and hands to the person or
// tool that holds the key, and what `apiGuide` answers to the key itself.
// Written for a tool or an AI chat to follow, in plain words. The lists
// (categories, stages, kinds) are read from the code, so they can't drift;
// GUIDE_FNS is every function the text names — the tests check each one
// exists and is open to a key. node scripts/test-api-keys.mjs

import { CATEGORY_KEYS } from './category-hints'
import { LOG_KINDS, TALKS_ENDS, TALKS_STAGES } from './in-talks'

export const GUIDE_FNS = [
  'whoAmI', 'apiGuide',
  'search', 'brandLookup', 'getBrand', 'listBrands',
  'createBrand', 'addBrandsBulk', 'updateBrand',
  'upsertContact',
  'addBrandNote', 'editBrandNote',
  'setTalksStage', 'addTalksEvent', 'talksLog',
  'upsertDeal', 'listDeals',
] as const

const TIERS = ['emerging', 'growth', 'established']

export function apiGuideText(base: string, opts: { dealStages: readonly string[] }): string {
  const site = String(base || '').replace(/\/+$/, '')
  const cats = CATEGORY_KEYS.join(' · ')
  const stages = [...TALKS_STAGES, ...TALKS_ENDS].map(s => s.key).join(' | ')
  const kinds = LOG_KINDS.map(k => k.key).join(' | ')
  const deals = opts.dealStages.join(' | ')
  return `SB COMMAND CENTER — ADDING THINGS WITH A KEY

You have a key for SB Agency's Command Center, the dashboard where the team keeps
its brands, the people at them, notes and deals. With the key you can do what a
signed-in team member does on the site, by calling one web address.

Keep the key private. Never print it, never paste it into a chat, never put it
in code or a file other people can see — keep it in your tool's secret / API-key
setting. Whoever gave it to you sees every change it makes, and can switch it
off at any time.

THE CALL

  POST ${site}/api/data
  Authorization: Bearer <the key>
  Content-Type: application/json

  {"fn": "<function>", "args": { ... }}

The answer is {"ok": true, "data": ...} or {"ok": false, "error": "why, in words"}.

  curl -s ${site}/api/data \\
    -H "Authorization: Bearer $SB_KEY" -H "Content-Type: application/json" \\
    -d '{"fn":"whoAmI"}'

whoAmI says whether the key works and whose it is. Start there.

RULES

1. Look before you add. Call brandLookup first: a brand or a person already on
   file is never added a second time.
2. Brands and people are addressed by id (from brandLookup, search or getBrand),
   not by name.
3. Money is whole cents: $1,750 is 175000. Never decimals.
4. Anything that deletes, merges or changes many things at once answers with a
   preview first. Show the person exactly what would change, and only on their
   yes call it again with what the preview asks for (apply: true or
   confirm: true). Never skip the preview.
5. An error is an answer. "error" says why in plain words (already on file,
   unknown category, this person doesn't want to be contacted). Tell the person;
   don't try another way around it.
6. A key cannot change who has access, send email, open the operations mailbox,
   or read the people who came to events (event totals only).

FIND

  search        {q}                    brands, people, sponsorships and shows matching the words
  brandLookup   {q}                    brands [{id, name, category, archived}] and exact
                                       (true = already on the roster under that name)
  getBrand      {brandId}              the brand with its people (brand.contacts), notes, deals, outreach
  listBrands    {search?, category?, take?}

ADD A BRAND

  createBrand   {name, category?, tier?, website?, linkedinUrl?, notes?}
                answers {brand, created}; created false = it was already there, nothing changed
    category    ${cats}
    tier        ${TIERS.join(' | ')}

  addBrandsBulk {text, category?, tier?}
                text = one brand per line, a website after a comma if you have it.
                Answers a preview {create, existing}; the same call with apply: true adds them.

  A person who isn't a brand (someone to send the Show Board to):
  createBrand   {kind: "person", name, email?, phone?}

EDIT A BRAND

  updateBrand   {brandId, ...only what changes}
                website, linkedinUrl, category, tier, aka (other names, comma separated),
                about, topProducts, hq, owner

ADD A PERSON AT A BRAND

  upsertContact {brandId, name, title?, email?, phone?, location?, linkedinUrl?, notes?}
                Someone with a buyer title and a LinkedIn link also joins that brand's
                outreach queue, the same as "+ Add person" on the site.
  upsertContact {id, ...only what changes}      edits a person already on file

NOTES

  addBrandNote  {brandId, text}        a dated note on the brand, signed with the key's name
  editBrandNote {id, text}

WHERE A BRAND STANDS (Deals → In talks)

  setTalksStage {brandId, stage, day?, note?}
    stage       ${stages}
  addTalksEvent {brandId, kind, day?, text?}    something that happened, on its day
    kind        ${kinds}   (other needs text)
    day         "YYYY-MM-DD", today or earlier; left out = now
  talksLog      {brandId}              everything logged at that brand, newest first

DEALS

  upsertDeal    {brandId, name, stage?, valueCents?, notes?, owner?}
    stage       ${deals}
  upsertDeal    {id, ...only what changes}
  listDeals     {}

EVERYTHING ELSE

Every button on the site is a function here. apiGuide answers with this text and
"functions", the name of every function a key may call. Ask the person who gave
you the key before using one that isn't described above.
`
}
