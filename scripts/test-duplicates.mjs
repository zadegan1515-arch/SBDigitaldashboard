// scripts/test-duplicates.mjs — guards src/lib/duplicates.ts (Brands →
// Duplicates).
//
// The finder only suggests, but a bad suggestion invites a bad merge, and
// a merge deletes a brand. So: the same name, LinkedIn page or website
// links brands; a platform or a website several brands share never does;
// a pair Leo said is different never links again; groups hold together
// through chains. Compiles the lib and the two it reads from, like
// test-stock.mjs. Run: node scripts/test-duplicates.mjs

import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = mkdtempSync(join(tmpdir(), 'dup-test-'))
execSync(
  'npx tsc src/lib/duplicates.ts src/lib/brand-match.ts src/lib/li-capture.ts --outDir ' + out +
  ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck',
  { stdio: 'inherit' },
)
// Node wants the extension on a relative import; tsc leaves it off.
for (const f of readdirSync(out).filter(f => f.endsWith('.js'))) {
  const p = join(out, f)
  writeFileSync(p, readFileSync(p, 'utf8').replace(/from '(\.\/[^']+)'/g, "from '$1.js'"))
}
const { findDuplicateGroups, websiteDomain, pairKey } = await import(pathToFileURL(join(out, 'duplicates.js')).href)

let pass = 0, fail = 0
const is = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return }
  fail++; console.log('✗', label, '— got', JSON.stringify(got), 'want', JSON.stringify(want))
}
const b = (id, name, extra = {}) => ({ id, name, aka: null, website: null, linkedinUrl: null, ...extra })

// ---- website domains ---------------------------------------------------
is('strips scheme, www and path', websiteDomain('https://www.DrinkPoppi.com/shop?x=1'), 'drinkpoppi.com')
is('bare domain', websiteDomain('liquiddeath.com'), 'liquiddeath.com')
is('www2', websiteDomain('http://www2.example.co.uk/'), 'example.co.uk')
is('a platform is not a brand site', websiteDomain('https://linktr.ee/somebrand'), null)
is('a shop subdomain of a platform', websiteDomain('https://brand.myshopify.com'), null)
is('instagram', websiteDomain('instagram.com/brand'), null)
is('nothing', websiteDomain(''), null)
is('not an address', websiteDomain('n/a'), null)
is('pair key is order-free', pairKey('b', 'a'), pairKey('a', 'b'))

// ---- groups --------------------------------------------------------------
{
  const g = findDuplicateGroups([
    b('1', 'Celsius'), b('2', 'Celsius Holdings, Inc.'), b('3', 'Red Bull'),
  ])
  is('same name key (Holdings / Inc dropped)', g.map(x => x.ids), [['1', '2']])
  is('why: name', g[0].pairs.map(p => p.why), [['name']])
}
{
  const g = findDuplicateGroups([
    b('1', '818 Spirits', { aka: '818 Tequila' }), b('2', '818 Tequila'), b('3', 'Casamigos'),
  ])
  is('a name matching another brand’s also-known-as', g.map(x => x.ids), [['1', '2']])
}
{
  const g = findDuplicateGroups([
    b('1', 'Liquid Death', { linkedinUrl: 'https://www.linkedin.com/company/liquid-death/' }),
    b('2', 'Liquid Death Mountain Water', { linkedinUrl: 'linkedin.com/company/Liquid-Death/people/' }),
  ])
  is('same LinkedIn page', g.map(x => [x.ids, x.pairs[0].why]), [[['1', '2'], ['linkedin']]])
}
{
  const g = findDuplicateGroups([
    b('1', 'Poppi', { website: 'drinkpoppi.com' }), b('2', 'Poppi Soda', { website: 'https://www.drinkpoppi.com/' }),
  ])
  is('same website', g.map(x => [x.ids, x.pairs[0].why]), [[['1', '2'], ['website']]])
}
{
  // A parent's site shared by four brands says nothing.
  const g = findDuplicateGroups([
    b('1', 'Bubly', { website: 'pepsico.com' }), b('2', 'Rockstar', { website: 'pepsico.com' }),
    b('3', 'Gatorade', { website: 'pepsico.com' }), b('4', 'Mountain Dew', { website: 'pepsico.com' }),
  ])
  is('a website four brands share is not a signal', g, [])
  const platform = findDuplicateGroups([b('1', 'A Co', { website: 'linktr.ee/a' }), b('2', 'B Co', { website: 'linktr.ee/b' })])
  is('a platform link is not a signal', platform, [])
}
{
  // Several signals on one pair are all listed, name first.
  const g = findDuplicateGroups([
    b('1', 'Ghost', { website: 'ghostlifestyle.com', linkedinUrl: 'https://www.linkedin.com/company/ghost-lifestyle/' }),
    b('2', 'GHOST', { website: 'ghostlifestyle.com', linkedinUrl: 'https://www.linkedin.com/company/ghost-lifestyle/' }),
  ])
  is('every reason, in order', g[0].pairs[0].why, ['name', 'linkedin', 'website'])
}
{
  // Chains: A~B by name, B~C by LinkedIn page -> one group of three.
  const g = findDuplicateGroups([
    b('a', 'Olipop'), b('b', 'OLIPOP Inc', { linkedinUrl: 'https://www.linkedin.com/company/olipop/' }),
    b('c', 'Olipop Prebiotic Soda', { linkedinUrl: 'https://linkedin.com/company/olipop' }),
  ])
  is('a chain is one group', g.map(x => x.ids), [['a', 'b', 'c']])
  is('two pairs hold it', g[0].pairs.length, 2)
}
{
  // "Not duplicates" on a pair means it never links again — and a group
  // that only held through that pair falls apart.
  const brands = [b('1', 'Monster'), b('2', 'Monster'.concat(' Inc'))]
  is('linked before', findDuplicateGroups(brands).length, 1)
  is('dismissed pair never links', findDuplicateGroups(brands, new Set([pairKey('2', '1')])), [])
  const chain = [b('a', 'Olipop'), b('b', 'OLIPOP Inc', { linkedinUrl: 'https://www.linkedin.com/company/olipop/' }), b('c', 'Olipop Soda', { linkedinUrl: 'https://www.linkedin.com/company/olipop/' })]
  const g = findDuplicateGroups(chain, new Set([pairKey('a', 'b')]))
  is('only the pair left forms a group', g.map(x => x.ids), [['b', 'c']])
}
{
  // Website-only groups come after name/LinkedIn ones.
  const g = findDuplicateGroups([
    b('w1', 'Alpha Drinks', { website: 'alpha.com' }), b('w2', 'Zeta Co', { website: 'alpha.com' }),
    b('n1', 'Zulu'), b('n2', 'Zulu Inc'),
  ])
  is('strong groups first', g.map(x => x.ids[0]), ['n1', 'w1'])
}
{
  // Different companies that merely share a word are not matched.
  const g = findDuplicateGroups([b('1', 'Monster Energy'), b('2', 'Monster Beverage Careers'), b('3', 'Red Bull'), b('4', 'Bull Durham')])
  is('a shared word is not a match', g, [])
  // Two-letter keys still work; one letter never does.
  is('two-letter names can match', findDuplicateGroups([b('1', 'AG1'), b('2', 'AG1 Inc')]).length, 1)
  is('a one-character key never links', findDuplicateGroups([b('1', 'X'), b('2', 'X Inc')]), [])
}

console.log(fail ? `duplicates: ${pass} passed, ${fail} FAILED` : `duplicates: all ${pass} passed`)
process.exit(fail ? 1 : 0)
