// Runs the WebAssembly solver off the main thread. For a position it scores every column,
// centre first, and streams each result back: the exact score if the search fits the node
// budget, else just win / draw / loss if that fits, else "unknown". The transposition table
// is kept between requests of the same board size, so a game gets cheaper as it goes.
import { Engine, FULL } from './engine.ts';
import wasmUrl from './c4.wasm?url';

export type ColumnResult = { c: number; score: number | null; exact: boolean; nodes: number };
export type Request = { id: number; w: number; h: number; moves: number[]; budget: number };

const ready = fetch(wasmUrl).then((r) => r.arrayBuffer()).then((b) => Engine.load(b));
let size = '';

self.onmessage = async (e: MessageEvent<Request>) => {
  const { id, w, h, moves, budget } = e.data;
  const engine = await ready;
  const post = (msg: object) => (self as unknown as Worker).postMessage({ id, ...msg });
  if (size !== `${w}x${h}`) {
    engine.init(w, h);
    size = `${w}x${h}`;
  }
  engine.setPosition(moves);
  const order = Array.from({ length: w }, (_, i) => Math.floor(w / 2) + (1 - 2 * (i % 2)) * Math.floor((i + 1) / 2));
  const t0 = performance.now();
  for (const c of order) {
    engine.resetNodes();
    let score: number | null = null;
    let exact = false;
    if (!engine.canPlay(c)) {
      score = FULL;
      exact = true;
    } else {
      engine.setBudget(budget);
      const s = engine.analyze(c, false);
      if (!engine.aborted()) {
        score = s;
        exact = true;
      } else {
        engine.setBudget(budget);
        const weak = engine.analyze(c, true);
        if (!engine.aborted()) score = weak;
      }
    }
    const result: ColumnResult = { c, score, exact, nodes: engine.nodes() };
    post({ kind: 'col', result });
  }
  post({ kind: 'done', ms: performance.now() - t0 });
};
