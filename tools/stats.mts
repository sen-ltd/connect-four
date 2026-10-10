// Puts every published number from tools/literature.json next to the computed one from
// tools/runs/ and writes src/stats.json for the page (side tables, notes, the 7 x 6 book).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const lit = JSON.parse(readFileSync(new URL('tools/literature.json', root), 'utf8'));
const read = (dir: string) => {
  const d = new URL(`tools/runs/${dir}/`, root);
  if (!existsSync(d)) return new Map<string, any>();
  const m = new Map<string, any>();
  for (const f of readdirSync(d).filter((f) => f.endsWith('.json'))) {
    try {
      m.set(f.replace(/\.json$/, ''), JSON.parse(readFileSync(new URL(f, d), 'utf8')));
    } catch {
      console.warn(`skipping ${dir}/${f} (still being written?)`);
    }
  }
  return m;
};
const solve = read('solve');
const count = read('count');
const NOT_ATTEMPTED = new Set(['8x6', '9x6', '7x7', '8x7', '6x8', '7x8', '6x9']);

// ---------------------------------------------------------------- who wins, by board size
const sign = (r: any) => (r.value as string) ?? null;
const table = lit.tromp.results.map((c: { w: number; h: number; value: string }) => {
  const id = `${c.w}x${c.h}`;
  const run = solve.get(`solve-${id}`);
  const base = { w: c.w, h: c.h, published: c.value, computed: null as string | null, nodes: null as number | null };
  if (c.w * (c.h + 1) > 64) return { ...base, status: 'too-wide' };
  if (NOT_ATTEMPTED.has(id) || !run) return { ...base, status: 'not-attempted' };
  if (run.timeout) return { ...base, status: 'timeout', cap: run.timeout as number };
  const v = sign(run);
  return { ...base, computed: v, nodes: run.nodes, status: v === c.value ? 'ok' : 'mismatch' };
});

// ---------------------------------------------------------------- positions
const counts = lit.tromp.counts.map((c: { w: number; h: number; positions: number }) => {
  const run = count.get(`total-${c.w}x${c.h}`);
  const base = { w: c.w, h: c.h, published: c.positions, computed: null as number | null };
  if (!run || run.skipped) return { ...base, status: 'skipped', reason: run?.skipped ?? 'not run' };
  return { ...base, computed: run.total, status: run.total === c.positions ? 'ok' : 'mismatch' };
});
const playOn = [...count.entries()]
  .filter(([k]) => k.startsWith('playon-'))
  .map(([, r]) => {
    const pub = counts.find((c: any) => c.w === r.w && c.h === r.h);
    return { w: r.w, h: r.h, playOn: r.total, published: pub.published, ratio: r.total / pub.published };
  })
  .sort((a, b) => a.w * a.h - b.w * b.h);
const lv = count.get('levels-7x6');
const levels = lv
  ? {
      computed: lv.byPly as number[],
      published: lit.oeis.data.slice(0, lv.byPly.length) as number[],
      matched: (lv.byPly as number[]).filter((v, i) => v === lit.oeis.data[i]).length,
    }
  : null;
// Every by-ply row of every counted board must sum to its total (sanity of the logs).
for (const [k, r] of count) if (r.byPly && r.total !== undefined && r.byPly.reduce((a: number, b: number) => a + b, 0) !== r.total) throw new Error(`${k}: byPly does not sum`);

// ---------------------------------------------------------------- 7 x 6 first moves
// Columns 1-3 are solved after the first move (5-7 are their mirror images); column 4 is
// then the only one that can carry the root's win. Exact scores come from single
// null-window searches: "is the score above s?" twice brackets it.
const CELLS = 42;
type Book = { score: number | null; exact: boolean };
const book: Book[] = Array.from({ length: 7 }, () => ({ score: null, exact: false }));
const done = (r: any) => r && !r.timeout;
const above = (moves: string, k: number) => {
  const r = solve.get(`above-7x6-${moves || '-'}-${k}`);
  return done(r) ? (r.above as boolean) : null;
};
const s76root = solve.get('solve-7x6');
for (const c of [1, 2, 3]) {
  const r = solve.get(`solve-7x6-${c}`);
  if (!done(r)) continue;
  const v = r.value === '+' ? 1 : r.value === '-' ? -1 : 0; // first player's view
  book[c - 1] = book[7 - c] = { score: v, exact: v === 0 };
}
if (done(s76root) && s76root.value === '+' && [0, 1, 2].every((i) => book[i].score !== null && book[i].score! <= 0)) {
  book[3] = { score: 1, exact: false };
  if (above('', 1) === false) book[3] = { score: 1, exact: true }; // win, and not by more than 1
}
// Second player's exact score after a first move into column c (k when it wins with its
// (22 - k)-th disc): weak says it wins (>= 1); above(k - 1) && !above(k) pins it to k.
for (const [c, k] of [[1, 2], [2, 1]] as const) {
  if (book[c - 1].score !== -1) continue;
  const lower = k === 1 ? true : above(String(c), k - 1);
  if (lower && above(String(c), k) === false) book[c - 1] = book[7 - c] = { score: -k, exact: true };
}
// The ply on which the game ends, from a first-move score (first player's point of view).
const endPly = (s: number) => (s > 0 ? 2 * (CELLS / 2 + 1 - s) - 1 : s < 0 ? 2 * (CELLS / 2 + 1 + s) : null);
const wiki = lit.wikipedia.claims.map((cl: { columns: number[]; value: string; ply: number | null; quote: string }) => {
  const got = cl.columns.map((c) => book[c - 1]);
  const value = got.map((b) => (b.score === null ? null : b.score > 0 ? '+' : b.score < 0 ? '-' : '='));
  const ply = got.map((b) => (b.exact && b.score !== null ? endPly(b.score) : null));
  const valueOk = value.every((v) => v === cl.value);
  const plyOk = cl.ply === null ? valueOk : ply.every((p) => p === cl.ply);
  return { ...cl, computedValue: value, computedPly: ply, status: value.includes(null) || (cl.ply !== null && ply.includes(null)) ? 'unknown' : valueOk && plyOk ? 'ok' : 'mismatch' };
});

// ---------------------------------------------------------------- notes for the page
const okT = table.filter((c: any) => c.status === 'ok').length;
const attempted = table.filter((c: any) => ['ok', 'mismatch', 'timeout'].includes(c.status)).length;
const timedOut = table.filter((c: any) => c.status === 'timeout').map((c: any) => `${c.w}×${c.h} (${c.cap} s)`);
const okC = counts.filter((c: any) => c.status === 'ok').length;
const skipped = counts.filter((c: any) => c.status === 'skipped').map((c: any) => `${c.w}×${c.h}`);
const fmt = (n: number) => n.toLocaleString('en');
const s76 = s76root;
const notes = [
  `<strong>Who wins, by board size.</strong> Tromp's table has ${table.length} cells. The native solver attempted ${attempted} and agrees on <strong>${okT}</strong>${timedOut.length ? `; ${timedOut.join(', ')} hit the time cap` : ''}. The other wide boards took Tromp thousands of CPU hours (9×6 in 2005, 8×8 in 2015) and were not attempted; 8×8 does not fit the 64-bit board.`,
  s76 && !s76.timeout ? `<strong>7×6, the standard board</strong>, is a first-player win: ${fmt(s76.nodes)} positions searched for the win/draw/loss answer.` : '',
  `<strong>Legal positions.</strong> ${okC} of Tromp's ${counts.length} counts recomputed exactly by marking every reachable position in a bitmap${skipped.length ? `; ${skipped.join(', ')} need a bigger bitmap than this run allowed` : ''}.`,
  levels ? `<strong>7×6 ply by ply.</strong> OEIS A212693 recomputed for plies 0–${levels.computed.length - 1}: ${levels.matched} of ${levels.computed.length} terms match.` : '',
  playOn.length ? `<strong>The counting convention matters.</strong> Tromp's numbers stop the game at four in a row. Letting play continue after a win gives ${playOn.map((p) => `${fmt(p.playOn)} on ${p.w}×${p.h}`).slice(0, 3).join(', ')} — none of them in the table.` : '',
  `<strong>Wikipedia's first-move values for 7×6</strong>: ${wiki.filter((w: any) => w.status === 'ok').length} of ${wiki.length} claims reproduced (centre wins on ply 41, the adjacent columns draw, columns 1 and 2 lose on plies 40 and 42).`,
].filter(Boolean);

const out = { table, counts, playOn, levels, book: { '7x6': book }, wiki, notes };
writeFileSync(new URL('src/stats.json', root), JSON.stringify(out, null, 1) + '\n');
console.log(`table ${okT}/${attempted} attempted (${table.length}), counts ${okC}/${counts.length}, levels ${levels?.matched}/${levels?.computed.length}, wiki ${wiki.map((w: any) => w.status).join(',')}`);
console.log('book', JSON.stringify(book));
