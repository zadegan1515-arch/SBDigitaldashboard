# In talks — Claude's daily check

Leo, Oct 18 2026: every brand on the **In talks** tab (a call booked on Zach's list, or added by hand)
gets an **overview** (at most 4 sentences), an **activation idea**, and its **website / Instagram /
TikTok**. A Claude session fills whatever is missing once a day. No API spend — you are the writer.
Only write the In talks fields below; never send email, never change outreach, never touch other data.

## Each run

1. `node scripts/cc.mjs listTalksToFill` → `brands[]`, each with `missing` (any of `overview`, `idea`,
   `website`, `instagram`, `tiktok`) and what's known (category, LinkedIn page, about, people and their
   stage, the latest notes). Nothing listed → stop; log nothing.
2. For each brand, research the open web (WebSearch / WebFetch; `curl` if WebFetch can't resolve a host):
   - **website** — the official US site.
   - **instagram / tiktok** — the brand's official US account. Count it only when the brand's own site
     links it, it has a verified badge, or the brand's press release names it. Can't confirm → leave the
     field out (it stays on the list for tomorrow). Sure they have none → send `"none"`.
   - **overview** — at most 4 sentences, plain English, beyond basic facts: what they sell and to whom,
     recent momentum (funding, retail, owner, acquisitions), how they market (athletes, music, college,
     events, sponsorships), and why they fit college concerts. Only what sources support. The server
     refuses 5 or more sentences from a Claude session.
   - **idea** — one SB Agency activation: a title (8 words max) on the first line, a blank line, then 3–5
     plain sentences: what happens at the show; what happens on campus before show day; the content
     piece; what we report back (totals only — students reached, samples, content pieces, impressions;
     never anyone's personal details). Make it this brand's: its product, its existing marketing, the
     people we're talking to and Leo's notes. **Alcohol brands** (categories rtd, spirits, alcohol): 21+
     shows only, the licensed venue pours, nothing goes to chapter houses or anyone under 21.
3. Write it — only the fields you have, `onlyEmpty: true` so nothing a person wrote is replaced:
   ```
   node scripts/cc.mjs saveTalksProfile @/tmp/talks-<brand>.json
   { "brandId": "…", "onlyEmpty": true, "overview": "…", "activationIdea": "Title\n\n…",
     "website": "…", "instagramUrl": "https://www.instagram.com/<handle>/", "tiktokUrl": "https://www.tiktok.com/@<handle>" }
   ```
4. Something Leo should know before the call (a new CEO, an acquisition, the contact isn't the buyer,
   a look-alike company to avoid) → one short note: `node scripts/cc.mjs addBrandNote '{"brandId":"…","text":"…"}'`.
5. Log the run: `node scripts/cc.mjs addWorkLog '{"text":"In talks daily check: wrote the profile for X, Y"}'`
   (a NEED block only if Leo has to do something).

## About SB Agency (for the ideas)

The largest college concert producer in the US: 500+ shows a year in 100+ tier-1 college markets, run
with 100+ Greek-life (fraternity and sorority) campus networks. What a brand can buy: presence inside
the shows (sampling, pop-ups, stage / concourse / perimeter signage), campus seeding before show day
(house drops to Greek chapters, managed student ambassadors), a content engine (our pro photo and video
crews, student UGC, full commercial rights to the media), and data-backed recaps. Some shows are 21+.
Money lines stay apart: never add activation costs to sponsorship fees or show booking money.
