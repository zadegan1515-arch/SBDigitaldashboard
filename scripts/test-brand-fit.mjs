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
const { scoreBrand, isTooSmall, dollarsToCents, shortMoney, cleanResearchRow, TOO_SMALL_SALES_CENTS } =
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

t('18–24 categories score, others do not', () => {
  for (const c of ['energy', 'electrolytes', 'rtd', 'spirits', 'nicotine', 'betting', 'apparel', 'athletic', 'beauty']) {
    assert.equal(scoreBrand({ ...base, category: c }).reasons.find(r => /18–24/.test(r.text)).good, true, c)
  }
  assert.equal(scoreBrand({ ...base, category: 'software' }).reasons.find(r => /18–24/.test(r.text)).good, false)
})

t('score stays 0..100 and every point has a reason', () => {
  const top = scoreBrand({ ...base, salesCents: 900 * M, sponsorsCollege: true, acceptRate: 0.9 })
  assert.equal(top.score, 100)
  assert.equal(top.reasons.reduce((s, r) => s + r.points, 0), 100)
  const bottom = scoreBrand({ category: null, reachable: 0, need: 3, acceptRate: 0, now, salesCents: 0, sponsorsCollege: false })
  assert.equal(bottom.score, 0)
})

t('ruled out: confirmed not in the US, closed, acquired → suggest Archive', () => {
  assert.equal(scoreBrand({ ...base, usStatus: 'no' }).ruledOut, 'not sold in the US')
  assert.equal(scoreBrand({ ...base, usStatus: 'no' }).archiveWhy, 'not sold in the US')
  assert.equal(scoreBrand({ ...base, bizStatus: 'closed' }).ruledOut, 'out of business')
  assert.equal(scoreBrand({ ...base, bizStatus: 'acquired', acquiredBy: 'PepsiCo' }).ruledOut, 'acquired by PepsiCo')
  assert.equal(scoreBrand({ ...base, usStatus: 'yes' }).ruledOut, null)
})

t('US unknown: kept, tagged US?', () => {
  const r = scoreBrand({ ...base })
  assert.equal(r.ruledOut, null)
  assert.equal(r.usUnknown, true)
  assert.equal(scoreBrand({ ...base, usStatus: 'yes' }).usUnknown, false)
})

t('low fit + no signal → suggested only once researched', () => {
  const weak = { category: 'software', reachable: 0, need: 3, acceptRate: 0.05, now, salesCents: 300_000 * 100, sponsorsCollege: false }
  assert.equal(scoreBrand(weak).archiveWhy, null, 'not researched → never suggested on score')
  assert.match(scoreBrand({ ...weak, researchedAt: '2026-10-05' }).archiveWhy, /low fit/)
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
  assert.match(cleanResearchRow({ name: 'X', us: 'maybe' }).error, /yes \/ no/)
  assert.match(cleanResearchRow({ sales: 1 }).error, /no name/)
})

console.log(n + ' passed')
