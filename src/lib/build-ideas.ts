// Home → Today's last card: ideas for building the command center out
// (Leo, Oct 2026: "ideas on how we can build out the command center
// more"). Each is grounded in data the dashboard already has. Leo's
// "Build this" ticks live in Setting `buildIdeaPicks` so the next Claude
// session can read them (`node scripts/cc.mjs dayRecap`). Retire an idea
// by deleting it here once it's built; add new ones at the top.

export type BuildIdea = { id: string; title: string; why: string; area: string }

export const BUILD_IDEAS: BuildIdea[] = [
  // Built Oct 6 2026 and retired from here: weekly scoreboard, brand
  // timeline, stale deal nudges, Friday wrap-up, Zach's list on a phone,
  // sponsor report after a show.
  { id: 'reply-inbox', area: 'Outreach', title: 'One inbox for every reply',
    why: 'LinkedIn accepts, LinkedIn replies and email replies in one list on Home, newest first, each with its next step.' },
  { id: 'su-batch', area: 'Brands', title: 'SponsorUnited lookups in bulk',
    why: 'Tick the brands with nobody on file and the SponsorUnited script looks them all up in one go, instead of one brand page at a time.' },
  { id: 'deal-forecast', area: 'Deals', title: 'Deal forecast',
    why: 'What the open deals are likely worth this month, weighted by stage — sponsorship money only, on its own line.' },
  { id: 'board-alert', area: 'Show Board', title: 'Board-open alerts',
    why: 'When a brand with a code opens the Show Board, put them in Needs action that day so Zach follows up while they are looking.' },
  { id: 'show-match', area: 'Deals', title: 'Match unsold shows to brands',
    why: 'For each confirmed show with no sponsor, suggest 5 brands by category, genre and state — the pitch list writes itself.' },
  { id: 'hunt-to-show', area: 'Discover', title: 'Hunt finds tagged with a show',
    why: 'When the daily brand hunt finds a brand, name the upcoming show it fits best, so Add goes straight to a pitch.' },
]
