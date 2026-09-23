// src/lib/region.ts
//
// SB books college shows in the United States. A contact who runs
// marketing for EMEA South is never going to buy one, but they arrive in
// the same SponsorUnited capture as everyone else and then sit in the
// queue eating a slot out of the twenty a day.
//
// This only labels them. Leo asked for a flag, not a filter: nothing is
// dropped, nothing is un-queued, the tag just shows on the row so he can
// judge. Deliberately conservative — an unrecognised location returns
// null rather than guessing "foreign", because wrongly hiding a real US
// buyer costs more than showing an extra tag.

// The region words that appear in titles: "Head of Marketing | EMEA South".
const TITLE_REGIONS: Array<[RegExp, string]> = [
  [/\bEMEA\b/i, 'EMEA'],
  [/\bAPAC\b|\bASEAN\b/i, 'APAC'],
  [/\bLATAM\b|\bLAC\b/i, 'LATAM'],
  [/\bANZ\b|\bAustralasia\b/i, 'APAC'],
  [/\bUK(?:\s*&\s*I)?\b|\bUnited Kingdom\b/i, 'UK'],
  [/\bDACH\b|\bBenelux\b|\bNordics?\b|\bIberia\b/i, 'Europe'],
]

// Countries we see most in SponsorUnited data. Not exhaustive on
// purpose: a country nobody has ever appeared from is better left
// unlabelled than guessed at.
const COUNTRIES: Array<[RegExp, string]> = [
  [/\bUnited Kingdom\b|\bEngland\b|\bScotland\b|\bWales\b|\bLondon\b/i, 'UK'],
  [/\bIreland\b|\bDublin\b/i, 'Ireland'],
  [/\bGermany\b|\bDeutschland\b|\bBerlin\b|\bMunich\b|\bHamburg\b/i, 'Germany'],
  [/\bFrance\b|\bParis\b/i, 'France'],
  [/\bSpain\b|\bMadrid\b|\bBarcelona\b/i, 'Spain'],
  [/\bItaly\b|\bMilan\b|\bRome\b/i, 'Italy'],
  [/\bNetherlands\b|\bAmsterdam\b|\bHolland\b/i, 'Netherlands'],
  [/\bSwitzerland\b|\bZurich\b|\bGeneva\b/i, 'Switzerland'],
  [/\bSweden\b|\bStockholm\b|\bDenmark\b|\bCopenhagen\b|\bNorway\b|\bOslo\b|\bFinland\b|\bHelsinki\b/i, 'Nordics'],
  [/\bPoland\b|\bWarsaw\b|\bPortugal\b|\bLisbon\b|\bAustria\b|\bVienna\b|\bBelgium\b|\bBrussels\b/i, 'Europe'],
  [/\bAustralia\b|\bSydney\b|\bMelbourne\b|\bNew Zealand\b/i, 'APAC'],
  [/\bSingapore\b|\bJapan\b|\bTokyo\b|\bChina\b|\bShanghai\b|\bHong Kong\b|\bIndia\b|\bMumbai\b|\bBengaluru\b|\bBangalore\b|\bKorea\b|\bSeoul\b/i, 'APAC'],
  [/\bBrazil\b|\bSão Paulo\b|\bSao Paulo\b|\bMexico\b|\bArgentina\b|\bColombia\b|\bChile\b/i, 'LATAM'],
  [/\bUnited Arab Emirates\b|\bDubai\b|\bIsrael\b|\bTel Aviv\b|\bSaudi\b|\bQatar\b/i, 'Middle East'],
  [/\bSouth Africa\b|\bNigeria\b|\bKenya\b|\bEgypt\b/i, 'Africa'],
]

const CANADA = /\bCanada\b|\bToronto\b|\bVancouver\b|\bMontreal\b|\bOntario\b|\bQuebec\b|\bAlberta\b|\bBritish Columbia\b/i

const US_STATES = [
  'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut',
  'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa',
  'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan',
  'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada',
  'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina',
  'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island',
  'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont',
  'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming',
  'District of Columbia', 'Washington DC', 'Puerto Rico',
]
const US_STATE_RE = new RegExp('\\b(' + US_STATES.join('|') + ')\\b', 'i')
const US_WORDS = /\bUnited States\b|\bUSA\b|\bU\.S\.A?\b|\bAmerica\b(?!s)/i

export type RegionFlag = { label: string; why: 'title' | 'location' } | null

// A label when this person is plainly not buying US college shows, or
// null when they look domestic or we simply can't tell.
export function regionFlag(location: string | null, title: string | null): RegionFlag {
  const t = String(title ?? '')
  // "Head of Marketing, North America" is a US role even if the person
  // sits in Toronto, so the title is read first and its region wins.
  if (/\bNorth America\b|\bNAM\b|\bUS\b|\bU\.S\.\b|\bAmericas\b/i.test(t)) return null
  for (const [re, label] of TITLE_REGIONS) if (re.test(t)) return { label, why: 'title' }

  const loc = String(location ?? '').trim()
  if (!loc) return null
  // A US state or "United States" settles it, even in a string like
  // "San Antonio, Texas Metropolitan Area" that never names the country.
  if (US_WORDS.test(loc) || US_STATE_RE.test(loc)) return null
  if (CANADA.test(loc)) return null   // close enough to sell to
  for (const [re, label] of COUNTRIES) if (re.test(loc)) return { label, why: 'location' }
  return null
}
