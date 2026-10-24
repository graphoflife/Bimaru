// Run with: npm test   (or: node --test test/)
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E = require('../js/engine.js');

// Independent brute-force solution counter: tries every fleet placement that
// respects the no-touching rule and the row/column counts, then checks hints.
function countSolutions(p, limit = 2) {
  const n = p.n, N = n * n;
  const fleet = p.fleet.slice().sort((a, b) => b - a);
  const water = new Uint8Array(N);
  for (const [i, v] of p.hints) if (v === E.WATER) water[i] = 1;
  const grid = new Uint8Array(N), blocked = new Uint16Array(N);
  const rowS = new Int16Array(n), colS = new Int16Array(n);
  let count = 0;

  function mark(r0, c0, dir, L, delta) {
    for (let k = 0; k < L; k++) {
      const r = r0 + dir * k, c = c0 + (1 - dir) * k;
      grid[r * n + c] = delta > 0 ? 1 : 0;
      rowS[r] += delta; colS[c] += delta;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && rr < n && cc >= 0 && cc < n) blocked[rr * n + cc] += delta;
      }
    }
  }

  function done() {
    for (let i = 0; i < n; i++) if (rowS[i] !== p.rows[i] || colS[i] !== p.cols[i]) return false;
    for (const [i, v, sh] of p.hints) {
      if (v === E.WATER ? grid[i] : !grid[i]) return false;
      if (v === E.SHIP && E.shapeAt(grid, n, i) !== sh) return false;
    }
    return true;
  }

  function rec(k, minPos) {
    if (count >= limit) return;
    if (k === fleet.length) { if (done()) count++; return; }
    const L = fleet[k];
    const from = k > 0 && fleet[k - 1] === L ? minPos : 0;
    for (let pos = from; pos < 2 * N; pos++) {
      const start = pos >> 1, dir = pos & 1;
      if (L === 1 && dir === 1) continue;
      const r0 = (start / n) | 0, c0 = start % n;
      if (dir === 0 ? c0 + L > n : r0 + L > n) continue;
      let ok = true;
      for (let k2 = 0; k2 < L && ok; k2++) {
        const r = r0 + dir * k2, c = c0 + (1 - dir) * k2, i = r * n + c;
        if (blocked[i] || water[i]) ok = false;
        else if (dir === 0 ? colS[c] + 1 > p.cols[c] : rowS[r] + 1 > p.rows[r]) ok = false;
      }
      if (!ok) continue;
      if (dir === 0 ? rowS[r0] + L > p.rows[r0] : colS[c0] + L > p.cols[c0]) continue;
      mark(r0, c0, dir, L, 1);
      rec(k + 1, pos + 1);
      mark(r0, c0, dir, L, -1);
    }
  }
  rec(0, 0);
  return count;
}

test('generated puzzles have exactly one solution (brute force check)', () => {
  for (const size of [6, 8]) {
    for (const difficulty of Object.keys(E.DIFFICULTIES)) {
      for (let seed = 1; seed <= 4; seed++) {
        const p = E.generate({ size, difficulty, seed: seed * 7919 + size });
        assert.strictEqual(countSolutions(p), 1, `size ${size} ${difficulty} seed ${p.seed}`);
      }
    }
  }
});

test('the logical solver reproduces the stored solution', () => {
  for (const size of [6, 8, 10, 12]) {
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

test('nextHint suggests a correct cell', () => {
  const p = E.generate({ size: 8, difficulty: 'medium', seed: 5 });
  const marks = new Array(64).fill(E.UNKNOWN);
  for (const [i, v] of p.hints) marks[i] = v;
  for (let step = 0; step < 64; step++) {
    const h = E.nextHint(p, marks);
    if (!h) break;
    assert.strictEqual(h.value, p.solution[h.index] ? E.SHIP : E.WATER);
    assert.strictEqual(marks[h.index], E.UNKNOWN);
    marks[h.index] = h.value;
  }
  assert.ok(marks.every((v, i) => v === (p.solution[i] ? E.SHIP : E.WATER)));
});
