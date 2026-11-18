// Gera js/study.js: estatísticas agregadas (30 moedas, histórico completo) da estratégia escolhida.
// Esses números aparecem no app como "o estudo por trás" e alimentam a simulação quando a moeda tem poucos casos.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { computeIndicators, quantile, PARAMS, isTrigger, marketRegime } from '../js/analysis.js';
import { readFileSync as rf } from 'node:fs';
const dir = process.argv[2] || 'research/data';
const H = PARAMS.horizon, COST = PARAMS.costPct;
const ev = [], base = [], strong = [], baseY = {};
let coins = 0, from = Infinity;
for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
  const cs = JSON.parse(readFileSync(`${dir}/${f}`)); const d = computeIndicators(cs);
  coins++; from = Math.min(from, cs[0].t);
  let last = -1e9;
  for (let i = 30; i + H < d.c.length; i++) {
    const r = d.c[i + H] / d.c[i] - 1 - COST;
    base.push(r); const yy = new Date(cs[i].t).getUTCFullYear(); (baseY[yy] ||= []).push(r);
    const g = isTrigger(d, i);
    if (!g || i - last < H) continue;
    last = i; ev.push({ t: cs[i].t, r }); if (g === 'strong') strong.push(r);
  }
}
// amplitude: fração das moedas no gatilho em cada dia
const trigCount = {}, active = {};
for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
  const cs = JSON.parse(rf(`${dir}/${f}`)); const d = computeIndicators(cs);
  for (let i = 30; i < d.c.length; i++) { active[cs[i].t] = (active[cs[i].t] || 0) + 1; if (isTrigger(d, i)) trigCount[cs[i].t] = (trigCount[cs[i].t] || 0) + 1; }
}
// clima (tendência do BTC) em cada dia
const btcCs = JSON.parse(rf(`${dir}/BTC.json`));
const regimeAt = new Map(); for (let i = 230; i < btcCs.length; i++) regimeAt.set(btcCs[i].t, marketRegime(btcCs.slice(0, i + 1)).state);
const panic = ev.filter(e => trigCount[e.t] / active[e.t] >= PARAMS.minBreadth).map(e => e.r);
const isolated = ev.filter(e => trigCount[e.t] / active[e.t] < PARAMS.minBreadth).map(e => e.r);
const s = ev.map(e => e.r).sort((a, b) => a - b);
const win = a => a.filter(x => x > 0).length / a.length;
const wk = {}; for (const e of ev) (wk[Math.floor(e.t / 6048e5)] ||= []).push(e.r);
// excesso em relação a um dia qualquer do MESMO ANO (remove o efeito de ano bom/ruim) e agrupado por semana
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const bmY = Object.fromEntries(Object.entries(baseY).map(([y, a]) => [y, mean(a)]));
const winY = Object.fromEntries(Object.entries(baseY).map(([y, a]) => [y, a.filter(x => x > 0).length / a.length]));
const wkE = {}; for (const e of ev) { const y = new Date(e.t).getUTCFullYear(); (wkE[Math.floor(e.t / 6048e5)] ||= []).push({ ex: e.r - bmY[y], wx: (e.r > 0) - winY[y] }); }
const tstat = arr => { const m = mean(arr), sd = Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1)); return m / (sd / Math.sqrt(arr.length)); };
const wEx = Object.values(wkE).map(a => mean(a.map(x => x.ex)));
const wWin = Object.values(wkE).map(a => mean(a.map(x => x.wx)));
const w = wEx;
const years = {}; for (const e of ev) { const y = new Date(e.t).getUTCFullYear(); (years[y] ||= []).push(e.r); }
const q = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95].map(p => +quantile(s, p).toFixed(4));
const study = {
  rule: 'Queda de 25%+ da máxima de 30 dias e RSI(14) < 30', horizon: H,
  coins, from: new Date(from).toISOString().slice(0, 10), to: new Date(ev.at(-1).t).toISOString().slice(0, 10),
  events: ev.length, winRate: +win(s).toFixed(4), baseWinRate: +win(base).toFixed(4),
  strongEvents: strong.length, strongWinRate: +win(strong).toFixed(4),
  climate: Object.fromEntries(['bull', 'correction', 'bear'].map(k => { const a = ev.filter(e => trigCount[e.t] / active[e.t] >= PARAMS.minBreadth && regimeAt.get(e.t) === k).map(e => e.r); return [k, { n: a.length, win: +win(a).toFixed(4) }]; })),
  alerts: (() => { const a = ev.filter(e => trigCount[e.t] / active[e.t] >= PARAMS.minBreadth && regimeAt.has(e.t) && regimeAt.get(e.t) !== 'bear'); const r = a.map(e => e.r).sort((x, y) => x - y);
    const per = k => { const b = a.filter(e => (e.t < Date.UTC(2023, 0, 1)) === (k === 'is')).map(e => e.r); return { n: b.length, win: +win(b).toFixed(4) }; };
    return { n: r.length, win: +win(r).toFixed(4), median: +quantile(r, 0.5).toFixed(4), study: per('is'), proof: per('oos') }; })(),
  breadth: { panicEvents: panic.length, panicWinRate: +win(panic).toFixed(4), isolatedEvents: isolated.length, isolatedWinRate: +win(isolated).toFixed(4) },
  median: q[3], quantiles: { p5: q[0], p10: q[1], p25: q[2], p50: q[3], p75: q[4], p90: q[5], p95: q[6] },
  weeks: w.length, tWeekly: +tstat(wEx).toFixed(2), tWeeklyWin: +tstat(wWin).toFixed(2),
  byYear: Object.fromEntries(Object.entries(years).map(([y, a]) => [y, { n: a.length, win: +win(a).toFixed(3) }])),
  // distribuição (percentis 1..99) para a simulação
  dist: Array.from({ length: 99 }, (_, k) => +quantile(s, (k + 1) / 100).toFixed(4)),
};
writeFileSync('js/study.js', `// Gerado por research/build-study.mjs em ${new Date().toISOString().slice(0, 10)} — não edite à mão.\nexport const STUDY = ${JSON.stringify(study, null, 1)};\n`);
console.log({ ...study, dist: `[${study.dist.length} pontos]` });
