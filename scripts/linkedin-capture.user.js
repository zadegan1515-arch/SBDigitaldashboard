// ==UserScript==
// @name         SB Dashboard — LinkedIn People Capture
// @namespace    sbagency.command-center
// @version      1.3
// @description  On a brand's LinkedIn People page, send its marketing and partnership people to the SB Command Center. One click, one page — nothing browses on its own.
// @match        https://www.linkedin.com/*
// @match        https://linkedin.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @connect      sb-digitaldashboard.vercel.app
// @updateURL    https://raw.githubusercontent.com/zadegan1515-arch/SBDigitaldashboard/main/scripts/linkedin-capture.user.js
// @downloadURL  https://raw.githubusercontent.com/zadegan1515-arch/SBDigitaldashboard/main/scripts/linkedin-capture.user.js
// ==/UserScript==

// -------------------------------------------------------------------
// The LinkedIn half of filling brands with people. SponsorUnited lists
// some of a brand's people; LinkedIn lists everyone who works there.
// This reads a brand's People page and sends the buyers to the dashboard.
//
// Run it on LEO'S LinkedIn account, not Zach's. Zach's account sends the
// connection requests; if LinkedIn ever objects to this, it should be
// Leo's account that hears about it.
//
// Nothing here browses on its own, on purpose. LinkedIn watches for
// scripts walking its pages far more closely than SponsorUnited does,
// and a restricted account costs more than a thin brand. So: you open a
// People page, you press the button, it scrolls that one page the way you
// would, shows you who it found, and saves only when you say so.
//
// What the dashboard keeps (its rules, not this script's): marketing /
// partnership / brand / campus / founder titles only, inside the same
// 25-per-brand cap as SponsorUnited, best titles first. No emails —
// LinkedIn doesn't show them, and these people go to the LinkedIn queue.
//
// TO INSTALL (once): Tampermonkey -> Dashboard -> + (new script) ->
// select ALL of Tampermonkey's sample text and paste over it -> save.
// (Pasted underneath the sample, Tampermonkey reads the sample's header
// instead of this one and the script never runs on LinkedIn.) (Opening the raw GitHub link does not always
// bring up Tampermonkey's install page — pasting always works.) The SB
// pill then shows on every LinkedIn page; click it, paste the ingest
// token. It updates itself from GitHub after that.
//
// The token is NOT in this file and must never be put in it. It is the
// same value as INGEST_TOKEN in Vercel. It is kept in Tampermonkey's own
// storage (not LinkedIn's), which LinkedIn's page cannot read, and sent
// to exactly one place: the dashboard's ingest URL.
// -------------------------------------------------------------------

(function () {
  'use strict';

  var INGEST_URL = 'https://sb-digitaldashboard.vercel.app/api/ingest';
  var DASH_URL = 'https://sb-digitaldashboard.vercel.app/app.html';
  var TOKEN_KEY = 'sbIngestToken';
  var VERSION = '1.3';

  // The header's @grant lines are what give this script Tampermonkey's
  // storage and requests. A paste that lost the header (the usual cause:
  // pasted under Tampermonkey's sample script) runs without them — say
  // so instead of failing quietly.
  var HAS_GM = typeof GM_xmlhttpRequest === 'function' && typeof GM_getValue === 'function';

  // One press reads at most this much. A big company's People page never
  // ends; the keyword chips narrow it instead of scrolling forever.
  var MAX_PEOPLE = 150;
  var MAX_ROUNDS = 15;

  // Titles worth searching a big company's People page for. Each is a
  // plain link Leo clicks — the page it opens is LinkedIn's own filter.
  var KEYWORDS = ['marketing', 'partnerships', 'sponsorship', 'brand', 'events', 'campus'];

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
        data: JSON.stringify(Object.assign({ token: token() }, payload)),
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
    catch (e2) { alert('SB LinkedIn capture: ' + msg); }
  }
  function guard(fn) {
    return function () {
      try { return fn.apply(this, arguments); } catch (e) { report(e); }
    };
  }

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function rand(a, b) { return a + Math.floor(Math.random() * (b - a)); }

  // ---- where we are ----------------------------------------------

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
    var h = document.querySelector('.org-top-card-summary__title, main h1, h1');
    var t = h ? (h.innerText || h.textContent || '').replace(/\s+/g, ' ').trim() : '';
    if (!t) t = document.title.replace(/^\(\d+\+?\)\s*/, '').split(/[:|]/)[0].trim();
    return t.slice(0, 120);
  }

  // ---- reading the People page -------------------------------------

  var PROFILE_SEL = 'a[href*="/in/"]';

  // The header's own "Me" link, dialogs and our panel are not employees.
  function skipZone(el) {
    return !!el.closest('#global-nav, header, nav, aside, [role="dialog"], .sb-li-ui');
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
    [].slice.call(el.querySelectorAll(PROFILE_SEL)).forEach(function (a) {
      var k = slugOf(a.getAttribute('href'));
      if (k) s[k] = 1;
    });
    return Object.keys(s).length;
  }
  function count() {
    var s = {};
    profileLinks().forEach(function (a) { s[slugOf(a.getAttribute('href'))] = 1; });
    return Object.keys(s).length;
  }

  // Lines on a card that are LinkedIn's furniture, not the person.
  var NOISE = /^(connect|follow|following|message|pending|more|send inmail|view profile|·)$|degree connection|^·\s*(1st|2nd|3rd)|^(1st|2nd|3rd\+?)$|mutual connection|^view .*profile$|^status is|followers$|^open to work$/i;
  function lines(el) {
    return String(el.innerText || el.textContent || '').split('\n')
      .map(function (s) { return s.replace(/\s+/g, ' ').trim(); })
      .filter(function (s) { return s && !NOISE.test(s); });
  }

  // The block that holds one person: their <li> when it holds only them,
  // otherwise walk up until the next step would take in a second person.
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
    var nameEl = card.querySelector('.artdeco-entity-lockup__title, .org-people-profile-card__profile-title');
    var subEl = card.querySelector('.artdeco-entity-lockup__subtitle');
    var name = nameEl ? lines(nameEl)[0] : null;
    if (!name) {
      // The profile link that carries text is the name link.
      var named = profileLinks(card).map(function (a) { return lines(a)[0]; }).filter(Boolean);
      name = named[0] || null;
    }
    var all = lines(card);
    if (!name) name = all[0] || null;
    var headline = subEl ? lines(subEl).join(' ') : '';
    if (!headline && name) {
      var i = all.indexOf(name);
      headline = i !== -1 ? (all[i + 1] || '') : '';
    }
    return { name: name, headline: headline };
  }

  function scrape() {
    var done = {};
    var rows = [];
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

  function moreButton() {
    var bs = [].slice.call(document.querySelectorAll('button'));
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i];
      if (b.disabled || skipZone(b) || !b.offsetParent) continue;
      if (/^(show more results|show more|load more)$/i.test((b.innerText || b.textContent || '').trim())) return b;
    }
    return null;
  }

  // Scroll the way a person would: to the bottom, a pause, "Show more
  // results" if it is there, a longer pause. Stops when the list stops
  // growing, at MAX_PEOPLE, or when Stop is pressed.
  function expand(onProgress, halt) {
    return new Promise(function (resolve) {
      var rounds = 0, still = 0, last = count();
      function step() {
        if (halt.stopped || rounds >= MAX_ROUNDS || last >= MAX_PEOPLE) return resolve();
        rounds++;
        // Both, because LinkedIn has moved which element scrolls before.
        var links = profileLinks();
        if (links.length) links[links.length - 1].scrollIntoView({ block: 'end' });
        window.scrollTo(0, document.body.scrollHeight);
        wait(rand(1200, 2200)).then(function () {
          if (halt.stopped) return;
          var more = moreButton();
          if (more) more.click();
          return wait(more ? rand(1800, 3000) : rand(600, 1200));
        }).then(function () {
          var n = count();
          onProgress(n);
          still = n <= last ? still + 1 : 0;
          last = Math.max(last, n);
          if (still >= 2) return resolve();
          step();
        }).catch(function () {
          // A page that changed under us still gets read as it stands.
          resolve();
        });
      }
      step();
    });
  }

  // ---- UI ------------------------------------------------------------
  //
  // Every panel is built node by node — no HTML strings, no innerHTML.
  // LinkedIn only lets its own Trusted Types policy through, and that
  // policy scrubs inserted HTML: on the first real run it stripped the
  // panel's buttons and ids, and the click died with "Cannot set
  // properties of null". Nodes made with createElement never pass through
  // it, and styles go through the style object, which no page policy
  // touches.

  var pill, panel, busy = false, lastRead = null;

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
      else if (k === 'value' || k === 'disabled' || k === 'open') el[k] = v;
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
    panel = h('div', { id: 'sbli-panel', 'class': 'sb-li-ui', style: PANEL_CSS }, kids);
    // On <html>, not <body>: a transform or containment LinkedIn puts on
    // <body> would pin a fixed element to it, possibly off screen.
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

  function keywordChips() {
    var base = companyBase();
    if (!base) return null;
    return h('div', {}, [
      h('div', { style: 'font-size:11.5px;color:#777;margin:10px 0 5px', text: 'Big company? Narrow the page first:' }),
      h('div', { style: 'display:flex;flex-wrap:wrap;gap:5px' }, KEYWORDS.map(function (k) {
        return h('a', {
          href: base + 'people/?keywords=' + encodeURIComponent(k),
          style: 'border:1px solid #ddd;border-radius:99px;padding:3px 9px;color:#111;text-decoration:none;font-size:12px',
          text: k,
        });
      })),
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

  function openSetup() {
    var input = h('input', {
      id: 'sblitok', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'Ingest token',
      style: 'display:block;width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #ccc;border-radius:6px;margin-bottom:10px;font:13px system-ui;color:#111;background:#fff',
    });
    var msg = h('span', { id: 'sblitokmsg', style: 'font-size:11.5px;flex:1' });
    var say = function (text, color) { msg.textContent = text; msg.style.color = color || '#555'; };
    var save = function () {
      var v = (input.value || '').trim();
      if (!v) return say('Paste the token first.', '#b00');
      saveToken(v);
      say('Checking…', '#137333');
      // An empty preview: proves the token now, saves nothing.
      post({ action: 'liPreview', rows: [] }).then(function (j) {
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
        h('button', { id: 'sblitoksave', style: 'background:#111;color:#fff;border:0;border-radius:7px;padding:7px 12px;cursor:pointer;font:600 13px system-ui', text: 'Save', onclick: save }),
        msg,
      ]),
    ]);
    input.focus();
  }

  function openMenu() {
    if (!HAS_GM) return openBroken();
    if (!token()) return openSetup();
    if (busy) return;
    if (!companyPath()) return openElsewhere();
    if (onPeoplePage()) return readPage();
    freshPanel([
      head(companyName() || 'LinkedIn'),
      h('div', { style: 'color:#555;margin-bottom:10px' }, ['This reads a company\'s ', b('People'), ' tab. Open it, then press the SB pill again.']),
      h('button', { id: 'sblipeople', style: BTN, text: 'Open the People tab', onclick: function () { location.href = companyBase() + 'people/'; } }),
      keywordChips(),
      tokenLink(),
    ]);
  }

  function openBroken() {
    freshPanel([
      head('Reinstall this script'),
      h('div', { style: MUTED }, ['Tampermonkey is running this script without its settings lines, so it can\'t reach the dashboard. That happens when it was pasted ', b('under'), ' Tampermonkey\'s sample script.']),
      h('div', { style: 'color:#555', text: 'Tampermonkey → Dashboard → open this script → select everything (Ctrl/Cmd+A) → paste the script from GitHub over it → save.' }),
    ]);
  }

  // The pill shows on every LinkedIn page, so a working install is
  // visible at once. Off a company page it only says where to go.
  function openElsewhere() {
    var search = /\/search\/results\/companies/.test(location.pathname);
    freshPanel([
      head('SB LinkedIn capture'),
      search
        ? h('div', { style: MUTED }, ['Click the brand\'s company in these results, then its ', b('People'), ' tab, then this pill again.'])
        : h('div', { style: MUTED }, ['This works on a brand\'s ', b('company page'), ' on LinkedIn. The easy way in: the dashboard\'s ', b('Under 25'), ' list, then ', b('People ↗'), ' on a brand.']),
      h('a', { href: DASH_URL + '#people', target: '_blank', rel: 'noopener', style: BTN2, text: 'Open the Under 25 list ↗' }),
      tokenLink(),
    ]);
  }

  function readPage() {
    busy = true;
    var halt = { stopped: false };
    var prog = h('div', { id: 'sbliprog', style: 'color:#555;margin-bottom:10px', text: count() + ' people on screen…' });
    freshPanel([
      head('Reading this page'),
      prog,
      h('div', { style: 'color:#999;font-size:11px;margin-bottom:10px', text: 'Scrolling this one page, with pauses, up to ' + MAX_PEOPLE + ' people. Nothing is saved yet.' }),
      h('button', { id: 'sblistop', style: BTN2, text: 'Stop and use what\'s here', onclick: function () { halt.stopped = true; } }),
    ]);
    expand(function (n) {
      prog.textContent = n + ' people on screen…';
    }, halt).then(function () {
      window.scrollTo(0, 0);
      lastRead = { rows: scrape(), companyName: companyName(), companyUrl: location.href };
      return preview('');
    }).catch(function (e) {
      showError(e.message);
    }).then(function () { busy = false; });
  }

  function preview(brandName) {
    var r = lastRead;
    if (!r) return Promise.resolve();
    return post({
      action: 'liPreview',
      companyUrl: r.companyUrl,
      companyName: r.companyName,
      brandName: brandName || '',
      rows: r.rows,
    }).then(function (j) {
      if (!j || !j.ok) return showError((j && j.error) || 'The dashboard could not read that.');
      renderPreview(j, brandName);
    });
  }

  function showError(msg) {
    busy = false;
    freshPanel([
      head('Something went wrong'),
      h('div', { style: 'color:#b00', text: msg }),
      tokenLink(),
    ]);
  }

  function group(title, rows, open, color) {
    if (!rows.length) return null;
    return h('details', { open: !!open, style: 'display:block;margin-top:8px' }, [
      h('summary', { style: 'display:list-item;cursor:pointer;font-weight:600;color:' + (color || '#111'), text: title + ' (' + rows.length + ')' }),
      h('div', { style: 'font-size:12px;margin-top:4px;max-height:180px;overflow:auto' }, rows.map(function (r) {
        return h('div', { style: 'padding:2px 0' }, [
          r.name,
          r.role ? h('span', { style: 'color:#777', text: ' — ' + r.role }) : null,
          r.at ? h('span', { style: 'color:#946200', text: ' (on file at ' + r.at + ')' }) : null,
        ]);
      })),
    ]);
  }

  function renderPreview(j, typed) {
    var by = function (v) { return j.rows.filter(function (r) { return r.verdict === v; }); };
    var adds = by('add'), waiting = by('noBrand');
    var pickAndPreview = function (name) { preview(name).catch(function (e) { showError(e.message); }); };

    var brandLine;
    if (j.brand) {
      brandLine = [
        h('div', { style: 'margin-bottom:4px' }, ['For ', b(j.brand.name), ' · ' + j.have + ' of ' + j.cap + ' on file' + (j.room ? ', room for ' + j.room : ' — full')]),
        j.pageMismatch ? h('div', { style: 'font-size:11.5px;color:#946200;margin-bottom:4px', text: 'This brand has a different LinkedIn page saved (maybe a parent or sister brand). Adding people here is fine; the saved page stays.' }) : null,
      ];
    } else {
      brandLine = [
        h('div', { style: 'color:#946200;margin-bottom:4px', text: j.notFound
          ? 'No brand called "' + j.notFound + '" in the dashboard.'
          : 'Which dashboard brand is this? None matched "' + lastRead.companyName + '".' }),
        j.suggestions && j.suggestions.length
          ? h('div', { style: 'display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px' }, j.suggestions.map(function (s) {
              return h('button', {
                style: 'border:1px solid #ddd;background:#fff;color:#111;border-radius:99px;padding:3px 9px;cursor:pointer;font:12px system-ui',
                text: s, onclick: function () { pickAndPreview(s); },
              });
            }))
          : null,
      ];
    }

    var box = h('input', {
      id: 'sblibrand', value: typed || (j.brand ? j.brand.name : ''), placeholder: 'Dashboard brand name',
      style: 'flex:1;min-width:0;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font:12.5px system-ui;color:#111;background:#fff',
    });
    box.onkeydown = function (e) { if (e.key === 'Enter') pickAndPreview(box.value.trim()); };

    var add = null;
    if (j.brand) {
      add = h('button', {
        id: 'sbliadd', style: BTN + ';margin-top:12px', disabled: !adds.length,
        text: adds.length ? 'Add ' + adds.length + ' to ' + j.brand.name : 'Nobody new to add',
      });
      if (adds.length) add.onclick = function () { capture(typed, add); };
    }

    freshPanel([head(lastRead.companyName || 'LinkedIn')].concat(brandLine, [
      h('div', { style: 'display:flex;gap:6px;margin:6px 0 4px' }, [
        box,
        h('button', {
          id: 'sblicheck', text: j.brand ? 'Change' : 'Check',
          style: 'background:#fff;color:#111;border:1px solid #ccc;border-radius:6px;padding:5px 10px;cursor:pointer;font:12.5px system-ui',
          onclick: function () { pickAndPreview(box.value.trim()); },
        }),
      ]),
      h('div', { style: 'font-size:12px;color:#555;margin-top:8px', text: lastRead.rows.length + ' people read from this page.' }),
      group(j.brand ? 'Will add' : 'Buyers found', j.brand ? adds : waiting, true, '#137333'),
      group('Over the ' + j.cap + ' cap', by('full'), false, '#946200'),
      group('Already on file', by('dupe'), false, '#555'),
      group('On file at another brand', by('elsewhere'), false, '#946200'),
      group('Not a buyer title — left out', by('notBuyer'), false, '#999'),
      add,
      h('div', { style: SMALL, text: 'No emails — LinkedIn doesn\'t show them. New people join the LinkedIn queue; it keeps the best 4 per brand in play.' }),
      keywordChips(),
      tokenLink(),
    ]));
  }

  function capture(typed, btn) {
    var r = lastRead;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    post({
      action: 'liCapture',
      companyUrl: r.companyUrl,
      companyName: r.companyName,
      brandName: typed || '',
      rows: r.rows,
    }).then(function (j) {
      if (!j || !j.ok) return showError((j && j.error) || 'Nothing was saved.');
      freshPanel([
        head('Saved'),
        h('div', { style: 'margin-bottom:6px' }, [b(String(j.added)), ' added to ', b(j.brand.name), '. It now has ' + j.have + ' of ' + j.cap + ' people on file.']),
        j.targetsShelved ? h('div', { style: 'font-size:12px;color:#555', text: j.targetsShelved + ' parked on the brand page — the queue keeps the best 4 per brand in play.' }) : null,
        j.savedPage ? h('div', { style: 'font-size:12px;color:#555', text: 'This page is now saved as the brand\'s LinkedIn page, so next time it matches by itself.' }) : null,
        j.failed ? h('div', { style: 'font-size:12px;color:#b00', text: j.failed + ' could not be saved: ' + (j.errors || []).join('; ') }) : null,
        h('a', { href: DASH_URL + '#brand/' + j.brand.id, target: '_blank', rel: 'noopener', style: BTN2 + ';margin-top:10px', text: 'Open the brand in the dashboard ↗' }),
        h('div', { style: SMALL, text: 'Still short? Try a keyword below, then press the SB pill again.' }),
        keywordChips(),
      ]);
    }).catch(function (e) { showError(e.message); });
  }

  // Bottom-left: LinkedIn's Messaging bar sits bottom-right and would
  // cover it. `all:initial` keeps LinkedIn's own button styles off it.
  function ensurePill() {
    if ((pill && pill.isConnected) || !document.documentElement) return;
    pill = document.createElement('button');
    pill.id = 'sblipill';
    pill.className = 'sb-li-ui';
    pill.textContent = 'SB ⬇ People';
    pill.title = 'SB LinkedIn capture ' + VERSION;
    pill.style.cssText = 'all:initial;display:block;position:fixed;bottom:16px;left:16px;z-index:2147483646;background:#111;color:#fff;border:0;border-radius:999px;padding:11px 16px;font:600 13px system-ui,-apple-system,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.28);cursor:pointer';
    pill.onclick = guard(openMenu);
    document.documentElement.appendChild(pill);
  }

  // LinkedIn is a single-page app: moving between a company's tabs, or
  // to someone's profile, never reloads the page. So the panel follows
  // the address on a timer, and the pill is put back if LinkedIn's own
  // rendering ever removes it.
  var lastPath = '';
  function tick() {
    ensurePill();
    if (location.pathname !== lastPath) {
      // A different page: whatever the panel said is about the old one.
      if (lastPath && !busy) { closePanel(); lastRead = null; }
      lastPath = location.pathname;
    }
  }
  // A second way in, from the Tampermonkey icon's menu — works even if
  // something on the page hides the pill.
  try {
    if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('Open the SB capture panel', guard(openMenu));
  } catch (e) {}
  try { console.info('[SB] LinkedIn capture ' + VERSION + ' running' + (HAS_GM ? '' : ' WITHOUT its @grant lines — reinstall')); } catch (e) {}

  tick();
  setInterval(tick, 1500);
})();
