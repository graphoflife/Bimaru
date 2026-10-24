/* Bimaru — game UI: menu, board, input, feedback and persistence. */
(function () {
  'use strict';

  const E = window.BimaruEngine;
  const { UNKNOWN, WATER, SHIP, SHAPE } = E;
  const Sound = window.Sound;
  const FX = window.FX;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');
  // Keep in sync with the side-layout media query in style.css.
  const sideLayout = window.matchMedia('(min-aspect-ratio: 5/4) and (min-width: 700px), (orientation: landscape) and (max-height: 520px)');
  const SPRING = 'cubic-bezier(.34,1.56,.64,1)';

  const SIZES = [6, 8, 10, 12];
  const DIFFS = ['easy', 'medium', 'hard', 'expert'];
  const DIFF_INFO = {
    easy: { name: 'Easy', desc: 'Plenty of clues. Counting rows and columns is all you need.' },
    medium: { name: 'Medium', desc: 'Fewer clues. Count carefully and read the ship shapes.' },
    hard: { name: 'Hard', desc: 'Think about where the big ships can still fit.' },
    expert: { name: 'Expert', desc: 'Very few clues. Now and then, ask “what if this were a ship?” and spot what breaks.' },
  };
  const MODES = ['cycle', 'water', 'ship'];
  const MODE_INFO = {
    cycle: { label: 'Cycle', toast: 'Tap cycles water → ship → empty' },
    water: { label: 'Water', toast: 'Tap places water' },
    ship: { label: 'Ship', toast: 'Tap places ship pieces' },
  };

  /* ------------------------------------------------------------------ */
  /* Storage                                                              */
  /* ------------------------------------------------------------------ */

  const KEYS = { settings: 'bimaru.settings', save: 'bimaru.save', stats: 'bimaru.stats' };
  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function store(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode or full */ }
  }
  function forget(key) {
    try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  const settings = Object.assign(
    { size: 8, difficulty: 'medium', sound: true, haptics: true, assist: false, theme: 'auto', mode: 'cycle', seenHelp: false },
    load(KEYS.settings, {})
  );
  if (!SIZES.includes(settings.size)) settings.size = 8;
  if (!DIFFS.includes(settings.difficulty)) settings.difficulty = 'medium';
  if (!MODES.includes(settings.mode)) settings.mode = 'cycle';
  const saveSettings = () => store(KEYS.settings, settings);
  Sound.enabled = settings.sound;

  /* ------------------------------------------------------------------ */
  /* Small helpers                                                        */
  /* ------------------------------------------------------------------ */

  function el(tag, cls, html) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html != null) node.innerHTML = html;
    return node;
  }

  function fmtTime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (x) => String(x).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  }

  function buzz(pattern) {
    if (!settings.haptics || !navigator.vibrate) return;
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    try { navigator.vibrate(pattern); } catch (e) { /* ignore */ }
  }

  function center(node) {
    const r = node.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  }

  function animate(node, frames, opts) {
    if (reduceMotion.matches || !node.animate) return null;
    return node.animate(frames, opts);
  }

  const POP = [{ transform: 'scale(1)' }, { transform: 'scale(1.3)' }, { transform: 'scale(1)' }];
  const SHAKE = [
    { transform: 'translateX(0)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(5px)' },
    { transform: 'translateX(-3px)' }, { transform: 'translateX(0)' },
  ];

  let toastTimer = null;
  function toast(msg, action, duration) {
    const t = $('#toast');
    t.textContent = '';
    t.classList.toggle('is-long', msg.length > 60);
    t.appendChild(el('span', null)).textContent = msg;
    if (action) {
      const b = el('button');
      b.type = 'button';
      b.textContent = action.label;
      b.addEventListener('click', () => { t.classList.remove('is-show'); action.run(); });
      t.appendChild(b);
    }
    t.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('is-show'), duration || (action ? 4200 : 2200));
  }
  $('#toast').addEventListener('click', (e) => { if (!e.target.closest('button')) e.currentTarget.classList.remove('is-show'); });

  /* ------------------------------------------------------------------ */
  /* Theme                                                                */
  /* ------------------------------------------------------------------ */

  function applyTheme() {
    const root = document.documentElement;
    if (settings.theme === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', settings.theme);
    const dark = settings.theme === 'dark' || (settings.theme === 'auto' && darkScheme.matches);
    const metas = $$('meta[name="theme-color"]');
    metas.forEach((m, k) => {
      m.removeAttribute('media');
      m.setAttribute('content', dark ? '#1b1a2a' : '#f5f2fc');
      if (k > 0) m.remove();
    });
  }
  darkScheme.addEventListener && darkScheme.addEventListener('change', applyTheme);

  /* ------------------------------------------------------------------ */
  /* Screens & segmented controls                                         */
  /* ------------------------------------------------------------------ */

  let screen = 'menu';
  function showScreen(name) {
    screen = name;
    document.body.dataset.screen = name;
    $$('.screen').forEach((s) => s.classList.toggle('is-active', s.id === 'screen-' + name));
  }

  const segs = [];
  function initSeg(root, value, onChange) {
    const thumb = el('span', 'seg-thumb');
    root.prepend(thumb);
    const buttons = $$('button', root);
    function select(v, instant) {
      root.dataset.value = v;
      buttons.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === String(v))));
      const b = buttons.find((x) => x.dataset.value === String(v));
      if (!b) return;
      if (instant) thumb.style.transition = 'none';
      thumb.style.width = b.offsetWidth + 'px';
      thumb.style.transform = `translateX(${b.offsetLeft}px)`;
      if (instant) { void thumb.offsetWidth; thumb.style.transition = ''; }
    }
    buttons.forEach((b, k) => b.addEventListener('click', () => {
      if (root.dataset.value === b.dataset.value) return;
      select(b.dataset.value);
      Sound.select(k * 2);
      buzz(5);
      onChange(b.dataset.value);
    }));
    select(value, true);
    const api = { select, refresh: () => select(root.dataset.value, true) };
    segs.push(api);
    return api;
  }

  /* ------------------------------------------------------------------ */
  /* Game state                                                           */
  /* ------------------------------------------------------------------ */

  const board = $('#board');
  const boardWrap = $('#board-wrap');
  const fleetEl = $('#fleet');
  let game = null;
  let cellEls = [], pieceEls = [], rowEls = [], colEls = [];
  let geo = { cell: 40, gap: 4, label: 30, pad: 6 };

  function createGame(p, saved) {
    const n = p.n, N = n * n;
    const given = new Uint8Array(N), shapes = new Int8Array(N), marks = new Int8Array(N);
    for (const [i, v, sh] of p.hints) {
      given[i] = 1;
      marks[i] = v;
      if (v === SHIP) shapes[i] = sh;
    }
    if (saved && saved.marks) {
      for (let i = 0; i < N; i++) if (!given[i]) marks[i] = saved.marks[i] | 0;
    }
    return {
      p, n, N, given, shapes, marks,
      history: (saved && saved.history) || [],
      future: [],
      elapsed: (saved && saved.elapsed) || 0,
      hintsUsed: (saved && saved.hintsUsed) || 0,
      checks: (saved && saved.checks) || 0,
      won: false,
      lineState: [],
      found: new Set(),
      fleetGroups: [],
      cursor: -1,
      lastTick: null,
    };
  }

  function neighbors(i) {
    const n = game.n, r = (i / n) | 0, c = i % n;
    return {
      u: r > 0 ? i - n : -1,
      d: r < n - 1 ? i + n : -1,
      l: c > 0 ? i - 1 : -1,
      r: c < n - 1 ? i + 1 : -1,
    };
  }

  function diagonals(i) {
    const n = game.n, r = (i / n) | 0, c = i % n, out = [];
    for (const [dr, dc] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < n && cc >= 0 && cc < n) out.push(rr * n + cc);
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Board building & layout                                              */
  /* ------------------------------------------------------------------ */

  function buildBoard() {
    const { n, p } = game;
    board.textContent = '';
    board.style.setProperty('--n', n);
    cellEls = []; pieceEls = []; rowEls = []; colEls = [];
    board.appendChild(el('div', 'corner', '<svg><use href="#i-anchor"/></svg>'));
    for (let c = 0; c < n; c++) {
      const b = el('button', 'count count-col');
      b.type = 'button';
      b.textContent = p.cols[c];
      b.dataset.col = c;
      b.setAttribute('aria-label', `Column ${c + 1}: ${p.cols[c]} ship segments`);
      board.appendChild(b);
      colEls.push(b);
    }
    for (let r = 0; r < n; r++) {
      const b = el('button', 'count count-row');
      b.type = 'button';
      b.textContent = p.rows[r];
      b.dataset.row = r;
      b.setAttribute('aria-label', `Row ${r + 1}: ${p.rows[r]} ship segments`);
      board.appendChild(b);
      rowEls.push(b);
      for (let c = 0; c < n; c++) {
        const i = r * n + c;
        const d = el('div', 'cell', '<span class="wave"></span><span class="piece"></span>');
        d.setAttribute('role', 'gridcell');
        d.style.setProperty('--d', r + c);
        if (game.given[i]) d.classList.add('is-given');
        board.appendChild(d);
        cellEls.push(d);
        pieceEls.push(d.children[1]);
      }
    }
  }

  // Apply geometry without transitions (first render, resume, resize).
  function settleInstantly() {
    board.classList.add('is-static');
    void board.offsetWidth;
    requestAnimationFrame(() => requestAnimationFrame(() => board.classList.remove('is-static')));
  }

  function layout() {
    if (!game) return;
    settleInstantly();
    const n = game.n;
    // The board gets whatever space the fleet and tools leave over, so the
    // whole group can be centred on screen.
    const play = boardWrap.parentElement, cs = getComputedStyle(play);
    let W = play.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    let H = play.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (sideLayout.matches) W -= $('.side').offsetWidth + (parseFloat(cs.columnGap) || 0);
    else H -= $('.fleet-card').offsetHeight + $('.tools').offsetHeight + 2 * (parseFloat(cs.rowGap) || 0);
    if (W <= 0 || H <= 0) return;
    // board side = 2·pad + label + n·(cell + gap), with gap ≈ .09, label ≈ .74, pad ≈ .16 of a cell
    const k = 0.32 + 0.74 + n * 1.09;
    let cell = Math.floor(Math.min(W, H) / k);
    cell = Math.max(16, Math.min(cell, 72));
    const gap = Math.max(2, Math.round(cell * 0.09));
    geo = { cell, gap, label: Math.round(cell * 0.74), pad: Math.max(5, Math.round(cell * 0.16)) };
    const s = board.style;
    s.setProperty('--cell', cell + 'px');
    s.setProperty('--gap', gap + 'px');
    s.setProperty('--label', geo.label + 'px');
    s.setProperty('--pad', geo.pad + 'px');
    for (let i = 0; i < game.N; i++) renderPiece(i);
    layoutFleet();
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                            */
  /* ------------------------------------------------------------------ */

  const STATE_NAME = ['empty', 'water', 'ship'];

  function renderCell(i) {
    const d = cellEls[i], v = game.marks[i];
    d.classList.toggle('is-water', v === WATER);
    d.classList.toggle('is-ship', v === SHIP);
    const n = game.n;
    d.setAttribute('aria-label', `Row ${((i / n) | 0) + 1}, column ${(i % n) + 1}: ${STATE_NAME[v]}${game.given[i] ? ' (given)' : ''}`);
    renderPiece(i);
  }

  function renderAround(i) {
    renderCell(i);
    const nb = neighbors(i);
    for (const j of [nb.u, nb.d, nb.l, nb.r]) if (j >= 0) renderPiece(j);
  }

  /*
   * Each side of a ship piece is one of:
   *   conn  — joins the neighbouring piece (extends into the gap)
   *   round — closed end, fully rounded
   *   flat  — must continue (given end/middle pieces), nearly square
   *   soft  — unknown neighbour, gently rounded
   */
  function shipSides(i) {
    const { marks, shapes } = game;
    const nb = neighbors(i);
    const kind = (j) => (j < 0 ? WATER : marks[j]);
    const sh = shapes[i];
    let orient = 0; // 1 horizontal, 2 vertical
    if (sh === SHAPE.LEFT || sh === SHAPE.RIGHT) orient = 1;
    else if (sh === SHAPE.TOP || sh === SHAPE.BOTTOM) orient = 2;
    else if (sh === SHAPE.MIDDLE) {
      if (kind(nb.l) === SHIP || kind(nb.r) === SHIP || kind(nb.u) === WATER || kind(nb.d) === WATER) orient = 1;
      else if (kind(nb.u) === SHIP || kind(nb.d) === SHIP || kind(nb.l) === WATER || kind(nb.r) === WATER) orient = 2;
    } else if (sh !== SHAPE.SINGLE) {
      if (kind(nb.l) === SHIP || kind(nb.r) === SHIP) orient = 1;
      else if (kind(nb.u) === SHIP || kind(nb.d) === SHIP) orient = 2;
    }
    // The end of a given piece that has to continue.
    const openEnd = { [SHAPE.TOP]: 'd', [SHAPE.BOTTOM]: 'u', [SHAPE.LEFT]: 'r', [SHAPE.RIGHT]: 'l' }[sh];
    const sides = {};
    for (const side of ['u', 'd', 'l', 'r']) {
      const k = kind(nb[side]);
      const along = orient === 1 ? side === 'l' || side === 'r' : orient === 2 ? side === 'u' || side === 'd' : false;
      if (sh === SHAPE.SINGLE) sides[side] = 'round';
      else if (k === SHIP && along) sides[side] = 'conn';
      else if (sh === SHAPE.MIDDLE) sides[side] = 'flat';
      else if (orient && !along) sides[side] = 'round';
      else if (openEnd === side) sides[side] = 'flat';
      else if (sh) sides[side] = 'round';
      else sides[side] = k === UNKNOWN ? 'soft' : 'round';
    }
    return sides;
  }

  function pieceStyle(sides, cell, gap) {
    const pad = Math.round(cell * 0.1);
    const R = (cell - 2 * pad) / 2, M = cell * 0.22, S = cell * 0.08;
    const ext = -(gap / 2 + 0.5);
    const corner = (a, b) => (a === 'conn' || b === 'conn') ? 0
      : (a === 'flat' || b === 'flat') ? S
        : (a === 'round' && b === 'round') ? R : M;
    const at = (side) => (sides[side] === 'conn' ? ext : pad) + 'px';
    return {
      top: at('u'), bottom: at('d'), left: at('l'), right: at('r'),
      borderRadius: `${corner(sides.u, sides.l)}px ${corner(sides.u, sides.r)}px ${corner(sides.d, sides.r)}px ${corner(sides.d, sides.l)}px`,
    };
  }

  function renderPiece(i) {
    if (game.marks[i] !== SHIP) return; // keep the old geometry so it can shrink away
    Object.assign(pieceEls[i].style, pieceStyle(shipSides(i), geo.cell, geo.gap));
  }

  /* ------------------------------------------------------------------ */
  /* Fleet panel                                                          */
  /* ------------------------------------------------------------------ */

  function buildFleet() {
    fleetEl.textContent = '';
    const counts = new Map();
    for (const L of game.p.fleet) counts.set(L, (counts.get(L) || 0) + 1);
    game.fleetGroups = [];
    for (const [L, count] of Array.from(counts).sort((a, b) => b[0] - a[0])) {
      const g = el('div', 'fleet-group');
      const minis = [];
      for (let k = 0; k < count; k++) {
        const m = el('span', 'mini');
        for (let s = 0; s < L; s++) m.appendChild(el('i'));
        g.appendChild(m);
        minis.push(m);
      }
      fleetEl.appendChild(g);
      game.fleetGroups.push({ L, count, el: g, minis });
    }
  }

  function layoutFleet() {
    if (!game) return;
    const W = fleetEl.parentElement.clientWidth - 28;
    const side = getComputedStyle(fleetEl).flexDirection === 'column';
    let m;
    if (side) {
      m = Math.min(...game.fleetGroups.map((g) => (W - g.count * 6) / (g.L * g.count)));
    } else {
      const total = game.p.fleet.reduce((a, b) => a + b, 0);
      m = (W - game.p.fleet.length * 6 - game.fleetGroups.length * 8) / total;
      if (m < 8) m = (W * 2 - game.p.fleet.length * 6) / total / 1.05; // allow two lines
    }
    fleetEl.style.setProperty('--m', Math.max(6, Math.min(side ? 18 : 15, Math.floor(m))) + 'px');
  }

  // Straight runs of ship marks, as the player drew them (the solution is never
  // consulted). A run is "closed" when water or the edge caps both ends, or when
  // it already has the fleet's longest length and so cannot grow any further.
  function shipRuns() {
    const { N, marks } = game;
    const isS = (j) => j >= 0 && marks[j] === SHIP;
    const sea = (j) => j < 0 || marks[j] === WATER;
    const longest = Math.max(...game.p.fleet);
    const runs = [];
    for (let i = 0; i < N; i++) {
      if (marks[i] !== SHIP) continue;
      const nb = neighbors(i);
      if (!isS(nb.l) && isS(nb.r)) {
        const cells = [i];
        let j = i;
        while (isS(neighbors(j).r)) { j = neighbors(j).r; cells.push(j); }
        runs.push({ cells, len: cells.length, closed: cells.length >= longest || (sea(nb.l) && sea(neighbors(j).r)), key: `h${i}-${cells.length}` });
      }
      if (!isS(nb.u) && isS(nb.d)) {
        const cells = [i];
        let j = i;
        while (isS(neighbors(j).d)) { j = neighbors(j).d; cells.push(j); }
        runs.push({ cells, len: cells.length, closed: cells.length >= longest || (sea(nb.u) && sea(neighbors(j).d)), key: `v${i}-${cells.length}` });
      }
      if (!isS(nb.l) && !isS(nb.r) && !isS(nb.u) && !isS(nb.d)) {
        runs.push({ cells: [i], len: 1, closed: sea(nb.l) && sea(nb.r) && sea(nb.u) && sea(nb.d), key: `s${i}` });
      }
    }
    return runs;
  }

  function updateFleet(silent) {
    const found = new Map(), keys = new Set(), fresh = [];
    for (const run of shipRuns()) {
      if (!run.closed) continue;
      found.set(run.len, (found.get(run.len) || 0) + 1);
      keys.add(run.key);
      if (!game.found.has(run.key)) fresh.push(run);
    }
    for (const g of game.fleetGroups) {
      const have = found.get(g.L) || 0;
      g.el.classList.toggle('is-over', have > g.count);
      g.minis.forEach((m, k) => {
        const on = k < have;
        if (on === m.classList.contains('is-found')) return;
        m.classList.toggle('is-found', on);
        if (on && !silent) animate(m, POP, { duration: 480, easing: SPRING, delay: 60 });
      });
    }
    game.found = keys;
    if (!silent && fresh.length) fresh.slice(-2).forEach((run, k) => setTimeout(() => celebrateShip(run), k * 120));
  }

  function celebrateShip(run) {
    run.cells.forEach((i, k) => animate(pieceEls[i],
      [{ transform: 'scale(1)' }, { transform: 'scale(1.2)' }, { transform: 'scale(1)' }],
      { duration: 460, delay: 40 + k * 60, easing: SPRING }));
    const a = center(cellEls[run.cells[0]]), b = center(cellEls[run.cells[run.cells.length - 1]]);
    FX.bubbles((a.x + b.x) / 2, (a.y + b.y) / 2, 8 + run.len * 4, Math.abs(b.x - a.x) / 2 + a.w * 0.3);
    Sound.shipDone(run.len);
    buzz([8, 40, 14]);
  }

  /* ------------------------------------------------------------------ */
  /* Row / column counts                                                  */
  /* ------------------------------------------------------------------ */

  function updateCounts(silent) {
    const { n, marks, p } = game;
    const rs = new Array(n).fill(0), ru = new Array(n).fill(0);
    const cs = new Array(n).fill(0), cu = new Array(n).fill(0);
    for (let i = 0; i < game.N; i++) {
      const r = (i / n) | 0, c = i % n, v = marks[i];
      if (v === SHIP) { rs[r]++; cs[c]++; } else if (v === UNKNOWN) { ru[r]++; cu[c]++; }
    }
    let chime = false;
    for (let k = 0; k < 2 * n; k++) {
      const isRow = k < n, idx = isRow ? k : k - n;
      const ships = isRow ? rs[idx] : cs[idx], open = isRow ? ru[idx] : cu[idx];
      const target = isRow ? p.rows[idx] : p.cols[idx];
      const state = ships > target ? 'over' : ships === target ? (open ? 'done' : 'full') : 'todo';
      const prev = game.lineState[k];
      if (prev === state) continue;
      game.lineState[k] = state;
      const label = isRow ? rowEls[idx] : colEls[idx];
      label.classList.toggle('is-over', state === 'over');
      label.classList.toggle('is-done', state === 'done');
      label.classList.toggle('is-full', state === 'full');
      if (silent || prev === undefined) continue;
      const reached = (state === 'done' || state === 'full') && (prev === 'todo' || prev === 'over');
      if (reached || (state === 'full' && prev === 'done')) {
        animate(label, POP, { duration: 460, easing: SPRING });
        shimmerLine(isRow, idx);
        if (reached) chime = true;
      }
    }
    if (chime) Sound.line();
  }

  function shimmerLine(isRow, idx) {
    const n = game.n;
    for (let k = 0; k < n; k++) {
      const i = isRow ? idx * n + k : k * n + idx;
      animate(cellEls[i], [{ filter: 'brightness(1)' }, { filter: 'brightness(1.1) saturate(1.2)' }, { filter: 'brightness(1)' }],
        { duration: 420, delay: 80 + k * 28, easing: 'ease-out' });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Making marks                                                         */
  /* ------------------------------------------------------------------ */

  function setMark(i, v, batch, fx) {
    const from = game.marks[i];
    if (from === v || game.given[i]) return false;
    game.marks[i] = v;
    batch.push(i, from, v);
    renderAround(i);
    if (fx) markFx(i, v, fx.step || 0);
    return true;
  }

  function markFx(i, v, step) {
    if (v === WATER) Sound.water(step);
    else if (v === SHIP) Sound.ship(step);
    else Sound.erase();
    buzz(v === SHIP ? 12 : 6);
    const cell = cellEls[i];
    const cls = v === WATER ? 'r-water' : v === SHIP ? 'r-ship' : 'r-clear';
    const rings = v === WATER ? 2 : 1;
    if (!reduceMotion.matches) {
      for (let k = 0; k < rings; k++) {
        const r = el('span', 'ripple ' + cls);
        r.addEventListener('animationend', () => r.remove());
        cell.appendChild(r);
      }
    }
    animate(cell, [{ transform: 'scale(.86)' }, { transform: 'scale(1.07)', offset: 0.55 }, { transform: 'scale(1)' }],
      { duration: 380, easing: 'cubic-bezier(.3,.7,.4,1)' });
  }

  function autoWater(i, batch) {
    for (const j of diagonals(i)) {
      if (!game.given[j] && game.marks[j] === UNKNOWN) setMark(j, WATER, batch, null);
    }
  }

  function nextValue(cur, reverse) {
    if (settings.mode === 'water') return cur === WATER ? UNKNOWN : WATER;
    if (settings.mode === 'ship') return cur === SHIP ? UNKNOWN : SHIP;
    const order = [UNKNOWN, WATER, SHIP];
    return order[(order.indexOf(cur) + (reverse ? 2 : 1)) % 3];
  }

  function commit(batch) {
    if (!batch.length) return;
    game.history.push(batch);
    if (game.history.length > 400) game.history.shift();
    game.future = [];
    updateTools();
    persistSoon();
  }

  function afterChange(silent) {
    if (!game) return;
    updateCounts(silent);
    updateFleet(silent);
    updateTools();
    if (!game.won && isSolved()) win();
  }

  function isSolved() {
    const { marks, p } = game;
    for (let i = 0; i < game.N; i++) if ((marks[i] === SHIP) !== (p.solution[i] === 1)) return false;
    return true;
  }

  function wrongCells() {
    const { marks, p, given } = game, out = [];
    for (let i = 0; i < game.N; i++) {
      if (given[i] || marks[i] === UNKNOWN) continue;
      if (marks[i] !== (p.solution[i] ? SHIP : WATER)) out.push(i);
    }
    return out;
  }

  function showWrong(list) {
    for (const i of list) {
      const c = cellEls[i];
      c.classList.remove('is-wrong');
      void c.offsetWidth;
      c.classList.add('is-wrong');
      clearTimeout(c._wrongTimer);
      c._wrongTimer = setTimeout(() => c.classList.remove('is-wrong'), 1900);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Pointer input: tap to cycle, drag to paint                           */
  /* ------------------------------------------------------------------ */

  let gesture = null;

  function cellAt(x, y) {
    const r = board.getBoundingClientRect();
    const step = geo.cell + geo.gap;
    const x0 = r.left + geo.pad + geo.label + geo.gap;
    const y0 = r.top + geo.pad + geo.label + geo.gap;
    const fx = (x - x0 + geo.gap / 2) / step, fy = (y - y0 + geo.gap / 2) / step;
    if (fx < 0 || fy < 0 || fx >= game.n || fy >= game.n) return -1;
    return Math.floor(fy) * game.n + Math.floor(fx);
  }

  function lineCells(a, b) {
    const n = game.n;
    let r0 = (a / n) | 0, c0 = a % n;
    const r1 = (b / n) | 0, c1 = b % n;
    const dr = Math.abs(r1 - r0), dc = Math.abs(c1 - c0);
    const sr = r0 < r1 ? 1 : -1, sc = c0 < c1 ? 1 : -1;
    let err = dc - dr;
    const out = [];
    while (r0 !== r1 || c0 !== c1) {
      const e2 = 2 * err;
      if (e2 > -dr) { err -= dr; c0 += sc; }
      if (e2 < dc) { err += dc; r0 += sr; }
      out.push(r0 * n + c0);
    }
    return out;
  }

  function paint(i) {
    // Only paint cells that looked like the starting cell, so a drag never wipes other work.
    if (game.given[i] || game.marks[i] !== gesture.from) return;
    if (setMark(i, gesture.value, gesture.batch, { step: gesture.step })) {
      if (settings.assist && gesture.value === SHIP) autoWater(i, gesture.batch);
      gesture.step++;
      afterChange(false);
    }
  }

  board.addEventListener('contextmenu', (e) => e.preventDefault());

  board.addEventListener('pointerdown', (e) => {
    if (!game || game.won || e.target.closest('.count')) return;
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return;
    if (gesture) endGesture(); // a second finger finishes the first stroke
    const i = cellAt(e.clientX, e.clientY);
    if (i < 0) return;
    e.preventDefault();
    Sound.unlock();
    document.body.classList.remove('kbd');
    setCursor(i);
    try { board.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (game.given[i]) {
      const c = cellEls[i];
      c.classList.remove('is-nudge');
      void c.offsetWidth;
      c.classList.add('is-nudge');
      Sound.nudge();
      gesture = null;
      return;
    }
    const from = game.marks[i];
    gesture = {
      id: e.pointerId, from, value: nextValue(from, e.button === 2),
      last: i, batch: [], step: ((i / game.n) | 0) % 3 + (i % game.n) % 4,
    };
    paint(i);
  });

  board.addEventListener('pointermove', (e) => {
    if (!game) return;
    if (!gesture) {
      if (e.pointerType === 'mouse') hover(cellAt(e.clientX, e.clientY));
      return;
    }
    if (e.pointerId !== gesture.id) return;
    const i = cellAt(e.clientX, e.clientY);
    if (i < 0 || i === gesture.last) return;
    for (const j of lineCells(gesture.last, i)) paint(j);
    gesture.last = i;
  });

  function endGesture(e) {
    if (!gesture || (e && e.pointerId !== gesture.id)) return;
    commit(gesture.batch);
    gesture = null;
  }
  board.addEventListener('pointerup', endGesture);
  board.addEventListener('pointercancel', endGesture);
  board.addEventListener('lostpointercapture', endGesture);
  board.addEventListener('pointerleave', () => hover(-1));

  let hot = [];
  function hover(i) {
    hot.forEach((x) => x.classList.remove('is-hot'));
    hot = [];
    if (i < 0 || !game || game.won) return;
    hot = [rowEls[(i / game.n) | 0], colEls[i % game.n]];
    hot.forEach((x) => x.classList.add('is-hot'));
  }

  // Tapping a count fills the rest of its line once the answer is forced.
  board.addEventListener('click', (e) => {
    const b = e.target.closest('.count');
    if (!b || !game || game.won) return;
    if (b.dataset.row != null) fillLine(true, +b.dataset.row);
    else fillLine(false, +b.dataset.col);
  });

  function fillLine(isRow, idx) {
    const { n, marks, p } = game;
    let ships = 0;
    const open = [];
    for (let k = 0; k < n; k++) {
      const i = isRow ? idx * n + k : k * n + idx;
      if (marks[i] === SHIP) ships++;
      else if (marks[i] === UNKNOWN) open.push(i);
    }
    const target = isRow ? p.rows[idx] : p.cols[idx];
    const label = isRow ? rowEls[idx] : colEls[idx];
    let v = null;
    if (open.length && ships === target) v = WATER;
    else if (open.length && ships + open.length === target) v = SHIP;
    if (v === null) {
      animate(label, SHAKE, { duration: 380, easing: 'ease-out' });
      Sound.nudge();
      return;
    }
    const batch = [];
    open.forEach((i) => { game.marks[i] = v; batch.push(i, UNKNOWN, v); });
    if (settings.assist && v === SHIP) {
      for (const i of open) {
        for (const j of diagonals(i)) {
          if (!game.given[j] && game.marks[j] === UNKNOWN) { game.marks[j] = WATER; batch.push(j, UNKNOWN, WATER); }
        }
      }
    }
    commit(batch);
    const extra = [];
    for (let k = 0; k < batch.length; k += 3) if (!open.includes(batch[k])) extra.push(batch[k]);
    open.forEach((i, k) => setTimeout(() => { if (game && game.marks[i] === v) { renderAround(i); markFx(i, v, k); } }, k * 45));
    extra.forEach((i) => setTimeout(() => renderAround(i), open.length * 45));
    animate(label, POP, { duration: 420, easing: SPRING });
    const g = game;
    setTimeout(() => { if (game === g) afterChange(false); }, open.length * 45 + 40);
  }

  /* ------------------------------------------------------------------ */
  /* Keyboard                                                             */
  /* ------------------------------------------------------------------ */

  function setCursor(i) {
    if (!game) return;
    if (game.cursor >= 0 && cellEls[game.cursor]) cellEls[game.cursor].classList.remove('is-cursor');
    game.cursor = i;
    if (i >= 0) cellEls[i].classList.add('is-cursor');
  }

  function keyMark(v) {
    const i = game.cursor;
    if (i < 0) return;
    if (game.given[i]) { Sound.nudge(); return; }
    const batch = [];
    if (setMark(i, v, batch, { step: (i % game.n) % 5 })) {
      if (settings.assist && v === SHIP) autoWater(i, batch);
      commit(batch);
      afterChange(false);
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') document.body.classList.add('kbd');
    if (openModal) {
      if (e.key === 'Escape' && openModal.id !== 'modal-win') closeModal();
      return;
    }
    if (screen !== 'game' || !game) return;
    const k = e.key, ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (ctrl && k.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (ctrl || e.altKey) return;
    if (k === 'Escape') { goMenu(); return; }
    if (game.won) return;
    const n = game.n;
    const moves = { ArrowUp: -n, ArrowDown: n, ArrowLeft: -1, ArrowRight: 1 };
    if (moves[k] != null) {
      e.preventDefault();
      document.body.classList.add('kbd');
      let i = game.cursor;
      if (i < 0) i = 0;
      else {
        const r = (i / n) | 0, c = i % n;
        if (k === 'ArrowUp' && r > 0) i -= n;
        if (k === 'ArrowDown' && r < n - 1) i += n;
        if (k === 'ArrowLeft' && c > 0) i -= 1;
        if (k === 'ArrowRight' && c < n - 1) i += 1;
      }
      setCursor(i);
      Sound.select(((i / n) | 0) + (i % n));
      return;
    }
    if (game.cursor < 0 && /^( |Enter|w|W|s|S|1|2|0|x|X|Backspace|Delete)$/.test(k)) {
      document.body.classList.add('kbd');
      setCursor(0);
    }
    switch (k) {
      case ' ': case 'Enter':
        e.preventDefault();
        keyMark(nextValue(game.marks[game.cursor], e.shiftKey));
        break;
      case 'w': case 'W': case '1': keyMark(WATER); break;
      case 's': case 'S': case '2': keyMark(SHIP); break;
      case '0': case 'x': case 'X': case 'Backspace': case 'Delete': e.preventDefault(); keyMark(UNKNOWN); break;
      case 'h': case 'H': useHint(); break;
      case 'u': case 'U': undo(); break;
      case 'r': case 'R': redo(); break;
      case 'm': case 'M': setMode(MODES[(MODES.indexOf(settings.mode) + 1) % MODES.length]); break;
    }
  });

  /* ------------------------------------------------------------------ */
  /* Tools                                                                */
  /* ------------------------------------------------------------------ */

  function updateTools() {
    if (!game) return;
    const live = !game.won;
    $('#tool-undo').disabled = !live || !game.history.length;
    $('#tool-redo').disabled = !live || !game.future.length;
    $('#tool-hint').disabled = !live;
    $('#tool-check').disabled = !live;
    let any = false;
    for (let i = 0; i < game.N; i++) if (!game.given[i] && game.marks[i] !== UNKNOWN) { any = true; break; }
    $('#tool-clear').disabled = !live || !any;
    $('#tool-mode').disabled = !live;
  }

  function rerender(indices) {
    const all = new Set();
    for (const i of indices) {
      all.add(i);
      const nb = neighbors(i);
      for (const j of [nb.u, nb.d, nb.l, nb.r]) if (j >= 0) all.add(j);
    }
    for (const i of all) renderCell(i);
    for (const i of indices) animate(cellEls[i], [{ transform: 'scale(.9)' }, { transform: 'scale(1)' }], { duration: 300, easing: SPRING });
  }

  function undo() {
    if (!game || game.won || !game.history.length) return;
    const b = game.history.pop();
    const touched = [];
    for (let k = b.length - 3; k >= 0; k -= 3) { game.marks[b[k]] = b[k + 1]; touched.push(b[k]); }
    game.future.push(b);
    rerender(touched);
    Sound.undo();
    buzz(5);
    afterChange(true);
    persistSoon();
  }

  function redo() {
    if (!game || game.won || !game.future.length) return;
    const b = game.future.pop();
    const touched = [];
    for (let k = 0; k < b.length; k += 3) { game.marks[b[k]] = b[k + 2]; touched.push(b[k]); }
    game.history.push(b);
    rerender(touched);
    Sound.redo();
    buzz(5);
    afterChange(false);
    persistSoon();
  }

  function setMode(mode, quiet) {
    settings.mode = mode;
    saveSettings();
    const b = $('#tool-mode');
    b.dataset.mode = mode;
    $('#mode-label').textContent = MODE_INFO[mode].label;
    b.setAttribute('aria-label', `Tap mode: ${MODE_INFO[mode].label}`);
    if (!quiet) {
      Sound.select(MODES.indexOf(mode) * 2 + 2);
      toast(MODE_INFO[mode].toast);
    }
  }

  function useHint() {
    if (!game || game.won || game.proof) return;
    const wrong = wrongCells();
    if (wrong.length) {
      showWrong(wrong);
      Sound.error();
      buzz([30, 40, 30]);
      toast(wrong.length === 1 ? 'One mark is wrong. Fix it first.' : `${wrong.length} marks are wrong. Fix them first.`);
      return;
    }
    const h = E.nextHint(game.p, game.marks);
    if (!h) return;
    game.hintsUsed++;
    persistSoon();
    const info = explain(h);
    toast(info.text, null, Math.max(4500, info.text.length * 55));
    Sound.hint();
    buzz(10);
    if (h.why && h.why.code === E.WHY.WHAT_IF && h.why.trial && !reduceMotion.matches) playProof(h, info);
    else {
      highlight(info.lines, info.cells, 'is-focus', 2600);
      revealHint(h);
    }
  }

  function revealHint(h) {
    if (!game || game.won || game.marks[h.index] !== UNKNOWN) return;
    const batch = [];
    setMark(h.index, h.value, batch, null);
    commit(batch);
    const c = cellEls[h.index];
    c.classList.remove('is-hinted');
    void c.offsetWidth;
    c.classList.add('is-hinted');
    setTimeout(() => c.classList.remove('is-hinted'), 1700);
    const pt = center(c);
    FX.sparkle(pt.x, pt.y, 12, pt.w * 0.3);
    afterChange(false);
  }

  // Shows a "what if" proof: the assumption, what it forces, what breaks.
  function playProof(h, info) {
    const g = game;
    const trial = h.why.trial;
    const step = Math.min(130, 1000 / trial.length);
    const ghosts = [];
    game.proof = true;
    trial.forEach(([i, v], k) => setTimeout(() => {
      if (game !== g || game.marks[i] !== UNKNOWN) return;
      const c = cellEls[i];
      if (v === SHIP) Object.assign(pieceEls[i].style, pieceStyle({ u: 'soft', d: 'soft', l: 'soft', r: 'soft' }, geo.cell, geo.gap));
      c.classList.add(v === SHIP ? 'ghost-ship' : 'ghost-water');
      if (k === 0) c.classList.add('ghost-assume');
      ghosts.push(c);
      if (v === SHIP) Sound.ship(k); else Sound.water(k);
    }, k * step));
    const broke = trial.length * step + 250;
    setTimeout(() => {
      if (game !== g) return;
      highlight(info.lines, info.cells, 'is-broken', 1400);
      Sound.error();
      buzz([20, 30, 20]);
    }, broke);
    setTimeout(() => {
      ghosts.forEach((c) => c.classList.remove('ghost-ship', 'ghost-water', 'ghost-assume'));
      if (game !== g) return;
      game.proof = false;
      revealHint(h);
      Sound.hint();
    }, broke + 1300);
  }

  function highlight(lines, cells, cls, ms) {
    const nodes = lines.map((k) => (k < game.n ? rowEls[k] : colEls[k - game.n]))
      .concat(cells.map((i) => cellEls[i]));
    nodes.forEach((x) => { x.classList.remove(cls); void x.offsetWidth; x.classList.add(cls); });
    setTimeout(() => nodes.forEach((x) => x.classList.remove(cls)), ms);
  }

  /* Turns a solver reason into a sentence plus the rows, columns and cells it is about. */
  function explain(h) {
    const { n, p } = game;
    const W = E.WHY;
    const cellName = (i) => `row ${((i / n) | 0) + 1}, column ${(i % n) + 1}`;
    const lineName = (k) => (k < n ? `Row ${k + 1}` : `Column ${k - n + 1}`);
    const target = (k) => (k < n ? p.rows[k] : p.cols[k - n]);
    const segs = (x) => `${x} ship segment${x === 1 ? '' : 's'}`;
    const what = (v) => (v === SHIP ? 'a ship' : 'water');
    const why = h.why;
    if (!why) {
      return { text: 'No short proof from here (this puzzle is from an older version), so this cell is free.', lines: [], cells: [] };
    }
    const out = { lines: [], cells: [] };
    switch (why.code) {
      case W.DIAG:
        out.cells = [why.a];
        out.text = `Ships never touch, not even at the corners. This cell touches the corner of the ship piece at ${cellName(why.a)}, so it is water.`;
        break;
      case W.SHAPE: {
        out.cells = [why.a];
        const sh = game.shapes[why.a], at = cellName(why.a);
        if (sh === SHAPE.SINGLE) out.text = `The round piece at ${at} is a one-cell submarine, so every cell next to it is water.`;
        else if (sh === SHAPE.MIDDLE) {
          out.text = h.value === SHIP
            ? `The square piece at ${at} is the middle of a ship. The other direction is blocked, so the ship continues here.`
            : `The square piece at ${at} is the middle of a ship that runs the other way, so its sides are water.`;
        } else {
          out.text = h.value === SHIP
            ? `The rounded piece at ${at} is the end of a ship, and the ship continues on its flat side, right here.`
            : `The rounded piece at ${at} is the end of a ship, so the cells around its rounded side are water.`;
        }
        break;
      }
      case W.LINE_FULL:
        out.lines = [why.a];
        out.text = target(why.a) === 0
          ? `${lineName(why.a)} has no ship segments at all, so it is all water.`
          : `${lineName(why.a)} already has ${target(why.a) === 1 ? 'its one ship segment' : `all ${segs(target(why.a))}`}, so the rest of it is water.`;
        break;
      case W.LINE_FILL:
        out.lines = [why.a];
        out.text = why.b === 1
          ? `${lineName(why.a)} still needs 1 ship segment and has just 1 empty cell left, so that cell is a ship.`
          : `${lineName(why.a)} still needs ${segs(why.b)} and has exactly ${why.b} empty cells left, so all of them are ship segments.`;
        break;
      case W.NO_FIT:
        out.cells = [h.index];
        out.text = 'None of the ships that are still missing can fit through this cell, so it is water.';
        break;
      case W.ONLY_PLACES:
        out.cells = [].concat(...(why.extra || []));
        out.text = why.b === 1
          ? `The ship of length ${why.a} has only one place left where it fits, ${h.value === SHIP ? 'and this cell is part of it' : 'and this cell is right at its end, so it is water'}.`
          : `There are exactly ${why.b} places left for the ${why.b} missing ships of length ${why.a}, so every one is used${h.value === SHIP ? ', and this cell is part of one' : ', and this cell sits at the end of one, so it is water'}.`;
        break;
      case W.OVERLAP:
        out.cells = [].concat(...(why.extra || []));
        out.text = `The ship of length ${why.a} can only go in ${why.b} places, and every one of them covers this cell.`;
        break;
      case W.GROW:
        out.cells = why.extra || [why.a];
        out.text = `The ship piece at ${cellName(why.a)} can only be finished in ways that all cover this cell.`;
        break;
      case W.WHAT_IF: {
        const f = why.extra || {};
        let broke = 'something would break';
        switch (f.code) {
          case W.LINE_OVER: broke = `${lineName(f.a).toLowerCase()} would get more than its ${segs(target(f.a))}`; out.lines = [f.a]; break;
          case W.LINE_UNDER: broke = `${lineName(f.a).toLowerCase()} would no longer have room for its ${segs(target(f.a))}`; out.lines = [f.a]; break;
          case W.DIAG: broke = 'two ships would touch at a corner'; out.cells = [f.a]; break;
          case W.SHAPE: broke = `the given piece at ${cellName(f.a)} would no longer fit`; out.cells = [f.a]; break;
          case W.TOO_LONG:
            broke = f.b != null
              ? `${lineName(f.b).toLowerCase()} would get a ship longer than ${f.a}, the longest in the fleet`
              : `a ship would get longer than ${f.a}, the longest in the fleet`;
            if (f.b != null) out.lines = [f.b];
            break;
          case W.TOO_MANY:
            broke = `there would be more ships of length ${f.a} than the fleet has`;
            out.cells = f.extra || [];
            break;
        }
        out.text = `What if this cell were ${what(why.a)}? Then ${broke}. So it must be ${what(h.value)}.`;
        break;
      }
      default:
        out.text = `This cell must be ${what(h.value)}.`;
    }
    return out;
  }

  function check() {
    if (!game || game.won) return;
    const wrong = wrongCells();
    game.checks++;
    if (wrong.length) {
      showWrong(wrong);
      Sound.error();
      buzz([30, 40, 30]);
      toast(wrong.length === 1 ? 'Found 1 mistake' : `Found ${wrong.length} mistakes`);
    } else {
      Sound.good();
      buzz(10);
      toast('All good so far!');
      const n = game.n;
      cellEls.forEach((c, i) => {
        if (game.marks[i] === UNKNOWN) return;
        animate(c, [{ filter: 'brightness(1)' }, { filter: 'brightness(1.12)' }, { filter: 'brightness(1)' }],
          { duration: 500, delay: (((i / n) | 0) + (i % n)) * 25, easing: 'ease-out' });
      });
    }
    persistSoon();
  }

  function clearBoard() {
    if (!game || game.won) return;
    const batch = [];
    for (let i = 0; i < game.N; i++) {
      if (game.given[i] || game.marks[i] === UNKNOWN) continue;
      batch.push(i, game.marks[i], UNKNOWN);
      game.marks[i] = UNKNOWN;
    }
    if (!batch.length) return;
    commit(batch);
    const n = game.n;
    for (let k = 0; k < batch.length; k += 3) {
      const i = batch[k];
      setTimeout(() => { if (game && game.marks[i] === UNKNOWN) renderAround(i); }, (((i / n) | 0) + (i % n)) * 18);
    }
    Sound.erase();
    buzz(14);
    afterChange(true);
    toast('Board cleared', { label: 'Undo', run: undo });
  }

  $('#tool-undo').addEventListener('click', undo);
  $('#tool-redo').addEventListener('click', redo);
  $('#tool-hint').addEventListener('click', useHint);
  $('#tool-check').addEventListener('click', check);
  $('#tool-clear').addEventListener('click', clearBoard);
  $('#tool-mode').addEventListener('click', () => setMode(MODES[(MODES.indexOf(settings.mode) + 1) % MODES.length]));

  /* ------------------------------------------------------------------ */
  /* Timer & persistence                                                  */
  /* ------------------------------------------------------------------ */

  let timerId = null;
  function tick() {
    if (!game) return;
    const now = performance.now();
    if (game.lastTick != null && !game.won) game.elapsed += now - game.lastTick;
    if (game.lastTick != null) game.lastTick = now;
    $('#status-time').textContent = fmtTime(game.elapsed);
  }
  function startTimer() {
    if (!game || game.won || timerId) return;
    game.lastTick = performance.now();
    timerId = setInterval(() => { tick(); if (Math.random() < 0.1) persistSoon(); }, 500);
    tick();
  }
  function stopTimer() {
    if (game) { tick(); game.lastTick = null; }
    clearInterval(timerId);
    timerId = null;
  }

  let persistTimer = null;
  function persistSoon() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persist, 400);
  }
  function persist() {
    clearTimeout(persistTimer);
    if (!game || game.won) return;
    store(KEYS.save, {
      p: game.p,
      marks: Array.from(game.marks),
      elapsed: Math.round(game.elapsed),
      hintsUsed: game.hintsUsed,
      checks: game.checks,
      history: game.history.slice(-200),
    });
  }

  function savedGame() {
    const s = load(KEYS.save, null);
    if (!s || !s.p || !Array.isArray(s.marks) || !SIZES.includes(s.p.n) || !Array.isArray(s.p.solution)) return null;
    return s;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopTimer(); persist(); }
    else if (screen === 'game' && !openModal) startTimer();
  });
  window.addEventListener('pagehide', () => { stopTimer(); persist(); });

  /* ------------------------------------------------------------------ */
  /* Stats                                                                */
  /* ------------------------------------------------------------------ */

  function allStats() { return load(KEYS.stats, {}); }
  function statFor(all, n, d) {
    const k = `${n}-${d}`;
    if (!all[k]) all[k] = { played: 0, won: 0, clean: 0, best: null };
    return all[k];
  }
  function countPlayed(n, d) {
    const all = allStats();
    statFor(all, n, d).played++;
    store(KEYS.stats, all);
  }
  function recordWin() {
    const all = allStats();
    const s = statFor(all, game.n, game.p.difficulty);
    s.won++;
    s.played = Math.max(s.played, s.won);
    let best = false;
    if (game.hintsUsed === 0) {
      s.clean++;
      if (s.best == null || game.elapsed < s.best) { s.best = Math.round(game.elapsed); best = true; }
    }
    store(KEYS.stats, all);
    return { best, won: s.won };
  }

  function renderStats() {
    const all = allStats();
    let won = 0, played = 0, clean = 0;
    Object.values(all).forEach((s) => { won += s.won; played += s.played; clean += s.clean; });
    $('#stats-sum').innerHTML =
      `<div class="stat"><b>${won}</b><span>Solved</span></div>` +
      `<div class="stat"><b>${played}</b><span>Played</span></div>` +
      `<div class="stat"><b>${clean}</b><span>No hints</span></div>`;
    let html = '<thead><tr><th></th>' + SIZES.map((n) => `<th scope="col">${n}×${n}</th>`).join('') + '</tr></thead><tbody>';
    for (const d of DIFFS) {
      html += `<tr><th scope="row">${DIFF_INFO[d].name}</th>`;
      for (const n of SIZES) {
        const s = all[`${n}-${d}`];
        if (!s || !s.won) html += '<td class="empty">–</td>';
        else html += `<td>${s.best != null ? fmtTime(s.best) : '✓'}<small>${s.won}× solved</small></td>`;
      }
      html += '</tr>';
    }
    $('#stats-table').innerHTML = html + '</tbody>';
  }

  let resetArmed = null;
  $('#stats-reset').addEventListener('click', (e) => {
    const b = e.currentTarget;
    if (!resetArmed) {
      b.textContent = 'Tap again to reset';
      resetArmed = setTimeout(() => { b.textContent = 'Reset statistics'; resetArmed = null; }, 3000);
      return;
    }
    clearTimeout(resetArmed);
    resetArmed = null;
    forget(KEYS.stats);
    b.textContent = 'Reset statistics';
    renderStats();
    Sound.erase();
  });

  /* ------------------------------------------------------------------ */
  /* Starting, winning, leaving                                           */
  /* ------------------------------------------------------------------ */

  function newGame(size, difficulty, seed) {
    const p = E.generate({ size, difficulty, seed });
    countPlayed(size, difficulty);
    startGame(p, null);
  }

  function startGame(p, saved) {
    closeModal(true);
    stopTimer();
    game = createGame(p, saved);
    board.classList.remove('is-won');
    fleetEl.classList.remove('is-won');
    buildBoard();
    buildFleet();
    $('#status-mode').textContent = `${p.n}×${p.n} · ${DIFF_INFO[p.difficulty].name}`;
    showScreen('game');
    layout();
    for (let i = 0; i < game.N; i++) renderCell(i);
    settleInstantly();
    afterChange(true);
    setMode(settings.mode, true);
    dealIn();
    startTimer();
    persist();
    if (!settings.seenHelp) {
      settings.seenHelp = true;
      saveSettings();
      setTimeout(() => { if (screen === 'game' && !openModal) showModal('howto'); }, 900);
    }
  }

  function dealIn() {
    Sound.deal();
    if (reduceMotion.matches) return;
    const n = game.n;
    cellEls.forEach((c, i) => animate(c,
      [{ opacity: 0, transform: 'scale(.3) translateY(14px)' }, { opacity: 1, transform: 'none' }],
      { duration: 520, delay: 140 + (((i / n) | 0) + (i % n)) * 24, easing: SPRING, fill: 'backwards' }));
    rowEls.concat(colEls).forEach((c, k) => animate(c,
      [{ opacity: 0, transform: 'scale(.5)' }, { opacity: 1, transform: 'none' }],
      { duration: 420, delay: 80 + (k % n) * 30, easing: SPRING, fill: 'backwards' }));
    $$('.mini', fleetEl).forEach((m, k) => animate(m,
      [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
      { duration: 400, delay: 200 + k * 40, easing: SPRING, fill: 'backwards' }));
  }

  function win() {
    game.won = true;
    gesture = null;
    stopTimer();
    setCursor(-1);
    hover(-1);
    const result = recordWin();
    forget(KEYS.save);
    const n = game.n;
    const rest = [];
    for (let i = 0; i < game.N; i++) if (game.marks[i] === UNKNOWN) { game.marks[i] = WATER; rest.push(i); }
    const delayOf = (i) => (((i / n) | 0) + (i % n)) * 26;
    rest.forEach((i) => setTimeout(() => renderCell(i), 120 + delayOf(i)));
    for (let s = 0; s < Math.min(5, rest.length); s++) setTimeout(() => Sound.water(s * 2), 120 + s * 70);
    setTimeout(() => updateCounts(true), 140 + delayOf(game.N - 1));
    board.classList.add('is-won');
    fleetEl.classList.add('is-won');
    updateTools();
    const g = game;
    setTimeout(() => {
      if (game !== g) return;
      Sound.win();
      buzz([20, 50, 20, 50, 40]);
      const c = center(board);
      FX.confetti(c.x, c.y - c.h * 0.1, 150);
      FX.rain(60);
    }, 380);
    setTimeout(() => { if (game === g) openWin(result); }, 1600);
  }

  function openWin(result) {
    const p = game.p;
    $('#win-lead').textContent = `${p.n}×${p.n} · ${DIFF_INFO[p.difficulty].name}`;
    $('#win-time').textContent = fmtTime(game.elapsed);
    $('#win-hints').textContent = game.hintsUsed;
    $('#win-streak').textContent = result.won;
    $('#win-best').hidden = !result.best;
    showModal('win');
  }

  function goMenu() {
    stopTimer();
    persist();
    closeModal(true);
    showScreen('menu');
    refreshContinue();
  }

  function refreshContinue() {
    const s = savedGame();
    const b = $('#btn-continue');
    b.hidden = !s;
    if (s) $('#continue-info').textContent = `${s.p.n}×${s.p.n} · ${DIFF_INFO[s.p.difficulty].name} · ${fmtTime(s.elapsed || 0)}`;
  }

  async function share() {
    if (!game) return;
    const p = game.p;
    const url = `${location.origin}${location.pathname}#${p.n}-${p.difficulty}-${p.seed}`;
    const text = `I found the fleet in a ${p.n}×${p.n} ${DIFF_INFO[p.difficulty].name} Bimaru in ${fmtTime(game.elapsed)}. Can you beat it?`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Bimaru', text, url }); } catch (e) { /* cancelled */ }
      return;
    }
    try {
      await navigator.clipboard.writeText(`${text} ${url}`);
      toast('Link copied to clipboard');
    } catch (e) {
      toast(url);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Modals                                                               */
  /* ------------------------------------------------------------------ */

  let openModal = null;
  function showModal(name) {
    closeModal(true);
    const m = $('#modal-' + name);
    if (!m) return;
    if (name === 'stats') renderStats();
    if (name === 'howto') renderDemos();
    if (name === 'settings') syncSettingsForm();
    m.classList.add('is-open');
    openModal = m;
    if (screen === 'game' && name !== 'win') stopTimer();
    requestAnimationFrame(() => segs.forEach((s) => s.refresh()));
    const focusable = m.querySelector('.sheet-actions .btn, .btn-primary');
    if (focusable && document.body.classList.contains('kbd')) setTimeout(() => focusable.focus({ preventScroll: true }), 50);
  }
  function closeModal(quiet) {
    if (!openModal) return;
    openModal.classList.remove('is-open');
    openModal = null;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    if (!quiet && screen === 'game' && game && !game.won) startTimer();
  }
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal()));
  $$('[data-open]').forEach((b) => b.addEventListener('click', () => showModal(b.dataset.open)));

  function demoCell(sides, given) {
    const c = el('div', 'cell is-ship' + (given ? ' is-given' : ''), '<span class="wave"></span><span class="piece"></span>');
    Object.assign(c.children[1].style, pieceStyle(sides, 30, 3));
    return c;
  }
  function renderDemos() {
    const R = 'round', C = 'conn', F = 'flat';
    const fleet = $('#demo-fleet');
    fleet.textContent = '';
    [
      { u: R, d: R, l: R, r: C }, { u: R, d: R, l: C, r: C }, { u: R, d: R, l: C, r: C }, { u: R, d: R, l: C, r: R }, null,
      { u: R, d: R, l: R, r: C }, { u: R, d: R, l: C, r: R }, null,
      { u: R, d: R, l: R, r: R },
    ].forEach((s) => fleet.appendChild(s ? demoCell(s, false) : el('span', 'demo-gap')));
    const given = $('#demo-given');
    given.textContent = '';
    [
      { u: R, d: F, l: R, r: R }, null, { u: F, d: F, l: F, r: F }, null, { u: R, d: R, l: R, r: F }, null, { u: R, d: R, l: R, r: R }, null,
    ].forEach((s) => given.appendChild(s ? demoCell(s, true) : el('span', 'demo-gap')));
    given.appendChild(el('div', 'cell is-water is-given', '<span class="wave"></span><span class="piece"></span>'));
  }

  /* ------------------------------------------------------------------ */
  /* Menu & settings wiring                                               */
  /* ------------------------------------------------------------------ */

  initSeg($('#seg-size'), settings.size, (v) => { settings.size = +v; saveSettings(); });
  initSeg($('#seg-diff'), settings.difficulty, (v) => {
    settings.difficulty = v;
    saveSettings();
    setDiffText();
  });
  initSeg($('#seg-theme'), settings.theme, (v) => { settings.theme = v; saveSettings(); applyTheme(); });

  function setDiffText() {
    const p = $('#diff-desc');
    p.style.opacity = '0';
    setTimeout(() => { p.textContent = DIFF_INFO[settings.difficulty].desc; p.style.opacity = '1'; }, 120);
  }
  $('#diff-desc').textContent = DIFF_INFO[settings.difficulty].desc;

  $('#btn-play').addEventListener('click', () => {
    const b = $('#btn-play');
    b.disabled = true;
    // Let the press animation play before the (short) generation work.
    setTimeout(() => {
      try { newGame(settings.size, settings.difficulty); } finally { b.disabled = false; }
    }, 90);
  });
  $('#btn-continue').addEventListener('click', () => {
    const s = savedGame();
    if (s) startGame(s.p, s);
  });
  $('#btn-back').addEventListener('click', goMenu);
  $('#btn-help').addEventListener('click', () => showModal('howto'));
  $('#win-next').addEventListener('click', () => {
    const p = game.p;
    newGame(p.n, p.difficulty);
  });
  $('#win-menu').addEventListener('click', goMenu);
  $('#win-share').addEventListener('click', share);

  function syncSound() {
    const b = $('#btn-sound');
    b.innerHTML = `<svg><use href="#${settings.sound ? 'i-sound' : 'i-mute'}"/></svg>`;
    b.setAttribute('aria-label', settings.sound ? 'Mute sound' : 'Turn sound on');
    $('#set-sound').checked = settings.sound;
  }
  function setSound(on) {
    settings.sound = on;
    Sound.enabled = on;
    saveSettings();
    syncSound();
    if (on) Sound.select(4);
  }
  $('#btn-sound').addEventListener('click', () => setSound(!settings.sound));

  function syncSettingsForm() {
    $('#set-sound').checked = settings.sound;
    $('#set-haptics').checked = settings.haptics;
    $('#set-assist').checked = settings.assist;
  }
  $('#set-sound').addEventListener('change', (e) => setSound(e.target.checked));
  $('#set-haptics').addEventListener('change', (e) => {
    settings.haptics = e.target.checked;
    saveSettings();
    buzz(20);
    Sound.select(settings.haptics ? 6 : 2);
  });
  $('#set-assist').addEventListener('change', (e) => {
    settings.assist = e.target.checked;
    saveSettings();
    Sound.select(settings.assist ? 6 : 2);
  });

  // Soft click on every button press (the board has its own sounds).
  document.addEventListener('pointerdown', (e) => {
    Sound.unlock();
    document.body.classList.remove('kbd');
    const b = e.target.closest('button, .switch');
    if (!b || b.disabled || board.contains(b) || b.closest('.seg')) return;
    Sound.tap();
    buzz(4);
  }, true);
  document.addEventListener('touchstart', () => {}, { passive: true }); // enables :active on iOS

  let resizeFrame = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => { layout(); segs.forEach((s) => s.refresh()); });
  });

  /* ------------------------------------------------------------------ */
  /* Boot                                                                 */
  /* ------------------------------------------------------------------ */

  function parseHash() {
    const m = /^#(\d+)-(easy|medium|hard|expert)-(\d+)$/.exec(location.hash);
    if (!m || !SIZES.includes(+m[1])) return null;
    return { size: +m[1], difficulty: m[2], seed: +m[3] };
  }

  function boot() {
    applyTheme();
    syncSound();
    refreshContinue();
    const shared = parseHash();
    if (shared) {
      history.replaceState(null, '', location.pathname + location.search);
      newGame(shared.size, shared.difficulty, shared.seed);
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => segs.forEach((s) => s.refresh()));
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
    }
  }
  window.addEventListener('hashchange', () => {
    const shared = parseHash();
    if (!shared) return;
    history.replaceState(null, '', location.pathname + location.search);
    newGame(shared.size, shared.difficulty, shared.seed);
  });

  boot();
})();
