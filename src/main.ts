import './style.css';
import { FULL, stonesToWin } from './engine.ts';
import type { ColumnResult, Request } from './worker.ts';
import stats from './stats.json';

type Cell = (typeof stats.table)[number];
type CountCell = (typeof stats.counts)[number];

const BUDGET = 2_500_000; // nodes per column and stage (exact, then win/draw/loss)
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const sizeSel = $<HTMLSelectElement>('sizeSel');
const sideSel = $<HTMLSelectElement>('sideSel');
const showEval = $<HTMLInputElement>('showEval');
const boardEl = $('board');
const statusEl = $('status');

let W = 7;
let H = 6;
let moves: number[] = [];
let human = 1; // 1 = first player, 2 = second, 0 = both
let results = new Map<number, ColumnResult>();
let analysing = false;
let requestId = 0;
let hint = -1;
let lastMs = 0;
let aiTimer = 0;

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
worker.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.id !== requestId) return;
  if (m.kind === 'col') results.set(m.result.c, m.result);
  if (m.kind === 'done') {
    analysing = false;
    lastMs = m.ms;
    maybeAiMove();
  }
  render();
};

// ---------------------------------------------------------------- game state

function grid(): number[][] {
  const cols: number[][] = Array.from({ length: W }, () => []);
  moves.forEach((c, i) => cols[c].push(i % 2 === 0 ? 1 : 2));
  return cols;
}

function fourCells(cols: number[][]): Set<string> {
  const out = new Set<string>();
  const at = (c: number, r: number) => (c >= 0 && c < W && r >= 0 ? cols[c][r] ?? 0 : 0);
  for (let c = 0; c < W; c++)
    for (let r = 0; r < cols[c].length; r++)
      for (const [dc, dr] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
        const p = at(c, r);
        if (p && [1, 2, 3].every((k) => at(c + k * dc, r + k * dr) === p))
          for (let k = 0; k < 4; k++) out.add(`${c + k * dc},${r + k * dr}`);
      }
  return out;
}

function gameOver(): { winner: number; four: Set<string> } | null {
  const four = fourCells(grid());
  if (four.size) return { winner: moves.length % 2 === 1 ? 1 : 2, four };
  if (moves.length === W * H) return { winner: 0, four };
  return null;
}

const toMove = () => (moves.length % 2 === 0 ? 1 : 2);
const isAiTurn = () => human !== 0 && toMove() !== human && !gameOver();

function bookFor(): ColumnResult[] | null {
  if (moves.length) return null;
  const b = (stats.book as Record<string, { score: number | null; exact: boolean }[]>)[`${W}x${H}`];
  return b ? b.map((r, c) => ({ c, score: r.score, exact: r.exact, nodes: 0 })) : null;
}

function analyse() {
  requestId++;
  results = new Map();
  hint = -1;
  clearTimeout(aiTimer);
  if (gameOver()) {
    analysing = false;
    return;
  }
  const book = bookFor();
  if (book) {
    for (const r of book) results.set(r.c, r);
    analysing = false;
    lastMs = 0;
    maybeAiMove();
    return;
  }
  analysing = true;
  const req: Request = { id: requestId, w: W, h: H, moves, budget: BUDGET };
  worker.postMessage(req);
}

function syncUrl() {
  const q = new URLSearchParams({ w: String(W), h: String(H) });
  if (moves.length) q.set('moves', moves.map((c) => (c + 1).toString(36)).join(''));
  if (human !== 1) q.set('you', String(human));
  window.history.replaceState(null, '', `${location.pathname}?${q}`);
}

function setGame(next: number[]) {
  moves = next;
  syncUrl();
  analyse();
  render();
}

function drop(c: number, byAi = false) {
  if (gameOver() || grid()[c].length >= H) return;
  if (!byAi && isAiTurn()) return;
  setGame([...moves, c]);
}

// Best column by the verdicts: exact scores first, then win/draw/loss, unknown as a draw;
// ties go to the column nearest the centre.
function bestColumn(): { c: number; proven: boolean } {
  let best = -1;
  let bestKey = -Infinity;
  let proven = true;
  for (let c = 0; c < W; c++) {
    if (grid()[c].length >= H) continue;
    const r = results.get(c);
    let key: number;
    if (r && r.score !== null && r.score !== FULL) key = r.exact ? r.score * 4 : Math.sign(r.score) * 2;
    else key = 0;
    key -= Math.abs(c - (W - 1) / 2) * 0.01;
    if (key > bestKey) {
      bestKey = key;
      best = c;
    }
  }
  for (let c = 0; c < W; c++) {
    const r = results.get(c);
    if (grid()[c].length < H && (!r || r.score === null || !r.exact)) proven = false;
  }
  return { c: best, proven };
}

function maybeAiMove() {
  if (!isAiTurn() || analysing) return;
  clearTimeout(aiTimer);
  aiTimer = window.setTimeout(() => {
    if (isAiTurn() && !analysing) drop(bestColumn().c, true);
  }, 350);
}

// ---------------------------------------------------------------- rendering

function verdict(r: ColumnResult | undefined): { cls: string; v: string; n: string; title: string } {
  if (!r) return { cls: 'pending', v: '…', n: '', title: 'solving' };
  if (r.score === FULL) return { cls: '', v: '', n: '', title: 'column full' };
  if (r.score === null)
    return { cls: '', v: '?', n: '', title: `not solved within ${BUDGET.toLocaleString('en')} nodes (${r.nodes.toLocaleString('en')} searched)` };
  const nodes = `${r.nodes.toLocaleString('en')} nodes`;
  if (!r.exact) {
    const cls = r.score > 0 ? 'win weak' : r.score < 0 ? 'lose weak' : 'draw weak';
    return { cls, v: r.score > 0 ? 'win' : r.score < 0 ? 'lose' : 'draw', n: '', title: `win/draw/loss only — ${nodes}` };
  }
  const k = stonesToWin(r.score, moves.length, W * H);
  if (r.score > 0) return { cls: 'win', v: 'win', n: `in ${k}`, title: `wins with your ${k === 1 ? 'next disc' : `${k}th disc from now`} — ${nodes}` };
  if (r.score < 0) return { cls: 'lose', v: 'lose', n: `in ${k}`, title: `opponent wins with their ${k === 1 ? 'next disc' : `${k}th disc from now`} — ${nodes}` };
  return { cls: 'draw', v: 'draw', n: '', title: `draw — ${nodes}` };
}

function render() {
  const cols = grid();
  const over = gameOver();
  const cell = Math.max(30, Math.min(64, Math.floor(560 / Math.max(W, H + 1))));
  boardEl.style.setProperty('--cell', `${cell}px`);
  boardEl.style.gridTemplateColumns = `repeat(${W}, auto)`;
  const maxScore = Math.max(
    ...[...results.values()].filter((r) => r.exact && r.score !== null && r.score !== FULL).map((r) => r.score as number),
  );
  const last = moves.length ? `${moves[moves.length - 1]},${cols[moves[moves.length - 1]].length - 1}` : '';
  boardEl.innerHTML = '';
  for (let c = 0; c < W; c++) {
    const col = document.createElement('div');
    col.className = 'col' + (cols[c].length >= H || over ? ' full' : '') + (hint === c ? ' hint' : '');
    col.setAttribute('role', 'button');
    col.setAttribute('aria-label', `column ${c + 1}`);
    const v = verdict(results.get(c));
    const vd = document.createElement('div');
    const isBest = results.get(c)?.exact && results.get(c)?.score === maxScore && results.size === W;
    vd.className = `verdict ${showEval.checked && !over ? v.cls : ''}${isBest && showEval.checked ? ' best' : ''}`;
    if (showEval.checked && !over) {
      vd.innerHTML = `<span class="v">${v.v}</span><span>${v.n}</span>`;
      vd.title = v.title;
    }
    col.appendChild(vd);
    const slots = document.createElement('div');
    slots.className = 'slots';
    for (let r = 0; r < H; r++) {
      const d = document.createElement('div');
      const p = cols[c][r] ?? 0;
      const id = `${c},${r}`;
      d.className = `cell${p ? ` p${p}` : ''}${over?.four.has(id) ? ' four' : id === last ? ' last' : ''}`;
      slots.appendChild(d);
    }
    col.appendChild(slots);
    col.addEventListener('click', () => drop(c));
    boardEl.appendChild(col);
  }
  renderStatus(over);
  renderTables();
  ($<HTMLButtonElement>('undo')).disabled = moves.length === 0;
}

function renderStatus(over: ReturnType<typeof gameOver>) {
  const name = (p: number) => (p === 1 ? '<span class="y">Yellow</span>' : '<span class="r">Red</span>');
  if (over) {
    statusEl.innerHTML = over.winner ? `<strong>${name(over.winner)} wins</strong> after ${moves.length} discs.` : '<strong>Draw</strong> — the board is full.';
    return;
  }
  const p = toMove();
  const who = human === 0 ? '' : p === human ? ' (you)' : ' (computer)';
  let line = `${name(p)}${who} to move.`;
  if (results.size === W) {
    const known = [...results.values()].filter((r) => r.score !== FULL);
    const exact = known.filter((r) => r.exact && r.score !== null).map((r) => r.score as number);
    if (exact.length === known.length) {
      const s = Math.max(...exact);
      const k = stonesToWin(s, moves.length, W * H);
      line += s > 0 ? ` With perfect play ${name(p)} <strong>wins with ${k === 1 ? 'the next disc' : `${k} more discs`}</strong>.`
        : s < 0 ? ` With perfect play ${name(3 - p)} <strong>wins with ${k === 1 ? 'their next disc' : `${k} more discs`}</strong>.`
        : ' With perfect play it is a <strong>draw</strong>.';
    } else {
      line += ' Some columns (?) are beyond the in-browser node budget';
      line += human !== 0 && !isAiTurn() ? '.' : ' — the computer guesses there.';
    }
    const nodes = known.reduce((n, r) => n + r.nodes, 0);
    if (nodes) line += ` <span class="dim">${nodes.toLocaleString('en')} nodes, ${Math.round(lastMs)} ms.</span>`;
    else if (!moves.length) line += ' <span class="dim">Verdicts for the empty board from the native solver.</span>';
  } else line += ' <span class="dim">solving…</span>';
  statusEl.innerHTML = line;
}

const SYM: Record<string, string> = { '+': 'cell-win', '=': 'cell-draw', '-': 'cell-lose' };
const STATUS: Record<string, [string, string]> = {
  ok: ['✓', 'ok'], mismatch: ['✗', 'bad'], timeout: ['time', ''], 'not-attempted': ['—', ''], 'too-wide': ['>64b', ''],
};

function renderTables() {
  const t = $('table');
  const hs = [...new Set(stats.table.map((c) => c.h))].sort((a, b) => b - a);
  const ws = [...new Set(stats.table.map((c) => c.w))].sort((a, b) => a - b);
  let html = '<table class="grid"><tr><th>h\\w</th>' + ws.map((w) => `<th>${w}</th>`).join('') + '</tr>';
  for (const h of hs) {
    html += `<tr><th>${h}</th>`;
    for (const w of ws) {
      const c = stats.table.find((x) => x.w === w && x.h === h) as Cell | undefined;
      if (!c) { html += '<td></td>'; continue; }
      const [mark, cls] = STATUS[c.status];
      const fits = w * (h + 1) <= 64;
      const title = `${w}×${h}: published ${c.published}` + (c.computed ? `, computed ${c.computed} (${c.nodes?.toLocaleString('en')} nodes)` : `, ${c.status}${'cap' in c ? ` after ${c.cap} s` : ''}`);
      html += `<td class="${SYM[c.published]}${fits ? ' pick' : ''}${w === W && h === H ? ' cur' : ''}" data-w="${w}" data-h="${h}" title="${title}">${c.published}<small class="${cls}">${mark}</small></td>`;
    }
    html += '</tr>';
  }
  html += '</table>';
  const ok = stats.table.filter((c) => c.status === 'ok').length;
  html += `<div class="legend">+ first player wins, = draw, − second player wins. ✓ = the solver here agrees (${ok} of ${stats.table.length} cells); time = hit the time cap; — = not attempted. Click a cell to play on that board.</div>`;
  t.innerHTML = html;
  t.querySelectorAll<HTMLElement>('td.pick').forEach((td) =>
    td.addEventListener('click', () => setSize(Number(td.dataset.w), Number(td.dataset.h))),
  );

  const k = $('counts');
  const chs = [...new Set(stats.counts.map((c) => c.h))].sort((a, b) => b - a);
  const cws = [...new Set(stats.counts.map((c) => c.w))].sort((a, b) => a - b);
  let ch = '<table class="grid wide"><tr><th>h\\w</th>' + cws.map((w) => `<th>${w}</th>`).join('') + '</tr>';
  for (const h of chs) {
    ch += `<tr><th>${h}</th>`;
    for (const w of cws) {
      const c = stats.counts.find((x) => x.w === w && x.h === h) as CountCell | undefined;
      if (!c) { ch += '<td></td>'; continue; }
      const mark = c.status === 'ok' ? '<small class="ok">✓</small>' : c.status === 'mismatch' ? '<small class="bad">✗</small>' : '<small>—</small>';
      ch += `<td title="${w}×${h}: ${c.published.toLocaleString('en')} published${c.computed !== null ? `, ${c.computed.toLocaleString('en')} counted` : ''}" class="${w === W && h === H ? 'cur' : ''}">${short(c.published)}${mark}</td>`;
    }
    ch += '</tr>';
  }
  ch += '</table>';
  const here = stats.counts.find((c) => c.w === W && c.h === H);
  const okc = stats.counts.filter((c) => c.status === 'ok').length;
  ch += `<div id="countLine">${here ? `${W}×${H}: <strong>${here.published.toLocaleString('en')}</strong> positions${here.computed !== null ? ' — counted here too' : ''}. ` : ''}✓ = recounted exactly (${okc} of ${stats.counts.length}).</div>`;
  k.innerHTML = ch;
}

function short(n: number): string {
  if (n < 10_000) return String(n);
  const e = Math.floor(Math.log10(n));
  return `${(n / 10 ** e).toFixed(1)}e${e}`;
}

function setSize(w: number, h: number) {
  W = w;
  H = h;
  sizeSel.value = `${w}x${h}`;
  setGame([]);
}

// ---------------------------------------------------------------- notes

function renderNotes() {
  $('notes').innerHTML = `<h2>What was recomputed</h2><ul>${stats.notes.map((n) => `<li>${n}</li>`).join('')}</ul>`;
}

// ---------------------------------------------------------------- setup

const sizes = stats.table.filter((c) => c.w * (c.h + 1) <= 64).sort((a, b) => a.w * a.h - b.w * b.h || a.w - b.w);
for (const c of sizes) {
  const o = document.createElement('option');
  o.value = `${c.w}x${c.h}`;
  o.textContent = `${c.w} × ${c.h}${c.w === 7 && c.h === 6 ? ' (standard)' : ''}`;
  sizeSel.appendChild(o);
}
sizeSel.addEventListener('change', () => {
  const [w, h] = sizeSel.value.split('x').map(Number);
  setSize(w, h);
});
sideSel.addEventListener('change', () => {
  human = Number(sideSel.value);
  syncUrl();
  maybeAiMove();
  render();
});
$('newGame').addEventListener('click', () => setGame([]));
$('undo').addEventListener('click', () => {
  if (!moves.length) return;
  // Against the computer, take back its reply too.
  const back = human !== 0 && moves.length >= 2 && toMove() === human ? 2 : 1;
  setGame(moves.slice(0, moves.length - back));
});
$('hint').addEventListener('click', () => {
  hint = bestColumn().c;
  render();
});
showEval.addEventListener('change', render);

const q = new URLSearchParams(location.search);
const qw = Number(q.get('w')), qh = Number(q.get('h'));
if (sizes.some((c) => c.w === qw && c.h === qh)) { W = qw; H = qh; }
sizeSel.value = `${W}x${H}`;
human = q.has('you') ? Number(q.get('you')) : 1;
if (![0, 1, 2].includes(human)) human = 1;
sideSel.value = String(human);
const parsed: number[] = [];
{
  const heights = new Array(W).fill(0);
  for (const ch of q.get('moves') ?? '') {
    const c = parseInt(ch, 36) - 1;
    if (!(c >= 0 && c < W) || heights[c] >= H) break;
    parsed.push(c);
    heights[c]++;
    moves = parsed;
    if (gameOver()) break;
  }
}
renderNotes();
setGame(parsed);
