// ==UserScript==
// @name         SB Dashboard — LinkedIn People Capture
// @namespace    sbagency.command-center
// @version      1.0
// @description  On a brand's LinkedIn People page, send its marketing and partnership people to the SB Command Center. One click, one page — nothing browses on its own.
// @match        https://www.linkedin.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
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
// paste this in -> save. Open any company page on LinkedIn, click the SB
// pill, paste the ingest token. It then updates itself from GitHub.
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

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
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

  var pill, panel, busy = false, lastRead = null;

  var PANEL_CSS = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;background:#fff;color:#111;border:1px solid #d9d9d6;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.25);padding:14px 16px;font:13px/1.45 system-ui,-apple-system,sans-serif;width:340px;max-height:80vh;overflow:auto;text-align:left';
  var BTN = 'width:100%;background:#111;color:#fff;border:0;border-radius:7px;padding:9px 12px;cursor:pointer;font-weight:600;font:600 13px system-ui';
  var BTN2 = 'width:100%;background:#fff;color:#111;border:1px solid #ccc;border-radius:7px;padding:8px 12px;cursor:pointer;font:13px system-ui';

  function freshPanel() {
    if (panel) panel.remove();
    panel = document.createElement('div');
    panel.className = 'sb-li-ui';
    panel.id = 'sbli-panel';
    panel.style.cssText = PANEL_CSS;
    document.body.appendChild(panel);
    return panel;
  }
  function closePanel() { if (panel) { panel.remove(); panel = null; } }

  function head(title) {
    return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
      '<div style="width:22px;height:22px;border-radius:6px;background:#111;color:#fff;font-weight:700;font-size:11px;display:flex;align-items:center;justify-content:center">SB</div>' +
      '<b style="flex:1">' + esc(title) + '</b>' +
      '<span data-x style="cursor:pointer;color:#999;font-size:16px">×</span></div>';
  }
  function wireClose(p) {
    var x = p.querySelector('[data-x]');
    if (x) x.onclick = closePanel;
  }

  function keywordChips() {
    var base = companyBase();
    if (!base) return '';
    return '<div style="font-size:11.5px;color:#777;margin:10px 0 5px">Big company? Narrow the page first:</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:5px">' +
      KEYWORDS.map(function (k) {
        return '<a href="' + esc(base + 'people/?keywords=' + encodeURIComponent(k)) + '" ' +
          'style="border:1px solid #ddd;border-radius:99px;padding:3px 9px;color:#111;text-decoration:none;font-size:12px">' + esc(k) + '</a>';
      }).join('') + '</div>';
  }

  function tokenLink() {
    return '<div style="margin-top:10px"><a href="#" data-key style="color:#999;font-size:11px">Change the token</a></div>';
  }
  function wireToken(p) {
    var k = p.querySelector('[data-key]');
    if (k) k.onclick = function (e) { e.preventDefault(); forgetToken(); openSetup(); };
  }

  function openSetup() {
    var p = freshPanel();
    p.innerHTML = head('Connect to the SB dashboard') +
      '<div style="color:#555;font-size:12px;margin-bottom:10px">Paste the ingest token — the same value as INGEST_TOKEN in Vercel. Tampermonkey keeps it; LinkedIn can\'t read it; it only goes to the dashboard.</div>' +
      '<input id="sblitok" type="password" autocomplete="off" spellcheck="false" placeholder="Ingest token" style="width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #ccc;border-radius:6px;margin-bottom:10px;font:13px system-ui">' +
      '<div style="display:flex;gap:8px;align-items:center">' +
        '<button id="sblitoksave" style="background:#111;color:#fff;border:0;border-radius:7px;padding:7px 12px;cursor:pointer;font-weight:600">Save</button>' +
        '<span id="sblitokmsg" style="font-size:11.5px;flex:1"></span>' +
      '</div>';
    wireClose(p);
    var save = function () {
      var v = (p.querySelector('#sblitok').value || '').trim();
      var msg = p.querySelector('#sblitokmsg');
      if (!v) { msg.textContent = 'Paste the token first.'; return; }
      saveToken(v);
      msg.innerHTML = '<span style="color:#137333">Checking…</span>';
      // An empty preview: proves the token now, saves nothing.
      post({ action: 'liPreview', rows: [] }).then(function (j) {
        if (j && j.ok) { openMenu(); return; }
        forgetToken();
        msg.innerHTML = '<span style="color:#b00">' + esc((j && j.error) || 'The dashboard rejected that token.') + '</span>';
      }).catch(function (e) {
        forgetToken();
        msg.innerHTML = '<span style="color:#b00">' + esc(e.message) + '</span>';
      });
    };
    p.querySelector('#sblitoksave').onclick = save;
    p.querySelector('#sblitok').onkeydown = function (e) { if (e.key === 'Enter') save(); };
  }

  function openMenu() {
    if (!token()) return openSetup();
    if (busy) return;
    if (onPeoplePage()) return readPage();
    var p = freshPanel();
    p.innerHTML = head(companyName() || 'LinkedIn') +
      '<div style="color:#555;margin-bottom:10px">This reads a company\'s <b>People</b> tab. Open it, then press the SB pill again.</div>' +
      '<button id="sblipeople" style="' + BTN + '">Open the People tab</button>' +
      keywordChips() + tokenLink();
    wireClose(p);
    wireToken(p);
    p.querySelector('#sblipeople').onclick = function () { location.href = companyBase() + 'people/'; };
  }

  function readPage() {
    busy = true;
    var halt = { stopped: false };
    var p = freshPanel();
    p.innerHTML = head('Reading this page') +
      '<div id="sbliprog" style="color:#555;margin-bottom:10px">' + count() + ' people on screen…</div>' +
      '<div style="color:#999;font-size:11px;margin-bottom:10px">Scrolling this one page, with pauses, up to ' + MAX_PEOPLE + ' people. Nothing is saved yet.</div>' +
      '<button id="sblistop" style="' + BTN2 + '">Stop and use what\'s here</button>';
    wireClose(p);
    p.querySelector('#sblistop').onclick = function () { halt.stopped = true; };
    expand(function (n) {
      var el = document.getElementById('sbliprog');
      if (el) el.textContent = n + ' people on screen…';
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
    var p = freshPanel();
    p.innerHTML = head('Something went wrong') + '<div style="color:#b00">' + esc(msg) + '</div>' + tokenLink();
    wireClose(p);
    wireToken(p);
  }

  function group(title, rows, open, color) {
    if (!rows.length) return '';
    var list = rows.map(function (r) {
      return '<div style="padding:2px 0">' + esc(r.name) +
        (r.role ? ' <span style="color:#777">— ' + esc(r.role) + '</span>' : '') +
        (r.at ? ' <span style="color:#946200">(on file at ' + esc(r.at) + ')</span>' : '') + '</div>';
    }).join('');
    return '<details' + (open ? ' open' : '') + ' style="margin-top:8px">' +
      '<summary style="cursor:pointer;font-weight:600;color:' + (color || '#111') + '">' + esc(title) + ' (' + rows.length + ')</summary>' +
      '<div style="font-size:12px;margin-top:4px;max-height:180px;overflow:auto">' + list + '</div></details>';
  }

  function renderPreview(j, typed) {
    var by = function (v) { return j.rows.filter(function (r) { return r.verdict === v; }); };
    var adds = by('add'), waiting = by('noBrand');
    var p = freshPanel();
    var brandLine;
    if (j.brand) {
      brandLine = '<div style="margin-bottom:4px">For <b>' + esc(j.brand.name) + '</b> · ' + j.have + ' of ' + j.cap + ' on file' +
        (j.room ? ', room for ' + j.room : ' — full') + '</div>' +
        (j.pageMismatch ? '<div style="font-size:11.5px;color:#946200;margin-bottom:4px">This brand has a different LinkedIn page saved (maybe a parent or sister brand). Adding people here is fine; the saved page stays.</div>' : '');
    } else {
      brandLine = '<div style="color:#946200;margin-bottom:4px">' +
        (j.notFound ? 'No brand called "' + esc(j.notFound) + '" in the dashboard.' : 'Which dashboard brand is this? None matched "' + esc(lastRead.companyName) + '".') +
        '</div>' +
        (j.suggestions && j.suggestions.length
          ? '<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px">' + j.suggestions.map(function (s) {
              return '<button data-pick="' + esc(s) + '" style="border:1px solid #ddd;background:#fff;border-radius:99px;padding:3px 9px;cursor:pointer;font-size:12px">' + esc(s) + '</button>';
            }).join('') + '</div>'
          : '');
    }
    p.innerHTML = head(lastRead.companyName || 'LinkedIn') + brandLine +
      '<div style="display:flex;gap:6px;margin:6px 0 4px">' +
        '<input id="sblibrand" list="" value="' + esc(typed || (j.brand ? j.brand.name : '')) + '" placeholder="Dashboard brand name" ' +
          'style="flex:1;min-width:0;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font:12.5px system-ui">' +
        '<button id="sblicheck" style="background:#fff;border:1px solid #ccc;border-radius:6px;padding:5px 10px;cursor:pointer;font:12.5px system-ui">' + (j.brand ? 'Change' : 'Check') + '</button>' +
      '</div>' +
      '<div style="font-size:12px;color:#555;margin-top:8px">' + lastRead.rows.length + ' people read from this page.</div>' +
      group(j.brand ? 'Will add' : 'Buyers found', j.brand ? adds : waiting, true, '#137333') +
      group('Over the ' + j.cap + ' cap', by('full'), false, '#946200') +
      group('Already on file', by('dupe'), false, '#555') +
      group('On file at another brand', by('elsewhere'), false, '#946200') +
      group('Not a buyer title — left out', by('notBuyer'), false, '#999') +
      (j.brand
        ? '<button id="sbliadd" style="' + BTN + ';margin-top:12px"' + (adds.length ? '' : ' disabled') + '>' +
            (adds.length ? 'Add ' + adds.length + ' to ' + esc(j.brand.name) : 'Nobody new to add') + '</button>'
        : '') +
      '<div style="color:#999;font-size:11px;margin-top:8px">No emails — LinkedIn doesn\'t show them. New people join the LinkedIn queue; it keeps the best 4 per brand in play.</div>' +
      keywordChips() + tokenLink();
    wireClose(p);
    wireToken(p);
    var box = p.querySelector('#sblibrand');
    var check = function () { preview(box.value.trim()).catch(function (e) { showError(e.message); }); };
    p.querySelector('#sblicheck').onclick = check;
    box.onkeydown = function (e) { if (e.key === 'Enter') check(); };
    [].slice.call(p.querySelectorAll('[data-pick]')).forEach(function (b) {
      b.onclick = function () { preview(b.getAttribute('data-pick')).catch(function (e) { showError(e.message); }); };
    });
    var add = p.querySelector('#sbliadd');
    if (add && adds.length) add.onclick = function () { capture(typed, add); };
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
      var p = freshPanel();
      p.innerHTML = head('Saved') +
        '<div style="margin-bottom:6px"><b>' + j.added + '</b> added to <b>' + esc(j.brand.name) + '</b>. It now has ' + j.have + ' of ' + j.cap + ' people on file.</div>' +
        (j.targetsShelved ? '<div style="font-size:12px;color:#555">' + j.targetsShelved + ' parked on the brand page — the queue keeps the best 4 per brand in play.</div>' : '') +
        (j.savedPage ? '<div style="font-size:12px;color:#555">This page is now saved as the brand\'s LinkedIn page, so next time it matches by itself.</div>' : '') +
        (j.failed ? '<div style="font-size:12px;color:#b00">' + j.failed + ' could not be saved: ' + esc((j.errors || []).join('; ')) + '</div>' : '') +
        '<a href="' + esc(DASH_URL + '#brand/' + j.brand.id) + '" target="_blank" rel="noopener" style="display:block;margin-top:10px;' + BTN2 + ';text-align:center;text-decoration:none;box-sizing:border-box">Open the brand in the dashboard ↗</a>' +
        '<div style="color:#999;font-size:11px;margin-top:8px">Still short? Try a keyword below, then press the SB pill again.</div>' +
        keywordChips();
      wireClose(p);
    }).catch(function (e) { showError(e.message); });
  }

  function ensurePill() {
    if (pill || !document.body) return;
    pill = document.createElement('button');
    pill.id = 'sblipill';
    pill.className = 'sb-li-ui';
    pill.textContent = 'SB ⬇ People';
    pill.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483646;background:#111;color:#fff;border:0;border-radius:999px;padding:11px 16px;font:600 13px system-ui,-apple-system,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.28);cursor:pointer';
    pill.onclick = openMenu;
    document.body.appendChild(pill);
  }

  // LinkedIn is a single-page app: moving between a company's tabs, or
  // to someone's profile, never reloads the page. So the pill follows
  // the address on a timer — shown on company pages, gone elsewhere.
  var lastPath = '';
  function tick() {
    var here = !!companyPath();
    if (here) ensurePill();
    if (pill) pill.style.display = here ? 'block' : 'none';
    if (location.pathname !== lastPath) {
      // A different page: whatever the panel said is about the old one.
      if (lastPath && !busy) { closePanel(); lastRead = null; }
      lastPath = location.pathname;
    }
    if (!here && panel && !busy) closePanel();
  }
  tick();
  setInterval(tick, 1500);
})();
