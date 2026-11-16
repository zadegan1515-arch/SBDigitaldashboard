// node scripts/test-cold-templates.mjs — the cold email templates, one per
// kind of brand, kept on the dashboard and written into Instantly (Leo, Nov
// 16 2026; src/lib/cold-templates.ts), and each person's own Show Board link
// (src/lib/board-key.ts): which template a category gets, the drafts, what's
// kept when one is saved, the dashboard's placeholders ⇄ Instantly's, a
// template as Instantly's sequence and back, whether the two say the same
// thing, the campaign a group gets, and the personal link's key.
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
const B = await import(pathToFileURL(join(out, 'board-key.js')).href)

let n = 0
function t(name, fn) { fn(); n++; console.log('  ok — ' + name) }
const SIG = 'Zach Goldstein\nCo-CEO, SB Agency'

// ---- which template a brand gets
t('a brand’s category picks its template; anything else gets the general one', () => {
  assert.equal(T.groupOfCategory('energy'), 'energy')
  for (const c of ['alcohol', 'rtd', 'spirits']) assert.equal(T.groupOfCategory(c), 'alcohol', c)
  assert.equal(T.groupOfCategory('nicotine'), 'nicotine')
  assert.equal(T.groupOfCategory('beauty'), 'beauty')
  for (const c of ['cpg', 'beverage', 'electrolytes', 'qsr']) assert.equal(T.groupOfCategory(c), 'food', c)
  for (const c of ['tech', 'apps', 'betting', 'apparel', '', null, undefined, 'something-new']) assert.equal(T.groupOfCategory(c), 'general', String(c))
  assert.equal(T.groupOfCategory(' Energy '), 'energy')
  assert.deepEqual(T.TEMPLATE_GROUPS.map(g => g.key), ['energy', 'alcohol', 'nicotine', 'beauty', 'food', 'general'])
  assert.equal(T.groupLabel('food'), 'Food, drinks & CPG')
  assert.equal(T.isGroup('energy'), true); assert.equal(T.isGroup('toString'), false)
  // No category sits in two groups.
  const all = T.TEMPLATE_GROUPS.flatMap(g => g.categories)
  assert.equal(new Set(all).size, all.length)
})

// ---- the drafts
t('every group has a draft: a subject, three emails, the Show Board link in the first one only', () => {
  for (const g of T.TEMPLATE_GROUPS) {
    const d = T.DEFAULT_TEMPLATES[g.key]
    assert.ok(d, g.key)
    assert.equal(d.subject, '(BRAND) x SB Agency')
    assert.deepEqual(d.steps.map(s => s.wait), [0, 3, 4], g.key)
    assert.equal(T.hasBoard(d.steps[0].body), true, g.key + ': the first email carries (BOARD)')
    assert.equal(d.steps.slice(1).some(s => T.hasBoard(s.body)), false, g.key + ': follow-ups have no link')
    for (const s of d.steps) {
      assert.match(s.body, /^Hi \(NAME\),/)
      assert.ok(!/https?:\/\//.test(s.body), g.key + ': no link but the board')
      assert.ok(s.body.split(/\s+/).length <= 130, g.key + ': short')
      assert.ok(!/[—]/.test(s.body), g.key + ': no long dashes')
    }
    assert.match(d.steps[0].body, /just say the word and I won’t follow up/, g.key + ': a way out')
  }
  // Each group's first email says something of its own.
  assert.equal(new Set(T.TEMPLATE_GROUPS.map(g => T.DEFAULT_TEMPLATES[g.key].steps[0].body)).size, T.TEMPLATE_GROUPS.length)
  // Alcohol and nicotine say 21+; nicotine never promises samples.
  assert.match(T.DEFAULT_TEMPLATES.alcohol.steps[0].body, /21\+/)
  assert.match(T.DEFAULT_TEMPLATES.nicotine.steps[0].body, /21\+/)
  assert.ok(!/sampl/i.test(T.DEFAULT_TEMPLATES.nicotine.steps[0].body))
})

// ---- saving
t('a saved template is cleaned: one-line subject, one to three emails, the first with no wait', () => {
  const c = T.cleanTemplate({ subject: '  Hello\nthere  ', steps: [{ body: '  First  \r\nline  ', wait: 9 }, { body: '', wait: 2 }, { body: 'Second', wait: 0 }, { body: 'Third', wait: 500 }, { body: 'Fourth', wait: 1 }] })
  assert.equal(c.subject, 'Hello there')
  assert.deepEqual(c.steps, [{ body: 'First\nline', wait: 0 }, { body: 'Second', wait: 1 }, { body: 'Third', wait: 60 }])
  assert.throws(() => T.cleanTemplate({ subject: '', steps: [{ body: 'x' }] }), /subject is empty/)
  assert.throws(() => T.cleanTemplate({ subject: 'x', steps: [{ body: '   ' }] }), /first email is empty/)
  assert.throws(() => T.cleanTemplate(null), /subject is empty/)
  assert.equal(T.cleanSignature('  Zach  \r\nSB Agency \n'), 'Zach\nSB Agency')
})
t('each group reads its saved template, else the draft; a broken saved one falls back to the draft', () => {
  const r = T.readTemplates({ signature: 'Leo', groups: { energy: { subject: 'Mine', steps: [{ body: 'Hi (NAME)', wait: 0 }], at: '2026-11-16T00:00:00Z', by: 'Leo' }, beauty: { subject: '', steps: [] } } })
  assert.equal(r.signature, 'Leo')
  const g = (k) => r.groups.find(x => x.key === k)
  assert.deepEqual([g('energy').subject, g('energy').edited, g('energy').by, g('energy').steps.length], ['Mine', true, 'Leo', 1])
  assert.equal(g('beauty').subject, '(BRAND) x SB Agency')
  assert.deepEqual([g('alcohol').edited, g('alcohol').steps.length], [false, 3])
  assert.equal(T.readTemplates(null).signature, T.DEFAULT_SIGNATURE)
  assert.equal(T.readTemplates({ signature: '' }).signature, '', 'an emptied signature stays empty')
})

// ---- placeholders
t('the dashboard’s placeholders become Instantly’s variables, and come back', () => {
  const mine = 'Hi (NAME), [Name] at (BRAND) [Brand], (TITLE) [Title]: (BOARD) [Board]'
  const theirs = T.toInstantlyVars(mine)
  assert.equal(theirs, 'Hi {{firstName}}, {{firstName}} at {{companyName}} {{companyName}}, {{jobTitle}} {{jobTitle}}: {{board_link}} {{board_link}}')
  assert.equal(T.fromInstantlyVars('{{ firstName }} {{companyName}} {{jobTitle}} {{ board_link }} {{unknown}}'), '(NAME) (BRAND) (TITLE) (BOARD) {{unknown}}')
  assert.equal(T.BOARD_VAR, 'board_link')
})
t('plain text goes out as the HTML Instantly wants, and whatever HTML it keeps reads back as text', () => {
  assert.equal(T.toHtml('Hi (NAME),\n\nTom & Jerry <3\n(BOARD)'), 'Hi {{firstName}},<br/><br/>Tom &amp; Jerry &lt;3<br/>{{board_link}}')
  assert.equal(T.fromHtml('Hi {{firstName}},<br/><br/>Tom &amp; Jerry &lt;3<br>{{board_link}}'), 'Hi (NAME),\n\nTom & Jerry <3\n(BOARD)')
  assert.equal(T.fromHtml('<div>Hi {{firstName}},</div><div><br></div><div>It&#39;s&nbsp;us</div><p>Bye</p>'), 'Hi (NAME),\n\nIt\'s us\nBye')
  assert.equal(T.fromHtml(null), '')
})
t('the signature goes under every email and comes off again when Instantly’s copy is read', () => {
  assert.equal(T.withSignature('Hi\n\nBest,\n', SIG), 'Hi\n\nBest,\n' + SIG)
  assert.equal(T.withSignature('Hi', '  '), 'Hi')
  assert.equal(T.withoutSignature('Hi\n\nBest,\n' + SIG, SIG), 'Hi\n\nBest,')
  assert.equal(T.withoutSignature('Hi\n\nBest,\nSomeone else', SIG), 'Hi\n\nBest,\nSomeone else')
})

// ---- the sequence
const tpl = { subject: '(BRAND) x SB Agency', steps: [{ body: 'Hi (NAME),\n\n(BOARD)\n\nBest,', wait: 0 }, { body: 'Hi (NAME),\n\nAgain.\n\nBest,', wait: 3 }, { body: 'Hi (NAME),\n\nLast.\n\nBest,', wait: 4 }] }
t('a template becomes Instantly’s one sequence: each step carries the wait before the NEXT email; follow-ups stay in the thread', () => {
  const seq = T.toSequence(tpl, SIG)
  assert.equal(seq.length, 1)
  assert.deepEqual(seq[0].steps.map(s => [s.type, s.delay, s.delay_unit, s.variants.length]), [['email', 3, 'days', 1], ['email', 4, 'days', 1], ['email', 0, 'days', 1]])
  assert.deepEqual(seq[0].steps.map(s => s.variants[0].subject), ['{{companyName}} x SB Agency', '', ''])
  assert.equal(seq[0].steps[0].variants[0].body, 'Hi {{firstName}},<br/><br/>{{board_link}}<br/><br/>Best,<br/>Zach Goldstein<br/>Co-CEO, SB Agency')
})
t('Instantly’s sequence reads back as the same template', () => {
  assert.deepEqual(T.fromSequence(T.toSequence(tpl, SIG), SIG), tpl)
  // Its first enabled variant; hours and minutes read as days; a missing or empty sequence is nothing.
  const theirs = [{ steps: [
    { type: 'email', delay: 48, delay_unit: 'hours', variants: [{ subject: 'Off', body: 'x', v_disabled: true }, { subject: 'Hi {{firstName}}', body: '<div>One</div>' }] },
    { type: 'email', delay: 0, variants: [{ subject: '', body: 'Two' }] },
  ] }]
  assert.deepEqual(T.fromSequence(theirs, SIG), { subject: 'Hi (NAME)', steps: [{ body: 'One', wait: 0 }, { body: 'Two', wait: 2 }] })
  assert.equal(T.fromSequence([], SIG), null)
  assert.equal(T.fromSequence([{ steps: [] }], SIG), null)
  assert.equal(T.fromSequence(undefined, SIG), null)
})
t('the dashboard’s copy and Instantly’s match when they’d send the same emails, whatever the markup', () => {
  const state = (o) => T.syncState({ mine: tpl, signature: SIG, linked: true, found: true, theirs: tpl, ...o })
  assert.deepEqual(state({}), { state: 'match', newer: null })
  const spaced = { subject: ' (BRAND)  x SB Agency ', steps: tpl.steps.map(s => ({ body: s.body.replace(/\n\n/g, '\n \n\n'), wait: s.wait })) }
  assert.equal(state({ theirs: spaced }).state, 'match')
  assert.equal(state({ linked: false }).state, 'none')
  assert.equal(state({ found: false }).state, 'gone')
  assert.deepEqual(state({ theirs: null }), { state: 'empty', newer: 'dashboard' })
  // A changed word, a changed wait, a dropped step: differs.
  const other = { subject: tpl.subject, steps: [{ body: 'Hi (NAME),\n\nNew words\n\nBest,', wait: 0 }, ...tpl.steps.slice(1)] }
  assert.equal(state({ theirs: other }).state, 'differs')
  assert.equal(state({ theirs: { ...tpl, steps: [tpl.steps[0], { ...tpl.steps[1], wait: 5 }, tpl.steps[2]] } }).state, 'differs')
  assert.equal(state({ theirs: { ...tpl, steps: tpl.steps.slice(0, 2) } }).state, 'differs')
  // Whose copy changed since the last push.
  assert.equal(state({ theirs: other, pushedSig: T.templateSig(other, SIG) }).newer, 'dashboard')
  assert.equal(state({ theirs: other, pushedSig: T.templateSig(tpl, SIG) }).newer, 'instantly')
  assert.equal(state({ theirs: other, pushedSig: null }).newer, null)
})

// ---- the campaign
t('a new campaign is a draft-ready shape: Tue–Thu, Eastern, 30 a day, stops on reply, plain, no tracking', () => {
  const c = T.campaignDraft('energy', T.toSequence(tpl, SIG))
  assert.equal(c.name, 'SB cold · Energy drinks')
  const sch = c.campaign_schedule.schedules[0]
  assert.deepEqual(sch.days, { '0': false, '1': false, '2': true, '3': true, '4': true, '5': false, '6': false })
  assert.deepEqual([sch.timing.from, sch.timing.to, sch.timezone], ['09:00', '17:00', 'America/Detroit'])
  assert.deepEqual([c.daily_limit, c.stop_on_reply, c.stop_for_company, c.text_only, c.open_tracking, c.link_tracking], [30, true, true, true, false, false])
  assert.equal(c.sequences[0].steps.length, 3)
  assert.equal('email_list' in c, false, 'the inbox is Leo’s to attach')
})

t('a template fills for one person, as they’d read it', () => {
  assert.equal(T.fillTemplate('Hi (NAME) at (BRAND), (TITLE): (BOARD)', { first: 'Ann', brand: 'Cold Co', title: 'VP', board: 'https://x/?code=A&p=B' }), 'Hi Ann at Cold Co, VP: https://x/?code=A&p=B')
  assert.equal(T.fillTemplate('Hi (NAME) at (BRAND)', {}), 'Hi there at your brand')
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
