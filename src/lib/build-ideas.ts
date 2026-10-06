// Home → Today's last card: ideas for building the command center out
// (Leo, Oct 2026: "ideas on how we can build out the command center
// more"). Each is grounded in data the dashboard already has. Leo's
// "Build this" ticks live in Setting `buildIdeaPicks` so the next Claude
// session can read them (`node scripts/cc.mjs dayRecap`). Retire an idea
// by deleting it here once it's built; add new ones at the top.

export type BuildIdea = { id: string; title: string; why: string; area: string }

export const BUILD_IDEAS: BuildIdea[] = [
  { id: 'board-alert', area: 'Show Board', title: 'Board-open alerts',
    why: 'When a brand with a code opens the Show Board, put them in Needs action that day so Zach follows up while they are looking.' },
  { id: 'show-match', area: 'Deals', title: 'Match unsold shows to brands',
    why: 'For each confirmed show with no sponsor, suggest 5 brands by category, genre and state — the pitch list writes itself.' },
  { id: 'weekly-score', area: 'Outreach', title: 'Weekly scoreboard',
    why: 'Invites → accepts → replies → calls → deals per week against a goal you set, so you can see if the machine is working.' },
  { id: 'brand-timeline', area: 'Brands', title: 'One timeline per brand',
    why: 'Every touch on the brand page in order: invites, accepts, emails, opens, board visits, deals — no more piecing it together.' },
  { id: 'stale-deals', area: 'Deals', title: 'Stale deal nudges',
    why: 'Deals with no activity in 14 days show on Home with the last thing that happened and a suggested next step.' },
  { id: 'friday-wrap', area: 'Home', title: 'Friday wrap-up page',
    why: 'The Tue–Thu recaps rolled into one week view you can send to Zach: who went out, who replied, what got found.' },
  { id: 'zach-phone', area: 'Home', title: "Zach's list on a phone",
    why: 'A one-column version of For Zach to do that works on his phone, so the text-back and follow-ups happen on the go.' },
  { id: 'sponsor-report', area: 'Audience', title: 'Sponsor report after a show',
    why: 'Turn an event’s check-ins into a one-page recap for the sponsor (aggregates only) — proof that drives renewals.' },
  { id: 'hunt-to-show', area: 'Discover', title: 'Hunt finds tagged with a show',
    why: 'When the daily brand hunt finds a brand, name the upcoming show it fits best, so Add goes straight to a pitch.' },
]
