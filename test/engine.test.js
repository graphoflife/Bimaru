// Run with: npm test   (or: node --test test/)
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E = require('../js/engine.js');

const SIZES = Object.keys(E.FLEETS).map(Number).sort((a, b) => a - b);

// Independent solution counter. Fills the board cell by cell using only the rules of
// the puzzle and remembers results at row boundaries, where two different partial
// boards with the same last row, column counts and remaining fleet finish the same way.
function countSolutions(p, limit = 2) {
  const n = p.n, N = n * n;
  const given = new Int8Array(N);
  for (const [i, v] of p.hints) given[i] = v;
  const shapes = new Int8Array(N);
  for (const [i, v, sh] of p.hints) if (v === E.SHIP) shapes[i] = sh;
  const grid = new Uint8Array(N), hlen = new Uint8Array(N), vlen = new Uint8Array(N);
  const rowLeft = p.rows.slice(), colLeft = p.cols.slice();
  const maxLen = Math.max(...p.fleet);
  const left = new Int16Array(maxLen + 2);
  for (const L of p.fleet) left[L]++;
  const memo = new Map();

  const at = (r, c) => (r >= 0 && c >= 0 && r < n && c < n ? grid[r * n + c] : 0);
  const longestLeft = () => { for (let L = maxLen; L > 0; L--) if (left[L] > 0) return L; return 0; };

  // Which ships end because the cell below (r - 1, c) is not a ship.
  function endedAbove(r, c, out) {
    if (!at(r - 1, c)) return;
    const up = (r - 1) * n + c;
    if (vlen[up] >= 2) out.push(vlen[up]);
    else if (hlen[up] === 1 && !at(r - 1, c + 1)) out.push(1); // a one-cell ship
  }
  const shapeOk = (i) => shapes[i] === 0 || E.shapeAt(grid, n, i) === shapes[i];

  function withBooked(ended, next) {
    let ok = true;
    for (const L of ended) if (--left[L] < 0) ok = false;
    const res = ok ? next() : 0;
    for (const L of ended) left[L]++;
    return res;
  }

  function rec(i) {
    const r = (i / n) | 0, c = i % n;
    if (i === N) {
      const ended = [];
      for (let x = 0; x < n; x++) {
        if (!shapeOk((n - 1) * n + x)) return 0;
        endedAbove(n, x, ended);
      }
      return withBooked(ended, () => {
        for (let L = 1; L <= maxLen; L++) if (left[L] !== 0) return 0;
        return 1;
      });
    }
    let key = null;
    if (c === 0) {
      key = r + '|' + (r > 0 ? Array.from(vlen.subarray((r - 1) * n, r * n)).join() : '') + '|' + colLeft.join() + '|' + left.join();
      const hit = memo.get(key);
      if (hit !== undefined) return hit;
    }
    let total = 0;
    // Water
    if (given[i] !== E.SHIP && rowLeft[r] <= n - 1 - c && colLeft[c] <= n - 1 - r && (r === 0 || shapeOk(i - n))) {
      const ended = [];
      if (at(r, c - 1) && hlen[i - 1] >= 2) ended.push(hlen[i - 1]);
      endedAbove(r, c, ended);
      total += withBooked(ended, () => rec(i + 1));
    }
    // Ship
    if (total < limit && given[i] !== E.WATER && rowLeft[r] > 0 && colLeft[c] > 0 &&
        rowLeft[r] - 1 <= n - 1 - c && colLeft[c] - 1 <= n - 1 - r &&
        !at(r - 1, c - 1) && !at(r - 1, c + 1) && !(at(r, c - 1) && at(r - 1, c))) {
      const h = at(r, c - 1) ? hlen[i - 1] + 1 : 1;
      const v = at(r - 1, c) ? vlen[i - n] + 1 : 1;
      const room = longestLeft();
      if (h <= room && v <= room) {
        grid[i] = 1; hlen[i] = h; vlen[i] = v; rowLeft[r]--; colLeft[c]--;
        if (r === 0 || shapeOk(i - n)) {
          total += withBooked(c === n - 1 && h >= 2 ? [h] : [], () => rec(i + 1));
        }
        grid[i] = 0; hlen[i] = 0; vlen[i] = 0; rowLeft[r]++; colLeft[c]++;
      }
    }
    if (total > limit) total = limit;
    if (key !== null) memo.set(key, total);
    return total;
  }
  return rec(0);
}

test('bigger boards have more ships, more ship cells and never shorter ships', () => {
  const sum = (fleet) => fleet.reduce((a, b) => a + b, 0);
  for (let k = 1; k < SIZES.length; k++) {
    const small = E.FLEETS[SIZES[k - 1]], big = E.FLEETS[SIZES[k]];
    assert.ok(big.length > small.length, `${SIZES[k]}: more ships`);
    assert.ok(sum(big) > sum(small), `${SIZES[k]}: more ship cells`);
    assert.ok(Math.max(...big) >= Math.max(...small), `${SIZES[k]}: longest ship`);
  }
  assert.ok(Math.max(...E.FLEETS[15]) > Math.max(...E.FLEETS[12]), 'the largest board has the longest ship');
});

test('generated puzzles contain exactly the fleet of their board', () => {
  for (const size of SIZES) {
    const p = E.generate({ size, difficulty: 'medium', seed: 11 });
    const found = [];
    const ship = (r, c) => r >= 0 && c >= 0 && r < size && c < size && p.solution[r * size + c] === 1;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!ship(r, c) || ship(r, c - 1) || ship(r - 1, c)) continue;
        let len = 1;
        if (ship(r, c + 1)) while (ship(r, c + len)) len++;
        else while (ship(r + len, c)) len++;
        found.push(len);
      }
    }
    assert.deepStrictEqual(found.sort((a, b) => b - a), E.FLEETS[size], `size ${size}`);
  }
});

test('generated puzzles have exactly one solution (independent search)', () => {
  for (const size of [6, 8, 10]) {
    for (const difficulty of Object.keys(E.DIFFICULTIES)) {
      for (let seed = 1; seed <= 4; seed++) {
        const p = E.generate({ size, difficulty, seed: seed * 7919 + size });
        assert.strictEqual(countSolutions(p), 1, `size ${size} ${difficulty} seed ${p.seed}`);
      }
    }
  }
});

test('the logical solver reproduces the stored solution', () => {
  for (const size of SIZES) {
    for (const difficulty of Object.keys(E.DIFFICULTIES)) {
      const p = E.generate({ size, difficulty, seed: 1234 + size });
      const level = E.DIFFICULTIES[difficulty].level;
      const res = E.solve(p, level);
      assert.ok(res.solved, `size ${size} ${difficulty}`);
      const ships = Array.from(res.cells, (v) => (v === E.SHIP ? 1 : 0));
      assert.deepStrictEqual(ships, p.solution);
    }
  }
});

test('row and column counts match the solution and the fleet', () => {
  const p = E.generate({ size: 10, difficulty: 'medium', seed: 42 });
  const total = p.fleet.reduce((a, b) => a + b, 0);
  assert.strictEqual(p.rows.reduce((a, b) => a + b, 0), total);
  assert.strictEqual(p.cols.reduce((a, b) => a + b, 0), total);
  assert.strictEqual(p.solution.reduce((a, b) => a + b, 0), total);
});

test('same seed gives the same puzzle', () => {
  const a = E.generate({ size: 8, difficulty: 'hard', seed: 99 });
  const b = E.generate({ size: 8, difficulty: 'hard', seed: 99 });
  assert.deepStrictEqual(a, b);
});

// The promise of the game: wherever a player stands (any set of correct marks,
// made in any order), there is a next move that can be proven with the
// strategies of the puzzle's difficulty, and Hint can explain it.
test('a provable next move exists from every correct position', () => {
  const rng = E.mulberry32(2024);
  for (const size of SIZES) {
    for (const difficulty of Object.keys(E.DIFFICULTIES)) {
      for (let seed = 1; seed <= 3; seed++) {
        const p = E.generate({ size, difficulty, seed: seed * 104729 + size });
        const allowed = E.DIFFICULTIES[difficulty].level;
        const N = size * size;
        // Start from the clues plus a random share of correct marks.
        const marks = new Array(N).fill(E.UNKNOWN);
        for (const [i, v] of p.hints) marks[i] = v;
        const share = rng() * 0.7;
        for (let i = 0; i < N; i++) if (rng() < share) marks[i] = p.solution[i] ? E.SHIP : E.WATER;
        for (let step = 0; step <= N; step++) {
          const h = E.nextHint(p, marks);
          if (!h) break;
          const where = `size ${size} ${difficulty} seed ${p.seed} step ${step}`;
          assert.ok(h.why, `no proof found: ${where}`);
          assert.ok(h.level >= 1 && h.level <= allowed, `needed level ${h.level}: ${where}`);
          assert.strictEqual(h.value, p.solution[h.index] ? E.SHIP : E.WATER, where);
          assert.strictEqual(marks[h.index], E.UNKNOWN, where);
          marks[h.index] = h.value;
        }
        assert.ok(marks.every((v, i) => v === (p.solution[i] ? E.SHIP : E.WATER)));
      }
    }
  }
});

test('expert "what if" steps stay local and say what breaks', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const p = E.generate({ size: 10, difficulty: 'expert', seed });
    const marks = new Array(100).fill(E.UNKNOWN);
    for (const [i, v] of p.hints) marks[i] = v;
    for (let h = E.nextHint(p, marks); h; h = E.nextHint(p, marks)) {
      if (h.level === 3) {
        assert.strictEqual(h.why.code, E.WHY.WHAT_IF);
        assert.ok(h.why.extra && h.why.extra.code, 'contradiction is named');
        assert.strictEqual(h.why.trial[0][0], h.index);
        // The assumed cell lies in a nearly finished row or column.
        const r = (h.index / 10) | 0, c = h.index % 10;
        let inRow = 0, inCol = 0;
        for (let k = 0; k < 10; k++) {
          if (marks[r * 10 + k] === E.UNKNOWN) inRow++;
          if (marks[k * 10 + c] === E.UNKNOWN) inCol++;
        }
        assert.ok(Math.min(inRow, inCol) <= 4, `open cells: ${inRow} and ${inCol}`);
      }
      marks[h.index] = h.value;
    }
  }
});

test('hard and expert puzzles stay within the limits of their level', () => {
  for (const size of SIZES) {
    for (const difficulty of ['hard', 'expert']) {
      const cfg = E.DIFFICULTIES[difficulty];
      for (let seed = 1; seed <= 8; seed++) {
        const p = E.generate({ size, difficulty, seed: seed * 271 + size });
        const g = E.grade(p, cfg.level);
        const where = `size ${size} ${difficulty} seed ${p.seed}`;
        assert.ok(g.solved, where);
        assert.ok(g.fleet <= cfg.fleet[size][1], `${where}: ${g.fleet} fleet moments`);
        if (difficulty === 'hard') {
          assert.ok(g.fleet >= 1, `${where}: no fleet reasoning needed`);
          assert.ok(!E.solve(p, 1).solved, `${where}: easy techniques are enough`);
        } else {
          assert.ok(g.whatIf >= 1 && g.whatIf <= cfg.whatIf[size][1], `${where}: ${g.whatIf} what-if moments`);
          assert.strictEqual(g.whatIfHidden.length, 0, `${where}: a what-if is too hidden`);
          assert.ok(!E.solve(p, 2).solved, `${where}: hard techniques are enough`);
        }
      }
    }
  }
});

test('hard puzzles use all the published fleet techniques', () => {
  const seen = new Set();
  for (const size of [8, 10, 12, 15]) {
    for (let seed = 1; seed <= 12; seed++) {
      const p = E.generate({ size, difficulty: 'hard', seed: seed * 613 + size });
      const marks = new Array(size * size).fill(E.UNKNOWN);
      for (const [i, v] of p.hints) marks[i] = v;
      for (let h = E.nextHint(p, marks); h; h = E.nextHint(p, marks)) {
        seen.add(h.why.code);
        marks[h.index] = h.value;
      }
    }
  }
  const W = E.WHY;
  for (const code of [W.ONLY_PLACES, W.OVERLAP, W.ONE_WAY, W.LINE_WAYS, W.NO_FIT, W.GROW]) {
    assert.ok(seen.has(code), `technique ${code} never appeared`);
  }
  assert.ok(!seen.has(W.WHAT_IF), 'hard puzzles never need a what-if');
});
