// Baixa o histórico diário completo (desde a listagem) de todas as moedas da lista padrão.
// Uso: node research/fetch-history.mjs <pasta-de-saida>
import { writeFileSync, mkdirSync } from 'node:fs';
import { COINS } from '../js/coins.js';
const out = process.argv[2] || 'research/data';
mkdirSync(out, { recursive: true });
const BASE = 'https://data-api.binance.vision/api/v3/klines';
for (const c of COINS) {
  let start = Date.UTC(2017, 0, 1), all = [];
  for (;;) {
    const r = await fetch(`${BASE}?symbol=${c.sym}USDT&interval=1d&limit=1000&startTime=${start}`);
    if (!r.ok) { console.log(c.sym, 'HTTP', r.status); break; }
    const rows = await r.json();
    all.push(...rows.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[7] })));
    if (rows.length < 1000) break;
    start = rows.at(-1)[0] + 1;
  }
  writeFileSync(`${out}/${c.sym}.json`, JSON.stringify(all));
  console.log(c.sym.padEnd(7), all.length, 'dias desde', all[0] && new Date(all[0].t).toISOString().slice(0, 10));
}
