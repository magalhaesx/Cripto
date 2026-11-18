// =============================================================================
// Motor de análise — usado tanto pelo app (navegador) quanto pelo robô de
// notificações (GitHub Actions / Node). Funções puras, sem dependências.
//
// ESTRATÉGIA (v2, escolhida por estudo com 30 moedas e histórico desde 2017 —
// ver research/ e METODOLOGIA.md): "REPIQUE APÓS QUEDA FORTE".
//   Gatilho: preço 25%+ abaixo da máxima dos últimos 30 dias  E  RSI(14) < 30.
//   Horizonte: 7 dias. Nível "forte" quando RSI(14) < 25.
// Foi a única abordagem, entre ~15 testadas, com vantagem nos dois períodos
// (antes e depois de 2023), em todas as variações de parâmetros e com
// estatística robusta mesmo agrupando sinais da mesma semana.
// =============================================================================

export const PARAMS = {
  horizon: 7,         // dias à frente usados para medir "deu lucro?"
  dropPct: -0.25,     // queda mínima em relação à máxima de 30 dias
  rsiMax: 30,         // RSI(14) abaixo disto
  rsiStrong: 25,      // RSI(14) abaixo disto = sinal forte
  minBreadth: 0.15,
  regimeSlopeDays: 30, // inclinação da MM200 do BTC medida em 30 dias (testado de 10 a 90: mesmo resultado)   // alerta só se >= 15% das moedas estiverem no gatilho juntas (pânico de mercado)
  minCoinWin: 0.45,   // se a própria moeda tiver >=5 casos e acerto abaixo disto, rebaixa para "observar"
  costPct: 0.002,     // custo ida+volta (taxas/spread) = 0,2%
  warmup: 210,        // candles necessários para os indicadores de contexto (MM200)
};

// ---------- indicadores básicos ----------------------------------------------
export function sma(arr, n) {
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= n) sum -= arr[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(arr, n) {
  const out = new Array(arr.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < arr.length; i++) {
    if (i < n - 1) continue;
    if (prev === null) {
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += arr[j];
      prev = s / n;
    } else prev = arr[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function rsi(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= n) {
      gain += g; loss += l;
      if (i === n) { gain /= n; loss /= n; out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss); }
    } else {
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + l) / n;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  return out;
}

function rollingStd(arr, n, means) {
  const out = new Array(arr.length).fill(null);
  for (let i = n - 1; i < arr.length; i++) {
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (arr[j] - means[i]) ** 2;
    out[i] = Math.sqrt(s / n);
  }
  return out;
}

function rollingMax(arr, n) {
  const out = new Array(arr.length).fill(null);
  for (let i = 0; i < arr.length; i++) {
    let m = -Infinity;
    for (let j = Math.max(0, i - n + 1); j <= i; j++) if (arr[j] > m) m = arr[j];
    out[i] = m;
  }
  return out;
}

function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// Aproximação da CDF normal (Abramowitz–Stegun) para p-valor.
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

// ---------- todos os indicadores de uma série diária --------------------------
// candles: [{t, o, h, l, c, v}] em ordem cronológica (diário)
export function computeIndicators(candles) {
  const c = candles.map(k => k.c);
  const v = candles.map(k => k.v);
  const n = c.length;

  const sma20 = sma(c, 20), sma50 = sma(c, 50), sma200 = sma(c, 200);
  const std20 = rollingStd(c, 20, sma20);
  const ema12 = ema(c, 12), ema26 = ema(c, 26);
  const macd = c.map((_, i) => (ema12[i] != null && ema26[i] != null ? ema12[i] - ema26[i] : null));
  const macdFirst = macd.findIndex(x => x != null);
  const sigRaw = ema(macd.slice(macdFirst), 9);
  const macdSig = new Array(n).fill(null);
  sigRaw.forEach((x, j) => { macdSig[macdFirst + j] = x; });
  const hist = macd.map((m, i) => (m != null && macdSig[i] != null ? m - macdSig[i] : null));
  const rsi14 = rsi(c, 14);

  // ATR(14) em % do preço
  const tr = candles.map((k, i) => i === 0 ? k.h - k.l
    : Math.max(k.h - k.l, Math.abs(k.h - candles[i - 1].c), Math.abs(k.l - candles[i - 1].c)));
  const atr = sma(tr, 14);
  const atrPct = atr.map((a, i) => (a != null ? a / c[i] : null));

  // OBV (On-Balance Volume)
  const obv = new Array(n).fill(0);
  for (let i = 1; i < n; i++) obv[i] = obv[i - 1] + (c[i] > c[i - 1] ? v[i] : c[i] < c[i - 1] ? -v[i] : 0);

  const vol5 = sma(v, 5), vol50 = sma(v, 50);
  const high365 = rollingMax(c, 365);
  const high30 = rollingMax(c, 30);

  return { c, v, sma20, sma50, sma200, std20, macd, macdSig, hist, rsi14, atr, atrPct, obv, vol5, vol50, high365, high30 };
}

// mediana móvel do ATR% (último ano) — calculada sob demanda
function atrMedianAt(ind, i) {
  const from = Math.max(0, i - 364);
  const arr = [];
  for (let j = from; j <= i; j++) if (ind.atrPct[j] != null) arr.push(ind.atrPct[j]);
  return median(arr);
}

const br = (x, d = 1) => x.toFixed(d).replace('.', ',');

// ---------- REGRA ANTIGA (v1) — mantida só para comparação nos estudos ----------
// Não é mais usada para alertas: no período 2023+ teve acerto ABAIXO de um dia qualquer.
// Retorna {score, parts}. parts traz cada fator, pontos e texto explicativo.
export function scoreAt(ind, i, opts = {}) {
  const { c, sma20, sma50, sma200, std20, macd, macdSig, hist, rsi14, atrPct, obv, vol5, vol50, high365 } = ind;
  const parts = [];
  const add = (group, key, pts, max, ok, text) => parts.push({ group, key, pts, max, ok, text });
  const price = c[i];

  // 1) TENDÊNCIA (30) — time-series momentum / filtro de tendência
  const above200 = sma200[i] != null && price > sma200[i];
  add('Tendência', 'above200', above200 ? 12 : 0, 12, above200,
    above200 ? 'Preço acima da média de 200 dias (tendência de alta de longo prazo)'
             : 'Preço abaixo da média de 200 dias (tendência de baixa de longo prazo)');
  const golden = sma50[i] != null && sma200[i] != null && sma50[i] > sma200[i];
  add('Tendência', 'golden', golden ? 10 : 0, 10, golden,
    golden ? 'Média de 50 dias acima da de 200 ("cruz dourada")' : 'Média de 50 dias abaixo da de 200');
  const slope200 = sma200[i] != null && sma200[i - 20] != null ? sma200[i] / sma200[i - 20] - 1 : 0;
  add('Tendência', 'slope', slope200 > 0 ? 8 : 0, 8, slope200 > 0,
    slope200 > 0 ? 'Média de 200 dias inclinada para cima' : 'Média de 200 dias inclinada para baixo');

  // 2) MOMENTUM (20)
  const ret90 = i >= 90 ? price / c[i - 90] - 1 : 0;
  add('Momentum', 'ret90', ret90 > 0 ? 6 : 0, 6, ret90 > 0,
    `Retorno de 90 dias de ${br(ret90 * 100)}%` + (ret90 > 0 ? ' (momentum positivo)' : ' (momentum negativo)'));
  const histUp = hist[i] != null && hist[i - 3] != null && hist[i] > hist[i - 3];
  add('Momentum', 'histUp', histUp ? 8 : 0, 8, histUp,
    histUp ? 'MACD ganhando força nos últimos dias' : 'MACD perdendo força');
  const macdBull = macd[i] != null && macdSig[i] != null && macd[i] > macdSig[i];
  add('Momentum', 'macd', macdBull ? 6 : 0, 6, macdBull,
    macdBull ? 'MACD acima da linha de sinal' : 'MACD abaixo da linha de sinal');

  // 3) PONTO DE ENTRADA (25) — reversão de curto prazo dentro da tendência
  const r = rsi14[i];
  let rPts = 0, rText;
  if (r == null) rText = 'RSI indisponível';
  else if (r < 30) { rPts = above200 ? 12 : 4; rText = `RSI ${r.toFixed(0)}: sobrevendido` + (above200 ? ' dentro de tendência de alta (desconto)' : ' (mas tendência de baixa — cuidado)'); }
  else if (r <= 50) { rPts = 12; rText = `RSI ${r.toFixed(0)}: correção saudável, sem euforia`; }
  else if (r <= 60) { rPts = 6; rText = `RSI ${r.toFixed(0)}: neutro`; }
  else if (r <= 70) { rPts = 2; rText = `RSI ${r.toFixed(0)}: aquecido`; }
  else { rPts = -10; rText = `RSI ${r.toFixed(0)}: sobrecomprado (risco de correção)`; }
  add('Entrada', 'rsi', rPts, 12, rPts >= 12, rText);

  const z = std20[i] ? (price - sma20[i]) / std20[i] : 0;
  let zPts = 0, zText;
  if (z >= -2.2 && z <= -0.3) { zPts = 13; zText = `Preço ${br(Math.abs(z))} desvios abaixo da média de 20 dias (abaixo do "preço justo" de curto prazo)`; }
  else if (z > -0.3 && z <= 0.5) { zPts = 6; zText = 'Preço próximo da média de 20 dias'; }
  else if (z < -2.2) { zPts = 3; zText = 'Queda brusca e anormal (possível "faca caindo")'; }
  else { zPts = 0; zText = `Preço ${br(z)} desvios acima da média de 20 dias (esticado)`; }
  add('Entrada', 'z', zPts, 13, zPts >= 13, zText);

  // 4) VOLUME (13) — atenção/fluxo
  const volUp = vol5[i] != null && vol50[i] != null && vol5[i] >= vol50[i];
  add('Volume', 'vol', volUp ? 6 : 0, 6, volUp,
    volUp ? 'Volume recente acima da média de 50 dias (interesse crescente)' : 'Volume recente abaixo da média');
  const obvUp = i >= 20 && obv[i] > obv[i - 20];
  add('Volume', 'obv', obvUp ? 7 : 0, 7, obvUp,
    obvUp ? 'OBV subindo: volume comprador dominando (acumulação)' : 'OBV caindo: volume vendedor dominando');

  // 5) RISCO (12)
  const atrMed = opts.atrMedian ?? atrMedianAt(ind, i);
  const calm = atrPct[i] != null && atrMed != null && atrPct[i] <= atrMed * 1.1;
  add('Risco', 'atr', calm ? 7 : 0, 7, calm,
    calm ? 'Volatilidade controlada (abaixo da mediana do ano)' : 'Volatilidade acima do normal');
  const dd = high365[i] ? price / high365[i] - 1 : 0;
  const notCrashed = dd > -0.6;
  add('Risco', 'dd', notCrashed ? 5 : 0, 5, notCrashed,
    `${(dd * 100).toFixed(0)}% abaixo da máxima de 12 meses` + (notCrashed ? '' : ' (colapso — risco alto)'));

  const score = Math.max(0, Math.min(100, parts.reduce((s, p) => s + p.pts, 0)));
  return { score, parts, rsi: r, z, atrPct: atrPct[i], dd, ret90, above200 };
}

// ---------- gatilho da estratégia -------------------------------------------
// Retorna false, 'normal' ou 'strong'
export function isTrigger(ind, i, P = PARAMS) {
  const r = ind.rsi14[i], hi = ind.high30[i];
  if (r == null || !hi) return false;
  if (ind.c[i] / hi - 1 > P.dropPct || r >= P.rsiMax) return false;
  return r < P.rsiStrong ? 'strong' : 'normal';
}

// Proximidade do gatilho (0–100). 100 = gatilho disparado.
// Metade pela queda (0% → 0 pts, -25% → 50 pts) e metade pelo RSI (60 → 0 pts, 30 → 50 pts).
export function proximity(ind, i, P = PARAMS) {
  const dd = ind.c[i] / ind.high30[i] - 1;
  const r = ind.rsi14[i] ?? 50;
  const a = Math.max(0, Math.min(1, dd / P.dropPct)) * 50;
  const b = Math.max(0, Math.min(1, (60 - r) / (60 - P.rsiMax))) * 50;
  return Math.round(a + b);
}

// ---------- backtest da regra na própria moeda --------------------------------
export function backtest(candles, ind, P = PARAMS) {
  const n = candles.length, H = P.horizon;
  const sig = [], base = [], onsets = [];
  let last = -Infinity, prev = false;
  for (let i = 30; i < n; i++) {
    const g = isTrigger(ind, i, P);
    if (g && !prev) onsets.push(i);
    prev = !!g;
    if (i + H >= n) continue;
    const fwd = ind.c[i + H] / ind.c[i] - 1 - P.costPct;
    base.push(fwd);
    if (g && i - last >= H) { sig.push(fwd); last = i; }   // episódios independentes
  }
  const win = a => (a.length ? a.filter(x => x > 0).length / a.length : null);
  const sorted = [...sig].sort((a, b) => a - b);
  return {
    onsets, horizon: H, days: n,
    events: sig.length, signalDays: sig.length,
    winRate: win(sig), baseWinRate: win(base),
    medianRet: median(sig), baseMedianRet: median(base),
    meanRet: sig.length ? sig.reduce((a, b) => a + b, 0) / sig.length : null,
    p10: quantile(sorted, 0.1), p90: quantile(sorted, 0.9),
    distribution: sorted,
  };
}

// ---------- análise completa --------------------------------------------------
// study: estatística agregada (js/study.js). Opcional — sem ela a análise usa só a moeda.
export function analyze(candles, P = PARAMS, study = null) {
  if (!candles || candles.length < 60) {
    return { ok: false, reason: 'Histórico insuficiente para análise (moeda muito recente).' };
  }
  const ind = computeIndicators(candles);
  const i = candles.length - 1;
  const bt = backtest(candles, ind, P);
  const trig = isTrigger(ind, i, P);
  const score = proximity(ind, i, P);
  const price = ind.c[i];
  const rsiNow = ind.rsi14[i];
  const dd30 = price / ind.high30[i] - 1;
  const above200 = ind.sma200[i] != null ? price > ind.sma200[i] : null;

  const coinWeak = bt.events >= 5 && bt.winRate < P.minCoinWin;
  let verdict;
  if (trig && !coinWeak) verdict = 'buy';
  else if (trig || score >= 70) verdict = 'watch';
  else if ((rsiNow ?? 50) > 70) verdict = 'avoid';
  else verdict = 'neutral';

  const pc = x => `${Math.round(x * 100)}%`;
  const br1 = x => `${x >= 0 ? '+' : ''}${br(x * 100)}%`;
  const parts = [
    { group: 'Gatilho', key: 'drop', ok: dd30 <= P.dropPct, pts: Math.round(Math.max(0, Math.min(1, dd30 / P.dropPct)) * 50), max: 50,
      text: `Queda de ${br(Math.abs(dd30) * 100)}% desde a máxima de 30 dias (gatilho: 25% ou mais)` },
    { group: 'Gatilho', key: 'rsi', ok: rsiNow != null && rsiNow < P.rsiMax, pts: Math.round(Math.max(0, Math.min(1, (60 - (rsiNow ?? 50)) / (60 - P.rsiMax))) * 50), max: 50,
      text: `RSI ${rsiNow != null ? rsiNow.toFixed(0) : '—'} (gatilho: abaixo de 30${rsiNow != null && rsiNow < P.rsiStrong ? '; abaixo de 25 = sinal forte' : ''})` },
    { group: 'Contexto', key: 'trend', ok: !!above200, pts: 0, max: 0,
      text: above200 == null ? 'Média de 200 dias indisponível' : above200 ? 'Acima da média de 200 dias (tendência longa de alta)' : 'Abaixo da média de 200 dias (tendência longa de baixa)' },
  ];

  const reasons = [], warnings = [];
  if (trig) {
    reasons.push(`Caiu ${br(Math.abs(dd30) * 100)}% em relação à máxima de 30 dias — pânico de curto prazo`);
    reasons.push(`RSI ${rsiNow.toFixed(0)}: ${trig === 'strong' ? 'sobrevenda extrema' : 'sobrevendido'}, vendedores esgotados`);
    if (study) reasons.push(`No estudo com ${study.coins} moedas (${study.events} casos desde ${study.from.slice(0, 4)}), ${trig === 'strong' ? pc(study.strongWinRate) : pc(study.winRate)} subiram em ${P.horizon} dias, contra ${pc(study.baseWinRate)} num dia qualquer`);
  } else {
    if (dd30 > P.dropPct) warnings.push(`Queda de só ${br(Math.abs(dd30) * 100)}% da máxima de 30 dias (gatilho: 25%)`);
    if (rsiNow != null && rsiNow >= P.rsiMax) warnings.push(`RSI ${rsiNow.toFixed(0)}: ainda não está sobrevendido (gatilho: < 30)`);
  }
  if (coinWeak) warnings.push(`Nesta moeda o padrão funcionou pouco: ${pc(bt.winRate)} de acerto em ${bt.events} casos`);
  if (above200 === false && trig) warnings.push('Tendência longa de baixa: é uma operação curta de repique, não de longo prazo');

  const statsText = bt.events
    ? `Nesta moeda (últimos ${br(candles.length / 365)} anos), o gatilho disparou ${bt.events} vezes e o preço estava mais alto ${P.horizon} dias depois em ${pc(bt.winRate)} delas (mediana ${br1(bt.medianRet)}), contra ${pc(bt.baseWinRate)} num dia qualquer.`
    : `O gatilho ainda não disparou nesta moeda nos últimos ${br(candles.length / 365)} anos; a simulação usa o estudo com todas as moedas.`;

  let summary;
  if (verdict === 'buy') summary = `Oportunidade de repique${trig === 'strong' ? ' FORTE' : ''}: ${reasons[0].toLowerCase()} e RSI ${rsiNow.toFixed(0)}. Estratégia de curto prazo: comprar agora e reavaliar em ~${P.horizon} dias.`;
  else if (verdict === 'watch' && trig) summary = 'O gatilho disparou, mas nesta moeda o padrão teve acerto baixo no passado. Alerta rebaixado para "observar".';
  else if (verdict === 'watch') summary = `Perto do gatilho (${score}/100): ${warnings.join('; ').toLowerCase()}.`;
  else if (verdict === 'avoid') summary = `Evitar agora: RSI ${rsiNow.toFixed(0)} indica euforia — preço esticado.`;
  else summary = `Sem oportunidade no momento (${score}/100 do caminho até o gatilho).`;

  const atr = ind.atr[i] ?? price * 0.05;
  return {
    ok: true, score, verdict, trigger: trig, parts, reasons, warnings, summary, statsText,
    rsi: rsiNow, dd30, atrPct: ind.atrPct[i], above200, price,
    stop: price - 2 * atr, target: price + 2 * atr,
    ruleWorks: !coinWeak, statsOk: true, edge: bt.winRate != null ? bt.winRate - bt.baseWinRate : null,
    bt, study, signalTimes: bt.onsets.map(k => candles[k].t),
  };
}

// ---------- contexto de mercado ----------------------------------------------
// Queda ISOLADA de uma moeda (provável notícia ruim própria) teve repique inconsistente;
// pânico GERAL (várias moedas no gatilho ao mesmo tempo) teve vantagem nos dois períodos.
// Recebe {sym: análise} de todas as moedas e ajusta o veredito de cada uma.
// ---------- clima do mercado (tendência do Bitcoin) ----------------------------
// 'bear'       = BTC abaixo da MM200 e MM200 caindo  → baixa longa (repique sem vantagem: ~49%)
// 'correction' = BTC abaixo da MM200, MM200 subindo  → correção dentro de alta (melhor clima: ~78%)
// 'bull'       = BTC acima da MM200                   → alta
export function marketRegime(btcCandles, P = PARAMS) {
  if (!btcCandles || btcCandles.length < 200 + P.regimeSlopeDays) return null;
  const c = btcCandles.map(k => k.c), ma = sma(c, 200), i = c.length - 1;
  const slope = ma[i] / ma[i - P.regimeSlopeDays] - 1;
  const state = c[i] > ma[i] ? 'bull' : slope < 0 ? 'bear' : 'correction';
  return { state, price: c[i], ma200: ma[i], dist: c[i] / ma[i] - 1, slope };
}

export function applyBreadth(analyses, P = PARAMS, study = null, regime = null) {
  const list = Object.values(analyses).filter(a => a?.ok);
  const trig = list.filter(a => a.trigger).length;
  const share = list.length ? trig / list.length : 0;
  for (const a of list) {
    // idempotente: sempre parte do resultado original da análise
    a._base ||= { verdict: a.verdict, summary: a.summary, reasons: [...a.reasons], warnings: [...a.warnings] };
    Object.assign(a, { verdict: a._base.verdict, summary: a._base.summary, reasons: [...a._base.reasons], warnings: [...a._base.warnings] });
    a.breadth = { triggered: trig, total: list.length, share };
    if (!a.trigger) continue;
    if (share < P.minBreadth) {
      if (a.verdict === 'buy') a.verdict = 'watch';
      a.warnings.unshift(`Queda isolada (só ${trig} de ${list.length} moedas no gatilho): no histórico recente, quedas isoladas não tiveram repique confiável`);
      a.summary = 'Gatilho disparou, mas é uma queda isolada desta moeda — historicamente pouco confiável. Fica em "observar".';
    } else if (regime?.state === 'bear') {
      if (a.verdict === 'buy') a.verdict = 'watch';
      a.warnings.unshift(`Bitcoin em baixa longa (abaixo da média de 200 dias, que está caindo): nesse clima o repique acertou só ${study?.climate ? Math.round(study.climate.bear.win * 100) : 49}% — sem vantagem`);
      a.summary = 'Gatilho disparou, mas o mercado está em baixa longa — clima em que o repique não teve vantagem no histórico. Fica em "observar".';
    } else {
      if (regime?.state === 'correction') a.reasons.splice(2, 0, `Clima favorável: correção dentro da tendência de alta do Bitcoin${study?.climate ? ` (${Math.round(study.climate.correction.win * 100)}% de acerto nesse clima)` : ''}`);
      a.reasons.splice(2, 0, `Pânico de mercado: ${trig} de ${list.length} moedas no gatilho ao mesmo tempo${study?.breadth ? ` (nesse cenário, ${Math.round(study.breadth.panicWinRate * 100)}% subiram em ${P.horizon} dias)` : ''}`);
    }
  }
  return share;
}

// ---------- simulação de compra --------------------------------------------
// Usa a distribuição EMPÍRICA dos retornos de 7 dias após o gatilho: da própria moeda se tiver
// 10+ casos; senão, a do estudo com todas as moedas.
export function simulate(amount, analysis) {
  const own = analysis?.bt?.distribution;
  const dist = own?.length >= 10 ? own : analysis?.study?.dist;
  if (!dist?.length) return null;
  const q = p => amount * (1 + quantile(dist, p));
  return {
    amount, horizon: analysis.bt.horizon, source: dist === own ? 'coin' : 'study', cases: dist === own ? own.length : analysis.study.events,
    pessimistic: q(0.10), low: q(0.25), median: q(0.5), high: q(0.75), optimistic: q(0.90),
    probProfit: dist === own ? dist.filter(x => x > 0).length / dist.length : analysis.study.winRate,
    expected: amount * (1 + dist.reduce((s, x) => s + x, 0) / dist.length),
    dist,
  };
}
