// Thin wrapper around src/c4.wasm (native/solver.c compiled for wasm32, no libc).
// Columns are 0-based here; the solver keeps one position, so callers replay moves.

interface Exports {
  memory: WebAssembly.Memory;
  c4_init(w: number, h: number): number;
  c4_reset(): void;
  c4_clear_tt(): void;
  c4_play(c: number): void;
  c4_can_play(c: number): number;
  c4_is_winning_move(c: number): number;
  c4_last_mover_won(): number;
  c4_moves(): number;
  c4_solve(weak: number): number;
  c4_analyze(c: number, weak: number): number;
  c4_nodes(): number;
  c4_reset_nodes(): void;
  c4_set_budget(b: number): void;
  c4_aborted(): number;
}

export const FULL = -1000;

export class Engine {
  w = 7;
  h = 6;
  private x: Exports;
  private constructor(x: Exports) {
    this.x = x;
  }

  static async load(bytes: BufferSource): Promise<Engine> {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new Engine(instance.exports as unknown as Exports);
  }

  /** Board size; clears the transposition table. False if it does not fit 64 bits. */
  init(w: number, h: number): boolean {
    this.w = w;
    this.h = h;
    return this.x.c4_init(w, h) === 1;
  }

  /** Replays a game from the empty board (keeps the transposition table). */
  setPosition(moves: readonly number[]) {
    this.x.c4_reset();
    for (const c of moves) this.x.c4_play(c);
  }

  play(c: number) { this.x.c4_play(c); }
  canPlay(c: number) { return this.x.c4_can_play(c) === 1; }
  isWinningMove(c: number) { return this.x.c4_is_winning_move(c) === 1; }
  lastMoverWon() { return this.x.c4_last_mover_won() === 1; }
  moves() { return this.x.c4_moves(); }
  nodes() { return this.x.c4_nodes(); }
  resetNodes() { this.x.c4_reset_nodes(); }
  clearTable() { this.x.c4_clear_tt(); }

  /** Node budget for the following searches; 0 = unlimited. */
  setBudget(nodes: number) { this.x.c4_set_budget(nodes); }
  aborted() { return this.x.c4_aborted() === 1; }

  /** Score for the player to move (weak: sign only). Check aborted() afterwards. */
  solve(weak = false) { return this.x.c4_solve(weak ? 1 : 0); }

  /** Score, for the player to move, of dropping a stone in column c; FULL if it is full. */
  analyze(c: number, weak = false) { return this.x.c4_analyze(c, weak ? 1 : 0); }
}

/**
 * What a score means for the player it belongs to, with `moves` stones on a w x h board:
 * how many more of their own stones they need to win (or the opponent needs to beat them).
 * Score s > 0: the player wins with their (cells/2 + 1 - s)-th stone.
 */
export function stonesToWin(score: number, moves: number, cells: number): number {
  if (score > 0) return Math.floor((cells + 1 - moves) / 2) - score + 1;
  if (score < 0) return Math.floor((cells - moves) / 2) + score + 1;
  return 0;
}
