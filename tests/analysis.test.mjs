import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sma, rsi, analyze, simulate, PARAMS } from '../js/analysis.js';

function series(n, drift, vol, seed = 1) {
  let s = seed, p = 100; const out = [];
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 0; i < n; i++) {
    const o = p; p *= 1 + drift + (rnd() - 0.5) * vol;
    out.push({ t: i * 864e5, o, h: Math.max(o, p) * 1.005, l: Math.min(o, p) * 0.995, c: p, v: 1000 + rnd() * 400 });
  }
  return out;
}

test('sma', () => assert.deepEqual(sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]));

test('rsi: só altas = 100, só quedas = 0', () => {
  assert.equal(rsi([1, 2, 3, 4, 5, 6], 3).at(-1), 100);
  assert.equal(rsi([6, 5, 4, 3, 2, 1], 3).at(-1), 0);
});

test('histórico curto não gera análise', () => {
  assert.equal(analyze(series(100, 0, 0.02)).ok, false);
});

test('pontuação limitada a 0–100 e backtest consistente', () => {
  const a = analyze(series(1000, 0.001, 0.05));
  assert.ok(a.ok);
  assert.ok(a.score >= 0 && a.score <= 100);
  assert.ok(a.bt.signalDays <= a.bt.days);
  assert.ok(['buy', 'watch', 'neutral', 'avoid'].includes(a.verdict));
});

test('compra forte só com regra validada no histórico', () => {
  for (let seed = 1; seed < 40; seed++) {
    const a = analyze(series(1000, 0, 0.06, seed));
    if (a.verdict === 'buy') {
      assert.ok(a.ruleWorks && a.score >= PARAMS.threshold);
      assert.ok(a.bt.winRate >= PARAMS.minWinRate && a.edge >= PARAMS.minEdge);
    }
  }
});

test('mercado em queda constante: tendência negativa', () => {
  const a = analyze(series(1000, -0.003, 0.02));
  assert.equal(a.above200, false);
  assert.notEqual(a.verdict, 'buy');
});

test('simulação usa quantis ordenados', () => {
  const a = analyze(series(1000, 0.002, 0.05, 3));
  const s = simulate(1000, a);
  if (s) assert.ok(s.pessimistic <= s.median && s.median <= s.optimistic && s.probProfit >= 0 && s.probProfit <= 1);
});
