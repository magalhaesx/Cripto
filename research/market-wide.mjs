// O repique funciona igual quando MUITAS moedas disparam juntas (pânico geral) vs. queda isolada?
import { readFileSync, readdirSync } from 'node:fs';
import { computeIndicators, isTrigger, PARAMS } from '../js/analysis.js';
const dir = process.argv[2] || 'research/data';
const H = PARAMS.horizon, COST = PARAMS.costPct;
const all = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => { const cs = JSON.parse(readFileSync(`${dir}/${f}`)); return { sym: f.slice(0, -5), t: cs.map(k => k.t), d: computeIndicators(cs) }; });
const count = {}, active = {};
for (const { t, d } of all) for (let i = 30; i < d.c.length; i++) { active[t[i]] = (active[t[i]] || 0) + 1; if (isTrigger(d, i)) count[t[i]] = (count[t[i]] || 0) + 1; }
const btc = all.find(x => x.sym === 'BTC'); const btcTrig = new Set(btc.t.filter((_, i) => i >= 30 && isTrigger(btc.d, i)));
const groups = {};
for (const { t, d } of all) {
  let last = -1e9;
  for (let i = 30; i + H < d.c.length; i++) {
    if (!isTrigger(d, i) || i - last < H) continue; last = i;
    const share = count[t[i]] / active[t[i]];
    const g = share < 0.15 ? 'A) isolada (<15% das moedas)' : share < 0.35 ? 'B) parcial (15–35%)' : 'C) pânico geral (35%+)';
    const r = d.c[i + H] / d.c[i] - 1 - COST;
    const per = t[i] < Date.UTC(2023, 0, 1) ? ' [estudo <2023]' : ' [prova 2023+]';
    (groups[g + per] ||= []).push(r);
    (groups[g] ||= []).push(r);
    (groups[btcTrig.has(t[i]) ? 'D) BTC também no gatilho' : 'E) BTC fora do gatilho'] ||= []).push(r);
  }
}
const med = a => [...a].sort((x, y) => x - y)[a.length >> 1];
for (const [g, a] of Object.entries(groups).sort()) {
  const days = new Set(); console.log(`${g.padEnd(32)} n=${String(a.length).padStart(4)} acerto ${(a.filter(x => x > 0).length / a.length * 100).toFixed(1)}%  mediana ${(med(a) * 100).toFixed(1)}%  pior 10% ${([...a].sort((x, y) => x - y)[Math.floor(a.length * .1)] * 100).toFixed(1)}%`);
}
