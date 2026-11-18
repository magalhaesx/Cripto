// Testes de robustez das estratégias finalistas:
//  1) variação de parâmetros (evita "escolher a dedo"), 2) resultado ano a ano,
//  3) estatística por semana (sinais de várias moedas no mesmo dia não contam como independentes).
import { readFileSync, readdirSync } from 'node:fs';
import { sma, rsi, computeIndicators } from '../js/analysis.js';
const dir = process.argv[2] || 'research/data';
const COST = 0.002;
const rollMax = (a, n) => a.map((_, i) => { let m = -Infinity; for (let j = Math.max(0, i - n + 1); j <= i; j++) m = Math.max(m, a[j]); return m; });
function prep(cs) { const d = computeIndicators(cs); d.t = cs.map(k => k.t); d.hi = {}; for (const n of [20, 30, 50, 100]) d.hi[n] = rollMax(d.c, n); d.hi30 = d.hi[30]; return d; }
const btc = prep(JSON.parse(readFileSync(`${dir}/BTC.json`)));
const bi = new Map(btc.t.map((t, i) => [t, i]));
const btcUp = (t, n = 200) => { const i = bi.get(t); const m = n === 200 ? btc.sma200 : n === 100 ? sma(btc.c, 100) : btc.sma50; return i != null && m[i] != null && btc.c[i] > m[i]; };
const btcS100 = sma(btc.c, 100);
const btcUpN = { 200: t => btcUp(t, 200), 100: t => { const i = bi.get(t); return i != null && btcS100[i] != null && btc.c[i] > btcS100[i]; }, 50: t => btcUp(t, 50) };
const data = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => prep(JSON.parse(readFileSync(`${dir}/${f}`))));

function run(fn, H) {
  const ev = [];
  for (const d of data) {
    const base = []; for (let i = 200; i + H < d.c.length; i++) base.push({ t: d.t[i], r: d.c[i + H] / d.c[i] - 1 - COST });
    const byYear = {}; for (const b of base) { const y = new Date(b.t).getUTCFullYear(); (byYear[y] ||= []).push(b.r); }
    const bm = Object.fromEntries(Object.entries(byYear).map(([y, a]) => [y, a.reduce((s, x) => s + x, 0) / a.length]));
    let last = -1e9;
    for (let i = 201; i + H < d.c.length; i++) {
      if (d.sma200[i] == null || i - last < H || !fn(d, i)) continue;
      last = i; const r = d.c[i + H] / d.c[i] - 1 - COST; const y = new Date(d.t[i]).getUTCFullYear();
      ev.push({ t: d.t[i], y, r, ex: r - bm[y] });
    }
  }
  // agrega por semana
  const wk = {}; for (const e of ev) { const w = Math.floor(e.t / (7 * 864e5)); (wk[w] ||= []).push(e.ex); }
  const w = Object.values(wk).map(a => a.reduce((s, x) => s + x, 0) / a.length);
  const m = w.reduce((s, x) => s + x, 0) / w.length, sd = Math.sqrt(w.reduce((s, x) => s + (x - m) ** 2, 0) / (w.length - 1));
  const med = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  return { n: ev.length, weeks: w.length, win: ev.filter(e => e.r > 0).length / ev.length, med: med(ev.map(e => e.r)), exMed: med(ev.map(e => e.ex)), tW: m / (sd / Math.sqrt(w.length)), ev };
}
const P = x => `${(x * 100).toFixed(1).padStart(5)}%`;
const line = (name, s) => console.log(`${name.padEnd(44)} n=${String(s.n).padStart(4)} semanas=${String(s.weeks).padStart(3)} acerto ${P(s.win)} mediana ${P(s.med)} excesso-mediano ${P(s.exMed)} t(semanal)=${s.tW.toFixed(1)}`);

const brk = (n, bf) => (d, i) => d.c[i] >= d.hi[n][i] && d.c[i - 1] < d.hi[n][i - 1] && (!bf || btcUpN[bf](d.t[i]));
for (const H of [14, 30]) {
  console.log(`\n=== ROMPIMENTO — variações de parâmetros — ${H} dias ===`);
  for (const n of [20, 30, 50, 100]) for (const bf of [null, 50, 100, 200]) line(`Rompimento ${n}d ${bf ? `+ BTC>MM${bf}` : '(sem filtro)'}`, run(brk(n, bf), H));
}
console.log('\n=== QUEDA FORTE (repique) — variações — 7 dias ===');
for (const dd of [-0.2, -0.25, -0.3]) for (const r of [25, 30, 35]) line(`Queda ${dd * 100}% em 30d + RSI<${r}`, run((d, i) => d.c[i] / d.hi30[i] - 1 <= dd && d.rsi14[i] < r, 7));

console.log('\n=== ANO A ANO ===');
for (const [name, fn, H] of [['Rompimento 50d + BTC>MM200 (14d)', brk(50, 200), 14], ['Rompimento 50d + BTC>MM200 (30d)', brk(50, 200), 30], ['Queda -25% + RSI<30 (7d)', (d, i) => d.c[i] / d.hi30[i] - 1 <= -0.25 && d.rsi14[i] < 30, 7]]) {
  const s = run(fn, H); console.log(`\n${name}`);
  const ys = {}; for (const e of s.ev) (ys[e.y] ||= []).push(e);
  for (const [y, a] of Object.entries(ys)) {
    const win = a.filter(e => e.r > 0).length / a.length; const mex = a.reduce((x, e) => x + e.ex, 0) / a.length;
    console.log(`  ${y}: n=${String(a.length).padStart(3)} acerto ${P(win)} excesso médio ${P(mex)}`);
  }
}
