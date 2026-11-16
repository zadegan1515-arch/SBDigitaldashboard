// node scripts/test-cold-templates.mjs — the cold emails Instantly sends
// (Leo, Nov 16 2026; src/lib/cold-templates.ts): the words come from
// Email → Templates (email-templates.ts), one Instantly campaign per campaign
// key — which campaign a brand's category goes to (its own, its family's, the
// general one), a key's three emails, the dashboard's placeholders ⇄
// Instantly's, the emails as Instantly's sequence and back (Leo's waits
// kept), whether a campaign still says what the dashboard says and which part
// doesn't, the campaign a key gets — and each person's own Show Board link
// (src/lib/board-key.ts).
import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const out = mkdtempSync(join(tmpdir(), 'cold-templates-test-'))
execSync('npx tsc src/lib/cold-templates.ts src/lib/board-key.ts --outDir ' + out + ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck --types node', { stdio: 'inherit' })
for (const f of readdirSync(out).filter(f => f.endsWith('.js'))) {
  const p = join(out, f)
  writeFileSync(p, readFileSync(p, 'utf8').replace(/from '(\.\/[^']+)'/g, "from '$1.js'"))
}
const T = await import(pathToFileURL(join(out, 'cold-templates.js')).href)
const E = await import(pathToFileURL(join(out, 'email-templates.js')).href)
const C = await import(pathToFileURL(join(out, 'category-hints.js')).href)
const B = await import(pathToFileURL(join(out, 'board-key.js')).href)

let n = 0
function t(name, fn) { fn(); n++; console.log('  ok — ' + name) }
const SIG = 'Zach Goldstein\nCo-CEO, SB Agency\n1 Main St, New York, NY'
const ANGLES = { energy: { insert: 'Cold cans for {brand}.' }, '': { insert: 'Ideas for {brand}.' } }
const has = (...keys) => k => keys.includes(k)

// ---- which campaign a brand goes to
t('Leo’s picks have a row from the start; a campaign key is "general" or a category', () => {
  assert.deepEqual(T.MAIN_KEYS, ['energy', 'alcohol', 'nicotine', 'beauty', 'cpg', 'general'])
  for (const k of ['general', ...C.CATEGORY_KEYS]) assert.equal(T.isCampaignKey(k), true, k)
  for (const k of ['', 'food', 'cat:energy', 'intro', 'toString', '__proto__', null, undefined]) assert.equal(T.isCampaignKey(k), false, String(k))
  // No category sits in two families, and every family category is a real one.
  const all = T.FAMILIES.flatMap(f => [f.key, ...f.also])
  assert.equal(new Set(all).size, all.length)
  for (const c of all) assert.ok(C.CATEGORY_KEYS.includes(c), c)
})
t('a category goes to its own campaign, else its family’s; a family never falls through to the general email', () => {
  // Nothing yet: nobody can go.
  for (const c of ['energy', 'rtd', 'tech', '']) assert.equal(T.campaignKeyOf(c, has()), null, c)
  // The family's campaign takes its categories.
  for (const c of ['alcohol', 'rtd', 'spirits', ' RTD ']) assert.equal(T.campaignKeyOf(c, has('alcohol', 'general')), 'alcohol', c)
  for (const c of ['cpg', 'beverage', 'electrolytes', 'qsr']) assert.equal(T.campaignKeyOf(c, has('cpg')), 'cpg', c)
  // One given its own campaign leaves the family's.
  assert.equal(T.campaignKeyOf('rtd', has('alcohol', 'rtd')), 'rtd')
  assert.equal(T.campaignKeyOf('spirits', has('alcohol', 'rtd')), 'alcohol')
  // A family with no campaign waits — even when the general one exists.
  for (const c of ['energy', 'alcohol', 'rtd', 'nicotine', 'beauty', 'electrolytes']) assert.equal(T.campaignKeyOf(c, has('general')), null, c)
  // Everyone else goes with the general one, until given their own.
  for (const c of ['tech', 'fintech', 'betting', 'apparel', '', null, undefined, 'something-new']) assert.equal(T.campaignKeyOf(c, has('general', 'energy')), 'general', String(c))
  assert.equal(T.campaignKeyOf('fintech', has('general', 'fintech')), 'fintech')
  assert.equal(T.campaignKeyOf('something-new', has('something-new', 'general')), 'general', 'a key that is no category is never a campaign')
  // What each waits for when it has nowhere to go.
  assert.equal(T.waitsOn('rtd'), 'alcohol'); assert.equal(T.waitsOn('energy'), 'energy'); assert.equal(T.waitsOn('qsr'), 'cpg')
  assert.equal(T.waitsOn('tech'), 'general'); assert.equal(T.waitsOn(''), 'general')
})
t('names: Leo’s own word for a family, "Everyone else", the site’s name for a category — the same names as the page', () => {
  assert.equal(T.keyLabel('general'), 'Everyone else')
  assert.equal(T.keyLabel('alcohol'), 'Alcohol'); assert.equal(T.keyLabel('cpg'), 'Food, drinks & CPG'); assert.equal(T.keyLabel('energy'), 'Energy drinks')
  assert.equal(T.keyLabel('rtd'), 'Beer, Seltzers & Canned Cocktails'); assert.equal(T.keyLabel('fintech'), 'Fintech')
  // CATEGORY_LABELS is CAT_NAMES in app.html, word for word.
  const html = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8')
  const block = html.slice(html.indexOf('var CAT_NAMES = {'), html.indexOf('};', html.indexOf('var CAT_NAMES = {')))
  const page = {}
  for (const m of block.matchAll(/([a-z]+):'([^']+)'/g)) page[m[1]] = m[2]
  assert.deepEqual(T.CATEGORY_LABELS, page)
  assert.deepEqual(Object.keys(T.CATEGORY_LABELS).sort(), [...C.CATEGORY_KEYS].sort())
})

// ---- the three emails of a key
t('a key’s emails are its first email on Templates, then the Follow-up and Last follow-up every category shares', () => {
  assert.equal(T.firstKeyOf('general'), 'intro'); assert.equal(T.firstKeyOf('energy'), 'cat:energy')
  const e = T.sequenceTemplate('energy', {}, ANGLES)
  assert.equal(e.subject, 'SB Agency x (BRAND)')
  assert.equal(e.steps.length, 3)
  assert.match(e.steps[0].body, /Cold cans for \(BRAND\)\./)
  assert.equal(e.steps[1].body, E.defaultTemplate('followup').body)
  assert.equal(e.steps[2].body, E.defaultTemplate('final').body)
  assert.deepEqual(e.steps.map(s => s.wait), [0, 3, 4])
  // The Show Board link: in the first email only.
  assert.equal(T.hasBoard(e.steps[0].body), true)
  assert.equal(T.hasBoard(e.steps[1].body) || T.hasBoard(e.steps[2].body), false)
  // The general one is the First email with no category line.
  const g = T.sequenceTemplate('general', {}, ANGLES)
  assert.equal(g.steps[0].body, E.defaultTemplate('intro').body)
  // Leo's own versions win, each where it belongs.
  const own = E.parseOwn({ 'cat:energy': { subject: 'Mine', body: 'Hi (NAME), (BOARD)' }, followup: { subject: 're: x', body: 'Bump, (NAME).' } })
  const mine = T.sequenceTemplate('energy', own, ANGLES)
  assert.equal(mine.subject, 'Mine'); assert.equal(mine.steps[0].body, 'Hi (NAME), (BOARD)'); assert.equal(mine.steps[1].body, 'Bump, (NAME).')
  assert.equal(T.sequenceTemplate('beauty', own, ANGLES).steps[1].body, 'Bump, (NAME).', 'the follow-up is everyone’s')
  assert.equal(T.sequenceTemplate('beauty', own, ANGLES).subject, 'SB Agency x (BRAND)')
})

// ---- placeholders, HTML, the footer
t('the dashboard’s placeholders become Instantly’s variables, and come back', () => {
  const s = 'Hi (NAME) at (BRAND), (TITLE): (BOARD) [Name] [brand]'
  assert.equal(T.toInstantlyVars(s), 'Hi {{firstName}} at {{companyName}}, {{jobTitle}}: {{board_link}} {{firstName}} {{companyName}}')
  assert.equal(T.fromInstantlyVars('Hi {{firstName}} at {{ companyName }}, {{jobTitle}}: {{board_link}}'), 'Hi (NAME) at (BRAND), (TITLE): (BOARD)')
  assert.equal(T.hasBoard('x (BOARD) y'), true); assert.equal(T.hasBoard('x [board] y'), true); assert.equal(T.hasBoard('x {{board_link}} y'), false)
})
t('plain text goes out as the HTML Instantly wants, and whatever HTML it keeps reads back as text', () => {
  assert.equal(T.toHtml('Hi (NAME),\n\nA & B <now>\n(BOARD)'), 'Hi {{firstName}},<br/><br/>A &amp; B &lt;now&gt;<br/>{{board_link}}')
  assert.equal(T.fromHtml('<div>Hi {{firstName}},</div><div><br></div><p>A &amp; B&nbsp;&lt;now&gt;</p>{{board_link}}'), 'Hi (NAME),\n\nA & B <now>\n(BOARD)')
})
t('the footer goes under every email and comes off again when Instantly’s copy is read; none by default', () => {
  assert.equal(T.DEFAULT_SIGNATURE, '')
  assert.equal(T.readSignature(null), ''); assert.equal(T.readSignature({ signature: SIG }), SIG)
  assert.equal(T.withSignature('Best,\nZach\n', ''), 'Best,\nZach')
  const out = T.withSignature('Best,\nZach', SIG)
  assert.equal(out, 'Best,\nZach\n\n' + SIG)
  assert.equal(T.withoutSignature(out, SIG), 'Best,\nZach')
  assert.equal(T.withoutSignature('Best,\nZach', SIG), 'Best,\nZach', 'nothing to take off')
  assert.equal(T.cleanSignature('  A  \r\nB   \n'), 'A\nB')
})

// ---- Instantly's sequence
const TPL = { subject: 'Hi from (BRAND)', steps: [{ body: 'One (NAME)\n(BOARD)\n\nBest,\nZach', wait: 0 }, { body: 'Two', wait: 3 }, { body: 'Three', wait: 4 }] }
t('the emails become Instantly’s one sequence: each step carries the wait before the NEXT email; follow-ups stay in the thread', () => {
  const [seq] = T.toSequence(TPL, SIG)
  assert.deepEqual(seq.steps.map(s => [s.type, s.delay, s.delay_unit, s.variants[0].subject]), [['email', 3, 'days', 'Hi from {{companyName}}'], ['email', 4, 'days', ''], ['email', 0, 'days', '']])
  assert.match(seq.steps[0].variants[0].body, /^One \{\{firstName\}\}<br\/>\{\{board_link\}\}<br\/><br\/>Best,<br\/>Zach<br\/><br\/>Zach Goldstein<br\/>/)
})
t('an update keeps the waits Leo set in Instantly', () => {
  const theirs = [{ steps: [{ type: 'email', delay: 2, delay_unit: 'days', variants: [{ subject: 'old', body: 'old' }] }, { type: 'email', delay: 6, delay_unit: 'days', variants: [{ subject: '', body: 'old' }] }, { type: 'email', delay: 9, variants: [{ subject: '', body: 'old' }] }] }]
  const [seq] = T.toSequence(TPL, '', theirs)
  assert.deepEqual(seq.steps.map(s => s.delay), [2, 6, 0], 'his 2 and 6 days stay; nothing waits after the last email')
  assert.equal(seq.steps[0].variants[0].body.startsWith('One {{firstName}}'), true, 'the words are the dashboard’s')
  // A campaign with fewer emails: the new ones get the standard waits.
  assert.deepEqual(T.toSequence(TPL, '', [{ steps: [theirs[0].steps[0]] }])[0].steps.map(s => s.delay), [2, 4, 0])
  assert.deepEqual(T.toSequence(TPL, '', null)[0].steps.map(s => s.delay), [3, 4, 0])
})
t('Instantly’s sequence reads back as the same emails', () => {
  const back = T.fromSequence(T.toSequence(TPL, SIG), SIG)
  assert.deepEqual(back, TPL)
  assert.equal(T.fromSequence([], SIG), null); assert.equal(T.fromSequence(null, SIG), null)
  // The first enabled variant of a step is the one that's read.
  const ab = [{ steps: [{ type: 'email', delay: 1, variants: [{ subject: 'off', body: 'off', v_disabled: true }, { subject: 'On {{companyName}}', body: 'Body' }] }] }]
  assert.deepEqual(T.fromSequence(ab, ''), { subject: 'On (BRAND)', steps: [{ body: 'Body', wait: 0 }] })
})
t('a campaign matches when it would send the same words — whatever the markup, the footer or the waits', () => {
  const sig = T.templateSig(TPL, SIG)
  const messy = [{ steps: T.toSequence(TPL, SIG)[0].steps.map(st => ({ ...st, delay: 9, variants: [{ ...st.variants[0], body: '<div>' + st.variants[0].body.replace(/<br\/>/g, '<br>') + '</div>' }] })) }]
  const theirs = T.fromSequence(messy, SIG)
  assert.deepEqual(T.syncState({ mine: TPL, signature: SIG, linked: true, found: true, theirs, pushedSig: sig }), { state: 'match', newer: null, parts: null })
  assert.equal(T.syncState({ mine: TPL, signature: SIG, linked: false, found: false, theirs: null }).state, 'none')
  assert.equal(T.syncState({ mine: TPL, signature: SIG, linked: true, found: false, theirs: null }).state, 'gone')
  assert.deepEqual(T.syncState({ mine: TPL, signature: SIG, linked: true, found: true, theirs: null }), { state: 'empty', newer: 'dashboard', parts: null })
})
t('when they differ: which part, and whose copy changed last', () => {
  const sig = T.templateSig(TPL, '')
  const st = (mine, theirs, pushedSig = sig) => T.syncState({ mine, signature: '', linked: true, found: true, theirs, pushedSig })
  const first = { ...TPL, steps: [{ body: 'One, rewritten (BOARD)', wait: 0 }, TPL.steps[1], TPL.steps[2]] }
  const follow = { ...TPL, steps: [TPL.steps[0], { body: 'Two, rewritten', wait: 3 }, TPL.steps[2]] }
  // Edited in Instantly since the dashboard last wrote it.
  assert.deepEqual(st(TPL, first), { state: 'differs', newer: 'instantly', parts: { first: true, follow: false } })
  assert.deepEqual(st(TPL, follow), { state: 'differs', newer: 'instantly', parts: { first: false, follow: true } })
  // Edited on Templates since: the campaign still says what was sent there.
  assert.deepEqual(st(first, TPL), { state: 'differs', newer: 'dashboard', parts: { first: true, follow: false } })
  assert.deepEqual(st(follow, TPL), { state: 'differs', newer: 'dashboard', parts: { first: false, follow: true } })
  // A new subject is the first email's; a follow-up gone in Instantly is the follow-ups'.
  assert.deepEqual(st({ ...TPL, subject: 'New' }, TPL).parts, { first: true, follow: false })
  assert.deepEqual(st(TPL, { ...TPL, steps: TPL.steps.slice(0, 2) }).parts, { first: false, follow: true })
  // Both changed, or a campaign the dashboard never wrote: nobody's is "newer".
  assert.equal(st(first, follow).newer, null)
  assert.equal(st(TPL, first, null).newer, null)
})

// ---- the campaign a key gets
t('a new campaign is a draft-ready shape: Tue–Thu, Eastern, 30 a day, stops on reply, plain, no tracking', () => {
  const c = T.campaignDraft('energy', T.toSequence(TPL, SIG))
  assert.equal(c.name, 'SB cold · Energy drinks')
  assert.equal(T.campaignDraft('rtd', []).name, 'SB cold · Beer, Seltzers & Canned Cocktails')
  assert.equal(T.campaignDraft('general', []).name, 'SB cold · Everyone else')
  const sch = c.campaign_schedule.schedules[0]
  assert.deepEqual(Object.entries(sch.days).filter(([, on]) => on).map(([d]) => d), ['2', '3', '4'])
  assert.equal(sch.timezone, 'America/Detroit')
  assert.deepEqual([c.daily_limit, c.stop_on_reply, c.stop_for_company, c.text_only, c.open_tracking, c.link_tracking, c.insert_unsubscribe_header], [30, true, true, true, false, false, true])
  assert.equal(c.sequences[0].steps.length, 3)
})

// ---- the personal link
t('a person’s key is short, the same every time, different per person, and never an awkward letter', () => {
  const a = B.personKey('cmwjqt6360000pk4co3p9s909'), b = B.personKey('cmwjqt6360000pk4co3p9s90a')
  assert.match(a, /^[A-HJ-KM-NP-Z2-9]{6}$/)
  assert.equal(a, B.personKey('cmwjqt6360000pk4co3p9s909'))
  assert.notEqual(a, b)
  assert.equal(B.personKey(''), ''); assert.equal(B.personKey(null), '')
  for (let i = 0; i < 300; i++) assert.ok(!/[01OIL]/.test(B.personKey('c' + i)))
})
t('the link carries the brand’s code and the person’s key; the key finds its person among the brand’s people', () => {
  const link = B.personBoardLink('https://shows.sboyagency.com/', 'ABCD-EFGH', 'c_ann')
  assert.equal(link, 'https://shows.sboyagency.com/?code=ABCD-EFGH&p=' + B.personKey('c_ann'))
  assert.equal(B.personBoardLink('https://x.app/partnerships', 'AB CD', 'c1'), 'https://x.app/partnerships?code=AB%20CD&p=' + B.personKey('c1'))
  const people = [{ id: 'c_ann', name: 'Ann' }, { id: 'c_bo', name: 'Bo' }]
  assert.equal(B.personOfKey(people, B.personKey('c_bo')).name, 'Bo')
  assert.equal(B.personOfKey(people, B.personKey('c_bo').toLowerCase()).name, 'Bo', 'typed in lower case')
  assert.equal(B.personOfKey(people, B.personKey('c_someone_else')), null)
  for (const junk of ['', null, 'AB', 'ABCDEFGHIJKL', '<script>']) assert.equal(B.personOfKey(people, junk), null, String(junk))
})

console.log(n + ' checks passed')
