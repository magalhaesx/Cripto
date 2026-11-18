// "Clima do mercado": o Índice de Medo e Ganância e a tendência do BTC melhoram ou pioram o repique?
// Uso: node research/market-climate.mjs <pasta-com-json> <fng.json (api.alternative.me/fng/?limit=0)>
import { readFileSync, readdirSync } from 'node:fs';
import { computeIndicators, isTrigger, sma, PARAMS } from '../js/analysis.js';
const [dir = 'research/data', fngFile] = process.argv.slice(2);
const H = PARAMS.horizon, COST = PARAMS.costPct, SPLIT = Date.UTC(2023, 0, 1);
const fng = new Map(JSON.parse(readFileSync(fngFile)).data.map(x => [+x.timestamp * 1000, +x.value]));
const all = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => { const cs = JSON.parse(readFileSync(`${dir}/${f}`)); return { sym: f.slice(0, -5), t: cs.map(k => k.t), d: computeIndicators(cs) }; });
const btc = all.find(x => x.sym === 'BTC'); const bi = new Map(btc.t.map((t, i) => [t, i]));
const regime = t => { const i = bi.get(t); if (i == null || btc.d.sma200[i] == null) return null;
  const up = btc.d.c[i] > btc.d.sma200[i], slopeUp = btc.d.sma200[i] > btc.d.sma200[i - 30];
  return up ? 'BTC acima da MM200' : slopeUp ? 'BTC abaixo da MM200 (MM200 ainda subindo)' : 'BTC abaixo da MM200 e MM200 caindo (baixa longa)'; };
const cnt = {}, act = {};
for (const { t, d } of all) for (let i = 30; i < d.c.length; i++) { act[t[i]] = (act[t[i]] || 0) + 1; if (isTrigger(d, i)) cnt[t[i]] = (cnt[t[i]] || 0) + 1; }
const groups = {}; const add = (k, per, r) => { (groups[k] ||= { all: [], is: [], oos: [] }).all.push(r); groups[k][per].push(r); };
const baseAll = { is: [], oos: [] };
for (const { t, d } of all) {
  let last = -1e9;
  for (let i = 30; i + H < d.c.length; i++) {
    const r = d.c[i + H] / d.c[i] - 1 - COST; const per = t[i] < SPLIT ? 'is' : 'oos';
    if (fng.has(t[i])) baseAll[per].push(r);
    if (!isTrigger(d, i) || i - last < H) continue; last = i;
    if (cnt[t[i]] / act[t[i]] < PARAMS.minBreadth) continue;           // só os alertas reais (pânico de mercado)
    add('TODOS os alertas', per, r);
    const f = fng.get(t[i]);
    if (f != null) add(f <= 15 ? 'Medo ≤ 15' : f <= 25 ? 'Medo 16–25' : 'Medo > 25', per, r);
    const g = regime(t[i]); if (g) add(g, per, r);
  }
}
const w = a => a.length ? `${(a.filter(x => x > 0).length / a.length * 100).toFixed(0).padStart(3)}% (n=${String(a.length).padStart(3)})` : '   —        ';
const med = a => a.length ? `${([...a].sort((x, y) => x - y)[a.length >> 1] * 100).toFixed(1)}%` : '—';
console.log(`Base (dia qualquer): estudo ${w(baseAll.is)}  prova ${w(baseAll.oos)}\n`);
console.log('Grupo'.padEnd(50), 'todos'.padEnd(16), 'estudo <2023'.padEnd(16), 'prova 2023+'.padEnd(16), 'mediana');
for (const [k, g] of Object.entries(groups)) console.log(k.padEnd(50), w(g.all).padEnd(16), w(g.is).padEnd(16), w(g.oos).padEnd(16), med(g.all));

// Estratégia isolada: comprar BTC quando o índice está em medo extremo
console.log('\nComprar BTC no medo extremo (sem outro filtro), eventos separados pelo prazo:');
for (const HH of [7, 14, 30]) for (const lim of [10, 15, 20]) {
  const r = { is: [], oos: [] }; let last = -1e9;
  for (let i = 0; i + HH < btc.d.c.length; i++) { const f = fng.get(btc.t[i]); if (f == null || f > lim || i - last < HH) continue; last = i; r[btc.t[i] < SPLIT ? 'is' : 'oos'].push(btc.d.c[i + HH] / btc.d.c[i] - 1 - COST); }
  console.log(`  ${HH}d, índice ≤ ${lim}: estudo ${w(r.is)}  prova ${w(r.oos)}`);
}
