/* GGN Index — shared front-end logic
   All amounts/dates below come from data.json, which is the single
   source of truth also used by generate.py to build the static
   per-project pages (for SEO, each project ships as its own HTML
   file — this file only needs to render list/board views client-side). */

const GGN = (() => {
  let DATA = null;
  /* Where the numbers on screen actually came from, and when. The live pill is
     not allowed to say "LIVE" on the strength of a data.json read, so every
     board asks this instead of assuming. 'live' is only set once a Firestore
     subscription is attached (see renderDeveloperBoard). */
  let SOURCE = { kind: 'pending', at: null };

  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>'"]/g, character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[character]));
  }

  function escapeDataForMarkup(value) {
    if (Array.isArray(value)) return value.map(escapeDataForMarkup);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, escapeDataForMarkup(child)]));
    }
    return typeof value === 'string' ? escapeHTML(value) : value;
  }

  function escapePublicRecords(data) {
    return {
      ...data,
      developers: escapeDataForMarkup(data.developers || []),
      channelPartners: escapeDataForMarkup(data.channelPartners || []),
      projects: escapeDataForMarkup(data.projects || [])
    };
  }

  async function loadData() {
    if (DATA) return DATA;
    // Prefer live Firebase data when firebase-config.js / firebase-data.js
    // are wired up with real SDK keys. Falls back to the static data.json
    // (also used by generate.py for SEO pages) if Firebase isn't configured
    // or the read fails for any reason.
    if (window.GGN_FIREBASE && window.GGN_FIREBASE.enabled) {
      try {
        const live = await window.GGN_FIREBASE.fetchData();
        // Treat an empty developers collection as "not populated yet" and
        // fall back to data.json rather than rendering an empty board —
        // once you've imported real documents into Firestore this check
        // stops mattering because live.developers.length will be > 0.
        if (live && live.developers && live.developers.length > 0) {
          DATA = escapePublicRecords(live);
          SOURCE = { kind: 'synced', at: Date.now() };
          return DATA;
        }
      } catch (e) {
        console.warn('Firebase read failed, falling back to data.json', e);
        SOURCE = { kind: 'fallback', at: Date.now() };
      }
    }
    const res = await fetch(resolvePath('data.json'));
    DATA = escapePublicRecords(await res.json());
    if (SOURCE.kind !== 'fallback') SOURCE = { kind: 'fallback', at: Date.now() };
    return DATA;
  }

  /* Board plumbing shared by every leaderboard view -------------------
     One derivation, one increment source, one place that decides what the
     live pill is allowed to claim. */
  function marketOf(data, kind) {
    const site = data.site || {};
    const rows = kind === 'partner' ? data.channelPartners : data.developers;
    const increment = kind === 'partner' ? site.minOutbidPartner : site.minOutbidDeveloper;
    return window.GGN_MARKET.deriveBoard(rows || [], { kind, increment });
  }

  function paintLiveState(state) {
    if (state) SOURCE = { kind: state, at: Date.now() };
    document.querySelectorAll('[data-live-state]').forEach(el => {
      window.GGN_MARKET.liveBadge(el, SOURCE.kind, SOURCE.at);
    });
  }

  /* Where a single record sits on the derived board, or null if it holds no
     position. Detail pages resolve through this so a developer page can never
     print a different number than the leaderboard does. Matched on id first
     (Firestore docId or data.json id), then on name for records whose id
     differs between collections. */
  function positionOf(board, row) {
    if (!row) return null;
    const id = row.id || row.docId;
    const key = window.GGN_MARKET.nameKey(row.name);
    const hit = (board.positions || []).find(p =>
      (id && (p.id === id || p.docId === id)) || (key && window.GGN_MARKET.nameKey(p.name) === key));
    return hit || null;
  }

  /* "12 on board · 1 registered without a bid" — the pending figure excludes
     duplicate admin stubs so it can never overstate how many companies are
     actually waiting to bid. */
  function paintBoardCounts(kind, board) {
    const key = kind === 'partner' ? 'partners' : 'developers';
    const countEl = document.querySelector(`[data-live-count="${key}"]`);
    if (countEl) countEl.textContent = board.onBoard;
    const pendingEl = document.querySelector(`[data-live-pending="${key}"]`);
    if (pendingEl) {
      pendingEl.textContent = board.pendingCount
        ? `${board.pendingCount} registered without a position bid — not on the board`
        : '';
      pendingEl.hidden = !board.pendingCount;
    }
    if (board.duplicates.length) {
      console.warn(
        `[Bid Gurgaon] ${board.duplicates.length} ${key} record(s) duplicate a name already on the board and carry no bid — ` +
        'clean these up in the admin console:', board.duplicates.map(r => r.name + ' (' + (r.docId || r.id || '?') + ')')
      );
    }
    const mismatched = board.positions.filter(row => row.rankMismatch);
    if (mismatched.length) {
      console.warn(
        `[Bid Gurgaon] ${mismatched.length} ${key} record(s) have a stored "rank" that disagrees with their bid. ` +
        'Display uses the bid; fix the rank field when convenient:',
        mismatched.map(r => `${r.name}: stored #${r.storedRank}, actually #${r.position}`)
      );
    }
  }

  /* ---------------- One clean URL per record ----------------
     Every developer, project and partner is addressed as
     /pages/<kind>-<slug> — no ".html", no "?id=".

     That single form works whether or not the record has a pre-rendered page:
     firebase.json sets cleanUrls, so /pages/developer-dlf-limited serves the
     generated developer-dlf-limited.html, and a rewrite sends slugs with no
     generated file (anything added in the admin console since the last
     generate.py run) to the live developer.html template, which fills in its
     own title, description and canonical. Search engines therefore see one
     stable, indexable address per record either way, and 404.html re-routes
     the same shape as a last resort. */
  const LISTING_PAGE = { developer: 'developers', project: 'projects', partner: 'channel-partners' };
  function detailHref(kind, id, opts = {}) {
    const linkBase = opts.fromPages ? '' : 'pages/';
    const slug = String(id == null ? '' : id);
    // No slug at all (a record saved without an id) — send the visitor to the
    // board it belongs on rather than to a dead per-record URL.
    if (!slug) return linkBase + (LISTING_PAGE[kind] || 'developers');
    return `${linkBase}${kind}-${encodeURIComponent(slug)}`;
  }

  /* ---------------- Which record is this page about? ----------------
     Accepts both URL shapes so old links keep working:
       /pages/developer-sobha-limited   (rewritten to developer.html)
       /pages/developer.html?id=sobha-limited
     The clean path wins when both are present. */
  function entityId(kind) {
    const fromPath = (location.pathname.match(
      new RegExp('(?:^|/)' + kind + '-(.+?)(?:\\.html)?$', 'i')
    ) || [])[1];
    if (fromPath) { try { return decodeURIComponent(fromPath); } catch (e) { return fromPath; } }
    return qsParam('id');
  }

  /* ---------------- Per-record SEO for the live templates ----------------
     One HTML file serves every record that has no pre-rendered page yet, so
     the title, description, canonical URL and social cards have to be written
     at render time — otherwise every one of them would compete for the same
     generic "Developer — Bid Gurgaon" listing. Canonical always points at the
     clean /pages/<kind>-<slug> URL (never at "?id=", which would split
     ranking signals between two addresses for the same content). Pages that
     resolve to nothing get noindex, so empty URLs can't enter the index. */
  const SITE_ORIGIN = 'https://bidgurgaon.in';

  function setMeta(selector, attr, value) {
    let el = document.head.querySelector(selector);
    if (!el) {
      el = document.createElement(selector.startsWith('link') ? 'link' : 'meta');
      const m = selector.match(/\[(name|property|rel)="([^"]+)"\]/);
      if (m) el.setAttribute(m[1], m[2]);
      document.head.appendChild(el);
    }
    el.setAttribute(attr, value);
  }

  function applyEntitySeo(kind, slug, opts = {}) {
    const found = !!opts.title;
    const canonical = `${SITE_ORIGIN}/pages/${kind}-${encodeURIComponent(slug || '')}`;
    setMeta('meta[name="robots"]', 'content', found ? 'index, follow' : 'noindex, follow');
    if (!found) return;
    document.title = opts.title;
    setMeta('link[rel="canonical"]', 'href', canonical);
    setMeta('meta[name="description"]', 'content', opts.description);
    setMeta('meta[property="og:title"]', 'content', opts.title);
    setMeta('meta[property="og:description"]', 'content', opts.description);
    setMeta('meta[property="og:url"]', 'content', canonical);
    setMeta('meta[name="twitter:title"]', 'content', opts.title);
    setMeta('meta[name="twitter:description"]', 'content', opts.description);
    if (opts.image) {
      setMeta('meta[property="og:image"]', 'content', opts.image);
      setMeta('meta[name="twitter:image"]', 'content', opts.image);
    }
    if (opts.jsonLd) {
      let s = document.getElementById('entity-jsonld');
      if (!s) {
        s = document.createElement('script');
        s.type = 'application/ld+json';
        s.id = 'entity-jsonld';
        document.head.appendChild(s);
      }
      s.textContent = JSON.stringify(opts.jsonLd);
    }
  }

  // Strips the HTML escaping escapePublicRecords() applies, for use in
  // attribute values and JSON-LD where markup must not appear.
  function plain(s) {
    return String(s == null ? '' : s)
      .replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ').trim();
  }

  // Works whether the page lives at root or in /pages/
  function resolvePath(rel) {
    const inPages = location.pathname.includes('/pages/');
    return inPages ? '../' + rel : rel;
  }

  function fmtINR(amount) {
    // Indian numbering (lakh/crore) grouping for a rupee figure
    const s = Math.round(Number(amount) || 0).toString();
    let last3 = s.substring(s.length - 3);
    let other = s.substring(0, s.length - 3);
    if (other !== '') last3 = ',' + last3;
    const formatted = other.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + last3;
    return '₹' + formatted;
  }

  /* "₹19,500/month" when the record stores a billing cycle, "₹19,500" when it
     doesn't. The cycle is never defaulted: eight of the twelve developers and
     all four partners currently on the board store an empty bidCycle, so
     printing "/month" for them would invent a billing term the platform has
     not recorded — and printing "/" alone (the old behaviour) left a dangling
     slash on every one of those rows. */
  function bidWithCycle(amount, cycle) {
    const c = String(cycle == null ? '' : cycle).trim();
    return fmtINR(amount) + (c ? '/' + c : '');
  }

  /* Developers register RERA per project, so a blank / "N/A" value is normal —
     it must never surface as the literal "N/A — registered per-project".
     Mirrors rera_phrase() in generate.py. */
  function reraPhrase(raw) {
    const v = String(raw == null ? '' : raw).trim();
    if (!v || /^n\/?a\b/i.test(v) || ['-', '—', 'none', 'null'].includes(v.toLowerCase())) {
      return 'RERA-registered per project';
    }
    return /^rera\b/i.test(v) ? v : 'RERA ' + v;
  }

  function fmtDateLong(iso) {
    if (!iso) return '—';
    const d = new Date(iso + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function monthsSince(iso) {
    if (!iso) return '—';
    const then = new Date(iso + 'T00:00:00');
    if (Number.isNaN(then.getTime())) return '—';
    const now = new Date();
    let months = (now.getFullYear() - then.getFullYear()) * 12 + (now.getMonth() - then.getMonth());
    if (months < 1) return 'This month';
    if (months === 1) return '1 month';
    return months + ' months';
  }

  function initials(name) {
    return String(name || '').split(' ').filter(word => word && word[0] === word[0].toUpperCase()).slice(0, 2).map(word => word[0]).join('');
  }

  /* `photo` is free text typed in the admin console, and one live partner record
     holds a company website ("https://growthxestates.com/") in it rather than an
     image. Emitting that as <img src> made every visitor's browser fetch a third
     party's homepage on page load — blocked by the browser as a non-image
     response, leaving an empty avatar. So a value is only used as an image when
     it actually looks like one; anything else falls back to initials. */
  function isImageUrl(value) {
    const v = String(value == null ? '' : value).trim();
    if (!v) return false;
    if (/^data:image\//i.test(v)) return true;
    return /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(v.split(/[?#]/)[0]);
  }

  /* ---------------- Nav toggle ---------------- */
  function initNav() {
    const toggle = document.querySelector('.nav-toggle');
    const links = document.querySelector('.nav-links');
    if (!toggle || !links) return;

    // Backdrop for the mobile menu — created once, reused across pages
    let backdrop = document.querySelector('.nav-backdrop');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.className = 'nav-backdrop';
      document.body.appendChild(backdrop);
    }

    function setOpen(open) {
      links.classList.toggle('open', open);
      backdrop.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      document.body.style.overflow = open ? 'hidden' : '';
    }

    toggle.addEventListener('click', () => setOpen(!links.classList.contains('open')));
    backdrop.addEventListener('click', () => setOpen(false));
    links.querySelectorAll('a').forEach(a => a.addEventListener('click', () => setOpen(false)));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') setOpen(false);
    });
  }

  /* ---------------- Scroll reveal ---------------- */
  function initReveal() {
    const els = document.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in window) || els.length === 0) {
      els.forEach(el => el.classList.add('in'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    els.forEach(el => io.observe(el));
  }

  /* ---------------- Developer board row ----------------
     `dev` here is a row that has already been through
     GGN_MARKET.deriveBoard(), so `dev.position` is derived from the bid that
     was actually paid — never the hand-typed `rank` field, which currently
     contradicts the bids on both boards. data-entity lets market.js match the
     row across re-renders and animate a genuine position change. */
  function developerRowHTML(dev, opts = {}) {
    const linkBase = opts.fromPages ? '' : 'pages/';
    const gap = dev.gapAbove == null
      ? '<span class="bid-gap">Top of the board</span>'
      : `<span class="bid-gap">${fmtINR(dev.gapAbove)} behind #${dev.position - 1}</span>`;
    return `
    <div class="board-row rank-${dev.position}" data-entity="dev-${dev.id || dev.docId || dev.position}">
      <div class="rank-num">${String(dev.position).padStart(2, '0')}</div>
      <div class="entity">
        <div class="logo">${dev.logo}</div>
        <div class="name-block">
          <div class="name">${dev.name} <span class="badge-rera" title="RERA registration">RERA ✓</span></div>
          <div class="meta">${dev.locality} — ${dev.tagline}</div>
        </div>
      </div>
      <div class="col-since"><span class="col-label">On board since </span>${fmtDateLong(dev.since)}</div>
      <div class="col-bid"><span class="col-label">Position bid </span>${bidWithCycle(dev.bid, dev.bidCycle)}${gap}</div>
      ${opts.hideActions ? '' : `<div class="col-action" style="display:flex;flex-direction:column;gap:8px;align-items:stretch;">
        <a class="btn btn-bid btn-sm" href="${linkBase}bid-now.html?type=developer&rank=${dev.position}&id=${dev.id}&entity=${encodeURIComponent(plain(dev.name))}&current=${dev.bid || 0}">Claim #${dev.position}</a>
        <a class="btn btn-outline btn-sm" href="${detailHref('developer', dev.id, opts)}">View projects</a>
      </div>`}
    </div>`;
  }

  /* ---------------- Channel partner board row ----------------
     "Active on" used to only show a bare count ("Active on 2 projects"),
     leaving a buyer to call blind and find out which projects the
     partner actually handles. We now resolve each id in cp.activeOn
     against the projects collection and render the real project names
     as clickable chips beneath the meta line, so a buyer can check
     before they dial. If an id doesn't resolve (project renamed/removed
     from the projects collection but not yet updated on the partner),
     we still show the raw id rather than silently hiding it, so the
     data gap stays visible instead of quietly disappearing. */
  function partnerRowHTML(cp, opts = {}) {
    const linkBase = opts.fromPages ? '' : 'pages/';
    const projectsById = opts.projectsById || {};
    const activeOn = cp.activeOn || [];

    // Prioritize premier flagship launches (DLF Privana, Godrej Verano, Lodha) so top marquee launches appear first
    const marqueePrio = ['dlf-privana-enclave', 'godrej-verano', 'lodha-golf-course-road', 'm3m-soulitude-central'];
    const sortedActiveOn = [...activeOn].sort((a, b) => {
      const idxA = marqueePrio.indexOf(a);
      const idxB = marqueePrio.indexOf(b);
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return 0;
    });

    const maxVisible = 3;
    const isTruncated = sortedActiveOn.length > 4;
    const visiblePids = isTruncated ? sortedActiveOn.slice(0, maxVisible) : sortedActiveOn;
    const hiddenPids = isTruncated ? sortedActiveOn.slice(maxVisible) : [];

    const renderChip = (pid) => {
      const project = projectsById[pid];
      const label = project ? project.name : pid;
      return project
        ? `<a class="chip-project" href="${detailHref('project', pid, opts)}">${label}</a>`
        : `<span class="chip-project chip-project--unresolved" title="Project id not found">${label}</span>`;
    };

    const visibleChips = visiblePids.map(renderChip).join('');
    const hiddenChips = hiddenPids.map(renderChip).join('');

    const toggleBtn = isTruncated
      ? `<button type="button" class="chip-expand-btn" data-more-text="+${hiddenPids.length} more projects ▾" data-less-text="Show fewer ▴" aria-expanded="false" onclick="GGN.togglePartnerChips(this)">+${hiddenPids.length} more projects ▾</button>`
      : '';

    const hiddenBox = isTruncated
      ? `<div class="active-projects-hidden">${hiddenChips}</div>`
      : '';

    const chipsMarkup = activeOn.length
      ? `<div class="active-projects-wrap">
          <div class="active-projects">${visibleChips}${toggleBtn}</div>
          ${hiddenBox}
        </div>`
      : '';

    const gap = cp.gapAbove == null
      ? '<span class="bid-gap">Top of the board</span>'
      : `<span class="bid-gap">${fmtINR(cp.gapAbove)} behind #${cp.position - 1}</span>`;
    return `
    <div class="board-row rank-${cp.position}" data-entity="cp-${cp.id || cp.docId || cp.position}">
      <div class="rank-num">${String(cp.position).padStart(2, '0')}</div>
      <div class="entity">
        <div class="logo">${initials(cp.name)}</div>
        <div class="name-block">
          <div class="name"><a href="${detailHref('partner', cp.id, opts)}" class="entity-name-link">${cp.name}</a> <span class="badge-rera">RERA ✓</span></div>
          <div class="meta">Active on ${activeOn.length} project${activeOn.length === 1 ? '' : 's'} · ${cp.reraChannel}</div>
          ${chipsMarkup}
          <a class="profile-link" href="${detailHref('partner', cp.id, opts)}">View full profile →</a>
        </div>
      </div>
      <div class="col-since"><span class="col-label">On board since </span>${fmtDateLong(cp.since)}</div>
      <div class="col-bid"><span class="col-label">Position bid </span>${bidWithCycle(cp.bid, cp.bidCycle)}${gap}</div>
      <div class="col-action" style="display:flex;flex-direction:column;gap:8px;align-items:stretch;">
        <a class="btn btn-bid btn-sm" href="${linkBase}bid-now.html?type=partner&rank=${cp.position}&id=${cp.id}&entity=${encodeURIComponent(plain(cp.name))}&current=${cp.bid || 0}">Claim #${cp.position}</a>
        <a class="btn btn-call btn-sm" href="tel:${String(cp.phone || '').replace(/\s/g, '')}">Call now</a>
      </div>
    </div>`;
  }

  function togglePartnerChips(btn) {
    if (!btn) return;
    const wrap = btn.closest('.active-projects-wrap');
    if (!wrap) return;
    const hiddenBox = wrap.querySelector('.active-projects-hidden');
    if (!hiddenBox) return;
    const isOpen = hiddenBox.classList.contains('is-open');
    if (isOpen) {
      hiddenBox.classList.remove('is-open');
      btn.classList.remove('is-active');
      btn.setAttribute('aria-expanded', 'false');
      btn.textContent = btn.getAttribute('data-more-text') || '+more ▾';
    } else {
      hiddenBox.classList.add('is-open');
      btn.classList.add('is-active');
      btn.setAttribute('aria-expanded', 'true');
      btn.textContent = btn.getAttribute('data-less-text') || 'Show fewer ▴';
    }
  }

  /* ---------------- Ticker board effect ----------------
     Turns a rendered board into a continuously scrolling "ticker"
     (departures-board style vertical loop). We duplicate the rendered
     rows once and animate the track up by exactly one copy's height,
     so it loops seamlessly. Pauses on hover and is fully disabled for
     users who prefer reduced motion (handled in CSS). Safe to call on
     re-render — it just rebuilds the ticker wrapper each time.

     The second copy is a presentation artefact, not a second market: it is
     wrapped so it can be marked aria-hidden (otherwise a screen reader reads
     a 12-company board as 24 companies) and so the reduced-motion rule can
     remove it outright — that rule drops the viewport's overflow clip, which
     would otherwise put every company on screen twice. */
  function applyTicker(mount, opts = {}, rowCount = 0) {
    // Ticker duplication disabled so developer and partner lists are never repeated or doubled
    return;
  }

  /* ---------------- Board structured data ----------------
     Only the two full listing pages ask for this (opts.itemList), because an
     ItemList should describe the whole board — a 3-row hero preview would
     publish a three-company market. Re-injected on every live re-render, so
     the markup a crawler reads is the order a visitor sees. The description
     written by market.js states plainly that this is a paid-placement order
     and not a quality ranking. */
  const ITEMLIST_META = {
    developer: { id: 'developer-board', name: 'Bid Gurgaon developer visibility board — Gurugram' },
    partner: { id: 'partner-board', name: 'Bid Gurgaon channel partner visibility board — Gurugram' }
  };
  function injectBoardItemList(board, kind) {
    const meta = ITEMLIST_META[kind] || ITEMLIST_META.developer;
    window.GGN_MARKET.injectItemList(board, {
      id: meta.id,
      name: meta.name,
      pathFor: row => (row.id || row.docId)
        ? '/pages/' + kind + '-' + encodeURIComponent(row.id || row.docId)
        : null
    });
  }

  /* ---------------- Leaderboards ----------------
     Both boards get their ordering from GGN_MARKET.deriveBoard() so the
     homepage, the developer page and the partner page can never disagree
     about who holds which position. Rows without a position bid are not
     given a position — they're reported separately as "registered, not on
     the board" instead of being printed as #undefined · ₹0.

     A live Firestore subscription upgrades the pill to LIVE; a dead one
     downgrades it to OFFLINE rather than leaving a stale "LIVE" on screen.
     FLIP is skipped on ticker boards because the ticker duplicates every
     row, so there is no unique on-screen position to animate between. */
  async function renderDeveloperBoard(mountSelector, opts = {}) {
    const data = await loadData();
    const mount = document.querySelector(mountSelector);
    if (!mount) return;
    const board = marketOf(data, 'developer');
    const before = opts.ticker ? null : window.GGN_MARKET.snapshotRows(mount);
    let rows = board.positions;
    if (opts.limit) rows = rows.slice(0, opts.limit);
    mount.innerHTML = rows.map(d => developerRowHTML(d, opts)).join('');
    paintBoardCounts('developer', board);
    paintLiveState();
    if (opts.itemList) injectBoardItemList(board, 'developer');
    if (before) window.GGN_MARKET.flipRows(mount, '[data-entity]', before);
    applyTicker(mount, opts, rows.length);
    // If Firestore is wired up, keep this board live: re-render whenever
    // bids change in the developers collection, no page refresh needed.
    if (window.GGN_FIREBASE && window.GGN_FIREBASE.enabled && !opts._isLiveUpdate) {
      window.GGN_FIREBASE.onCollectionChange('developers', (liveRows, meta) => {
        DATA.developers = escapeDataForMarkup(liveRows);
        SOURCE = { kind: meta && meta.fromCache ? 'fallback' : 'live', at: Date.now() };
        renderDeveloperBoard(mountSelector, { ...opts, _isLiveUpdate: true });
        renderMarketPulse('[data-pulse="developer"]', 'developer');
      }, () => paintLiveState('error'));
    }
  }

  async function renderPartnerBoard(mountSelector, opts = {}) {
    const data = await loadData();
    const mount = document.querySelector(mountSelector);
    if (!mount) return;
    const projectsById = Object.fromEntries((data.projects || []).map(p => [p.id, p]));
    const board = marketOf(data, 'partner');
    const before = opts.ticker ? null : window.GGN_MARKET.snapshotRows(mount);
    let rows = board.positions;
    if (opts.limit) rows = rows.slice(0, opts.limit);
    mount.innerHTML = rows.map(c => partnerRowHTML(c, { ...opts, projectsById })).join('');
    paintBoardCounts('partner', board);
    paintLiveState();
    if (opts.itemList) injectBoardItemList(board, 'partner');
    if (before) window.GGN_MARKET.flipRows(mount, '[data-entity]', before);
    applyTicker(mount, opts, rows.length);
    if (window.GGN_FIREBASE && window.GGN_FIREBASE.enabled && !opts._isLiveUpdate) {
      window.GGN_FIREBASE.onCollectionChange('channelPartners', (liveRows, meta) => {
        DATA.channelPartners = escapeDataForMarkup(liveRows);
        SOURCE = { kind: meta && meta.fromCache ? 'fallback' : 'live', at: Date.now() };
        renderPartnerBoard(mountSelector, { ...opts, _isLiveUpdate: true });
        renderMarketPulse('[data-pulse="partner"]', 'partner');
      }, () => paintLiveState('error'));
    }
  }

  /* ---------------- Hero board preview (top 3 devs) ---------------- */
  async function renderHeroPreview(mountSelector) {
    const data = await loadData();
    const mount = document.querySelector(mountSelector);
    if (!mount) return;
    const top = marketOf(data, 'developer').positions.slice(0, 3);
    mount.innerHTML = top.map((d, i) => `
      <div class="bp-row" style="animation-delay:${i * 0.08}s">
        <div class="bp-rank">${String(d.position).padStart(2, '0')}</div>
        <div>
          <div class="bp-name">${d.name}</div>
          <div class="bp-sub">since ${fmtDateLong(d.since)}</div>
        </div>
        <div class="bp-amt">${bidWithCycle(d.bid, d.bidCycle)}</div>
      </div>
    `).join('');
  }

  /* ---------------- Hero board preview (top 3 channel partners) ----------------
     Same compact bp-row markup as renderHeroPreview, just sourced from
     channelPartners instead of developers — used on pages/for-partners.html. */
  async function renderPartnerHeroPreview(mountSelector) {
    const data = await loadData();
    const mount = document.querySelector(mountSelector);
    if (!mount) return;
    const top = marketOf(data, 'partner').positions.slice(0, 3);
    mount.innerHTML = top.map((cp, i) => `
      <div class="bp-row" style="animation-delay:${i * 0.08}s">
        <div class="bp-rank">${String(cp.position).padStart(2, '0')}</div>
        <div>
          <div class="bp-name">${cp.name}</div>
          <div class="bp-sub">since ${fmtDateLong(cp.since)}</div>
        </div>
        <div class="bp-amt">${bidWithCycle(cp.bid, cp.bidCycle)}</div>
      </div>
    `).join('');
  }

  /* ---------------- Market Pulse ----------------
     Four tiles, every one of them computed from data the platform actually
     stores. "Biggest mover" and "most contested project" are deliberately
     absent: no position history is written anywhere in Firestore and almost
     no project↔partner links exist, so both would be invented. The pulse
     says so out loud in the untracked tile instead. */
  function pulseTile(label, value, sub, opts = {}) {
    return `
      <div class="pulse-tile${opts.muted ? ' is-untracked' : ''}">
        <div class="pulse-label">${label}</div>
        <div class="pulse-value">${value}</div>
        <div class="pulse-sub">${sub}</div>
      </div>`;
  }

  async function renderMarketPulse(mountSelector, kind = 'developer') {
    const mount = document.querySelector(mountSelector);
    if (!mount) return;
    const data = await loadData();
    const board = marketOf(data, kind);
    const p = window.GGN_MARKET.pulse(board);
    const noun = kind === 'partner' ? 'partners' : 'developers';

    const battle = p.closestBattle
      ? pulseTile('Closest battle', `#${p.closestBattle.above.position} vs #${p.closestBattle.below.position}`,
          `${fmtINR(p.closestBattle.gap)} apart — ${p.closestBattle.below.name} is the nearest challenger`)
      : pulseTile('Closest battle', 'No contest yet',
          'Two positions are needed before there is a race.', { muted: true });

    const takeTop = p.costToTakeTop
      ? pulseTile('Cost to take #1', bidWithCycle(p.costToTakeTop, board.positions[0].bidCycle),
          `${fmtINR(board.increment)} above ${board.positions[0].name}'s current bid`)
      : pulseTile('Cost to take #1', fmtINR(board.increment),
          'Board is empty — the minimum bid claims #1.');

    const depth = pulseTile('Board depth', `${p.depth.onBoard} on board`,
      p.depth.pending
        ? `${p.depth.pending} more ${p.depth.pending === 1 ? noun.slice(0, -1) : noun} registered without a position bid`
        : 'No company is waiting without a position bid');

    /* Ties are listed together, so the position line has to list every one of
       them — "at #4" beside two names would silently attribute one company's
       position to both. */
    const newest = p.newest
      ? pulseTile('Newest on board', p.newest.rows.map(r => r.name).join(', '),
          `Joined ${fmtDateLong(p.newest.since)} — now at ` +
          p.newest.rows.map(r => '#' + r.position).join(', '))
      : pulseTile('Newest on board', 'Not recorded',
          'No join dates on the current records.', { muted: true });

    mount.innerHTML = `
      <div class="pulse-grid">${battle}${takeTop}${depth}${newest}</div>
      <p class="pulse-note">
        Biggest mover and most-contested project are <b>not tracked yet</b> —
        ${p.movement.reason} ${p.contested.reason}
        We'd rather show nothing than a guess.
      </p>`;
  }

  /* ---------------- Outbid / required-bid calculation ----------------
     Single source of truth for "how much do I need to bid?" — used by
     the outbid banner on every board AND the Bid Now payment page, so
     the number shown before payment always matches the number shown
     on the board. Reads the current #1 bid from the same derived board
     every leaderboard uses, and adds the minimum outbid increment
     (site.minOutbidDeveloper / site.minOutbidPartner, defaults in
     js/market.js). Display-side arithmetic only — the real position is
     only ever granted server-side after a verified payment. */
  async function computeRequiredBid(type) {
    const data = await loadData();
    const board = marketOf(data, type === 'developer' ? 'developer' : 'partner');
    const current = board.topBid;
    const increment = board.increment;
    return {
      current, increment,
      required: window.GGN_MARKET.costToTake(board, 1),
      label: type === 'developer' ? 'developer' : 'partner',
      cycle: board.positions[0] ? board.positions[0].bidCycle : '',
      hasBoard: board.onBoard > 0
    };
  }

  function outbidMessage({ current, increment, required, label, hasBoard, cycle }) {
    if (!hasBoard) {
      return `No one's on this board yet — any bid claims <b>#1</b>.`;
    }
    return `To become <b>#1</b>, bid <b>${bidWithCycle(required, cycle)}</b> — that's ${fmtINR(increment)} more than the current top ${label} bid of ${bidWithCycle(current, cycle)}. Can't top #1 yet? Claim any position below — just pay more than whoever holds it.`;
  }

  async function renderOutbidBanner(mountSelector, type) {
    const mount = document.querySelector(mountSelector);
    if (!mount) return;
    const bid = await computeRequiredBid(type);
    mount.innerHTML = `<div class="outbid-banner"><span class="mono outbid-dot">●</span><span>${outbidMessage(bid)}</span></div>`;
  }

  /* ---------------- Developer ↔ project linkage ----------------
     A project's developer is stored as free text in the admin panel, so the
     same company arrives as "dlf-limited", "dlf", "DLF Limited" or "DLF Ltd."
     depending on who typed it. Matching on strict equality left most projects
     orphaned — the DLF developer page listed 6 of its projects and project
     cards rendered a blank developer name. Every view now resolves through
     this one index so they can't disagree.
     Mirrors slug_key/dev_key/_build_dev_index in generate.py. */
  const DEV_NOISE = new Set([
    'private', 'pvt', 'limited', 'ltd', 'llp', 'inc', 'india', 'group', 'groups',
    'properties', 'property', 'developer', 'developers', 'projects', 'realty',
    'realtors', 'realestate', 'estate', 'estates', 'buildtech', 'infra', 'the', 'and'
  ]);

  function unescapeEntities(s) {
    return String(s == null ? '' : s)
      .replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'")
      .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  }

  function slugKey(s) {
    return unescapeEntities(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }

  /* Aggressive key: drops corporate-suffix noise so "DLF Ltd." === "dlf-limited". */
  function devKey(s) {
    return unescapeEntities(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
      .filter(w => w && !DEV_NOISE.has(w)).join('');
  }

  function buildDevIndex(data) {
    const projects = data.projects || [];
    /* Bidders are indexed first, and a bid-less record is never allowed to make
       a key "ambiguous". The developers collection holds admin stubs that
       duplicate the name of a company already on the board (Godrej, M3M,
       Signature Global today). Indexed naively, each stub collides with the
       real record, the shared key gets deleted as ambiguous, and every project
       belonging to that developer is orphaned — which is what would have
       happened the moment the board stopped hiding those stubs. A stub loses
       every collision instead. */
    const devs = (data.developers || []).slice().sort((a, b) =>
      (Number(b.bidAmount) || 0 ? 1 : 0) - (Number(a.bidAmount) || 0 ? 1 : 0));
    const isStub = dev => !(Number(dev.bidAmount) || 0);
    const byId = new Map();
    const fuzzy = new Map();
    const ambiguous = new Set();
    devs.forEach(dev => {
      [dev.id, dev.docId].forEach(k => { if (k && !byId.has(String(k))) byId.set(String(k), dev); });
      [dev.id, dev.docId, dev.name].forEach(raw => {
        [slugKey(raw), devKey(raw)].forEach(key => {
          if (!key) return;
          if (!fuzzy.has(key)) { fuzzy.set(key, dev); return; }
          const held = fuzzy.get(key);
          if (held === dev || isStub(dev)) return;      // a stub never wins or spoils
          if (isStub(held)) { fuzzy.set(key, dev); return; }
          ambiguous.add(key);                            // two real developers — refuse to guess
        });
      });
    });
    ambiguous.forEach(key => fuzzy.delete(key));  // never guess between two developers

    function devFor(project) {
      if (!project) return null;
      const raw = project.developerId || project.developer || project.developerName || '';
      return byId.get(String(raw)) || fuzzy.get(slugKey(raw)) || fuzzy.get(devKey(raw)) || null;
    }

    // Group once: resolved owner, plus anything listed on the developer's own
    // projects[] array (so a project with a blank developerId still shows up).
    const grouped = new Map();
    devs.forEach(dev => { if (dev.id) grouped.set(dev.id, []); });
    const listedBy = new Map();
    devs.forEach(dev => (dev.projects || []).forEach(pid => { if (!listedBy.has(pid)) listedBy.set(pid, dev); }));
    const orphans = [];
    projects.forEach(project => {
      const dev = devFor(project) || listedBy.get(project.id) || null;
      if (!dev) { orphans.push(project); return; }
      if (!grouped.has(dev.id)) grouped.set(dev.id, []);
      grouped.get(dev.id).push(project);
    });

    return {
      devFor,
      orphans,
      projectsFor: dev => (dev ? grouped.get(dev.id) || [] : [])
    };
  }

  /* Surfaces data-entry mistakes once per page load instead of silently
     dropping the project from its developer's page. */
  let _warnedOrphans = false;
  function warnOrphans(index) {
    if (_warnedOrphans || !index.orphans.length) return;
    _warnedOrphans = true;
    console.warn(
      '[Bid Gurgaon] ' + index.orphans.length + ' project(s) are not linked to any developer — ' +
      'fix the "Developer ID" field in the admin panel:',
      index.orphans.map(p => p.name + ' (developerId: "' + (p.developerId || '') + '")')
    );
  }

  function projectPartners(project, channelPartners) {
    const partnerIds = new Set([
      ...(project.activePartners || []),
      ...(channelPartners || []).filter(partner => (partner.activeOn || []).includes(project.id)).map(partner => partner.id)
    ]);
    return [...partnerIds]
      .map(partnerId => (channelPartners || []).find(partner => partner.id === partnerId))
      .filter(Boolean)
      .sort((first, second) => (second.bidAmount || 0) - (first.bidAmount || 0));
  }

  function partnerSummaryHTML(partners) {
    if (!partners.length) {
      return `<div class="pcard-partners"><span class="pcard-partners-label">Active channel partners</span><span class="pcard-partners-empty">None listed yet</span></div>`;
    }
    const visiblePartners = partners.slice(0, 3);
    const moreCount = partners.length - visiblePartners.length;
    return `
      <div class="pcard-partners">
        <span class="pcard-partners-label">Active channel partners</span>
        <span class="pcard-partner-list">${visiblePartners.map(partner => `<span class="pcard-partner-name">${partner.name}</span>`).join('')}${moreCount ? `<span class="pcard-partner-more">+${moreCount} more</span>` : ''}</span>
      </div>`;
  }

  /* ---------------- Project status taxonomy ----------------
     The projects collection (and older data.json rows) carry free-text
     statuses like "Delivered/Operational", "Upcoming", "Under Construction
     (possession recently commenced)" or blank. Buyers only care about the
     lifecycle stage, so we collapse everything into five clean, ordered
     buckets for the badges and the filter bar. This is display-only — it
     never rewrites the underlying data / Firestore, so the admin can keep
     typing whatever they like and the public site stays tidy. */
  const STATUS_ORDER = ['Pre-Launch', 'New Launch', 'Under Construction', 'Near Possession', 'Ready to Move'];

  function normalizeStatus(raw) {
    const s = String(raw || '').toLowerCase().trim();
    if (!s) return '';
    if (s.includes('pre-launch') || s.includes('pre launch') || s.includes('prelaunch') || s.includes('upcoming') || s.includes('coming soon')) return 'Pre-Launch';
    if (s.includes('new launch') || s.includes('newly launched') || s.includes('just launched')) return 'New Launch';
    if (s.includes('ready to move') || s.includes('ready-to-move') || s.includes('rtm') || s.includes('delivered') || s.includes('operational') || s.includes('completed') || s.includes('handed over')) return 'Ready to Move';
    if (s.includes('near possession') || s.includes('nearing possession') || s.includes('near-possession') || s.includes('possession soon') || s.includes('possession commenced') || s.includes('possession recently') || (s.includes('possession') && !s.includes('await'))) return 'Near Possession';
    if (s.includes('under construction') || s.includes('under-construction') || s.includes('construction') || s.includes('ongoing')) return 'Under Construction';
    return ''; // unrecognised → no chip / no badge, still shows under "All"
  }

  /* ---------------- Project cards (home + listing) ---------------- */
  // Placeholder icon shown until a project has real photos. If a project record
  // ever carries an `images` array, those photos are used automatically.
  const PH_ICON = '<svg class="ph-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="M21 16l-5-5L5 20"/></svg>';

  function projectShot(url, cls, alt, label) {
    if (url) return `<img class="pcard-shot ${cls}" src="${url}" alt="${alt}" loading="lazy">`;
    return `<span class="pcard-shot pcard-shot--ph ${cls}" aria-hidden="true">${PH_ICON}${label ? `<span class="ph-label">${label}</span>` : ''}</span>`;
  }

  function projectMediaInner(project, status, developer, devInitials) {
    const imgs = (Array.isArray(project.images) && project.images.length)
      ? project.images.filter(Boolean)
      : (project.coverImage ? [project.coverImage] : []);
    const alt = project.name || 'Project';
    const mainImg = imgs[0] || project.coverImage || '';
    const hasMultiple = imgs.length > 1;

    return `
        ${status ? `<span class="pcard-status">${status}</span>` : ''}
        <span class="pcard-rera-tag">HRERA ✓</span>
        ${projectShot(mainImg, 'pcard-shot--main', alt, project.name)}
        ${hasMultiple ? `
        <div class="pcard-thumbs">
          ${projectShot(imgs[1], 'pcard-shot--thumb', alt, '')}
          ${projectShot(imgs[2], 'pcard-shot--thumb', alt, '')}
          ${projectShot(imgs[3], 'pcard-shot--thumb', alt, '')}
        </div>` : ''}
        ${developer ? `<span class="pcard-seal" title="${developer.name}">${devInitials}</span>` : ''}`;
  }

  // Large hero gallery for the project detail page
  function detailMediaInner(project) {
    const imgs = (Array.isArray(project.images) && project.images.length)
      ? project.images.filter(Boolean)
      : (project.coverImage ? [project.coverImage] : []);
    const alt = project.name || 'Project';
    const mainImg = imgs[0] || project.coverImage || '';
    const hasMultiple = imgs.length > 1;

    return `
        <div class="dg-main" style="${!hasMultiple ? 'flex:1; width:100%;' : ''}">
          ${projectShot(mainImg, 'dg-shot dg-shot--main', alt, project.name)}
        </div>
        ${hasMultiple ? `
        <div class="dg-thumbs">
          ${projectShot(imgs[1], 'dg-shot dg-shot--thumb', alt, '')}
          ${projectShot(imgs[2], 'dg-shot dg-shot--thumb', alt, '')}
          ${projectShot(imgs[3], 'dg-shot dg-shot--thumb', alt, '')}
        </div>` : ''}`;
  }

  function projectCardHTML(project, developer, opts = {}) {
    const devInitials = developer ? (developer.logo || initials(developer.name)) : '—';
    const partners = opts.partnersByProject?.[project.id] || [];
    const status = normalizeStatus(project.status) || project.status || '';
    const highlights = Array.isArray(project.highlights) ? project.highlights.slice(0, 2) : [];
    const priceDisplay = project.priceRange || 'Price on Request';

    return `
    <a class="pcard" href="${detailHref('project', project.id, opts)}">
      <div class="pcard-media">
        ${projectMediaInner(project, status, developer, devInitials)}
      </div>
      <div class="pcard-body">
        <div class="dev">${developer ? developer.name : 'Gurugram Luxury'}</div>
        <h3>${project.name}</h3>
        <div class="loc"><span class="loc-ico">📍</span>${project.locality}</div>
        <div class="pcard-specs">
          ${project.configs ? `<span><span class="ic">⌂</span><b>${project.configs}</b></span>` : ''}
          ${project.sizeRange ? `<span><span class="ic">◻</span><b>${project.sizeRange}</b></span>` : ''}
          ${project.possession ? `<span><span class="ic">📅</span><b>${project.possession}</b></span>` : ''}
        </div>
        ${highlights.length ? `<div class="pcard-tags">${highlights.map(h => `<span class="pcard-tag">${h}</span>`).join('')}</div>` : ''}
        ${partnerSummaryHTML(partners)}
        <div class="pcard-foot">
          <div class="price-block">
            <span class="price-lbl">Starting Price</span>
            <span class="price">${priceDisplay}</span>
          </div>
          <span class="btn btn-outline btn-sm">Explore Project →</span>
        </div>
      </div>
    </a>`;
  }

  async function renderProjectGrid(mountSelector, opts = {}) {
    const data = await loadData();
    const mount = document.querySelector(mountSelector);
    if (!mount) return;
    const index = buildDevIndex(data);
    warnOrphans(index);
    const partnersByProject = Object.fromEntries(data.projects.map(project => [project.id, projectPartners(project, data.channelPartners)]));
    let projects = [...data.projects];

    if (opts.filterStatus && opts.filterStatus !== 'all') {
      projects = projects.filter(p => normalizeStatus(p.status) === opts.filterStatus);
    }
    if (opts.limit) projects = projects.slice(0, opts.limit);

    mount.innerHTML = projects.map(project => projectCardHTML(project, index.devFor(project), { ...opts, partnersByProject })).join('');
  }

  /* ---------------- Projects page filter bar ---------------- */
  async function initProjectFilters(barSelector, gridSelector) {
    const data = await loadData();
    const bar = document.querySelector(barSelector);
    if (!bar) return;
    // Only show canonical stages that actually have projects, in lifecycle order.
    const present = new Set((data.projects || []).map(p => normalizeStatus(p.status)).filter(Boolean));
    const statuses = ['All', ...STATUS_ORDER.filter(s => present.has(s))];
    bar.innerHTML = statuses.map((s, i) =>
      `<button class="filter-chip ${i === 0 ? 'active' : ''}" data-status="${s === 'All' ? 'all' : s}">${s}</button>`
    ).join('');
    bar.addEventListener('click', (e) => {
      const chip = e.target.closest('.filter-chip');
      if (!chip) return;
      bar.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      renderProjectGrid(gridSelector, { filterStatus: chip.dataset.status, fromPages: true });
    });
  }

  /* ---------------- Query param helper ---------------- */
  function qsParam(name) {
    return new URLSearchParams(location.search).get(name);
  }

  /* ---------------- Developer detail (generic, Firestore-live) ----------------
     Serves /pages/developer-<slug> (rewritten here by firebase.json) and the
     older /pages/developer.html?id=<slug>, so a developer added purely through
     the admin console gets a clean, indexable URL immediately — no generate.py
     / redeploy needed. Run generate.py when convenient and that developer
     graduates to a real pre-rendered page at the same address. */
  async function renderDeveloperDetail(mountSelector, id) {
    const data = await loadData();
    const mount = document.querySelector(mountSelector);
    if (!mount) return;
    const dev = data.developers.find(d => d.id === id || d.docId === id);
    if (!dev) {
      applyEntitySeo('developer', id);
      mount.innerHTML = `<div class="wrap section"><p>We couldn't find that developer. <a href="developers.html" style="color:var(--brass-bright)">Back to the leaderboard →</a></p></div>`;
      return;
    }
    const projects = buildDevIndex(data).projectsFor(dev);
    const partnersByProject = Object.fromEntries(projects.map(project => [project.id, projectPartners(project, data.channelPartners)]));
    const devName = plain(dev.name);
    applyEntitySeo('developer', dev.id, {
      title: `${devName} — projects in Gurugram | Bid Gurgaon`,
      description: `${devName} on the Bid Gurgaon Gurugram developer leaderboard — ${projects.length} project${projects.length === 1 ? '' : 's'}, ${plain(reraPhrase(dev.rera)).toLowerCase()}. ${plain(dev.tagline)}`.trim(),
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'Organization',
        name: devName,
        url: `${SITE_ORIGIN}/pages/developer-${encodeURIComponent(dev.id)}`,
        address: { '@type': 'PostalAddress', addressLocality: plain(dev.locality) || 'Gurugram', addressRegion: 'Haryana', addressCountry: 'IN' },
        description: plain(dev.tagline),
        makesOffer: projects.slice(0, 25).map(p => ({
          '@type': 'Offer',
          itemOffered: { '@type': 'Residence', name: plain(p.name), url: `${SITE_ORIGIN}/pages/project-${encodeURIComponent(p.id)}` }
        }))
      }
    });
    // Only state the facts we actually have — a record with no position bid
    // must not render as "Rank #0 · ₹0/month", and the position quoted here is
    // the one derived from the bid, so it matches the leaderboard exactly.
    const devBits = [];
    const held = positionOf(marketOf(data, 'developer'), dev);
    if (dev.tagline) devBits.push(dev.tagline);
    if (held) devBits.push(`Position #${held.position} by visibility bid`);
    if (held) devBits.push(bidWithCycle(held.bid, dev.bidCycle));
    if (dev.since) devBits.push(`on board since ${fmtDateLong(dev.since)}`);
    mount.innerHTML = `
      <header class="page-head">
        <div class="wrap">
          <div class="breadcrumb"><a href="../index.html">Home</a> / <a href="developers.html">Developers</a> / ${dev.name}</div>
          <span class="eyebrow">${dev.locality || ''}</span>
          <h1>${dev.name} <span class="badge-rera">RERA ✓</span></h1>
          <p class="desc">${devBits.join(' · ')}</p>
        </div>
      </header>
      <section class="section">
        <div class="wrap">
          <span class="eyebrow">RERA registration</span>
          <p style="margin-top:10px; color:var(--paper-dim);">${reraPhrase(dev.rera)}</p>
          <span class="eyebrow">Projects by ${dev.name}</span>
          <div class="project-grid reveal" id="dev-project-grid" style="margin-top:16px;"></div>
        </div>
      </section>`;
    const grid = mount.querySelector('#dev-project-grid');
    if (grid) {
      grid.innerHTML = projects.length
        ? projects.map(project => projectCardHTML(project, dev, { fromPages: true, partnersByProject })).join('')
        : `<p style="color:var(--steel);">No projects listed yet.</p>`;
    }
    initReveal();
  }

  /* ---------------- Project detail (generic, Firestore-live) ---------------- */
  async function renderProjectDetail(mountSelector, id) {
    const data = await loadData();
    const mount = document.querySelector(mountSelector);
    if (!mount) return;
    const project = data.projects.find(p => p.id === id || p.docId === id);
    if (!project) {
      applyEntitySeo('project', id);
      mount.innerHTML = `<div class="wrap section"><p>We couldn't find that project. <a href="projects.html" style="color:var(--brass-bright)">Back to all projects →</a></p></div>`;
      return;
    }
    const dev = buildDevIndex(data).devFor(project);
    const devHeld = positionOf(marketOf(data, 'developer'), dev);
    const partners = projectPartners(project, data.channelPartners);
    const status = normalizeStatus(project.status);
    const pName = plain(project.name);
    const firstImage = (Array.isArray(project.images) ? project.images.filter(Boolean) : [])[0];
    applyEntitySeo('project', project.id, {
      title: `${pName}${plain(project.locality) ? ', ' + plain(project.locality) : ''} — price, configurations, RERA | Bid Gurgaon`,
      description: [
        pName,
        dev ? 'by ' + plain(dev.name) : '',
        plain(project.locality) ? 'in ' + plain(project.locality) : '',
        status ? '· ' + status : '',
        plain(project.configs) ? '· ' + plain(project.configs) : '',
        plain(project.priceRange) ? '· ' + plain(project.priceRange) : ''
      ].filter(Boolean).join(' '),
      image: firstImage ? (String(firstImage).startsWith('http') ? plain(firstImage) : SITE_ORIGIN + '/' + plain(firstImage).replace(/^\.\.\//, '').replace(/^\//, '')) : '',
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'Residence',
        name: pName,
        url: `${SITE_ORIGIN}/pages/project-${encodeURIComponent(project.id)}`,
        description: plain(project.summary),
        address: { '@type': 'PostalAddress', addressLocality: plain(project.locality) || 'Gurugram', addressRegion: 'Haryana', addressCountry: 'IN' },
        ...(dev ? { brand: { '@type': 'Organization', name: plain(dev.name), url: `${SITE_ORIGIN}/pages/developer-${encodeURIComponent(dev.id)}` } } : {})
      }
    });
    mount.innerHTML = `
      <header class="page-head">
        <div class="wrap">
          <div class="breadcrumb"><a href="../index.html">Home</a> / <a href="projects.html">Projects</a> / ${project.name}</div>
          <span class="eyebrow">${status ? status + ' · ' : ''}${project.locality || ''}</span>
          <h1>${project.name}</h1>
          <p class="desc">${dev ? `by <a href="${detailHref('developer', dev.id, { fromPages: true })}" style="color:var(--brass-bright)">${dev.name}</a>` : ''}${project.rera ? `${dev ? ' · ' : ''}RERA ${project.rera}` : ''}</p>
        </div>
      </header>
      <section class="section">
        <div class="wrap">
          <div class="detail-grid">
            <div>
              <div class="detail-hero-media detail-gallery">${detailMediaInner(project)}</div>
              <span class="eyebrow">About this project</span>
              <p style="margin-top:14px; color:var(--paper-dim); font-size:16px; line-height:1.85; max-width:65ch;">${project.summary || ''}</p>
              <table class="spec-table">
                <tr><td>Status</td><td>${status || '—'}</td></tr>
                <tr><td>Possession</td><td>${project.possession || '—'}</td></tr>
                <tr><td>Configurations</td><td>${project.configs || '—'}</td></tr>
                <tr><td>Size range</td><td>${project.sizeRange || '—'}</td></tr>
                <tr><td>Price range</td><td>${project.priceRange || '—'}</td></tr>
                <tr><td>Locality</td><td>${project.locality || '—'}</td></tr>
                <tr><td>RERA registration</td><td>${project.rera || '—'}</td></tr>
              </table>
              ${(project.highlights && project.highlights.length) ? `
                <span class="eyebrow">Highlights</span>
                <ul class="highlight-list" style="margin-top:16px;">
                  ${project.highlights.map(h => `<li>${h}</li>`).join('')}
                </ul>` : ''}
            </div>
            <div>
              ${dev ? `
              <div class="sidebar-card">
                <h4>Developer</h4>
                <div class="dev-card-mini">
                  <div class="logo">${dev.logo || initials(dev.name)}</div>
                  <div>
                    <div style="font-weight:600;">${dev.name} <span class="badge-rera">RERA ✓</span></div>
                    <div class="small-print" style="margin-top:4px;">${devHeld
                      ? `Position #${devHeld.position} by visibility bid · ${bidWithCycle(devHeld.bid, dev.bidCycle)}`
                      : 'Registered — no position bid on the developer board yet'}</div>
                  </div>
                </div>
                <a href="${detailHref('developer', dev.id, { fromPages: true })}" class="btn btn-outline btn-block btn-sm" style="margin-top:16px;">See all ${dev.name} projects</a>
              </div>` : ''}
              <div class="sidebar-card">
                <h4>Active Channel Partners on this project</h4>
                ${partners.length ? partners.map((cp, index) => `
                  <div class="partner-row">
                    <div class="logo">${initials(cp.name)}</div>
                    <div class="info">
                      <div class="n">#${index + 1} <a href="${detailHref('partner', cp.id, { fromPages: true })}" class="entity-name-link">${cp.name}</a> <span class="badge-rera" style="margin-left:4px;">RERA ✓</span></div>
                      <div class="b">${bidWithCycle(cp.bidAmount, cp.bidCycle)} · on this project since ${cp.since ? fmtDateLong(cp.since) : '—'}</div>
                    </div>
                  </div>
                  <div class="call-strip">
                    <a class="btn btn-outline btn-sm" style="flex:1; justify-content:center;" href="${detailHref('partner', cp.id, { fromPages: true })}">Profile</a>
                    <a class="btn btn-call btn-sm" style="flex:1; justify-content:center;" href="tel:${(cp.phone || '').replace(/\s/g, '')}">Call ${cp.name.split(' ')[0]}</a>
                  </div>
                `).join('') : `<p class="small-print">No channel partner active on this project yet.</p>`}
              </div>
              <p class="small-print">Ranked by position bid for this specific project — highest bid appears first. Any registered partner may outbid another to move up.</p>
              <div class="sidebar-card" style="text-align:center;">
                <h4>Are you a channel partner on ${project.name}?</h4>
                <p class="small-print" style="margin:8px 0 16px;">Get featured here in front of every buyer viewing this project. Register and place a position bid — pay more than the partner above you to move up.</p>
                <a href="for-partners.html?project=${project.id}" class="btn btn-bid btn-block btn-sm">Bid to be featured on this project</a>
                ${partners.length ? `<a href="bid-now.html?type=partner&rank=1&entity=${encodeURIComponent(plain(partners[0].name))}&current=${partners[0].bidAmount || 0}" class="btn btn-outline btn-block btn-sm" style="margin-top:10px;">Outbid the top partner (${bidWithCycle(partners[0].bidAmount, partners[0].bidCycle)})</a>` : ''}
              </div>
            </div>
          </div>
        </div>
      </section>
      ${partners.length ? `
      <div class="mobile-call-bar">
        <a class="btn btn-outline btn-sm" style="flex:1;justify-content:center" href="https://wa.me/${(partners[0].whatsapp || partners[0].phone || '').replace(/[^\d+]/g, '')}">WhatsApp</a>
        <a class="btn btn-call btn-sm" style="flex:2;justify-content:center" href="tel:${(partners[0].phone || '').replace(/\s/g, '')}">Call ${partners[0].name.split(' ')[0]} now</a>
      </div>` : ''}`;
  }

  /* ---------------- Channel partner profile (generic, Firestore-live) ----------------
     "So customers really know with whom they're going to speak" — a
     sleek, standalone profile a buyer can check before calling: photo,
     bio, years of experience, specialization/languages if supplied,
     and the real list of projects they're active on (not just a
     count). Every field here is optional and just omits its section
     when blank, so partial profiles (or ones filled in later via
     registration) never render broken/empty-looking blocks. */
  async function renderPartnerDetail(mountSelector, id) {
    const data = await loadData();
    const mount = document.querySelector(mountSelector);
    if (!mount) return;
    const cp = data.channelPartners.find(c => c.id === id || c.docId === id);
    if (!cp) {
      applyEntitySeo('partner', id);
      mount.innerHTML = `<div class="wrap section"><p>We couldn't find that channel partner. <a href="channel-partners.html" style="color:var(--brass-bright)">Back to the leaderboard →</a></p></div>`;
      return;
    }
    const cpName = plain(cp.name);
    applyEntitySeo('partner', cp.id, {
      title: `${cpName} — RERA-registered channel partner in Gurugram | Bid Gurgaon`,
      description: [
        `${cpName} is a RERA-registered channel partner on the Bid Gurgaon leaderboard`,
        cp.experienceYears ? `${plain(cp.experienceYears)} years' experience` : '',
        plain(cp.specialization),
        (cp.activeOn || []).length ? `active on ${(cp.activeOn || []).length} Gurugram projects` : ''
      ].filter(Boolean).join(' · '),
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'RealEstateAgent',
        name: cpName,
        url: `${SITE_ORIGIN}/pages/partner-${encodeURIComponent(cp.id)}`,
        telephone: plain(cp.phone),
        description: plain(cp.bio) || plain(cp.tagline),
        areaServed: { '@type': 'City', name: 'Gurugram' },
        knowsLanguage: plain(cp.languages).split(',').map(s => s.trim()).filter(Boolean)
      }
    });
    const devMap = Object.fromEntries(data.developers.map(d => [d.id, d]));
    const activeOn = cp.activeOn || [];
    const projects = activeOn
      .map(pid => data.projects.find(p => p.id === pid))
      .filter(Boolean);
    const partnersByProject = Object.fromEntries(projects.map(project => [project.id, projectPartners(project, data.channelPartners)]));
    const cpHeld = positionOf(marketOf(data, 'partner'), cp);
    const tags = [...(cp.specialization ? cp.specialization.split(',') : []), ...(cp.languages ? cp.languages.split(',') : [])]
      .map(t => t.trim()).filter(Boolean);
    const avatar = isImageUrl(cp.photo)
      ? `<img src="${cp.photo}" alt="${cp.name}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`
      : initials(cp.name);
    mount.innerHTML = `
      <header class="page-head">
        <div class="wrap">
          <div class="breadcrumb"><a href="../index.html">Home</a> / <a href="channel-partners.html">Channel Partners</a> / ${cp.name}</div>
          <span class="eyebrow">${cp.reraChannel || 'RERA-registered channel partner'}</span>
          <div class="profile-id">
            <div class="avatar-xl">${avatar}</div>
            <div>
              <h1>${cp.name} <span class="badge-rera">RERA ✓</span></h1>
              ${cp.tagline ? `<p class="desc" style="margin-top:6px;">${cp.tagline}</p>` : ''}
            </div>
          </div>
        </div>
      </header>
      <section class="section">
        <div class="wrap">
          <div class="detail-grid">
            <div>
              ${cp.bio ? `
                <span class="eyebrow">About</span>
                <p style="margin-top:14px; color:var(--paper-dim); font-size:16px; line-height:1.85; max-width:65ch;">${cp.bio}</p>` : ''}
              ${tags.length ? `<div class="tag-list">${tags.map(t => `<span class="tag">${t}</span>`).join('')}</div>` : ''}
              <span class="eyebrow" style="display:block; margin-top:${cp.bio || tags.length ? '32px' : '0'};">Active on ${projects.length} project${projects.length === 1 ? '' : 's'}</span>
              <div class="project-grid reveal" id="partner-project-grid" style="margin-top:16px;"></div>
            </div>
            <div>
              <div class="sidebar-card">
                <h4>Contact</h4>
                <div class="call-strip" style="flex-direction:column;">
                  <a class="btn btn-call btn-sm btn-block" href="tel:${(cp.phone || '').replace(/\s/g, '')}">Call ${cp.name.split(' ')[0]}</a>
                  ${cp.whatsapp || cp.phone ? `<a class="btn btn-outline btn-sm btn-block" href="https://wa.me/${(cp.whatsapp || cp.phone || '').replace(/[^\d+]/g, '')}">WhatsApp</a>` : ''}
                </div>
              </div>
              <div class="sidebar-card">
                <h4>On the board</h4>
                <table class="spec-table">
                  <tr><td>Position</td><td>${cpHeld ? '#' + cpHeld.position : 'Not on the board'}</td></tr>
                  <tr><td>Position bid</td><td>${cpHeld ? bidWithCycle(cpHeld.bid, cp.bidCycle) : 'No position bid yet'}</td></tr>
                  <tr><td>On board since</td><td>${cp.since ? fmtDateLong(cp.since) : '—'}</td></tr>
                  ${cp.experienceYears ? `<tr><td>Experience</td><td>${cp.experienceYears} year${cp.experienceYears == 1 ? '' : 's'}</td></tr>` : ''}
                  <tr><td>RERA registration</td><td>${cp.reraChannel || '—'}</td></tr>
                </table>
              </div>
              <p class="small-print">Position is the partner's own visibility bid, highest first — the same open-bid rule as every board on this site. It is not a rating of service quality.</p>
            </div>
          </div>
        </div>
      </section>
      <div class="mobile-call-bar">
        <a class="btn btn-outline btn-sm" style="flex:1;justify-content:center" href="https://wa.me/${(cp.whatsapp || cp.phone || '').replace(/[^\d+]/g, '')}">WhatsApp</a>
        <a class="btn btn-call btn-sm" style="flex:2;justify-content:center" href="tel:${(cp.phone || '').replace(/\s/g, '')}">Call ${cp.name.split(' ')[0]} now</a>
      </div>`;
    const grid = mount.querySelector('#partner-project-grid');
    if (grid) {
      grid.innerHTML = projects.length
        ? projects.map(project => projectCardHTML(project, devMap[project.developerId], { fromPages: true, partnersByProject })).join('')
        : `<p style="color:var(--steel);">No projects listed yet — check back soon.</p>`;
    }
    initReveal();
  }

  /* ---------------- Site content (admin-editable text) ----------------
     Any element with data-cms="someKey" gets its text swapped for
     data.site.someKey if that key exists and is non-empty on the
     meta/site record (Firestore) or the "site" block in data.json.
     Nothing is required — elements just keep their built-in text if
     the key isn't set, so this never breaks the page. */
  /* ---- live project list on the generated developer pages ----
     The static cards are built from data.json at deploy time, so a developer
     page could only ever show the projects that existed in that snapshot (DLF
     showed 6 while the live projects page had many more). The grid now carries
     data-live-projects="<devId>" and is re-rendered from live data on load, so
     it always matches the projects page. If live data returns nothing for this
     developer we keep the pre-rendered cards rather than blanking the page. */
  async function fillLiveDevProjects() {
    const grids = document.querySelectorAll('[data-live-projects]');
    if (!grids.length) return;
    const data = await loadData();
    const index = buildDevIndex(data);
    warnOrphans(index);
    const partnersByProject = Object.fromEntries((data.projects || []).map(p => [p.id, projectPartners(p, data.channelPartners)]));
    grids.forEach(grid => {
      const devId = grid.getAttribute('data-live-projects');
      const dev = (data.developers || []).find(d => d.id === devId || d.docId === devId);
      if (!dev) return;
      const projects = index.projectsFor(dev);
      const countEl = document.querySelector(`[data-live-project-count="${devId}"]`);
      if (countEl) countEl.textContent = projects.length;
      if (!projects.length) return;
      grid.innerHTML = projects
        .map(project => projectCardHTML(project, dev, { fromPages: true, partnersByProject }))
        .join('');
      initReveal();
    });
  }

  async function applySiteContent() {
    const data = await loadData();
    const site = data.site || {};
    document.querySelectorAll('[data-cms]').forEach(el => {
      const key = el.getAttribute('data-cms');
      const val = site[key];
      if (val === undefined || val === null || val === '') return;
      el.textContent = val;
    });
    document.querySelectorAll('[data-cms-href]').forEach(el => {
      const key = el.getAttribute('data-cms-href');
      const val = site[key];
      if (!val) return;
      if (key.toLowerCase().includes('whatsapp')) {
        el.setAttribute('href', 'https://wa.me/' + String(val).replace(/[^\d]/g, ''));
      } else if (key.toLowerCase().includes('phone')) {
        el.setAttribute('href', 'tel:' + String(val).replace(/\s/g, ''));
      }
    });
  }

  /* ---- live developer position / bid on the generated static pages ----
     Position and bid change the moment someone outbids someone else, so the
     generated pages ship a hook instead of a baked-in number:
       <span data-live-rank="dlf-limited" data-live-format="rank-sep" hidden></span>
     Formats: "rank-sep" → "Position #3 by visibility bid · " (prefix)
              "rank-bid" → "Position #3 by visibility bid · ₹1,65,000/month"
     The number comes from the derived board, not the stored `rank` field, so a
     static page and the leaderboard can't print different positions for the
     same developer. A developer holding no position is left hidden, so a page
     can never print "Rank #0 on the board" or "₹0/mo". */
  async function fillLiveDevStats() {
    const hooks = document.querySelectorAll('[data-live-rank]');
    if (!hooks.length) return;
    const data = await loadData();
    const devs = data.developers || [];
    const board = marketOf(data, 'developer');
    hooks.forEach(el => {
      const id = el.getAttribute('data-live-rank');
      const dev = devs.find(d => d.id === id || d.docId === id);
      const held = positionOf(board, dev);
      if (!held) return;
      const text = `Position #${held.position} by visibility bid · ${bidWithCycle(held.bid, dev.bidCycle)}`;
      el.textContent = el.getAttribute('data-live-format') === 'rank-sep' ? text + ' · ' : text;
      el.hidden = false;
    });
  }

  /* The browser knows it is offline before Firestore admits it. Without this,
     a tab that loses its connection keeps a green "LIVE" pill on screen while
     the SDK silently retries the Listen stream — the pill would be claiming a
     live market that isn't there. Coming back online is left to Firestore: the
     next server snapshot promotes the pill to LIVE on its own. */
  function initConnectionWatch() {
    if (initConnectionWatch.bound) return;
    initConnectionWatch.bound = true;
    window.addEventListener('offline', () => {
      if (document.querySelector('[data-live-state]')) paintLiveState('error');
    });
  }

  function init() {
    initNav();
    initReveal();
    initConnectionWatch();
    applySiteContent();
    fillLiveDevStats();
    fillLiveDevProjects();
  }

  return {
    loadData, fmtINR, fmtDateLong, monthsSince, initials, qsParam,
    renderDeveloperBoard, renderPartnerBoard, renderHeroPreview, renderPartnerHeroPreview, renderOutbidBanner, computeRequiredBid,
    renderMarketPulse, marketOf, positionOf,
    renderProjectGrid, initProjectFilters, applySiteContent, fillLiveDevStats, fillLiveDevProjects, buildDevIndex,
    detailHref, entityId, applyEntitySeo,
    renderDeveloperDetail, renderProjectDetail, renderPartnerDetail,
    togglePartnerChips, init
  };
})();

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.chip-expand-btn');
  if (btn && window.GGN && typeof window.GGN.togglePartnerChips === 'function') {
    e.preventDefault();
    window.GGN.togglePartnerChips(btn);
  }
});

document.addEventListener('DOMContentLoaded', GGN.init);
