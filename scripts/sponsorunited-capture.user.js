// ==UserScript==
// @name         SB Dashboard — SponsorUnited Contact Capture
// @namespace    sbagency.command-center
// @version      3.2
// @description  Capture contacts from SponsorUnited into the SB Command Center, and find the profile ids of brands we cannot reach yet.
// @match        https://pro.sponsorunited.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

// -------------------------------------------------------------------
// This is the capture button Leo runs in Tampermonkey. It lives here so
// it survives a cleared browser or a new laptop — the copy in the
// browser is the one that runs, this one is the backup and the record.
//
// TO INSTALL: Tampermonkey → Dashboard → + (new script) → paste this in
// → put the real INGEST_TOKEN on the line below → save.
//
// The token is deliberately NOT in this file. It's the same value as
// INGEST_TOKEN in Vercel. Anyone holding it can write contacts into the
// dashboard, so it never goes in the repo, in a screenshot or in chat.
// -------------------------------------------------------------------

(function () {
  'use strict';

  var INGEST_URL   = 'https://sb-digitaldashboard.vercel.app/api/ingest';
  var INGEST_TOKEN = 'PASTE_INGEST_TOKEN_HERE';

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

  function runStep() {
    var job = loadJob();
    if (!job || job.paused) return;
    var item = job.items[job.at];
    if (!item) { finishJob(job); return; }

    // Not on this brand's page yet — go there; the script restarts on
    // load and lands back here with the page it needs.
    if (brandUlid() !== item.externalId) {
      renderJobPanel(job, 'Opening ' + item.name + '…');
      location.href = profileUrl(item.externalId);
      return;
    }

    renderJobPanel(job, 'Reading ' + item.name + '…');
    setTimeout(function () {
      waitForContacts().then(function (rows) {
        if (!rows.length) {
          job.results.push({ name: item.name, added: 0, note: 'no contacts listed' });
          return next(job);
        }
        return post({
          token: INGEST_TOKEN,
          brandExternalId: item.externalId,
          rows: rows.map(function (r) {
            return { brandName: item.suName || item.name, name: r.name, title: r.title, email: r.email, linkedinUrl: r.linkedinUrl, location: r.location };
          }),
        }).then(function (j) {
          job.results.push({
            name: item.name,
            added: (j && j.contactsCreated) || 0,
            note: !j || !j.ok ? ((j && j.error) || 'failed')
              : (j.brandsMissing && j.brandsMissing.length) ? 'held for review'
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
    var done = { finishedAt: Date.now(), added: added, results: job.results, total: job.items.length };
    stopJob();
    try { localStorage.setItem('sbCaptureLast', JSON.stringify(done)); } catch (e) {}
    renderDonePanel(done);
  }

  function startSweep(scope) {
    renderJobPanel(null, 'Asking the dashboard what to capture…');
    post({ token: INGEST_TOKEN, action: 'list', scope: scope, limit: 200 }).then(function (j) {
      if (!j || !j.ok) throw new Error((j && j.error) || 'Could not get the list');
      if (!j.brands.length) {
        renderMessage('Nothing to sweep',
          scope !== 'all'
            ? 'Every brand whose SponsorUnited profile we know is already at 25 people.'
            : 'No brands have a saved SponsorUnited profile yet.',
          j.noProfile);
        return;
      }
      var job = { scope: scope, items: j.brands, at: 0, results: [], noProfile: j.noProfile, startedAt: Date.now() };
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
    var inputs = [].slice.call(document.querySelectorAll('input[type="search"], input[type="text"], input:not([type])'));
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var r = el.getBoundingClientRect();
      if (r.width < 120 || r.height < 14) continue;          // too small to be it
      if (r.top > 260) continue;                              // not in the banner
      if (el.closest('[aria-hidden="true"]')) continue;
      var hint = ((el.getAttribute('placeholder') || '') + ' ' +
                  (el.getAttribute('aria-label') || '') + ' ' +
                  (el.getAttribute('name') || '')).toLowerCase();
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

  // Every profile link currently on the page, newest render wins.
  // Deduped by id, because a result often links its logo and its name.
  function readResultLinks() {
    var seen = {};
    var out = [];
    var links = [].slice.call(document.querySelectorAll('a[href*="/profile/"]'));
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href') || '';
      var m = href.match(/\/profile\/([^\/?#]+)/);
      if (!m) continue;
      var id = m[1];
      var label = (links[i].textContent || '').replace(/\s+/g, ' ').trim();
      if (!label) {
        // A logo link: borrow the name from its row.
        var row = links[i].closest('li, tr, [role="option"], div');
        label = row ? (row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
      }
      if (!label) continue;
      if (seen[id]) continue;
      seen[id] = 1;
      out.push({ externalId: id, name: label });
      if (out.length >= 8) break;
    }
    return out;
  }

  // Type a name and wait for the results to change. Resolves with
  // whatever was on screen when it settled — judging them is the
  // server's job, not this script's.
  function runSearch(query) {
    return new Promise(function (resolve) {
      var box = findSearchInput();
      if (!box) return resolve({ error: 'Could not find the search box on this page' });
      var before = readResultLinks().map(function (r) { return r.externalId; }).join(',');
      box.focus();
      typeInto(box, query);
      var started = Date.now();
      setTimeout(function look() {
        var now = readResultLinks();
        var key = now.map(function (r) { return r.externalId; }).join(',');
        if (now.length && key !== before) return resolve({ results: now });
        if (Date.now() - started > SEARCH_WAIT_MS) {
          return resolve({ results: now, note: now.length ? 'unchanged' : 'no results' });
        }
        setTimeout(look, 300);
      }, SEARCH_SETTLE_MS);
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
  function startMatchSweep(opts) {
    var thenFill = !!(opts && opts.thenFill);
    if (!findSearchInput()) {
      renderMessage('No search box here',
        'This page has no SponsorUnited search bar. Open their home or Discovery page and try again.', 0);
      return;
    }
    renderMatchPanel(null, 'Asking the dashboard which brands are missing a profile…');
    post({ token: INGEST_TOKEN, action: 'needProfile', limit: 300 }).then(function (j) {
      if (!j || !j.ok) throw new Error((j && j.error) || 'Could not get the list');
      if (!j.items.length) {
        saveMatch(null);
        if (thenFill) { startSweep('thin'); return; }
        renderMessage('Nothing to look up', 'Every brand already has a SponsorUnited profile saved.', 0);
        return;
      }
      var job = { items: j.items, at: 0, attached: 0, parked: 0, failed: 0, fill: thenFill, startedAt: Date.now() };
      saveMatch(job);
      matchStep();
    }).catch(function (e) { saveMatch(null); renderMessage('Could not start', e.message, 0); });
  }

  function matchStep() {
    var job = loadMatch();
    if (!job) return;
    var item = job.items[job.at];
    if (!item) {
      var fill = job.fill;
      var found = job.attached;
      saveMatch(null);
      if (fill) {
        // Straight on to the capture half: the ids we just attached are
        // useless until somebody walks those profiles.
        renderMessage('Found ' + found + ' more profiles — now filling contacts…',
          'Leave this tab open. Anything that needed your eye is waiting in the dashboard under Brands.', 0);
        setTimeout(function () { startSweep('thin'); }, 1500);
        return;
      }
      renderMessage('Finished looking up profiles',
        job.attached + ' attached · ' + job.parked + ' need your eye · ' + job.failed + ' failed. ' +
        'The ones needing your eye are in the dashboard under Brands.', 0);
      return;
    }
    renderMatchPanel(job, 'Searching ' + item.name + '…');
    runSearch(item.name).then(function (r) {
      if (r.error) { job.failed += 1; return nextMatch(job); }
      return post({
        token: INGEST_TOKEN, action: 'matched',
        brandId: item.brandId, candidates: r.results || [],
      }).then(function (res) {
        if (res && res.outcome === 'attached') job.attached += 1;
        else if (res && res.ok) job.parked += 1;
        else job.failed += 1;
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
            job.attached + ' attached · ' + job.parked + ' for review</div>' +
          '<button id="sbmstop" style="width:100%;margin-top:10px;background:#fff;color:#111;border:1px solid #ccc;border-radius:7px;padding:8px 12px;cursor:pointer">Stop</button>'
        : '');
    var x = p.querySelector('#sbmx');
    if (x) x.onclick = closePanel;
    var stop = p.querySelector('#sbmstop');
    if (stop) stop.onclick = function () { saveMatch(null); closePanel(); };
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
    if (polling || loadJob() || loadMatch()) return;
    polling = true;
    post({ token: INGEST_TOKEN, action: 'searchJob' }).then(function (j) {
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
        token: INGEST_TOKEN, action: 'searchResults',
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
          post({ token: INGEST_TOKEN, action: 'captureDone', brandId: job.brandId });
        };
        if (!rows.length) return done();
        post({
          token: INGEST_TOKEN,
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

  function renderMessage(title, body, noProfile) {
    var p = freshPanel();
    p.innerHTML = head(title, 'sbx') + '<div style="color:#555">' + esc(body) + '</div>' +
      (noProfile ? '<div style="color:#946200;font-size:11.5px;margin-top:8px">' + noProfile +
        ' brand(s) have no saved SponsorUnited profile, so a sweep can\'t reach them. Capture one by hand, or paste its profile link on the brand\'s row in Needs contacts, and the sweep picks it up next time.</div>' : '');
    p.querySelector('#sbx').onclick = closePanel;
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
      '<div style="color:#999;font-size:11px;margin-bottom:10px">Leave this tab open. It pauses between brands on purpose.</div>' +
      '<button id="sbstop" style="background:#fff;color:#b00;border:1px solid #e0c4c4;border-radius:7px;padding:6px 11px;cursor:pointer;font-weight:600">Stop</button>';
    var stop = function () { stopJob(); renderMessage('Stopped', 'Nothing already captured is undone. Start again any time — it skips brands that now have contacts.', 0); };
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
      '<div style="color:#999;font-size:11px;margin-top:10px">Anything "held for review" is waiting in Brands → Needs contacts. A brand already holding 25 people is left as it is.</div>';
    p.querySelector('#sbx').onclick = closePanel;
  }

  function openMenu() {
    var p = freshPanel();
    var here = onBrandPage();
    p.innerHTML = head('SB capture', 'sbx') +
      (here
        ? '<button id="sbone" style="width:100%;background:#111;color:#fff;border:0;border-radius:7px;padding:9px 12px;cursor:pointer;font-weight:600;margin-bottom:8px">Capture this brand</button>'
        : '<div style="color:#555;margin-bottom:8px">Open a brand\'s Contacts tab to capture just that one.</div>') +
      '<button id="sbfill" style="width:100%;background:#111;color:#fff;border:0;border-radius:7px;padding:9px 12px;cursor:pointer;font-weight:600;margin-bottom:6px">Fill every brand to 25 people</button>' +
      '<div style="color:#999;font-size:11px;margin-bottom:10px">Looks up the brands we have no profile for, then walks every brand under 25 and tops it up. One click, runs on its own.</div>' +
      '<button id="sbmissing" style="width:100%;background:#fff;color:#111;border:1px solid #ccc;border-radius:7px;padding:9px 12px;cursor:pointer;margin-bottom:6px">Capture only (skip the lookup)</button>' +
      '<button id="sball" style="width:100%;background:#fff;color:#111;border:1px solid #ccc;border-radius:7px;padding:9px 12px;cursor:pointer;margin-bottom:8px">Refresh every brand</button>' +
      '<button id="sbfind" style="width:100%;background:#fff;color:#111;border:1px solid #ccc;border-radius:7px;padding:9px 12px;cursor:pointer;margin-bottom:6px;font-weight:600">Find profile ids for the rest</button>' +
      '<button id="sbtest" style="width:100%;background:#fff;color:#555;border:1px solid #eee;border-radius:7px;padding:7px 12px;cursor:pointer;margin-bottom:8px;font-size:12px">Test the search on this page</button>' +
      '<div style="color:#999;font-size:11px">A sweep walks brands one at a time in this tab, pausing between each. Brands without a saved profile can\'t be swept — "Find profile ids" searches for them and attaches the obvious ones.</div>';
    p.querySelector('#sbx').onclick = closePanel;
    if (here) p.querySelector('#sbone').onclick = openPanel;
    // "thin" = under the dashboard's per-brand cap of 25. It used to be
    // "missing" (no contacts at all), which skipped forever any brand
    // whose first capture found two people.
    p.querySelector('#sbfill').onclick = function () { startMatchSweep({ thenFill: true }); };
    p.querySelector('#sbmissing').onclick = function () { startSweep('thin'); };
    p.querySelector('#sball').onclick = function () { startSweep('all'); };
    p.querySelector('#sbfind').onclick = function () { startMatchSweep(); };
    p.querySelector('#sbtest').onclick = testSearch;
  }

  // A dry run: type one name, show what came back, save nothing. If
  // SponsorUnited redesigns their search, this says so in one click
  // instead of a sweep quietly parking two hundred brands.
  function testSearch() {
    if (!findSearchInput()) {
      renderMessage('No search box here',
        'This page has no SponsorUnited search bar. Open their home or Discovery page and try again.', 0);
      return;
    }
    var q = prompt('Type a brand name to test the search:', 'Red Bull');
    if (!q) return;
    renderMatchPanel(null, 'Searching ' + q + '…');
    runSearch(q).then(function (r) {
      var rows = r.results || [];
      renderMessage('Search test',
        r.error ? r.error
          : rows.length
            ? 'Found ' + rows.length + ': ' + rows.map(function (x) { return x.name; }).join(' · ')
            : 'The box was found but no results appeared. Their layout may have changed.',
        0);
    });
  }

  function ensureUI() {
    if (pill || !document.body) return;
    pill = document.createElement('button');
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
      token: INGEST_TOKEN,
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
        // A lookup run in progress — the page moved under it (a result
        // click, a back button) but the worklist survives, so pick it up.
        if (mj) setTimeout(matchStep, 1500);
      }
    }
  }
  tick();
  setInterval(tick, 1500);
  // Answer whatever the dashboard is waiting on, quietly, and only
  // while nothing else is walking pages.
  setTimeout(function () { pollJobs(); schedulePoll(); }, 1500);
})();
