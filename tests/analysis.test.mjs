import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sma, rsi, analyze, simulate, computeIndicators, isTrigger, PARAMS } from '../js/analysis.js';
import { STUDY } from '../js/study.js';

function series(n, drift, vol, seed = 1) {
  let s = seed, p = 100; const out = [];
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 0; i < n; i++) {
    const o = p; p *= 1 + drift + (rnd() - 0.5) * vol;
    out.push({ t: i * 864e5, o, h: Math.max(o, p) * 1.005, l: Math.min(o, p) * 0.995, c: p, v: 1000 + rnd() * 400 });
  }
  return out;
}
// série estável que termina com queda de ~35% em 10 dias (pânico)
function crash() {
  const s = series(400, 0.001, 0.02, 5);
  let p = s.at(-1).c;
  for (let k = 0; k < 10; k++) { const o = p; p *= 0.955; s.push({ t: s.at(-1).t + 864e5, o, h: o, l: p, c: p, v: 3000 }); }
  return s;
}

test('sma', () => assert.deepEqual(sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]));
test('rsi: só altas = 100, só quedas = 0', () => {
  assert.equal(rsi([1, 2, 3, 4, 5, 6], 3).at(-1), 100);
  assert.equal(rsi([6, 5, 4, 3, 2, 1], 3).at(-1), 0);
});
test('histórico curto não gera análise', () => assert.equal(analyze(series(40, 0, 0.02)).ok, false));

test('gatilho dispara após queda forte com RSI baixo', () => {
  const s = crash(); const d = computeIndicators(s);
  assert.ok(isTrigger(d, s.length - 1));
  const a = analyze(s, PARAMS, STUDY);
  assert.ok(a.trigger);
  assert.ok(['buy', 'watch'].includes(a.verdict));
  assert.equal(a.score, 100);
});

test('mercado calmo em alta não dispara', () => {
  const a = analyze(series(600, 0.002, 0.01), PARAMS, STUDY);
  assert.equal(a.trigger, false);
  assert.notEqual(a.verdict, 'buy');
});

test('simulação cai para o estudo quando a moeda tem poucos casos', () => {
  const a = analyze(series(600, 0.002, 0.01), PARAMS, STUDY);
  const s = simulate(1000, a);
  assert.equal(s.source, 'study');
  assert.ok(s.pessimistic <= s.median && s.median <= s.optimistic);
});

test('estudo embutido tem vantagem sobre um dia qualquer', () => {
  assert.ok(STUDY.events > 300 && STUDY.winRate > STUDY.baseWinRate);
});

import { firstHit, compactPos, expandPos } from '../js/positions.js';
test('saída: detecta o que foi tocado primeiro', () => {
  const pos = { at: 0, entry: 100, stop: 90, target: 110 };
  const k = (t, l, h) => ({ t, l, h, c: (l + h) / 2 });
  assert.equal(firstHit(pos, [k(0, 95, 105), k(36e5, 97, 111), k(72e5, 85, 100)]).type, 'target');
  assert.equal(firstHit(pos, [k(0, 95, 105), k(36e5, 89, 104)]).type, 'stop');
  assert.equal(firstHit(pos, [k(0, 89, 111)]).type, 'stop');          // mesma vela: conservador
  assert.equal(firstHit(pos, [k(0, 95, 105)]), null);
  assert.equal(firstHit({ ...pos, at: 72e5 }, [k(0, 50, 200), k(72e5, 95, 105)]), null); // antes da compra não conta
});
test('posição compacta ida e volta', () => {
  const p = { id: 'x', sym: 'BTC', entry: 100, stop: 90, target: 110, at: 1, exp: 2 };
  assert.deepEqual(expandPos(compactPos(p)), p);
});

import { alertHit, compactAlert, expandAlert } from '../js/alerts.js';
test('alerta de preço: acima e abaixo', () => {
  const k = (t, l, h) => ({ t, l, h, c: h });
  const up = { id: 'a', sym: 'BTC', price: 110, dir: 'above', at: 0 };
  const dn = { ...up, price: 90, dir: 'below' };
  assert.ok(alertHit(up, [k(0, 95, 105), k(36e5, 100, 111)]));
  assert.equal(alertHit(up, [k(0, 80, 105)]), null);
  assert.ok(alertHit(dn, [k(0, 89, 105)]));
  assert.equal(alertHit({ ...dn, at: 72e5 }, [k(0, 50, 100), k(72e5, 95, 100)]), null);
  assert.deepEqual(expandAlert(compactAlert(up)), up);
});

import { marketRegime } from '../js/analysis.js';
test('clima: alta, correção e baixa longa', () => {
  const mk = f => Array.from({ length: 400 }, (_, i) => ({ t: i * 864e5, c: f(i) }));
  assert.equal(marketRegime(mk(i => 100 + i)).state, 'bull');
  assert.equal(marketRegime(mk(i => i < 390 ? 100 + i : 200)).state, 'correction');   // caiu abaixo da MM200, que ainda sobe
  assert.equal(marketRegime(mk(i => 500 - i)).state, 'bear');
  assert.equal(marketRegime(mk(i => 100).slice(0, 100)), null);
});

import { evaluateOutcome } from '../js/analysis.js';
test('resultado de um alerta: alvo, stop e prazo', () => {
  const k = (h, l, c) => ({ t: 0, o: c, h, l, c, v: 1 });
  const cs = [k(100, 100, 100), k(101, 99, 100), k(115, 99, 112), k(112, 110, 111)];
  const ind = { c: cs.map(x => x.c), atrPct: [0.05, 0.05, 0.05, 0.05] };
  const r = evaluateOutcome(ind, cs, 0, { horizon: 3, costPct: 0 });
  assert.equal(r.exit, 'target'); assert.ok(Math.abs(r.retST - 0.10) < 1e-9);
  const cs2 = [k(100, 100, 100), k(100, 85, 88)];
  const r2 = evaluateOutcome({ c: [100, 88], atrPct: [0.05, 0.05] }, cs2, 0, { horizon: 3, costPct: 0 });
  assert.equal(r2.exit, 'stop'); assert.equal(r2.done, false);
});
