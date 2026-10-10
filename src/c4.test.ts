import { describe, expect, it, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Engine, FULL, stonesToWin } from './engine.ts';
import * as ref from './ref.ts';

const lit = JSON.parse(readFileSync(new URL('../tools/literature.json', import.meta.url), 'utf8'));
const runFile = (name: string) => {
  const u = new URL(`../tools/runs/${name}.json`, import.meta.url);
  return existsSync(u) ? JSON.parse(readFileSync(u, 'utf8')) : null;
};

let engine: Engine;
beforeAll(async () => {
  engine = await Engine.load(readFileSync(new URL('./c4.wasm', import.meta.url)));
});

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random unfinished game of n moves (no four in a row yet), or null if it ended early. */
function randomGame(w: number, h: number, n: number, rand: () => number): number[] | null {
  let b = ref.empty(w, h);
  const moves: number[] = [];
  for (let i = 0; i < n; i++) {
    const open = [...Array(w).keys()].filter((c) => ref.canPlay(b, c));
    if (!open.length) return null;
    const c = open[Math.floor(rand() * open.length)];
    b = ref.play(b, c);
    moves.push(c);
    if (ref.fourThrough(b, c, b.cols[c].length - 1)) return null;
  }
  return moves;
}

const z = (x: number) => x || 0; // -0 from negation is still a draw
const replay = (w: number, h: number, moves: number[]) => moves.reduce((b, c) => ref.play(b, c), ref.empty(w, h));

describe('WebAssembly solver against a naive full search', () => {
  for (const [w, h, samples] of [[4, 4, 400], [5, 4, 120], [4, 5, 200]] as const) {
    it(`${w}x${h}: exact scores of random positions and of every column`, () => {
      const score = ref.makeSolver(w, h);
      engine.init(w, h);
      engine.setBudget(0);
      const rand = rng(w * 100 + h);
      let checked = 0;
      while (checked < samples) {
        const moves = randomGame(w, h, Math.floor(rand() * (w * h - 1)), rand);
        if (!moves) continue;
        const b = replay(w, h, moves);
        engine.setPosition(moves);
        expect(engine.solve(false)).toBe(z(score(b)));
        expect(z(Math.sign(engine.solve(true)))).toBe(z(Math.sign(score(b))));
        for (let c = 0; c < w; c++) {
          const got = engine.analyze(c, false);
          if (!ref.canPlay(b, c)) { expect(got).toBe(FULL); continue; }
          const nb = ref.play(b, c);
          const want = ref.fourThrough(nb, c, nb.cols[c].length - 1) ? Math.floor((w * h + 1 - moves.length) / 2) : -score(nb);
          expect(got).toBe(z(want));
        }
        checked++;
      }
    });
  }

  it('7x6: exact scores of late-game positions (12 empty cells)', () => {
    const score = ref.makeSolver(7, 6);
    engine.init(7, 6);
    const rand = rng(76);
    let checked = 0;
    while (checked < 25) {
      const moves = randomGame(7, 6, 30, rand);
      if (!moves) continue;
      engine.setPosition(moves);
      expect(engine.solve(false)).toBe(z(score(replay(7, 6, moves))));
      checked++;
    }
  });

  it('detects the win of the last mover like the naive scan', () => {
    engine.init(7, 6);
    const rand = rng(5);
    for (let g = 0; g < 200; g++) {
      let b = ref.empty(7, 6);
      const moves: number[] = [];
      for (;;) {
        const open = [...Array(7).keys()].filter((c) => ref.canPlay(b, c));
        if (!open.length) break;
        const c = open[Math.floor(rand() * open.length)];
        engine.setPosition(moves);
        const winning = engine.isWinningMove(c);
        b = ref.play(b, c);
        moves.push(c);
        const four = ref.fourThrough(b, c, b.cols[c].length - 1);
        expect(winning).toBe(four);
        engine.setPosition(moves);
        expect(engine.lastMoverWon()).toBe(four);
        if (four) break;
      }
    }
  });
});

describe("Tromp's table of who wins", () => {
  const value = (w: number, h: number) => lit.tromp.results.find((c: any) => c.w === w && c.h === h).value;
  for (const [w, h] of [[4, 4], [5, 4], [6, 4], [4, 5], [5, 5], [4, 6], [6, 5], [5, 6], [4, 7]]) {
    it(`${w}x${h} in WebAssembly`, () => {
      engine.init(w, h);
      const s = engine.solve(true);
      expect(s > 0 ? '+' : s < 0 ? '-' : '=').toBe(value(w, h));
    });
  }

  it('every finished native run matches the table', () => {
    for (const c of lit.tromp.results) {
      const r = runFile(`solve/solve-${c.w}x${c.h}`);
      if (r && !r.timeout) expect(r.value, `${c.w}x${c.h}`).toBe(c.value);
    }
  });

  it('the 7x6 first moves (native) match Wikipedia', () => {
    const r = runFile('solve/first-7x6');
    if (!r || r.timeout) return;
    expect(r.columns.map(Math.sign)).toEqual([-1, -1, 0, 1, 0, -1, -1]);
  });
});

describe('position counts', () => {
  const published = (w: number, h: number) => lit.tromp.counts.find((c: any) => c.w === w && c.h === h).positions;
  for (const [w, h] of [[4, 4], [3, 6], [6, 3], [2, 8]]) {
    it(`${w}x${h}: TypeScript enumeration = C log = Tromp`, () => {
      const by = ref.countByPly(w, h);
      const total = by.reduce((a, b) => a + b, 0);
      expect(total).toBe(published(w, h));
      const log = runFile(`count/total-${w}x${h}`);
      if (log) expect(log.byPly).toEqual(by);
    });
  }

  it('the play-on convention gives a different, larger count', () => {
    const by = ref.countByPly(4, 4, true);
    const total = by.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(published(4, 4));
    const log = runFile('count/playon-4x4');
    if (log) expect(log.total).toBe(total);
  });

  it('7x6 by ply = OEIS A212693', () => {
    const log = runFile('count/levels-7x6');
    if (log) expect(log.byPly).toEqual(lit.oeis.data.slice(0, log.byPly.length));
  });

  it('every finished native count matches the table', () => {
    for (const c of lit.tromp.counts) {
      const r = runFile(`count/total-${c.w}x${c.h}`);
      if (r && !r.skipped) expect(r.total, `${c.w}x${c.h}`).toBe(c.positions);
    }
  });
});

describe('engine details', () => {
  it('gives up after the node budget, and the retry still gets the right answer', () => {
    engine.init(6, 5);
    engine.setBudget(5_000);
    engine.solve(true);
    expect(engine.aborted()).toBe(true);
    engine.setBudget(0);
    expect(engine.solve(true)).toBe(0);
    expect(engine.aborted()).toBe(false);
  });

  it('stonesToWin reads scores the way the solver writes them', () => {
    // 7x6, empty board: the first player wins with the 21st disc, score 1.
    expect(stonesToWin(1, 0, 42)).toBe(21);
    // A win with the very next disc, at any point of the game.
    for (const m of [0, 7, 20, 40]) expect(stonesToWin(Math.floor((43 - m) / 2), m, 42)).toBe(1);
    // A move that lets the opponent win at once.
    expect(stonesToWin(-Math.floor((42 - 10) / 2), 10, 42)).toBe(1);
    expect(stonesToWin(0, 5, 42)).toBe(0);
  });

  it('rejects boards that do not fit 64 bits', () => {
    expect(engine.init(8, 8)).toBe(false);
    expect(engine.init(9, 6)).toBe(true);
  });
});
