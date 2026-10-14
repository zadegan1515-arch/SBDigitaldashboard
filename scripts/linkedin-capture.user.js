// ==UserScript==
// @name         SB Dashboard — LinkedIn People Capture
// @namespace    sbagency.command-center
// @version      1.38
// @description  Send brands' marketing and partnership people from LinkedIn to the SB Command Center — one People page at a time, or a slow run through every brand.
// @match        https://www.linkedin.com/*
// @match        https://linkedin.com/*
// @run-at       document-start
// @noframes
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
// Leo's account that hears about it. Zach's browser gets only
// linkedin-log.user.js, which logs an invite or an accept from someone's
// profile and nothing else.
//
// Two ways to use it. By hand: open a People page, press the pill, see
// who it found, save when you say so; a brand the dashboard doesn't have
// can be added from the same panel. By itself ("Fill brands by itself"):
// a slow run through every brand under 25, ~50 a day, which can also add
// new brands LinkedIn shows (lookalikes, keyword searches) and pauses the
// moment LinkedIn shows a check — see "filling brands by itself" below.
// With Sales Navigator on the account (1.31), the run takes each brand's
// marketing / partnerships people from Sales Navigator's lead search,
// which names people the People tab hides — see "Sales Navigator".
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

  // Top page only. LinkedIn pages carry same-origin frames, and a copy of
  // the script in each one shared the tab's run: two readers worked the
  // same brand and one found it already finished ("Cannot read properties
  // of null (reading 'seen')", Sep 2026). @noframes says the same to
  // Tampermonkey; this holds even where that's ignored.
  if (window.top !== window.self) return;

  // The dashboard's "Start the LinkedIn fill" opens LinkedIn at #sb-fill.
  // LinkedIn tidies its own address while it loads and the mark was gone
  // by the time a page-ready script looked (Leo: the button started
  // nothing). So the script runs at document-start just to catch it,
  // and everything else waits for the page (whenReady, at the bottom).
  var AUTO_FILL = /^#sb-fill\b/.test(location.hash);
  if (AUTO_FILL) {
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
  }

  var INGEST_URL = 'https://sb-digitaldashboard.vercel.app/api/ingest';
  var DASH_URL = 'https://sb-digitaldashboard.vercel.app/app.html';
  // = @downloadURL: opening it brings up Tampermonkey's update page.
  var DOWNLOAD_URL = 'https://raw.githubusercontent.com/zadegan1515-arch/SBDigitaldashboard/main/scripts/linkedin-capture.user.js';
  var TOKEN_KEY = 'sbIngestToken';
  var VERSION = '1.38';
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
    return meReady().then(function (me) { return send(Object.assign(me ? { me: me } : {}, payload)); });
  }
  function send(payload) {
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
          if (!j) return reject(canRetry(new Error('The dashboard answered ' + r.status + '.')));
          // Another LinkedIn account than the one the fill runs on.
          if (j.notOwner) return reject(new Error(j.error));
          if (j.latest) noteLatest(j.latest);
          // The server's own failure (a database hiccup): the run tries again.
          if (r.status >= 500 && !j.ok) j.serverError = r.status;
          resolve(j);
        },
        onerror: function () { reject(canRetry(new Error('Could not reach the dashboard.'))); },
        ontimeout: function () { reject(canRetry(new Error('The dashboard took too long to answer.'))); },
      });
    });
  }
  function canRetry(e) { e.retry = true; return e; }

  // The run's calls ride out a dashboard that's down for a few minutes (a
  // deploy, a slow start, the network) before the run pauses (Leo, Oct 14
  // 2026) — about four minutes in all. Never a token or account refusal,
  // and never LinkedIn's own stops: those answer at once.
  var DASH_RETRY_MS = [5000, 15000, 30000, 60000, 60000, 60000];
  function runPost(payload) {
    var i = 0;
    function again(why) {
      var ms = DASH_RETRY_MS[i++];
      setFillStatus(why + ' Trying again in ' + Math.round(ms / 1000) + ' s…');
      return wait(ms).then(attempt);
    }
    function attempt() {
      return post(payload).then(function (j) {
        if (j && j.serverError && i < DASH_RETRY_MS.length) return again('The dashboard answered ' + j.serverError + '.');
        return j;
      }, function (e) {
        if (e && e.retry && i < DASH_RETRY_MS.length) return again(e.message);
        throw e;
      });
    }
    return attempt();
  }

  // ---- whose LinkedIn this is ----
  //
  // The fill runs on Leo's LinkedIn only (his call, Sep 2026). Every call
  // says who's signed in; the dashboard remembers the first account and
  // refuses any other before anything is read or saved. Asked of LinkedIn
  // the way its own pages ask (/voyager/api/me, once per half hour per
  // tab), else read off the header's photo. Not knowing never blocks.
  var ME_KEY = 'sbLiMe';
  var mePromise = null;
  function findMember(o, depth) {
    if (!o || typeof o !== 'object' || depth > 6) return null;
    if (typeof o.publicIdentifier === 'string') {
      return { slug: o.publicIdentifier, name: [o.firstName, o.lastName].filter(function (x) { return typeof x === 'string'; }).join(' ') || null };
    }
    var keys = Object.keys(o);
    for (var i = 0; i < keys.length; i++) {
      var hit = findMember(o[keys[i]], depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  function meFromPage() {
    var img = document.querySelector('img.global-nav__me-photo[alt], .global-nav__me img[alt]');
    var name = img ? String(img.getAttribute('alt') || '').replace(/\s+/g, ' ').trim() : '';
    return name && !/^(me|photo|profile)/i.test(name) ? { slug: null, name: name } : null;
  }
  function whoAmI() {
    try {
      var c = JSON.parse(sessionStorage.getItem(ME_KEY) || 'null');
      if (c && Date.now() - c.at < 30 * 60000) return Promise.resolve(c.me);
    } catch (e) {}
    var m = document.cookie.match(/JSESSIONID="?([^";]+)"?/);
    var ask = m && typeof fetch === 'function'
      ? fetch('/voyager/api/me', { credentials: 'include', headers: { 'csrf-token': m[1], accept: 'application/json' } })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) { return j ? findMember(j, 0) : null; })
          .catch(function () { return null; })
      : Promise.resolve(null);
    var timeout = new Promise(function (res) { setTimeout(function () { res(null); }, 6000); });
    return Promise.race([ask, timeout]).then(function (me) {
      me = me || meFromPage();
      if (me) { try { sessionStorage.setItem(ME_KEY, JSON.stringify({ me: me, at: Date.now() })); } catch (e) {} }
      return me;
    });
  }
  function meReady() {
    if (!mePromise) mePromise = whoAmI().catch(function () { return null; });
    return mePromise;
  }

  // ---- updates ----
  //
  // Tampermonkey fetches a new copy of this script about once a day.
  // The dashboard's replies say which version is current, so a copy that
  // is behind knows at once: the pill turns orange and every panel offers
  // the update (Tampermonkey's own update page — one click). A run keeps
  // going meanwhile; the new copy takes over at its next page.
  var LATEST_KEY = 'sbLiLatest';
  function newer(a, b) {
    var x = String(a || '').split('.'), y = String(b || '').split('.');
    for (var i = 0; i < Math.max(x.length, y.length); i++) {
      var p = Number(x[i]) || 0, q = Number(y[i]) || 0;
      if (p !== q) return p > q;
    }
    return false;
  }
  function latest() {
    try { var l = GM_getValue(LATEST_KEY, null); return l && l.v ? l : null; } catch (e) { return null; }
  }
  function behind() { var l = latest(); return !!l && newer(l.v, VERSION); }
  function noteLatest(v) {
    if (typeof v !== 'string' || !/^\d+(\.\d+)*$/.test(v)) return;
    try { GM_setValue(LATEST_KEY, { v: v, at: Date.now() }); } catch (e) {}
    paintPill();
  }
  // Asked at most every 6 hours; any other reply refreshes it for free.
  function checkLatest() {
    var l = latest();
    if (!HAS_GM || !token() || (l && Date.now() - l.at < 6 * 3600000)) return;
    post({ action: 'liVersion' }).catch(function () {});
  }
  function updateLine() {
    if (!behind()) return null;
    return h('div', { id: 'sbliupdate', style: 'margin:0 0 10px;padding:8px 10px;border-radius:8px;background:#fff4e5;color:#7a4b00;font-size:12px' }, [
      'Version ' + latest().v + ' is out (this is ' + VERSION + '). ',
      h('a', { href: DOWNLOAD_URL, target: '_blank', rel: 'noopener', style: 'color:#7a4b00;font-weight:600;text-decoration:underline', text: 'Update now ↗' }),
      ' — press Update on the page that opens.',
    ]);
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

  // ---- one profile (Leo, Oct 2026: "why can't I just add from this") --
  //
  // On someone's own profile page the pill adds that one person to their
  // brand's LinkedIn queue — the same preview → Add as a People page, one
  // row. It logs no invite: that stays the SB · Log pill / Zach's list.
  // The reader is the SB · Log script's (linkedin-log.user.js).
  function profilePath() {
    var m = location.pathname.match(/^\/in\/([^\/?#]+)\/?$/);
    return m ? m[1] : null;
  }
  var PROFILE_NOISE = /^(verified|contact info|hiring|provides services|premium|\d[\d,]*\+?\s+(connections|followers))$|^(she|he|they)\s*\/\s*(her|him|them)$/i;
  var EMPLOYMENT = /^(.+?)\s[·•]\s(?:full-time|part-time|contract|self-employed|freelance|internship|seasonal|apprenticeship)\b/i;
  function companyLink(a) {
    return a && /\/company\//.test(a.href) ? a.href : '';
  }
  function currentCompany(headline) {
    var cur = document.querySelector('[aria-label^="Current company"]');
    if (cur && !skipZone(cur)) {
      var al = cur.getAttribute('aria-label') || '';
      var m = al.match(/^Current company:\s*(.+?)(?:\.\s*Click\b.*)?$/i);
      var name = (m ? m[1] : (lines(cur)[0] || '')).trim();
      var a = cur.closest('a[href*="/company/"]') || cur.querySelector('a[href*="/company/"]');
      if (name) return { name: name.slice(0, 120), url: companyLink(a) };
    }
    var anchor = document.getElementById('experience');
    var sec = anchor ? (anchor.closest('section') || anchor.parentElement) : null;
    if (sec) {
      var logo = sec.querySelector('a[href*="/company/"] img[alt]');
      var alt = logo ? String(logo.getAttribute('alt') || '').replace(/\s*logo\s*$/i, '').trim() : '';
      if (alt) return { name: alt.slice(0, 120), url: companyLink(logo.closest('a')) };
      var links = [].slice.call(sec.querySelectorAll('a[href*="/company/"]'));
      for (var i = 0; i < links.length; i++) {
        var ls = lines(links[i]);
        for (var k = 0; k < ls.length; k++) {
          var em = ls[k].match(EMPLOYMENT);
          if (em) return { name: em[1].trim().slice(0, 120), url: companyLink(links[i]) };
        }
      }
    }
    var hm = String(headline || '').match(/\s(?:at|@)\s+([^|•·,]+)/i);
    return { name: hm ? hm[1].trim().slice(0, 120) : '', url: '' };
  }
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
      for (var j = at + 1; j < all.length && !headline; j++) {
        var l = personName(all[j]);
        if (l && l !== name && !PROFILE_NOISE.test(l) && !NOISE.test(l)) headline = l;
      }
    }
    return { name: name.slice(0, 80), headline: headline.slice(0, 300), slug: slug, company: currentCompany(headline) };
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

  // "LinkedIn Member" cards: people outside Leo's network, whose name and
  // profile LinkedIn hides. Nothing to save — but the card still shows
  // their headline, so each one comes back as that line ('' when there is
  // none). The fill sends them with the brand's visit and the dashboard
  // puts brands whose hidden people look like buyers on "Read on Zach's
  // LinkedIn": Zach's network is bigger, his account sees them by name.
  function memberLeaves(root) {
    return [].slice.call(root.querySelectorAll('*')).filter(function (el) {
      return !el.children.length && /^linkedin member$/i.test(String(el.textContent || '').trim());
    });
  }
  function memberCardFor(el) {
    var li = el.closest('li');
    if (li && !skipZone(li) && !profileLinks(li).length && memberLeaves(li).length === 1) return li;
    // No list item of its own: walk up until a headline shows, never into
    // a box that holds a real person or another hidden one.
    var c = el.parentElement || el;
    while (!lines(c).length && c.parentElement && c.parentElement !== document.body &&
      !profileLinks(c.parentElement).length && memberLeaves(c.parentElement).length <= 1) c = c.parentElement;
    return c;
  }
  function hiddenCards() {
    var cards = [];
    [].slice.call(document.querySelectorAll('main *')).forEach(function (el) {
      if (el.children.length || skipZone(el)) return;
      if (!/^linkedin member$/i.test(String(el.textContent || '').trim())) return;
      var c = memberCardFor(el);
      if (cards.indexOf(c) < 0) cards.push(c);
    });
    return cards.map(function (c) {
      var sub = c.querySelector('.artdeco-entity-lockup__subtitle');
      if (sub) return personName(lines(sub).join(' ')).slice(0, 160);
      // "LinkedIn Member • 3rd+" on one line is the name, not the headline.
      var ls = lines(c).map(personName).filter(function (x) { return x && !/^linkedin member$/i.test(x); });
      return (ls[0] || '').slice(0, 160);
    });
  }
  function hiddenMembers() { return hiddenCards().length; }
  // Hidden people across a brand's views, each counted once: with no name
  // to go on, a headline counts as many times as one view showed it (the
  // server merges the same way, li-hidden.ts).
  function hiddenTotal(views) {
    var most = {}, blanks = 0;
    (views || []).forEach(function (v) {
      var here = {}, b0 = 0;
      (v.heads || []).forEach(function (hd) {
        var k = String(hd || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        if (!k) b0++; else here[k] = (here[k] || 0) + 1;
      });
      Object.keys(here).forEach(function (k) { most[k] = Math.max(most[k] || 0, here[k]); });
      blanks = Math.max(blanks, b0);
    });
    return Object.keys(most).reduce(function (n, k) { return n + most[k]; }, blanks);
  }
  // Everyone the list shows, hidden or not: a list of mostly "LinkedIn
  // Member" cards still grows as it scrolls.
  function listed() { return count() + hiddenMembers(); }

  // When the reader looks broken on a page — the ways it has gone wrong
  // on LinkedIn's real pages: people on screen and none made out, or
  // everyone's title blank or the same (the "• 3rd+" badge read as the
  // title, Sep 2026). The run reports it with a sample of the cards.
  function readingProblem(rows) {
    var shown = count();
    if (!rows.length) return shown >= 3 ? 'LinkedIn showed ' + shown + ' people but the reader made out none' : null;
    if (rows.length < 3) return null;
    var heads = rows.map(function (r) { return String(r.headline || '').trim().toLowerCase(); });
    if (heads.every(function (x) { return !x; })) return 'every title came out blank (' + rows.length + ' people)';
    if (heads.every(function (x) { return x === heads[0]; })) return 'every title came out the same: “' + String(rows[0].headline).slice(0, 40) + '”';
    var badged = rows.filter(function (r) { return /[·•]|\b(1st|2nd|3rd)\b/.test(r.name); }).length;
    if (badged * 2 >= rows.length) return 'names came out with LinkedIn\'s badge on them';
    return null;
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
  function expand(onProgress, halt, limits) {
    var maxRounds = (limits && limits.rounds) || MAX_ROUNDS, maxPeople = (limits && limits.people) || MAX_PEOPLE;
    return new Promise(function (resolve) {
      // Growth is judged on everyone listed (a list of mostly hidden cards
      // still grows); the people cap on the readable ones, as before.
      var rounds = 0, still = 0, last = listed();
      function step() {
        if (halt.stopped) return resolve({ capped: false });
        if (rounds >= maxRounds || count() >= maxPeople) return resolve({ capped: true });
        rounds++;
        // Both, because LinkedIn has moved which element scrolls before.
        var links = profileLinks();
        if (links.length) links[links.length - 1].scrollIntoView({ block: 'end' });
        window.scrollTo(0, document.body.scrollHeight);
        wait(rand(900, 1600)).then(function () {
          if (halt.stopped) return;
          var more = moreButton();
          if (more) more.click();
          return wait(more ? rand(1300, 2200) : rand(500, 900));
        }).then(function () {
          var n = listed();
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
    var up = updateLine();
    if (up) kids = kids.slice(0, 1).concat([up], kids.slice(1));
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
    if (profilePath()) return readOneProfile();
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
    var profile = /^\/in\//.test(location.pathname);
    freshPanel([
      head('SB LinkedIn capture'),
      // Logging someone you invited is the SB Log script's job (Zach's
      // browser); from anywhere, Zach's list takes their link.
      profile
        ? h('div', { style: MUTED }, ['Logging someone you invited? That\'s the ', b('SB · Log'), ' pill (Zach\'s browser), or paste their link into ', b('Zach\'s list → + Add from LinkedIn'), '.'])
        : null,
      search
        ? h('div', { style: MUTED }, ['Click the brand\'s company in these results, then its ', b('People'), ' tab, then this pill again.'])
        : h('div', { style: MUTED }, ['This works on a brand\'s ', b('company page'), ' on LinkedIn. The easy way in: the dashboard\'s ', b('Under 25'), ' list, then ', b('People ↗'), ' on a brand.']),
      h('a', { href: DASH_URL + '#people', target: '_blank', rel: 'noopener', style: BTN2, text: 'Open the Under 25 list ↗' }),
      h('button', { id: 'sblifillopen', style: BTN + ';margin-top:6px', text: 'Fill brands by itself…', onclick: openFillSetup }),
      tokenLink(),
    ]);
  }

  // One button: Send to dashboard. Their current company is the brand
  // (made if the dashboard lacks it); Leo picked them, so the buyer-title
  // filter doesn't apply (handPicked). Joins the LinkedIn queue — no
  // invite is logged.
  function readOneProfile() {
    var p = readProfile();
    if (!p.name) return openElsewhere();
    var box = h('input', {
      id: 'sbliprofbrand', value: p.company.name, placeholder: 'Their company (dashboard brand)',
      style: 'display:block;box-sizing:border-box;width:100%;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font:12.5px system-ui;color:#111;background:#fff;margin:4px 0 10px',
    });
    var btn = h('button', { id: 'sblisend', style: BTN, text: 'Send to dashboard' });
    btn.onclick = guard(function () { sendProfile(p, box.value.trim(), btn); });
    box.onkeydown = function (e) { if (e.key === 'Enter') btn.click(); };
    freshPanel([
      head(p.name),
      p.headline ? h('div', { style: MUTED, text: p.headline }) : null,
      h('div', { style: 'font-size:12px;color:#555', text: 'Brand' }),
      box,
      btn,
      h('div', { style: SMALL, text: 'Adds them to the brand\'s LinkedIn queue. Logging an invite is the SB · Log pill / Zach\'s list.' }),
      tokenLink(),
    ]);
  }

  function sendProfile(p, brand, btn) {
    if (!brand) return showError('Type their company first.');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    var sameCo = brand.toLowerCase() === String(p.company.name || '').toLowerCase();
    return post({
      action: 'liCapture',
      handPicked: true,
      createIfMissing: true,
      companyName: brand,
      // Their company's page, only when it is the brand being sent to:
      // the brand may save it as its LinkedIn page.
      companyUrl: sameCo ? p.company.url : '',
      brandName: brand,
      rows: [{ name: p.name, headline: p.headline, linkedinUrl: 'https://www.linkedin.com/in/' + p.slug + '/' }],
    }).then(function (j) {
      if (!j || !j.ok) return showError((j && j.error) || 'Nothing was saved.');
      var v = (j.verdicts || [])[0] || {};
      var why = v.verdict === 'dupe' ? 'Already on file at ' + j.brand.name + '.'
        : v.verdict === 'elsewhere' ? 'Already on file at ' + v.at + ' — not added again.'
        : v.verdict === 'full' ? j.brand.name + ' already has ' + j.cap + ' people on file (the cap).'
        : null;
      freshPanel([
        head(j.added ? 'Sent' : 'Not added'),
        j.brandCreated ? h('div', { style: 'margin-bottom:6px;color:#137333' }, [b(j.brand.name), ' is now a brand in the dashboard. Its category is a guess — check it on the brand page.']) : null,
        j.added
          ? h('div', { style: 'margin-bottom:6px' }, [b(p.name), ' is in ', b(j.brand.name), '\'s LinkedIn queue (' + j.have + ' of ' + j.cap + ' on file).'])
          : h('div', { style: 'margin-bottom:6px;color:#946200', text: why || (j.errors || []).join('; ') || 'Nothing was saved.' }),
        h('a', { href: DASH_URL + '#brand/' + j.brand.id, target: '_blank', rel: 'noopener', style: BTN2 + ';margin-top:10px', text: 'Open ' + j.brand.name + ' in the dashboard ↗' }),
      ]);
    }).catch(function (e) { showError(e.message); });
  }

  // A hand scan reads the whole People tab, then its "marketing" and
  // "partnerships" views (Leo, Oct 2026: "make sure that all partnerships/
  // marketing people are accounted for"): the views surface the company's
  // marketers wherever they sit in the list, past the 150 a scroll reads
  // and past a scroll LinkedIn stopped feeding. Each view is its own page
  // load, so the scan's state rides in this tab's sessionStorage; one
  // preview at the end covers everyone. A view Leo opened himself
  // (?keywords=) is read alone — he has narrowed it already.
  var HAND_KEY = 'sbLiHand';
  var HAND_PASSES = ['', 'marketing', 'partnerships'];
  function loadHand() {
    try {
      var j = JSON.parse(sessionStorage.getItem(HAND_KEY) || 'null');
      return j && Date.now() - j.at < 10 * 60 * 1000 ? j : null;
    } catch (e) { return null; }
  }
  function saveHand(j) {
    try { if (j) { j.at = Date.now(); sessionStorage.setItem(HAND_KEY, JSON.stringify(j)); } else sessionStorage.removeItem(HAND_KEY); } catch (e) {}
  }
  function keywordOfPage() {
    try { return new URLSearchParams(location.search).get('keywords') || ''; } catch (e) { return ''; }
  }
  function handPassUrl(hs, i) {
    return hs.base + 'people/' + (hs.passes[i] ? '?keywords=' + encodeURIComponent(hs.passes[i]) : '');
  }
  // This page is the scan's next view: carry on without a click.
  function handHere() {
    var hs = loadHand();
    if (!hs || !onPeoplePage() || companyBase() !== hs.base) return null;
    return keywordOfPage() === (hs.passes[hs.pass] || '') ? hs : null;
  }

  function readPage() {
    var hs = handHere();
    if (!hs) {
      var kw = keywordOfPage();
      hs = {
        base: companyBase(), passes: kw ? [kw] : HAND_PASSES, pass: 0, rows: [], hidViews: [],
        companyName: companyName(), companyUrl: location.href, industry: companyIndustry(),
      };
    }
    saveHand(hs);
    busy = true;
    var halt = { stopped: false };
    var many = hs.passes.length > 1;
    var where = many ? (hs.passes[hs.pass] ? 'the “' + hs.passes[hs.pass] + '” view' : 'the whole list') + ' (' + (hs.pass + 1) + ' of ' + hs.passes.length + ')' : 'this page';
    var prog = h('div', { id: 'sbliprog', style: 'color:#555;margin-bottom:10px', text: count() + ' people on screen…' });
    freshPanel([
      head('Reading ' + where),
      prog,
      h('div', { style: 'color:#999;font-size:11px;margin-bottom:10px', text: (many ? 'Then the marketing and partnerships views, so no marketer is missed. ' + hs.rows.length + ' people so far. ' : '') + 'Up to ' + MAX_PEOPLE + ' people a page, with pauses. Nothing is saved yet.' }),
      h('button', { id: 'sblistop', style: BTN2, text: 'Stop and use what\'s here', onclick: function () { halt.stopped = true; } }),
    ]);
    // A view LinkedIn just loaded may draw its cards a moment later.
    waitFor(function () { return listed() > 0 || /no results/i.test(pageText(5000)); }, 8000).then(function () {
      return expand(function (n) { prog.textContent = n + ' people on screen…'; }, halt);
    }).then(function () {
      window.scrollTo(0, 0);
      var have = {};
      hs.rows.forEach(function (r) { have[r.linkedinUrl] = 1; });
      scrape().forEach(function (r) { if (!have[r.linkedinUrl]) { have[r.linkedinUrl] = 1; hs.rows.push(r); } });
      if (hs.pass === 0) hs.members = peopleCount();
      var hid = hiddenCards();
      if (hid.length) (hs.hidViews = hs.hidViews || []).push({ q: hs.passes[hs.pass] || '', url: location.href, heads: hid.slice(0, 60) });
      if (!halt.stopped && hs.pass < hs.passes.length - 1) {
        hs.pass++;
        saveHand(hs);
        prog.textContent = 'Opening the “' + hs.passes[hs.pass] + '” view…';
        return wait(rand(1500, 3000)).then(function () { location.href = handPassUrl(hs, hs.pass); });
      }
      saveHand(null);
      lastRead = { rows: hs.rows, hidden: hiddenTotal(hs.hidViews), hidViews: hs.hidViews || [], views: hs.passes.length, members: hs.passes[0] ? null : hs.members, companyName: hs.companyName, companyUrl: hs.companyUrl, industry: hs.industry };
      busy = false;
      return preview('');
    }).catch(function (e) {
      saveHand(null);
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
      // The "LinkedIn Member" cards: likely buyers go on Zach's list.
      hidden: r.hidViews || [],
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
      // Nobody new, but LinkedIn hid people here: saving still sends them
      // for Zach's list, under the brand Leo has confirmed.
      var forZach = !adds.length && lastRead.hidden > 0;
      add = h('button', {
        id: 'sbliadd', style: BTN + ';margin-top:12px', disabled: !adds.length && !forZach,
        text: adds.length ? 'Add ' + adds.length + ' to ' + j.brand.name
          : forZach ? 'Nobody new — save the ' + lastRead.hidden + ' hidden for Zach' : 'Nobody new to add',
      });
      if (adds.length || forZach) add.onclick = function () { capture(typed, add); };
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
      h('div', { style: 'font-size:12px;color:#555;margin-top:8px', text: lastRead.rows.length + (lastRead.views > 1 ? ' people read from the whole list + the marketing and partnerships views.' : ' people read from this page.') +
        (lastRead.hidden ? ' ' + lastRead.hidden + ' more show as "LinkedIn Member" — hidden from your account. If they look like buyers, the brand goes on “Read on Zach\'s LinkedIn” in the dashboard.' : '') }),
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
      members: r.members == null ? null : r.members,
      rows: r.rows,
      hidden: r.hidViews || [],
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
  function sampleText(markupChars) {
    var cards = [], seen = {};
    // A Sales Navigator search: its lead cards, read its way.
    var sn = onSalesSearch();
    (sn ? snLinks() : profileLinks()).forEach(function (a) {
      var slug = sn ? leadId(a.getAttribute('href')) : slugOf(a.getAttribute('href'));
      if (seen[slug] || cards.length >= 3) return;
      seen[slug] = 1;
      cards.push(sn ? snCard(a) : cardFor(a));
    });
    var out = ['SB LinkedIn sample · script ' + VERSION + ' · ' + location.pathname + ' · ' + (sn ? snCount() : count()) + ' people on screen'];
    // Where every profile link on the page is, read or skipped: when the
    // count is short, this says which wrapper hid the rest.
    var zones = {};
    [].slice.call(document.querySelectorAll(PROFILE_SEL)).forEach(function (a) {
      var z = a.closest('#global-nav, header, nav, aside, [role="dialog"], .sb-li-ui');
      var k = z ? 'skipped:' + z.tagName.toLowerCase() + (z.id ? '#' + z.id : '') + (z.getAttribute('role') ? '[role=' + z.getAttribute('role') + ']' : '') : 'read';
      zones[k] = (zones[k] || 0) + 1;
    });
    out.push('profile links ' + JSON.stringify(zones));
    cards.forEach(function (c, i) {
      out.push('--- card ' + (i + 1) + ' read as ' + JSON.stringify(sn ? snReadCard(c, c.querySelector('a[href*="/sales/lead/"]') || c) : readCard(c)));
      out.push('lines ' + JSON.stringify(cardLines(c).slice(0, 14)));
      out.push(String(c.outerHTML || '')
        .replace(/<img[^>]*>/g, '<img>')
        .replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>')
        .replace(/\s(src|srcset|style|data-[\w-]+|aria-[\w-]+|tabindex|role)="[^"]*"/g, '')
        .replace(/\s+/g, ' ')
        .slice(0, markupChars || 2500));
    });
    if (!cards.length) out.push('No profile links found on this page.');
    return out.join('\n');
  }
  function copySample() {
    var text = sampleText(2500);
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
  // every brand on its own, electrolyte brands first, about 75 a day,
  // saving as it goes, and find the company page for brands that have
  // none. LinkedIn restricts accounts that browse like a script, so this
  // is built to move and stop like a person:
  //   · one tab — the run belongs to the tab it started in; only its
  //     Pause button pauses it;
  //   · BETWEEN_BRANDS / BETWEEN_PAGES below (Leo keeps asking for
  //     faster; it's pages per day LinkedIn watches, which is the cap);
  //   · DAILY_CAP brands, then it waits for the next morning;
  //   · a login wall, security check or search limit pauses it at once.
  // People are saved through the same liCapture as a manual read, named
  // by brandId, so buyers-only, the 25 cap and duplicates all hold. New
  // brands come only through liDiscover (see "new brands" below), which
  // the server judges; the brand lookup itself never creates one.

  var FILL_KEY = 'sbLiFill';
  var DAILY_CAP = 100;
  // Leo (Sep 30): "why are the steps so long between each" — 8-15 s
  // between brands, 3-6 s between a brand's pages, and a brand skipped
  // before any reading (too big) moves on after only a page's wait.
  var BETWEEN_BRANDS = [8, 15];   // seconds
  var BETWEEN_PAGES = [3, 6];
  // A small company is read whole on its People tab; a big one (the tab
  // never ran out) also gets these two keyword views.
  var PASSES = ['', 'marketing', 'partnerships'];
  // Leo (Sep 2026): only companies with under 100 people on LinkedIn.
  // A bigger one (Microsoft and the like) is skipped on its People tab's
  // count, before any scrolling or reading.
  // Its own name: `var MAX_PEOPLE` here re-set the by-hand scroll cap (150) too.
  var BIG_COMPANY = 100;
  // Leo (Sep 30, after a run that skipped Bang, Tito's, Bacardi and Nike):
  // a big company isn't skipped any more — too big to read whole, its
  // People tab is searched for the people who buy, a short read of each
  // (LinkedIn puts the closest matches first); "marketing" only when the
  // first three found fewer than three.
  var BIG_PASSES = ['partnerships', 'sponsorship', 'brand manager', 'marketing'];
  var SHORT_READ = { rounds: 6, people: 60 };

  function loadFill() { try { return GM_getValue(FILL_KEY, null); } catch (e) { return null; } }
  function saveFill(job) {
    if (job) { flushHidden(job); job.touchedAt = Date.now(); }
    try { GM_setValue(FILL_KEY, job); } catch (e) {}
  }

  // Time the run's window spent hidden. Leo runs the fill in a window of
  // its own beside the dashboard (Sep 2026); Chrome slows a window it
  // treats as hidden (minimized, or fully covered) to about one step a
  // minute, so a hidden run crawls. Counted per brand and for the run,
  // shown in the panel and sent with the report.
  var hiddenAt = document.hidden ? Date.now() : 0;
  function flushHidden(job) {
    if (!hiddenAt || job.runner !== PAGE_NONCE) return;
    var now = Date.now(), gone = now - hiddenAt;
    hiddenAt = document.hidden ? now : 0;
    job.hiddenMs = (job.hiddenMs || 0) + gone;
    if (job.step) job.step.hiddenMs = (job.step.hiddenMs || 0) + gone;
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { if (!hiddenAt) hiddenAt = Date.now(); return; }
    var job = loadFill();
    if (hiddenAt && job && inCharge(job)) { saveFill(job); renderFill(job, 'Back in view.'); }
    else hiddenAt = 0;
  });
  // A run nobody has touched for ten minutes has lost its tab (closed, or
  // a copy from an older script). It shouldn't block starting a new one.
  // A live run's tab touches it at least once a minute (runFill).
  function staleFill(job) { return !!job && (!job.touchedAt || Date.now() - job.touchedAt > 10 * 60000); }
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
  // One page is in charge of the run at a time: the latest page load in
  // the run's tab claims it. A duplicated tab (which copies the tab's id)
  // or a stray second copy then stands down instead of working the same
  // brand in parallel.
  var PAGE_NONCE = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  function inCharge(job) { return ownsFill(job) && job.runner === PAGE_NONCE; }
  // Still on the brand this step started on, and still ours to do.
  function sameStep(job, at) { return inCharge(job) && !job.paused && job.at === at && !!job.step; }
  function fillHere() { return HAS_GM && ownsFill(loadFill()); }

  function todayKey() { var d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
  function tomorrowMorning() { var d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, rand(0, 45), 0, 0); return d.getTime(); }
  function secs(range) { return rand(range[0] * 1000, range[1] * 1000); }
  function akaName(item) {
    return String(item.aka || '').split(/[,;]/).map(function (x) { return x.trim(); }).filter(Boolean)[0] || '';
  }
  // The second name typed into LinkedIn's search: the "also known as",
  // else what the dashboard sends (a spelling its lists know — "AriZona"
  // for Arizona Beverages — or the name without "Skincare" / "Energy").
  function secondName(item) {
    return akaName(item) || String(item.alsoSearch || '').trim();
  }

  // A company search that showed nothing. LinkedIn sometimes draws an
  // empty page (a hidden window, a slow load): Arizona Beverages "found
  // nothing" on Oct 12 2026 with the window hidden. The same search is
  // loaded once more before the run believes it.
  function searchLooksEmpty(job, q) {
    var st = job.step;
    if (searchCandidates().length || st.emptyRetried === q) return false;
    st.emptyRetried = q; st.navs = 0;
    job.nextAt = Date.now() + rand(4000, 8000);
    saveFill(job);
    renderFill(job, 'LinkedIn showed nothing for “' + q + '” — loading it again');
    later(runFill, 1000);
    return true;
  }
  // How long a search gets to draw: longer while the window is hidden
  // (Chrome slows a hidden window's page).
  function searchWait() { return document.hidden ? 30000 : 12000; }

  function peopleUrl(linkedinUrl, keyword) {
    var m = String(linkedinUrl || '').match(/linkedin\.com\/(company|showcase)\/([^\/?#]+)/i);
    if (!m) return null;
    return location.origin + '/' + m[1] + '/' + m[2] + '/people/' + (keyword ? '?keywords=' + encodeURIComponent(keyword) : '');
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
  // The People tab's "12,345 associated members"; null when it's not shown.
  function peopleCount() {
    var m = /([\d][\d,.]*)\s*([KM])?\+?\s+associated members?/i.exec(pageText(8000));
    if (!m) return null;
    var n = parseFloat(m[1].replace(/,/g, ''));
    if (!isFinite(n)) return null;
    if (m[2]) n *= /k/i.test(m[2]) ? 1e3 : 1e6;
    return Math.round(n);
  }

  function pageText(n) {
    try { return String(document.body ? document.body.innerText : '').slice(0, n || 20000); } catch (e) { return ''; }
  }

  // LinkedIn telling us to stop. Checked on every page the run lands on
  // and before every save. (Our panel hangs off <html>, not <body>, so
  // its own words never trip this.)
  var HALT_TEXT = /commercial use limit|unusual activity|security verification|quick security check|verify (?:that )?you'?re (?:a )?human|too many requests|you'?ve reached the (?:weekly|monthly) limit|account (?:has been )?restricted|temporarily restricted|reached (?:your|the) (?:\w+ )?search limit|too many actions/i;
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

  // ---- Sales Navigator (Leo, Oct 12 2026) ----
  //
  // On Leo's account a brand's People tab shows most of its marketers as
  // "LinkedIn Member": outside his network, name and profile hidden.
  // Sales Navigator shows 3rd-degree people by name. So when it's open on
  // the account, a brand's marketing / partnerships views come from Sales
  // Navigator's lead search instead: current company = the brand's page
  // (by LinkedIn's company id, so it's that company and no other), and
  //   1. function Marketing or Business Development (up to 3 pages);
  //   2. "partnership(s) OR sponsorship(s)" anywhere (up to 2 pages).
  // The People tab's whole list is still read first: it gives the
  // headcount, the industry check, lookalikes and anyone in-network.
  // Saving is the same liCapture by brandId, so the dashboard's rules
  // (buyers only, 25 cap, duplicates) hold exactly as they do now.
  // 1.38 (Leo, Oct 14 2026: "make sure that each brand goes to the sales
  // navigator"): every brand does — an empty People tab, a big company and
  // a brand read under its parent (the parent's company, searched for the
  // brand's name) too. Nothing falls back to the People tab's views: a page
  // that doesn't load is loaded once more, then the brand is an issue,
  // tried again at the end of the run and first on the next one (the
  // dashboard keeps count). An account without Sales Navigator pauses the
  // run. The People tab's views are only for a run with the switch off.
  var SN_KEY = 'sbLiSalesNav';
  var SN_SEARCHES = [
    { label: 'marketing & business development', q: 'marketing', pages: 3,
      functions: [[15, 'Marketing'], [4, 'Business Development']] },
    { label: 'partnerships & sponsorship', q: 'partnerships', pages: 2,
      keywords: 'partnership OR partnerships OR sponsorship OR sponsorships' },
  ];
  var SN_PAGE_SIZE = 25;
  // The People tab's first screen or two, when Sales Navigator does the rest.
  var SN_GLANCE = { rounds: 2, people: 40 };
  // Under this many on LinkedIn, the marketing search finds everyone worth it;
  // the partnerships / sponsorship search is skipped.
  var SN_SMALL = 50;
  // Sales Navigator's empty search, and its pages for an account without it.
  // Its wordings seen so far: "No leads matched your search" / "0 results"
  // and, with a function filter, "No matches found" (Oct 12 2026).
  var SN_EMPTY = /no leads (?:match|found)|no matches found|no results found|\b0 results/i;
  var SN_UPSELL = /start (?:your )?free trial|try sales navigator|upgrade to sales navigator|get sales navigator|reactivate (?:your )?sales navigator/i;
  // Skip very big brands (Leo, Oct 12 2026: "not reach out to any brand with
  // over 1500 employees"): the list leaves out the ones it knows; the run
  // skips the rest as soon as their People tab shows the count (1.38).
  var VERY_BIG = 1500;

  var FIT_KEY = 'sbLiMinFit';
  // 50, not 60: Brand Fit gives a big company 8 more points than a mid-size
  // one, and 60 left out most mid-size brands (Leo wants them mainly).
  var FIT_DEFAULT = 50;
  var BIG_KEY = 'sbLiSkipBig';
  function skipBigWanted() { try { return GM_getValue(BIG_KEY, true) !== false; } catch (e) { return true; } }
  function minFitWanted() {
    try { var v = GM_getValue(FIT_KEY, FIT_DEFAULT); return typeof v === 'number' && v >= 0 && v <= 100 ? v : FIT_DEFAULT; } catch (e) { return FIT_DEFAULT; }
  }
  function snWanted() { try { return GM_getValue(SN_KEY, true) !== false; } catch (e) { return true; } }
  function snOn(job) { return !!job && job.salesNav === true; }
  function onSalesSearch() { return /^\/sales\/search\/people\/?$/.test(location.pathname); }
  function snPageNo() {
    try { return parseInt(new URLSearchParams(location.search).get('page') || '1', 10) || 1; } catch (e) { return 1; }
  }
  // Rest.li text: encodeURIComponent leaves ( ) ' ! * alone, and those
  // are Sales Navigator's own punctuation in the query.
  function restli(s) {
    return encodeURIComponent(String(s || '')).replace(/[()'!*]/g, function (c) { return '%' + c.charCodeAt(0).toString(16).toUpperCase(); });
  }
  // brandKw: a brand read under its parent company — the parent's people
  // whose profile names the brand ("Ketel One" at Diageo).
  function snUrl(coId, coName, search, page, brandKw) {
    var filters = ['(type:CURRENT_COMPANY,values:List((id:urn%3Ali%3Aorganization%3A' + coId + ',text:' + restli(coName) + ',selectionType:INCLUDED)))'];
    var kw = search.keywords || '';
    if (brandKw) kw = '"' + String(brandKw).replace(/"/g, '') + '"' + (kw ? ' AND (' + kw + ')' : '');
    if (search.functions) {
      filters.push('(type:FUNCTION,values:List(' + search.functions.map(function (f) {
        return '(id:' + f[0] + ',text:' + restli(f[1]) + ',selectionType:INCLUDED)';
      }).join(',') + '))');
    }
    var query = '(' + (kw ? 'keywords:' + restli(kw) + ',' : '') + 'filters:List(' + filters.join(',') + '))';
    return location.origin + '/sales/search/people?query=' + query + (page > 1 ? '&page=' + page : '');
  }

  // LinkedIn's own id for the company page we're on — what Sales
  // Navigator's company filter takes. Asked of LinkedIn the way its pages
  // ask; else the id the page itself mentions most (its own, on its own
  // page). null when neither says.
  var COMPANY_URN = /urn:li:(?:fsd_company|fs_normalized_company|fs_company|company|organization):(\d+)/g;
  function companyIdOnPage() {
    var html = '';
    try { html = document.documentElement.innerHTML; } catch (e) {}
    var counts = {}, m, best = null;
    COMPANY_URN.lastIndex = 0;
    while ((m = COMPANY_URN.exec(html))) counts[m[1]] = (counts[m[1]] || 0) + 1;
    Object.keys(counts).forEach(function (id) { if (!best || counts[id] > counts[best]) best = id; });
    return best;
  }
  function companyIdHere() {
    var c = companyPath();
    if (!c) return Promise.resolve(null);
    var m = document.cookie.match(/JSESSIONID="?([^";]+)"?/);
    var ask = m && typeof fetch === 'function'
      ? fetch('/voyager/api/organization/companies?q=universalName&universalName=' + encodeURIComponent(c.slug), {
          credentials: 'include', headers: { 'csrf-token': m[1], accept: 'application/json', 'x-restli-protocol-version': '2.0.0' },
        })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            var first = j && Array.isArray(j.elements) ? j.elements[0] : j;
            var hit = first ? /urn:li:(?:fsd_company|fs_normalized_company|fs_company|company|organization):(\d+)/.exec(JSON.stringify(first)) : null;
            return hit ? hit[1] : null;
          })
          .catch(function () { return null; })
      : Promise.resolve(null);
    var timeout = new Promise(function (res) { setTimeout(function () { res(null); }, 6000); });
    return Promise.race([ask, timeout]).then(function (id) { return id || companyIdOnPage(); });
  }

  // Lead links in Sales Navigator's results: /sales/lead/<id>,NAME_SEARCH,…
  // The id opens the same person's profile at linkedin.com/in/<id>.
  function leadId(href) {
    var m = String(href || '').match(/\/sales\/lead\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  }
  function snLinks() {
    return [].slice.call(document.querySelectorAll('a[href*="/sales/lead/"]')).filter(function (a) {
      return !a.closest('.sb-li-ui, [role="dialog"]') && leadId(a.getAttribute('href'));
    });
  }
  function distinctLeads(el) {
    var s = {};
    [].slice.call(el.querySelectorAll('a[href*="/sales/lead/"]')).forEach(function (a) {
      var k = leadId(a.getAttribute('href'));
      if (k) s[k] = 1;
    });
    return Object.keys(s).length;
  }
  function snCard(a) {
    var li = a.closest('li');
    if (li && distinctLeads(li) === 1) return li;
    var el = a;
    while (el.parentElement && el.parentElement !== document.body) {
      if (distinctLeads(el.parentElement) > 1) break;
      el = el.parentElement;
      if (lines(el).length > 14) break;
    }
    return el;
  }
  function textOf(el) { return el ? String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : ''; }
  // One result: name, title and company. Sales Navigator marks each with
  // data-anonymize; when it doesn't, the lines after the name decide.
  function snReadCard(card, a) {
    var name = personName(textOf(card.querySelector('[data-anonymize="person-name"]')) || lines(a)[0] || '');
    var title = textOf(card.querySelector('[data-anonymize="title"]'));
    var company = textOf(card.querySelector('[data-anonymize="company-name"]'));
    if (!title && name) {
      var all = lines(card).map(personName), at = all.indexOf(name);
      for (var i = at + 1; i < all.length && !title; i++) {
        var l = all[i];
        if (l && l !== name && !/^(save|saved|message|view profile|\d+(st|nd|rd|th)?|.*\bdegree\b.*)$/i.test(l)) title = l;
      }
    }
    return { name: name, title: personName(title).slice(0, 200), company: company.replace(/^\s*(?:at\s+)?/i, '').slice(0, 120) };
  }
  // "LinkedIn Member" cards Sales Navigator still can't name.
  function snHiddenLeaves() {
    return [].slice.call(document.querySelectorAll('main *, #search-results-container *')).filter(function (el) {
      return !el.children.length && !el.closest('.sb-li-ui') && /^linkedin member$/i.test(String(el.textContent || '').trim());
    });
  }
  function snRead() {
    var ids = {}, rows = [], hidden = [], hidCards = [];
    snLinks().forEach(function (a) {
      var id = leadId(a.getAttribute('href'));
      if (ids[id]) return;
      ids[id] = 1;
      var card = snCard(a);
      var r = snReadCard(card, a);
      if (!r.name || r.name.length > 80) return;
      if (/^linkedin member$/i.test(r.name)) { hidden.push(r.title); hidCards.push(card); return; }
      rows.push({ name: r.name, title: r.title, company: r.company, linkedinUrl: 'https://www.linkedin.com/in/' + id + '/' });
    });
    // Hidden cards with no lead link at all.
    var unlinked = 0;
    snHiddenLeaves().forEach(function (el) {
      var card = el.closest('li') || el.parentElement;
      if (!card || hidCards.indexOf(card) >= 0 || card.querySelector('a[href*="/sales/lead/"]')) return;
      hidCards.push(card); unlinked++;
      hidden.push(textOf(card.querySelector('[data-anonymize="title"]')) ||
        (lines(card).map(personName).filter(function (x) { return x && !/^linkedin member$/i.test(x); })[0] || ''));
    });
    // cards: every result on screen, each once (a hidden one may have a link).
    return { rows: rows, hidden: hidden.map(function (x) { return String(x || '').slice(0, 160); }), links: Object.keys(ids).length, cards: Object.keys(ids).length + unlinked };
  }
  function snCount() { var g = snRead(); return g.links + g.hidden.length; }
  // Sales Navigator's own count over the list ("28 results", "1K+ results"):
  // what a page should show, so a page that drew only part of it is caught.
  function snTotal() {
    var m = /(?:^|\s)(?:about\s+)?(\d[\d,.]*)\s*([KM])?\+?\s+results?\b/i.exec(pageText(8000));
    if (!m) return null;
    var n = parseFloat(m[1].replace(/,/g, ''));
    if (!isFinite(n)) return null;
    if (m[2]) n *= /k/i.test(m[2]) ? 1e3 : 1e6;
    return Math.round(n);
  }

  // Sales Navigator draws its results as they scroll into view, inside a
  // box of their own: scroll that box down a screen at a time until the
  // count stops growing at the bottom.
  function snScroller() {
    var c = document.querySelector('#search-results-container');
    if (c && c.scrollHeight > c.clientHeight + 20) return c;
    var a = snLinks()[0], el = a && a.parentElement;
    while (el && el !== document.body) {
      var cs = getComputedStyle(el);
      if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 20) return el;
      el = el.parentElement;
    }
    return null;
  }
  function snExpand(halt) {
    return new Promise(function (resolve) {
      var steps = 0, still = 0, last = -1;
      (function step() {
        if (halt.stopped) return resolve();
        var sc = snScroller();
        if (sc) sc.scrollTop = sc.scrollTop + Math.max(300, sc.clientHeight * 0.8);
        else window.scrollBy(0, Math.max(300, window.innerHeight * 0.8));
        steps++;
        wait(rand(400, 800)).then(function () {
          var n = snCount();
          var atEnd = sc ? sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 5
            : window.innerHeight + window.scrollY >= document.body.scrollHeight - 5;
          still = n === last && atEnd ? still + 1 : 0;
          last = n;
          if (still >= 2 || steps >= 20) {
            if (sc) sc.scrollTop = 0;
            window.scrollTo(0, 0);
            return resolve();
          }
          step();
        }).catch(function () { resolve(); });
      })();
    });
  }

  // Is a result's company the brand? The company filter should make every
  // result the brand's; this is the check that a wrong company id can't
  // fill a brand with someone else's people.
  function coKey(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ').replace(/\b(inc|llc|ltd|corp|co|company|the|group)\b/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function sameCompany(a, names) {
    var x = coKey(a);
    if (!x) return true;
    return names.some(function (n) {
      var y = coKey(n);
      if (!y) return false;
      if (x === y || x.indexOf(y) >= 0 || y.indexOf(x) >= 0) return true;
      var fx = x.split(' ')[0], fy = y.split(' ')[0];
      return fx.length >= 4 && fx === fy;
    });
  }

  function snReadingProblem(got) {
    if (!got.rows.length) return got.links >= 3 ? 'Sales Navigator showed ' + got.links + ' people but the reader made out none' : null;
    if (got.rows.length >= 3 && got.rows.every(function (r) { return !r.title; })) return 'every Sales Navigator title came out blank (' + got.rows.length + ' people)';
    return null;
  }

  // Why the run isn't on a Sales Navigator search after going to one.
  function snWhyNot() {
    var p = location.pathname;
    if (/^\/sales\/contract/.test(p)) return { pause: 'Sales Navigator asked which contract to use. Pick it, then press Continue' };
    if (/^\/(sales|premium)\//.test(p) || SN_UPSELL.test(pageText(6000))) return { text: 'Sales Navigator isn\'t open on this LinkedIn account', wholeRun: true };
    return null;
  }
  var fillTimer = null, fillHalt = { stopped: false }, fillStatusEl = null;
  function later(fn, ms) {
    clearTimeout(fillTimer);
    fillTimer = setTimeout(function () { try { fn(); } catch (e) { fillError(e); } }, ms);
  }

  // discover: { lookalikes: bool, words: [..] } — the new-brand half.
  // The run's own report: started, paused (and why), carried on, ended.
  function runEvent(job, kind, extra) {
    if (!job || !job.id) return;
    runPost(Object.assign({ action: 'liRun', kind: kind, run: job.id, script: VERSION }, extra || {})).catch(function () {});
  }

  function startFill(items, focus, discover) {
    discover = discover || {};
    saveFill({
      id: 'f' + Date.now().toString(36), owner: tabId(), runner: PAGE_NONCE, focus: focus || '',
      items: items, at: 0, step: null, results: [], added: 0,
      day: todayKey(), doneToday: 0, nextAt: 0, pausedUntil: 0, paused: null,
      lookalikes: !!discover.lookalikes, newBrands: [], reviewSent: 0,
      // Skip very big brands, as the setup panel said (1.38).
      skipBig: discover.skipBig !== false,
      // Sales Navigator for the marketing / partnerships people (Leo, Oct
      // 2026); off for the rest of the run if the account doesn't have it.
      salesNav: discover.salesNav !== false,
      snWanted: discover.salesNav !== false,
      // The dashboard put mid-size brands first (a Brand Fit floor is on).
      midFirst: !!discover.midFirst,
      searches: (discover.words || []).map(function (q) { return { q: q, page: 1, navs: 0 }; }),
    });
    runEvent(loadFill(), 'start', { focus: focus || '', items: items.length });
    fillHalt = { stopped: false };
    runFill();
  }

  function pauseFill(job, reason) {
    fillHalt.stopped = true;
    clearTimeout(fillTimer);
    job.paused = reason;
    saveFill(job);
    runEvent(job, 'pause', { why: reason });
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
    if (!inCharge(job)) return renderFill(job, 'This run carries on in another copy of this tab.');
    if (Date.now() - (job.touchedAt || 0) > 60000) saveFill(job);
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
      job.step = { phase: item.research ? 'research' : peopleUrl(item.linkedinUrl, '') ? 'read' : 'search', pass: 0, triedAka: false, seen: 0, added: 0, navs: 0, startedAt: Date.now(), hiddenMs: 0 };
      saveFill(job);
      // Leo marked it "None of these": never searched under its own name
      // again — straight to its parent's page, or done.
      if (item.noPage && job.step.phase === 'search') return endBrand(job, 'you marked it as having no LinkedIn page');
    }
    var st = job.step;
    // Only a page this run opened itself counts (navs > 0) — never the
    // page Leo happened to be on when he pressed Start.
    if (st.phase === 'search' || st.phase === 'research') {
      var q = st.triedAka ? secondName(item) : item.name;
      if (st.navs > 0 && /^\/search\/results\/companies/.test(location.pathname) && kwParam() === q && pageParam() === 1) {
        st.navs = 0; saveFill(job);
        return st.phase === 'research' ? fillResearch(item, q) : fillSearch(item, q);
      }
      return go(job, searchUrl(q), 'Looking up ' + item.name + ' on LinkedIn' + (item.research ? ' (research list)' : ''));
    }
    // A step saved by an older copy on its way to the company home page
    // for similar brands; that stop is gone, so the brand is done.
    if (st.phase === 'home') return finishBrand(job, null);
    // The parent's own page, found once per parent (then remembered).
    if (st.phase === 'parent-find') {
      var pq = item.parent.search;
      if (st.navs > 0 && /^\/search\/results\/companies/.test(location.pathname) && kwParam() === pq && pageParam() === 1) {
        st.navs = 0; saveFill(job);
        return fillParentFind(item, pq);
      }
      return go(job, searchUrl(pq), 'Finding ' + item.parent.name + ' on LinkedIn — ' + item.name + '\'s people are there');
    }
    // Sales Navigator's lead searches (instead of the keyword views).
    if (st.phase === 'sales') {
      if (st.navs > 0 && onSalesSearch() && snPageNo() === st.snPage) {
        st.navs = 0; saveFill(job);
        return fillSales(item);
      }
      if (st.navs > 0) {
        var why = snWhyNot();
        if (why && why.pause) return pauseFill(job, why.pause);
        if (why) return snNoAccount(job, why.text);
      }
      if (st.navs >= 2) return brandIssue(job, 'snLeft', 'its Sales Navigator search would not open');
      var sn = SN_SEARCHES[st.snI], atParent = st.snFrom === 'parent';
      return go(job, snUrl(st.coId, st.pageName || (atParent ? item.parent.name : item.name), sn, st.snPage, atParent ? item.name : null),
        'Sales Navigator: ' + item.name + (atParent ? ' at ' + item.parent.name : '') + ' — ' + sn.label + (st.snPage > 1 ? ' (page ' + st.snPage + ')' : ''));
    }
    // Its People tab once more, for the company id it didn't give the
    // first time (LinkedIn's own lookup can be slow) — then Sales Navigator.
    if (st.phase === 'sn-id') {
      if (st.navs > 0 && onPeoplePage()) {
        st.navs = 0; saveFill(job);
        return waitFor(function () { return listed() > 0 || /associated members|no results/i.test(pageText(5000)); }, 12000)
          .then(function () { return toSales(job.at, st.snFrom); });
      }
      return go(job, peopleUrl(stepPage(item, st), st.kind === 'parent' ? item.name : ''), 'Opening ' + item.name + ' again for its LinkedIn company id');
    }
    var want = stepPasses(st)[st.pass];
    if (st.navs > 0 && onPeoplePage() && kwParam() === want) {
      st.navs = 0; saveFill(job);
      return fillRead(item);
    }
    return go(job, peopleUrl(stepPage(item, st), want), 'Opening ' + item.name +
      (st.kind === 'parent' ? ' at ' + item.parent.name : want ? ' — ' + want : ''));
  }

  function go(job, url, status) {
    var st = job.step;
    if (!url) return endBrand(job, 'no LinkedIn page');
    if (leoIsElsewhere(job)) {
      renderFill(job, 'You\'re using this window — it carries on a minute after you stop.');
      return later(runFill, 5000);
    }
    // Twice asked, twice landed somewhere else: the page is gone or
    // renamed. Move on rather than loop.
    if (st.navs >= 2) {
      st.issue = 'noOpen';
      return endBrand(job, (st.kind === 'parent' ? job.items[job.at].parent.name + '\'s' : 'its') + ' LinkedIn page would not open');
    }
    st.navs++;
    renderFill(job, status + '…');
    goTo(job, url);
  }

  // What a brand's read looks at: its own People tab (whole, then the
  // marketing / partnerships views if it never ran out), a big company's
  // targeted views, or its parent's People tab searched for its name.
  function stepPasses(st) { return st.passes || PASSES; }
  function stepPage(item, st) {
    return st.kind === 'parent' ? 'https://www.linkedin.com/company/' + item.parent.slug + '/' : item.linkedinUrl;
  }

  // A brand whose own page gave nobody, and whose people are under a
  // parent company (Captain Morgan → Diageo): its parent's People tab,
  // searched for its name, once.
  function tryParent(job, note) {
    var item = job.items[job.at], st = job.step || {};
    if (!item || !item.parent || !item.brandId || st.parentTried || st.added) return false;
    var why = note || (st.kind === 'big' ? 'nobody new in its big-company searches' : st.seen ? 'nobody new on its own page' : 'nobody readable on its own page');
    job.step = {
      phase: item.parent.slug ? 'read' : 'parent-find', kind: 'parent', passes: [item.name], pass: 0,
      parentTried: true, ownNote: why, triedAka: true, seen: st.seen || 0, seenUrls: st.seenUrls || [], added: 0, navs: 0,
      startedAt: st.startedAt || Date.now(), hiddenMs: st.hiddenMs || 0, members: st.members || null,
      hidRead: st.hidRead || 0, hidViews: st.hidViews || [], salesNav: !!st.salesNav,
    };
    job.nextAt = Date.now() + secs(BETWEEN_PAGES);
    saveFill(job);
    runFill();
    return true;
  }
  function endBrand(job, note) {
    if (tryParent(job, note)) return;
    finishBrand(job, note);
  }

  function fillParentFind(item, q) {
    var job = loadFill(), at0 = job.at;
    renderFill(job, 'Reading LinkedIn\'s results for “' + q + '”');
    waitFor(function () { return searchCandidates().length || /no results/i.test(pageText(5000)); }, 12000).then(function () {
      var stop = linkedinSaysStop();
      if (stop) return { halt: stop };
      return runPost({ action: 'liParent', parent: item.parent.name, candidates: searchCandidates() });
    }).then(function (r) {
      var job2 = loadFill();
      if (!sameStep(job2, at0)) return;
      if (r && r.halt) return pauseFill(job2, r.halt + '. Leave LinkedIn alone for a day before pressing Continue.');
      if (r && r.serverError) return brandIssue(job2, 'save', r.error || 'the dashboard did not answer');
      var st = job2.step;
      if (!r || !r.ok || !r.slug) {
        // Not tried: the parent's page wasn't found, so the next run looks
        // again; the note says what LinkedIn showed, for the morning check.
        st.parentTried = false;
        var shown = r && r.shown && r.shown.length ? ' (LinkedIn showed: ' + r.shown.slice(0, 3).join(', ') + ')' : '';
        return finishBrand(job2, (st.ownNote ? st.ownNote + '; ' : '') + 'could not find ' + item.parent.name + ' on LinkedIn' + shown);
      }
      job2.items.forEach(function (i) { if (i.parent && i.parent.name === item.parent.name) i.parent.slug = r.slug; });
      st.phase = 'read'; st.navs = 0;
      job2.nextAt = Date.now() + secs(BETWEEN_PAGES);
      saveFill(job2);
      runFill();
    }).catch(fillError);
  }

  function fillSearch(item, q) {
    var job = loadFill(), at0 = job.at;
    renderFill(job, 'Reading LinkedIn\'s results for “' + q + '”');
    waitFor(function () { return searchCandidates().length || /no results/i.test(pageText(5000)); }, searchWait()).then(function () {
      var stop = linkedinSaysStop();
      if (stop) return { halt: stop };
      var j = loadFill();
      if (!sameStep(j, at0)) return null;
      if (searchLooksEmpty(j, q)) return null;
      return runPost({ action: 'liMatched', brandId: item.brandId, recheck: !!loadFill().step.recheck, candidates: searchCandidates() });
    }).then(function (r) {
      if (r === null) return;
      var job2 = loadFill();
      if (!sameStep(job2, at0)) return;
      if (r && r.halt) return pauseFill(job2, r.halt + '. Leave LinkedIn alone for a day before pressing Continue.');
      if (r && r.serverError) return brandIssue(job2, 'save', r.error || 'the dashboard did not answer');
      var st = job2.step;
      if (r && r.ok && (r.outcome === 'attached' || r.outcome === 'already')) {
        job2.items[job2.at].linkedinUrl = r.linkedinUrl;
        job2.step = { phase: 'read', pass: 0, triedAka: st.triedAka, seen: 0, added: 0, navs: 0, startedAt: st.startedAt, hiddenMs: st.hiddenMs || 0 };
        job2.nextAt = Date.now() + rand(2000, 4000);
        saveFill(job2);
        return runFill();
      }
      if (r && r.outcome === 'markedNone') return endBrand(job2, 'you marked it as having no LinkedIn page');
      if (r && r.outcome !== 'review' && !st.triedAka && secondName(item)) {
        st.triedAka = true; st.navs = 0;
        job2.nextAt = Date.now() + rand(3000, 6000);
        saveFill(job2);
        return runFill();
      }
      if (r && r.outcome === 'taken') return finishBrand(job2, 'its LinkedIn page is saved on ' + r.by);
      endBrand(job2, r && r.outcome === 'review'
        ? 'its saved LinkedIn page looks like another company — pick the right one on Outreach → People'
        : 'no clear LinkedIn page — pick it on Outreach → People');
    }).catch(fillError);
  }

  // A name from the research list: the server decides whether one of
  // LinkedIn's results is that brand (industry must fit its lane), makes
  // the brand, and the run reads its people next.
  function fillResearch(item, q) {
    var job = loadFill(), at0 = job.at;
    renderFill(job, 'Reading LinkedIn\'s results for “' + q + '” (research list)');
    var final = job.step.triedAka || !secondName(item);
    waitFor(function () { return searchCandidates().length || /no results/i.test(pageText(5000)); }, searchWait()).then(function () {
      var stop = linkedinSaysStop();
      if (stop) return { halt: stop };
      var j = loadFill();
      if (!sameStep(j, at0)) return null;
      if (searchLooksEmpty(j, q)) return null;
      return runPost({ action: 'liResearch', name: item.name, aka: item.aka || '', category: item.category, lane: item.lane || '', candidates: searchCandidates(), final: final });
    }).then(function (r) {
      if (r === null) return;
      var job2 = loadFill();
      if (!sameStep(job2, at0)) return;
      if (r && r.halt) return pauseFill(job2, r.halt + '. Leave LinkedIn alone for a day before pressing Continue.');
      if (r && r.serverError) return brandIssue(job2, 'save', r.error || 'the dashboard did not answer');
      var st = job2.step, it = job2.items[job2.at];
      if (r && r.ok && (r.outcome === 'added' || r.outcome === 'exists')) {
        it.research = false;
        it.brandId = r.brandId;
        it.linkedinUrl = r.linkedinUrl;
        if (r.outcome === 'added') job2.newBrands = (job2.newBrands || []).concat([r.name]);
        // Still the same item: its clock and hidden time carry on.
        job2.step = { phase: peopleUrl(r.linkedinUrl, '') ? 'read' : 'search', pass: 0, triedAka: false, seen: 0, added: 0, navs: 0, startedAt: st.startedAt || Date.now(), hiddenMs: st.hiddenMs || 0 };
        job2.nextAt = Date.now() + rand(2000, 4000);
        saveFill(job2);
        return runFill();
      }
      if (r && r.ok && r.outcome === 'parent') {
        it.research = false;
        it.brandId = r.brandId;
        it.linkedinUrl = null;
        it.parent = r.parent;
        job2.newBrands = (job2.newBrands || []).concat([r.name]);
        if (tryParent(job2, 'no LinkedIn page of its own')) return;
        return finishBrand(job2, 'no LinkedIn page of its own');
      }
      if (!final) {
        st.triedAka = true; st.navs = 0;
        job2.nextAt = Date.now() + rand(3000, 6000);
        saveFill(job2);
        return runFill();
      }
      finishBrand(job2, 'research list: no clear LinkedIn page');
    }).catch(fillError);
  }

  function fillRead(item) {
    var job = loadFill(), at0 = job.at;
    var kind = job.step.kind || 'own', passes = stepPasses(job.step);
    var label = item.name + (kind === 'parent' ? ' at ' + item.parent.name : passes[job.step.pass] ? ' — ' + passes[job.step.pass] : '');
    renderFill(job, 'Reading ' + label);
    fillHalt = { stopped: false };
    var capped = false, rows = [], problem = null, sample = null;
    // This view's "LinkedIn Member" cards (their headlines) and where.
    var hid = [], viewQ = passes[job.step.pass] || '', viewUrl = null;
    var tooBig = null, veryBig = null;
    readPath = location.pathname;
    var headcount = null;
    waitFor(function () { return listed() > 0 || /no results|0 associated members/i.test(pageText(5000)); }, 12000).then(function () {
      var n = kind === 'own' && job.step.pass === 0 ? peopleCount() : null;
      // The brand's LinkedIn headcount sizes it for the next run's order.
      headcount = n;
      // Skip very big brands (1.38): 1,500+ on LinkedIn, unless the
      // dashboard says this one may be read (the Schedule's, a name Leo
      // asked for, a giant he OK'd, a conglomerate).
      if (n != null && n >= VERY_BIG && job.skipBig && item.bigOk === false) { veryBig = n; return { skip: true }; }
      if (n != null && n >= BIG_COMPANY) { tooBig = n; return { skip: true }; }
      // With Sales Navigator the People tab only needs a glance (headcount,
      // page check, similar brands): Sales Navigator reads the people.
      var limits = kind !== 'own' ? SHORT_READ : snOn(job) && job.step.pass === 0 ? SN_GLANCE : null;
      return expand(function (n) { setFillStatus('Reading ' + label + ' — ' + n + ' people on screen'); }, fillHalt, limits);
    }).then(function (res) {
      if (veryBig != null) {
        var jobV = loadFill();
        readPath = null;
        if (!sameStep(jobV, at0)) return null;
        // Its headcount is saved with the visit, so the next list leaves it out.
        jobV.step.members = veryBig; jobV.step.skip = 'veryBig';
        finishBrand(jobV, 'very big — ' + veryBig.toLocaleString('en-US') + ' on LinkedIn, skipped (Skip very big brands)', true);
        return null;
      }
      // Too big to read whole: its People tab's targeted views instead.
      if (tooBig != null) {
        var jobB = loadFill();
        readPath = null;
        if (!sameStep(jobB, at0)) return null;
        var sb = jobB.step;
        sb.members = tooBig;
        // With Sales Navigator, a big company's buyers come from its lead
        // search (by company id) instead of the People tab's searches.
        if (snOn(jobB) && kind === 'own') {
          saveFill(jobB);
          return toSales(at0, 'big').then(function () { return null; });
        }
        sb.kind = 'big'; sb.passes = BIG_PASSES; sb.pass = 0; sb.navs = 0;
        jobB.nextAt = Date.now() + secs(BETWEEN_PAGES);
        saveFill(jobB);
        runFill();
        return null;
      }
      capped = !!(res && res.capped);
      var job1 = loadFill();
      if (!sameStep(job1, at0)) return null;
      if (location.pathname !== readPath) { readPath = null; later(runFill, 3000); return null; }
      readPath = null;
      var stop = linkedinSaysStop();
      if (stop) return { halt: stop };
      if (headcount != null) { job1.step.members = headcount; saveFill(job1); }
      rows = scrape();
      hid = hiddenCards();
      viewUrl = location.href;
      problem = readingProblem(rows);
      if (problem) sample = sampleText(1500);
      window.scrollTo(0, 0);
      return runPost({
        action: 'liCapture', brandId: item.brandId, companyUrl: location.href,
        // At a parent the people are the brand's (never the parent's page).
        companyName: kind === 'parent' ? item.name : companyName(),
        companyIndustry: companyIndustry(), checkPage: kind !== 'parent', viaParent: kind === 'parent', rows: rows,
      });
    }).then(function (r) {
      if (!r) return;
      var job2 = loadFill();
      if (!sameStep(job2, at0)) return;
      if (r.halt) return pauseFill(job2, r.halt + '. Leave LinkedIn alone for a day before pressing Continue.');
      if (!r.ok) return brandIssue(job2, 'save', r.error || 'the dashboard did not save');
      var st = job2.step;
      // The saved page is another company's (its industry doesn't fit):
      // nobody saved; look the brand up again, and the results go on the
      // dashboard's "Which LinkedIn page is theirs?" list.
      if (r.pageMismatch) {
        if (st.recheck) return finishBrand(job2, 'its saved LinkedIn page looks like another company (' + r.industry + ') — pick the right one on Outreach → People');
        job2.step = { phase: 'search', recheck: true, pass: 0, triedAka: false, seen: st.seen, added: st.added, navs: 0, startedAt: st.startedAt, hiddenMs: st.hiddenMs || 0 };
        job2.nextAt = Date.now() + secs(BETWEEN_PAGES);
        saveFill(job2);
        return runFill();
      }
      // Each person once, however many views they turn up in.
      var seenUrls = st.seenUrls || [];
      rows.forEach(function (r) { if (seenUrls.indexOf(r.linkedinUrl) < 0) seenUrls.push(r.linkedinUrl); });
      st.seenUrls = seenUrls;
      st.seen = Math.max(st.seen || 0, seenUrls.length);
      st.added += r.added || 0;
      if (problem && !st.problem) { st.problem = problem; st.sample = sample; }
      // Views read, and the hidden people on each (sent with the visit).
      st.hidRead = (st.hidRead || 0) + 1;
      if (hid.length) (st.hidViews = st.hidViews || []).push({ q: viewQ, url: viewUrl, heads: hid.slice(0, 60) });
      job2.added = (job2.added || 0) + (r.added || 0);
      var full = r.have >= r.cap;
      if (full) st.full = true;
      // With Sales Navigator every brand goes on to its lead search — an
      // empty People tab too (1.38: it used to stop there) — and a brand
      // under its parent searches the parent's company for its name.
      if (!full && snOn(job2) && st.pass === 0 && ((st.kind || 'own') === 'own' || st.kind === 'parent')) {
        saveFill(job2);
        return toSales(at0, st.kind === 'parent' ? 'parent' : 'own');
      }
      var ps = stepPasses(st);
      var more = st.kind === 'parent' ? false
        : st.kind === 'big' ? !full && st.pass < ps.length - 1 && !(ps[st.pass + 1] === 'marketing' && st.added >= 3)
        // The marketing / partnerships views run even when the scroll
        // seemed to reach the end: a stalled scroll looks the same. A page
        // with nobody on it at all has no views worth opening — but one of
        // only "LinkedIn Member" cards does (their headlines go to Zach).
        : !full && st.pass < ps.length - 1 && (st.pass > 0 || rows.length > 0 || hid.length > 0);
      if (!more) return afterPeople(job2, item);
      st.pass++; st.navs = 0;
      job2.nextAt = Date.now() + secs(BETWEEN_PAGES);
      saveFill(job2);
      runFill();
    }).catch(fillError);
  }

  // From the brand's People tab to its Sales Navigator searches. Called
  // while still on the People tab: the company id, the page's name and
  // industry, and its lookalikes are read here, before leaving it.
  function toSales(at0, from) {
    return companyIdHere().then(function (id) {
      var job = loadFill();
      if (!sameStep(job, at0)) return;
      var st = job.step;
      st.pageName = companyName();
      st.industry = companyIndustry();
      if (from !== 'parent' && !st.look) st.look = job.lookalikes ? lookalikes() : [];
      st.snFrom = from;
      // No id, no company filter: its page once more, then an issue.
      if (!id) {
        if (!st.idRetried) {
          st.idRetried = true; st.phase = 'sn-id'; st.navs = 0;
          job.nextAt = Date.now() + secs(BETWEEN_PAGES);
          saveFill(job);
          return runFill();
        }
        return brandIssue(job, 'snNoId', 'couldn’t find its LinkedIn company id');
      }
      st.phase = 'sales'; st.coId = id; st.snI = 0; st.snPage = 1; st.navs = 0; st.snHid = []; st.snReloads = 0;
      job.nextAt = Date.now() + secs(BETWEEN_PAGES);
      saveFill(job);
      runFill();
    }).catch(fillError);
  }

  // Something went wrong with this brand's read (1.38, Leo, Oct 14 2026: "if
  // a brand capture does not get all the people … or it times out … make
  // sure that it runs again"). It's done for now; finishBrand puts it at the
  // end of the run for a second try, and the dashboard puts it first on the
  // next run until a read comes out clean.
  function brandIssue(job, code, words) {
    var st = job.step || (job.step = { seen: 0, added: 0 });
    st.issue = code; st.issueNote = words;
    finishBrand(job, words);
  }
  // A Sales Navigator page that didn't come out right: loaded once more
  // (reload), then an issue.
  function snTrouble(job, code, words, reload) {
    var st = job.step;
    if (reload && !(st.snReloads >= 1)) {
      st.snReloads = (st.snReloads || 0) + 1; st.navs = 0;
      job.nextAt = Date.now() + secs(BETWEEN_PAGES);
      saveFill(job);
      renderFill(job, words + ' — loading it again');
      return runFill();
    }
    brandIssue(job, code, words);
  }
  // LinkedIn says this account has no Sales Navigator. Every brand goes
  // through it now, so the run stops for Leo instead of reading the People
  // tab (an older copy switched to it for the rest of the run).
  function snNoAccount(job, why) {
    pauseFill(job, why + '. Open Sales Navigator in this window once (sign in, pick the contract if it asks), then press Continue.');
  }
  // Sales Navigator back on for a run that switched it off (the panel's
  // button, and by itself for a run an older copy switched off on a page
  // that didn't load) — never against the setup panel's switch.
  function snBackOn(job) {
    if (!job || job.salesNav !== false || !job.snOff || !snWanted()) return false;
    job.salesNav = true; job.snOff = null; job.snNoAccount = false;
    return true;
  }
  function snTurnOn() {
    var job = loadFill();
    if (!job || !ownsFill(job)) return;
    if (job.salesNav === false) { job.salesNav = true; job.snOff = null; job.snNoAccount = false; }
    try { GM_setValue(SN_KEY, true); } catch (e) {}
    saveFill(job);
    renderFill(job, 'Sales Navigator back on — from the next brand.');
  }

  function fillSales(item) {
    var job = loadFill(), at0 = job.at, st0 = job.step;
    var search = SN_SEARCHES[st0.snI], page = st0.snPage;
    renderFill(job, 'Reading Sales Navigator — ' + item.name + ' · ' + search.label + (page > 1 ? ' (page ' + page + ')' : ''));
    fillHalt = { stopped: false };
    readPath = location.pathname;
    var got = null, rows = [], problem = null, sample = null, short = null, totalN = null;
    var atParent = st0.snFrom === 'parent';
    waitFor(function () { return snLinks().length || snHiddenLeaves().length || SN_EMPTY.test(pageText(6000)) || !onSalesSearch(); }, document.hidden ? 60000 : 30000).then(function () {
      if (!sameStep(loadFill(), at0)) return null;
      var stop = linkedinSaysStop();
      if (stop) return { halt: stop };
      if (!onSalesSearch()) return { fail: snWhyNot() || { code: 'snLeft', text: 'Sales Navigator left its search page', reload: true } };
      if (!snLinks().length && !snHiddenLeaves().length && !SN_EMPTY.test(pageText(6000))) return { fail: { code: 'snNoLoad', text: 'Sales Navigator\'s results did not load', reload: true } };
      return snExpand(fillHalt).then(function () { return {}; });
    }).then(function (res) {
      if (!res) return null;
      if (res.halt || res.fail) return res;
      if (location.pathname !== readPath) { readPath = null; later(runFill, 3000); return null; }
      readPath = null;
      var stop = linkedinSaysStop();
      if (stop) return { halt: stop };
      got = snRead();
      // All of this page drawn? Sales Navigator says how many results there
      // are; a page short of its share is loaded once more, then counted as
      // a read that didn't get everyone (the brand comes back for it).
      var total = totalN = snTotal(), seenHere = got.cards;
      var expect = total == null ? null : Math.max(0, Math.min(SN_PAGE_SIZE, total - (page - 1) * SN_PAGE_SIZE));
      if (expect != null && seenHere + 1 < expect) {
        short = { seen: seenHere, expect: expect };
        if (!(st0.snReloads >= 1)) return { fail: { code: 'partial', text: 'Sales Navigator drew ' + seenHere + ' of ' + expect + ' on this page', reload: true } };
      }
      // Every result should be the brand (the company filter). Mostly
      // someone else's: the id was wrong — save nobody.
      var names = [st0.pageName, item.name, akaName(item), atParent ? item.parent.name : null].filter(Boolean);
      var named = got.rows.filter(function (r) { return r.company; });
      var off = named.filter(function (r) { return !sameCompany(r.company, names); });
      if (named.length >= 3 && off.length * 2 > named.length) {
        return { fail: { code: 'snOtherCompany', text: 'Sales Navigator showed another company\'s people (' + off[0].company + ')' } };
      }
      rows = got.rows.filter(function (r) { return off.indexOf(r) < 0; }).map(function (r) {
        return { name: r.name, headline: r.title + (r.title && r.company ? ' at ' + r.company : ''), linkedinUrl: r.linkedinUrl };
      });
      problem = snReadingProblem(got);
      if (problem) sample = sampleText(1500);
      return runPost({
        action: 'liCapture', brandId: item.brandId,
        // The brand's own page, never Sales Navigator's address: the
        // dashboard may save it as the brand's page. Under a parent: the
        // parent's page, said to be the parent's (never saved on the brand).
        companyUrl: atParent ? stepPage(item, st0) : item.linkedinUrl, companyName: item.name, companyIndustry: atParent ? '' : st0.industry || '',
        viaParent: atParent,
        // A big company skipped its People tab's read, so its page is
        // checked here, once.
        checkPage: st0.snFrom === 'big' && !st0.pageChecked, rows: rows,
      });
    }).then(function (r) {
      if (!r) return;
      var job2 = loadFill();
      if (!sameStep(job2, at0)) return;
      if (r.halt) return pauseFill(job2, r.halt + '. Leave LinkedIn alone for a day before pressing Continue.');
      if (r.fail) {
        if (r.fail.pause) return pauseFill(job2, r.fail.pause);
        if (r.fail.wholeRun) return snNoAccount(job2, r.fail.text);
        return snTrouble(job2, r.fail.code, r.fail.text, r.fail.reload);
      }
      if (!r.ok) return brandIssue(job2, 'save', r.error || 'the dashboard did not save');
      var st = job2.step;
      if (r.pageMismatch) {
        if (st.recheck) return finishBrand(job2, 'its saved LinkedIn page looks like another company (' + r.industry + ') — pick the right one on Outreach → People');
        job2.step = { phase: 'search', recheck: true, pass: 0, triedAka: false, seen: st.seen, added: st.added, navs: 0, startedAt: st.startedAt, hiddenMs: st.hiddenMs || 0 };
        job2.nextAt = Date.now() + secs(BETWEEN_PAGES);
        saveFill(job2);
        return runFill();
      }
      st.pageChecked = true;
      job2.snFails = 0;
      var seenUrls = st.seenUrls || [];
      rows.forEach(function (x) { if (seenUrls.indexOf(x.linkedinUrl) < 0) seenUrls.push(x.linkedinUrl); });
      st.seenUrls = seenUrls;
      st.seen = Math.max(st.seen || 0, seenUrls.length);
      st.added += r.added || 0;
      job2.added = (job2.added || 0) + (r.added || 0);
      if (problem && !st.problem) { st.problem = problem; st.sample = sample; }
      // Who Sales Navigator still couldn't name. Sent as the People tab's
      // matching view, which is what Zach can open on his account.
      if (got.hidden.length) {
        (st.snHid = st.snHid || []).push(atParent
          ? { q: item.name, url: peopleUrl(stepPage(item, st0), item.name), heads: got.hidden.slice(0, 60) }
          : { q: search.q, url: peopleUrl(item.linkedinUrl, search.q), heads: got.hidden.slice(0, 60) });
      }
      st.snRead = (st.snRead || 0) + 1;
      // What Sales Navigator showed vs what was read, for the dashboard.
      var shown = got.cards;
      st.snShown = (st.snShown || 0) + (short ? short.expect : shown);
      st.snSeen = (st.snSeen || 0) + shown;
      if (short && !st.partial) st.partial = 'read ' + short.seen + ' of ' + short.expect + ' on Sales Navigator’s ' + search.label + (page > 1 ? ' page ' + page : '') + ' (loaded twice)';
      st.snReloads = 0;
      var full = r.have >= r.cap;
      if (full) st.full = true;
      // The next page while this one was full — or Sales Navigator's count
      // says there's more than a short page showed.
      if (!full && page < search.pages && (shown >= SN_PAGE_SIZE || (totalN != null && page * SN_PAGE_SIZE < totalN))) { st.snPage++; st.navs = 0; }
      else if (!full && st.snI < SN_SEARCHES.length - 1 && !(st.members != null && st.members < SN_SMALL)) { st.snI++; st.snPage = 1; st.navs = 0; }
      else {
        // Done. Sales Navigator named whoever it could, so the hidden
        // people that count now are the ones it still couldn't.
        st.salesNav = true; st.snVia = st0.snFrom;
        st.hidViews = st.snHid || [];
        st.hidRead = (st.hidRead || 0) + 1;
        return afterPeople(job2, item);
      }
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
    if (leoIsElsewhere(job)) {
      renderFill(job, 'You\'re using this window — it carries on a minute after you stop.');
      return later(runFill, 5000);
    }
    ds.navs++;
    renderFill(job, 'Searching LinkedIn for new “' + ds.q + '” brands' + (ds.page > 1 ? ' (page ' + ds.page + ')' : '') + '…');
    goTo(job, searchUrl(ds.q) + (ds.page > 1 ? '&page=' + ds.page : ''));
  }

  function fillDiscoverSearch() {
    var job = loadFill(), ds = job.searches[0], found = [];
    renderFill(job, 'Reading LinkedIn\'s “' + ds.q + '” results');
    waitFor(function () { return searchCandidates().length || /no results/i.test(pageText(5000)); }, 12000).then(function () {
      var stop = linkedinSaysStop();
      if (stop) return { halt: stop };
      found = searchCandidates();
      return runPost({ action: 'liDiscover', source: 'search', from: ds.q, companies: found });
    }).then(function (r) {
      var job2 = loadFill();
      var d0 = job2 && job2.searches && job2.searches[0];
      if (!inCharge(job2) || job2.paused || !d0 || d0.q !== ds.q || d0.page !== ds.page) return;
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
  // brands — only when LinkedIn shows them on the page it's already on.
  // The extra stop at every company's home page to find them cost a page
  // and most of a minute per brand (Leo, Sep 2026: "only when free").
  function afterPeople(job, item) {
    // Not from a parent's page, and not twice for a brand's second try.
    if (!job.lookalikes || (job.step && job.step.kind === 'parent') || item.again) return endBrand(job, null);
    // Read on the People tab before the run left it for Sales Navigator.
    var here = job.step && job.step.look ? job.step.look : lookalikes();
    // saveLookalikes re-reads the run, so this brand's counts must be
    // saved first (they weren't: a brand with lookalikes logged 0 added).
    if (here.length) { saveFill(job); return saveLookalikes(item, here); }
    endBrand(job, null);
  }

  function saveLookalikes(item, found) {
    var job = loadFill();
    if (!job || !sameStep(job, job.at) || job.items[job.at].brandId !== item.brandId) return;
    var at0 = job.at;
    if (!found.length) return endBrand(job, null);
    var stop = linkedinSaysStop();
    if (stop) return pauseFill(job, stop + '. Leave LinkedIn alone for a day before pressing Continue.');
    runPost({ action: 'liDiscover', source: 'lookalike', from: item.name, fromBrandId: item.brandId, companies: found }).then(function (r) {
      var job2 = loadFill();
      if (!sameStep(job2, at0)) return;
      // Brands → Discover, To review (Leo, Oct 14 2026) — never brands the
      // run reads by itself: the last run's lookalikes chained into therapy
      // apps and grocery chains and took most of its day.
      var n = r && r.ok && Array.isArray(r.review) ? r.review.length : 0;
      if (n) { job2.reviewSent = (job2.reviewSent || 0) + n; job2.step.review = n; }
      endBrand(job2, null);
    }).catch(fillError);
  }

  function finishBrand(job, note, quick) {
    flushHidden(job);
    var item = job.items[job.at];
    var st = job.step || { seen: 0, added: 0 };
    // How its people were found — and, when none were, where it looked.
    var via = null;
    if (st.kind === 'parent' && item.parent) {
      via = 'via ' + item.parent.name;
      if (!st.added && !note) note = (st.ownNote ? st.ownNote + '; ' : '') + 'nobody at ' + item.parent.name + ' mentions it';
    } else if (st.kind === 'big') {
      var searched = (st.passes || []).slice(0, (st.pass || 0) + 1).join(', ');
      var size = (st.members || 0).toLocaleString('en-US') + ' people';
      via = 'big company, ' + size + ': searched ' + searched;
      if (!st.added && !note) note = 'big company (' + size + ') — nobody new in its ' + searched + ' searches';
    }
    if (st.kind === 'parent' && st.snVia === 'parent') via = 'Sales Navigator via ' + item.parent.name;
    else if (st.salesNav && st.kind !== 'parent') via = 'Sales Navigator' + (st.snFrom === 'big' ? ', big company (' + (st.members || 0).toLocaleString('en-US') + ' people)' : '');
    // What went wrong, if anything (1.38): an issue stopped the read, or a
    // Sales Navigator page drew only part of its results twice.
    var issue = st.issue || (st.partial ? 'partial' : null);
    var issueNote = st.issueNote || st.partial || null;
    if (issue && !note && issue === 'partial') note = issueNote;
    // A first try that went wrong goes again at the end of this run.
    var again = !!issue && !item.again;
    // Every item goes in the run's report; the server's visit log (which
    // decides whether a brand is read again) only takes the ones with a
    // brandId — a research name that never became a brand is logged by
    // liResearch.
    var swept = runPost({
      action: 'liSwept', brandId: item.brandId || null, run: job.id, script: VERSION, name: item.name,
      seen: st.seen, added: st.added, note: note || '', problem: st.problem || null, sample: st.sample || null,
      ms: st.startedAt ? Date.now() - st.startedAt : null, hiddenMs: st.hiddenMs || 0,
      via: via, members: st.members || null, parentTried: !!st.parentTried,
      // Read through Sales Navigator: the brand's hidden people had their
      // chance to be named.
      salesNav: !!st.salesNav,
      // done = it read everything it meant to (Sales Navigator to the end, or
      // 25 on file); with no issue the dashboard never brings it back by itself.
      done: !!st.salesNav || !!st.full, issue: issue, issueNote: issueNote,
      skipped: st.skip || null, shown: st.snShown != null ? st.snShown : null, read: st.snSeen != null ? st.snSeen : null,
      again: !!item.again, review: st.review || 0,
      // One key per post: a post retried after a timeout counts once.
      key: job.id + ':' + job.at + ':' + (item.brandId || item.name),
      // People LinkedIn hid from this account, view by view — only when a
      // view was read (no page read says nothing about who's hidden).
      hidden: st.hidRead ? (st.hidViews || []) : undefined,
    }).catch(function () {});
    job.results.push({ name: item.name, added: st.added, note: note || null, via: via, hidden: hiddenTotal(st.hidViews), issue: !!issue, again: !!item.again });
    if (again) job.items.push(Object.assign({}, item, { again: 1, againWhy: issueNote || note || 'its first try went wrong' }));
    job.at++;
    job.step = null;
    job.doneToday++;
    job.nextAt = Date.now() + secs(quick ? BETWEEN_PAGES : BETWEEN_BRANDS);
    if (job.doneToday >= DAILY_CAP && job.at < job.items.length) job.pausedUntil = tomorrowMorning();
    saveFill(job);
    // The last brand's visit mark lands before the run says it's finished
    // (up to 15 s): a run started right after would otherwise redo it.
    if (job.at >= job.items.length) {
      Promise.race([swept, new Promise(function (r) { setTimeout(r, 15000); })]).then(function () { runFill(); });
    } else runFill();
  }

  function finishFill(job, stopped) {
    clearTimeout(fillTimer);
    fillHalt.stopped = true;
    clearFill();
    runEvent(job, 'finish', { stopped: !!stopped, newBrands: (job.newBrands || []).length, hiddenMs: job.hiddenMs || 0 });
    var results = job.results || [];
    // A brand tried twice shows its last try.
    var lastOf = {};
    results.forEach(function (r) { lastOf[r.name] = r; });
    var issues = results.filter(function (r) { return r.issue && lastOf[r.name] === r; });
    var problems = results.filter(function (r) { return r.note && !r.issue; });
    var hiddenAt = results.filter(function (r) { return r.hidden; });
    freshPanel([
      head(stopped ? 'Run stopped' : 'Run finished'),
      h('div', { style: 'margin-bottom:6px' }, [b(String(job.added || 0)), ' people added across ' + results.length + ' brands.']),
      // Every brand it went through, in order (Leo: "after every run I
      // want a list of what it did"). Names of the people: the dashboard.
      results.length
        ? h('details', { open: true, style: 'display:block;margin-top:6px' }, [
            h('summary', { style: 'display:list-item;cursor:pointer;font-weight:600', text: 'What it did' }),
            h('div', { id: 'sblidid', style: 'font-size:12px;margin-top:4px;max-height:220px;overflow:auto' }, results.map(function (r) {
              return h('div', { style: 'padding:2px 0' }, [
                r.name,
                h('span', { style: 'color:' + (r.added ? '#137333' : '#777'), text: ' — ' + (r.added ? r.added + ' added' + (r.via ? ' (' + r.via + ')' : '') : r.note || 'nobody new') }),
                r.hidden ? h('span', { style: 'color:#946200', text: ' · ' + r.hidden + ' hidden' }) : null,
              ]);
            })),
          ])
        : null,
      (job.newBrands || []).length
        ? h('details', { style: 'display:block;margin-top:6px' }, [
            h('summary', { style: 'display:list-item;cursor:pointer;font-weight:600;color:#137333', text: job.newBrands.length + (job.newBrands.length === 1 ? ' new brand added' : ' new brands added') }),
            h('div', { style: 'font-size:12px;margin-top:4px;max-height:160px;overflow:auto', text: job.newBrands.join(', ') }),
          ])
        : null,
      job.reviewSent
        ? h('div', { id: 'sblireviewdone', style: 'font-size:12px;margin-top:6px;color:#555', text: job.reviewSent + ' similar page' + (job.reviewSent === 1 ? '' : 's') + ' sent to Brands → Discover — add the ones you want there.' })
        : null,
      issues.length
        ? h('details', { open: true, style: 'display:block;margin-top:6px' }, [
            h('summary', { style: 'display:list-item;cursor:pointer;font-weight:600;color:#946200', text: 'Went wrong — first on the next run (' + issues.length + ')' }),
            h('div', { id: 'sbliissues', style: 'font-size:12px;margin-top:4px;max-height:160px;overflow:auto' }, issues.map(function (r) {
              return h('div', { style: 'padding:2px 0' }, [r.name, h('span', { style: 'color:#777', text: ' — ' + (r.note || 'something went wrong') + (r.again ? ' (twice)' : '') })]);
            })),
          ])
        : null,
      // Leo, Oct 7 2026: "i dont want to miss out on people if i do it from
      // my own account" — the ones LinkedIn hid wait for Zach's account.
      hiddenAt.length
        ? h('div', { id: 'sblihiddenppl', style: 'font-size:12px;margin-top:8px;color:#946200', text: hiddenAt.length + (hiddenAt.length === 1 ? ' brand had' : ' brands had') + ' people LinkedIn hid from your account. The ones who look like buyers are on “Read on Zach\'s LinkedIn” (dashboard → Outreach → People).' })
        : null,
      problems.length
        ? h('details', { open: true, style: 'display:block;margin-top:6px' }, [
            h('summary', { style: 'display:list-item;cursor:pointer;font-weight:600;color:#946200', text: 'Do these by hand (' + problems.length + ')' }),
            h('div', { style: 'font-size:12px;margin-top:4px;max-height:200px;overflow:auto' }, problems.map(function (r) {
              return h('div', { style: 'padding:2px 0' }, [r.name, h('span', { style: 'color:#777', text: ' — ' + r.note })]);
            })),
          ])
        : null,
      h('a', { href: DASH_URL + '#people', target: '_blank', rel: 'noopener', style: BTN2 + ';margin-top:10px', text: 'The full list, with names, on the dashboard ↗' }),
      h('div', { style: SMALL, text: stopped
        ? 'Nothing saved is undone. Start again any time — brands it read in full aren\'t read again; ones that went wrong go first.'
        : 'Brands it couldn\'t do are still in Under 25 — open their People tab and press the pill.' }),
    ]);
  }

  function pauseByHand() {
    var job = loadFill();
    if (job && ownsFill(job) && !job.paused) pauseFill(job, 'you paused it. Press Continue to carry on.');
  }

  function stopFill() {
    var job = loadFill();
    if (job) finishFill(job, true); else closePanel();
  }

  function continueFill() {
    var job = loadFill();
    if (!job) return closePanel();
    job.owner = tabId();
    job.runner = PAGE_NONCE;
    job.paused = null;
    if (job.step) job.step.navs = 0;
    job.nextAt = 0;
    if (!job.snNoAccount) snBackOn(job);
    saveFill(job);
    runEvent(job, 'resume');
    fillHalt = { stopped: false };
    runFill();
  }

  // Leo using the run's window (Sep 2026: "it keeps stopping every time I
  // click"). Clicks, keys, scrolling never pause the run now — only its
  // Pause button does. They're only noted (for this tab, across page
  // loads): while Leo used the window in the last minute, the run doesn't
  // take it to another page, and a read whose page he moved away from is
  // dropped and redone when he's done.
  var HUMAN_KEY = 'sbLiHuman';
  var IDLE_MS = 60000;
  function onHuman(e) {
    if (!e.isTrusted) return;
    var t = e.target;
    if (t && t.closest && t.closest('.sb-li-ui')) return;
    try { sessionStorage.setItem(HUMAN_KEY, String(Date.now())); } catch (err) {}
  }
  function humanBusy() {
    var at = 0;
    try { at = Number(sessionStorage.getItem(HUMAN_KEY)) || 0; } catch (e) {}
    return Date.now() - at < IDLE_MS;
  }
  // Leo has taken the window somewhere the run didn't send it, and used it
  // in the last minute: leave him be. On the run's own page (he only
  // clicked or scrolled) the run carries straight on.
  function leoIsElsewhere(job) {
    return !!(job && job.navPath) && location.pathname !== job.navPath && humanBusy();
  }
  function goTo(job, url) {
    try { job.navPath = new URL(url, location.href).pathname; } catch (e) { job.navPath = null; }
    saveFill(job);
    later(function () { location.href = url; }, rand(1500, 3500));
  }
  ['mousedown', 'keydown', 'wheel', 'touchstart'].forEach(function (ev) {
    document.addEventListener(ev, onHuman, { capture: true, passive: true });
  });
  // The page a read started on; if it changes under the read, stop it.
  var readPath = null;

  function setFillStatus(text) { if (fillStatusEl) fillStatusEl.textContent = text; }

  // Rebuilt only when something visible changes; the countdown and the
  // scroll count just update the status line.
  // Why a brand is where it is in the line (Leo, Sep 2026: "why is Native
  // under electrolyte brands" — it was on the Schedule, which goes first).
  function whyItem(job, item) {
    if (!item) return '';
    var w = whyItemBase(job, item);
    return item.fit != null && !item.research ? w + ' · Brand Fit ' + item.fit : w;
  }
  function whyItemBase(job, item) {
    if (item.planned) {
      var d = new Date(item.planned + 'T12:00:00');
      return 'on the Schedule for ' + d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + ' and short on people';
    }
    if (item.research) return 'from the research list' + (item.lane ? ' (' + item.lane + ')' : '');
    if (item.again) return 'trying it again — ' + (item.againWhy || 'its first try went wrong');
    if (item.retry) return 'read again first — ' + (item.issueText || 'its last read went wrong') + (item.tries > 1 ? ' (try ' + (item.tries + 1) + ')' : '');
    if (item.hiddenRetry) return 'read before without Sales Navigator — back for it';
    // Mid-size first (Leo, Oct 12 2026): the size leads the reason.
    if (job.midFirst && item.size) {
      var sw = { target: 'a mid-size brand', unknown: 'size not measured yet', small: 'a small brand', big: 'a big company (500–1,499)' }[item.size];
      if (sw) return sw + (item.members != null ? ', ' + item.members.toLocaleString('en-US') + ' on LinkedIn' : '') +
        (item.noBuyer ? ' — no marketing / partnerships person yet' : '') + (item.focus ? ' (a “' + (job.focus || 'focus') + '” brand)' : '');
    }
    // Brands with nobody in marketing / partnerships go right after the
    // Schedule's (the dashboard's liList puts them there).
    if (item.noBuyer) return 'no marketing / partnerships person on file yet' + (item.focus ? ' (a “' + (job.focus || 'focus') + '” brand)' : '');
    if (item.focus) return 'a “' + (job.focus || 'focus') + '” brand';
    var sz = { target: 'a target brand (mid-size)', small: 'a small brand', big: 'a big company — they go last' }[item.size];
    if (sz) return sz + (item.members != null ? ', ' + item.members.toLocaleString('en-US') + ' on LinkedIn' : '');
    return 'under 25 people, emptiest first';
  }

  function renderFill(job, status) {
    if (!job) return;
    var hiddenMin = Math.floor((job.hiddenMs || 0) / 60000);
    var key = [job.at, job.added, job.doneToday, job.paused, job.pausedUntil, (job.newBrands || []).length, job.items.length, hiddenMin, job.salesNav, job.snOff, job.reviewSent || 0].join('|');
    if (panel && panel.getAttribute('data-fill') === key && fillStatusEl && fillStatusEl.isConnected) {
      return setFillStatus(status);
    }
    var n = job.items.length, at = Math.min(job.at, n);
    var focusN = job.items.filter(function (i) { return i.focus && !i.planned; }).length;
    var plannedN = job.items.filter(function (i) { return i.planned; }).length;
    var isGap = function (i) { return i.noBuyer && !i.planned && !i.research; };
    // Mid-size first: the brands that lead the run, instead of the no-buyer ones.
    if (job.midFirst) isGap = function (i) { return i.size === 'target' && !i.planned && !i.research; };
    var gapN = job.items.filter(isGap).length;
    var doneOf = function (test) { return job.items.slice(0, at).filter(test).length; };
    var pct = n ? Math.round(at / n * 100) : 100;
    var cur = at < n ? job.items[at] : null;
    fillStatusEl = h('div', { style: 'font-size:12px;margin:8px 0;color:' + (job.paused ? '#b00' : '#555'), text: status });
    var p = freshPanel([
      head('Filling brands from LinkedIn'),
      h('div', { style: 'margin-bottom:4px' }, [b(String(at)), ' of ' + n + ' brands · ', b(String(job.added || 0)), ' people added']),
      plannedN ? h('div', { style: 'font-size:12px;color:#555', text: 'First, the Schedule\'s brands that are short on people: ' + doneOf(function (i) { return i.planned; }) + ' of ' + plannedN + ' done' }) : null,
      gapN ? h('div', { id: 'sbligap', style: 'font-size:12px;color:#555', text: (plannedN ? 'Then ' : 'First, ') + (job.midFirst ? 'mid-size brands: ' : 'brands with no marketing / partnerships person yet: ') + doneOf(isGap) + ' of ' + gapN + ' done' }) : null,
      focusN ? h('div', { style: 'font-size:12px;color:#555', text: (plannedN || gapN ? 'Then ' : '') + '“' + (job.focus || 'focus') + '” brands: ' + doneOf(function (i) { return i.focus && !i.planned; }) + ' of ' + focusN + ' done' }) : null,
      cur ? h('div', { id: 'sblinow', style: 'font-size:12px;color:#111;margin-top:4px' }, [b(cur.name), ' — ' + whyItem(job, cur)]) : null,
      h('div', { style: 'font-size:12px;color:#555', text: 'Today: ' + job.doneToday + ' of ' + DAILY_CAP + ' brands' }),
      h('div', { id: 'sblisnline', style: 'font-size:12px;color:' + (job.snOff ? '#946200' : '#555'), text: job.salesNav ? 'Every brand through Sales Navigator; one that goes wrong is tried again at the end'
        : job.snOff ? 'Sales Navigator off for this run: ' + job.snOff + ' — using the People tab' : 'Marketing / partnerships people from the People tab (Sales Navigator is off)' }),
      job.salesNav === false ? h('button', { id: 'sblisnon', style: BTN2 + ';margin-top:6px', text: 'Use Sales Navigator again', onclick: guard(snTurnOn) }) : null,
      (job.newBrands || []).length ? h('div', { style: 'font-size:12px;color:#137333', text: job.newBrands.length + ' new brand' + (job.newBrands.length === 1 ? '' : 's') + ' found and added' }) : null,
      job.reviewSent ? h('div', { id: 'sblireview', style: 'font-size:12px;color:#555', text: job.reviewSent + ' similar page' + (job.reviewSent === 1 ? '' : 's') + ' sent to Brands → Discover for review' }) : null,
      h('div', { style: 'height:6px;background:#eee;border-radius:99px;overflow:hidden;margin-top:6px' }, [
        h('div', { style: 'height:100%;width:' + pct + '%;background:#111' }),
      ]),
      fillStatusEl,
      hiddenMin >= 2
        ? h('div', { id: 'sblihidden', style: 'font-size:12px;margin:0 0 8px;padding:6px 8px;border-radius:6px;background:#fff4e5;color:#7a4b00', text: 'Slowed while this window was hidden: ' + hiddenMin + ' min so far. Keep it in view — a corner showing is enough; minimized or fully covered, Chrome slows it.' })
        : null,
      job.paused
        ? h('button', { id: 'sblifillgo', style: BTN, text: 'Continue', onclick: continueFill })
        : h('button', { id: 'sblifillpause', style: BTN2, text: 'Pause', onclick: pauseByHand }),
      h('button', { id: 'sblifillstop', style: BTN2 + ';margin-top:6px;color:#b00', text: 'Stop the run', onclick: stopFill }),
      h('div', { style: SMALL, text: 'Clicking, scrolling or typing here doesn\'t stop it; if you open another page in this window, it waits until you\'ve left it alone for a minute, then goes back. About ' + DAILY_CAP + ' brands a day. It pauses by itself if LinkedIn shows a check or a limit.' }),
    ]);
    p.setAttribute('data-fill', key);
  }

  // opts.auto: opened by the dashboard's "Start the LinkedIn fill" — load
  // the list and start with what's on the panel, no further click.
  function openFillSetup(opts) {
    var startNow = !!(opts && opts.auto);
    if (!HAS_GM) return openBroken();
    if (!token()) return openSetup();
    var job = loadFill();
    if (job && !job.done && !ownsFill(job) && staleFill(job)) job = null;
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
    var snBox = h('input', { type: 'checkbox', id: 'sblisalesnav', checked: snWanted(), style: 'margin:2px 0 0' });
    // Only brands that score well on Brand Fit (the dashboard's ratings;
    // Leo, Oct 12 2026: "only fill in the brands that score highly").
    var fitBox = h('input', {
      id: 'sbliminfit', type: 'number', min: '0', max: '100', value: String(minFitWanted()),
      style: 'width:56px;padding:4px 6px;border:1px solid #ccc;border-radius:6px;font:12.5px system-ui;color:#111;background:#fff',
    });
    var bigBox = h('input', { type: 'checkbox', id: 'sbliskipbig', checked: skipBigWanted(), style: 'margin:2px 0 0' });
    bigBox.onchange = function () { try { GM_setValue(BIG_KEY, bigBox.checked); } catch (e) {} };
    fitBox.onchange = function () { try { GM_setValue(FIT_KEY, Math.max(0, Math.min(100, Number(fitBox.value) || 0))); } catch (e) {} };
    snBox.onchange = function () { try { GM_setValue(SN_KEY, snBox.checked); } catch (e) {} };
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
        salesNav: snBox.checked,
        skipBig: bigBox.checked,
        words: words.value.split(/[,;]/).map(function (w) { return w.trim(); }).filter(Boolean).slice(0, 5),
      };
    };
    var out = h('div', { style: 'margin-top:10px' });
    var look = function () {
      var f = focus.value.trim();
      out.textContent = 'Getting the list…';
      post({ action: 'liList', focus: f, research: researchBox.checked, salesNav: snBox.checked, minFit: Math.max(0, Math.min(100, Number(fitBox.value) || 0)), skipGiants: bigBox.checked }).then(function (j) {
        while (out.firstChild) out.removeChild(out.firstChild);
        if (!j || !j.ok) { out.textContent = (j && j.error) || 'Could not get the list.'; return; }
        if (!j.items.length) {
          var dn = discoverNow();
          out.appendChild(h('div', { style: MUTED, text: 'Every brand is full, off outreach, or resting after a recent visit.' + (dn.words.length ? ' It can still search for new brands.' : ' Nothing to do.') }));
          if (dn.words.length) out.appendChild(h('button', { id: 'sblifillstart', style: BTN, text: 'Search for new brands', onclick: function () { startFill([], f, discoverNow()); } }));
          else startNow = false;
          if (startNow) { startNow = false; startFill([], f, discoverNow()); }
          return;
        }
        var first = j.items.filter(function (i) { return i.focus; });
        var have = j.items.length - (j.research || 0);
        out.appendChild(h('div', { style: MUTED }, [b(String(have)), ' brands under ' + j.cap + ' people' +
          (j.research ? ', plus ' : '.'), j.research ? b(String(j.research)) : null, j.research ? ' names from the research list to find on LinkedIn.' : null]));
        // The dashboard puts the brands with no marketing / partnerships
        // person right after the Schedule's (Leo, Oct 2026: every brand
        // gets one); the focus word orders brands within each group.
        var gap = j.noBuyer || 0;
        if (j.midFirst) out.appendChild(h('div', { id: 'sblimidnote', style: 'font-size:12px;color:#111;margin-bottom:6px', text: (j.planned ? 'After the Schedule\'s ' + j.planned + ' brand' + (j.planned === 1 ? '' : 's') + ' short on people: m' : 'M') +
          'id-size brands first' + (j.sizes ? ' (' + j.sizes.target + ', 20–499 on LinkedIn), then ' + j.sizes.unknown + ' not measured yet, ' + j.sizes.small + ' small, ' + j.sizes.big + ' big (500–1,499)' : '') +
          '. Within each, brands with no marketing / partnerships person first, then best Brand Fit.' }));
        if (gap && !j.midFirst) out.appendChild(h('div', { id: 'sbligapnote', style: 'font-size:12px;color:#111;margin-bottom:6px', text: (j.planned ? 'After the Schedule\'s ' + j.planned + ' brand' + (j.planned === 1 ? '' : 's') + ' short on people, the ' : 'First the ') +
          gap + ' brand' + (gap === 1 ? '' : 's') + ' with no marketing / partnerships person on file yet — so every brand gets one. Then the rest, up to 25 people each.' }));
        if (f) out.appendChild(h('div', { style: 'font-size:12px;color:#555;margin-bottom:6px', text: first.length
          ? (gap ? 'Within each, the ' + first.length + ' matching “' + f + '” go first: ' : 'First the ' + first.length + ' matching “' + f + '”: ') +
            first.slice(0, 15).map(function (i) { return i.name; }).join(', ') + (first.length > 15 ? '…' : '') + (gap ? '.' : '. Then everything else, emptiest first.')
          : 'None match “' + f + '” — it goes emptiest first.' }));
        if (j.sizes && !j.midFirst) out.appendChild(h('div', { style: 'font-size:12px;color:#555;margin-bottom:6px', text: 'Then by size: ' + j.sizes.target + ' target (mid-size, 20–499 on LinkedIn), ' + j.sizes.unknown + ' not measured yet, ' + j.sizes.small + ' small, ' + j.sizes.big + ' big companies last.' }));
        if (j.noPage) out.appendChild(h('div', { style: 'font-size:12px;color:#555;margin-bottom:6px', text: j.noPage + ' have no LinkedIn page saved; it searches LinkedIn for those and only uses a clear match.' }));
        if (j.minFit) out.appendChild(h('div', { id: 'sblifitnote', style: 'font-size:12px;color:#555;margin-bottom:6px', text: 'Only brands with Brand Fit ' + j.minFit + '+' + (j.belowFit ? ' — ' + j.belowFit + ' lower-scoring, too small or Skip brands left out' : '') + '. The Schedule\'s brands always go.' }));
        if (j.bigSkipped) out.appendChild(h('div', { id: 'sblibignote', style: 'font-size:12px;color:#555;margin-bottom:6px', text: j.bigSkipped + ' very big brands skipped (household names, big parent companies, 1,500+ on LinkedIn).' }));
        var again = j.retry != null ? j.retry : j.hiddenRetry;
        if (again) out.appendChild(h('div', { id: 'sblisnretry', style: 'font-size:12px;color:#555;margin-bottom:6px', text: again + ' brand' + (again === 1 ? '' : 's') + ' whose last read went wrong (or never went through Sales Navigator) go first, right after the Schedule\'s.' }));
        if (j.resting) out.appendChild(h('div', { id: 'sbliresting', style: 'font-size:12px;color:#555;margin-bottom:6px', text: j.resting + ' left out: read already — a brand read in full isn\'t read again by itself' + (j.stuck ? '; ' + j.stuck + ' went wrong 3 runs in a row and wait a month' : '') + '.' }));
        if (j.researchWaiting) out.appendChild(h('div', { style: 'font-size:12px;color:#555;margin-bottom:6px', text: j.researchWaiting + ' research names left out: LinkedIn had no clear page for them last month.' }));
        out.appendChild(h('div', { style: 'font-size:12px;color:#555;margin-bottom:8px', text: 'At about ' + DAILY_CAP + ' a day that is roughly ' + Math.ceil(j.items.length / DAILY_CAP) + ' day(s).' }));
        out.appendChild(h('button', { id: 'sblifillstart', style: BTN, text: 'Start', onclick: function () { startFill(j.items, f, Object.assign(discoverNow(), { midFirst: !!j.midFirst })); } }));
        if (startNow) { startNow = false; startFill(j.items, f, Object.assign(discoverNow(), { midFirst: !!j.midFirst })); }
      }).catch(function (e) { out.textContent = e.message; });
    };
    focus.onkeydown = function (e) { if (e.key === 'Enter') look(); };
    freshPanel([
      head('Fill brands by itself'),
      h('div', { style: MUTED, text: 'Goes through every brand under 25 people — the ones with no marketing / partnerships person first — one at a time in this tab, and saves the buyers it finds. About ' + DAILY_CAP + ' brands a day, under a minute apart. It pauses if LinkedIn shows a check or a limit.' }),
      h('div', { style: 'font-size:12px;color:#555;margin-bottom:4px', text: 'Start with brands matching (optional):' }),
      h('div', { style: 'display:flex;gap:6px' }, [
        focus,
        h('button', {
          id: 'sblifilllook', text: 'See the list', onclick: look,
          style: 'background:#fff;color:#111;border:1px solid #ccc;border-radius:6px;padding:5px 10px;cursor:pointer;font:12.5px system-ui',
        }),
      ]),
      h('label', { style: 'display:flex;gap:7px;align-items:center;font-size:12px;color:#333;margin-top:10px' }, [
        h('span', { text: 'Only brands with Brand Fit of at least' }), fitBox,
        h('span', { style: 'color:#777', text: '(0 = every brand)' }),
      ]),
      h('label', { style: 'display:flex;gap:7px;align-items:flex-start;font-size:12px;color:#333;cursor:pointer;margin-top:8px' }, [
        bigBox,
        h('span', { text: 'Skip very big brands — household names, brands of the big parent companies (Diageo, Pernod Ricard…), $1B+ sales or 1,500+ on LinkedIn' }),
      ]),
      h('label', { style: 'display:flex;gap:7px;align-items:flex-start;font-size:12px;color:#333;cursor:pointer;margin-top:10px' }, [
        snBox,
        h('span', { text: 'Use Sales Navigator for every brand — it names people your LinkedIn shows as "LinkedIn Member". A brand it can\'t read is tried again at the end of the run, and first on the next. Untick to use the People tab instead.' }),
      ]),
      h('div', { style: 'margin-top:12px;padding-top:10px;border-top:1px solid #eee' }, [
        h('div', { style: 'font-weight:600;margin-bottom:6px', text: 'Find new brands too' }),
        h('label', { style: 'display:flex;gap:7px;align-items:flex-start;font-size:12px;color:#333;cursor:pointer;margin-bottom:6px' }, [
          researchBox,
          h('span', { text: 'Look up the research list — the well-known brands on Stock take we don\'t have yet (Powerade, Vita Coco…). Added when LinkedIn clearly has them.' }),
        ]),
        h('label', { style: 'display:flex;gap:7px;align-items:flex-start;font-size:12px;color:#333;cursor:pointer' }, [
          lookBox,
          h('span', { text: 'Send pages LinkedIn shows as similar to each brand to Brands → Discover for review' }),
        ]),
        h('div', { style: 'font-size:12px;color:#333;margin-top:8px', text: 'Also search LinkedIn for these words (finds small brands, not big ones):' }),
        words,
        h('div', { style: 'font-size:11.5px;color:#777;margin-top:6px', text: 'Research-list and search finds go straight into the dashboard and are read in the same run. Similar pages wait on Discover, graded, until you add them. Consumer industries with 5K+ LinkedIn followers only, up to 50 a day. Press See the list again after changing these.' }),
      ]),
      out,
      h('div', { style: SMALL, text: 'Use a tab you\'re not using — clicking or typing in it pauses the run.' }),
    ]);
    if (startNow) look();
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
    paintPill();
  }
  function paintPill() {
    if (!pill) return;
    var up = behind();
    pill.textContent = up ? 'SB ⬇ People · update' : 'SB ⬇ People';
    pill.style.background = up ? '#c2410c' : '#111';
    pill.title = 'SB LinkedIn capture ' + VERSION + (up ? ' — ' + latest().v + ' is out; open the panel to update' : '');
  }

  // LinkedIn is a single-page app: moving between a company's tabs, or
  // to someone's profile, never reloads the page. So the panel follows
  // the address on a timer, and the pill is put back if LinkedIn's own
  // rendering ever removes it.
  var lastPath = '';
  function tick() {
    ensurePill();
    // Leo moved the run's window to another page mid-read: stop scrolling.
    if (readPath && location.pathname !== readPath && fillHalt) fillHalt.stopped = true;
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

  function whenReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  whenReady(function () {
    tick();
    setInterval(tick, 1500);
    checkLatest();

    // A run's tab picks the run back up on every page load, once LinkedIn
    // has had a moment to draw the page.
    if (fillHere()) {
      var claim = loadFill();
      claim.runner = PAGE_NONCE;
      // The dashboard's button brought the run's window back to the feed:
      // that trip was Leo's, not the run's, so it doesn't count as one of
      // the brand's two tries at opening its page.
      if (AUTO_FILL && claim.step) claim.step.navs = 0;
      // Switched off by an older copy over a page that didn't load: back on.
      if (claim.snOff && !claim.snNoAccount && !claim.snFixed) { snBackOn(claim); claim.snFixed = true; }
      saveFill(claim);
      later(runFill, rand(2500, 4000));
    }

    // Opened from the dashboard's button (AUTO_FILL, caught at the top):
    // start a run in this tab with the panel's defaults. A live run in
    // another tab is shown, not doubled; a stale one is replaced.
    else if (AUTO_FILL) later(function () { openFillSetup({ auto: true }); }, rand(1500, 2500));

    // A hand scan's next view (marketing / partnerships) just loaded.
    else if (handHere()) later(guard(function () { if (!busy && handHere()) readPage(); }), rand(1500, 2500));

    // The dashboard's button again, on a window already at the feed: only
    // the #mark changes, so there's no page load to catch it. Same rules.
    window.addEventListener('hashchange', guard(function () {
      if (!/^#sb-fill\b/.test(location.hash)) return;
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
      if (fillHere()) { var job = loadFill(); return renderFill(job, job.paused ? 'Paused: ' + job.paused : 'Running.'); }
      openFillSetup({ auto: true });
    }));
  });
})();
