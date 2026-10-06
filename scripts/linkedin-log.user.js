// ==UserScript==
// @name         SB Dashboard — Log LinkedIn Invites
// @namespace    sbagency.command-center
// @version      1.1
// @description  For Zach's LinkedIn: on someone's profile, log that you invited them or that they accepted; on a company's People page, read the marketing / partnerships people you can see into the SB Command Center. Only when you click.
// @match        https://www.linkedin.com/*
// @match        https://linkedin.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @connect      sb-digitaldashboard.vercel.app
// @updateURL    https://raw.githubusercontent.com/zadegan1515-arch/SBDigitaldashboard/main/scripts/linkedin-log.user.js
// @downloadURL  https://raw.githubusercontent.com/zadegan1515-arch/SBDigitaldashboard/main/scripts/linkedin-log.user.js
// ==/UserScript==

// -------------------------------------------------------------------
// Logging only, for the browser that's signed in to ZACH'S LinkedIn
// (Leo, Sep 2026: "get rid of everything but the logging people on
// Zach's LinkedIn"). Zach's account sends the connection requests, and
// invites often go out straight from LinkedIn, unlogged. On someone's
// profile the pill logs them in one click:
//   · Invite sent  — dated now, counts like any send;
//   · They accepted — straight onto Zach's list in the dashboard.
// Never through a day's queue; the dashboard decides the rest
// (src/lib/li-log.ts). Each log has an Undo.
//
// It only ever reads the one page that's open, and only when Zach
// clicks: a profile (log them), or — since 1.1 (Leo, Oct 6 2026) — a
// company's People page ("Read this page": scrolls that page, previews,
// Add). It has no "Fill brands by itself", no run and no page-to-page
// browsing on its own — those are in linkedin-capture.user.js, which stays
// on Leo's own LinkedIn and must never be installed here.
//
// TO INSTALL (once, in Zach's browser): Tampermonkey -> + (new script) ->
// select ALL of the sample text and paste this over it -> save. Chrome
// also needs Tampermonkey's "Allow User Scripts" switch on (Extensions ->
// Tampermonkey -> Details). Then open LinkedIn, press the pill and paste
// the ingest token — the same value as INGEST_TOKEN in Vercel. Tampermonkey
// keeps it in its own storage (LinkedIn can't read it) and it only goes to
// the dashboard. Updates come from GitHub by themselves.
// -------------------------------------------------------------------

(function () {
  'use strict';

  // Top page only: LinkedIn's same-origin frames would each get a copy.
  if (window.top !== window.self) return;

  var INGEST_URL = 'https://sb-digitaldashboard.vercel.app/api/ingest';
  var DASH_URL = 'https://sb-digitaldashboard.vercel.app/app.html';
  var TOKEN_KEY = 'sbIngestToken';
  var VERSION = '1.1';
  // The dashboard refuses LinkedIn calls from an older card reader
  // (LI_READER in src/lib/li-sweep.ts). This reads a profile, not cards,
  // and sends the current number so its calls are let through.
  var READER = 2;

  // The @grant lines give this script Tampermonkey's storage and
  // requests. A paste that lost the header runs without them — say so.
  var HAS_GM = typeof GM_xmlhttpRequest === 'function' && typeof GM_getValue === 'function';

  function token() {
    try { return GM_getValue(TOKEN_KEY, '') || ''; } catch (e) { return ''; }
  }
  function saveToken(t) {
    try { GM_setValue(TOKEN_KEY, String(t || '').trim()); } catch (e) {}
  }
  function forgetToken() {
    try { GM_deleteValue(TOKEN_KEY); } catch (e) {}
  }

  // LinkedIn's content security policy blocks a page-level fetch to any
  // other site, so the request goes through Tampermonkey instead.
  function post(payload) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'POST',
        url: INGEST_URL,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(Object.assign({ token: token(), reader: READER }, payload)),
        timeout: 45000,
        onload: function (r) {
          if (r.status === 401) return reject(new Error('The dashboard did not accept the token. Use "Change the token" below.'));
          var j = null;
          try { j = JSON.parse(r.responseText); } catch (e) {}
          if (!j) return reject(new Error('The dashboard answered ' + r.status + '.'));
          resolve(j);
        },
        onerror: function () { reject(new Error('Could not reach the dashboard.')); },
        ontimeout: function () { reject(new Error('The dashboard took too long to answer.')); },
      });
    });
  }

  // A click that fails says so, instead of doing nothing.
  function report(e) {
    var msg = (e && e.message) || String(e);
    try { showError(msg); }
    catch (e2) { alert('SB Log: ' + msg); }
  }
  function guard(fn) {
    return function () {
      try { return fn.apply(this, arguments); } catch (e) { report(e); }
    };
  }

  // ---- reading the page ----------------------------------------------

  // The header's "Me" link, dialogs, side rails and our own panel are not
  // the person.
  function skipZone(el) {
    return !!el.closest('#global-nav, header, nav, aside, [role="dialog"], .sb-li-ui');
  }
  // LinkedIn's furniture, not the person: buttons, the "· 2nd" / "• 3rd+"
  // badge, pronouns, counts.
  var NOISE = /^(connect|follow|following|message|pending|more|send inmail|view profile|[·•])$|degree connection|^[·•]\s*(1st|2nd|3rd\+?)$|^(1st|2nd|3rd\+?)$|mutual connection|^view .*profile$|^status is|followers$|^open to work$|^linkedin member$|^\(?(she|he|they)\s*\/\s*(her|him|them)\)?$/i;
  var DEGREE_TAIL = /\s*[·•]\s*(1st|2nd|3rd\+?)\s*$/i;
  var PRONOUN_TAIL = /\s*\((she|he|they)\s*\/\s*(her|him|them)\)\s*$/i;
  function personName(s) {
    return String(s || '').replace(DEGREE_TAIL, '').replace(PRONOUN_TAIL, '').replace(/\s+/g, ' ').trim();
  }
  function lines(el) {
    return String(el.innerText || el.textContent || '').split('\n')
      .map(function (s) { return s.replace(/\s+/g, ' ').trim(); })
      .filter(function (s) { return s && !NOISE.test(s); });
  }

  // ---- the panel -------------------------------------------------------
  //
  // Built node by node, never innerHTML: LinkedIn allows only its own
  // Trusted Types policy, and it scrubs inserted HTML.

  var pill, panel;

  var PANEL_CSS = 'all:initial;display:block;box-sizing:border-box;position:fixed;bottom:64px;left:16px;z-index:2147483647;background:#fff;color:#111;border:1px solid #d9d9d6;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.25);padding:14px 16px;font:13px/1.45 system-ui,-apple-system,sans-serif;width:340px;max-height:80vh;overflow:auto;text-align:left';
  var BTN = 'display:block;box-sizing:border-box;width:100%;background:#111;color:#fff;border:0;border-radius:7px;padding:9px 12px;cursor:pointer;font:600 13px system-ui,-apple-system,sans-serif';
  var BTN2 = 'display:block;box-sizing:border-box;width:100%;background:#fff;color:#111;border:1px solid #ccc;border-radius:7px;padding:8px 12px;cursor:pointer;font:13px system-ui,-apple-system,sans-serif;text-align:center;text-decoration:none';
  var MUTED = 'color:#555;margin-bottom:8px';
  var SMALL = 'color:#999;font-size:11px;margin-top:8px';

  // h('div', { style: '…', text: '…', id: '…', onclick: fn }, [children])
  // Children are nodes or plain strings (added as text, never as HTML).
  function h(tag, props, kids) {
    var el = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      var v = props[k];
      if (v == null || v === false) return;
      if (k === 'style') el.style.cssText = v;
      else if (k === 'text') el.textContent = v;
      else if (k.indexOf('on') === 0) el[k] = v;
      else if (k === 'value' || k === 'disabled' || k === 'open' || k === 'checked') el[k] = v;
      else el.setAttribute(k, v);
    });
    (kids || []).forEach(function (c) {
      if (c == null || c === false || c === '') return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }
  function b(text) { return h('b', { text: text }); }

  function freshPanel(kids) {
    if (panel) panel.remove();
    panel = h('div', { id: 'sblog-panel', 'class': 'sb-li-ui', style: PANEL_CSS }, kids);
    // On <html>, not <body>: a transform LinkedIn puts on <body> would pin
    // a fixed element to it, possibly off screen.
    document.documentElement.appendChild(panel);
    return panel;
  }
  function closePanel() { if (panel) { panel.remove(); panel = null; } }

  function head(title) {
    return h('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:8px' }, [
      h('div', { style: 'width:22px;height:22px;border-radius:6px;background:#111;color:#fff;font-weight:700;font-size:11px;display:flex;align-items:center;justify-content:center', text: 'SB' }),
      h('b', { style: 'flex:1', text: title }),
      h('span', { style: 'cursor:pointer;color:#999;font-size:16px', text: '×', title: 'Close', onclick: closePanel }),
    ]);
  }

  function tokenLink() {
    return h('div', { style: 'margin-top:10px' }, [
      h('a', {
        href: '#', style: 'color:#999;font-size:11px', text: 'Change the token',
        onclick: function (e) { e.preventDefault(); forgetToken(); openSetup(); },
      }),
    ]);
  }

  function showError(msg) {
    freshPanel([
      head('Something went wrong'),
      h('div', { style: 'color:#b00', text: msg }),
      tokenLink(),
    ]);
  }

  function openSetup() {
    var input = h('input', {
      id: 'sblogtok', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'Ingest token',
      style: 'display:block;width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #ccc;border-radius:6px;margin-bottom:10px;font:13px system-ui;color:#111;background:#fff',
    });
    var msg = h('span', { style: 'font-size:11.5px;flex:1' });
    var say = function (text, color) { msg.textContent = text; msg.style.color = color || '#555'; };
    var save = function () {
      var v = (input.value || '').trim();
      if (!v) return say('Paste the token first.', '#b00');
      saveToken(v);
      say('Checking…', '#137333');
      // Proves the token now; saves nothing.
      post({ action: 'liVersion' }).then(function (j) {
        if (j && j.ok) { openMenu(); return; }
        forgetToken();
        say((j && j.error) || 'The dashboard rejected that token.', '#b00');
      }).catch(function (e) {
        forgetToken();
        say(e.message, '#b00');
      });
    };
    input.onkeydown = function (e) { if (e.key === 'Enter') save(); };
    freshPanel([
      head('Connect to the SB dashboard'),
      h('div', { style: 'color:#555;font-size:12px;margin-bottom:10px', text: 'Paste the ingest token — the same value as INGEST_TOKEN in Vercel. Tampermonkey keeps it; LinkedIn can\'t read it; it only goes to the dashboard.' }),
      input,
      h('div', { style: 'display:flex;gap:8px;align-items:center' }, [
        h('button', { id: 'sblogtoksave', style: 'background:#111;color:#fff;border:0;border-radius:7px;padding:7px 12px;cursor:pointer;font:600 13px system-ui', text: 'Save', onclick: save }),
        msg,
      ]),
    ]);
    input.focus();
  }

  function openBroken() {
    freshPanel([
      head('Reinstall this script'),
      h('div', { style: MUTED }, ['Tampermonkey is running this script without its settings lines, so it can\'t reach the dashboard. That happens when it was pasted ', b('under'), ' Tampermonkey\'s sample script.']),
      h('div', { style: 'color:#555', text: 'Tampermonkey → Dashboard → open this script → select everything (Ctrl/Cmd+A) → paste the script from GitHub over it → save.' }),
    ]);
  }

  // Anywhere but a profile: it only says where to go.
  function openNotProfile() {
    freshPanel([
      head('SB · Log'),
      h('div', { style: MUTED }, ['Open the person\'s ', b('profile'), ', then press this pill to log that you invited them, or that they accepted.']),
      h('a', { href: DASH_URL + '#zach', target: '_blank', rel: 'noopener', style: BTN2, text: 'Open Zach\'s list ↗' }),
      tokenLink(),
    ]);
  }

  function openMenu() {
    if (!HAS_GM) return openBroken();
    if (!token()) return openSetup();
    if (profilePath()) return openProfile();
    if (profileSubpage()) return openProfileSubpage();
    if (companyPath()) return openPeople();
    return openNotProfile();
  }

  // ---- the profile: who, and log them -------------------------------

  var lastProfile = null;

  // The profile's own page: /in/<slug>/ (not its Experience / Contact
  // info subpages, whose <h1> isn't the name).
  function profilePath() {
    var m = location.pathname.match(/^\/in\/([^\/?#]+)\/?$/);
    return m ? m[1] : null;
  }
  function profileSubpage() {
    var m = location.pathname.match(/^\/in\/([^\/?#]+)\/.+/);
    return m ? m[1] : null;
  }
  function openProfileSubpage() {
    freshPanel([
      head('SB · Log'),
      h('div', { style: MUTED, text: 'To log this person, open their main profile page and press the pill there.' }),
      h('a', { href: location.origin + '/in/' + profileSubpage() + '/', style: BTN2, text: 'Open their profile' }),
      tokenLink(),
    ]);
  }

  // Lines in the top card that aren't the person: LinkedIn's badges,
  // buttons and counts.
  var PROFILE_NOISE = /^(verified|contact info|hiring|provides services|premium|\d[\d,]*\+?\s+(connections|followers))$|^(she|he|they)\s*\/\s*(her|him|them)$/i;

  // Their current company, as a first guess the panel lets Leo change:
  // LinkedIn's "Current company" line in the top card, else the first
  // company named in Experience, else "… at Company" in the headline.
  var EMPLOYMENT = /^(.+?)\s[·•]\s(?:full-time|part-time|contract|self-employed|freelance|internship|seasonal|apprenticeship)\b/i;
  function currentCompany(headline) {
    // "Current company: Liquid I.V.. Click to skip to experience card"
    var cur = document.querySelector('[aria-label^="Current company"]');
    if (cur && !skipZone(cur)) {
      var al = cur.getAttribute('aria-label') || '';
      var m = al.match(/^Current company:\s*(.+?)(?:\.\s*Click\b.*)?$/i);
      var name = (m ? m[1] : (lines(cur)[0] || '')).trim();
      var a = cur.closest('a[href*="/company/"]') || cur.querySelector('a[href*="/company/"]');
      if (name) return { name: name.slice(0, 120), url: a ? a.href : '' };
    }
    var anchor = document.getElementById('experience');
    var sec = anchor ? (anchor.closest('section') || anchor.parentElement) : null;
    if (sec) {
      // The first job's logo says the company ("Liquid I.V. logo").
      var logo = sec.querySelector('a[href*="/company/"] img[alt]');
      var alt = logo ? String(logo.getAttribute('alt') || '').replace(/\s*logo\s*$/i, '').trim() : '';
      if (alt) return { name: alt.slice(0, 120), url: logo.closest('a').href };
      // "Liquid I.V. · Full-time" names it too; a bare first line is as
      // likely the job title, so it's left alone.
      var links = [].slice.call(sec.querySelectorAll('a[href*="/company/"]'));
      for (var i = 0; i < links.length; i++) {
        var ls = lines(links[i]);
        for (var k = 0; k < ls.length; k++) {
          var em = ls[k].match(EMPLOYMENT);
          if (em) return { name: em[1].trim().slice(0, 120), url: links[i].href };
        }
      }
      if (links.length) return { name: '', url: links[0].href };
    }
    var hm = String(headline || '').match(/\s(?:at|@)\s+([^|•·,]+)/i);
    return { name: hm ? hm[1].trim().slice(0, 120) : '', url: '' };
  }

  // Name, headline, profile link and current company. LinkedIn's class
  // names change, so the text decides: the name is the page's <h1> (else
  // the tab title), the headline the first real line after it.
  function readProfile() {
    var slug = profilePath();
    var h1 = [].slice.call(document.querySelectorAll('main h1, h1')).filter(function (x) { return !skipZone(x); })[0] || null;
    var name = h1 ? personName(lines(h1)[0] || '') : '';
    if (!name) name = personName(document.title.replace(/^\(\d+\+?\)\s*/, '').split('|')[0]);
    var headline = '';
    var box = h1 ? (h1.closest('section') || h1.parentElement) : null;
    if (box) {
      var all = lines(box);
      var at = -1;
      for (var i = 0; i < all.length; i++) {
        if (personName(all[i]) === name || (name && all[i].indexOf(name) === 0)) { at = i; break; }
      }
      // Pronouns and the "· 2nd" badge ride on their own line ("She/Her
      // · 2nd"): cleaned first, then skipped.
      for (var j = at + 1; j < all.length && !headline; j++) {
        var l = personName(all[j]);
        if (l && l !== name && !PROFILE_NOISE.test(l) && !NOISE.test(l)) headline = l;
      }
    }
    var co = currentCompany(headline);
    return {
      url: slug ? 'https://www.linkedin.com/in/' + slug + '/' : '',
      name: name.slice(0, 80),
      headline: headline.slice(0, 300),
      companyName: co.name,
      companyUrl: co.url,
    };
  }

  function openProfile() {
    lastProfile = readProfile();
    freshPanel([
      head(lastProfile.name || 'This profile'),
      h('div', { id: 'sblogprof', style: MUTED, text: 'Checking the dashboard…' }),
    ]);
    return lookupProfile({});
  }

  function lookupProfile(pick) {
    var p = lastProfile;
    return post({
      action: 'liPerson',
      url: p.url, name: p.name, headline: p.headline,
      companyName: p.companyName, companyUrl: p.companyUrl,
      brandName: pick.brandName || '', brandId: pick.brandId || '',
    }).then(function (j) {
      if (!j || !j.ok) return showError((j && j.error) || 'The dashboard could not read that.');
      renderProfile(j, pick.brandName || '');
    }).catch(function (e) { showError(e.message); });
  }

  // "LinkedIn · invite sent Sep 20" — where someone on file stands.
  function stateWords(p) {
    var d = p.sentAt ? new Date(p.sentAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
    switch (p.status) {
      case null: case undefined: case '': return 'not contacted yet';
      case 'queued': case 'drafted': return 'in the LinkedIn queue, not sent yet';
      case 'sent': return 'invite sent' + (d ? ' ' + d : '');
      case 'accepted': return 'accepted';
      case 'replied': return 'replied';
      case 'converted': return 'won';
      case 'passed': return 'skipped';
      case 'withdrawn': return 'invite withdrawn';
      default: return p.status;
    }
  }

  function stageButtons(choices, onPick, prefix) {
    return choices.map(function (s) {
      var accepted = s === 'accepted';
      var btn = h('button', {
        id: accepted ? 'sblogacc' : 'sblogsent',
        style: (accepted ? BTN : BTN2) + ';margin-top:8px',
        text: (prefix || '') + (accepted ? 'They accepted ✓' : 'Invite sent ✓'),
        title: accepted
          ? 'Straight onto Zach\'s list. The invite went out unlogged, so it stays out of the weekly limit and accept rates.'
          : 'You just sent the invite from LinkedIn: logged today, counts like any send. Press the pill again when they accept.',
      });
      btn.onclick = guard(function () { onPick(s, btn); });
      return btn;
    });
  }

  function renderProfile(j, typed) {
    var p = lastProfile;
    var nameBox = h('input', { id: 'sblogname', value: j.nameGuess || p.name || '', placeholder: 'Name', style: 'display:block;width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font:12.5px system-ui;color:#111;background:#fff;margin-bottom:6px' });
    var titleBox = h('input', { id: 'sblogtitle', value: j.titleGuess || '', placeholder: 'Title (optional)', style: 'display:block;width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font:12.5px system-ui;color:#111;background:#fff' });

    // On file already (by profile link, or by name at the brand).
    if (j.person) {
      var pp = j.person;
      var kids = [
        head(pp.name),
        h('div', { style: 'margin-bottom:4px' }, ['On file at ', b(pp.brand.name), pp.brand.archived ? ' (archived)' : '', ' · ' + stateWords(pp)]),
        pp.title ? h('div', { style: 'font-size:12px;color:#555', text: pp.title }) : null,
      ];
      if (pp.choices && pp.choices.length) {
        kids = kids.concat(stageButtons(pp.choices, function (stage, btn) { logProfile({ contactId: pp.contactId, stage: stage }, btn); }));
      } else {
        kids.push(h('div', { style: 'margin-top:8px;color:#137333', text: pp.status === 'accepted' ? 'Already accepted: they\'re on Zach\'s list.' : 'Already ' + stateWords(pp) + '. Nothing to log.' }));
      }
      kids.push(h('a', { href: DASH_URL + '#brand/' + pp.brand.id, target: '_blank', rel: 'noopener', style: BTN2 + ';margin-top:10px', text: 'Open ' + pp.brand.name + ' in the dashboard ↗' }));
      kids.push(profileSampleLink());
      kids.push(tokenLink());
      freshPanel(kids);
      return;
    }

    // Not on file: which brand, then the two buttons.
    var brandBox = h('input', {
      id: 'sblogbrand', value: typed || (j.brand ? j.brand.name : ''), placeholder: 'Dashboard brand name',
      style: 'flex:1;min-width:0;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font:12.5px system-ui;color:#111;background:#fff',
    });
    var check = function () { lookupProfile({ brandName: brandBox.value.trim() }); };
    brandBox.onkeydown = function (e) { if (e.key === 'Enter') check(); };
    var brandLine = j.brand
      ? h('div', { style: 'margin-bottom:4px' }, ['Goes under ', b(j.brand.name), j.brand.archived ? ' (archived)' : ''])
      : h('div', { style: 'color:#946200;margin-bottom:4px', text: j.notFound
          ? 'No brand called "' + j.notFound + '" in the dashboard.'
          : 'Which dashboard brand? ' + (p.companyName ? 'None matched "' + p.companyName + '".' : 'Type it below.') });
    var chips = !j.brand && j.suggestions && j.suggestions.length
      ? h('div', { style: 'display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px' }, j.suggestions.map(function (s) {
          return h('button', {
            style: 'border:1px solid #ddd;background:#fff;color:#111;border-radius:99px;padding:3px 9px;cursor:pointer;font:12px system-ui',
            text: s, onclick: guard(function () { lookupProfile({ brandName: s }); }),
          });
        }))
      : null;
    var fields = function () { return { name: nameBox.value.trim(), title: titleBox.value.trim() }; };
    var send = function (stage, btn, create) {
      var f = fields();
      if (!f.name) { nameBox.focus(); return; }
      logProfile({
        stage: stage, url: p.url, name: f.name, title: f.title,
        brandId: j.brand ? j.brand.id : '', brandName: j.brand ? '' : (typed || ''),
        createIfMissing: !!create,
        companyName: p.companyName, companyUrl: p.companyUrl, headline: p.headline,
      }, btn);
    };
    var go = j.brand
      ? stageButtons(['sent', 'accepted'], function (stage, btn) { send(stage, btn, false); })
      : j.createName
        ? [h('div', { style: 'font-size:12px;color:#555;margin-top:10px' }, ['Not a brand in the dashboard yet? Add ', b(j.createName), ':'])]
            .concat(stageButtons(['sent', 'accepted'], function (stage, btn) { send(stage, btn, true); }, 'New brand + '))
        : [];

    freshPanel([
      head(p.name || 'This profile'),
      h('div', { style: 'font-size:12px;color:#555;margin-bottom:8px', text: 'Not in the dashboard yet.' + (p.headline ? ' ' + p.headline : '') }),
      brandLine,
      chips,
      h('div', { style: 'display:flex;gap:6px;margin:6px 0 8px' }, [
        brandBox,
        h('button', {
          id: 'sblogcheck', text: j.brand ? 'Change' : 'Check',
          style: 'background:#fff;color:#111;border:1px solid #ccc;border-radius:6px;padding:5px 10px;cursor:pointer;font:12.5px system-ui',
          onclick: guard(check),
        }),
      ]),
      nameBox,
      titleBox,
    ].concat(go, [
      h('div', { style: SMALL, text: 'Nothing goes through today\'s LinkedIn list. They accepted = straight onto Zach\'s list.' }),
      profileSampleLink(),
      tokenLink(),
    ]));
  }

  function logProfile(payload, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    return post(Object.assign({ action: 'liPersonLog' }, payload)).then(function (j) {
      if (!j || !j.ok) return showError((j && j.error) || 'Nothing was saved.');
      renderLogged(j);
    }).catch(function (e) { showError(e.message); });
  }

  function renderLogged(j) {
    var what = j.noop
      ? (j.noop === 'already-accepted' ? 'already accepted: they\'re on Zach\'s list. Nothing changed.'
        : j.noop === 'already-sent' ? 'the invite is already logged. Nothing changed.'
        : 'already further along. Nothing changed.')
      : j.status === 'accepted' ? 'accepted. They\'re on Zach\'s list.'
      : 'invite sent, logged today. Press the pill again when they accept.';
    var undo = null;
    if (j.undo) {
      undo = h('button', { id: 'sblogundo', style: BTN2 + ';margin-top:8px', text: 'Undo' });
      undo.onclick = guard(function () {
        undo.disabled = true;
        post({ action: 'liPersonUndo', undo: j.undo }).then(function (u) {
          if (!u || !u.ok) return showError((u && u.error) || 'Could not undo that.');
          freshPanel([head('Undone'), h('div', { style: MUTED, text: u.removed ? j.name + ' is off the dashboard again.' : j.name + ' is back as before.' })]);
        }).catch(function (e) { showError(e.message); });
      });
    }
    freshPanel([
      head(j.noop ? 'Already logged' : 'Logged'),
      j.brandCreated ? h('div', { style: 'margin-bottom:6px;color:#137333' }, [b(j.brand.name), ' is now a brand in the dashboard. Its category is a guess — check it on the brand page.']) : null,
      h('div', { style: 'margin-bottom:6px' }, [b(j.name), ' · ' + j.brand.name + ': ' + what]),
      undo,
      h('a', {
        href: DASH_URL + (j.status === 'accepted' ? '#zach' : '#brand/' + j.brand.id), target: '_blank', rel: 'noopener',
        style: BTN2 + ';margin-top:8px', text: j.status === 'accepted' ? 'Open Zach\'s list ↗' : 'Open ' + j.brand.name + ' in the dashboard ↗',
      }),
    ]);
  }

  // A profile's version of "Copy a sample for Claude": what the reader
  // made of the top card, for when LinkedIn changes it.
  function copyProfileSample() {
    var p = readProfile();
    var h1 = document.querySelector('main h1, h1');
    var box = h1 ? (h1.closest('section') || h1.parentElement) : null;
    var out = ['SB LinkedIn profile sample · log script ' + VERSION + ' · ' + location.pathname,
      'read as ' + JSON.stringify(p),
      'lines ' + JSON.stringify(box ? lines(box).slice(0, 20) : []),
      String(box ? box.outerHTML : 'no <h1> on this page')
        .replace(/<img[^>]*>/g, '<img>')
        .replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>')
        .replace(/\s(src|srcset|style|data-[\w-]+|tabindex|role)="[^"]*"/g, '')
        .replace(/\s+/g, ' ')
        .slice(0, 4000)];
    var text = out.join('\n');
    var copied = false;
    try { GM_setClipboard(text, 'text'); copied = true; } catch (e) {}
    var ta = h('textarea', { style: 'display:block;box-sizing:border-box;width:100%;height:120px;font:11px monospace;margin-top:8px;color:#111;background:#fff;border:1px solid #ccc;border-radius:6px', value: text });
    freshPanel([
      head(copied ? 'Copied' : 'Copy this'),
      h('div', { style: MUTED, text: copied ? 'Paste it into the chat with Claude.' : 'Select all in the box and copy it, then paste it into the chat with Claude.' }),
      ta,
    ]);
    ta.select();
  }
  function profileSampleLink() {
    return h('div', { style: 'margin-top:6px' }, [
      h('a', {
        href: '#', style: 'color:#999;font-size:11px', text: 'Name or company wrong? Copy a sample for Claude',
        onclick: function (e) { e.preventDefault(); copyProfileSample(); },
      }),
    ]);
  }

  // ---- a company's People page, read by hand (Leo, Oct 6 2026) --------
  //
  // "When the run is on my account it does not give access to all of the
  // people at a company but it does on Zach's": LinkedIn hides people
  // outside your network as "LinkedIn Member", and Zach's network is the
  // big one. So on a company's People page this pill can read the people
  // Zach can see — only when he presses "Read this page", only the page
  // that's open (it scrolls it and presses "Show more" like a person
  // would, up to 150 people), never another page by itself. No run, no
  // fill: an automatic run is what LinkedIn restricts, and this is the
  // account that sends the invites. Same preview → Add as Leo's People
  // script; buyers only, the 25 cap, never anyone already on file.

  var PROFILE_SEL = 'a[href*="/in/"]';
  var MAX_PEOPLE = 150, MAX_ROUNDS = 15;
  var KEYWORDS = ['partnerships', 'marketing', 'sponsorship', 'brand', 'events'];
  var HALT_TEXT = /commercial use limit|unusual activity|security verification|quick security check|verify (?:that )?you'?re (?:a )?human|too many requests|you'?ve reached the (?:weekly|monthly) limit|account (?:has been )?restricted|temporarily restricted/i;

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function rand(a, c) { return a + Math.floor(Math.random() * (c - a)); }
  function pageText(n) {
    try { return String(document.body ? document.body.innerText : '').slice(0, n || 20000); } catch (e) { return ''; }
  }
  function companyPath() {
    var m = location.pathname.match(/^\/(company|showcase)\/([^\/?#]+)/);
    return m ? { kind: m[1], slug: m[2] } : null;
  }
  function onPeoplePage() {
    return /^\/(company|showcase)\/[^\/]+\/people(\/|$)/.test(location.pathname);
  }
  function companyBase() {
    var c = companyPath();
    return c ? location.origin + '/' + c.kind + '/' + c.slug + '/' : null;
  }
  function companyName() {
    var el = document.querySelector('.org-top-card-summary__title, main h1, h1');
    var t = el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '';
    if (!t) t = document.title.replace(/^\(\d+\+?\)\s*/, '').split(/[:|]/)[0].trim();
    return t.slice(0, 120);
  }
  function companyIndustry() {
    var el = document.querySelector('.org-top-card-summary-info-list__info-item, .org-top-card-summary-info-list');
    return el ? String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  }
  function slugOf(href) {
    var m = String(href || '').match(/\/in\/([^\/?#]+)/);
    return m ? m[1].toLowerCase() : null;
  }
  function profileLinks(root) {
    return [].slice.call((root || document).querySelectorAll(PROFILE_SEL)).filter(function (a) {
      return !skipZone(a) && slugOf(a.getAttribute('href'));
    });
  }
  function distinctSlugs(el) {
    var s = {};
    [].slice.call(el.querySelectorAll(PROFILE_SEL)).forEach(function (a) { var k = slugOf(a.getAttribute('href')); if (k) s[k] = 1; });
    return Object.keys(s).length;
  }
  function countPeople() {
    var s = {};
    profileLinks().forEach(function (a) { s[slugOf(a.getAttribute('href'))] = 1; });
    return Object.keys(s).length;
  }
  function cardFor(a) {
    var li = a.closest('li');
    if (li && !skipZone(li) && distinctSlugs(li) === 1) return li;
    var el = a;
    while (el.parentElement && el.parentElement !== document.body) {
      var p = el.parentElement;
      if (distinctSlugs(p) > 1) break;
      el = p;
      if (lines(el).length > 14) break;
    }
    return el;
  }
  function readCard(card) {
    var all = lines(card);
    var name = null;
    profileLinks(card).forEach(function (a) { if (!name) name = personName(lines(a)[0]) || null; });
    if (!name) name = personName(all[0]) || null;
    var subEl = card.querySelector('.artdeco-entity-lockup__subtitle');
    var headline = subEl ? personName(lines(subEl).join(' ')) : '';
    if (!headline && name) {
      var at = -1;
      for (var i = 0; i < all.length; i++) { if (personName(all[i]) === name || all[i].indexOf(name) === 0) { at = i; break; } }
      for (var j = at + 1; j < all.length && !headline; j++) {
        var l = personName(all[j]);
        if (l && l !== name) headline = l;
      }
    }
    return { name: name, headline: headline };
  }
  function scrapePeople() {
    var done = {}, rows = [];
    profileLinks().forEach(function (a) {
      var slug = slugOf(a.getAttribute('href'));
      if (done[slug]) return;
      var got = readCard(cardFor(a));
      if (!got.name || /^linkedin member$/i.test(got.name) || got.name.length > 80) return;
      done[slug] = 1;
      rows.push({ name: got.name, headline: got.headline, linkedinUrl: 'https://www.linkedin.com/in/' + slug + '/' });
    });
    return rows;
  }
  function hiddenMembers() {
    var seen = [];
    [].slice.call(document.querySelectorAll('main *')).forEach(function (el) {
      if (el.children.length || skipZone(el)) return;
      if (!/^linkedin member$/i.test(String(el.textContent || '').trim())) return;
      var c = el.closest('li') || el.parentElement;
      if (seen.indexOf(c) < 0) seen.push(c);
    });
    return seen.length;
  }
  function peopleCount() {
    var m = /([\d][\d,.]*)\s*([KM])?\+?\s+associated members?/i.exec(pageText(8000));
    if (!m) return null;
    var n = parseFloat(m[1].replace(/,/g, ''));
    if (!isFinite(n)) return null;
    if (m[2]) n *= /k/i.test(m[2]) ? 1e3 : 1e6;
    return Math.round(n);
  }
  function moreButton() {
    var bs = [].slice.call(document.querySelectorAll('button'));
    for (var i = 0; i < bs.length; i++) {
      var x = bs[i];
      if (x.disabled || skipZone(x) || !x.offsetParent) continue;
      if (/^(show more results|show more|load more)$/i.test((x.innerText || x.textContent || '').trim())) return x;
    }
    return null;
  }
  // Scroll the way a person would: to the bottom, a pause, "Show more
  // results" if it's there, a longer pause. Stops when the list stops
  // growing, at 150 people, or when Stop is pressed.
  function expand(onProgress, halt) {
    return new Promise(function (resolve) {
      var rounds = 0, still = 0, last = countPeople();
      function step() {
        if (halt.stopped || rounds >= MAX_ROUNDS || last >= MAX_PEOPLE) return resolve();
        rounds++;
        var links = profileLinks();
        if (links.length) links[links.length - 1].scrollIntoView({ block: 'end' });
        window.scrollTo(0, document.body.scrollHeight);
        wait(rand(900, 1600)).then(function () {
          if (halt.stopped) return;
          var more = moreButton();
          if (more) more.click();
          return wait(more ? rand(1300, 2200) : rand(500, 900));
        }).then(function () {
          var n = countPeople();
          onProgress(n);
          still = n <= last ? still + 1 : 0;
          last = Math.max(last, n);
          if (still >= 2) return resolve();
          step();
        }).catch(function () { resolve(); });
      }
      step();
    });
  }

  function keywordChips() {
    var base = companyBase();
    if (!base) return null;
    return h('div', {}, [
      h('div', { style: 'font-size:11.5px;color:#777;margin:10px 0 5px', text: 'Big company? Open a narrower view, then read it:' }),
      h('div', { style: 'display:flex;flex-wrap:wrap;gap:5px' }, KEYWORDS.map(function (k) {
        return h('a', {
          href: base + 'people/?keywords=' + encodeURIComponent(k),
          style: 'border:1px solid #ddd;border-radius:99px;padding:3px 9px;color:#111;text-decoration:none;font-size:12px',
          text: k,
        });
      })),
    ]);
  }

  var lastRead = null, reading = false;

  function openPeople() {
    if (reading) return;
    if (!onPeoplePage()) {
      return freshPanel([
        head(companyName() || 'SB · Log'),
        h('div', { style: MUTED }, ['To add this company\'s marketing / partnerships people, open its ', b('People'), ' tab, then press this pill.']),
        h('button', { id: 'sblogopenpeople', style: BTN, text: 'Open the People tab', onclick: function () { location.href = companyBase() + 'people/'; } }),
        tokenLink(),
      ]);
    }
    freshPanel([
      head(companyName() || 'People'),
      h('div', { style: MUTED }, ['Reads the people ', b('you can see'), ' on this page and adds the marketing / partnerships ones to the brand in the dashboard. You see who first; nothing is saved until you press Add.']),
      h('button', { id: 'sblogread', style: BTN, text: 'Read this page', onclick: guard(readPeople) }),
      keywordChips(),
      h('div', { style: SMALL, text: 'Only this page, only when you press Read. It scrolls like you would (up to ' + MAX_PEOPLE + ' people).' }),
      tokenLink(),
    ]);
  }

  function readPeople() {
    if (HALT_TEXT.test(pageText(6000))) return showError('LinkedIn is asking you to slow down on this page. Leave it for a while — nothing was read.');
    reading = true;
    var halt = { stopped: false };
    var prog = h('div', { id: 'sblogprog', style: 'color:#555;margin-bottom:10px', text: countPeople() + ' people on screen…' });
    freshPanel([
      head('Reading this page'),
      prog,
      h('button', { id: 'sblogstop', style: BTN2, text: 'Stop and use what\'s here', onclick: function () { halt.stopped = true; } }),
    ]);
    var info = { companyName: companyName(), companyUrl: location.href, industry: companyIndustry(), members: peopleCount() };
    expand(function (n) { prog.textContent = n + ' people on screen…'; }, halt).then(function () {
      window.scrollTo(0, 0);
      lastRead = Object.assign(info, { rows: scrapePeople(), hidden: hiddenMembers(), keyword: (location.search.match(/keywords=([^&]+)/) || [])[1] || '' });
      reading = false;
      return previewPeople('');
    }).catch(function (e) { reading = false; showError(e.message); });
  }

  function previewPeople(brandName) {
    var r = lastRead;
    if (!r) return Promise.resolve();
    return post({ action: 'liPreview', companyUrl: r.companyUrl, companyName: r.companyName, brandName: brandName || '', rows: r.rows, via: 'log' })
      .then(function (j) {
        if (!j || !j.ok) return showError((j && j.error) || 'The dashboard could not read that.');
        renderPeoplePreview(j, brandName);
      });
  }

  function peopleGroup(title, rows, open, color) {
    if (!rows.length) return null;
    return h('details', { open: !!open, style: 'display:block;margin-top:8px' }, [
      h('summary', { style: 'display:list-item;cursor:pointer;font-weight:600;color:' + (color || '#111'), text: title + ' (' + rows.length + ')' }),
      h('div', { style: 'font-size:12px;margin-top:4px;max-height:180px;overflow:auto' }, rows.map(function (x) {
        return h('div', { style: 'padding:2px 0' }, [
          x.name,
          x.role ? h('span', { style: 'color:#777', text: ' — ' + x.role }) : null,
          x.at ? h('span', { style: 'color:#946200', text: ' (on file at ' + x.at + ')' }) : null,
        ]);
      })),
    ]);
  }

  function renderPeoplePreview(j, typed) {
    var by = function (v) { return j.rows.filter(function (x) { return x.verdict === v; }); };
    var adds = by('add'), waiting = by('noBrand');
    var again = function (name) { previewPeople(name).catch(function (e) { showError(e.message); }); };
    var box = h('input', {
      id: 'sblogbrand', value: typed || (j.brand ? j.brand.name : ''), placeholder: 'Dashboard brand name',
      style: 'flex:1;min-width:0;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font:12.5px system-ui;color:#111;background:#fff',
    });
    box.onkeydown = function (e) { if (e.key === 'Enter') again(box.value.trim()); };
    var add = null, create = null;
    if (j.brand) {
      add = h('button', { id: 'sblogadd', style: BTN + ';margin-top:12px', disabled: !adds.length,
        text: adds.length ? 'Add ' + adds.length + ' to ' + j.brand.name : 'Nobody new to add' });
      if (adds.length) add.onclick = guard(function () { capturePeople(typed, add); });
    } else if (j.createName) {
      var n = Math.min(waiting.length, j.cap);
      create = h('button', { id: 'sblogcreate', style: BTN + ';margin-top:12px',
        text: 'Add “' + j.createName + '” as a new brand' + (n ? ' + ' + n + (n === 1 ? ' person' : ' people') : '') });
      create.onclick = guard(function () { capturePeople(typed, create, true); });
    }
    freshPanel([
      head(lastRead.companyName || 'People'),
      j.brand
        ? h('div', { style: 'margin-bottom:4px' }, ['For ', b(j.brand.name), ' · ' + j.have + ' of ' + j.cap + ' on file' + (j.room ? ', room for ' + j.room : ' — full')])
        : h('div', { style: 'color:#946200;margin-bottom:4px', text: 'Which dashboard brand is this? None matched “' + (j.notFound || lastRead.companyName) + '”.' }),
      !j.brand && j.suggestions && j.suggestions.length
        ? h('div', { style: 'display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px' }, j.suggestions.map(function (s) {
            return h('button', { style: 'border:1px solid #ddd;background:#fff;color:#111;border-radius:99px;padding:3px 9px;cursor:pointer;font:12px system-ui', text: s, onclick: function () { again(s); } });
          }))
        : null,
      h('div', { style: 'display:flex;gap:6px;margin:6px 0 4px' }, [
        box,
        h('button', { id: 'sblogcheck', text: j.brand ? 'Change' : 'Check',
          style: 'background:#fff;color:#111;border:1px solid #ccc;border-radius:6px;padding:5px 10px;cursor:pointer;font:12.5px system-ui',
          onclick: function () { again(box.value.trim()); } }),
      ]),
      h('div', { style: 'font-size:12px;color:#555;margin-top:8px', text: lastRead.rows.length + ' people read from this page.' +
        (lastRead.hidden ? ' ' + lastRead.hidden + ' show as "LinkedIn Member" (outside your network).' : '') }),
      peopleGroup(j.brand ? 'Will add' : 'Buyers found', j.brand ? adds : waiting, true, '#137333'),
      peopleGroup('Over the ' + j.cap + ' cap', by('full'), false, '#946200'),
      peopleGroup('Already on file', by('dupe'), false, '#555'),
      peopleGroup('On file at another brand', by('elsewhere'), false, '#946200'),
      peopleGroup('Not a buyer title — left out', by('notBuyer'), false, '#999'),
      add, create,
      keywordChips(),
      tokenLink(),
    ]);
  }

  function capturePeople(typed, btn, create) {
    var r = lastRead;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    return post({
      action: 'liCapture', via: 'log',
      companyUrl: r.companyUrl, companyName: r.companyName, companyIndustry: r.industry || '',
      brandName: typed || '', createIfMissing: !!create,
      // The headcount is the whole company's only on the unfiltered tab.
      members: r.keyword ? null : r.members,
      rows: r.rows,
    }).then(function (j) {
      if (!j || !j.ok) return showError((j && j.error) || 'Nothing was saved.');
      freshPanel([
        head('Saved'),
        j.brandCreated ? h('div', { style: 'margin-bottom:6px;color:#137333' }, [b(j.brand.name), ' is now a brand in the dashboard. Its category is a guess — check it on the brand page.']) : null,
        h('div', { style: 'margin-bottom:6px' }, [b(String(j.added)), ' added to ', b(j.brand.name), '. It now has ' + j.have + ' of ' + j.cap + ' people on file.']),
        h('a', { href: DASH_URL + '#brand/' + j.brand.id, target: '_blank', rel: 'noopener', style: BTN2 + ';margin-top:10px', text: 'Open ' + j.brand.name + ' in the dashboard ↗' }),
        h('div', { style: SMALL, text: 'Still short? Open a narrower view below, then press the pill again.' }),
        keywordChips(),
      ]);
    }).catch(function (e) { showError(e.message); });
  }

  // ---- the pill ---------------------------------------------------------
  //
  // Bottom-left: LinkedIn's Messaging bar sits bottom-right. If this
  // browser also has the People capture script (its pill is #sblipill),
  // this one sits just above it.
  function ensurePill() {
    if ((pill && pill.isConnected) || !document.documentElement) return;
    pill = document.createElement('button');
    pill.id = 'sblogpill';
    pill.className = 'sb-li-ui';
    pill.title = 'SB Log ' + VERSION + ' — log someone you invited, from their profile';
    pill.style.cssText = 'all:initial;display:block;position:fixed;bottom:16px;left:16px;z-index:2147483646;background:#111;color:#fff;border:0;border-radius:999px;padding:11px 16px;font:600 13px system-ui,-apple-system,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.28);cursor:pointer';
    pill.onclick = guard(openMenu);
    document.documentElement.appendChild(pill);
    paintPill();
  }
  function paintPill() {
    if (!pill) return;
    var label = profilePath() ? 'SB · Log them' : onPeoplePage() ? 'SB · Read people' : 'SB · Log';
    if (pill.textContent !== label) pill.textContent = label;
    var bottom = document.getElementById('sblipill') ? '66px' : '16px';
    if (pill.style.bottom !== bottom) pill.style.bottom = bottom;
  }

  // LinkedIn is a single-page app: going to someone's profile never
  // reloads the page. So the pill and panel follow the address on a timer,
  // and the pill is put back if LinkedIn's own rendering removes it.
  var lastPath = '';
  function tick() {
    ensurePill();
    paintPill();
    if (location.pathname !== lastPath) {
      // A different page: whatever the panel said is about the old one.
      if (lastPath && !reading) closePanel();
      lastPath = location.pathname;
    }
  }

  // A second way in, from the Tampermonkey icon's menu.
  try {
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('Log this person (SB)', guard(openMenu));
      GM_registerMenuCommand('Copy a sample of this profile for Claude', guard(function () {
        if (profilePath()) copyProfileSample(); else openNotProfile();
      }));
    }
  } catch (e) {}
  try { console.info('[SB] LinkedIn log ' + VERSION + ' running' + (HAS_GM ? '' : ' WITHOUT its @grant lines — reinstall')); } catch (e) {}

  function start() {
    tick();
    setInterval(tick, 1500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
