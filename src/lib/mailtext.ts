// Makes the plain-text body of an inbound email readable.
//
// Mail that passes through Outlook / Proofpoint / Microsoft Safe Links
// arrives with every link rewritten to a tracking wrapper and every inline
// image replaced by a "[cid:image002.png@01DC…]" marker. The plain-text
// part also repeats each link right after its label ("website<https://…>").
// This turns that back into something a person can read:
//
//   * wrapped links → the real destination
//   * "Label<https://x>" → "[Label](https://x)" (rendered as a link by the UI)
//   * "<https://x>" / "<mailto:x>" → "https://x" / "x"
//   * "[cid:…]" and "[image: …]" markers removed
//   * runs of blank lines / trailing spaces collapsed
//
// Output is still plain text, so it is safe to store, search and forward.

function hexDecode(s: string, marker: string) {
  return s.replace(new RegExp(marker + '([0-9A-Fa-f]{2})', 'g'), (_, h) => String.fromCharCode(parseInt(h, 16)))
}

export function unwrapUrl(url: string): string {
  let u = url
  for (let hops = 0; hops < 3; hops++) {
    const before = u
    // Proofpoint v2: …/v2/url?u=https-3A__host_path-3Fa-3D1&d=…
    const p2 = /urldefense\.(?:proofpoint\.)?com\/v2\/url\?u=([^&\s]+)/i.exec(u)
    if (p2) { u = hexDecode(p2[1].replace(/_/g, '/'), '-'); continue }
    // Proofpoint v3: …/v3/__https://host/path*40x__;…
    const p3 = /urldefense\.(?:proofpoint\.)?com\/v3\/__(.+?)__;/i.exec(u)
    if (p3) { u = hexDecode(p3[1], '\\*'); continue }
    // Microsoft Safe Links: https://xxx.safelinks.protection.outlook.com/?url=<enc>&data=…
    const sl = /safelinks\.protection\.outlook\.com\/\?url=([^&\s]+)/i.exec(u)
    if (sl) { try { u = decodeURIComponent(sl[1]) } catch { u = sl[1] } continue }
    // Google redirect: https://www.google.com/url?q=<enc>&…
    const g = /^https?:\/\/(?:www\.)?google\.com\/url\?(?:[^#]*&)?q=([^&\s]+)/i.exec(u)
    if (g) { try { u = decodeURIComponent(g[1]) } catch { u = g[1] } continue }
    if (u === before) break
  }
  return u
}

const URL_RX = /https?:\/\/[^\s<>()\[\]"']+/g

// HTML entities that survive the html→text step of some senders
// ("&mdash;", "&zwnj;" spacer runs in marketing preheaders, "&#8217;").
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', bull: '•', middot: '·',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', deg: '°', times: '×', euro: '€', pound: '£', cent: '¢', yen: '¥',
  zwnj: '', zwj: '', shy: '', ensp: ' ', emsp: ' ', thinsp: ' ',
}
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m
    }
    const v = ENTITIES[e.toLowerCase()]
    return v === undefined ? m : v
  })
}

export function cleanEmailText(raw: string): string {
  let t = decodeEntities(String(raw || '').replace(/\r/g, ''))
  if (!t) return t
  // invisible spacer characters marketing senders pad preheaders with
  t = t.replace(/[\u200B\u200C\u200D\u2060\uFEFF\u00AD\u034F]/g, '')
  // 1. real destinations instead of tracking wrappers
  t = t.replace(URL_RX, u => {
    const trail = /[.,;:!?]+$/.exec(u)?.[0] || ''
    return unwrapUrl(u.slice(0, u.length - trail.length)) + trail
  })
  // 2. inline image / cid markers
  t = t.replace(/\[cid:[^\]]*\]/gi, '').replace(/\[(?:image|logo|photo)[^\]]{0,120}\]/gi, '')
  // 3. "label<url>" pairs from Outlook's text rendering
  t = t.replace(/([^\s<>\[\]()]*)\s?<((?:https?:\/\/|mailto:)[^>\s]+)>/g, (_, label: string, url: string) => {
    const bare = url.replace(/^mailto:/i, '')
    const norm = (s: string) => s.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '').toLowerCase()
    if (!label || norm(label) === norm(bare)) return bare              // "www.x.com<https://www.x.com/>" → one copy
    if (/^[\w.+-]+@[\w.-]+$/.test(label) && label.toLowerCase() === bare.toLowerCase()) return bare
    if (/[:,;]$/.test(label)) return `${label} ${bare}`                 // "Website: <https://x>" → "Website: https://x"
    return `[${label}](${url})`
  })
  // 4. whitespace
  t = t.split('\n').map(l => l.replace(/[ \t]+$/g, '').replace(/^[ \t]{0,3}(?=\S)/, '')).join('\n')
  t = t.replace(/\n{3,}/g, '\n\n').trim()
  return t
}
