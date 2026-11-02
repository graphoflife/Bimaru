/*
 * Bimaru puzzle engine — fleet placement, logical solver and puzzle generator.
 *
 * Works as a classic browser script (window.BimaruEngine), inside a Web Worker
 * (importScripts) and in Node (require). No dependencies.
 *
 * Every puzzle is generated so that a human-style logical solver can finish it
 * without guessing. Because the solver only makes sound deductions, a puzzle it
 * completes has exactly one solution.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BimaruEngine = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const UNKNOWN = 0, WATER = 1, SHIP = 2;

  // Shape of a ship segment. TOP is the upper end of a vertical ship, LEFT the
  // left end of a horizontal one, and so on.
  const SHAPE = { NONE: 0, SINGLE: 1, TOP: 2, BOTTOM: 3, LEFT: 4, RIGHT: 5, MIDDLE: 6 };
  const { NONE, SINGLE, TOP, BOTTOM, LEFT, RIGHT, MIDDLE } = SHAPE;

  // Fleets follow the "triangular" pattern used by published Bimaru puzzles:
  // the longest ship appears once, the next length twice, and so on. Bigger
  // boards get one more length, so both the ship count and the longest ship grow.
  // Arguments are how many ships there are of length 1, 2, 3, ...
  function fleetOf(...counts) {
    const fleet = [];
    counts.forEach((count, k) => { for (let c = 0; c < count; c++) fleet.push(k + 1); });
    return fleet.reverse();
  }

  const FLEETS = {
    6: fleetOf(3, 2, 1),
    8: fleetOf(3, 2, 2, 1),
    10: fleetOf(4, 3, 2, 1),
    12: fleetOf(5, 4, 3, 2, 1),
    15: fleetOf(6, 5, 4, 3, 2, 1),
  };

  // Bumped whenever the generator changes, so old saved puzzles can be told apart.
  const ENGINE_VERSION = 4;

  // level: strongest solving technique the puzzle may require
  //   1 = row/column counts, given piece shapes, ships never touch
  //   2 = + fleet reasoning and nearly complete rows and columns
  //   3 = + a short, local "what if"
  // avoid: the puzzle must NOT be solvable at this level
  // extra: additional free clues, as a fraction of the board size
  // fleet, whatIf: for each board size, [min, max] moments per puzzle at which a
  // person gets stuck and needs that technique. Over the max, the generator adds
  // a clue: enough to feel like the level, never a wall of hard steps.
  const FLEET_MOMENTS = { 6: [2, 3], 8: [2, 4], 10: [2, 5], 12: [3, 7], 15: [4, 9] };
  const DIFFICULTIES = {
    easy: { level: 1, avoid: 0, extra: 0.6 },
    medium: { level: 1, avoid: 0, extra: 0 },
    hard: { level: 2, avoid: 1, extra: 0, fleet: FLEET_MOMENTS },
    expert: {
      level: 3, avoid: 2, extra: 0, fleet: FLEET_MOMENTS,
      whatIf: { 6: [1, 2], 8: [1, 3], 10: [1, 3], 12: [1, 4], 15: [2, 5] },
    },
  };

  /* ------------------------------------------------------------------ */
  /* Utilities                                                            */
  /* ------------------------------------------------------------------ */

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  const geoCache = {};
  function geometry(n) {
    if (geoCache[n]) return geoCache[n];
    const N = n * n;
    const up = new Int16Array(N), down = new Int16Array(N);
    const left = new Int16Array(N), right = new Int16Array(N);
    const diag = new Array(N);
    for (let i = 0; i < N; i++) {
      const r = (i / n) | 0, c = i % n;
      up[i] = r > 0 ? i - n : -1;
      down[i] = r < n - 1 ? i + n : -1;
      left[i] = c > 0 ? i - 1 : -1;
      right[i] = c < n - 1 ? i + 1 : -1;
      const d = [];
      for (const [dr, dc] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && rr < n && cc >= 0 && cc < n) d.push(rr * n + cc);
      }
      diag[i] = d;
    }
    return (geoCache[n] = { n, N, up, down, left, right, diag });
  }

  function fleetCounts(fleet) {
    const maxLen = Math.max.apply(null, fleet);
    const counts = new Int16Array(maxLen + 1);
    for (const L of fleet) counts[L]++;
    return { counts, maxLen };
  }

  /* ------------------------------------------------------------------ */
  /* Random fleet placement                                               */
  /* ------------------------------------------------------------------ */

  function placeFleet(n, fleet, rng) {
    const N = n * n;
    const sorted = fleet.slice().sort((a, b) => b - a);
    for (let attempt = 0; attempt < 2000; attempt++) {
      const grid = new Uint8Array(N);
      const blocked = new Uint8Array(N);
      let ok = true;
      for (const L of sorted) {
        const options = [];
        for (let dir = 0; dir < (L === 1 ? 1 : 2); dir++) {
          const maxR = dir === 1 ? n - L : n - 1;
          const maxC = dir === 0 ? n - L : n - 1;
          for (let r = 0; r <= maxR; r++) {
            for (let c = 0; c <= maxC; c++) {
              let fits = true;
              for (let k = 0; k < L && fits; k++) {
                if (blocked[(r + dir * k) * n + c + (1 - dir) * k]) fits = false;
              }
              if (fits) options.push(r * n + c, dir);
            }
          }
        }
        if (!options.length) { ok = false; break; }
        const pick = Math.floor(rng() * (options.length / 2)) * 2;
        const start = options[pick], dir = options[pick + 1];
        const r0 = (start / n) | 0, c0 = start % n;
        for (let k = 0; k < L; k++) {
          const r = r0 + dir * k, c = c0 + (1 - dir) * k;
          grid[r * n + c] = 1;
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              const rr = r + dr, cc = c + dc;
              if (rr >= 0 && rr < n && cc >= 0 && cc < n) blocked[rr * n + cc] = 1;
            }
          }
        }
      }
      if (ok) return grid;
    }
    throw new Error('Could not place fleet');
  }

  // Shape of the segment at i given a full solution grid (1 = ship).
  function shapeAt(sol, n, i) {
    const g = geometry(n);
    const s = (j) => j >= 0 && sol[j] === 1;
    const u = s(g.up[i]), d = s(g.down[i]), l = s(g.left[i]), r = s(g.right[i]);
    if ((u && d) || (l && r)) return MIDDLE;
    if (d) return TOP;
    if (u) return BOTTOM;
    if (r) return LEFT;
    if (l) return RIGHT;
    return SINGLE;
  }

  /* ------------------------------------------------------------------ */
  /* Logical solver                                                       */
  /* ------------------------------------------------------------------ */
  //
  // Every deduction comes from a technique taught in Bimaru guides, kept at a size
  // a person can follow:
  //   level 1  rows/columns, given piece shapes, ships never touch
  //   level 2  where can the missing ships still fit, and how can a nearly
  //            complete row or column be finished?
  //   level 3  a local "what if": assume a cell in a nearly finished row or column,
  //            follow it through its own row and column, and hit a contradiction.
  // With tracing on, every newly known cell remembers why (st.why) and a
  // contradiction remembers what broke (st.fail). The app turns these
  // reasons into the explanations shown by the Hint button.

  const PLACE_LIMIT = 7; // positions to compare for one ship type
  const COMBO_SHIPS = 3; // ships of one type to fit together
  const LINE_NEAR = 2; // a line is nearly complete with this few ship segments or water cells left
  const LINE_WAYS_LIMIT = 6; // ways to finish a line to compare
  const WHAT_IF_OPEN = 4; // what if: test cells in rows and columns with this few open cells
  const WHAT_IF_HIDDEN = 12; // what if: tries per working assumption before a moment counts as too hidden

  const WHY = {
    DIAG: 1, // a: ship cell. Ships never touch, not even at corners.
    SHAPE: 2, // a: given cell. The given piece fixes the cells around it.
    LINE_FULL: 3, // a: line. The line has all its ship segments; the rest is water.
    LINE_FILL: 4, // a: line, b: segments still needed. Every empty cell is needed.
    NO_FIT: 5, // No ship that is still missing fits through this cell.
    ONLY_PLACES: 6, // a: length, b: places left (= ships left). extra: the places.
    OVERLAP: 7, // a: length, b: places left. Every place covers this cell.
    GROW: 8, // a: first cell, b: length of a ship piece. Every way to finish it covers this cell.
    LINE_OVER: 9, // a: line. Too many ship segments.
    LINE_UNDER: 10, // a: line. Not enough room left for its ship segments.
    TOO_LONG: 11, // a: longest ship length, b: line (if known).
    TOO_MANY: 12, // a: length. More finished ships of this length than the fleet has.
    NO_ROOM: 13, // a: length. The missing ships of this length no longer fit.
    STUCK: 14, // a: first cell of a ship piece that can no longer be finished.
    WHAT_IF: 15, // a: assumed value, extra: the contradiction it leads to, trial: what it forces.
    ONE_WAY: 16, // a: length, b: ships left. extra: the places. Ships fit together only in ways that decide this cell.
    LINE_WAYS: 17, // a: line, b: ways left to finish it. The cell is the same in all of them.
  };

  // Lines are numbered 0..n-1 for rows and n..2n-1 for columns.

  function makeState(p, trace) {
    const geo = geometry(p.n);
    const cells = new Int8Array(geo.N);
    const shape = new Int8Array(geo.N);
    for (const h of p.hints) {
      cells[h[0]] = h[1];
      if (h[1] === SHIP) shape[h[0]] = h[2] || NONE;
    }
    const { counts, maxLen } = fleetCounts(p.fleet);
    return {
      n: p.n, geo, cells, shape, rows: p.rows, cols: p.cols, fleet: counts, maxLen,
      trace: !!trace, why: trace ? new Array(geo.N).fill(null) : null, order: null, fail: null,
      score: null,
    };
  }

  function cloneState(st) {
    return Object.assign({}, st, {
      cells: st.cells.slice(), why: st.why && st.why.slice(), order: null, fail: null,
    });
  }

  function broke(st, code, a, b, extra) {
    if (st.trace && !st.fail) st.fail = { code, a, b, extra };
    return -1;
  }

  // Sets cell j to v. 1 = changed, 0 = already so, -1 = contradiction. j < 0 is off the board.
  function put(st, j, v, code, a, b, extra) {
    if (j < 0) return v === WATER ? 0 : broke(st, code, a, b, extra);
    const cur = st.cells[j];
    if (cur === v) return 0;
    if (cur !== UNKNOWN) return broke(st, code, a, b, extra);
    st.cells[j] = v;
    if (st.trace) {
      st.why[j] = { code, a, b, extra };
      if (st.order) st.order.push(j);
    }
    return 1;
  }

  const isSea = (cells, j) => j < 0 || cells[j] === WATER;
  const isShip = (cells, j) => j >= 0 && cells[j] === SHIP;

  // Level 1: ships never touch, not even diagonally.
  function diagRule(st) {
    const { cells } = st, { N, diag } = st.geo;
    let changed = 0, r;
    for (let i = 0; i < N; i++) {
      if (cells[i] !== SHIP) continue;
      const dg = diag[i];
      for (let k = 0; k < dg.length; k++) {
        if ((r = put(st, dg[k], WATER, WHY.DIAG, i)) < 0) return -1;
        changed |= r;
      }
    }
    return changed;
  }

  // Level 1: a given piece shows the ship's shape around it.
  function shapeRule(st) {
    const { cells, shape } = st, { N, up, down, left, right } = st.geo;
    let changed = 0, r;
    for (let i = 0; i < N; i++) {
      const sh = shape[i];
      if (sh === NONE || cells[i] !== SHIP) continue;
      let waters, ships;
      switch (sh) {
        case SINGLE: waters = [up[i], down[i], left[i], right[i]]; ships = []; break;
        case TOP: waters = [up[i], left[i], right[i]]; ships = [down[i]]; break;
        case BOTTOM: waters = [down[i], left[i], right[i]]; ships = [up[i]]; break;
        case LEFT: waters = [left[i], up[i], down[i]]; ships = [right[i]]; break;
        case RIGHT: waters = [right[i], up[i], down[i]]; ships = [left[i]]; break;
        default: {
          // MIDDLE: horizontal or vertical, decided by whatever is known around it.
          const hBlocked = isSea(cells, left[i]) || isSea(cells, right[i]) ||
            isShip(cells, up[i]) || isShip(cells, down[i]);
          const vBlocked = isSea(cells, up[i]) || isSea(cells, down[i]) ||
            isShip(cells, left[i]) || isShip(cells, right[i]);
          if (hBlocked && vBlocked) return broke(st, WHY.SHAPE, i);
          if (hBlocked) { ships = [up[i], down[i]]; waters = [left[i], right[i]]; }
          else if (vBlocked) { ships = [left[i], right[i]]; waters = [up[i], down[i]]; }
          else continue;
        }
      }
      for (const j of waters) { if ((r = put(st, j, WATER, WHY.SHAPE, i)) < 0) return -1; changed |= r; }
      for (const j of ships) { if ((r = put(st, j, SHIP, WHY.SHAPE, i)) < 0) return -1; changed |= r; }
    }
    return changed;
  }

  // Row and column counts for one line (and no run longer than the longest ship).
  // With fill off it only looks for contradictions.
  function lineStep(st, line, fill) {
    const { n, cells, rows, cols, maxLen } = st;
    const isRow = line < n, idx = isRow ? line : line - n;
    const base = isRow ? idx * n : idx, step = isRow ? 1 : n;
    const target = isRow ? rows[idx] : cols[idx];
    let s = 0, u = 0, run = 0;
    for (let k = 0, j = base; k < n; k++, j += step) {
      const v = cells[j];
      if (v === SHIP) { s++; if (++run > maxLen) return broke(st, WHY.TOO_LONG, maxLen, line); }
      else { run = 0; if (v === UNKNOWN) u++; }
    }
    if (s > target) return broke(st, WHY.LINE_OVER, line);
    if (s + u < target) return broke(st, WHY.LINE_UNDER, line);
    if (!fill || u === 0 || (s !== target && s + u !== target)) return 0;
    const v = s === target ? WATER : SHIP;
    const code = s === target ? WHY.LINE_FULL : WHY.LINE_FILL;
    for (let k = 0, j = base; k < n; k++, j += step) {
      if (cells[j] === UNKNOWN) put(st, j, v, code, line, target - s);
    }
    return 1;
  }

  // Level 1: row and column counts.
  function lineRule(st) {
    let changed = 0;
    for (let line = 0; line < 2 * st.n; line++) {
      const r = lineStep(st, line, true);
      if (r < 0) return -1;
      changed |= r;
    }
    return changed;
  }

  const BASIC_RULES = [diagRule, shapeRule, lineRule];

  function basicPass(st) {
    let changed = 0;
    for (const rule of BASIC_RULES) {
      const r = rule(st);
      if (r < 0) return -1;
      changed |= r;
    }
    return changed;
  }

  // Splits ship cells into straight components. A component is "closed" when
  // water or the edge caps it on every side, i.e. it is a finished ship.
  function components(st) {
    const { n, cells } = st;
    const { N, up, down, left, right } = st.geo;
    const comp = new Int16Array(N).fill(-1);
    const list = [];
    for (let i = 0; i < N; i++) {
      if (cells[i] !== SHIP || comp[i] >= 0) continue;
      const step = isShip(cells, right[i]) ? 1 : isShip(cells, down[i]) ? n : 0;
      const members = [i];
      if (step === 1) for (let j = right[i]; isShip(cells, j); j = right[j]) members.push(j);
      else if (step === n) for (let j = down[i]; isShip(cells, j); j = down[j]) members.push(j);
      const last = members[members.length - 1];
      let closed;
      if (step === 0) {
        closed = isSea(cells, up[i]) && isSea(cells, down[i]) && isSea(cells, left[i]) && isSea(cells, right[i]);
      } else if (step === 1) {
        closed = isSea(cells, left[i]) && isSea(cells, right[last]);
      } else {
        closed = isSea(cells, up[i]) && isSea(cells, down[last]);
      }
      const id = list.length;
      for (const m of members) comp[m] = id;
      list.push({ cells: members, len: members.length, closed });
    }
    return { comp, list };
  }

  // Which sets of k positions can hold all the missing ships of one length together?
  // Returns how many sets work, which positions they use and how often each cell is used.
  function shipCombos(st, places, k, rowS, colS) {
    const { n, cells, rows, cols } = st;
    const rowFree = rows.map((t, r) => t - rowS[r]), colFree = cols.map((t, c) => t - colS[c]);
    const touches = (a, b) => a.some((x) => b.some((y) =>
      Math.abs(((x / n) | 0) - ((y / n) | 0)) <= 1 && Math.abs((x % n) - (y % n)) <= 1));
    const used = new Uint8Array(places.length), hits = new Int16Array(cells.length);
    const chosen = [];
    let combos = 0;
    (function choose(from) {
      if (chosen.length === k) {
        combos++;
        for (const c of chosen) { used[c] = 1; for (const j of places[c]) hits[j]++; }
        return;
      }
      for (let c = from; c < places.length; c++) {
        if (chosen.some((o) => touches(places[o], places[c]))) continue;
        const fresh = places[c].filter((j) => cells[j] === UNKNOWN);
        for (const j of fresh) { rowFree[(j / n) | 0]--; colFree[j % n]--; }
        if (fresh.every((j) => rowFree[(j / n) | 0] >= 0 && colFree[j % n] >= 0)) {
          chosen.push(c);
          choose(c + 1);
          chosen.pop();
        }
        for (const j of fresh) { rowFree[(j / n) | 0]++; colFree[j % n]++; }
      }
    })(0);
    return { combos, used, hits };
  }

  // Level 2: where can the missing ships still fit? Assumes level 1 is done.
  // Goes from the longest ship down, the order Bimaru guides recommend.
  function fleetPass(st) {
    const { n, cells, shape, rows, cols, fleet, maxLen } = st;
    const { N, up, down, left, right } = st.geo;

    const rowS = new Int16Array(n), colS = new Int16Array(n);
    for (let i = 0; i < N; i++) if (cells[i] === SHIP) { rowS[(i / n) | 0]++; colS[i % n]++; }

    const { comp, list } = components(st);
    const remaining = new Int16Array(maxLen + 1);
    for (let L = 1; L <= maxLen; L++) remaining[L] = fleet[L];
    for (const c of list) {
      if (c.len > maxLen) return broke(st, WHY.TOO_LONG, maxLen, lineOf(st, c));
      if (c.closed && --remaining[c.len] < 0) return broke(st, WHY.TOO_MANY, c.len, undefined, c.cells);
    }

    const cover = new Uint8Array(N);
    const C = list.length;
    const compHits = new Int32Array(C);
    const compCell = new Int32Array(C * N);
    const ships = [], waters = []; // [cell, code, a, b, extra]
    const ends = (cs) => {
      const step = cs.length > 1 ? cs[1] - cs[0] : 1, last = cs[cs.length - 1];
      return [step === 1 ? left[cs[0]] : up[cs[0]], step === 1 ? right[last] : down[last]];
    };

    for (let L = maxLen; L >= 1; L--) {
      const k = remaining[L];
      if (k <= 0) continue;
      let places = [];
      for (let dir = 0; dir < (L === 1 ? 1 : 2); dir++) {
        const step = dir === 0 ? 1 : n;
        const maxR = dir === 1 ? n - L : n - 1;
        const maxC = dir === 0 ? n - L : n - 1;
        for (let r = 0; r <= maxR; r++) {
          for (let c = 0; c <= maxC; c++) {
            const start = r * n + c, last = start + step * (L - 1);
            const before = dir === 0 ? left[start] : up[start];
            const after = dir === 0 ? right[last] : down[last];
            if (isShip(cells, before) || isShip(cells, after)) continue;
            let fresh = 0, ok = true;
            for (let q = 0, j = start; q < L; q++, j += step) {
              const v = cells[j];
              if (v === WATER) { ok = false; break; }
              const p1 = dir === 0 ? up[j] : left[j], p2 = dir === 0 ? down[j] : right[j];
              if (isShip(cells, p1) || isShip(cells, p2)) { ok = false; break; }
              const sh = shape[j];
              if (sh !== NONE) {
                const want = L === 1 ? SINGLE
                  : q === 0 ? (dir === 0 ? LEFT : TOP)
                    : q === L - 1 ? (dir === 0 ? RIGHT : BOTTOM) : MIDDLE;
                if (sh !== want) { ok = false; break; }
              }
              if (v === UNKNOWN) {
                fresh++;
                if (dir === 0 ? colS[c + q] + 1 > cols[c + q] : rowS[r + q] + 1 > rows[r + q]) { ok = false; break; }
              }
            }
            if (!ok) continue;
            if (dir === 0 ? rowS[r] + fresh > rows[r] : colS[c] + fresh > cols[c]) continue;
            if (fresh === 0 && list[comp[start]].closed) continue; // an already finished ship
            const cs = [];
            for (let q = 0; q < L; q++) cs.push(start + q * step);
            places.push(cs);
          }
        }
      }

      const count = places.length;
      if (count < k) return broke(st, WHY.NO_ROOM, L);
      if (count === k) {
        // Only place it fits: every position left is used.
        for (const cs of places) {
          for (const j of cs) ships.push([j, WHY.ONLY_PLACES, L, count, places]);
          for (const j of ends(cs)) waters.push([j, WHY.ONLY_PLACES, L, count, places]);
        }
      } else if (k === 1 && count <= PLACE_LIMIT) {
        // Overlap: squares that every position of this ship covers.
        const hits = new Int16Array(N);
        for (const cs of places) for (const j of cs) hits[j]++;
        for (let j = 0; j < N; j++) if (hits[j] === count) ships.push([j, WHY.OVERLAP, L, count, places]);
      } else if (k <= COMBO_SHIPS && count <= PLACE_LIMIT) {
        // One way only: positions that can't sit together rule each other out.
        const { combos, used, hits } = shipCombos(st, places, k, rowS, colS);
        if (combos === 0) return broke(st, WHY.NO_ROOM, L);
        const all = places;
        places = places.filter((_, c) => used[c]);
        for (let j = 0; j < N; j++) if (hits[j] === combos) ships.push([j, WHY.ONE_WAY, L, k, all]);
        if (combos === 1) for (const cs of places) for (const j of ends(cs)) waters.push([j, WHY.ONE_WAY, L, k, all]);
      }

      for (const cs of places) {
        let seen = -1;
        for (const j of cs) {
          cover[j] = 1;
          const id = comp[j];
          if (id >= 0 && id !== seen) {
            // A position may swallow several ship pieces; count each one once.
            seen = id;
            compHits[id]++;
            for (const jj of cs) compCell[id * N + jj]++;
          }
        }
      }
    }

    for (let id = 0; id < C; id++) {
      const c = list[id];
      if (c.closed) continue;
      if (compHits[id] === 0) return broke(st, WHY.STUCK, c.cells[0]);
      if (compHits[id] > PLACE_LIMIT) continue;
      const base = id * N;
      for (let j = 0; j < N; j++) {
        if (compCell[base + j] === compHits[id]) ships.push([j, WHY.GROW, c.cells[0], c.len, c.cells]);
      }
    }
    for (let j = 0; j < N; j++) if (cells[j] === UNKNOWN && !cover[j]) waters.push([j, WHY.NO_FIT]);

    let changed = 0, r;
    for (const d of ships) { if ((r = put(st, d[0], SHIP, d[1], d[2], d[3], d[4])) < 0) return -1; changed |= r; }
    for (const d of waters) { if ((r = put(st, d[0], WATER, d[1], d[2], d[3], d[4])) < 0) return -1; changed |= r; }
    return changed;
  }

  // Level 2: a nearly complete row or column can often be finished in only a few
  // ways. Whatever all of them agree on is certain. Assumes level 1 is done.
  function lineWaysRule(st) {
    const { n, cells, shape, rows, cols, fleet, maxLen } = st;
    const { up, down, left, right } = st.geo;
    const { comp, list } = components(st);
    const rem = new Int16Array(maxLen + 1);
    for (let L = 1; L <= maxLen; L++) rem[L] = fleet[L];
    for (const c of list) if (c.closed && c.len <= maxLen) rem[c.len]--;
    let longest = 0;
    for (let L = 1; L <= maxLen; L++) if (rem[L] > 0) longest = L;
    const pick = new Uint8Array(n), yes = new Int16Array(n), counts = new Int16Array(maxLen + 2);
    let changed = 0;

    for (let line = 0; line < 2 * n; line++) {
      const isRow = line < n, idx = isRow ? line : line - n;
      const at = (k) => (isRow ? idx * n + k : k * n + idx);
      const open = [];
      let s = 0;
      for (let k = 0; k < n; k++) {
        const v = cells[at(k)];
        if (v === UNKNOWN) open.push(k);
        else if (v === SHIP) s++;
      }
      const need = (isRow ? rows[idx] : cols[idx]) - s;
      if (need <= 0 || need >= open.length || Math.min(need, open.length - need) > LINE_NEAR) continue;

      const on = (k) => k >= 0 && k < n && (pick[k] === 1 || cells[at(k)] === SHIP);
      const fits = () => {
        counts.fill(0);
        for (let k = 0; k < n; k++) {
          if (!on(k) || on(k - 1)) continue;
          let len = 1, fresh = pick[k] === 1;
          while (on(k + len)) { if (pick[k + len]) fresh = true; len++; }
          const first = at(k);
          if (!fresh && comp[first] >= 0 && list[comp[first]].closed) continue; // already finished
          if (len > longest) return false;
          if (len >= 2) {
            if (shape[first] === MIDDLE || shape[at(k + len - 1)] === MIDDLE) return false;
            if (++counts[len] > rem[len]) return false;
          } else if (isSea(cells, isRow ? up[first] : left[first]) && isSea(cells, isRow ? down[first] : right[first])) {
            // Closed on all sides: a one-cell ship.
            if (shape[first] === MIDDLE || ++counts[1] > rem[1]) return false;
          }
        }
        return true;
      };

      yes.fill(0);
      let ways = 0;
      (function choose(from, left2) {
        if (left2 === 0) {
          if (fits()) { ways++; for (const k of open) if (pick[k]) yes[k]++; }
          return;
        }
        for (let o = from; o <= open.length - left2; o++) {
          pick[open[o]] = 1;
          choose(o + 1, left2 - 1);
          pick[open[o]] = 0;
        }
      })(0, need);
      if (ways === 0) return broke(st, WHY.LINE_UNDER, line);
      if (ways > LINE_WAYS_LIMIT) continue;
      for (const k of open) {
        if (yes[k] === ways) { put(st, at(k), SHIP, WHY.LINE_WAYS, line, ways); changed = 1; }
        else if (yes[k] === 0) { put(st, at(k), WATER, WHY.LINE_WAYS, line, ways); changed = 1; }
      }
    }
    return changed;
  }

  // The row or column a ship component lies in.
  function lineOf(st, c) {
    const n = st.n, i = c.cells[0];
    return c.len > 1 && c.cells[1] - i === n ? n + (i % n) : (i / n) | 0;
  }

  // Too long a ship, or more finished ships of one length than the fleet has? Used by "what if".
  function fleetCountFails(st) {
    const found = new Int16Array(st.maxLen + 1);
    for (const c of components(st).list) {
      if (c.len > st.maxLen) return st.trace ? { code: WHY.TOO_LONG, a: st.maxLen, b: lineOf(st, c) } : true;
      if (!c.closed) continue;
      if (++found[c.len] > st.fleet[c.len]) return st.trace ? { code: WHY.TOO_MANY, a: c.len, extra: c.cells } : true;
    }
    return null;
  }

  // Cells that are natural to test: those in nearly finished rows and columns.
  function whatIfCandidates(st) {
    const { n, cells } = st;
    const mark = new Uint8Array(cells.length);
    for (let line = 0; line < 2 * n; line++) {
      const isRow = line < n, idx = isRow ? line : line - n;
      const base = isRow ? idx * n : idx, step = isRow ? 1 : n;
      let u = 0;
      for (let k = 0, j = base; k < n; k++, j += step) if (cells[j] === UNKNOWN) u++;
      if (u > WHAT_IF_OPEN) continue;
      for (let k = 0, j = base; k < n; k++, j += step) if (cells[j] === UNKNOWN) mark[j] = 1;
    }
    const out = [];
    for (let i = 0; i < cells.length; i++) if (mark[i]) out.push(i);
    return out;
  }

  // Level 3: assume cell i has value v and follow it locally: its corners, any given
  // piece it touches, its own row and column, and the corners of what that forces.
  // Returns what breaks anywhere on the board (and the cells it forced), or null.
  function whatIfFails(st, i, v) {
    const t = cloneState(st);
    t.cells[i] = v;
    if (st.trace) t.order = [];
    let broken = diagRule(t) < 0 || shapeRule(t) < 0 ||
      lineStep(t, (i / st.n) | 0, true) < 0 || lineStep(t, st.n + (i % st.n), true) < 0 || diagRule(t) < 0;
    for (let line = 0; !broken && line < 2 * st.n; line++) broken = lineStep(t, line, false) < 0;
    const fail = broken ? (t.fail || true) : fleetCountFails(t);
    if (!fail) return null;
    const trial = [[i, v]];
    if (t.order) for (const j of t.order) trial.push([j, t.cells[j]]);
    return { fail, trial };
  }

  function hasUnknown(cells) {
    for (let i = 0; i < cells.length; i++) if (cells[i] === UNKNOWN) return true;
    return false;
  }

  // Full check of a completely filled grid.
  function validFull(st) {
    const probe = cloneState(st);
    probe.trace = false;
    if (basicPass(probe) !== 0) return false;
    const found = new Int16Array(st.maxLen + 1);
    for (const c of components(probe).list) {
      if (c.len > st.maxLen) return false;
      found[c.len]++;
    }
    for (let L = 1; L <= st.maxLen; L++) if (found[L] !== st.fleet[L]) return false;
    return true;
  }

  function newlyKnown(before, cells) {
    const out = [];
    for (let i = 0; i < cells.length; i++) if (before[i] === UNKNOWN && cells[i] !== UNKNOWN) out.push(i);
    return out;
  }

  function propagate(st, level) {
    for (;;) {
      const b = basicPass(st);
      if (b < 0) return false;
      if (b > 0) continue;
      if (level < 2) return true;
      const before = st.score ? st.cells.slice() : null;
      let f = fleetPass(st);
      if (f === 0) f = lineWaysRule(st);
      if (f < 0) return false;
      if (f === 0) return true;
      if (st.score) {
        st.score.fleet++;
        st.score.fleetCells.push(...newlyKnown(before, st.cells));
      }
    }
  }

  function consistent(st, level) {
    if (!propagate(st, level)) return false;
    return hasUnknown(st.cells) || validFull(st);
  }

  // Runs the solver on st in place. Returns false on contradiction.
  function runSolver(st, level) {
    if (!consistent(st, Math.min(level, 2))) return false;
    if (level < 3) return true;
    while (hasUnknown(st.cells)) {
      const cands = whatIfCandidates(st);
      let hit = -1, guess = 0, works = 0;
      // Grading looks at every assumption, to see how hard this moment is to find.
      for (let c = 0; c < cands.length && (st.score || hit < 0); c++) {
        for (const g of [SHIP, WATER]) {
          if (!whatIfFails(st, cands[c], g)) continue;
          works++;
          if (hit < 0) { hit = cands[c]; guess = g; }
        }
      }
      if (hit < 0) return true;
      st.cells[hit] = guess === SHIP ? WATER : SHIP;
      if (st.score) {
        st.score.whatIf++;
        st.score.whatIfCells.push(hit);
        if (cands.length * 2 > works * WHAT_IF_HIDDEN) st.score.whatIfHidden.push(hit);
      }
      if (!consistent(st, 2)) return false;
    }
    return true;
  }

  function solve(p, level) {
    const st = makeState(p);
    const ok = runSolver(st, level);
    const solved = ok && !hasUnknown(st.cells) && validFull(st);
    return { ok, solved, cells: st.cells };
  }

  // How many moments of each technique a puzzle needs when solved with simple
  // techniques first, and which cells those moments decided.
  function grade(p, level) {
    const st = makeState(p);
    st.score = { fleet: 0, whatIf: 0, fleetCells: [], whatIfCells: [], whatIfHidden: [] };
    const ok = runSolver(st, level);
    const solved = ok && !hasUnknown(st.cells) && validFull(st);
    return Object.assign({ solved }, st.score);
  }

  /* ------------------------------------------------------------------ */
  /* Generator                                                            */
  /* ------------------------------------------------------------------ */

  function hintFor(sol, n, i) {
    return sol[i] ? [i, SHIP, shapeAt(sol, n, i)] : [i, WATER, NONE];
  }

  function buildPuzzle(n, fleet, sol, hints) {
    const rows = new Array(n).fill(0), cols = new Array(n).fill(0);
    for (let i = 0; i < n * n; i++) if (sol[i]) { rows[(i / n) | 0]++; cols[i % n]++; }
    return { n, fleet, rows, cols, hints };
  }

  function attempt(n, fleet, rng, level) {
    const sol = placeFleet(n, fleet, rng);
    const p = buildPuzzle(n, fleet, sol, []);
    const chosen = new Map();

    // Add hints where the solver gets stuck until it can finish.
    for (;;) {
      p.hints = Array.from(chosen.values());
      const res = solve(p, level);
      if (res.solved) break;
      const ships = [], water = [];
      for (let i = 0; i < n * n; i++) {
        if (res.cells[i] !== UNKNOWN || chosen.has(i)) continue;
        (sol[i] ? ships : water).push(i);
      }
      const pool = ships.length && (rng() < 0.55 || !water.length) ? ships : water;
      const i = pool[Math.floor(rng() * pool.length)];
      chosen.set(i, hintFor(sol, n, i));
    }

    // Remove every hint that isn't needed.
    for (const i of shuffle(Array.from(chosen.keys()), rng)) {
      const h = chosen.get(i);
      chosen.delete(i);
      p.hints = Array.from(chosen.values());
      if (!solve(p, level).solved) chosen.set(i, h);
    }
    p.hints = Array.from(chosen.values()).sort((a, b) => a[0] - b[0]);
    return { p, sol };
  }

  // Adds clues until the puzzle is within its level's limits. Returns how far it
  // ended up below the level's minimum (0 = a good fit).
  function tune(p, sol, cfg, n, rng) {
    const fleet = cfg.fleet && cfg.fleet[n], whatIf = cfg.whatIf && cfg.whatIf[n];
    if (!fleet && !whatIf) return 0;
    for (;;) {
      const g = grade(p, cfg.level);
      const cells = whatIf && g.whatIf > whatIf[1] ? g.whatIfCells
        : whatIf && g.whatIfHidden.length ? g.whatIfHidden
          : fleet && g.fleet > fleet[1] ? g.fleetCells : null;
      if (!cells) return whatIf ? Math.max(0, whatIf[0] - g.whatIf) : Math.max(0, fleet[0] - g.fleet);
      p.hints.push(hintFor(sol, n, cells[Math.floor(rng() * cells.length)]));
      p.hints.sort((a, b) => a[0] - b[0]);
    }
  }

  /**
   * generate({ size, difficulty, seed }) → puzzle
   * puzzle = { n, fleet, rows, cols, hints: [[index, WATER|SHIP, shape]], solution, seed, difficulty }
   */
  function generate(opts) {
    const n = opts.size || 8;
    const difficulty = DIFFICULTIES[opts.difficulty] ? opts.difficulty : 'medium';
    const cfg = DIFFICULTIES[difficulty];
    const fleet = (opts.fleet || FLEETS[n]).slice().sort((a, b) => b - a);
    const seed = (opts.seed == null ? Math.floor(Math.random() * 1e9) : opts.seed) >>> 0;
    const rng = mulberry32(seed);
    // Small boards can afford more attempts to land inside the level's limits.
    const tries = opts.tries || Math.round(3600 / (n * n));

    let best = null, bestMiss = Infinity;
    for (let t = 0; t < tries && bestMiss > 0; t++) {
      const cand = attempt(n, fleet, rng, cfg.level);
      const miss = tune(cand.p, cand.sol, cfg, n, rng);
      if (miss < bestMiss) { best = cand; bestMiss = miss; }
    }

    const { p, sol } = best;
    if (cfg.extra > 0) {
      const have = new Set(p.hints.map((h) => h[0]));
      const free = [];
      for (let i = 0; i < n * n; i++) if (!have.has(i)) free.push(i);
      shuffle(free, rng);
      // Prefer ship segments: they look nicer and teach shapes.
      free.sort((a, b) => sol[b] - sol[a] + (rng() - 0.5) * 1.6);
      const extra = Math.round(n * cfg.extra);
      for (let k = 0; k < extra && k < free.length; k++) p.hints.push(hintFor(sol, n, free[k]));
      p.hints.sort((a, b) => a[0] - b[0]);
    }

    p.solution = Array.from(sol);
    p.seed = seed;
    p.difficulty = difficulty;
    p.v = ENGINE_VERSION;
    return p;
  }

  /* ------------------------------------------------------------------ */
  /* Hints                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * The next move the player can prove from where they are, and why.
   * marks: the player's grid (UNKNOWN/WATER/SHIP). Wrong marks are ignored;
   * the app points those out first.
   * Returns { index, value, why, level } or null when nothing is left.
   * `why` is null only if no short proof exists (puzzles from older versions).
   */
  function nextHint(p, marks) {
    const st = makeState(p, true);
    const sol = p.solution;
    for (let i = 0; i < marks.length; i++) {
      const want = sol[i] ? SHIP : WATER;
      if (marks[i] === want && st.cells[i] === UNKNOWN) st.cells[i] = want;
    }
    if (!hasUnknown(st.cells)) return null;
    const found = (t, level) => {
      const j = t.order[0];
      return { index: j, value: t.cells[j], why: t.why[j], level };
    };

    // Each rule runs on its own copy, and only its first deduction is used, so
    // the explanation relies on nothing but what the player already knows.
    for (const rule of [lineRule, shapeRule, diagRule]) {
      const t = cloneState(st);
      t.order = [];
      if (rule(t) > 0 && t.order.length) return found(t, 1);
    }
    for (const rule of [fleetPass, lineWaysRule]) {
      const t = cloneState(st);
      t.order = [];
      if (rule(t) > 0 && t.order.length) return found(t, 2);
    }
    // The shortest "what if" among the cells that are natural to test.
    let best = null;
    for (const i of whatIfCandidates(st)) {
      for (const guess of [SHIP, WATER]) {
        const res = whatIfFails(st, i, guess);
        if (res && (!best || res.trial.length < best.res.trial.length)) best = { i, guess, res };
      }
    }
    if (best) {
      const { i, guess, res } = best;
      return {
        index: i, value: guess === SHIP ? WATER : SHIP, level: 3,
        why: { code: WHY.WHAT_IF, a: guess, extra: res.fail === true ? null : res.fail, trial: res.trial },
      };
    }
    // No short proof: only possible for puzzles made by an older version.
    const { N } = st.geo;
    for (let i = 0; i < N; i++) {
      if (st.cells[i] === UNKNOWN && sol[i]) return { index: i, value: SHIP, why: null, level: 0 };
    }
    for (let i = 0; i < N; i++) {
      if (st.cells[i] === UNKNOWN) return { index: i, value: WATER, why: null, level: 0 };
    }
    return null;
  }

  return {
    UNKNOWN, WATER, SHIP, SHAPE, WHY, FLEETS, DIFFICULTIES, ENGINE_VERSION,
    generate, solve, grade, nextHint, shapeAt, placeFleet, mulberry32,
  };
});
