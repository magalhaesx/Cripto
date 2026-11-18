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
