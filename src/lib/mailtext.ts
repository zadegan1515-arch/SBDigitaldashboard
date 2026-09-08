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

export function cleanEmailText(raw: string): string {
  let t = String(raw || '').replace(/\r/g, '')
  if (!t) return t
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
