// node scripts/test-brand-fit.mjs — which brands to reach out to (Fit score,
// too small, suggest Archive, research import rows).
import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const out = mkdtempSync(join(tmpdir(), 'fit-test-'))
execSync('npx tsc src/lib/brand-fit.ts --outDir ' + out + ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck', { stdio: 'inherit' })
// tsc emits extensionless relative imports; Node's ESM loader needs ".js".
const fs = await import('node:fs')
for (const f of fs.readdirSync(out)) {
  if (!f.endsWith('.js')) continue
  const p = join(out, f)
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/from '\.\/([\w-]+)'/g, "from './$1.js'"))
}
const { scoreBrand, priorityOf, isTooSmall, dollarsToCents, shortMoney, cleanResearchRow, TOO_SMALL_SALES_CENTS } =
  await import(pathToFileURL(join(out, 'brand-fit.js')).href)

let n = 0
function t(name, fn) { fn(); n++; console.log('  ok — ' + name) }

const now = new Date('2026-10-05T12:00:00Z')
const base = { category: 'energy', reachable: 4, need: 4, acceptRate: 0.3, now }
const M = 1_000_000 * 100

t('dollars in any common spelling → cents; unreadable → null', () => {
  assert.equal(dollarsToCents('$12M'), 12 * M)
  assert.equal(dollarsToCents('12,000,000'), 12 * M)
  assert.equal(dollarsToCents('1.5B'), 1500 * M)
  assert.equal(dollarsToCents('750k'), 75_000_000)
  assert.equal(dollarsToCents(2500000), 250_000_000)
  assert.equal(dollarsToCents('USD 3 million'), 3 * M)
  assert.equal(dollarsToCents('$5M+'), 5 * M)
  assert.equal(dollarsToCents('about 5M'), null)
  assert.equal(dollarsToCents(''), null)
  assert.equal(dollarsToCents(-4), null)
  assert.equal(shortMoney(12 * M), '$12M')
  assert.equal(shortMoney(1500 * M), '$1.5B')
  assert.equal(shortMoney(75_000_000), '$750K')
})

t('too small: sales under $1M; sales known wins over headcount', () => {
  assert.equal(isTooSmall({ salesCents: TOO_SMALL_SALES_CENTS - 1 }).tooSmall, true)
  assert.equal(isTooSmall({ salesCents: TOO_SMALL_SALES_CENTS }).tooSmall, false)
  assert.equal(isTooSmall({ salesCents: 5 * M, liMembers: 8 }).tooSmall, false)
  assert.equal(isTooSmall({ salesCents: 500_000 * 100, liMembers: 300 }).tooSmall, true)
})

t('too small: sales unknown → under 20 people on LinkedIn, measured only', () => {
  assert.equal(isTooSmall({ liMembers: 19 }).tooSmall, true)
  assert.equal(isTooSmall({ liMembers: 20 }).tooSmall, false)
  assert.equal(isTooSmall({ tier: 'emerging' }).tooSmall, false, 'a size guessed from tier never hides')
  assert.equal(isTooSmall({ liMembers: 5, tier: 'established' }).tooSmall, true, 'measured wins over tier')
  assert.equal(isTooSmall({}).tooSmall, false, 'unknown size is never hidden')
  assert.match(isTooSmall({ liMembers: 7 }).why, /7 people/)
})

t('money weighs most: $5M+ raised outranks every other single signal', () => {
  const funded = scoreBrand({ ...base, category: 'tech', reachable: 0, acceptRate: null, fundingCents: 6 * M, lastRoundAt: '2025-06-01' })
  const college = scoreBrand({ ...base, category: 'tech', reachable: 0, acceptRate: null, salesCents: 0, sponsorsCollege: true })
  assert.ok(funded.score > college.score, funded.score + ' vs ' + college.score)
  const moneyReason = funded.reasons.find(r => /raised/.test(r.text))
  assert.ok(moneyReason.points >= 26)
})

t('a recent round adds to funding; an old one does not', () => {
  const fresh = scoreBrand({ ...base, fundingCents: 10 * M, lastRoundAt: '2025-12-01' })
  const old = scoreBrand({ ...base, fundingCents: 10 * M, lastRoundAt: '2020-01-01' })
  assert.equal(fresh.score - old.score, 4)
})

t('sales and funding: only the stronger one counts', () => {
  const both = scoreBrand({ ...base, salesCents: 150 * M, fundingCents: 6 * M })
  const sales = scoreBrand({ ...base, salesCents: 150 * M })
  assert.equal(both.score, sales.score)
})

t('no money known: LinkedIn size stands in', () => {
  const big = scoreBrand({ ...base, liMembers: 900 })
  const target = scoreBrand({ ...base, liMembers: 120 })
  const unknown = scoreBrand({ ...base })
  const small = scoreBrand({ ...base, liMembers: 9 })
  assert.ok(big.score > target.score && target.score > unknown.score && unknown.score > small.score)
  assert.equal(small.tooSmall, true)
})

t('category priority: Top 30, Middle 15, Low 0, Skip 0 (Leo, Oct 7 2026)', () => {
  const pts = (c, priority) => scoreBrand({ ...base, category: c, priority }).reasons.find(r => /priority category/.test(r.text)).points
  for (const c of ['betting', 'spirits', 'rtd', 'alcohol', 'beverage', 'energy', 'electrolytes', 'nicotine']) assert.equal(pts(c), 30, c)
  for (const c of ['apparel', 'athletic', 'tech', 'software', 'fintech']) assert.equal(pts(c), 0, c)
  for (const c of ['beauty', 'wellness', 'cpg', 'qsr']) assert.equal(pts(c), 15, c)
  assert.equal(pts('apparel', 'top'), 30, 'Leo\'s own setting wins over the default')
  assert.equal(scoreBrand({ ...base, category: 'energy', priority: 'skip' }).priority, 'skip')
  assert.equal(priorityOf('apparel', { apparel: 'middle' }), 'middle')
  assert.equal(priorityOf('nonsense'), 'middle')
  assert.equal(priorityOf(null), 'middle', 'no category reads Middle')
  assert.equal(priorityOf('apparel', { apparel: 'bogus' }), 'low', 'a junk saved value falls back to the default, not Middle')
})

t('category beats money unless the gap is huge', () => {
  // A Top-category brand nobody has researched beats a Low-category brand with $50M raised…
  const topUnknown = scoreBrand({ ...base, category: 'spirits' })
  const lowFunded = scoreBrand({ ...base, category: 'apparel', fundingCents: 50 * M })
  assert.ok(topUnknown.score > lowFunded.score, topUnknown.score + ' vs ' + lowFunded.score)
  // …but a tiny Top brand loses to a $100M+ Low one.
  const topTiny = scoreBrand({ ...base, category: 'spirits', liMembers: 8 })
  const lowHuge = scoreBrand({ ...base, category: 'apparel', salesCents: 200 * M })
  assert.ok(lowHuge.score > topTiny.score, lowHuge.score + ' vs ' + topTiny.score)
})

t('score stays 0..100 and every point has a reason', () => {
  const top = scoreBrand({ ...base, salesCents: 900 * M, sponsorsCollege: true, acceptRate: 0.9 })
  assert.equal(top.score, 100)
  assert.equal(top.reasons.reduce((s, r) => s + r.points, 0), 100)
  const bottom = scoreBrand({ category: 'software', reachable: 0, need: 3, acceptRate: 0, now, salesCents: 0, sponsorsCollege: false })
  assert.equal(bottom.score, 0)
})

t('ruled out: only confirmed not in the US; closed / acquired go to suggest Archive', () => {
  assert.equal(scoreBrand({ ...base, usStatus: 'no' }).ruledOut, 'not sold in the US')
  assert.equal(scoreBrand({ ...base, usStatus: 'no' }).archiveWhy, 'not sold in the US')
  const closed = scoreBrand({ ...base, bizStatus: 'closed' })
  assert.deepEqual([closed.ruledOut, closed.bizNote, closed.archiveWhy], [null, 'out of business', 'out of business'])
  const bought = scoreBrand({ ...base, bizStatus: 'acquired', acquiredBy: 'PepsiCo' })
  assert.deepEqual([bought.ruledOut, bought.archiveWhy], [null, 'acquired by PepsiCo'])
  assert.equal(scoreBrand({ ...base, usStatus: 'yes' }).ruledOut, null)
})

t('a parent company\'s brand is never too small by its own page', () => {
  assert.equal(isTooSmall({ liMembers: 6, hasParent: true }).tooSmall, false)
  assert.equal(isTooSmall({ liMembers: 6, hasParent: true, salesCents: 50_000 * 100 }).tooSmall, true, 'known sales still count')
})

t('a parent company\'s brand keeps the parent\'s size in its score', () => {
  const unmeasured = scoreBrand({ ...base, hasParent: true })
  const tinyPage = scoreBrand({ ...base, hasParent: true, liMembers: 6 })
  assert.equal(tinyPage.score, unmeasured.score)
  assert.equal(tinyPage.size, 'big')
})

t('learning a little never scores below knowing nothing', () => {
  const target = scoreBrand({ ...base, liMembers: 200 })
  const smallRound = scoreBrand({ ...base, liMembers: 200, fundingCents: 2 * M })
  assert.ok(smallRound.score >= target.score, smallRound.score + ' vs ' + target.score)
  const unknown = scoreBrand({ ...base })
  const sales = scoreBrand({ ...base, salesCents: 2 * M })
  assert.ok(sales.score >= unknown.score)
})

t('US unknown: kept, tagged US?', () => {
  const r = scoreBrand({ ...base })
  assert.equal(r.ruledOut, null)
  assert.equal(r.usUnknown, true)
  assert.equal(scoreBrand({ ...base, usStatus: 'yes' }).usUnknown, false)
})

t('low fit + no signal → suggested only once researched', () => {
  const weak = { category: 'software', reachable: 0, need: 3, acceptRate: 0.05, now, salesCents: 300_000 * 100, fundingCents: 0, sponsorsCollege: false }
  assert.equal(scoreBrand(weak).archiveWhy, null, 'not researched → never suggested on score')
  assert.match(scoreBrand({ ...weak, researchedAt: '2026-10-05' }).archiveWhy, /low fit/)
  // Research that found nothing is not "no signal".
  assert.equal(scoreBrand({ ...weak, researchedAt: '2026-10-05', salesCents: null }).archiveWhy, null, 'sales not found')
  assert.equal(scoreBrand({ ...weak, researchedAt: '2026-10-05', fundingCents: null, liMembers: 3000 }).archiveWhy, null, 'funding not found: not "no budget"')
  assert.equal(scoreBrand({ ...weak, researchedAt: '2026-10-05', sponsorsCollege: null }).archiveWhy, null, 'sponsorships not found')
  // Any one signal keeps it off the list.
  assert.equal(scoreBrand({ ...weak, researchedAt: '2026-10-05', sponsorsCollege: true }).archiveWhy, null)
  assert.equal(scoreBrand({ ...weak, researchedAt: '2026-10-05', category: 'energy' }).archiveWhy, null)
  assert.equal(scoreBrand({ ...weak, researchedAt: '2026-10-05', fundingCents: 5 * M }).archiveWhy, null)
})

t('research rows: dollars parsed, unknown fields left alone, bad values refused', () => {
  const { row } = cleanResearchRow({ name: 'Liquid Death', sales: '$263M', funding: '267M', lastRound: '2024-03', us: 'yes', sponsorsCollege: 'yes', sponsorNote: 'festivals', status: 'active' })
  assert.equal(row.salesCents, 263 * M)
  assert.equal(row.fundingCents, 267 * M)
  assert.equal(row.lastRoundAt, '2024-03-01')
  assert.equal(row.usStatus, 'yes')
  assert.equal(row.sponsorsCollege, true)
  assert.equal(row.bizStatus, 'active')
  const partial = cleanResearchRow({ name: 'X', us: 'unknown' }).row
  assert.equal('salesCents' in partial, false, 'missing key = leave as is')
  assert.equal(partial.usStatus, null)
  assert.match(cleanResearchRow({ name: 'X', sales: 'lots' }).error, /not an amount/)
  assert.match(cleanResearchRow({ name: 'X', lastRound: 'spring 2024' }).error, /YYYY-MM/)
  assert.match(cleanResearchRow({ name: 'X', lastRound: '2024-13' }).error, /YYYY-MM/, 'no month 13')
  assert.match(cleanResearchRow({ name: 'X', lastRound: '2024-00' }).error, /YYYY-MM/)
  assert.match(cleanResearchRow({ name: 'X', lastRound: '2024-02-30' }).error, /YYYY-MM/, 'not rolled into March')
  assert.equal(cleanResearchRow({ name: 'X', lastRound: '2024-02-29' }).row.lastRoundAt, '2024-02-29')
  assert.match(cleanResearchRow({ name: 'X', us: 'maybe' }).error, /yes \/ no/)
  assert.match(cleanResearchRow({ sales: 1 }).error, /no name/)
})

console.log(n + ' passed')
