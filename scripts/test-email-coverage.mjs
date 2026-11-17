// node scripts/test-email-coverage.mjs — Email → "Where we stand on emails"
// (Leo, Nov 17 2026; src/lib/email-coverage.ts): which brands are counted
// (the ones we're not talking to), what "has an email" and "a buyer's email"
// mean, what counts as Hunter's, the brands with no website and what there is
// to go by, the numbers by category, the marks (the numbers on earlier days),
// and the websites waiting for Leo's yes.
import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const out = mkdtempSync(join(tmpdir(), 'email-coverage-test-'))
execSync('npx tsc src/lib/email-coverage.ts --outDir ' + out + ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck', { stdio: 'inherit' })
for (const f of readdirSync(out).filter(f => f.endsWith('.js'))) {
  const p = join(out, f)
  writeFileSync(p, readFileSync(p, 'utf8').replace(/from '(\.\/[^']+)'/g, "from '$1.js'"))
}
const m = await import(pathToFileURL(join(out, 'email-coverage.js')).href)
const {
  COLD_SPOTS, isCold, coverRow, coverage, countRows, emptyNumbers, markNumbers, cleanMarks, addMark, MARKS_KEEP,
  cleanStaged, planStage, dropStaged, waiting, siteDomain, HOW_WORDS, isSure,
} = m

let n = 0
function t(name, fn) { fn(); n++; console.log('  ok — ' + name) }

const brand = (id, spot, people, extra) => Object.assign({ id, name: 'Brand ' + id, category: 'energy', spot, website: null, linkedinUrl: null, parent: null, people: people || [] }, extra || {})
const p = (title, email, extra) => Object.assign({ title, email: email || null }, extra || {})

t('the brands counted are the ones we’re not talking to', () => {
  for (const s of ['list', 'ready', 'nobody', 'tooNew', 'emailed', 'waiting', 'held']) assert.equal(isCold(s), true, s)
  for (const s of ['talking', 'known', 'off', 'other', null, undefined]) assert.equal(isCold(s), false, String(s))
  assert.equal(COLD_SPOTS.length, 7)
  const c = coverage([
    brand('a', 'list'), brand('b', 'ready'), brand('c', 'nobody'), brand('d', 'held'),
    brand('t', 'talking'), brand('k', 'known'), brand('o', 'off'), brand('o2', 'off'), brand('x', 'other'),
  ])
  assert.equal(c.n.brands, 4)
  assert.deepEqual(c.out, { talking: 1, known: 1, off: 2, other: 1 })
  assert.equal(c.total, 9)
  assert.equal(c.n.brands + c.out.talking + c.out.known + c.out.off + c.out.other, c.total)
})

t('has an email = anyone there; a buyer’s email = a partnerships, events, marketing or founder title', () => {
  const r = coverRow(brand('a', 'list', [p('Head of Partnerships', 'a@a.com'), p('Accountant', 'b@a.com'), p('Brand Manager', null)]))
  assert.equal(r.people, 3)
  assert.equal(r.emails, 2)
  assert.equal(r.buyerEmails, 1)
  const none = coverRow(brand('b', 'list', [p('Accountant', 'x@b.com'), p('CEO', '')]))
  assert.equal(none.emails, 1)
  assert.equal(none.buyerEmails, 0)       // the CEO has no address; the accountant isn't a buyer
  const c = coverage([brand('a', 'list', [p('Founder', 'f@a.com')]), brand('b', 'list', [p('Accountant', 'x@b.com')]), brand('c', 'nobody')])
  assert.equal(c.n.email, 2)
  assert.equal(c.n.buyerEmail, 1)
  assert.equal(c.n.noEmail, 1)
  assert.equal(c.n.email + c.n.noEmail, c.n.brands)
})

t('someone who said stop is not counted — not as a person, not their address', () => {
  const r = coverRow(brand('a', 'held', [p('CMO', 'cmo@a.com', { stopped: true }), p('Intern', null)]))
  assert.equal(r.people, 1)
  assert.equal(r.emails, 0)
})

t('an address is Hunter’s only when every one there came from Hunter', () => {
  const both = coverRow(brand('a', 'list', [p('CMO', 'c@a.com', { hunter: true }), p('Founder', 'f@a.com')]))
  assert.equal(both.hunterOnly, false)
  assert.equal(both.buyerHunterOnly, false)
  const only = coverRow(brand('b', 'list', [p('CMO', 'c@b.com', { hunter: true })]))
  assert.equal(only.hunterOnly, true)
  assert.equal(only.buyerHunterOnly, true)
  // An address on file before, and Hunter found the buyer.
  const mix = coverRow(brand('c', 'list', [p('Accountant', 'x@c.com'), p('Head of Events', 'e@c.com', { hunter: true })]))
  assert.equal(mix.hunterOnly, false)
  assert.equal(mix.buyerHunterOnly, true)
  const c = coverage([brand('a', 'list', both ? [p('CMO', 'c@a.com', { hunter: true }), p('Founder', 'f@a.com')] : []), brand('b', 'list', [p('CMO', 'c@b.com', { hunter: true })]), brand('c', 'list', [p('Accountant', 'x@c.com'), p('Head of Events', 'e@c.com', { hunter: true })])])
  assert.equal(c.n.email, 3)
  assert.equal(c.n.emailHunter, 1)
  assert.equal(c.n.buyerEmail, 3)
  assert.equal(c.n.buyerHunter, 2)
})

t('no email: people to look up or nobody, and how Hunter can look the brand up', () => {
  const c = coverage([
    brand('a', 'list', [p('CMO', null)], { website: 'https://www.alpha.com/shop' }),          // by its website
    brand('b', 'nobody', []),                                                                    // by name
    brand('c', 'list', [p('CMO', null)], { parent: 'Diageo', website: 'https://ketelone.com' }), // under its parent
    brand('d', 'list', [p('CMO', null)], { linkedinUrl: 'https://www.linkedin.com/company/d/' }), // by name (a page isn't a domain)
  ])
  assert.equal(c.n.noEmail, 4)
  assert.equal(c.n.noEmailPeople, 3)
  assert.equal(c.n.noEmailNobody, 1)
  assert.equal(c.n.findDomain, 1)
  assert.equal(c.n.findParent, 1)
  assert.equal(c.n.findName, 2)
  assert.equal(c.n.findDomain + c.n.findParent + c.n.findName, c.n.noEmail)
  assert.equal(c.rows.find(r => r.id === 'a').website, 'alpha.com')
})

t('a label whose people have their own addresses goes by those, not its parent', () => {
  const r = coverRow(brand('a', 'ready', [p('CMO', 'c@ketelone.com')], { parent: 'Diageo' }))
  assert.equal(r.find, 'domain')
  assert.equal(r.mailDomain, 'ketelone.com')
})

t('no website saved: the mail domain, only a LinkedIn page, or just the name', () => {
  const c = coverage([
    brand('a', 'ready', [p('CMO', 'c@alpha.com'), p('PR', 'p@alpha.com'), p('X', 'x@gmail.com')]),                  // mail domain known
    brand('b', 'list', [p('CMO', null)], { linkedinUrl: 'https://www.linkedin.com/company/b/' }),                     // a page only
    brand('c', 'nobody', []),                                                                                         // nothing
    brand('d', 'ready', [p('CMO', 'c@other.com')], { website: 'delta.com' }),                                         // has a website
    brand('e', 'ready', [p('CMO', 'someone@gmail.com')]),                                                             // a free mailbox is no domain
  ])
  assert.equal(c.n.website, 1)
  assert.equal(c.n.noWebsite, 4)
  assert.equal(c.n.noWebsiteMail, 1)
  assert.equal(c.n.noWebsitePage, 1)
  assert.equal(c.n.noWebsiteNothing, 2)
  assert.equal(c.n.noWebsiteMail + c.n.noWebsitePage + c.n.noWebsiteNothing, c.n.noWebsite)
  assert.equal(c.n.website + c.n.noWebsite, c.n.brands)
  assert.equal(c.rows.find(r => r.id === 'a').mailDomain, 'alpha.com')
  assert.equal(c.rows.find(r => r.id === 'd').mailDomain, null)      // a saved website: no need for it
  assert.equal(c.rows.find(r => r.id === 'e').mailDomain, null)
})

t('by category: every counted brand once, biggest first, and they add up', () => {
  const c = coverage([
    brand('a', 'list', [p('CMO', 'c@a.com')], { category: 'energy' }), brand('b', 'list', [], { category: 'energy' }),
    brand('c', 'nobody', [], { category: 'spirits' }), brand('d', 'held', [p('CMO', 'c@d.com')], { category: null }),
    brand('t', 'talking', [], { category: 'energy' }),
  ])
  assert.deepEqual(c.byCategory.map(x => x.key), ['energy', '', 'spirits'])
  assert.equal(c.byCategory[0].n.brands, 2)
  assert.equal(c.byCategory.reduce((s, x) => s + x.n.brands, 0), c.n.brands)
  assert.equal(c.byCategory.reduce((s, x) => s + x.n.email, 0), c.n.email)
  assert.equal(c.byCategory.reduce((s, x) => s + x.n.noWebsite, 0), c.n.noWebsite)
  assert.deepEqual(countRows(c.rows), c.n)
  assert.deepEqual(c.rows.map(r => r.name), [...c.rows.map(r => r.name)].sort())
})

t('marks: the first one is never dropped, a broken one is', () => {
  const mk = (i) => ({ at: '2026-11-' + String(i).padStart(2, '0') + 'T12:00:00Z', by: 'Claude', why: 'file', label: 'm' + i, n: markNumbers({ ...emptyNumbers(), brands: 800 + i, email: i }) })
  let marks = []
  for (let i = 1; i <= MARKS_KEEP + 5; i++) marks = addMark(marks, mk(i))
  assert.equal(marks.length, MARKS_KEEP)
  assert.equal(marks[0].label, 'm1')
  assert.equal(marks[marks.length - 1].label, 'm' + (MARKS_KEEP + 5))
  assert.deepEqual(Object.keys(marks[0].n).sort(), ['brands', 'buyerEmail', 'email', 'emails', 'noEmail', 'noWebsite', 'website'])
  const clean = cleanMarks([mk(1), null, { at: 5 }, { at: 'x', n: {} }, { at: '2026-11-17T00:00:00Z', why: 'nonsense', n: { brands: 3 } }])
  assert.equal(clean.length, 2)
  assert.equal(clean[1].why, 'mark')
  assert.equal(clean[1].n.email, 0)
  assert.deepEqual(cleanMarks('nope'), [])
})

t('a website is a company’s own site — never a social or marketplace link', () => {
  assert.equal(siteDomain('https://www.Kith.com/pages/about'), 'kith.com')
  assert.equal(siteDomain('kith.com'), 'kith.com')
  for (const bad of ['https://www.instagram.com/kith', 'linkedin.com/company/kith', 'https://www.amazon.com/kith', 'linktr.ee/kith', 'kith', '', null]) assert.equal(siteDomain(bad), null, String(bad))
})

const BRANDS = new Map([
  ['a', { name: 'Alpha', website: null }], ['b', { name: 'Beta', website: 'https://beta.com' }], ['c', { name: 'Gamma', website: '' }], ['d', { name: 'Delta', website: null }],
])
const CTX = { brands: BRANDS, at: '2026-11-17T15:00:00Z', by: 'Claude' }

t('a list of finds: staged, and left out with why', () => {
  const r = planStage({ rows: [], no: {} }, [
    { brandId: 'a', website: 'https://www.alpha.com/', how: 'search', note: 'its own store' },
    { brandId: 'b', website: 'beta.io' },                       // already has a website
    { brandId: 'c', website: 'instagram.com/gamma' },           // not a site
    { brandId: 'zz', website: 'nope.com' },                     // not a brand
    { brandId: 'a', website: 'alpha.co' },                      // twice
    { brandId: 'd', website: 'delta.com', how: 'memory' },
  ], CTX)
  assert.deepEqual(r.counts, { staged: 2, has: 1, bad: 1, unknown: 1, twice: 1, no: 0 })
  assert.deepEqual(r.state.rows.map(x => [x.brandId, x.website, x.how]), [['a', 'alpha.com', 'search'], ['d', 'delta.com', 'memory']])
  assert.equal(r.state.rows[0].by, 'Claude')
  assert.equal(r.state.rows[0].note, 'its own store')
  assert.ok(HOW_WORDS.memory && HOW_WORDS.search && HOW_WORDS.emails && HOW_WORDS.unsure)
  // Only a confirmed find and a brand's own email addresses are sure; a kind nobody knows is read as a find.
  assert.deepEqual(['search', 'emails', 'unsure', 'memory'].map(isSure), [true, true, false, false])
  const kinds = planStage({ rows: [], no: {} }, [{ brandId: 'a', website: 'alpha.com', how: 'unsure' }, { brandId: 'd', website: 'delta.com', how: 'whatever' }], CTX)
  assert.deepEqual(kinds.state.rows.map(x => x.how), ['unsure', 'search'])
})

t('a newer find replaces the older one; one whose brand got a website drops off', () => {
  const first = planStage({ rows: [], no: {} }, [{ brandId: 'a', website: 'alpha.com' }, { brandId: 'd', website: 'delta.com' }], CTX).state
  const later = new Map(BRANDS)
  later.set('d', { name: 'Delta', website: 'https://delta.com' })
  const r = planStage(first, [{ brandId: 'a', website: 'drinkalpha.com', how: 'search' }], { ...CTX, brands: later })
  assert.deepEqual(r.state.rows.map(x => [x.brandId, x.website]), [['a', 'drinkalpha.com']])
})

t('not theirs: off the list, and never offered for that brand again', () => {
  const st = planStage({ rows: [], no: {} }, [{ brandId: 'a', website: 'alpha.com' }, { brandId: 'd', website: 'delta.com' }], CTX).state
  const d = dropStaged(st, ['a'])
  assert.deepEqual(d.dropped.map(x => x.website), ['alpha.com'])
  assert.deepEqual(d.state.rows.map(x => x.brandId), ['d'])
  assert.deepEqual(d.state.no, { a: ['alpha.com'] })
  const again = planStage(d.state, [{ brandId: 'a', website: 'www.alpha.com' }, { brandId: 'a', website: 'alpha.co' }], CTX)
  assert.equal(again.counts.no, 1)
  assert.equal(again.lines[0].action, 'no')
  // Another website for the same brand is fine — but it came second in that list for the brand, so say it alone.
  const other = planStage(d.state, [{ brandId: 'a', website: 'alpha.co' }], CTX)
  assert.equal(other.counts.staged, 1)
})

t('waiting = still on file with no website, by name', () => {
  const st = cleanStaged({ rows: [
    { brandId: 'd', website: 'delta.com', how: 'memory', note: '', at: 'x', by: null }, { brandId: 'a', website: 'alpha.com', how: 'search' },
    { brandId: 'b', website: 'beta.com' }, { brandId: 'gone', website: 'gone.com' }, { brandId: 'c', website: 'instagram.com/c' }, null,
  ], no: { a: ['https://www.old.com', 'bad'], q: 'x' } })
  assert.equal(st.rows.length, 4)                       // the social link and the null are dropped
  assert.deepEqual(st.no, { a: ['old.com'] })
  const w = waiting(st, BRANDS)
  assert.deepEqual(w.map(x => x.name), ['Alpha', 'Delta'])
  assert.deepEqual(cleanStaged(null), { rows: [], no: {} })
})

console.log('\n' + n + ' checks passed')
