// node scripts/test-claude-day.mjs — Claude's day (src/lib/claude-day.ts):
// which Claude calls are changes and how they read, and how a commit reads.
import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const out = mkdtempSync(join(tmpdir(), 'claude-day-test-'))
execSync('npx tsc src/lib/claude-day.ts --outDir ' + out + ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck', { stdio: 'inherit' })
const C = await import(pathToFileURL(join(out, 'claude-day.js')).href)

let n = 0
function t(name, fn) { fn(); n++; console.log('  ok — ' + name) }

t('reads, previews, refusals and the work log are never changes', () => {
  assert.equal(C.actionText('getBrand', { brandId: 'b1' }, {}), null)
  assert.equal(C.actionText('listDiscoveries', {}, {}), null)
  assert.equal(C.actionText('zachTodo', { brandId: 'b1' }, {}), null)
  assert.equal(C.actionText('combineParent', { parent: 'Diageo' }, { applied: false }), null, 'a preview')
  assert.equal(C.actionText('mergePeople', { brandId: 'b' }, { stale: true }), null, 'stale')
  assert.equal(C.actionText('reviewNewBrands', { ids: ['a'], action: 'archive', preview: true }, { preview: true }), null)
  assert.equal(C.actionText('planWeek', {}, { days: [] }), null, 'Plan my week only changes with apply')
  assert.equal(C.actionText('addWorkLog', { text: 'x' }, { saved: 1 }), null, 'the log shows as its own card')
  assert.equal(C.actionText('me', {}, {}), null)
  assert.equal(C.actionText('deleteBrand', { brandId: 'b' }, { deleted: false, summary: {} }), null, 'a delete preview')
  assert.equal(C.actionText('researchImport', { stagedAt: 'x' }, { changes: [] }), null, 'previews unless preview: false')
  assert.equal(C.actionText('undoPlanWeek', {}, { ok: false, message: 'Nothing to undo' }), null, 'a refusal')
  assert.equal(C.actionText('queueBrandTargets', { brandId: 'b' }, { queued: false, reason: 'notus' }), null)
  assert.equal(C.actionText('mergeBrands', { fromId: 'a', toId: 'b' }, { merged: false }), null, 'merge preview')
})

t('merges are changes (mergeX is not a read)', () => {
  assert.equal(C.actionText('mergePeople', { brandId: 'b', confirm: true, expect: 'x' }, { applied: true, brand: { name: 'Acme' } }), 'Merged people on file twice at Acme')
  assert.equal(C.actionText('mergeBrands', { fromId: 'a', toId: 'b', confirm: true }, { merged: true }), 'Merge brands')
  assert.equal(C.actionText('researchImport', { preview: false }, { updated: 4 }), 'Saved reviewed Brand Fit facts for 4 brands')
})

t('known changes read in words', () => {
  assert.equal(C.actionText('combineParent', { parent: 'Diageo', confirm: true }, { applied: true, brands: [1, 2, 3] }), "Combined Diageo's brands into one (3 brands)")
  assert.equal(C.actionText('chatAddBrand', { brand: { name: 'Koloa Rum' }, apply: true }, { brand: { name: 'Koloa Rum' }, factsWritten: 3 }), 'Added Koloa Rum from the Add a brand chat (with its facts)')
  assert.equal(C.actionText('researchStage', { rows: [{}, {}] }, { staged: 2 }), 'Staged Brand Fit research for 2 brands — waiting for your review')
  assert.equal(C.actionText('reviewNewBrands', { ids: ['a', 'b'], action: 'archive' }, { ok: true, archived: 2 }), 'Archived 2 brands from New from LinkedIn')
  assert.equal(C.actionText('saveHandTemplate', { kind: 'final', body: '…' }, {}), "Saved the final message template on Zach's list")
  assert.equal(C.actionText('importContacts', { rows: [1, 2, 3], source: 'research' }, { added: 2 }), 'Added 2 people (research)')
})

t('anything else: its name in words and what it was about', () => {
  assert.equal(C.fnWords('setExtraSendingDay'), 'Set extra sending day')
  assert.equal(C.actionText('setExtraSendingDay', { day: '2026-10-16', on: true }, { ok: true }), 'Set extra sending day — 2026-10-16')
})

t('kept args are short: no long text, lists as counts, no server args', () => {
  const b = C.argsBrief({ brandId: 'b1', rows: [1, 2], text: 'x'.repeat(200), confirm: true, __user: 'CLI' })
  assert.equal(b, 'brandId=b1 rows=[2] confirm=true')
})

t('a commit: title and its points, trailers out; merges and non-Claude commits left out', () => {
  const msg = 'Brand page: Zach\'s list steps\n\nThe same card as Home\'s list sits under an accepted\nperson\'s row.\n\n- A step redraws in place.\n- Undo refills the cards.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_x'
  const c = C.readCommit({ sha: '1c4fe1a7be42', html_url: 'https://github.com/x/y/commit/1c4fe1a', commit: { message: msg, committer: { date: '2026-10-13T21:30:00Z' } } })
  assert.equal(c.title, "Brand page: Zach's list steps")
  assert.deepEqual(c.lines, ["The same card as Home's list sits under an accepted person's row.", 'A step redraws in place.', 'Undo refills the cards.'])
  assert.equal(c.sha, '1c4fe1a')
  assert.equal(C.readCommit({ sha: 'a', commit: { message: "Merge remote-tracking branch 'origin/main'\n\nClaude-Session: x" } }), null)
  assert.equal(C.readCommit({ sha: 'a', commit: { message: 'Fix typo by hand' } }), null, 'only Claude\'s commits')
})

console.log('claude-day: all ' + n + ' passed')
