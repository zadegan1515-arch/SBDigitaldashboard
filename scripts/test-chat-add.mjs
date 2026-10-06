// scripts/test-chat-add.mjs — guards src/lib/chat-add.ts (the "Add a
// brand" chat). A brand Leo already has must be found under any name,
// LinkedIn page or website so the chat never makes a second copy; an
// Instagram or Linktree link is never taken for the brand's website.
// Run: node scripts/test-chat-add.mjs

import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = mkdtempSync(join(tmpdir(), 'chat-add-test-'))
execSync(
  'npx tsc src/lib/chat-add.ts --outDir ' + out +
  ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck',
  { stdio: 'inherit' },
)
for (const f of readdirSync(out).filter(f => f.endsWith('.js'))) {
  const p = join(out, f)
  writeFileSync(p, readFileSync(p, 'utf8').replace(/from '(\.\/[^']+)'/g, "from '$1.js'"))
}
const { cleanChatBrand, matchRoster, igHandle, chatNotes } = await import(pathToFileURL(join(out, 'chat-add.js')).href)

let pass = 0, fail = 0
const is = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return }
  fail++; console.log('✗', label, '— got', JSON.stringify(got), 'want', JSON.stringify(want))
}
const clean = raw => cleanChatBrand(raw).row
const r = (id, name, extra = {}) => ({ id, name, aka: null, website: null, linkedinUrl: null, passedAt: null, ...extra })

// ---- cleaning ------------------------------------------------------------
is('no name refused', cleanChatBrand({ name: '  ' }).error, 'The brand needs a name')
is('not an object', cleanChatBrand('Poppi').error, 'Send the brand as an object')
const p = clean({
  name: ' Poppi ', category: 'Beverage', tier: 'Growth', website: 'drinkpoppi.com',
  linkedinUrl: 'https://www.linkedin.com/company/drinkpoppi/about/?x=1',
  aka: 'poppi, Poppi Soda; ', instagram: 'https://instagram.com/drinkpoppi/', sourceUrl: 'instagram.com/p/abc',
})
is('name trimmed', p.name, 'Poppi')
is('category lowercased (checked by the handler)', p.category, 'beverage')
is('tier', p.tier, 'growth')
is('website gets a scheme', p.website, 'https://drinkpoppi.com/')
is('LinkedIn → company page', p.linkedinUrl, 'https://www.linkedin.com/company/drinkpoppi/')
is('aka drops the name itself and blanks', p.aka, ['Poppi Soda'])
is('instagram handle', p.instagram, '@drinkpoppi')
is('source link', p.sourceUrl, 'https://instagram.com/p/abc')
is('instagram as website is not a website', clean({ name: 'X', website: 'instagram.com/x' }).website, null)
is('linktree is not a website', clean({ name: 'X', website: 'https://linktr.ee/x' }).website, null)
is('a person profile is not a company page', clean({ name: 'X', linkedinUrl: 'linkedin.com/in/jane' }).linkedinUrl, null)
is('bad tier → null', clean({ name: 'X', tier: 'huge' }).tier, null)
is('@handle', igHandle('@liquiddeath'), '@liquiddeath')
is('bare handle', igHandle('liquiddeath'), '@liquiddeath')
is('junk handle', igHandle('not a handle!'), null)

// ---- matching the roster -------------------------------------------------
const roster = [
  r('1', 'Poppi Inc.'),
  r('2', 'Olipop', { aka: 'Olipop Soda, OLI' }),
  r('3', 'Liquid Death', { linkedinUrl: 'https://www.linkedin.com/company/liquid-death-mountain-water/' }),
  r('4', 'Celsius', { website: 'https://www.celsius.com/shop' }),
  r('5', 'Sister A', { website: 'parentco.com' }), r('6', 'Sister B', { website: 'parentco.com' }),
  r('7', 'Sister C', { website: 'parentco.com' }), r('8', 'Sister D', { website: 'parentco.com' }),
  r('9', 'Gone Brand', { passedAt: new Date() }),
  r('10', 'Shop on IG', { website: 'instagram.com/shop' }),
]
const m = b => matchRoster(clean(b), roster).map(x => x.name + ':' + x.why.join('+'))
is('name ignoring Inc.', m({ name: 'poppi' }), ['Poppi Inc.:name'])
is('aka on the roster', m({ name: 'Olipop Soda' }), ['Olipop:name'])
is('aka the chat sends', m({ name: 'New Name', aka: ['OLI'] }), ['Olipop:name'])
is('same LinkedIn page, another name', m({ name: 'LD Water', linkedinUrl: 'linkedin.com/company/liquid-death-mountain-water' }), ['Liquid Death:linkedin'])
is('same website', m({ name: 'Celsius Energy Drink', website: 'celsius.com' }), ['Celsius:website'])
is('website 4 brands share is no signal', m({ name: 'Sister E', website: 'www.parentco.com' }), [])
is('platform link on the roster is no signal', m({ name: 'Shop', website: 'instagram.com/shop' }), [])
is('archived match is flagged', matchRoster(clean({ name: 'Gone Brand' }), roster)[0].archived, true)
is('a new brand matches nothing', m({ name: 'Brand New Co', website: 'brandnew.co' }), [])
is('name match ranks first', m({ name: 'Celsius', linkedinUrl: 'linkedin.com/company/liquid-death-mountain-water' }), ['Celsius:name', 'Liquid Death:linkedin'])
is('no substring matches', m({ name: 'Pop' }), [])

// ---- notes ---------------------------------------------------------------
is('notes say where it came from', chatNotes(p, 'Oct 6, 2026'),
  'Added from the "Add a brand" chat · Oct 6, 2026\nInstagram: @drinkpoppi\nFound in: https://instagram.com/p/abc')

console.log(fail ? `✗ ${fail} failed, ${pass} passed` : `✓ chat-add: ${pass} passed`)
process.exit(fail ? 1 : 0)
