// ==UserScript==
// @name         SB Dashboard — SponsorUnited Contact Capture
// @namespace    sbagency.command-center
// @version      4.4
// @description  Capture contacts from SponsorUnited into the SB Command Center, and find the profile ids of brands we cannot reach yet.
// @match        https://pro.sponsorunited.com/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/zadegan1515-arch/SBDigitaldashboard/main/scripts/sponsorunited-capture.user.js
// @downloadURL  https://raw.githubusercontent.com/zadegan1515-arch/SBDigitaldashboard/main/scripts/sponsorunited-capture.user.js
// ==/UserScript==

// -------------------------------------------------------------------
// This is the capture button Leo runs in Tampermonkey. It lives here so
// it survives a cleared browser or a new laptop — the copy in the
// browser is the one that runs, this one is the backup and the record.
//
// TO INSTALL (once): Tampermonkey -> Dashboard -> + (new script) ->
// paste this in -> save. Then open SponsorUnited, click the SB pill, and
// paste the ingest token into the box it shows. That's the whole setup.
//
// After that Tampermonkey updates this script from GitHub on its own,
// and the token stays where you put it — so a new version never means
// pasting the token again. (Auto-update reads the repo over https; if
// the repo is ever made private, updates stop silently and you go back
// to pasting the file in by hand.)
//
// The token is NOT in this file and must never be put in it. It's the
// same value as INGEST_TOKEN in Vercel. Anyone holding it can write
// contacts into the dashboard, so it stays out of the repo, out of
// screenshots and out of chat. The script keeps it in this browser's own
// storage and sends it to exactly one place: the dashboard's ingest URL.
// -------------------------------------------------------------------

(function () {
  'use strict';

  var INGEST_URL   = 'https://sb-digitaldashboard.vercel.app/api/ingest';

  // Older installs had the token pasted on a line here. It now lives in
  // this browser's storage instead, so updating the script doesn't wipe
  // it. Leave this line as it is — an old inline token migrates across
  // by itself the first time the new version runs.
  var LEGACY_TOKEN = 'PASTE_INGEST_TOKEN_HERE';
  var TOKEN_KEY = 'sbIngestToken';

  function token() {
    try {
      var t = localStorage.getItem(TOKEN_KEY);
      if (t) return t;
    } catch (e) {}
    return LEGACY_TOKEN.indexOf('PASTE_') === 0 ? '' : LEGACY_TOKEN;
  }
  function saveToken(t) {
    try { localStorage.setItem(TOKEN_KEY, String(t || '').trim()); } catch (e) {}
  }
  function forgetToken() {
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  }
  (function migrate() {
    try {
      if (!localStorage.getItem(TOKEN_KEY) && LEGACY_TOKEN.indexOf('PASTE_') !== 0) saveToken(LEGACY_TOKEN);
    } catch (e) {}
  })();

  var LI_SEL = 'a[href*="linkedin.com/in"], a[href*="linkedin.com/pub"]';

  // Pull the name / title / location out of a card's visible text.
  function readCard(card, email) {
    var lines = card.innerText.split('\n')
      .map(function (s) { return s.trim(); })
      .filter(Boolean)
      .filter(function (l) { return !/^(suggested|new|more details|verified|follow|following)$/i.test(l); })
      .filter(function (l) { return l !== email; });

    var name = lines[0] || null;
    var title = lines[1] || null;
    var location = null;
    for (var j = lines.length - 1; j >= 2; j--) {
      if (/,/.test(lines[j])) { location = lines[j]; break; }
    }
    return { name: name, title: title, location: location };
  }

  // Walk up from an anchor to the block that holds one person: stop just
  // before the ancestor starts covering a second person's link, and don't
  // balloon into the whole list.
  function cardAround(el) {
    while (el.parentElement && el.parentElement !== document.body) {
      var p = el.parentElement;
      if (p.querySelectorAll(LI_SEL).length > 1) break;
      if (p.querySelectorAll('a[href^="mailto:"]').length > 1) break;
      el = p;
      if ((el.innerText || '').split('\n').filter(Boolean).length > 12) break;
    }
    return el;
  }

  function scrapeContacts() {
    // Every link that marks a person: a LinkedIn profile or an address.
    // Rooting on both is what picks up contacts SponsorUnited lists with
    // an email and no profile — they used to be invisible here.
    var roots = [].slice.call(document.querySelectorAll(LI_SEL + ', a[href^="mailto:"]'));
    var cards = [];
    var rows = [];

    roots.forEach(function (a) {
      var card = cardAround(a);
      // One person's LinkedIn link and address land on the same card;
      // take the card once.
      if (cards.indexOf(card) !== -1) return;
      if (cards.some(function (c) { return c.contains(card) || card.contains(c); })) return;
      cards.push(card);

      var em = card.querySelector('a[href^="mailto:"]');
      var email = em ? em.getAttribute('href').replace(/^mailto:/, '') : null;
      var li = card.querySelector(LI_SEL);
      var got = readCard(card, email);

      if (!got.name || got.name.indexOf('@') !== -1 || got.name.length > 70) return;
      if (rows.some(function (r) { return r.name === got.name; })) return;

      rows.push({
        name: got.name,
        title: got.title,
        location: got.location,
        email: email,
        linkedinUrl: li ? li.getAttribute('href') : null,
      });
    });

    return rows;
  }

  function brandUlid() {
    var m = location.pathname.match(/\/profile\/([^\/?#]+)/);
    return m ? m[1] : null;
  }
  function onBrandPage() { return !!brandUlid(); }

  function guessBrandName() {
    var t = (document.title || '').split(/\s+\(/)[0].replace(/\s*\|.*$/, '').trim();
    return t || '';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[<>&"]/g, function (c) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c];
    });
  }

  // -------------------------------------------------------------
  // Unattended sweep
  //
  // "Capture all" asks the dashboard which brands to visit, then walks
  // them one at a time: open the profile's contacts tab, wait for the
  // list to render, capture, pause, next. The job lives in localStorage
  // because every step is a real page navigation that tears this script
  // down and starts it again — on each load we pick the job back up.
  //
  // Deliberately unhurried. A pause between brands keeps this looking
  // like a person reading profiles rather than something hammering
  // SponsorUnited, and a failed brand is recorded and stepped over
  // rather than retried in a loop.
  // -------------------------------------------------------------
  var JOB_KEY = 'sbCaptureJob';
  var GAP_MS = 6000;      // between brands
  var SETTLE_MS = 2600;   // after a profile loads, before reading it
  var MAX_WAIT_MS = 14000; // give a slow contacts list this long to appear

  function loadJob() {
    try { return JSON.parse(localStorage.getItem(JOB_KEY) || 'null'); } catch (e) { return null; }
  }
  function saveJob(j) {
    try { j ? localStorage.setItem(JOB_KEY, JSON.stringify(j)) : localStorage.removeItem(JOB_KEY); } catch (e) {}
  }
  function stopJob() { saveJob(null); }

  function profileUrl(externalId) {
    return 'https://pro.sponsorunited.com/profile/' + encodeURIComponent(externalId) + '/contacts';
  }

  function post(payload) {
    // No token yet — fail here rather than throwing 401s at the
    // dashboard every four seconds until someone notices.
    if (!token()) return Promise.reject(new Error('No ingest token saved yet'));
    return fetch(INGEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (r) { return r.json(); });
  }

  // Contacts render after the page settles, so poll until people show up
  // rather than reading an empty list and calling the brand done.
  function waitForContacts() {
    return new Promise(function (resolve) {
      var started = Date.now();
      (function look() {
        var rows = scrapeContacts();
        if (rows.length) return resolve(rows);
        if (Date.now() - started > MAX_WAIT_MS) return resolve([]);
        setTimeout(look, 700);
      })();
    });
  }

  // Their contacts tab shows a first screen and loads the rest as you
  // scroll or click "load more". Reading just the first screen is why a
  // brand with three people on file never got a fourth: the same three
  // were the only ones on screen, every visit. Scroll and click until
  // the list stops growing, then read it once.
  var EXPAND_ROUNDS = 8;
  var EXPAND_WAIT_MS = 1100;
  function expandContacts(rows) {
    return new Promise(function (resolve) {
      var round = 0;
      // Union across rounds, by name: a paginated list swaps page one out
      // for page two, so reading only what is on screen at the end would
      // lose the first page.
      var seen = {};
      var all = [];
      var merge = function (list) {
        var grew = false;
        list.forEach(function (r) { if (!seen[r.name]) { seen[r.name] = 1; all.push(r); grew = true; } });
        return grew;
      };
      merge(rows);
      (function more() {
        if (round++ >= EXPAND_ROUNDS) return resolve(all);
        var clicked = false;
        var btns = [].slice.call(document.querySelectorAll('button, [role="button"], a'));
        for (var i = 0; i < btns.length; i++) {
          var b = btns[i];
          if ((pill && pill.contains(b)) || (panel && panel.contains(b))) continue;
          if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
          var t = (b.textContent || '').replace(/\s+/g, ' ').trim();
          if (!/^((load|show|see|view) (more|all)( contacts)?|more contacts|next)$/i.test(t)) continue;
          var href = b.getAttribute('href');
          if (href && !/^(#|javascript:)/.test(href)) continue;   // a real link would navigate away
          if (!b.getBoundingClientRect().width) continue;
          try { b.click(); clicked = true; } catch (e) {}
          break;
        }
        // Scroll the page and any scrollable list to the bottom.
        try { window.scrollTo(0, document.documentElement.scrollHeight); } catch (e) {}
        var boxes = [].slice.call(document.querySelectorAll('div, main, section, ul'));
        for (var k = 0; k < boxes.length; k++) {
          var el = boxes[k];
          if (el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 150) {
            var ov = getComputedStyle(el).overflowY;
            if (ov === 'auto' || ov === 'scroll') el.scrollTop = el.scrollHeight;
          }
        }
        setTimeout(function () {
          var grew = merge(scrapeContacts());
          if (grew || clicked) return more();
          resolve(all);
        }, EXPAND_WAIT_MS);
      })();
    });
  }

  function runStep() {
    var job = loadJob();
    if (!job || job.paused) return;
    var item = job.items[job.at];
    if (!item) { finishJob(job); return; }
    // He's back and clicking around — don't yank the page. Check again
    // in a moment; the worklist keeps.
    if (autoHold(job)) { setTimeout(runStep, 5000); return; }

    // Not on this brand's page yet — go there; the script restarts on
    // load and lands back here with the page it needs.
    if (brandUlid() !== item.externalId) {
      renderJobPanel(job, 'Opening ' + item.name + '…');
      location.href = profileUrl(item.externalId);
      return;
    }

    renderJobPanel(job, 'Reading ' + item.name + '…');
    setTimeout(function () {
      waitForContacts().then(function (first) {
        if (!first.length) return [];
        renderJobPanel(job, 'Loading the whole list for ' + item.name + '…');
        return expandContacts(first);
      }).then(function (rows) {
        if (!rows.length) {
          job.results.push({ name: item.name, added: 0, note: 'no contacts listed' });
          // Tell the dashboard, so this brand rests instead of being
          // opened again next run.
          post({ token: token(), action: 'swept', brandId: item.id, seen: 0, added: 0 }).catch(function () {});
          return next(job);
        }
        renderJobPanel(job, 'Sending ' + rows.length + ' people from ' + item.name + '…');
        return post({
          token: token(),
          brandExternalId: item.externalId,
          rows: rows.map(function (r) {
            return { brandName: item.suName || item.name, name: r.name, title: r.title, email: r.email, linkedinUrl: r.linkedinUrl, location: r.location };
          }),
        }).then(function (j) {
          var added = (j && j.contactsCreated) || 0;
          job.results.push({
            name: item.name,
            added: added,
            note: !j || !j.ok ? ((j && j.error) || 'failed')
              : (j.brandsMissing && j.brandsMissing.length) ? 'held for review'
              : (!added && j.capped) ? 'already holds 25'
              : !added ? 'nothing new — all ' + rows.length + ' on file already'
              : '',
          });
          next(job);
        }).catch(function (e) {
          job.results.push({ name: item.name, added: 0, note: e.message });
          next(job);
        });
      });
    }, SETTLE_MS);
  }

  function next(job) {
    job.at += 1;
    saveJob(job);
    if (!job.items[job.at]) { finishJob(job); return; }
    renderJobPanel(job, 'Waiting a moment…');
    setTimeout(function () { if (loadJob()) runStep(); }, GAP_MS);
  }

  function finishJob(job) {
    var added = job.results.reduce(function (n, r) { return n + r.added; }, 0);
    var done = { finishedAt: Date.now(), added: added, results: job.results, total: job.items.length,
      noProfile: job.noProfile || 0, resting: job.resting || 0, ignoredRest: !!job.ignoredRest };
    stopJob();
    try { localStorage.setItem('sbCaptureLast', JSON.stringify(done)); } catch (e) {}
    renderDonePanel(done);
  }

  // opts.ignoreRest: walk the brands that are resting too. Resting is a
  // guess about SponsorUnited, not a fact, and after adding profile ids
  // by hand Leo wants those brands visited now rather than in a
  // fortnight.
  function startSweep(scope, opts) {
    var auto = !!(opts && opts.auto);
    var ignoreRest = !!(opts && opts.ignoreRest);
    renderJobPanel(null, 'Asking the dashboard what to capture…');
    post({ token: token(), action: 'list', scope: scope, limit: 200, ignoreRest: ignoreRest }).then(function (j) {
      if (!j || !j.ok) throw new Error((j && j.error) || 'Could not get the list');
      if (!j.brands.length) {
        renderMessage('Nothing to sweep',
          scope !== 'all'
            ? (j.resting
                ? 'Every reachable brand is either at 25 or resting (' + j.resting + ' had nobody new last time, they come back after two weeks).'
                : 'Every brand whose SponsorUnited profile we know is already at 25 people.')
            : 'No brands have a saved SponsorUnited profile yet.',
          j.noProfile, j.resting && !ignoreRest ? { scope: scope, resting: j.resting } : null);
        return;
      }
      var job = { scope: scope, items: j.brands, at: 0, results: [], noProfile: j.noProfile,
        resting: (ignoreRest ? 0 : j.resting) || 0, underCap: j.underCap || 0,
        ignoredRest: ignoreRest, auto: auto, startedAt: Date.now() };
      saveJob(job);
      runStep();
    }).catch(function (e) { renderMessage('Could not start', e.message, 0); });
  }

  // -------------------------------------------------------------
  // Finding profile ids
  //
  // A brand can only be swept once we know its SponsorUnited profile
  // id, and that id only exists behind their search — which is an
  // autocomplete inside the app, not a linkable URL. So the search has
  // to be performed here, in the logged-in tab, by typing into their own
  // box and reading what comes back. Nothing calls their API.
  //
  // Two ways in, one mechanism:
  //   · the dashboard asks a question ("who is Yerba Madre?") and this
  //     script answers it while Leo watches the dashboard;
  //   · "Find profile ids" walks every brand we cannot reach and lets
  //     the server judge each result.
  // -------------------------------------------------------------

  // Keep in step with @version above; the menu shows it, so "which
  // version are you on" is one look. scripts/test-capture.js checks.
  var SCRIPT_VERSION = '4.4';
  // Sent on every lookup call: this copy reads only what the search
  // brings up. The dashboard turns away lookups without it, because
  // copies before 4.2 read the page's own links as results.
  var LOOKUP_READER = 2;
  var SEARCH_SETTLE_MS = 500;    // let the autocomplete catch up
  var SEARCH_WAIT_MS = 9000;     // give slow results this long
  var MATCH_GAP_MS = 3500;       // between brands in a batch run

  // Their search sits in the banner of every page — "SUrface deals,
  // contacts, profiles and more" — so there is no search page to go to
  // and no navigation to wait through. (An earlier version looked for
  // the word "search" in the placeholder, which that wording does not
  // contain, and sent the tab to /search for nothing.)
  function onSearchPage() { return !!findSearchInput(); }

  // Score every visible text box and take the best: their banner box is
  // wide and near the top. Naming-based guesses come first, but a
  // redesign only has to keep a wide box up top for this to survive.
  function findSearchInput() {
    var best = null, bestScore = -1;
    // Not always an <input>: their newer pages render the banner search
    // as a combobox, and some overlays use a contenteditable div.
    var inputs = [].slice.call(document.querySelectorAll(
      // textarea included on purpose: SponsorUnited's banner search is
      // a multi-line box, not an <input>, so every selector list that
      // only named inputs looked straight past the one box that matters.
      'input[type="search"], input[type="text"], input:not([type]), textarea, ' +
      '[role="searchbox"], [role="combobox"] input, [contenteditable="true"]'));
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var r = el.getBoundingClientRect();
      if (r.width < 120 || r.height < 14) continue;          // too small to be it
      if (el.closest('[aria-hidden="true"]')) continue;
      var hint = ((el.getAttribute('placeholder') || '') + ' ' +
                  (el.getAttribute('aria-label') || '') + ' ' +
                  (el.getAttribute('name') || '')).toLowerCase();
      // Not in the banner — unless it names itself their search, which
      // is what a box pushed down by a notice bar or a narrow window does.
      if (r.top > 260 && !/surface|profiles|deals, contacts/.test(hint)) continue;
      var score = r.width / 100;
      if (/surface|profiles|deals, contacts/.test(hint)) score += 40;
      else if (/search/.test(hint)) score += 25;
      if (el.type === 'search') score += 10;
      // The contacts tab has its own "Search contacts" box — never that.
      if (/search contacts|filter/.test(hint)) score -= 60;
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  // Some pages render their search as an icon or a fake box that only
  // becomes a real input once clicked. Scroll up, try again, then click
  // whatever up top calls itself search, and look once more.
  function ensureSearchInput() {
    return new Promise(function (resolve) {
      var el = findSearchInput();
      if (el) return resolve(el);
      try { window.scrollTo(0, 0); } catch (e) {}
      setTimeout(function () {
        el = findSearchInput();
        if (el) return resolve(el);
        var cands = [].slice.call(document.querySelectorAll('button, [role="button"], [role="search"], [role="combobox"], div, span'));
        var trigger = null;
        for (var i = 0; i < cands.length && !trigger; i++) {
          var c = cands[i];
          if ((pill && pill.contains(c)) || (panel && panel.contains(c))) continue;
          var r = c.getBoundingClientRect();
          if (!r.width || r.top > 260 || r.top < 0) continue;
          var label = ((c.getAttribute('aria-label') || '') + ' ' + (c.getAttribute('title') || '') + ' ' +
                       (c.getAttribute('placeholder') || '') + ' ' +
                       (c.children.length ? '' : (c.textContent || ''))).toLowerCase();
          if (/surface|search/.test(label) && !/search contacts|filter/.test(label)) trigger = c;
        }
        if (!trigger) return resolve(null);
        try { trigger.click(); } catch (e) {}
        setTimeout(function () { resolve(findSearchInput()); }, 700);
      }, 300);
    });
  }

  // What the page has instead, so a screenshot of the message says why.
  function describeInputs() {
    // Same net as the finder, or the diagnostic reports that there is
    // nothing here while the thing we want is sitting on the page.
    var inputs = [].slice.call(document.querySelectorAll('input, textarea, [contenteditable="true"]'));
    if (!inputs.length) return 'No text boxes on this page at all.';
    return 'Text boxes seen: ' + inputs.slice(0, 6).map(function (el) {
      var r = el.getBoundingClientRect();
      return '"' + (el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.type || '?').slice(0, 40) +
        '" ' + Math.round(r.width) + 'px wide at ' + Math.round(r.top) + 'px';
    }).join(' · ');
  }

  // React keeps its own copy of an input's value, so assigning .value
  // alone changes the pixels and nothing else. Go through the native
  // setter and fire the events their handler is listening for.
  function typeInto(el, text) {
    var proto = Object.getPrototypeOf(el);
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'e' }));
  }

  function profileLinks() {
    return [].slice.call(document.querySelectorAll('a[href*="/profile/"]'));
  }
  function profileIdOf(a) {
    var m = (a.getAttribute('href') || '').match(/\/profile\/([^\/?#]+)/);
    return m ? m[1] : null;
  }

  // The tag their dropdown puts on each result ("Brand", "Property").
  var KIND_RX = /^(brand|property|agency|team|league|venue|event|person|people|contact|company)$/i;
  function textLines(el) {
    return String((el && el.innerText) || '').split('\n')
      .map(function (s) { return s.replace(/\s+/g, ' ').trim(); })
      .filter(Boolean);
  }
  // The row a result link sits in: a list item if there is one, else the
  // widest box around the link that still points at this profile only
  // (a row often links its logo and its name separately).
  function rowOf(a) {
    var li = a.closest('li, tr, [role="option"]');
    if (li) return li;
    var id = profileIdOf(a), el = a;
    while (el.parentElement && el.parentElement !== document.body) {
      var inside = el.parentElement.querySelectorAll('a[href*="/profile/"]'), other = false;
      for (var i = 0; i < inside.length && !other; i++) other = profileIdOf(inside[i]) !== id;
      if (other) break;
      el = el.parentElement;
    }
    return el;
  }
  // One result: the profile id from its link, the name — first line only,
  // because the row also carries the category ("Beverage - Non-Alcoholic
  // Tea") — and the Brand / Property tag when the row shows one.
  function readResult(a) {
    var id = profileIdOf(a);
    if (!id) return null;
    var row = rowOf(a), around = textLines(row), own = textLines(a);
    var name = (own.length ? own : around).filter(function (l) { return !KIND_RX.test(l); })[0] || '';
    var kind = '';
    for (var i = 0; i < around.length; i++) if (KIND_RX.test(around[i])) { kind = around[i].toLowerCase(); break; }
    return name ? { externalId: id, name: name.slice(0, 120), kind: kind } : null;
  }

  // Result links that appeared after typing: a link element that wasn't
  // on the page before, or one their list re-used for a new profile.
  // Deduped by id. Brands only — the same search also returns teams,
  // venues and agencies, and those are never the answer for a brand.
  function freshResults(wasThere) {
    var seen = {}, out = [];
    var links = profileLinks();
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      if (wasThere(a)) continue;
      var box = a.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      var r = readResult(a);
      if (!r || seen[r.externalId]) continue;
      seen[r.externalId] = 1;
      out.push(r);
    }
    return out.filter(function (r) { return !r.kind || r.kind === 'brand'; }).slice(0, 8);
  }

  // Type a name and read what their dropdown shows. Only links that came
  // with the search count: the page has profile links of its own (the
  // dashboard lists eight brands), and reading those as results gave
  // every brand the same eight "matches" and attached nothing. Judging
  // the results is the server's job, not this script's.
  function runSearch(query) {
    return new Promise(function (resolve) {
      var box = findSearchInput();
      if (!box) return resolve({ error: 'Could not find the search box on this page' });
      box.focus();
      typeInto(box, '');                       // close the last search's dropdown first
      setTimeout(function () {
        // Every profile link on the page now, and where it points.
        var prior = profileLinks().map(function (a) { return { el: a, href: a.getAttribute('href') }; });
        var wasThere = function (a) {
          for (var i = 0; i < prior.length; i++) if (prior[i].el === a) return prior[i].href === a.getAttribute('href');
          return false;
        };
        typeInto(box, query);
        var started = Date.now(), lastKey = null;
        setTimeout(function look() {
          var now = freshResults(wasThere);
          var key = now.map(function (r) { return r.externalId; }).join(',');
          // Settled = the same results on two looks in a row.
          if (now.length && key === lastKey) return resolve({ results: now });
          lastKey = key;
          if (Date.now() - started > SEARCH_WAIT_MS) {
            return resolve({ results: now, note: now.length ? 'unsettled' : 'no results' });
          }
          setTimeout(look, 300);
        }, SEARCH_SETTLE_MS);
      }, 400);
    });
  }

  // ---- batch: work through every brand we cannot reach ----

  var MATCH_KEY = 'sbMatchJob';
  function loadMatch() {
    try { return JSON.parse(localStorage.getItem(MATCH_KEY) || 'null'); } catch (e) { return null; }
  }
  function saveMatch(j) {
    try { j ? localStorage.setItem(MATCH_KEY, JSON.stringify(j)) : localStorage.removeItem(MATCH_KEY); } catch (e) {}
  }

  // opts.thenFill: when the lookup finishes, go straight on to capturing
  // every brand under 25. That pair is the whole job Leo actually wants
  // ("fill the rest in"), so the menu offers it as one button.
  var SEARCH_HOME = 'https://pro.sponsorunited.com/dashboard';

  function startMatchSweep(opts) {
    var thenFill = !!(opts && opts.thenFill);
    var auto = !!(opts && opts.auto);
    ensureSearchInput().then(function (box) {
      if (box) return beginMatchSweep(thenFill, auto);

      // No search box here. This used to fall straight through to the
      // capture, which then reported "nothing to sweep" — so pressing
      // "Fill every brand to 25" looked like it ran and did nothing,
      // every time, while the lookup silently never happened. That was
      // the loop.
      //
      // Their search lives on the dashboard, so go there and pick the
      // lookup back up on load rather than asking Leo to be on the
      // right page. Parked in the same store the run itself uses, so a
      // navigation cannot lose it.
      if (location.pathname.indexOf('/dashboard') === -1) {
        saveMatch({ pending: true, fill: thenFill, auto: auto });
        renderMatchPanel(null, 'Opening SponsorUnited\u2019s search to look up the missing profiles…');
        location.href = SEARCH_HOME;
        return;
      }
      // Already on the dashboard and still no box: say so instead of
      // quietly doing the other half of the job.
      renderMessage('Could not reach the search',
        'The script is on SponsorUnited\u2019s dashboard but cannot find their search bar, so profiles cannot be looked up. ' +
        describeInputs(), 0);
    });
  }
  function beginMatchSweep(thenFill, auto) {
    renderMatchPanel(null, 'Asking the dashboard which brands are missing a profile…');
    post({ token: token(), action: 'needProfile', limit: 300, reader: LOOKUP_READER }).then(function (j) {
      if (!j || !j.ok) throw new Error((j && j.error) || 'Could not get the list');
      if (!j.items.length) {
        saveMatch(null);
        if (thenFill) { startSweep('thin', { auto: auto }); return; }
        renderMessage('Nothing to look up', 'Every brand already has a SponsorUnited profile saved.', 0);
        return;
      }
      var job = { items: j.items, at: 0, attached: 0, parked: 0, missing: 0, failed: 0, fill: thenFill, auto: auto, startedAt: Date.now() };
      saveMatch(job);
      matchStep();
    }).catch(function (e) { saveMatch(null); renderMessage('Could not start', e.message, 0); });
  }

  function matchStep() {
    var job = loadMatch();
    if (!job || job.pending) return;
    var item = job.items[job.at];
    if (!item) {
      var fill = job.fill;
      var auto = job.auto;
      var found = job.attached;
      saveMatch(null);
      if (fill) {
        // Straight on to the capture half: the ids we just attached are
        // useless until somebody walks those profiles.
        renderMessage('Found ' + found + ' more profiles — now filling contacts…',
          'Leave this tab open. Anything that needed your eye is waiting in the dashboard under Brands.', 0);
        setTimeout(function () { startSweep('thin', { auto: auto }); }, 1500);
        return;
      }
      renderMessage('Finished looking up profiles',
        job.attached + ' attached · ' + job.parked + ' need your eye · ' + (job.missing || 0) + ' not found · ' + job.failed + ' failed. ' +
        'The ones needing your eye are in the dashboard under Brands.', 0);
      return;
    }
    // Typing into their search bar while he's using it is the same
    // rudeness as navigating — wait him out.
    if (autoHold(job)) { setTimeout(matchStep, 5000); return; }
    renderMatchPanel(job, 'Searching ' + item.name + '…');
    runSearch(item.name).then(function (r) {
      if (r.error) { job.failed += 1; return nextMatch(job); }
      return post({
        token: token(), action: 'matched', reader: LOOKUP_READER,
        brandId: item.brandId, candidates: r.results || [],
      }).then(function (res) {
        // Only 'ambiguous' leaves a question on the dashboard. 'none'
        // (no results, or only pages Leo turned down) parks nothing, so
        // it is counted apart instead of inflating "for review".
        if (res && res.outcome === 'attached') job.attached += 1;
        else if (res && res.outcome === 'ambiguous') job.parked += 1;
        else if (res && res.outcome === 'none') job.missing = (job.missing || 0) + 1;
        else if (!res || !res.ok) job.failed += 1;
        nextMatch(job);
      });
    }).catch(function () { job.failed += 1; nextMatch(job); });
  }

  function nextMatch(job) {
    job.at += 1;
    saveMatch(job);
    setTimeout(function () { if (loadMatch()) matchStep(); }, MATCH_GAP_MS);
  }

  function renderMatchPanel(job, note) {
    var p = freshPanel();
    var total = job ? job.items.length : 0;
    var at = job ? job.at : 0;
    p.innerHTML = head('Finding profiles', 'sbmx') +
      '<div style="font-size:12.5px;margin-bottom:6px">' + esc(note || '') + '</div>' +
      (job
        ? '<div style="font-size:11.5px;color:#555">' + at + ' of ' + total + ' · ' +
            job.attached + ' attached · ' + job.parked + ' for review · ' + (job.missing || 0) + ' not found</div>' +
          '<button id="sbmstop" style="width:100%;margin-top:10px;background:#fff;color:#111;border:1px solid #ccc;border-radius:7px;padding:8px 12px;cursor:pointer">Stop</button>'
        : '');
    var x = p.querySelector('#sbmx');
    if (x) x.onclick = closePanel;
    var stop = p.querySelector('#sbmstop');
    if (stop) stop.onclick = function () { saveMatch(null); closePanel(); };
  }

  // ---- filling by itself ----
  //
  // Leo's rule: every brand should sit at 25 people on file, and he
  // shouldn't have to remember to press a button for that. So whenever a
  // SponsorUnited tab is open and he isn't using it, the script does the
  // same two halves on its own — look up the profile ids we're missing,
  // then top up every brand under 25.
  //
  // Three guards, because this drives the tab he's logged into:
  //   · it only starts after the tab has been left alone for a while, so
  //     a page never jumps out from under him mid-read;
  //   · it waits out a cooldown between runs, so a run that finds
  //     nothing to do doesn't ask again every four seconds;
  //   · Stop, and the off switch in the menu, both hold it off.
  // Nothing it does is destructive: captures only ever add people, and
  // the 25 cap is enforced by the dashboard, not here.

  var AUTO_KEY = 'sbAutoFill';       // '0' = off. Unset = on.
  var AUTO_AT_KEY = 'sbAutoAt';      // when the last auto run started
  var AUTO_IDLE_MS = 120000;         // hands off the tab this long first
  var AUTO_COOLDOWN_MS = 30 * 60000; // between auto runs
  var AUTO_QUIET_MS = 30000;         // don't navigate this soon after a click

  // "When did a human last touch this tab" has to outlive a page load,
  // because a sweep navigates constantly: keeping it in a variable would
  // reset it on every hop and make the script think it had just been
  // clicked. So it lives in localStorage, written at most every couple
  // of seconds. The script's own navigation writes nothing, which is
  // exactly the distinction we need.
  var ACT_KEY = 'sbActivityAt';
  var lastWrite = 0;
  function noteActivity(e) {
    // Only a real person counts. The script types into their search box
    // with dispatched events; if those ever grew a keydown, counting
    // them would make the script think a human had arrived and freeze
    // itself mid-sweep.
    if (e && e.isTrusted === false) return;
    var now = Date.now();
    if (now - lastWrite < 2000) return;
    lastWrite = now;
    try { localStorage.setItem(ACT_KEY, String(now)); } catch (e) {}
  }
  ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'].forEach(function (ev) {
    window.addEventListener(ev, noteActivity, { passive: true, capture: true });
  });
  function idleFor() {
    var at = 0;
    try { at = Number(localStorage.getItem(ACT_KEY) || 0); } catch (e) {}
    return Date.now() - at;
  }

  function autoOn() {
    try { return localStorage.getItem(AUTO_KEY) !== '0'; } catch (e) { return true; }
  }
  function setAuto(on) {
    try { on ? localStorage.removeItem(AUTO_KEY) : localStorage.setItem(AUTO_KEY, '0'); } catch (e) {}
  }
  function autoLast() {
    try { return Number(localStorage.getItem(AUTO_AT_KEY) || 0); } catch (e) { return 0; }
  }
  // Also called when a run is stopped, so stopping buys the same quiet
  // half hour that finishing does.
  function markAuto() {
    try { localStorage.setItem(AUTO_AT_KEY, String(Date.now())); } catch (e) {}
  }

  function maybeAutoFill() {
    if (!token()) return;
    if (!autoOn()) return;
    if (loadJob() || loadMatch()) return;            // something already walking
    if (document.hidden) return;                     // background tab, leave it
    if (idleFor() < AUTO_IDLE_MS) return;            // he's using this tab
    if (Date.now() - autoLast() < AUTO_COOLDOWN_MS) return;
    markAuto();
    // No search bar on this page just means no lookup: the capture
    // half still runs (startMatchSweep falls through to it).
    startMatchSweep({ thenFill: true, auto: true });
  }

  // A run that started itself yields to a returning human: it finishes
  // the brand it is on, then waits rather than navigating away from a
  // page he just clicked into.
  function autoHold(job) {
    return job && job.auto && idleFor() < AUTO_QUIET_MS;
  }

  // ---- answering the dashboard's own search box ----
  //
  // Polled rather than pushed: this tab has no address the dashboard
  // could call. Quiet, and it stands down entirely while a sweep is
  // walking pages so the two never fight over navigation.

  // Idles slowly, then leans in: once a question has been seen, the
  // next one is usually seconds behind it, and waiting six seconds to
  // notice was most of what made a lookup feel slow.
  var POLL_IDLE_MS = 4000;
  var POLL_BUSY_MS = 1200;
  var POLL_BUSY_UNTIL = 0;
  var polling = false;
  var pollTimer = null;

  function schedulePoll() {
    clearTimeout(pollTimer);
    var gap = Date.now() < POLL_BUSY_UNTIL ? POLL_BUSY_MS : POLL_IDLE_MS;
    pollTimer = setTimeout(function () { pollJobs(); schedulePoll(); }, gap);
  }

  function pollJobs() {
    if (!token()) return;
    if (polling || loadJob() || loadMatch()) return;
    polling = true;
    post({ token: token(), action: 'searchJob' }).then(function (j) {
      polling = false;
      if (!j || !j.ok || !j.job) return;
      // Something is happening — stay attentive for the next minute.
      POLL_BUSY_UNTIL = Date.now() + 60000;
      schedulePoll();
      if (j.job.kind === 'search') return answerSearch(j.job);
      if (j.job.kind === 'capture') return captureQueued(j.job);
    }).catch(function () { polling = false; });
  }

  function answerSearch(job) {
    runSearch(job.q).then(function (r) {
      post({
        token: token(), action: 'searchResults', reader: LOOKUP_READER,
        id: job.id, results: r.results || [], error: r.error || null,
      });
    });
  }

  // A brand whose id was just attached: read its people straight away,
  // which is what makes "pull their people now" true.
  function captureQueued(job) {
    if (brandUlid() !== job.externalId) {
      location.href = profileUrl(job.externalId);
      return;
    }
    setTimeout(function () {
      waitForContacts().then(function (rows) {
        var done = function () {
          post({ token: token(), action: 'captureDone', brandId: job.brandId });
        };
        if (!rows.length) return done();
        post({
          token: token(),
          brandExternalId: job.externalId,
          rows: rows.map(function (r) {
            return { brandName: job.brandName, name: r.name, title: r.title, email: r.email, linkedinUrl: r.linkedinUrl, location: r.location };
          }),
        }).then(done, done);
      });
    }, SETTLE_MS);
  }

  var pill, panel;

  var PANEL_CSS = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;background:#fff;color:#111;border:1px solid #d9d9d6;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.25);padding:14px 16px;font:13px/1.45 system-ui,-apple-system,sans-serif;width:330px';

  function freshPanel() {
    if (panel) panel.remove();
    panel = document.createElement('div');
    panel.style.cssText = PANEL_CSS;
    document.body.appendChild(panel);
    return panel;
  }

  function head(title, closeId) {
    return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
      '<div style="width:22px;height:22px;border-radius:6px;background:#111;color:#fff;font-weight:700;font-size:11px;display:flex;align-items:center;justify-content:center">SB</div>' +
      '<b style="flex:1">' + esc(title) + '</b>' +
      '<span id="' + closeId + '" style="cursor:pointer;color:#999;font-size:16px">×</span></div>';
  }

  // `wake`: {scope, resting} when a run was skipped only because those
  // brands are resting. Resting is a guess, so Leo gets to overrule it
  // from the same panel that told him about it.
  //
  // When brands have no profile saved at all, that is the bigger number
  // and the real work, so it gets the primary button and the resting
  // override drops to secondary. Telling him 193 brands are out of
  // reach and then offering only the 18 is the wrong way round.
  function renderMessage(title, body, noProfile, wake) {
    var p = freshPanel();
    p.innerHTML = head(title, 'sbx') + '<div style="color:#555">' + esc(body) + '</div>' +
      (noProfile ? '<div style="color:#946200;font-size:11.5px;margin-top:8px">' + noProfile +
        ' brand(s) have no saved SponsorUnited profile, so a sweep can\'t reach them. The lookup finds those by searching each name.</div>' +
        '<button id="sbfindnow" style="width:100%;margin-top:10px;background:#111;color:#fff;border:0;border-radius:7px;padding:9px 12px;cursor:pointer;font-weight:600">Find the ' + noProfile + ' missing profiles now</button>' : '') +
      (wake ? '<button id="sbwake" style="width:100%;margin-top:8px;background:#fff;color:#111;border:1px solid #ccc;border-radius:7px;padding:8px 12px;cursor:pointer">Go through the ' +
        wake.resting + ' resting ones anyway</button>' : '');
    p.querySelector('#sbx').onclick = closePanel;
    var fn = p.querySelector('#sbfindnow');
    if (fn) fn.onclick = function () { startMatchSweep({ thenFill: true }); };
    if (wake) {
      p.querySelector('#sbwake').onclick = function () {
        startSweep(wake.scope, { ignoreRest: true });
      };
    }
  }

  function renderJobPanel(job, status) {
    var p = freshPanel();
    var at = job ? job.at : 0;
    var total = job ? job.items.length : 0;
    var added = job ? job.results.reduce(function (n, r) { return n + r.added; }, 0) : 0;
    var pct = total ? Math.round((at / total) * 100) : 0;
    p.innerHTML = head('Capturing all brands', 'sbstopx') +
      '<div style="margin-bottom:6px">' + at + ' of ' + total + ' brands · <b>' + added + '</b> contacts added</div>' +
      '<div style="height:6px;background:#eee;border-radius:99px;overflow:hidden;margin-bottom:8px">' +
        '<div style="height:100%;width:' + pct + '%;background:#111"></div></div>' +
      '<div style="color:#555;font-size:12px;margin-bottom:10px">' + esc(status || '') + '</div>' +
      '<div style="color:#999;font-size:11px;margin-bottom:10px">Leave this tab open. It pauses between brands on purpose.' +
        // Where the rest of the roster went. Without this, "1 of 2" on a
        // 240-brand roster reads as the sweep being lazy.
        (job && job.underCap ? ' ' + job.underCap + ' brands are under 25.' : '') +
        (job && job.resting ? ' ' + job.resting + ' are resting (nothing new last time).' : '') +
        (job && job.noProfile ? ' ' + job.noProfile + ' have no SponsorUnited profile saved, so they cannot be visited until the lookup finds one.' : '') +
      '</div>' +
      '<button id="sbstop" style="background:#fff;color:#b00;border:1px solid #e0c4c4;border-radius:7px;padding:6px 11px;cursor:pointer;font-weight:600">Stop</button>';
    var stop = function () {
      // Stopping a run it started itself also means "not for a while" —
      // otherwise it would be back two minutes later.
      markAuto();
      stopJob();
      renderMessage('Stopped', 'Nothing already captured is undone. Start again any time — it skips brands that now have contacts.', 0);
    };
    p.querySelector('#sbstop').onclick = stop;
    p.querySelector('#sbstopx').onclick = stop;
  }

  function renderDonePanel(done) {
    var p = freshPanel();
    var problems = done.results.filter(function (r) { return r.note; });
    p.innerHTML = head('Sweep finished', 'sbx') +
      '<div style="margin-bottom:8px"><b>' + done.added + '</b> contacts added across ' + done.total + ' brands.</div>' +
      (problems.length
        ? '<div style="font-size:11.5px;color:#946200;max-height:120px;overflow:auto">' +
            problems.slice(0, 20).map(function (r) { return '• ' + esc(r.name) + ' — ' + esc(r.note); }).join('<br>') +
            (problems.length > 20 ? '<br>…and ' + (problems.length - 20) + ' more' : '') +
          '</div>'
        : '<div style="font-size:11.5px;color:#137333">No problems.</div>') +
      // "0 across 1 brand" is only the whole story if nothing is
      // waiting. Usually something is, and the next click is right here
      // rather than back in the menu.
      (done.noProfile
        ? '<div style="margin-top:12px;padding-top:10px;border-top:1px solid #eee">' +
            '<div style="font-size:12.5px;margin-bottom:6px"><b>' + done.noProfile + ' brands</b> have no SponsorUnited profile saved, so this sweep could never reach them. That is the bigger half of the job.</div>' +
            '<button id="sbnext" style="width:100%;background:#111;color:#fff;border:0;border-radius:7px;padding:9px 12px;cursor:pointer;font-weight:600">Find their profiles now</button>' +
          '</div>'
        : '') +
      (!done.noProfile && done.resting && !done.ignoredRest
        ? '<div style="margin-top:12px;padding-top:10px;border-top:1px solid #eee">' +
            '<div style="font-size:12.5px;margin-bottom:6px"><b>' + done.resting + ' brands</b> were skipped because SponsorUnited had nobody new for them last time.</div>' +
            '<button id="sbnextrest" style="width:100%;background:#fff;color:#111;border:1px solid #ccc;border-radius:7px;padding:9px 12px;cursor:pointer">Go through those anyway</button>' +
          '</div>'
        : '') +
      '<div style="color:#999;font-size:11px;margin-top:10px">Anything "held for review" is waiting in Brands → Needs contacts. A brand already holding 25 people is left as it is. A brand with nothing new rests for two weeks before the sweep opens it again.</div>';
    p.querySelector('#sbx').onclick = closePanel;
    var nx = p.querySelector('#sbnext');
    if (nx) nx.onclick = function () { startMatchSweep({ thenFill: true }); };
    var nr = p.querySelector('#sbnextrest');
    if (nr) nr.onclick = function () { startSweep('thin', { ignoreRest: true }); };
  }

  function openMenu() {
    if (!token()) return openSetup();
    var p = freshPanel();
    var here = onBrandPage();
    p.innerHTML = head('SB capture', 'sbx') +
      (here
        ? '<button id="sbone" style="width:100%;background:#111;color:#fff;border:0;border-radius:7px;padding:9px 12px;cursor:pointer;font-weight:600;margin-bottom:8px">Capture this brand</button>'
        : '<div style="color:#555;margin-bottom:8px">Open a brand\'s Contacts tab to capture just that one.</div>') +
      '<button id="sbfill" style="width:100%;background:#111;color:#fff;border:0;border-radius:7px;padding:9px 12px;cursor:pointer;font-weight:600;margin-bottom:2px">Fill every brand to 25 people</button>' +
      '<div style="color:#999;font-size:11px;margin-bottom:10px">Start here. Looks up the brands with no SponsorUnited profile first, then captures. The buttons below each do only one half.</div>' +
      '<div style="color:#999;font-size:11px;margin-bottom:10px">Looks up the brands we have no profile for, then walks every brand under 25 and tops it up. One click, runs on its own.</div>' +
      '<button id="sbmissing" style="width:100%;background:#fff;color:#111;border:1px solid #ccc;border-radius:7px;padding:9px 12px;cursor:pointer;margin-bottom:6px">Capture only (skip the lookup)</button>' +
      '<button id="sbwakeall" style="width:100%;background:#fff;color:#111;border:1px solid #ccc;border-radius:7px;padding:9px 12px;cursor:pointer;margin-bottom:6px">Capture, including resting brands</button>' +
      '<button id="sball" style="width:100%;background:#fff;color:#111;border:1px solid #ccc;border-radius:7px;padding:9px 12px;cursor:pointer;margin-bottom:8px">Refresh every brand</button>' +
      '<button id="sbfind" style="width:100%;background:#fff;color:#111;border:1px solid #ccc;border-radius:7px;padding:9px 12px;cursor:pointer;margin-bottom:6px;font-weight:600">Find profile ids for the rest</button>' +
      '<button id="sbtest" style="width:100%;background:#fff;color:#555;border:1px solid #eee;border-radius:7px;padding:7px 12px;cursor:pointer;margin-bottom:8px;font-size:12px">Test the search on this page</button>' +
      '<div style="color:#999;font-size:11px;margin-bottom:10px">A sweep walks brands one at a time in this tab, pausing between each. Brands without a saved profile can\'t be swept — "Find profile ids" searches for them and attaches the obvious ones.</div>' +
      '<label style="display:flex;gap:7px;align-items:flex-start;font-size:11.5px;color:#555;border-top:1px solid #eee;padding-top:9px;cursor:pointer">' +
        '<input type="checkbox" id="sbauto"' + (autoOn() ? ' checked' : '') + ' style="margin-top:2px">' +
        '<span>Fill by itself when I\'m not using this tab<br><span style="color:#999">Starts after two idle minutes, waits half an hour between runs, and stops the moment you touch the page.</span></span>' +
      '</label>' +
      '<div style="margin-top:8px;display:flex;justify-content:space-between;align-items:center">' +
        '<a href="#" id="sbkey" style="color:#999;font-size:11px">Change the ingest token</a>' +
        '<span id="sbver" style="color:#bbb;font-size:11px">v' + SCRIPT_VERSION + '</span></div>';
    p.querySelector('#sbx').onclick = closePanel;
    if (here) p.querySelector('#sbone').onclick = openPanel;
    // "thin" = under the dashboard's per-brand cap of 25. It used to be
    // "missing" (no contacts at all), which skipped forever any brand
    // whose first capture found two people.
    p.querySelector('#sbfill').onclick = function () { startMatchSweep({ thenFill: true }); };
    p.querySelector('#sbmissing').onclick = function () { startSweep('thin'); };
    p.querySelector('#sbwakeall').onclick = function () { startSweep('thin', { ignoreRest: true }); };
    p.querySelector('#sball').onclick = function () { startSweep('all'); };
    p.querySelector('#sbfind').onclick = function () { startMatchSweep(); };
    p.querySelector('#sbtest').onclick = testSearch;
    p.querySelector('#sbkey').onclick = function () { forgetToken(); openSetup(); };
    p.querySelector('#sbauto').onchange = function () {
      setAuto(this.checked);
      // Turning it on shouldn't hijack the page a moment later; the
      // normal idle wait still applies from here.
      markAuto();
    };
  }

  // Setup. The token is typed here once and kept in this browser, so
  // updating the script never asks for it again. It is a password field
  // and is never printed, logged or shown back.
  function openSetup() {
    var p = freshPanel();
    p.innerHTML = head('Connect to the SB dashboard', 'sbx') +
      '<div style="color:#555;font-size:12px;margin-bottom:10px">Paste the ingest token — the same value as INGEST_TOKEN in Vercel. It stays in this browser and is only ever sent to the dashboard.</div>' +
      '<input id="sbtok" type="password" autocomplete="off" spellcheck="false" placeholder="Ingest token" style="width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #ccc;border-radius:6px;margin-bottom:10px;font:13px system-ui">' +
      '<div style="display:flex;gap:8px;align-items:center">' +
        '<button id="sbtoksave" style="background:#111;color:#fff;border:0;border-radius:7px;padding:7px 12px;cursor:pointer;font-weight:600">Save</button>' +
        '<span id="sbtokmsg" style="font-size:11.5px;flex:1"></span>' +
      '</div>';
    p.querySelector('#sbx').onclick = closePanel;
    var save = function () {
      var v = (p.querySelector('#sbtok').value || '').trim();
      if (!v) { p.querySelector('#sbtokmsg').textContent = 'Paste the token first.'; return; }
      saveToken(v);
      p.querySelector('#sbtokmsg').innerHTML = '<span style="color:#137333">Checking…</span>';
      // Prove it works now rather than failing silently in a sweep.
      post({ token: token(), action: 'searchJob' }).then(function (j) {
        if (j && j.ok) { closePanel(); openMenu(); return; }
        forgetToken();
        p.querySelector('#sbtokmsg').innerHTML = '<span style="color:#b00">' + esc((j && j.error) || 'The dashboard rejected that token.') + '</span>';
      }).catch(function (e) {
        forgetToken();
        p.querySelector('#sbtokmsg').innerHTML = '<span style="color:#b00">' + esc(e.message) + '</span>';
      });
    };
    p.querySelector('#sbtoksave').onclick = save;
    p.querySelector('#sbtok').onkeydown = function (e) { if (e.key === 'Enter') save(); };
  }

  // A dry run: type one name, show what came back, save nothing. If
  // SponsorUnited redesigns their search, this says so in one click
  // instead of a sweep quietly parking two hundred brands.
  function testSearch() {
    ensureSearchInput().then(function (box) {
      if (!box) {
        renderMessage('No search box here',
          'Could not find SponsorUnited\u2019s search bar on this page. ' + describeInputs(), 0);
        return;
      }
      testSearchWith();
    });
  }
  function testSearchWith() {
    var q = prompt('Type a brand name to test the search:', 'Red Bull');
    if (!q) return;
    renderMatchPanel(null, 'Searching ' + q + '…');
    runSearch(q).then(function (r) {
      var rows = r.results || [];
      renderMessage('Search test',
        r.error ? r.error
          : rows.length
            ? 'Found ' + rows.length + ': ' + rows.map(function (x) { return x.name; }).join(' · ')
            : 'The box was found but no brand results were read. ' + describeDropdown(),
        0);
    });
  }

  // When a search reads nothing, say what their dropdown rows are made
  // of, so a screenshot of the test is enough to fix the reader.
  function describeDropdown() {
    var tags = [].slice.call(document.querySelectorAll('body *')).filter(function (el) {
      return !el.children.length && KIND_RX.test((el.textContent || '').trim()) &&
        el.getBoundingClientRect().height > 0 && !(panel && panel.contains(el));
    }).slice(0, 3);
    if (!tags.length) return 'No Brand / Property tags on screen either.';
    return 'Rows seen: ' + tags.map(function (t) {
      var row = t.closest('a, li, [role="option"]') || t.parentElement;
      var link = row.matches('a') ? row : row.querySelector('a');
      return '"' + textLines(row).join(' / ').slice(0, 60) + '" — ' +
        (link ? 'links to ' + (link.getAttribute('href') || 'nowhere') : 'no link (' + row.tagName.toLowerCase() + ')');
    }).join(' · ');
  }

  function ensureUI() {
    if (pill || !document.body) return;
    pill = document.createElement('button');
    // Named so a test can find it without guessing at "the first button".
    pill.id = 'sbpill';
    pill.textContent = 'SB ⬇ Capture contacts';
    pill.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;background:#111;color:#fff;border:0;border-radius:999px;padding:11px 16px;font:600 13px system-ui,-apple-system,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.28);cursor:pointer';
    pill.onclick = openMenu;
    document.body.appendChild(pill);
  }

  function openPanel() {
    var rows = scrapeContacts();
    if (panel) panel.remove();
    panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;background:#fff;color:#111;border:1px solid #d9d9d6;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.25);padding:14px 16px;font:13px/1.45 system-ui,-apple-system,sans-serif;width:330px';

    if (!rows.length) {
      panel.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><div style="width:22px;height:22px;border-radius:6px;background:#111;color:#fff;font-weight:700;font-size:11px;display:flex;align-items:center;justify-content:center">SB</div><b style="flex:1">No contacts found</b><span id="sbx" style="cursor:pointer;color:#999;font-size:16px">×</span></div>' +
        '<div style="color:#555">Open a brand\'s <b>Contacts</b> tab first, then click Capture. If the list is long, scroll down so they all load.</div>' +
        '<div style="color:#999;font-size:11px;margin-top:8px">On this page: ' +
          document.querySelectorAll(LI_SEL).length + ' LinkedIn link(s), ' +
          document.querySelectorAll('a[href^="mailto:"]').length + ' email link(s). ' +
          'If both are 0 you are not on the Contacts tab.</div>';
      document.body.appendChild(panel);
      panel.querySelector('#sbx').onclick = closePanel;
      return;
    }

    var preview = rows.slice(0, 4).map(function (r) {
      return '• ' + esc(r.name) + (r.title ? ' <span style="color:#888">— ' + esc(r.title) + '</span>' : '');
    }).join('<br>');

    panel.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
        '<div style="width:22px;height:22px;border-radius:6px;background:#111;color:#fff;font-weight:700;font-size:11px;display:flex;align-items:center;justify-content:center">SB</div>' +
        '<b style="flex:1">Capture to dashboard</b>' +
        '<span id="sbx" style="cursor:pointer;color:#999;font-size:16px">×</span>' +
      '</div>' +
      '<div style="margin-bottom:8px"><b>' + rows.length + '</b> contact' + (rows.length === 1 ? '' : 's') + ' on this page</div>' +
      '<div style="font-size:11.5px;color:#555;margin-bottom:10px;max-height:74px;overflow:auto">' + preview + (rows.length > 4 ? '<br><span style="color:#aaa">…and ' + (rows.length - 4) + ' more</span>' : '') + '</div>' +
      '<label style="display:block;font-size:11px;color:#888;margin-bottom:3px">Brand name (a name we don\'t have is kept, not lost)</label>' +
      '<input id="sbbrand" value="' + esc(guessBrandName()) + '" style="width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #ccc;border-radius:6px;margin-bottom:10px;font:13px system-ui">' +
      '<div style="display:flex;gap:8px;align-items:center">' +
        '<button id="sbsend" style="background:#111;color:#fff;border:0;border-radius:7px;padding:7px 12px;cursor:pointer;font-weight:600">Send to SB dashboard</button>' +
        '<span id="sbmsg" style="font-size:11.5px;flex:1"></span>' +
      '</div>';
    document.body.appendChild(panel);
    panel.querySelector('#sbx').onclick = closePanel;
    panel.querySelector('#sbsend').onclick = function () { send(rows); };
  }

  function closePanel() { if (panel) { panel.remove(); panel = null; } }

  function send(rows) {
    var brand = (panel.querySelector('#sbbrand').value || '').trim();
    var msg = panel.querySelector('#sbmsg');
    var btn = panel.querySelector('#sbsend');
    if (!brand) { msg.textContent = 'Enter the brand name.'; return; }

    var payload = {
      token: token(),
      brandExternalId: brandUlid(),
      // Leo typed and confirmed this name, so the dashboard makes the
      // brand if it doesn't have it. Only this panel sends the flag —
      // the unattended sweep still parks unknown names for review.
      createIfMissing: true,
      rows: rows.map(function (r) {
        return { brandName: brand, name: r.name, title: r.title, email: r.email, linkedinUrl: r.linkedinUrl, location: r.location };
      })
    };

    btn.disabled = true; btn.textContent = 'Sending…'; msg.textContent = '';
    fetch(INGEST_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        btn.disabled = false; btn.textContent = 'Send to SB dashboard';
        if (j.ok && (!j.brandsMissing || !j.brandsMissing.length)) {
          var made = (j.brandsCreated && j.brandsCreated.length)
            ? ' <b>New brand created.</b>' : '';
          var cap = j.capped ? ' ' + j.capped + ' over the 25 cap.' : '';
          msg.innerHTML = '<span style="color:#137333">Done — ' + j.contactsCreated + ' added, ' +
            j.skipped + ' already there.' + cap + made + '</span>';
        } else if (j.ok) {
          // Shouldn't happen from this panel any more (the dashboard
          // creates the brand), so say what actually went wrong.
          msg.innerHTML = '<span style="color:#946200">Couldn\'t file these under "' + esc(brand) +
            '". Open <b>Brands → Needs contacts</b> — they\'re parked there, not lost.</span>';
        } else {
          msg.innerHTML = '<span style="color:#b00">' + esc(j.error || 'Failed') + '</span>';
        }
      })
      .catch(function (e) {
        btn.disabled = false; btn.textContent = 'Send to SB dashboard';
        msg.innerHTML = '<span style="color:#b00">' + esc(e.message) + '</span>';
      });
  }

  var resumed = false;
  function tick() {
    if (!document.body) return;
    ensureUI();
    // The pill is always available now: a sweep can be started from any
    // SponsorUnited page, not only a brand profile.
    if (pill) pill.style.display = 'block';
    // A navigation tore the script down mid-sweep — pick the job back up
    // exactly once per page load.
    if (!resumed) {
      resumed = true;
      if (loadJob()) setTimeout(runStep, 1200);
      else {
        var mj = loadMatch();
        // Parked before navigating to the search: start the lookup here.
        if (mj && mj.pending) {
          saveMatch(null);
          var want = { thenFill: mj.fill, auto: mj.auto };
          setTimeout(function () { startMatchSweep(want); }, 1500);
        }
        // A lookup run in progress — the page moved under it (a result
        // click, a back button) but the worklist survives, so pick it up.
        else if (mj) setTimeout(matchStep, 1500);
      }
    }
  }
  tick();
  setInterval(tick, 1500);
  // Answer whatever the dashboard is waiting on, quietly, and only
  // while nothing else is walking pages.
  setTimeout(function () { pollJobs(); schedulePoll(); }, 1500);
  // The by-itself fill. Checked on a slow timer of its own: the guards
  // inside decide whether this is a moment to start, and almost always
  // the answer is no.
  setInterval(maybeAutoFill, 20000);
})();
