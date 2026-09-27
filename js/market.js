/* ================================================================
   BID GURGAON — MARKET MODEL  (js/market.js)

   One place that answers "what is the board, right now?", so the
   homepage, the developer leaderboard and the partner leaderboard can
   never disagree about who holds which position.

   The rule this file enforces: POSITION IS DERIVED FROM bidAmount.
   The stored `rank` field is typed by hand in the admin console and
   currently contradicts the bids it is supposed to express (two
   developers share rank 6; the partner board has rank 2 on a ₹799 bid
   sitting above rank 3 on ₹8,800). Every public page promises "ranked
   by position bid, highest first", so the bid is treated as the
   authority and `rank` is kept only as an admin hint — surfaced as
   `rankMismatch` for the console, never shown to a visitor.

   A record with no position bid is NOT given a position. It is
   "pending" — registered, not yet on the board — because printing
   "#undefined · ₹0" would invent a market participant.

   Nothing here writes, and nothing here estimates. Metrics that the
   platform does not yet record (position movement, project contention)
   report themselves as untracked instead of being approximated.
================================================================= */
(function () {
  'use strict';

  // Falls back to these when data.json / meta.site carries no override.
  var DEFAULT_INCREMENT = { developer: 1999, partner: 999 };

  function num(value) { return Number(value) || 0; }

  // Public records are HTML-escaped before they reach any renderer, so a
  // name has to be un-escaped before it can be compared or keyed on.
  function unescapeEntities(value) {
    return String(value == null ? '' : value)
      .replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'")
      .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  }

  function nameKey(value) {
    return unescapeEntities(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  // Indian lakh/crore grouping — mirrors fmtINR() in js/main.js so a figure
  // formatted by this module is byte-identical to one formatted there.
  function fmtINR(amount) {
    var s = Math.round(num(amount)).toString();
    var last3 = s.substring(s.length - 3);
    var other = s.substring(0, s.length - 3);
    if (other !== '') last3 = ',' + last3;
    return '₹' + other.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + last3;
  }

  /* A position exists only where real money is committed to it. */
  function isOnBoard(row) { return num(row && row.bidAmount) > 0; }

  /* ---------------- deriveBoard ----------------
     rows -> { positions, pending, duplicates, onBoard, pendingCount,
               topBid, increment }

     Ordering: bid descending; ties broken by who arrived first (`since`),
     then by name, so the same input always produces the same board. */
  function deriveBoard(rows, opts) {
    opts = opts || {};
    var all = Array.isArray(rows) ? rows.slice() : [];
    var ranked = all.filter(isOnBoard);
    var unranked = all.filter(function (row) { return !isOnBoard(row); });

    ranked.sort(function (a, b) {
      var byBid = num(b.bidAmount) - num(a.bidAmount);
      if (byBid) return byBid;
      var sa = String(a.since || '9999-12-31');
      var sb = String(b.since || '9999-12-31');
      if (sa !== sb) return sa < sb ? -1 : 1;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });

    var claimed = {};
    var positions = ranked.map(function (row, i) {
      var key = nameKey(row.name);
      if (key) claimed[key] = true;
      var bidAbove = i > 0 ? num(ranked[i - 1].bidAmount) : null;
      var out = {};
      for (var k in row) if (Object.prototype.hasOwnProperty.call(row, k)) out[k] = row[k];
      out.position = i + 1;
      out.bid = num(row.bidAmount);
      out.gapAbove = bidAbove === null ? null : bidAbove - num(row.bidAmount);
      out.storedRank = row.rank == null || row.rank === '' ? null : Number(row.rank);
      out.rankMismatch = out.storedRank !== null && out.storedRank !== out.position;
      return out;
    });

    /* A bid-less record is only a market participant if it is a company we
       haven't already counted. Two things disqualify it:

         - its name already holds a position (an admin re-entry of a company
           that is on the board), or
         - its name was already counted as pending (the live data has the same
           channel partner entered twice, once Published and once Draft, with
           no bid on either — that is one company, not two).

       Either way it is a data-entry artefact, so it is split into `duplicates`
       and reported to the console for cleanup instead of being added to a
       public "N registered" figure it would overstate. A bid-less row with no
       name at all is an empty admin row and is treated the same way. */
    var pending = [];
    var duplicates = [];
    unranked.forEach(function (row) {
      var key = nameKey(row.name);
      if (!key || claimed[key]) { duplicates.push(row); return; }
      claimed[key] = true;
      pending.push(row);
    });

    return {
      positions: positions,
      pending: pending,
      duplicates: duplicates,
      onBoard: positions.length,
      pendingCount: pending.length,
      topBid: positions.length ? positions[0].bid : 0,
      increment: num(opts.increment) || DEFAULT_INCREMENT[opts.kind] || DEFAULT_INCREMENT.developer
    };
  }

  /* What it costs to take a given position: beat the holder by the minimum
     increment. Position 1 on an empty board costs the increment alone. */
  function costToTake(board, position) {
    var holder = (board.positions || [])[(position || 1) - 1];
    return (holder ? holder.bid : 0) + board.increment;
  }

  /* Smallest bid gap between two adjacent positions — the tightest contest on
     the board. Null with fewer than two positions: one bidder is not a race. */
  function closestBattle(board) {
    var rows = board.positions || [];
    var best = null;
    for (var i = 1; i < rows.length; i++) {
      var gap = rows[i - 1].bid - rows[i].bid;
      if (!best || gap < best.gap) best = { gap: gap, above: rows[i - 1], below: rows[i] };
    }
    return best;
  }

  /* Most recent arrival(s) on the board, by the `since` the admin recorded.
     Ties are returned together rather than one being picked arbitrarily. */
  function newestEntries(board) {
    var dated = (board.positions || []).filter(function (row) { return row.since; });
    if (!dated.length) return null;
    var latest = dated.reduce(function (max, row) {
      return String(row.since) > max ? String(row.since) : max;
    }, '');
    return { since: latest, rows: dated.filter(function (row) { return String(row.since) === latest; }) };
  }

  /* ---------------- pulse ----------------
     Only metrics that can be computed from what the platform actually stores.

     `movement` and `contested` are deliberately un-computed: there is no
     position-change history in Firestore (no event log is written when a bid
     is applied), and almost no project↔partner links exist, so "biggest
     mover" and "most contested project" would both be guesses. They report
     tracked:false and the UI states that plainly. */
  function pulse(board) {
    return {
      closestBattle: closestBattle(board),
      costToTakeTop: board.onBoard ? costToTake(board, 1) : null,
      depth: { onBoard: board.onBoard, pending: board.pendingCount },
      newest: newestEntries(board),
      movement: { tracked: false, reason: 'Position changes are not recorded yet.' },
      contested: { tracked: false, reason: 'Too few project–partner links to measure contention.' }
    };
  }

  /* ---------------- Position-change animation ----------------
     Call snapshotRows() before re-rendering a board and hand the result to
     flipRows() afterwards: only rows whose on-screen position actually moved
     animate, so the first paint is still and a real takeover is obvious.
     Rows are matched by data-entity. Honours prefers-reduced-motion. */
  function snapshotRows(container, selector) {
    var map = {};
    if (!container) return map;
    var rows = container.querySelectorAll(selector || '[data-entity]');
    Array.prototype.forEach.call(rows, function (el) {
      map[el.getAttribute('data-entity')] = el.getBoundingClientRect().top;
    });
    return map;
  }

  function flipRows(container, selector, before) {
    if (!container || !before) return;
    var ids = Object.keys(before);
    if (!ids.length) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var rows = container.querySelectorAll(selector || '[data-entity]');
    Array.prototype.forEach.call(rows, function (el) {
      var was = before[el.getAttribute('data-entity')];
      if (was == null) return;
      var delta = was - el.getBoundingClientRect().top;
      if (!delta) return;
      el.style.transition = 'none';
      el.style.transform = 'translateY(' + delta + 'px)';
      el.classList.add('is-moving');
      requestAnimationFrame(function () {
        el.style.transition = 'transform .55s cubic-bezier(.22,.61,.36,1)';
        el.style.transform = '';
        setTimeout(function () {
          el.classList.remove('is-moving');
          el.style.transition = '';
        }, 620);
      });
    });
  }

  /* ---------------- Live-state pill ----------------
     The pill claims "LIVE" only while a Firestore subscription is genuinely
     attached. A one-off read, a data.json fallback or a dead listener each say
     so instead, with the time the figures were actually read. */
  var LIVE_STATES = {
    live: { cls: 'is-live', text: 'LIVE', hint: 'Connected to the market — the board updates as bids change.' },
    synced: { cls: 'is-synced', text: 'SYNCED', hint: 'Read once from the live market at ' },
    fallback: { cls: 'is-fallback', text: 'CACHED', hint: 'Live market unreachable — showing the last reviewed snapshot, read at ' },
    error: { cls: 'is-error', text: 'OFFLINE', hint: 'Could not reach the market at ' }
  };

  function liveBadge(el, state, at) {
    if (!el) return;
    var mode = LIVE_STATES[state] || LIVE_STATES.synced;
    var when = at ? new Date(at) : new Date();
    var stamp = when.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    var base = el.getAttribute('data-base-class') || 'live-pill';
    el.className = base + ' ' + mode.cls;
    el.textContent = state === 'live' ? mode.text : mode.text + ' ' + stamp;
    el.setAttribute('title', state === 'live' ? mode.hint : mode.hint + stamp + '.');
  }

  /* ---------------- ItemList JSON-LD ----------------
     The board is the page's primary content, so it gets structured data — but
     it is described as a paid-visibility ordering, never as a quality ranking.
     Replaces its own <script> on every re-render so a live position change
     can't leave stale markup behind. */
  function injectItemList(board, opts) {
    opts = opts || {};
    var rows = (board.positions || []).slice(0, opts.limit || 25);
    if (!rows.length) return;
    var origin = opts.origin || 'https://bidgurgaon.in';
    var pathFor = opts.pathFor || function () { return null; };
    var node = document.querySelector('script[data-ggn-itemlist="' + (opts.id || 'board') + '"]');
    if (!node) {
      node = document.createElement('script');
      node.type = 'application/ld+json';
      node.setAttribute('data-ggn-itemlist', opts.id || 'board');
      document.head.appendChild(node);
    }
    node.textContent = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: opts.name || 'Bid Gurgaon visibility board',
      description: 'Ordered by the position bid each company pays for visibility, highest first. ' +
                   'This is a paid-placement order, not an assessment of quality.',
      numberOfItems: rows.length,
      itemListOrder: 'https://schema.org/ItemListOrderDescending',
      itemListElement: rows.map(function (row) {
        var url = pathFor(row);
        var item = { '@type': 'ListItem', position: row.position, name: unescapeEntities(row.name) };
        if (url) item.url = origin + url;
        return item;
      })
    });
  }

  window.GGN_MARKET = {
    deriveBoard: deriveBoard,
    costToTake: costToTake,
    closestBattle: closestBattle,
    newestEntries: newestEntries,
    pulse: pulse,
    snapshotRows: snapshotRows,
    flipRows: flipRows,
    liveBadge: liveBadge,
    injectItemList: injectItemList,
    fmtINR: fmtINR,
    nameKey: nameKey,
    unescapeEntities: unescapeEntities,
    LIVE_STATES: LIVE_STATES,
    DEFAULT_INCREMENT: DEFAULT_INCREMENT
  };
})();
