// A deliberately naive Connect Four in plain TypeScript, for the tests: an array board,
// a four-in-a-row scan, and a memoised full game-tree search. It shares nothing with the C
// solver, so agreement between the two means something.

export type Board = { w: number; h: number; cols: number[][] }; // cols[c] bottom first; 1 = first player, 2 = second

export function empty(w: number, h: number): Board {
  return { w, h, cols: Array.from({ length: w }, () => []) };
}

export function stones(b: Board): number {
  return b.cols.reduce((n, c) => n + c.length, 0);
}

export function canPlay(b: Board, c: number): boolean {
  return b.cols[c].length < b.h;
}

export function play(b: Board, c: number): Board {
  const p = stones(b) % 2 === 0 ? 1 : 2;
  return { ...b, cols: b.cols.map((col, i) => (i === c ? [...col, p] : col)) };
}

function at(b: Board, c: number, r: number): number {
  return c >= 0 && c < b.w && r >= 0 ? b.cols[c][r] ?? 0 : 0;
}

/** Does the stone at (c, r) belong to a line of four? */
export function fourThrough(b: Board, c: number, r: number): boolean {
  const p = at(b, c, r);
  if (!p) return false;
  for (const [dc, dr] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    let n = 1;
    for (let k = 1; at(b, c + k * dc, r + k * dr) === p; k++) n++;
    for (let k = 1; at(b, c - k * dc, r - k * dr) === p; k++) n++;
    if (n >= 4) return true;
  }
  return false;
}

export function anyFour(b: Board): boolean {
  for (let c = 0; c < b.w; c++) for (let r = 0; r < b.cols[c].length; r++) if (fourThrough(b, c, r)) return true;
  return false;
}

const key = (b: Board) => b.cols.map((c) => c.join('')).join('|');

/**
 * Exact score for the player to move, Pons's convention: winning with your k-th stone
 * scores cells/2 + 1 - k (rounded down for odd boards), a draw 0, a loss minus the
 * opponent's score. Full search with a memo; only for small boards.
 */
export function makeSolver(w: number, h: number) {
  const cells = w * h;
  const memo = new Map<string, number>();
  const score = (b: Board): number => {
    const k = key(b);
    const hit = memo.get(k);
    if (hit !== undefined) return hit;
    const n = stones(b);
    let best = -Infinity;
    for (let c = 0; c < w; c++) {
      if (!canPlay(b, c)) continue;
      const next = play(b, c);
      const s = fourThrough(next, c, next.cols[c].length - 1) ? Math.floor((cells + 1 - n) / 2) : -score(next);
      if (s > best) best = s;
    }
    if (best === -Infinity) best = 0; // full board
    memo.set(k, best);
    return best;
  };
  return score;
}

/** Positions reachable in a game, by number of stones (no moves after a win unless playOn). */
export function countByPly(w: number, h: number, playOn = false): number[] {
  let level = new Map<string, Board>([[key(empty(w, h)), empty(w, h)]]);
  const out = [1];
  for (let ply = 0; ply < w * h; ply++) {
    const next = new Map<string, Board>();
    for (const b of level.values()) {
      if (!playOn && anyFour(b)) continue;
      for (let c = 0; c < w; c++) {
        if (!canPlay(b, c)) continue;
        const nb = play(b, c);
        next.set(key(nb), nb);
      }
    }
    out.push(next.size);
    level = next;
  }
  return out;
}
