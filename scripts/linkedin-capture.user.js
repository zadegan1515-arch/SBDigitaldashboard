// ==UserScript==
// @name         SB Dashboard — LinkedIn People Capture
// @namespace    sbagency.command-center
// @version      1.7
// @description  Send brands' marketing and partnership people from LinkedIn to the SB Command Center — one People page at a time, or a slow run through every brand.
// @match        https://www.linkedin.com/*
// @match        https://linkedin.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
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
// Two ways to use it. By hand: open a People page, press the pill, see
// who it found, save when you say so; a brand the dashboard doesn't have
// can be added from the same panel. By itself ("Fill brands by itself"):
// a slow run through every brand under 25, ~50 a day, which can also add
// new brands LinkedIn shows (lookalikes, keyword searches) and pauses the
// moment LinkedIn shows a check — see "filling brands by itself" below.
// Leo asked for the run knowing LinkedIn restricts accounts that browse
// like a script; everything about its pace is there to look like a
// person, and to stop like one.
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
  var VERSION = '1.7';
  // Which card reader this is. The dashboard refuses LinkedIn calls from
  // older readers (the "• 3rd+" one read nobody as a buyer), so a stale
  // copy can't quietly rest brands for a month.
  var READER = 2;

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

  // "Beverage Manufacturing" — the first item under the company's name.
  // Only a hint for a new brand's category, so any miss is fine.
  function companyIndustry() {
    var el = document.querySelector('.org-top-card-summary-info-list__info-item, .org-top-card-summary-info-list');
    return el ? String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
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
  // LinkedIn writes the connection badge with a bullet ("• 3rd+") as well
  // as a middle dot ("· 2nd"); on the first real reads the bullet form got
  // glued onto names and read as people's titles, so nobody was a buyer.
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

  // One person's name and headline. Class names come and go on LinkedIn,
  // so the text decides: the name is the profile link that carries text
  // (badge stripped), and the headline is the first real line after the
  // name — LinkedIn's subtitle element only when it actually has text.
  function readCard(card) {
    var all = lines(card);
    var name = null;
    profileLinks(card).forEach(function (a) { if (!name) name = personName(lines(a)[0]) || null; });
    if (!name) {
      var nameEl = card.querySelector('.artdeco-entity-lockup__title, .org-people-profile-card__profile-title');
      if (nameEl) name = personName(lines(nameEl)[0]) || null;
    }
    if (!name) name = personName(all[0]) || null;
    var subEl = card.querySelector('.artdeco-entity-lockup__subtitle');
    var headline = subEl ? personName(lines(subEl).join(' ')) : '';
    if (!headline && name) {
      var at = -1;
      for (var i = 0; i < all.length; i++) {
        if (personName(all[i]) === name || all[i].indexOf(name) === 0) { at = i; break; }
      }
      for (var j = at + 1; j < all.length && !headline; j++) {
        var l = personName(all[j]);
        if (l && l !== name) headline = l;
      }
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
        if (halt.stopped) return resolve({ capped: false });
        if (rounds >= MAX_ROUNDS || last >= MAX_PEOPLE) return resolve({ capped: true });
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
          if (still >= 2) return resolve({ capped: false });
          step();
        }).catch(function () {
          // A page that changed under us still gets read as it stands.
          resolve({ capped: false });
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
    var fj = loadFill();
    if (ownsFill(fj)) return renderFill(fj, fj.paused ? 'Paused: ' + fj.paused : 'Running.');
    if (busy) return;
    if (!companyPath()) return openElsewhere();
    if (onPeoplePage()) return readPage();
    freshPanel([
      head(companyName() || 'LinkedIn'),
      h('div', { style: 'color:#555;margin-bottom:10px' }, ['This reads a company\'s ', b('People'), ' tab. Open it, then press the SB pill again.']),
      h('button', { id: 'sblipeople', style: BTN, text: 'Open the People tab', onclick: function () { location.href = companyBase() + 'people/'; } }),
      keywordChips(),
      fillLink(),
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
      h('button', { id: 'sblifillopen', style: BTN + ';margin-top:6px', text: 'Fill brands by itself…', onclick: openFillSetup }),
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
      lastRead = { rows: scrape(), companyName: companyName(), companyUrl: location.href, industry: companyIndustry() };
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

    // Not in the dashboard at all (Casamigos): Leo can add it from here.
    // The name is the one he typed, else the page's own.
    var create = null;
    if (!j.brand && j.createName) {
      var n = Math.min(waiting.length, j.cap);
      create = h('button', {
        id: 'sblicreate', style: BTN + ';margin-top:12px',
        text: 'Add “' + j.createName + '” as a new brand' + (n ? ' + ' + n + (n === 1 ? ' person' : ' people') : ''),
      });
      create.onclick = function () { capture(typed, create, { create: true }); };
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
      create,
      create ? h('div', { style: SMALL, text: 'Already in the dashboard under another name? Pick it above or type that name and press Check instead.' }) : null,
      h('div', { style: SMALL, text: 'No emails — LinkedIn doesn\'t show them. New people join the LinkedIn queue; it keeps the best 4 per brand in play.' }),
      keywordChips(),
      sampleLink(),
      fillLink(),
      tokenLink(),
    ]));
  }

  function capture(typed, btn, opts) {
    var r = lastRead;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    post({
      action: 'liCapture',
      companyUrl: r.companyUrl,
      companyName: r.companyName,
      companyIndustry: r.industry || '',
      brandName: typed || '',
      createIfMissing: !!(opts && opts.create),
      rows: r.rows,
    }).then(function (j) {
      if (!j || !j.ok) return showError((j && j.error) || 'Nothing was saved.');
      freshPanel([
        head('Saved'),
        j.brandCreated ? h('div', { style: 'margin-bottom:6px;color:#137333' }, [b(j.brand.name), ' is now a brand in the dashboard. Its category is a guess — check it on the brand page.']) : null,
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

  // ---- a sample for Claude ----
  //
  // When names or titles come out wrong, LinkedIn has changed its cards
  // again. This copies what the reader saw on the first three cards —
  // what it made of each, their lines, and trimmed markup (no images,
  // no tracking attributes) — for Leo to paste into the chat.
  function copySample() {
    var cards = [], seen = {};
    profileLinks().forEach(function (a) {
      var slug = slugOf(a.getAttribute('href'));
      if (seen[slug] || cards.length >= 3) return;
      seen[slug] = 1;
      cards.push(cardFor(a));
    });
    var out = ['SB LinkedIn sample · script ' + VERSION + ' · ' + location.pathname + ' · ' + count() + ' people on screen'];
    cards.forEach(function (c, i) {
      out.push('--- card ' + (i + 1) + ' read as ' + JSON.stringify(readCard(c)));
      out.push('lines ' + JSON.stringify(cardLines(c).slice(0, 14)));
      out.push(String(c.outerHTML || '')
        .replace(/<img[^>]*>/g, '<img>')
        .replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>')
        .replace(/\s(src|srcset|style|data-[\w-]+|aria-[\w-]+|tabindex|role)="[^"]*"/g, '')
        .replace(/\s+/g, ' ')
        .slice(0, 2500));
    });
    if (!cards.length) out.push('No profile links found on this page.');
    var text = out.join('\n');
    var copied = false;
    try { GM_setClipboard(text, 'text'); copied = true; } catch (e) {}
    var box = h('textarea', { style: 'display:block;box-sizing:border-box;width:100%;height:120px;font:11px monospace;margin-top:8px;color:#111;background:#fff;border:1px solid #ccc;border-radius:6px', value: text });
    freshPanel([
      head(copied ? 'Copied' : 'Copy this'),
      h('div', { style: MUTED, text: copied ? 'Paste it into the chat with Claude.' : 'Select all in the box and copy it, then paste it into the chat with Claude.' }),
      box,
    ]);
    box.select();
  }

  function sampleLink() {
    return h('div', { style: 'margin-top:6px' }, [
      h('a', {
        href: '#', style: 'color:#999;font-size:11px', text: 'Names or titles look wrong? Copy a sample for Claude',
        onclick: function (e) { e.preventDefault(); copySample(); },
      }),
    ]);
  }

  // ---- filling brands by itself ---------------------------------------
  //
  // Leo's call (Sep 2026), once the one-click read worked: go through
  // every brand on its own, electrolyte brands first, about 50 a day,
  // saving as it goes, and find the company page for brands that have
  // none. LinkedIn restricts accounts that browse like a script, so this
  // is built to move and stop like a person:
  //   · one tab — the run belongs to the tab it started in, and any click
  //     or key in that tab pauses it;
  //   · 1–2½ minutes between brands, 20–45 s between one brand's pages,
  //     the same unhurried scrolling as a manual read;
  //   · 50 brands, then it waits for the next morning;
  //   · a login wall, security check or search limit pauses it at once.
  // People are saved through the same liCapture as a manual read, named
  // by brandId, so buyers-only, the 25 cap and duplicates all hold. New
  // brands come only through liDiscover (see "new brands" below), which
  // the server judges; the brand lookup itself never creates one.

  var FILL_KEY = 'sbLiFill';
  var DAILY_CAP = 50;
  var BETWEEN_BRANDS = [60, 150];   // seconds
  var BETWEEN_PAGES = [20, 45];
  // A small company is read whole on its People tab; a big one (the tab
  // never ran out) also gets these two keyword views.
  var PASSES = ['', 'marketing', 'partnerships'];

  function loadFill() { try { return GM_getValue(FILL_KEY, null); } catch (e) { return null; } }
  function saveFill(job) { try { GM_setValue(FILL_KEY, job); } catch (e) {} }
  function clearFill() { try { GM_deleteValue(FILL_KEY); } catch (e) {} }

  // This tab's own id. sessionStorage lives exactly as long as the tab,
  // across its page loads, which is what "the run belongs to this tab"
  // needs. It holds a random id, nothing else.
  function tabId() {
    try {
      var t = sessionStorage.getItem('sbLiTab');
      if (!t) {
        t = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        sessionStorage.setItem('sbLiTab', t);
      }
      return t;
    } catch (e) { return 'no-session'; }
  }
  function ownsFill(job) { return !!job && !job.done && job.owner === tabId(); }
  function fillHere() { return HAS_GM && ownsFill(loadFill()); }

  function todayKey() { var d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
  function tomorrowMorning() { var d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, rand(0, 45), 0, 0); return d.getTime(); }
  function secs(range) { return rand(range[0] * 1000, range[1] * 1000); }
  function akaName(item) {
    return String(item.aka || '').split(/[,;]/).map(function (x) { return x.trim(); }).filter(Boolean)[0] || '';
  }

  function peopleUrl(linkedinUrl, keyword) {
    var m = String(linkedinUrl || '').match(/linkedin\.com\/(company|showcase)\/([^\/?#]+)/i);
    if (!m) return null;
    return location.origin + '/' + m[1] + '/' + m[2] + '/people/' + (keyword ? '?keywords=' + encodeURIComponent(keyword) : '');
  }
  function companyHome(linkedinUrl) {
    var m = String(linkedinUrl || '').match(/linkedin\.com\/(company|showcase)\/([^\/?#]+)/i);
    return m ? location.origin + '/' + m[1] + '/' + m[2] + '/' : null;
  }
  function searchUrl(q) { return location.origin + '/search/results/companies/?keywords=' + encodeURIComponent(q); }
  function pageParam() {
    try { return parseInt(new URLSearchParams(location.search).get('page') || '1', 10) || 1; } catch (e) { return 1; }
  }
  function kwParam() {
    try { return new URLSearchParams(location.search).get('keywords') || ''; } catch (e) { return ''; }
  }

  function waitFor(test, ms) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      (function poll() {
        var v = false;
        try { v = test(); } catch (e) {}
        if (v || Date.now() - t0 > ms) return resolve(v);
        setTimeout(poll, 500);
      })();
    });
  }
  function pageText(n) {
    try { return String(document.body ? document.body.innerText : '').slice(0, n || 20000); } catch (e) { return ''; }
  }

  // LinkedIn telling us to stop. Checked on every page the run lands on
  // and before every save. (Our panel hangs off <html>, not <body>, so
  // its own words never trip this.)
  var HALT_TEXT = /commercial use limit|unusual activity|security verification|quick security check|verify (?:that )?you'?re (?:a )?human|too many requests|you'?ve reached the (?:weekly|monthly) limit|account (?:has been )?restricted|temporarily restricted/i;
  function linkedinSaysStop() {
    if (/^\/(checkpoint|authwall|uas|login|signup)(\/|$)/.test(location.pathname)) return 'LinkedIn asked you to sign in or pass a check';
    var m = pageText().match(HALT_TEXT);
    return m ? 'LinkedIn showed “' + m[0] + '”' : null;
  }

  // A company card's lines, keeping "40K followers" (which lines() drops
  // as people-card noise) — the follower count is what new brands are
  // judged on.
  function cardLines(el) {
    return String(el.innerText || el.textContent || '').split('\n')
      .map(function (x) { return x.replace(/\s+/g, ' ').trim(); })
      .filter(function (x) { return x && !/^(\+ ?)?(follow|following|message|view page|visit website)$/i.test(x); });
  }

  // Company cards inside `root`: page link, name, and the lines under the
  // name ("Beverage Manufacturing • 250,512 followers"). `skipAside`
  // leaves out the right rail (a search's own results are in <main>).
  function companyCards(root, skipAside, ownSlug) {
    var bySlug = {}, out = [];
    [].slice.call(root.querySelectorAll('a[href*="/company/"], a[href*="/showcase/"]')).forEach(function (a) {
      if (skipAside ? skipZone(a) : a.closest('.sb-li-ui')) return;
      var m = String(a.getAttribute('href') || '').match(/\/(company|showcase)\/([^\/?#]+)/);
      if (!m || m[2] === ownSlug) return;
      var c = bySlug[m[2]];
      if (!c) {
        c = bySlug[m[2]] = { url: 'https://www.linkedin.com/' + m[1] + '/' + m[2] + '/', name: '', subtitle: '' };
        out.push(c);
      }
      var name = lines(a)[0] || '';
      if (c.name || !name) return;
      c.name = name;
      var card = a.closest('li') || a.parentElement;
      var ls = card ? cardLines(card) : [];
      var i = ls.indexOf(name);
      c.subtitle = i === -1 ? '' : ls.slice(i + 1, i + 4).join(' • ');
    });
    return out.filter(function (c) { return c.name; });
  }

  // "Pages people also viewed" and its cousins, next to a company page.
  var LOOK_HEAD = /^(pages people also viewed|people also viewed|similar pages|similar companies|people also follow|affiliated pages)$/i;
  function lookalikes() {
    var own = (companyPath() || {}).slug;
    var out = [], seen = {};
    [].slice.call(document.querySelectorAll('h2, h3, h4, span, div, p')).forEach(function (el) {
      if (el.children.length && !/^H[2-4]$/.test(el.tagName)) return;
      if (!LOOK_HEAD.test(String(el.textContent || '').replace(/\s+/g, ' ').trim())) return;
      if (el.closest('.sb-li-ui')) return;
      var box = el.closest('section, aside, .artdeco-card') || (el.parentElement && el.parentElement.parentElement);
      if (!box) return;
      companyCards(box, false, own).forEach(function (c) {
        if (seen[c.url]) return;
        seen[c.url] = 1;
        out.push(c);
      });
    });
    return out.slice(0, 20);
  }

  // Company results on a LinkedIn company search: page link, name, and
  // the lines under it (industry, place, followers).
  function searchCandidates() {
    return companyCards(document, true, null).slice(0, 10);
  }
  var fillTimer = null, fillHalt = { stopped: false }, fillStatusEl = null;
  function later(fn, ms) {
    clearTimeout(fillTimer);
    fillTimer = setTimeout(function () { try { fn(); } catch (e) { fillError(e); } }, ms);
  }

  // discover: { lookalikes: bool, words: [..] } — the new-brand half.
  function startFill(items, focus, discover) {
    discover = discover || {};
    saveFill({
      id: 'f' + Date.now().toString(36), owner: tabId(), focus: focus || '',
      items: items, at: 0, step: null, results: [], added: 0,
      day: todayKey(), doneToday: 0, nextAt: 0, pausedUntil: 0, paused: null,
      lookalikes: !!discover.lookalikes, newBrands: [],
      searches: (discover.words || []).map(function (q) { return { q: q, page: 1, navs: 0 }; }),
    });
    fillHalt = { stopped: false };
    runFill();
  }

  function pauseFill(job, reason) {
    fillHalt.stopped = true;
    clearTimeout(fillTimer);
    job.paused = reason;
    saveFill(job);
    renderFill(job, 'Paused: ' + reason);
  }
  function fillError(e) {
    var job = loadFill();
    if (job && ownsFill(job)) pauseFill(job, (e && e.message) || String(e));
    else report(e);
  }

  // The one loop. Every page load in the run's tab lands here, works out
  // what the current brand needs next, and either does it on this page
  // or goes to the page that does.
  function runFill() {
    var job = loadFill();
    if (!ownsFill(job)) return;
    var stop = linkedinSaysStop();
    if (stop) return pauseFill(job, stop + '. Leave LinkedIn alone for a day before pressing Continue.');
    if (job.paused) return renderFill(job, 'Paused: ' + job.paused);
    if (job.day !== todayKey()) { job.day = todayKey(); job.doneToday = 0; saveFill(job); }
    if (job.pausedUntil && Date.now() < job.pausedUntil) {
      renderFill(job, 'Done for today (' + DAILY_CAP + ' brands). Carries on ' + new Date(job.pausedUntil).toLocaleString() + ' if this tab stays open.');
      return later(runFill, Math.min(job.pausedUntil - Date.now() + 1000, 60000));
    }
    if (job.pausedUntil) { job.pausedUntil = 0; saveFill(job); }
    if (Date.now() < job.nextAt) {
      renderFill(job, 'Next step in ' + Math.ceil((job.nextAt - Date.now()) / 1000) + ' s');
      return later(runFill, Math.min(1000, job.nextAt - Date.now()));
    }
    // New brands first: the keyword searches run before the first brand,
    // and what they find goes to the front of the line.
    if (job.searches && job.searches.length) return discoverSearchStep(job);
    if (job.at >= job.items.length) return finishFill(job, false);
    var item = job.items[job.at];
    if (!job.step) {
      job.step = { phase: item.research ? 'research' : peopleUrl(item.linkedinUrl, '') ? 'read' : 'search', pass: 0, triedAka: false, seen: 0, added: 0, navs: 0 };
      saveFill(job);
    }
    var st = job.step;
    // Only a page this run opened itself counts (navs > 0) — never the
    // page Leo happened to be on when he pressed Start.
    if (st.phase === 'search' || st.phase === 'research') {
      var q = st.triedAka ? akaName(item) : item.name;
      if (st.navs > 0 && /^\/search\/results\/companies/.test(location.pathname) && kwParam() === q && pageParam() === 1) {
        st.navs = 0; saveFill(job);
        return st.phase === 'research' ? fillResearch(item, q) : fillSearch(item, q);
      }
      return go(job, searchUrl(q), 'Looking up ' + item.name + ' on LinkedIn' + (item.research ? ' (research list)' : ''));
    }
    if (st.phase === 'home') {
      if (st.navs > 0 && companyPath() && !onPeoplePage()) {
        st.navs = 0; saveFill(job);
        return fillLookalikes(item);
      }
      return go(job, companyHome(item.linkedinUrl), 'Opening ' + item.name + '\'s page for similar brands');
    }
    var want = PASSES[st.pass];
    if (st.navs > 0 && onPeoplePage() && kwParam() === want) {
      st.navs = 0; saveFill(job);
      return fillRead(item);
    }
    return go(job, peopleUrl(item.linkedinUrl, want), 'Opening ' + item.name + (want ? ' — ' + want : ''));
  }

  function go(job, url, status) {
    var st = job.step;
    if (!url) return finishBrand(job, 'no LinkedIn page');
    // Twice asked, twice landed somewhere else: the page is gone or
    // renamed. Move on rather than loop.
    if (st.navs >= 2) return finishBrand(job, 'its LinkedIn page would not open');
    st.navs++;
    saveFill(job);
    renderFill(job, status + '…');
    later(function () { location.href = url; }, rand(1500, 3500));
  }

  function fillSearch(item, q) {
    var job = loadFill();
    renderFill(job, 'Reading LinkedIn\'s results for “' + q + '”');
    waitFor(function () { return searchCandidates().length || /no results/i.test(pageText(5000)); }, 12000).then(function () {
      var stop = linkedinSaysStop();
      if (stop) return { halt: stop };
      return post({ action: 'liMatched', brandId: item.brandId, candidates: searchCandidates() });
    }).then(function (r) {
      var job2 = loadFill();
      if (!ownsFill(job2) || job2.paused) return;
      if (r && r.halt) return pauseFill(job2, r.halt + '. Leave LinkedIn alone for a day before pressing Continue.');
      var st = job2.step;
      if (r && r.ok && (r.outcome === 'attached' || r.outcome === 'already')) {
        job2.items[job2.at].linkedinUrl = r.linkedinUrl;
        job2.step = { phase: 'read', pass: 0, triedAka: st.triedAka, seen: 0, added: 0, navs: 0 };
        job2.nextAt = Date.now() + rand(4000, 9000);
        saveFill(job2);
        return runFill();
      }
      if (!st.triedAka && akaName(item)) {
        st.triedAka = true; st.navs = 0;
        job2.nextAt = Date.now() + rand(8000, 15000);
        saveFill(job2);
        return runFill();
      }
      finishBrand(job2, r && r.outcome === 'taken'
        ? 'its LinkedIn page is saved on ' + r.by
        : 'no clear LinkedIn page — do it by hand');
    }).catch(fillError);
  }

  // A name from the research list: the server decides whether one of
  // LinkedIn's results is that brand (industry must fit its lane), makes
  // the brand, and the run reads its people next.
  function fillResearch(item, q) {
    var job = loadFill();
    renderFill(job, 'Reading LinkedIn\'s results for “' + q + '” (research list)');
    var final = job.step.triedAka || !akaName(item);
    waitFor(function () { return searchCandidates().length || /no results/i.test(pageText(5000)); }, 12000).then(function () {
      var stop = linkedinSaysStop();
      if (stop) return { halt: stop };
      return post({ action: 'liResearch', name: item.name, aka: item.aka || '', category: item.category, lane: item.lane || '', candidates: searchCandidates(), final: final });
    }).then(function (r) {
      var job2 = loadFill();
      if (!ownsFill(job2) || job2.paused) return;
      if (r && r.halt) return pauseFill(job2, r.halt + '. Leave LinkedIn alone for a day before pressing Continue.');
      var st = job2.step, it = job2.items[job2.at];
      if (r && r.ok && (r.outcome === 'added' || r.outcome === 'exists')) {
        it.research = false;
        it.brandId = r.brandId;
        it.linkedinUrl = r.linkedinUrl;
        if (r.outcome === 'added') job2.newBrands = (job2.newBrands || []).concat([r.name]);
        job2.step = { phase: peopleUrl(r.linkedinUrl, '') ? 'read' : 'search', pass: 0, triedAka: false, seen: 0, added: 0, navs: 0 };
        job2.nextAt = Date.now() + rand(4000, 9000);
        saveFill(job2);
        return runFill();
      }
      if (!final) {
        st.triedAka = true; st.navs = 0;
        job2.nextAt = Date.now() + rand(8000, 15000);
        saveFill(job2);
        return runFill();
      }
      finishBrand(job2, 'research list: no clear LinkedIn page');
    }).catch(fillError);
  }

  function fillRead(item) {
    var job = loadFill();
    var label = item.name + (PASSES[job.step.pass] ? ' — ' + PASSES[job.step.pass] : '');
    renderFill(job, 'Reading ' + label);
    fillHalt = { stopped: false };
    var capped = false, rows = [];
    waitFor(function () { return count() > 0 || /no results|0 associated members/i.test(pageText(5000)); }, 12000).then(function () {
      return expand(function (n) { setFillStatus('Reading ' + label + ' — ' + n + ' people on screen'); }, fillHalt);
    }).then(function (res) {
      capped = !!(res && res.capped);
      var job1 = loadFill();
      if (!ownsFill(job1) || job1.paused) return null;
      var stop = linkedinSaysStop();
      if (stop) return { halt: stop };
      rows = scrape();
      window.scrollTo(0, 0);
      return post({ action: 'liCapture', brandId: item.brandId, companyUrl: location.href, companyName: companyName(), rows: rows });
    }).then(function (r) {
      if (!r) return;
      var job2 = loadFill();
      if (!ownsFill(job2) || job2.paused) return;
      if (r.halt) return pauseFill(job2, r.halt + '. Leave LinkedIn alone for a day before pressing Continue.');
      if (!r.ok) return finishBrand(job2, r.error || 'the dashboard did not save');
      var st = job2.step;
      st.seen += rows.length;
      st.added += r.added || 0;
      job2.added = (job2.added || 0) + (r.added || 0);
      var full = r.have >= r.cap;
      var more = !full && st.pass < PASSES.length - 1 && (st.pass > 0 || capped);
      if (!more) return afterPeople(job2, item);
      st.pass++; st.navs = 0;
      job2.nextAt = Date.now() + secs(BETWEEN_PAGES);
      saveFill(job2);
      runFill();
    }).catch(fillError);
  }

  // ---- new brands ----
  //
  // Leo's call (Sep 2026): the run finds brands too, and they go straight
  // into the dashboard. Two sources: LinkedIn's lookalikes next to each
  // brand it visits, and company searches for the words he gives. The
  // server judges each one (consumer industry, 5K+ followers, not known,
  // not dismissed before, 50 a day) and makes the brand; the run then
  // reads its people too — keyword finds next, lookalikes at the end.

  function addNewBrands(job, created, front) {
    var fresh = (created || []).map(function (c) {
      return { brandId: c.brandId, name: c.name, aka: null, category: c.category, linkedinUrl: c.linkedinUrl, contacts: 0, focus: !!front, isNew: true };
    });
    if (!fresh.length) return;
    job.newBrands = (job.newBrands || []).concat(fresh.map(function (c) { return c.name; }));
    if (front) job.items.splice.apply(job.items, [job.at, 0].concat(fresh));
    else job.items = job.items.concat(fresh);
  }

  function discoverSearchStep(job) {
    var ds = job.searches[0];
    if (ds.navs > 0 && /^\/search\/results\/companies/.test(location.pathname) && kwParam() === ds.q && pageParam() === ds.page) {
      ds.navs = 0; saveFill(job);
      return fillDiscoverSearch();
    }
    if (ds.navs >= 2) { job.searches.shift(); saveFill(job); return runFill(); }
    ds.navs++;
    saveFill(job);
    renderFill(job, 'Searching LinkedIn for new “' + ds.q + '” brands' + (ds.page > 1 ? ' (page ' + ds.page + ')' : '') + '…');
    var url = searchUrl(ds.q) + (ds.page > 1 ? '&page=' + ds.page : '');
    later(function () { location.href = url; }, rand(1500, 3500));
  }

  function fillDiscoverSearch() {
    var job = loadFill(), ds = job.searches[0], found = [];
    renderFill(job, 'Reading LinkedIn\'s “' + ds.q + '” results');
    waitFor(function () { return searchCandidates().length || /no results/i.test(pageText(5000)); }, 12000).then(function () {
      var stop = linkedinSaysStop();
      if (stop) return { halt: stop };
      found = searchCandidates();
      return post({ action: 'liDiscover', source: 'search', from: ds.q, companies: found });
    }).then(function (r) {
      var job2 = loadFill();
      if (!ownsFill(job2) || job2.paused) return;
      if (r && r.halt) return pauseFill(job2, r.halt + '. Leave LinkedIn alone for a day before pressing Continue.');
      if (!r || !r.ok) return pauseFill(job2, (r && r.error) || 'the dashboard did not take the new brands');
      addNewBrands(job2, r.created, true);
      var d = job2.searches[0];
      // A full page and room left today: the next page of results too,
      // up to three.
      if (found.length >= 8 && d.page < 3 && !r.capped) { d.page++; d.navs = 0; }
      else job2.searches.shift();
      job2.nextAt = Date.now() + secs(BETWEEN_PAGES);
      saveFill(job2);
      runFill();
    }).catch(fillError);
  }

  // After a brand's people: its lookalikes, when the run looks for new
  // brands. Read off the page it's on if LinkedIn shows them there,
  // otherwise one more stop at the company's home page.
  function afterPeople(job, item) {
    if (!job.lookalikes) return finishBrand(job, null);
    var here = lookalikes();
    if (here.length) return saveLookalikes(item, here);
    job.step.phase = 'home';
    job.step.navs = 0;
    job.nextAt = Date.now() + secs(BETWEEN_PAGES);
    saveFill(job);
    runFill();
  }

  function fillLookalikes(item) {
    renderFill(loadFill(), 'Looking at brands similar to ' + item.name);
    // The side rail draws late; a little scroll wakes it.
    window.scrollTo(0, 600);
    waitFor(function () { return lookalikes().length; }, 10000).then(function () {
      window.scrollTo(0, 0);
      saveLookalikes(item, lookalikes());
    }).catch(fillError);
  }

  function saveLookalikes(item, found) {
    var job = loadFill();
    if (!ownsFill(job) || job.paused) return;
    if (!found.length) return finishBrand(job, null);
    var stop = linkedinSaysStop();
    if (stop) return pauseFill(job, stop + '. Leave LinkedIn alone for a day before pressing Continue.');
    post({ action: 'liDiscover', source: 'lookalike', from: item.name, fromBrandId: item.brandId, companies: found }).then(function (r) {
      var job2 = loadFill();
      if (!ownsFill(job2) || job2.paused) return;
      if (r && r.ok) addNewBrands(job2, r.created, false);
      finishBrand(job2, null);
    }).catch(fillError);
  }

  function finishBrand(job, note) {
    var item = job.items[job.at];
    var st = job.step || { seen: 0, added: 0 };
    // A research name that never became a brand is logged by liResearch.
    if (item.brandId) post({ action: 'liSwept', brandId: item.brandId, seen: st.seen, added: st.added, note: note || '' }).catch(function () {});
    job.results.push({ name: item.name, added: st.added, note: note || null });
    job.at++;
    job.step = null;
    job.doneToday++;
    job.nextAt = Date.now() + secs(BETWEEN_BRANDS);
    if (job.doneToday >= DAILY_CAP && job.at < job.items.length) job.pausedUntil = tomorrowMorning();
    saveFill(job);
    runFill();
  }

  function finishFill(job, stopped) {
    clearTimeout(fillTimer);
    fillHalt.stopped = true;
    clearFill();
    var problems = (job.results || []).filter(function (r) { return r.note; });
    freshPanel([
      head(stopped ? 'Run stopped' : 'Run finished'),
      h('div', { style: 'margin-bottom:6px' }, [b(String(job.added || 0)), ' people added across ' + (job.results || []).length + ' brands.']),
      (job.newBrands || []).length
        ? h('details', { style: 'display:block;margin-top:6px' }, [
            h('summary', { style: 'display:list-item;cursor:pointer;font-weight:600;color:#137333', text: job.newBrands.length + (job.newBrands.length === 1 ? ' new brand added' : ' new brands added') }),
            h('div', { style: 'font-size:12px;margin-top:4px;max-height:160px;overflow:auto', text: job.newBrands.join(', ') }),
          ])
        : null,
      problems.length
        ? h('details', { open: true, style: 'display:block;margin-top:6px' }, [
            h('summary', { style: 'display:list-item;cursor:pointer;font-weight:600;color:#946200', text: 'Do these by hand (' + problems.length + ')' }),
            h('div', { style: 'font-size:12px;margin-top:4px;max-height:200px;overflow:auto' }, problems.map(function (r) {
              return h('div', { style: 'padding:2px 0' }, [r.name, h('span', { style: 'color:#777', text: ' — ' + r.note })]);
            })),
          ])
        : null,
      h('a', { href: DASH_URL + '#people', target: '_blank', rel: 'noopener', style: BTN2 + ';margin-top:10px', text: 'Open the Under 25 list ↗' }),
      h('div', { style: SMALL, text: stopped
        ? 'Nothing saved is undone. Start again any time — brands it finished are skipped for a month if they gave nothing new.'
        : 'Brands it couldn\'t do are still in Under 25 — open their People tab and press the pill.' }),
    ]);
  }

  function stopFill() {
    var job = loadFill();
    if (job) finishFill(job, true); else closePanel();
  }

  function continueFill() {
    var job = loadFill();
    if (!job) return closePanel();
    job.owner = tabId();
    job.paused = null;
    if (job.step) job.step.navs = 0;
    job.nextAt = 0;
    saveFill(job);
    fillHalt = { stopped: false };
    runFill();
  }

  // Any click or key in the run's tab (outside our own panel) is a person
  // who wants the tab back.
  function onHuman(e) {
    if (!e.isTrusted) return;
    var t = e.target;
    if (t && t.closest && t.closest('.sb-li-ui')) return;
    var job = loadFill();
    if (!ownsFill(job) || job.paused) return;
    pauseFill(job, 'you clicked or typed in this tab. Press Continue to carry on — or start it in a tab you leave alone.');
  }
  document.addEventListener('mousedown', onHuman, true);
  document.addEventListener('keydown', onHuman, true);

  function setFillStatus(text) { if (fillStatusEl) fillStatusEl.textContent = text; }

  // Rebuilt only when something visible changes; the countdown and the
  // scroll count just update the status line.
  function renderFill(job, status) {
    if (!job) return;
    var key = [job.at, job.added, job.doneToday, job.paused, job.pausedUntil, (job.newBrands || []).length, job.items.length].join('|');
    if (panel && panel.getAttribute('data-fill') === key && fillStatusEl && fillStatusEl.isConnected) {
      return setFillStatus(status);
    }
    var n = job.items.length, at = Math.min(job.at, n);
    var focusN = job.items.filter(function (i) { return i.focus; }).length;
    var pct = n ? Math.round(at / n * 100) : 100;
    fillStatusEl = h('div', { style: 'font-size:12px;margin:8px 0;color:' + (job.paused ? '#b00' : '#555'), text: status });
    var p = freshPanel([
      head('Filling brands from LinkedIn'),
      h('div', { style: 'margin-bottom:4px' }, [b(String(at)), ' of ' + n + ' brands · ', b(String(job.added || 0)), ' people added']),
      focusN ? h('div', { style: 'font-size:12px;color:#555', text: '“' + (job.focus || 'focus') + '” brands first: ' + Math.min(at, focusN) + ' of ' + focusN + ' done' }) : null,
      h('div', { style: 'font-size:12px;color:#555', text: 'Today: ' + job.doneToday + ' of ' + DAILY_CAP + ' brands' }),
      (job.newBrands || []).length ? h('div', { style: 'font-size:12px;color:#137333', text: job.newBrands.length + ' new brand' + (job.newBrands.length === 1 ? '' : 's') + ' found and added' }) : null,
      h('div', { style: 'height:6px;background:#eee;border-radius:99px;overflow:hidden;margin-top:6px' }, [
        h('div', { style: 'height:100%;width:' + pct + '%;background:#111' }),
      ]),
      fillStatusEl,
      job.paused ? h('button', { id: 'sblifillgo', style: BTN, text: 'Continue', onclick: continueFill }) : null,
      h('button', { id: 'sblifillstop', style: BTN2 + ';margin-top:6px;color:#b00', text: 'Stop the run', onclick: stopFill }),
      h('div', { style: SMALL, text: 'Runs in this tab only; clicking or typing here pauses it. About ' + DAILY_CAP + ' brands a day, 1–2½ minutes apart. It pauses if LinkedIn shows a check or a limit.' }),
    ]);
    p.setAttribute('data-fill', key);
  }

  function openFillSetup() {
    if (!HAS_GM) return openBroken();
    if (!token()) return openSetup();
    var job = loadFill();
    if (job && !job.done) {
      if (ownsFill(job)) return renderFill(job, job.paused ? 'Paused: ' + job.paused : 'Running.');
      return freshPanel([
        head('A run is going in another tab'),
        h('div', { style: MUTED, text: 'Brand ' + job.at + ' of ' + job.items.length + ', ' + (job.added || 0) + ' people added so far. Only one tab runs it at a time.' }),
        h('button', { id: 'sblifilltake', style: BTN, text: 'Run it in this tab instead', onclick: continueFill }),
        h('button', { style: BTN2 + ';margin-top:6px;color:#b00', text: 'Stop the run', onclick: stopFill }),
      ]);
    }
    var focus = h('input', {
      id: 'sblifocus', value: 'electrolyte', placeholder: 'e.g. electrolyte — or leave empty',
      style: 'flex:1;min-width:0;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font:12.5px system-ui;color:#111;background:#fff',
    });
    var researchBox = h('input', { type: 'checkbox', id: 'sbliresearch', checked: true, style: 'margin:2px 0 0' });
    var lookBox = h('input', { type: 'checkbox', id: 'sblilook', checked: true, style: 'margin:2px 0 0' });
    // Off by default: LinkedIn's keyword search turns up small pages, not
    // the big names (Leo: "the big electrolyte brands don't come up when
    // you search electrolyte") — the research list is how those come in.
    var words = h('input', {
      id: 'sbliwords', value: '', placeholder: 'optional, e.g. electrolyte drink',
      style: 'display:block;box-sizing:border-box;width:100%;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font:12.5px system-ui;color:#111;background:#fff;margin-top:4px',
    });
    var discoverNow = function () {
      return {
        lookalikes: lookBox.checked,
        words: words.value.split(/[,;]/).map(function (w) { return w.trim(); }).filter(Boolean).slice(0, 5),
      };
    };
    var out = h('div', { style: 'margin-top:10px' });
    var look = function () {
      var f = focus.value.trim();
      out.textContent = 'Getting the list…';
      post({ action: 'liList', focus: f, research: researchBox.checked }).then(function (j) {
        while (out.firstChild) out.removeChild(out.firstChild);
        if (!j || !j.ok) { out.textContent = (j && j.error) || 'Could not get the list.'; return; }
        if (!j.items.length) {
          var dn = discoverNow();
          out.appendChild(h('div', { style: MUTED, text: 'Every brand is full, off outreach, or resting after a recent visit.' + (dn.words.length ? ' It can still search for new brands.' : ' Nothing to do.') }));
          if (dn.words.length) out.appendChild(h('button', { id: 'sblifillstart', style: BTN, text: 'Search for new brands', onclick: function () { startFill([], f, discoverNow()); } }));
          return;
        }
        var first = j.items.filter(function (i) { return i.focus; });
        var have = j.items.length - (j.research || 0);
        out.appendChild(h('div', { style: MUTED }, [b(String(have)), ' brands under ' + j.cap + ' people' +
          (j.research ? ', plus ' : '.'), j.research ? b(String(j.research)) : null, j.research ? ' names from the research list to find on LinkedIn.' : null]));
        if (f) out.appendChild(h('div', { style: 'font-size:12px;color:#555;margin-bottom:6px', text: first.length
          ? 'First the ' + first.length + ' matching “' + f + '”: ' + first.slice(0, 15).map(function (i) { return i.name; }).join(', ') + (first.length > 15 ? '…' : '') + '. Then everything else, emptiest first.'
          : 'None match “' + f + '” — it goes emptiest first.' }));
        if (j.noPage) out.appendChild(h('div', { style: 'font-size:12px;color:#555;margin-bottom:6px', text: j.noPage + ' have no LinkedIn page saved; it searches LinkedIn for those and only uses a clear match.' }));
        if (j.resting) out.appendChild(h('div', { style: 'font-size:12px;color:#555;margin-bottom:6px', text: j.resting + ' left out: nothing new on their last visit (they rest a month).' }));
        if (j.researchWaiting) out.appendChild(h('div', { style: 'font-size:12px;color:#555;margin-bottom:6px', text: j.researchWaiting + ' research names left out: LinkedIn had no clear page for them last month.' }));
        out.appendChild(h('div', { style: 'font-size:12px;color:#555;margin-bottom:8px', text: 'At about ' + DAILY_CAP + ' a day that is roughly ' + Math.ceil(j.items.length / DAILY_CAP) + ' day(s).' }));
        out.appendChild(h('button', { id: 'sblifillstart', style: BTN, text: 'Start', onclick: function () { startFill(j.items, f, discoverNow()); } }));
      }).catch(function (e) { out.textContent = e.message; });
    };
    focus.onkeydown = function (e) { if (e.key === 'Enter') look(); };
    freshPanel([
      head('Fill brands by itself'),
      h('div', { style: MUTED, text: 'Goes through every brand under 25 people, one at a time in this tab, and saves the buyers it finds. About ' + DAILY_CAP + ' brands a day, 1–2½ minutes apart. It pauses if LinkedIn shows a check or a limit.' }),
      h('div', { style: 'font-size:12px;color:#555;margin-bottom:4px', text: 'Start with brands matching (optional):' }),
      h('div', { style: 'display:flex;gap:6px' }, [
        focus,
        h('button', {
          id: 'sblifilllook', text: 'See the list', onclick: look,
          style: 'background:#fff;color:#111;border:1px solid #ccc;border-radius:6px;padding:5px 10px;cursor:pointer;font:12.5px system-ui',
        }),
      ]),
      h('div', { style: 'margin-top:12px;padding-top:10px;border-top:1px solid #eee' }, [
        h('div', { style: 'font-weight:600;margin-bottom:6px', text: 'Find new brands too' }),
        h('label', { style: 'display:flex;gap:7px;align-items:flex-start;font-size:12px;color:#333;cursor:pointer;margin-bottom:6px' }, [
          researchBox,
          h('span', { text: 'Look up the research list — the well-known brands on Stock take we don\'t have yet (Powerade, Vita Coco…). Added when LinkedIn clearly has them.' }),
        ]),
        h('label', { style: 'display:flex;gap:7px;align-items:flex-start;font-size:12px;color:#333;cursor:pointer' }, [
          lookBox,
          h('span', { text: 'Add brands LinkedIn shows as similar to each brand it visits' }),
        ]),
        h('div', { style: 'font-size:12px;color:#333;margin-top:8px', text: 'Also search LinkedIn for these words (finds small brands, not big ones):' }),
        words,
        h('div', { style: 'font-size:11.5px;color:#777;margin-top:6px', text: 'New brands go straight into the dashboard and their people are read in the same run. Lookalikes and searches: consumer industries with 5K+ LinkedIn followers, up to 50 a day. Press See the list again after changing these.' }),
      ]),
      out,
      h('div', { style: SMALL, text: 'Use a tab you\'re not using — clicking or typing in it pauses the run.' }),
    ]);
  }

  function fillLink() {
    return h('div', { style: 'margin-top:6px' }, [
      h('a', {
        href: '#', id: 'sblifilllink', style: 'color:#555;font-size:11.5px', text: 'Fill brands by itself…',
        onclick: function (e) { e.preventDefault(); openFillSetup(); },
      }),
    ]);
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
      if (lastPath && !busy && !fillHere()) { closePanel(); lastRead = null; }
      lastPath = location.pathname;
    }
  }
  // A second way in, from the Tampermonkey icon's menu — works even if
  // something on the page hides the pill.
  try {
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('Open the SB capture panel', guard(openMenu));
      GM_registerMenuCommand('Fill brands by itself', guard(openFillSetup));
      GM_registerMenuCommand('Copy a sample of this page for Claude', guard(copySample));
    }
  } catch (e) {}
  try { console.info('[SB] LinkedIn capture ' + VERSION + ' running' + (HAS_GM ? '' : ' WITHOUT its @grant lines — reinstall')); } catch (e) {}

  tick();
  setInterval(tick, 1500);

  // A run's tab picks the run back up on every page load, once LinkedIn
  // has had a moment to draw the page.
  if (fillHere()) later(runFill, rand(2500, 4000));
})();
