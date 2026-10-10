// Fetches the published numbers this repo checks itself against and writes
// tools/literature.json (committed, so `npm run stats` works offline):
//   - John Tromp, "John's Connect Four Playground": who wins on each board size, and the
//     number of legal positions on boards up to 8 wide (two HTML tables);
//   - OEIS A212693, legal 7 x 6 positions after n plies;
//   - Wikipedia, "Connect Four": the exact values of the 7 x 6 first moves.
import { writeFileSync } from 'node:fs';

const TROMP = 'https://tromp.github.io/c4/c4.html';
const OEIS = 'https://oeis.org/search?q=id:A212693&fmt=json';
const WIKI = 'https://en.wikipedia.org/w/index.php?title=Connect_Four&action=raw';

const get = async (url: string) => {
  const r = await fetch(url, { headers: { 'user-agent': 'sen-ltd/connect-four literature check' } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
};

// Rows are <tr><th>height</th> <td>..</td>...; the cells are left-aligned, starting at the
// first width of the footer row.
function parseTable(html: string) {
  const rows = [...html.matchAll(/<tr>(.*?)<\/tr>/gs)].map((m) => m[1]);
  const footer = rows.find((r) => /width/.test(r))!;
  const widths = [...footer.matchAll(/<th>\s*(\d+)\s*<\/th>/g)].map((m) => Number(m[1]));
  const cells: { w: number; h: number; value: string }[] = [];
  for (const r of rows) {
    const h = r.match(/^<th>\s*(\d+)\s*<\/th>/);
    if (!h) continue;
    [...r.matchAll(/<td>\s*([^<]*?)\s*<\/td>/g)].forEach((m, i) => cells.push({ w: widths[i], h: Number(h[1]), value: m[1] }));
  }
  return cells;
}

const tromp = await get(TROMP);
const parts = tromp.split(/<table[^>]*>/).slice(1).map((t) => t.split('</table>')[0]);
const results = parseTable(parts[0]);
const counts = parseTable(parts[1]).map((c) => ({ w: c.w, h: c.h, positions: Number(c.value) }));
if (!results.every((c) => ['+', '=', '-'].includes(c.value))) throw new Error('unexpected result symbol');

const oeis = JSON.parse(await get(OEIS));
const entry = Array.isArray(oeis) ? oeis[0] : oeis.results[0];
const a212693 = (entry.data as string).split(',').map(Number);

const wiki = await get(WIKI);
const sentence = wiki.match(/The solved conclusion for ''Connect Four''[^\n]*/)![0];
const strip = (s: string) => s.replace(/<ref[^>]*\/>|<ref[^>]*>.*?<\/ref>/gs, '').replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1');

writeFileSync(
  new URL('./literature.json', import.meta.url),
  JSON.stringify(
    {
      fetched: new Date().toISOString().slice(0, 10),
      tromp: { url: TROMP, results, counts },
      oeis: { url: 'https://oeis.org/A212693', name: entry.name, data: a212693 },
      wikipedia: {
        url: 'https://en.wikipedia.org/wiki/Connect_Four',
        text: strip(sentence),
        // The claims in that sentence, as (first move, value for the first player, ply of the end).
        claims: [
          { columns: [4], value: '+', ply: 41, quote: 'the first player can force a win, on or before the 41st move by starting in the middle column' },
          { columns: [3, 5], value: '=', ply: null, quote: 'a theoretical draw when the first player starts in the columns adjacent to the center' },
          { columns: [1, 7], value: '-', ply: 40, quote: 'column 1 and 2 on left (or column 7 and 6 on right), the exact move-value score for first player start is loss on the 40th move' },
          { columns: [2, 6], value: '-', ply: 42, quote: '... and loss on the 42nd move, respectively' },
        ],
      },
    },
    null,
    1,
  ) + '\n',
);
console.log(`results ${results.length}, counts ${counts.length}, A212693 ${a212693.length} terms`);
