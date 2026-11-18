// Laboratório: testa várias estratégias de compra em todo o histórico diário de todas as moedas.
// Separa em PERÍODO DE ESTUDO (antes de 2023) e PERÍODO DE PROVA (2023 em diante).
// Uma estratégia só é aceita se tiver vantagem nos DOIS períodos.
// Uso: node research/backtest-strategies.mjs <pasta-com-json>
import { readFileSync, readdirSync } from 'node:fs';
import { sma, rsi, computeIndicators, scoreAt } from '../js/analysis.js';

const dir = process.argv[2] || 'research/data';
const SPLIT = Date.UTC(2023, 0, 1);
const COST = 0.002;
const HS = [7, 14, 30];

const rollMax = (a, n) => a.map((_, i) => { let m = -Infinity; for (let j = Math.max(0, i - n + 1); j <= i; j++) m = Math.max(m, a[j]); return m; });
const rollMin = (a, n) => a.map((_, i) => { let m = Infinity; for (let j = Math.max(0, i - n + 1); j <= i; j++) m = Math.min(m, a[j]); return m; });

function prep(candles) {
  const ind = computeIndicators(candles);
  const c = ind.c;
  ind.rsi2 = rsi(c, 2);
  ind.hi20 = rollMax(c, 20); ind.hi50 = rollMax(c, 50); ind.hi30 = rollMax(c, 30);
  ind.lo20 = rollMin(c, 20);
  ind.vol20 = sma(ind.v, 20);
  ind.t = candles.map(k => k.t);
  return ind;
}

// BTC como "clima do mercado"
const btc = prep(JSON.parse(readFileSync(`${dir}/BTC.json`)));
const btcIdx = new Map(btc.t.map((t, i) => [t, i]));
const btcUp = t => { const i = btcIdx.get(t); return i != null && btc.sma200[i] != null && btc.c[i] > btc.sma200[i]; };
const btcAbove50 = t => { const i = btcIdx.get(t); return i != null && btc.sma50[i] != null && btc.c[i] > btc.sma50[i]; };

const S = {
  'Pontuação atual ≥65 (regra antiga)': (d, i) => scoreAt(d, i).score >= 65,
  'Queda forte: -25% em 30d + RSI<30': (d, i) => d.c[i] / d.hi30[i] - 1 <= -0.25 && d.rsi14[i] < 30,
  'Queda forte: -35% em 30d': (d, i) => d.c[i] / d.hi30[i] - 1 <= -0.35,
  'Queda forte -25% em 30d + BTC>MM200': (d, i) => d.c[i] / d.hi30[i] - 1 <= -0.25 && btcUp(d.t[i]),
  'Sobrevenda em alta: >MM200 e RSI<35': (d, i) => d.c[i] > d.sma200[i] && d.rsi14[i] < 35,
  'Connors: >MM200 e RSI(2)<10': (d, i) => d.c[i] > d.sma200[i] && d.rsi2[i] < 10,
  'Connors + BTC>MM200': (d, i) => d.c[i] > d.sma200[i] && d.rsi2[i] < 10 && btcUp(d.t[i]),
  'Rompimento 20d + volume 1,5x': (d, i) => d.c[i] >= d.hi20[i] && d.c[i - 1] < d.hi20[i - 1] && d.v[i] > 1.5 * d.vol20[i],
  'Rompimento 50d': (d, i) => d.c[i] >= d.hi50[i] && d.c[i - 1] < d.hi50[i - 1],
  'Rompimento 50d + BTC>MM200': (d, i) => d.c[i] >= d.hi50[i] && d.c[i - 1] < d.hi50[i - 1] && btcUp(d.t[i]),
  'Cruz dourada (MM50 cruza MM200)': (d, i) => d.sma50[i] > d.sma200[i] && d.sma50[i - 1] <= d.sma200[i - 1],
  'Volta acima da MM200': (d, i) => d.c[i] > d.sma200[i] && d.c[i - 1] <= d.sma200[i - 1],
  'Volta acima MM200 + BTC>MM50': (d, i) => d.c[i] > d.sma200[i] && d.c[i - 1] <= d.sma200[i - 1] && btcAbove50(d.t[i]),
  'Bollinger: volta para dentro da banda inferior': (d, i) => {
    const lb = j => d.sma20[j] - 2 * d.std20[j];
    return d.c[i - 1] < lb(i - 1) && d.c[i] > lb(i);
  },
  'Só BTC>MM200 (clima bom)': (d, i) => btcUp(d.t[i]),
};

const files = readdirSync(dir).filter(f => f.endsWith('.json'));
const data = files.map(f => ({ sym: f.replace('.json', ''), d: prep(JSON.parse(readFileSync(`${dir}/${f}`))) }));

function stats(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, arr.length - 1));
  return { n: arr.length, win: arr.filter(x => x > 0).length / arr.length, mean, med: s[s.length >> 1], t: mean / (sd / Math.sqrt(arr.length)) };
}

const rows = [];
for (const H of HS) {
  // base: todos os dias (não sobrepostos não importa para média), por período
  const base = { is: [], oos: [] };
  for (const { d } of data) for (let i = 200; i + H < d.c.length; i++) base[d.t[i] < SPLIT ? 'is' : 'oos'].push(d.c[i + H] / d.c[i] - 1 - COST);
  const bIS = stats(base.is), bOOS = stats(base.oos);
  rows.push({ H, name: '— BASE (comprar num dia qualquer) —', is: bIS, oos: bOOS, exIS: 0, exOOS: 0 });
  for (const [name, fn] of Object.entries(S)) {
    const ev = { is: [], oos: [] }, ex = { is: [], oos: [] };
    for (const { d } of data) {
      // média base da moeda no período, para retorno em excesso
      const bm = { is: [], oos: [] };
      for (let i = 200; i + H < d.c.length; i++) bm[d.t[i] < SPLIT ? 'is' : 'oos'].push(d.c[i + H] / d.c[i] - 1 - COST);
      const mb = { is: stats(bm.is)?.mean ?? 0, oos: stats(bm.oos)?.mean ?? 0 };
      let last = -Infinity;
      for (let i = 201; i + H < d.c.length; i++) {
        if (d.sma200[i] == null || i - last < H) continue;
        let ok = false; try { ok = fn(d, i); } catch {}
        if (!ok) continue;
        last = i;
        const k = d.t[i] < SPLIT ? 'is' : 'oos';
        const r = d.c[i + H] / d.c[i] - 1 - COST;
        ev[k].push(r); ex[k].push(r - mb[k]);
      }
    }
    rows.push({ H, name, is: stats(ev.is), oos: stats(ev.oos), exIS: stats(ex.is), exOOS: stats(ex.oos) });
  }
}

const p = x => x == null ? '   —  ' : `${(x * 100).toFixed(1).padStart(5)}%`;
const f = (s, ex, b) => !s ? '        sem casos         '.padEnd(46) :
  `n=${String(s.n).padStart(4)} acerto ${p(s.win)} (base ${p(b.win)}) mediana ${p(s.med)} excesso ${ex === 0 ? '   —  ' : p(ex.mean)} t=${ex === 0 ? ' — ' : ex.t.toFixed(1).padStart(4)}`;
for (const H of HS) {
  const b = rows.find(r => r.H === H && r.name.startsWith('—'));
  console.log(`\n================ HORIZONTE ${H} DIAS ================`);
  for (const r of rows.filter(r => r.H === H)) {
    console.log(`\n${r.name}`);
    console.log(`  estudo (<2023): ${f(r.is, r.exIS, b.is)}`);
    console.log(`  prova (2023+):  ${f(r.oos, r.exOOS, b.oos)}`);
  }
}
