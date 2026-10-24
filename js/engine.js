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

  const FLEETS = {
    6: [3, 2, 2, 1, 1, 1],
    8: [4, 3, 3, 2, 2, 1, 1, 1],
    10: [4, 3, 3, 2, 2, 2, 1, 1, 1, 1],
    12: [5, 4, 4, 3, 3, 3, 2, 2, 2, 1, 1, 1, 1],
  };

  // level: strongest solving technique the puzzle may require
  //   1 = row/column counts, given segment shapes, no-touching rule
  //   2 = + fleet reasoning ("where can the battleship still go?")
  //   3 = + one-step "what if" reasoning (assume, propagate, find a contradiction)
  // avoid: the puzzle should NOT be solvable at this level (best effort)
  // extra: additional free hints, as a fraction of the board size
  const DIFFICULTIES = {
    easy: { level: 1, avoid: 0, extra: 0.6 },
    medium: { level: 1, avoid: 0, extra: 0 },
    hard: { level: 2, avoid: 1, extra: 0 },
    expert: { level: 3, avoid: 2, extra: 0 },
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

  function makeState(p) {
    const geo = geometry(p.n);
    const cells = new Int8Array(geo.N);
    const shape = new Int8Array(geo.N);
    for (const h of p.hints) {
      cells[h[0]] = h[1];
      if (h[1] === SHIP) shape[h[0]] = h[2] || NONE;
    }
    const { counts, maxLen } = fleetCounts(p.fleet);
    return { n: p.n, geo, cells, shape, rows: p.rows, cols: p.cols, fleet: counts, maxLen };
  }

  function cloneState(st) {
    return Object.assign({}, st, { cells: st.cells.slice() });
  }

  // put*: 1 = changed, 0 = already so, -1 = contradiction. j < 0 is off-board.
  function putW(cells, j) {
    if (j < 0) return 0;
    const v = cells[j];
    if (v === WATER) return 0;
    if (v === SHIP) return -1;
    cells[j] = WATER;
    return 1;
  }
  function putS(cells, j) {
    if (j < 0) return -1;
    const v = cells[j];
    if (v === SHIP) return 0;
    if (v === WATER) return -1;
    cells[j] = SHIP;
    return 1;
  }
  const isSea = (cells, j) => j < 0 || cells[j] === WATER;
  const isShip = (cells, j) => j >= 0 && cells[j] === SHIP;

  // Level 1 rules. Returns 1 if something changed, 0 if not, -1 on contradiction.
  function basicPass(st) {
    const { n, cells, shape, rows, cols, maxLen } = st;
    const { N, up, down, left, right, diag } = st.geo;
    let changed = 0, r;

    for (let i = 0; i < N; i++) {
      if (cells[i] !== SHIP) continue;
      const dg = diag[i];
      for (let k = 0; k < dg.length; k++) {
        if ((r = putW(cells, dg[k])) < 0) return -1;
        changed |= r;
      }
      const sh = shape[i];
      if (sh === NONE) continue;
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
          if (hBlocked && vBlocked) return -1;
          if (hBlocked) { ships = [up[i], down[i]]; waters = [left[i], right[i]]; }
          else if (vBlocked) { ships = [left[i], right[i]]; waters = [up[i], down[i]]; }
          else continue;
        }
      }
      for (const j of waters) { if ((r = putW(cells, j)) < 0) return -1; changed |= r; }
      for (const j of ships) { if ((r = putS(cells, j)) < 0) return -1; changed |= r; }
    }

    // Row and column counts, plus maximum run length.
    for (let line = 0; line < 2 * n; line++) {
      const isRow = line < n, idx = isRow ? line : line - n;
      const base = isRow ? idx * n : idx, step = isRow ? 1 : n;
      const target = isRow ? rows[idx] : cols[idx];
      let s = 0, u = 0, run = 0;
      for (let k = 0, j = base; k < n; k++, j += step) {
        const v = cells[j];
        if (v === SHIP) { s++; if (++run > maxLen) return -1; }
        else { run = 0; if (v === UNKNOWN) u++; }
      }
      if (s > target || s + u < target) return -1;
      if (u === 0) continue;
      if (s === target) {
        for (let k = 0, j = base; k < n; k++, j += step) if (cells[j] === UNKNOWN) cells[j] = WATER;
        changed = 1;
      } else if (s + u === target) {
        for (let k = 0, j = base; k < n; k++, j += step) if (cells[j] === UNKNOWN) cells[j] = SHIP;
        changed = 1;
      }
    }
    return changed;
  }

  // Splits ship cells into straight components. Assumes basicPass reached a
  // fixpoint (so ships never touch diagonally).
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

  // Level 2 rules: reason about where the remaining ships can still fit.
  function fleetPass(st) {
    const { n, cells, shape, rows, cols, fleet, maxLen } = st;
    const { N, up, down, left, right } = st.geo;

    const rowS = new Int16Array(n), colS = new Int16Array(n);
    for (let i = 0; i < N; i++) if (cells[i] === SHIP) { rowS[(i / n) | 0]++; colS[i % n]++; }

    const { comp, list } = components(st);
    const remaining = new Int16Array(maxLen + 1);
    for (let L = 1; L <= maxLen; L++) remaining[L] = fleet[L];
    for (const c of list) {
      if (c.len > maxLen) return -1;
      if (c.closed && --remaining[c.len] < 0) return -1;
    }

    const cover = new Uint8Array(N);
    const C = list.length;
    const compHits = new Int32Array(C);
    const compCell = new Int32Array(C * N);
    const toShip = [], toWater = [];

    for (let L = 1; L <= maxLen; L++) {
      if (remaining[L] <= 0) continue;
      const placements = [];
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
            for (let k = 0, j = start; k < L; k++, j += step) {
              const v = cells[j];
              if (v === WATER) { ok = false; break; }
              const p1 = dir === 0 ? up[j] : left[j], p2 = dir === 0 ? down[j] : right[j];
              if (isShip(cells, p1) || isShip(cells, p2)) { ok = false; break; }
              const sh = shape[j];
              if (sh !== NONE) {
                const want = L === 1 ? SINGLE
                  : k === 0 ? (dir === 0 ? LEFT : TOP)
                    : k === L - 1 ? (dir === 0 ? RIGHT : BOTTOM) : MIDDLE;
                if (sh !== want) { ok = false; break; }
              }
              if (v === UNKNOWN) {
                fresh++;
                if (dir === 0 ? colS[c + k] + 1 > cols[c + k] : rowS[r + k] + 1 > rows[r + k]) { ok = false; break; }
              }
            }
            if (!ok) continue;
            if (dir === 0 ? rowS[r] + fresh > rows[r] : colS[c] + fresh > cols[c]) continue;
            if (fresh === 0 && list[comp[start]].closed) continue; // an already finished ship
            placements.push(start, step);
          }
        }
      }

      const count = placements.length / 2;
      if (count < remaining[L]) return -1;
      const hits = new Int16Array(N);
      for (let p = 0; p < placements.length; p += 2) {
        const start = placements[p], step = placements[p + 1];
        let seen = -1;
        for (let k = 0, j = start; k < L; k++, j += step) {
          hits[j]++;
          cover[j] = 1;
          const id = comp[j];
          if (id >= 0 && id !== seen) {
            // A placement may swallow several components; count each one once.
            seen = id;
            compHits[id]++;
            for (let kk = 0, jj = start; kk < L; kk++, jj += step) compCell[id * N + jj]++;
          }
        }
        if (count === remaining[L]) {
          for (let k = 0, j = start; k < L; k++, j += step) toShip.push(j);
          const last = start + step * (L - 1);
          toWater.push(step === 1 ? left[start] : up[start], step === 1 ? right[last] : down[last]);
        }
      }
      if (remaining[L] === 1 && count > 1) {
        for (let j = 0; j < N; j++) if (hits[j] === count) toShip.push(j);
      }
    }

    for (let id = 0; id < C; id++) {
      if (list[id].closed) continue;
      if (compHits[id] === 0) return -1; // this ship can't be finished anywhere
      const base = id * N;
      for (let j = 0; j < N; j++) if (compCell[base + j] === compHits[id]) toShip.push(j);
    }
    for (let j = 0; j < N; j++) if (cells[j] === UNKNOWN && !cover[j]) toWater.push(j);

    let changed = 0, r;
    for (const j of toShip) { if ((r = putS(cells, j)) < 0) return -1; changed |= r; }
    for (const j of toWater) { if ((r = putW(cells, j)) < 0) return -1; changed |= r; }
    return changed;
  }

  function hasUnknown(cells) {
    for (let i = 0; i < cells.length; i++) if (cells[i] === UNKNOWN) return true;
    return false;
  }

  // Full check of a completely filled grid.
  function validFull(st) {
    const probe = cloneState(st);
    if (basicPass(probe) !== 0) return false;
    const { list } = components(probe);
    const found = new Int16Array(st.maxLen + 1);
    for (const c of list) {
      if (c.len > st.maxLen) return false;
      found[c.len]++;
    }
    for (let L = 1; L <= st.maxLen; L++) if (found[L] !== st.fleet[L]) return false;
    return true;
  }

  function propagate(st, level) {
    for (;;) {
      const b = basicPass(st);
      if (b < 0) return false;
      if (b > 0) continue;
      if (level >= 2) {
        const f = fleetPass(st);
        if (f < 0) return false;
        if (f > 0) continue;
      }
      return true;
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
    const { N } = st.geo;
    let progress = true;
    while (progress && hasUnknown(st.cells)) {
      progress = false;
      for (let i = 0; i < N; i++) {
        if (st.cells[i] !== UNKNOWN) continue;
        for (const guess of [SHIP, WATER]) {
          const trial = cloneState(st);
          trial.cells[i] = guess;
          if (!consistent(trial, 2)) {
            st.cells[i] = guess === SHIP ? WATER : SHIP;
            if (!consistent(st, 2)) return false;
            progress = true;
            break;
          }
        }
      }
    }
    return true;
  }

  function solve(p, level) {
    const st = makeState(p);
    const ok = runSolver(st, level);
    const solved = ok && !hasUnknown(st.cells) && validFull(st);
    return { ok, solved, cells: st.cells };
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
    const tries = opts.tries || 6;

    let best = null;
    for (let t = 0; t < tries; t++) {
      const cand = attempt(n, fleet, rng, cfg.level);
      const tooEasy = cfg.avoid > 0 && solve(cand.p, cfg.avoid).solved;
      if (!tooEasy) { best = cand; break; }
      if (!best || cand.p.hints.length < best.p.hints.length) best = cand;
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
    return p;
  }

  /**
   * Suggests the next cell a player could deduce.
   * marks: the player's grid (UNKNOWN/WATER/SHIP). Wrong marks are ignored.
   * Returns { index, value } or null when nothing is left.
   */
  function nextHint(p, marks, rng) {
    rng = rng || Math.random;
    const st = makeState(p);
    const sol = p.solution;
    for (let i = 0; i < marks.length; i++) {
      const want = sol[i] ? SHIP : WATER;
      if (marks[i] === want && st.cells[i] === UNKNOWN) st.cells[i] = want;
    }
    const open = (cells) => {
      const out = [];
      for (let i = 0; i < cells.length; i++) {
        if (cells[i] !== UNKNOWN && marks[i] === UNKNOWN && !isGiven(p, i)) out.push(i);
      }
      return out;
    };
    let found = [];
    {
      const probe = cloneState(st);
      if (basicPass(probe) >= 0) found = open(probe.cells);
    }
    if (!found.length) {
      const probe = cloneState(st);
      if (propagate(probe, 1) && fleetPass(probe) >= 0) found = open(probe.cells);
    }
    if (!found.length) {
      for (let i = 0; i < marks.length; i++) if (marks[i] === UNKNOWN && !isGiven(p, i)) found.push(i);
      // Prefer ship cells when nothing logical is obvious.
      const ships = found.filter((i) => sol[i]);
      if (ships.length) found = ships;
    }
    if (!found.length) return null;
    const index = found[Math.floor(rng() * found.length)];
    return { index, value: sol[index] ? SHIP : WATER };
  }

  function isGiven(p, i) {
    if (!p._given) {
      Object.defineProperty(p, '_given', { value: new Set(p.hints.map((h) => h[0])), enumerable: false });
    }
    return p._given.has(i);
  }

  return {
    UNKNOWN, WATER, SHIP, SHAPE, FLEETS, DIFFICULTIES,
    generate, solve, nextHint, shapeAt, placeFleet, mulberry32,
  };
});
