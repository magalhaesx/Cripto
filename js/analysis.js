// =============================================================================
// Motor de análise — usado tanto pelo app (navegador) quanto pelo robô de
// notificações (GitHub Actions / Node). Funções puras, sem dependências.
//
// Ideia central: NÃO confiar em "achismo". Cada moeda recebe uma pontuação
// (0–100) feita de fatores com respaldo na literatura (tendência, momentum,
// reversão de curto prazo, volume e volatilidade). Em seguida a MESMA regra é
// testada no histórico daquela moeda (backtest): só existe alerta de compra se,
// no passado, os dias com pontuação parecida tiveram taxa de acerto e retorno
// mediano superiores aos de um dia qualquer, com amostra mínima.
// Detalhes e referências: METODOLOGIA.md
// =============================================================================

export const PARAMS = {
  horizon: 14,        // dias à frente usados para medir "deu lucro?"
  threshold: 65,      // pontuação mínima para um sinal de compra
  minSignalDays: 20,  // nº mínimo de dias-sinal no histórico
  minEvents: 5,       // nº mínimo de episódios independentes (separados por >= horizon)
  minWinRate: 0.55,   // taxa de acerto mínima
  minEdge: 0.03,      // vantagem mínima sobre um dia aleatório (3 p.p.)
  costPct: 0.002,     // custo ida+volta (taxas/spread) = 0,2%
  warmup: 210,        // candles necessários antes de começar a pontuar
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

  return { c, v, sma20, sma50, sma200, std20, macd, macdSig, hist, rsi14, atr, atrPct, obv, vol5, vol50, high365 };
}

// mediana móvel do ATR% (último ano) — calculada sob demanda
function atrMedianAt(ind, i) {
  const from = Math.max(0, i - 364);
  const arr = [];
  for (let j = from; j <= i; j++) if (ind.atrPct[j] != null) arr.push(ind.atrPct[j]);
  return median(arr);
}

const br = (x, d = 1) => x.toFixed(d).replace('.', ',');

// ---------- pontuação de um dia ---------------------------------------------
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

// ---------- backtest da regra na própria moeda --------------------------------
export function backtest(candles, ind, P = PARAMS) {
  const n = candles.length;
  const H = P.horizon;
  const scores = new Array(n).fill(null);
  for (let i = P.warmup; i < n; i++) scores[i] = scoreAt(ind, i).score;

  const sig = [], base = [];
  let lastEvent = -Infinity, events = 0, eventWins = 0;
  const onsets = [];
  for (let i = P.warmup; i < n; i++) {
    const isSig = scores[i] >= P.threshold;
    if (isSig && (scores[i - 1] == null || scores[i - 1] < P.threshold)) onsets.push(i);
    if (i + H >= n) continue;
    const fwd = ind.c[i + H] / ind.c[i] - 1 - P.costPct;
    base.push(fwd);
    if (isSig) {
      sig.push(fwd);
      if (i - lastEvent >= H) { events++; if (fwd > 0) eventWins++; lastEvent = i; }
    }
  }
  const win = a => (a.length ? a.filter(x => x > 0).length / a.length : null);
  const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const sortedSig = [...sig].sort((a, b) => a - b);
  const winRate = win(sig), baseWin = win(base);

  // teste binomial (unilateral) usando apenas episódios independentes — conservador
  let pValue = null;
  if (events > 0 && baseWin > 0 && baseWin < 1) {
    const p = eventWins / events;
    const zb = (p - baseWin) / Math.sqrt(baseWin * (1 - baseWin) / events);
    pValue = 1 - normCdf(zb);
  }

  return {
    scores, onsets,
    horizon: H,
    days: n,
    signalDays: sig.length,
    events,
    eventWinRate: events ? eventWins / events : null,
    winRate, baseWinRate: baseWin,
    meanRet: mean(sig), baseMeanRet: mean(base),
    medianRet: median(sig), baseMedianRet: median(base),
    p10: quantile(sortedSig, 0.10), p25: quantile(sortedSig, 0.25),
    p75: quantile(sortedSig, 0.75), p90: quantile(sortedSig, 0.90),
    worst: sortedSig[0] ?? null, best: sortedSig[sortedSig.length - 1] ?? null,
    distribution: sortedSig,
    pValue,
  };
}

// ---------- análise completa --------------------------------------------------
export function analyze(candles, P = PARAMS) {
  if (!candles || candles.length < P.warmup + P.horizon + 30) {
    return { ok: false, reason: 'Histórico insuficiente para análise estatística (moeda recente).' };
  }
  const ind = computeIndicators(candles);
  const i = candles.length - 1;
  const now = scoreAt(ind, i);
  const bt = backtest(candles, ind, P);

  const statsOk = bt.signalDays >= P.minSignalDays && bt.events >= P.minEvents;
  const edge = bt.winRate != null && bt.baseWinRate != null ? bt.winRate - bt.baseWinRate : null;
  const ruleWorks = statsOk && bt.winRate >= P.minWinRate && edge >= P.minEdge && bt.medianRet > 0;

  let verdict;
  if (now.score >= P.threshold && ruleWorks && (now.rsi ?? 50) < 72) verdict = 'buy';
  else if (now.score >= P.threshold - 10) verdict = 'watch';
  else if (now.score < 35 || (now.rsi ?? 50) > 75) verdict = 'avoid';
  else verdict = 'neutral';

  // gestão de risco baseada em ATR
  const price = ind.c[i];
  const atr = ind.atr[i] ?? price * 0.04;
  const stop = price - 2 * atr;
  const target = price + 3 * atr;

  const fmtP = x => `${(x * 100).toFixed(0)}%`;
  const fmtR = x => `${x >= 0 ? '+' : ''}${br(x * 100)}%`;
  const reasons = now.parts.filter(p => p.ok && p.pts > 0).sort((a, b) => b.pts - a.pts).slice(0, 4).map(p => p.text);
  const warnings = now.parts.filter(p => !p.ok && p.max >= 6).sort((a, b) => b.max - a.max).slice(0, 3).map(p => p.text);

  let statsText;
  if (!statsOk) statsText = `Poucos casos parecidos no histórico (${bt.events} episódios) — a estatística ainda não é confiável para esta moeda.`;
  else statsText = `Nos últimos ${br(candles.length / 365)} anos, em ${bt.events} episódios com sinal parecido, ` +
    `a moeda estava mais alta ${P.horizon} dias depois em ${fmtP(bt.winRate)} dos dias-sinal ` +
    `(mediana ${fmtR(bt.medianRet)}), contra ${fmtP(bt.baseWinRate)} em um dia qualquer (mediana ${fmtR(bt.baseMedianRet)}).`;

  let summary;
  if (verdict === 'buy') summary = `Boa oportunidade: ${reasons.slice(0, 2).join('; ').toLowerCase()}. ${statsText}`;
  else if (verdict === 'watch') summary = now.score >= P.threshold
    ? `Pontuação alta (${now.score}/100), mas ${!ruleWorks ? 'o histórico desta moeda ainda não comprova vantagem estatística suficiente — por isso não há alerta.' : 'o RSI indica euforia; melhor esperar uma correção.'}`
    : `Quase lá: pontuação ${now.score}/100 (alerta a partir de ${P.threshold}). Fique de olho.`;
  else if (verdict === 'avoid') summary = `Evitar agora: ${warnings.slice(0, 2).join('; ').toLowerCase()}.`;
  else summary = `Sem vantagem clara no momento (pontuação ${now.score}/100).`;

  return {
    ok: true, score: now.score, verdict, parts: now.parts, reasons, warnings, summary, statsText,
    rsi: now.rsi, z: now.z, atrPct: now.atrPct, dd: now.dd, ret90: now.ret90, above200: now.above200,
    price, stop, target, edge, ruleWorks, statsOk, bt,
    signalTimes: bt.onsets.map(k => candles[k].t),
    scoreSeries: bt.scores,
  };
}

// ---------- simulação de compra --------------------------------------------
// Usa a distribuição EMPÍRICA dos retornos após sinais (não um palpite).
export function simulate(amount, analysis) {
  const bt = analysis?.bt;
  const dist = bt?.distribution?.length >= 10 ? bt.distribution : null;
  if (!dist) return null;
  const q = p => amount * (1 + quantile(dist, p));
  return {
    amount,
    horizon: bt.horizon,
    pessimistic: q(0.10),
    low: q(0.25),
    median: q(0.5),
    high: q(0.75),
    optimistic: q(0.90),
    probProfit: dist.filter(x => x > 0).length / dist.length,
    expected: amount * (1 + dist.reduce((s, x) => s + x, 0) / dist.length),
    dist,
  };
}
