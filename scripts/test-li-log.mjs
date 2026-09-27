// scripts/test-li-log.mjs — guards src/lib/li-log.ts (logging a LinkedIn
// person by hand: an invite sent straight from LinkedIn, or an accept for
// one nobody logged).
//
// Pinned here: a log never moves anyone backwards; "Invite sent" is dated
// now (it counts like any send); "Accepted" on someone never logged makes
// up no invite date (Leo: leave it out of the weekly limit and accept
// rates) and takes them out of any day's list; an invite already logged
// keeps its date when they accept; the same person is found by profile
// link anywhere or by name at the brand, never by name alone across two
// different links; and a profile link starts the form with a name.
// Compiles the lib on its own, like test-duplicates.mjs.
// Run: node scripts/test-li-log.mjs

import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = mkdtempSync(join(tmpdir(), 'li-log-test-'))
execSync(
  'npx tsc src/lib/li-log.ts src/lib/li-capture.ts --outDir ' + out +
  ' --target es2020 --module esnext --moduleResolution bundler --skipLibCheck',
  { stdio: 'inherit' },
)
for (const f of readdirSync(out).filter(f => f.endsWith('.js'))) {
  const p = join(out, f)
  writeFileSync(p, readFileSync(p, 'utf8').replace(/from '(\.\/[^']+)'/g, "from '$1.js'"))
}
const { nameFromSlug, logWrite, findOnFile, logChoices, isLogStage } =
  await import(pathToFileURL(join(out, 'li-log.js')).href)

let pass = 0, fail = 0
const is = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return }
  fail++; console.log('✗', label, '— got', JSON.stringify(got), 'want', JSON.stringify(want))
}

// ---- a name from a profile link ----
is('code dropped', nameFromSlug('https://www.linkedin.com/in/jane-doe-4b21a3/'), 'Jane Doe')
is('query string and no www', nameFromSlug('linkedin.com/in/sam-lee?miniProfileUrn=x'), 'Sam Lee')
is('bare slug', nameFromSlug('max-vogel-123456789'), 'Max Vogel')
is('three names', nameFromSlug('https://www.linkedin.com/in/mary-kate-olsen/'), 'Mary Kate Olsen')
is('letters after a name', nameFromSlug('https://www.linkedin.com/in/jane-doe-mba-12ab/'), 'Jane Doe')
is('accents', nameFromSlug('https://www.linkedin.com/in/jos%C3%A9-garc%C3%ADa-9a/'), 'José García')
is('one word gives nothing', nameFromSlug('https://www.linkedin.com/in/janedoe/'), null)
is('a company page gives nothing', nameFromSlug('https://www.linkedin.com/company/liquid-death/'), null)
is('empty', nameFromSlug(''), null)
is('a typed name is not a slug', nameFromSlug('Jane Doe'), null)

// ---- what one log does ----
const now = new Date('2026-09-27T15:00:00Z')
const earlier = new Date('2026-09-01T15:00:00Z')
const today = new Date('2026-09-27T04:00:00Z')
const row = (status, extra = {}) => ({ status, sentAt: null, queuedFor: null, shelved: false, ...extra })

// Nobody on file yet.
is('new person, invite sent: made, dated now', logWrite(null, 'sent', now),
  { kind: 'create', from: null, to: 'sent', data: { status: 'sent', sentAt: now, shelved: false } })
is('new person, accepted: made with no invite date', logWrite(null, 'accepted', now),
  { kind: 'create', from: null, to: 'accepted', data: { status: 'accepted', queuedFor: null, shelved: false, sentAt: null } })

// On file, not written to.
is('in the pool, invite sent: dated now, keeps its day',
  logWrite(row('drafted', { queuedFor: today }), 'sent', now),
  { kind: 'update', from: 'drafted', to: 'sent', data: { status: 'sent', sentAt: now, shelved: false } })
is('in today’s list, accepted: out of the list, no invite date made up',
  logWrite(row('drafted', { queuedFor: today }), 'accepted', now),
  { kind: 'update', from: 'drafted', to: 'accepted', data: { status: 'accepted', queuedFor: null, shelved: false } })
is('shelved, accepted: unshelved', logWrite(row('queued', { shelved: true }), 'accepted', now).data.shelved, false)
is('skipped, invite sent: a new invite', logWrite(row('passed', { sentAt: earlier }), 'sent', now).data.sentAt, now)
is('withdrawn, accepted: allowed', logWrite(row('withdrawn'), 'accepted', now).kind, 'update')
is('an old invite date on the row stays when they accept',
  'sentAt' in logWrite(row('passed', { sentAt: earlier }), 'accepted', now).data, false)

// An invite already logged.
is('logged invite, accepted: status only — the date it went out stays',
  logWrite(row('sent', { sentAt: earlier }), 'accepted', now),
  { kind: 'update', from: 'sent', to: 'accepted', data: { status: 'accepted' } })
is('logged invite, invite sent again: nothing', logWrite(row('sent', { sentAt: earlier }), 'sent', now),
  { kind: 'none', reason: 'already-sent', status: 'sent' })

// Never backwards.
is('accepted stays accepted', logWrite(row('accepted'), 'sent', now).reason, 'already-accepted')
is('accepted, accepted again: nothing', logWrite(row('accepted'), 'accepted', now).kind, 'none')
is('replied stays replied', logWrite(row('replied'), 'accepted', now).reason, 'already-replied')
is('won stays won', logWrite(row('converted'), 'sent', now).reason, 'won')

// ---- which buttons show ----
is('nobody yet: both', logChoices(null), ['sent', 'accepted'])
is('queued: both', logChoices('queued'), ['sent', 'accepted'])
is('skipped: both', logChoices('passed'), ['sent', 'accepted'])
is('invite logged: accepted only', logChoices('sent'), ['accepted'])
is('accepted: none', logChoices('accepted'), [])
is('replied: none', logChoices('replied'), [])
is('stages', [isLogStage('sent'), isLogStage('accepted'), isLogStage('replied'), isLogStage(undefined)], [true, true, false, false])

// ---- already on file? ----
const people = [
  { id: 'c1', brandId: 'b-ld', name: 'Jane Doe', linkedinUrl: 'https://www.linkedin.com/in/Jane-Doe-12ab/?trk=x' },
  { id: 'c2', brandId: 'b-ld', name: 'Sam Lee', linkedinUrl: null },
  { id: 'c3', brandId: 'b-ol', name: 'Rita Moreno', linkedinUrl: 'https://www.linkedin.com/in/rita-m/' },
  { id: 'c4', brandId: 'b-ld', name: 'Pat Kim', linkedinUrl: 'https://www.linkedin.com/in/pat-kim-1/' },
]
const hit = r => r && [r.contact.id, r.by]
is('by link, whatever the case and query string', hit(findOnFile(people, { url: 'linkedin.com/in/jane-doe-12ab', brandId: 'b-ol' })), ['c1', 'link'])
is('by link at another brand still finds them (the caller says where)', hit(findOnFile(people, { url: 'https://www.linkedin.com/in/rita-m', name: 'X', brandId: 'b-ld' })), ['c3', 'link'])
is('by name at the brand', hit(findOnFile(people, { name: 'sam lee', brandId: 'b-ld' })), ['c2', 'name'])
is('name with letters after it', hit(findOnFile(people, { name: 'Sam Lee, MBA', brandId: 'b-ld' })), ['c2', 'name'])
is('by name only at the brand being logged', findOnFile(people, { name: 'Sam Lee', brandId: 'b-ol' }), null)
is('same name, different link: a different person', findOnFile(people, { url: 'linkedin.com/in/pat-kim-99', name: 'Pat Kim', brandId: 'b-ld' }), null)
is('same name, no link on file: the same person', hit(findOnFile(people, { url: 'linkedin.com/in/sam-lee-7', name: 'Sam Lee', brandId: 'b-ld' })), ['c2', 'name'])
is('nobody', findOnFile(people, { url: 'linkedin.com/in/new-person-1', name: 'New Person', brandId: 'b-ld' }), null)

console.log(`${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
