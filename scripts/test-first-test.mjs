// scripts/test-first-test.mjs — guards src/lib/first-test.ts: which first
// LinkedIn message gets answered (Leo, Oct 18 2026: version A = his first
// message, B = his test version; split by brand). Run: node scripts/test-first-test.mjs
import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const out = mkdtempSync(join(tmpdir(), 'first-test-'))
execSync('npx tsc src/lib/first-test.ts --outDir ' + out + ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck', { stdio: 'inherit' })
for (const f of readdirSync(out).filter(f => f.endsWith('.js'))) {
  const p = join(out, f)
  writeFileSync(p, readFileSync(p, 'utf8').replace(/from '(\.\/[^']+)'/g, "from '$1.js'"))
}
const { versionOf, isVersion, testOn, answeredAt, firstTestTable, JUDGE_DAYS, FEW } = await import(pathToFileURL(join(out, 'first-test.js')).href)

let n = 0
const t = (name, fn) => { fn(); n++; console.log('  ok — ' + name) }
const now = new Date('2026-11-20T16:00:00Z')
const ago = (d) => new Date(now.getTime() - d * 864e5)
const row = (x = {}) => ({ variant: 'A', dmSentAt: ago(20), ...x })

t('every brand is A or B, always the same one, about half each', () => {
  const ids = Array.from({ length: 2000 }, (_, i) => 'cm' + (i * 7919).toString(36) + 'brand' + i)
  const vs = ids.map(versionOf)
  assert.ok(vs.every(v => v === 'A' || v === 'B'))
  assert.deepEqual(ids.slice(0, 50).map(versionOf), vs.slice(0, 50), 'stable')
  const b = vs.filter(v => v === 'B').length
  assert.ok(b > 900 && b < 1100, 'about half: ' + b)
  assert.deepEqual([isVersion('A'), isVersion('B'), isVersion('C'), isVersion(null)], [true, true, false, false])
})
t('the test is on unless Leo stopped it', () => {
  assert.deepEqual([testOn(null), testOn({ on: true }), testOn({ on: false }), testOn('x')], [true, true, false, true])
})
t('an answer: a reply, a path picked, a call booked or a no — the earliest', () => {
  assert.equal(answeredAt(row()), null)
  assert.equal(answeredAt(row({ repliedAt: ago(5), callBookedAt: ago(3) })), ago(5).getTime())
  assert.equal(answeredAt(row({ wantsEmailAt: ago(6) })), ago(6).getTime())
  assert.equal(answeredAt(row({ declinedAt: ago(4) })), ago(4).getTime())
  assert.equal(answeredAt(row({ status: 'replied', updatedAt: ago(7) })), ago(7).getTime(), 'a reply with no date: its last change')
})
t('answered before the final reach-out counts; after it, or never, is judged unanswered', () => {
  const r = firstTestTable([
    row({ repliedAt: ago(15) }),                                   // A: answered
    row({ nudgedAt: ago(10), repliedAt: ago(5) }),                 // A: answered after the final → no
    row({ nudgedAt: ago(10) }),                                    // A: final sent, no answer
    row({ dmSentAt: ago(JUDGE_DAYS) }),                            // A: due day reached, no answer
    row({ dmSentAt: ago(3) }),                                     // A: still waiting
    row({ variant: 'B', declinedAt: ago(12) }),                    // B: said no (an answer)
    row({ variant: 'B', repliedAt: ago(14) }),                     // B: answered
    row({ variant: 'B', dmSentAt: ago(2), repliedAt: ago(1) }),    // B: answered fast (judged now)
  ], now)
  const [a, b] = r.versions
  assert.deepEqual([a.key, a.sent, a.judged, a.answered, a.saidNo, a.waiting], ['A', 5, 4, 1, 0, 1])
  assert.equal(a.rate, 1 / 4)
  assert.deepEqual([b.key, b.sent, b.judged, b.answered, b.saidNo, b.waiting], ['B', 3, 3, 3, 1, 0])
  assert.equal(a.few, true, 'under ' + FEW + ': too few to tell')
  assert.equal(r.startedAt, ago(20).toISOString())
})
t('left out: no version (before the test, a rewritten card), no first message, an answer before the message', () => {
  const r = firstTestTable([
    row({ variant: null }), row({ variant: 'own' }), row({ dmSentAt: null }),
    row({ repliedAt: ago(25) }),   // answered before the first message (sent 20 days ago)
  ], now)
  assert.deepEqual(r.versions.map(v => v.sent), [0, 0])
  assert.deepEqual(r.versions.map(v => v.rate), [null, null])
  assert.equal(r.startedAt, null)
})
console.log(n + ' first-test tests passed')
