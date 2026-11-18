import { COINS as BASE_COINS, colorFor } from './coins.js';
import { analyze, simulate, applyBreadth, marketRegime, historicalAlerts, PARAMS } from './analysis.js';
import { STUDY } from './study.js';
import { firstHit, compactPos, exitMessage } from './positions.js';
import { alertHit, compactAlert, alertMessage } from './alerts.js';
import { buildDigest } from './summary.js';
import { fetchDaily, fetchKlines, fetchTickers24h, fetchUsdBrl, fetchMarkets, connectLive, fetchAllUsdtSymbols, fetchFearGreed, RANGES } from './api.js';
import { PriceChart, MultiLineChart, drawSpark, drawHistogram, drawScoreRing, drawDonut, drawGauge, drawFngBars, scoreColor } from './chart.js';
import { VAPID_PUBLIC_KEY, ALERT_LOG_URL, REPO } from './config.js';

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// Lista de moedas = padrão + adicionadas pelo usuário
let COINS = [], coinBySym = {};
function buildCoins() {
  const custom = store.get('customCoins', []);
  COINS = [...BASE_COINS, ...custom.filter(c => !BASE_COINS.some(b => b.sym === c.sym))];
  coinBySym = Object.fromEntries(COINS.map(c => [c.sym, c]));
}
buildCoins();

const S = {
  cur: store.get('cur', 'BRL'),
  rate: store.get('rate', null),     // USDT → BRL
  tickers: {}, daily: {}, analysis: {}, markets: {}, spark: {},
  amount: store.get('amount', 1000),
  positions: store.get('positions', []),
  digest: store.get('digest', { on: true, h: 9 }),   // resumo diário
  alerts: store.get('priceAlerts', []),   // alertas de preço manuais
  wallet: store.get('wallet', null),       // { initialUsd, cashUsd, createdAt }
  hourly: {}, walletRange: '7D',
  notified: store.get('notified', {}),
  favs: store.get('favs', []),
  notifyMode: store.get('notifyMode', 'all'),   // 'all' | 'favorites'
  sigFilter: 'all',
  pushCfg: store.get('pushCfg', null),          // config incluída no último código copiado
  view: 'home', detail: null, range: '1A', chart: null, loading: true, error: null,
};

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------------------
// Formatação (pt-BR)
// ---------------------------------------------------------------------------
const conv = usd => (S.cur === 'BRL' && S.rate ? usd * S.rate : usd);
const curSym = () => (S.cur === 'BRL' && S.rate ? 'R$' : 'US$');
function money(usd, { compact = false, sign = false } = {}) {
  if (usd == null || !isFinite(usd)) return '—';
  const v = conv(usd);
  const a = Math.abs(v);
  let s;
  if (compact && a >= 1e6) s = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 2 }).format(a);
  else if (a >= 1) s = a.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  else if (a === 0) s = '0,00';
  else s = a.toLocaleString('pt-BR', { maximumSignificantDigits: 4 });
  return `${sign ? (v >= 0 ? '+' : '−') : v < 0 ? '−' : ''}${curSym()} ${s}`;
}
// valor já na moeda local (não converte)
function moneyLocal(v, sign = false) {
  if (v == null || !isFinite(v)) return '—';
  const s = Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign ? (v >= 0 ? '+' : '−') : v < 0 ? '−' : ''}${curSym()} ${s}`;
}
const pct = (x, d = 2) => (x == null || !isFinite(x) ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d })}%`);
const pct0 = x => (x == null ? '—' : `${Math.round(x * 100)}%`);
const cls = x => (x >= 0 ? 'up' : 'down');
const fmtDate = t => new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
const fmtDateTime = (t, range) => new Date(t).toLocaleString('pt-BR', range === '24H' || range === '7D'
  ? { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: 'short', year: 'numeric' });
const qty = (q, sym) => `${q.toLocaleString('pt-BR', { maximumSignificantDigits: 6 })} ${sym}`;

const VERDICT = {
  buy: { label: 'COMPRAR', title: 'Oportunidade de repique', cls: 'buy' },
  watch: { label: 'OBSERVAR', title: 'Perto do gatilho', cls: 'watch' },
  neutral: { label: 'NEUTRO', title: 'Sem oportunidade agora', cls: 'neutral' },
  avoid: { label: 'EVITAR', title: 'Melhor esperar', cls: 'avoid' },
};

function coinIcon(c, lg = false) {
  const img = S.markets[c.id]?.image;
  const fallback = `https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@0.18.1/svg/color/${c.sym.toLowerCase()}.svg`;
  return `<div class="coin-ic${lg ? ' lg' : ''}" style="background:${c.color}">${c.sym.slice(0, 3)}
    <img src="${img || fallback}" alt="" loading="lazy" onerror="if(!this.dataset.f&&'${img ? 1 : ''}'){this.dataset.f=1;this.src='${fallback}'}else{this.remove()}"></div>`;
}

const price = sym => S.tickers[sym]?.price ?? S.daily[sym]?.at(-1)?.c;

// ---------------------------------------------------------------------------
// Carregamento e análise
// ---------------------------------------------------------------------------
async function loadAll() {
  $('#refreshBtn').classList.add('spin');
  S.error = null;
  const [tick, rate, markets, fng] = await Promise.allSettled([fetchTickers24h(COINS), fetchUsdBrl(), fetchMarkets(COINS), fetchFearGreed()]);
  if (fng.status === 'fulfilled' && fng.value) S.fng = fng.value;
  if (tick.status === 'fulfilled') Object.assign(S.tickers, tick.value);
  if (rate.status === 'fulfilled' && rate.value) { S.rate = rate.value; store.set('rate', S.rate); }
  if (markets.status === 'fulfilled') S.markets = markets.value;

  const results = await Promise.allSettled(COINS.map(async c => {
    const [d, h] = await Promise.all([fetchDaily(c.sym), fetchKlines(c.sym, '1h', 168).catch(() => null)]);
    S.daily[c.sym] = d;
    if (h) { S.spark[c.sym] = h.map(k => k.c); S.hourly[c.sym] = h; }
    S.analysis[c.sym] = analyze(d, PARAMS, STUDY);
  }));
  const failed = results.filter(r => r.status === 'rejected').length;
  S.regime = marketRegime(S.daily.BTC); applyBreadth(S.analysis, PARAMS, STUDY, S.regime);
  S.dailyStamp = Date.now();
  if (failed === COINS.length) S.error = 'Não foi possível baixar os dados de mercado. Verifique a internet e toque em atualizar.';
  S.loading = false;
  $('#refreshBtn').classList.remove('spin');
  renderAll();
  checkAlerts();
}

// Reanalisa com o preço ao vivo (a vela diária atual é atualizada em tempo real)
function reanalyze() {
  for (const c of COINS) {
    const d = S.daily[c.sym], p = S.tickers[c.sym]?.price;
    if (!d?.length || !p) continue;
    const last = d[d.length - 1];
    last.c = p; last.h = Math.max(last.h, p); last.l = Math.min(last.l, p);
    S.analysis[c.sym] = analyze(d, PARAMS, STUDY);
  }
  S.regime = marketRegime(S.daily.BTC); applyBreadth(S.analysis, PARAMS, STUDY, S.regime);
  renderAll(true);
  checkAlerts();
}

function ranked() {
  return COINS.filter(c => S.analysis[c.sym]?.ok)
    .map(c => ({ c, a: S.analysis[c.sym] }))
    .sort((x, y) => (y.a.verdict === 'buy') - (x.a.verdict === 'buy') || y.a.score - x.a.score);
}

// ---------------------------------------------------------------------------
// Alertas (no app). Notificações com o app fechado vêm do robô no GitHub Actions.
// ---------------------------------------------------------------------------
async function checkAlerts() {
  const now = Date.now();
  const fresh = ranked().filter(({ c, a }) => a.verdict === 'buy'
    && (S.notifyMode !== 'favorites' || isFav(c.sym))
    && now - (S.notified[c.sym] || 0) >= 24 * 3600e3);
  if (!fresh.length) return;
  fresh.forEach(({ c }) => { S.notified[c.sym] = now; });
  store.set('notified', S.notified);
  let title, body, url, open;
  if (fresh.length >= 3) {   // várias de uma vez: um aviso só, sem encher a tela
    const strong = fresh.filter(x => x.a.trigger === 'strong').map(x => x.c.sym);
    title = `🟢 Pânico no mercado: ${fresh.length} moedas em oportunidade de repique`;
    body = `${fresh.map(x => x.c.sym).join(', ')}.${strong.length ? ` Sinal forte: ${strong.join(', ')}.` : ''} Historicamente ${pct0(STUDY.alerts?.win ?? STUDY.winRate)} subiram em ${PARAMS.horizon} dias.`;
    url = './'; open = () => switchView('signals');
  } else {
    const { c, a } = fresh[0];
    title = `🟢 ${c.name} (${c.sym}): oportunidade de repique${a.trigger === 'strong' ? ' FORTE' : ''}`;
    body = `${a.reasons[0] || ''}. Historicamente ${pct0(a.trigger === 'strong' ? STUDY.strongWinRate : STUDY.winRate)} subiram em ${PARAMS.horizon} dias.${fresh[1] ? ` Também: ${fresh[1].c.sym}.` : ''}`;
    url = `./?coin=${c.sym}`; open = () => openDetail(c.sym);
  }
  toast(`<b>${esc(title)}</b><br><span class="muted">${esc(body)}</span>`, open);
  if ('Notification' in window && Notification.permission === 'granted') {
    const reg = await navigator.serviceWorker?.getRegistration();
    reg?.showNotification(title, { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'radar-buy', data: { url } });
  }
}

let toastTimer;
function toast(html, onClick) {
  const t = $('#toast');
  t.innerHTML = html; t.classList.add('show');
  t.onclick = () => { t.classList.remove('show'); onClick?.(); };
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 6000);
}

// ---------------------------------------------------------------------------
// Renderização
// ---------------------------------------------------------------------------
function renderAll(soft = false) {
  renderHome(soft); renderSignals(); renderSim(); if (!soft && document.activeElement?.id !== 'coinSearch') renderSettings();
  const n = ranked().filter(x => x.a.verdict === 'buy').length;
  const b = $('#sigBadge'); b.hidden = !n; b.textContent = n;
  if (S.detail) updateDetailLive(true);
}

const isFav = sym => S.favs.includes(sym);
const star = sym => `<span class="star${isFav(sym) ? ' on' : ''}" data-fav="${sym}" role="button" aria-label="Favoritar">${isFav(sym) ? '★' : '☆'}</span>`;
function toggleFav(sym) {
  S.favs = isFav(sym) ? S.favs.filter(x => x !== sym) : [...S.favs, sym];
  store.set('favs', S.favs);
  navigator.vibrate?.(8);
  renderAll(true);
  if (S.detail) { const b = $('#detailFav'); if (b) b.outerHTML = detailStar(S.detail); }
}
const detailStar = sym => `<button class="back fav-btn${isFav(sym) ? ' on' : ''}" id="detailFav" data-fav="${sym}" aria-label="Favoritar">${isFav(sym) ? '★' : '☆'}</button>`;

function coinRow(c) {
  const t = S.tickers[c.sym], a = S.analysis[c.sym];
  const chg = t?.change;
  const v = a?.ok ? VERDICT[a.verdict] : null;
  return `<button class="row" data-open="${c.sym}">
    ${coinIcon(c)}
    <div class="meta">
      <div class="name">${esc(c.name)}${star(c.sym)}</div>
      <div class="sub">${c.sym}${v ? ` <span class="chip ${v.cls}">${a.score}</span>` : ''}</div>
    </div>
    <canvas class="spark" data-spark="${c.sym}"></canvas>
    <div class="right">
      <div class="price num" data-price="${c.sym}">${money(price(c.sym))}</div>
      <div class="chg num ${cls(chg ?? 0)}" data-chg="${c.sym}">${pct(chg)}</div>
    </div>
  </button>`;
}

// ---------------------------------------------------------------------------
// Clima do mercado
// ---------------------------------------------------------------------------
const FNG_LABEL = v => v <= 20 ? 'Medo extremo' : v <= 40 ? 'Medo' : v <= 60 ? 'Neutro' : v <= 80 ? 'Ganância' : 'Ganância extrema';
const FNG_COLOR = v => v <= 20 ? 'var(--down)' : v <= 40 ? 'var(--orange)' : v <= 60 ? 'var(--gold)' : v <= 80 ? '#9BE564' : 'var(--up)';
const REGIME = {
  bull: { icon: '🐂', name: 'Alta', cls: 'buy', txt: 'Bitcoin acima da média de 200 dias.', verdict: 'Neutro para repiques', vcls: 'neutral' },
  correction: { icon: '🔄', name: 'Correção na alta', cls: 'watch', txt: 'Bitcoin abaixo da média de 200 dias, mas ela ainda sobe.', verdict: 'Favorável para repiques', vcls: 'buy' },
  bear: { icon: '🐻', name: 'Baixa longa', cls: 'avoid', txt: 'Bitcoin abaixo da média de 200 dias, que está caindo.', verdict: 'Desfavorável — alertas pausados', vcls: 'avoid' },
};
function climateCard() {
  const g = S.regime, f = S.fng?.at(-1)?.v;
  if (!g && f == null) return '';
  const R0 = g ? REGIME[g.state] : null;
  const list = Object.values(S.analysis).filter(a => a?.ok);
  const trig = list.filter(a => a.trigger).length;
  const above = list.filter(a => a.above200).length;
  const cw = g && STUDY.climate?.[g.state];
  return `<div class="card climate" id="climate">
    <h3>🌡️ Clima do mercado ${R0 ? `<span class="chip ${R0.vcls}">${R0.verdict.toUpperCase()}</span>` : ''}</h3>
    <div class="climate-row">
      <div class="gauge"><canvas id="fngGauge"></canvas>
        <div class="gauge-v"><b class="num" style="color:${f != null ? FNG_COLOR(f) : 'inherit'}">${f ?? '—'}</b><span>${f != null ? FNG_LABEL(f) : 'Medo e Ganância'}</span></div></div>
      <div class="climate-info">
        ${R0 ? `<div class="regime"><span class="regime-ic">${R0.icon}</span><div><b>${R0.name}</b><div class="muted">${R0.txt}</div></div></div>` : ''}
        ${g ? `<div class="muted small">BTC ${pct(g.dist, 1)} da MM200 · MM200 ${g.slope >= 0 ? 'subindo' : 'caindo'} ${pct(g.slope, 1)} em ${PARAMS.regimeSlopeDays}d</div>` : ''}
      </div>
    </div>
    <div class="climate-stats">
      <div class="stat"><div class="k">Moedas em pânico</div><div class="v num ${trig / list.length >= PARAMS.minBreadth ? 'down' : ''}">${trig}<small>/${list.length}</small></div><div class="s">no gatilho de queda</div></div>
      <div class="stat"><div class="k">Acima da MM200</div><div class="v num">${list.length ? pct0(above / list.length) : '—'}</div><div class="s">saúde do mercado</div></div>
      <div class="stat"><div class="k">Repique nesse clima</div><div class="v num ${cw ? (cw.win >= 0.55 ? 'up' : 'down') : ''}">${cw ? pct0(cw.win) : '—'}</div><div class="s">${cw ? `${cw.n} casos` : ''}</div></div>
    </div>
    ${S.fng?.length ? `<div class="fng-hist"><span class="muted small">Medo e Ganância — 30 dias</span><canvas id="fngBars"></canvas></div>` : ''}
    <p class="note" style="margin-bottom:0">${g?.state === 'bear' ? 'Em baixa longa do Bitcoin, quedas fortes costumam continuar: o repique acertou só ' + (STUDY.climate ? pct0(STUDY.climate.bear.win) : '49%') + ' no histórico. Por isso os alertas de compra viram "observar" até o clima mudar.' : g?.state === 'correction' ? 'Melhor clima para a estratégia: quedas fortes dentro de uma tendência de alta do Bitcoin tiveram ' + (STUDY.climate ? pct0(STUDY.climate.correction.win) : '79%') + ' de repique em 7 dias.' : 'O índice de Medo e Ganância é só informativo: no estudo ele não melhorou o acerto dos alertas.'}</p>
  </div>`;
}
function drawClimate() {
  const f = S.fng?.at(-1)?.v;
  drawGauge($('#fngGauge'), f);
  drawFngBars($('#fngBars'), S.fng);
}

function renderHome(soft) {
  const el = $('#view-home');
  if (S.loading) {
    el.innerHTML = `<div class="hero skeleton" style="height:150px"></div>
      <h2 class="section">Mercado</h2><div class="list">${COINS.slice(0, 7).map(() => '<div class="row"><div class="coin-ic skeleton"></div><div class="meta"><div class="skeleton" style="height:14px;width:60%"></div></div></div>').join('')}</div>`;
    return;
  }
  const r = ranked();
  const buys = r.filter(x => x.a.verdict === 'buy');
  const watch = r.filter(x => x.a.verdict === 'watch');
  const opps = [...buys, ...watch].slice(0, 6);
  const scrollX = $('.opps', el)?.scrollLeft || 0;
  el.innerHTML = `
    <div class="hero">
      <div class="hero-label">Oportunidades de compra agora</div>
      <div class="hero-big num">${buys.length}</div>
      <div class="hero-sub">${buys.length
        ? `${buys.map(x => x.c.sym).join(', ')} ${buys.length > 1 ? 'passaram' : 'passou'} em todos os filtros estatísticos.`
        : 'Nenhuma moeda passou em todos os filtros agora. O app só alerta quando o histórico confirma vantagem.'}</div>
      <div class="hero-row">
        <span class="pill">🟢 ${buys.length} compra</span><span class="pill">🟡 ${watch.length} observar</span>
        ${S.rate ? `<span class="pill">US$ 1 = R$ ${S.rate.toFixed(2).replace('.', ',')}</span>` : ''}
      </div>
    </div>
    ${S.error ? `<div class="err">${S.error}</div>` : ''}
    ${climateCard()}
    <h2 class="section">Destaques <small class="muted">distância do gatilho 0–100</small></h2>
    ${opps.length ? `<div class="opps">${opps.map(({ c, a }) => `
      <button class="opp ${a.verdict}" data-open="${c.sym}">
        <div class="opp-head">${coinIcon(c)}<div class="grow"><b>${c.sym}</b><div class="muted num" style="font-size:13px" data-price="${c.sym}">${money(price(c.sym))}</div></div>
          <span class="chip ${VERDICT[a.verdict].cls}">${VERDICT[a.verdict].label}</span></div>
        <div class="score-bar"><i style="width:${a.score}%;background-position:${-300 + a.score * 3}px 0"></i></div>
        <div class="opp-txt">${esc(a.reasons.slice(0, 2).join(' · ') || a.summary)}</div>
      </button>`).join('')}</div>`
      : `<div class="empty"><b>Mercado sem sinais fortes.</b> Fique tranquilo: você será notificado quando uma moeda ficar boa para compra.</div>`}
    ${alertsHomeSection()}
    <h2 class="section">⭐ Favoritas <small class="muted">${S.favs.length ? 'toque na ★ para remover' : ''}</small></h2>
    ${S.favs.length ? `<div class="list">${S.favs.filter(f => coinBySym[f]).map(f => coinRow(coinBySym[f])).join('')}</div>`
      : '<div class="empty">Toque na <b>☆</b> ao lado de qualquer moeda para fixá-la aqui. Você também pode escolher receber notificações só das favoritas em Ajustes.</div>'}
    <h2 class="section">Mercado <small class="muted">${COINS.length} moedas · 24h</small></h2>
    <div class="list">${COINS.filter(c => !isFav(c.sym)).map(coinRow).join('')}</div>
    <div class="btn-row"><button class="btn ghost" data-compare="">⚖️ Comparar moedas</button><button class="btn ghost" data-goto="settings">＋ Adicionar moedas</button></div>`;
  if (soft) $('.opps', el)?.scrollTo(scrollX, 0);
  drawSparks(); drawClimate();
}

function drawSparks() {
  $$('canvas[data-spark]').forEach(cv => {
    const s = S.spark[cv.dataset.spark];
    if (s) drawSpark(cv, s, s.at(-1) >= s[0]);
  });
}

// ---------------------------------------------------------------------------
// Histórico de alertas: registro oficial (ao vivo) + simulação no histórico
// ---------------------------------------------------------------------------
async function loadAlertLog(force) {
  if (!force && S.alertLog && Date.now() - S.alertLogAt < 5 * 60e3) return;
  try {
    const r = await fetch(`${ALERT_LOG_URL}?t=${Math.floor(Date.now() / 60e3)}`);
    S.alertLog = r.ok ? await r.json() : [];
  } catch { S.alertLog = S.alertLog || null; }
  S.alertLogAt = Date.now();
  if (S.view === 'signals' && S.sigTab === 'hist') renderSignals();
}

// resultado de um registro ao vivo: preço 7 dias depois (ou agora, se ainda dentro do prazo)
function liveOutcome(e) {
  const end = e.t + PARAMS.horizon * 864e5, d = S.daily[e.sym];
  let px, done = Date.now() >= end, best = e.price;
  if (d) for (const k of d) { if (k.t + 864e5 > e.t && k.t <= end) best = Math.max(best, k.h); }
  if (done && d) { const k = d.find(k => k.t <= end && end < k.t + 864e5) || d.findLast?.(k => k.t <= end); px = k?.c; }
  else px = price(e.sym);
  if (!px) return null;
  return { ret: px / e.price - 1 - PARAMS.costPct, done, best: best / e.price - 1, daysLeft: Math.max(0, Math.ceil((end - Date.now()) / 864e5)) };
}

const REG_IC = { bull: '🐂', correction: '🔄', bear: '🐻' };
function dayGroups(items) {
  const g = new Map();
  for (const x of items) { const k = new Date(x.t).toISOString().slice(0, 10); (g.get(k) || g.set(k, []).get(k)).push(x); }
  return [...g.entries()];
}
const EXIT_IC = { target: '🎯', stop: '🛑', time: '⏰' };
const resChip = (sym, r, done, exit) => `<span class="res-chip ${!done ? 'open' : r >= 0 ? 'pos' : 'neg'}" data-open="${sym}">${exit ? `${EXIT_IC[exit] || ''} ` : ''}${sym} <b>${pct(r, 1)}</b></span>`;

function renderHistory(el, tabs) {
  if (S.alertLog === undefined) loadAlertLog();
  const mode = S.histMode || 'time';
  // simulação (recalculada quando os dados diários mudam)
  if (!S.hist || S.hist.stamp !== S.dailyStamp) S.hist = { stamp: S.dailyStamp, list: historicalAlerts(S.daily, PARAMS) };
  const H = S.hist.list, done = H.filter(x => x.done);
  const r = x => (mode === 'st' ? x.retST : x.ret);
  const winH = done.length ? done.filter(x => r(x) > 0).length / done.length : null;
  const avgH = done.length ? done.reduce((a, x) => a + r(x), 0) / done.length : null;
  const unitUsd = S.cur === 'BRL' && S.rate ? 1000 / S.rate : 1000;   // R$ 1.000 (ou US$ 1.000) por alerta
  const profitH = done.reduce((a, x) => a + r(x) * unitUsd, 0);
  const firstT = H.length ? H[H.length - 1].t : null;

  // registro ao vivo
  const log = (S.alertLog || []).slice().sort((a, b) => b.t - a.t).map(e => ({ ...e, out: liveOutcome(e) }));
  const ld = log.filter(e => e.out?.done);
  const winL = ld.length ? ld.filter(e => e.out.ret > 0).length / ld.length : null;
  const avgL = ld.length ? ld.reduce((a, e) => a + e.out.ret, 0) / ld.length : null;

  el.innerHTML = `${tabs}
    <div class="card proof">
      <h3>📒 Registro oficial <span class="chip buy">AO VIVO</span></h3>
      <p class="note" style="margin-top:0">Cada alerta é gravado pelo robô <b>no momento em que dispara</b>, com data e preço, num arquivo público do repositório (<a href="https://github.com/${REPO}/commits/main/data/alerts-log.json" target="_blank" rel="noopener">histórico no GitHub</a>). Não dá para apagar ou editar sem deixar rastro.</p>
      ${S.alertLog === undefined ? '<div class="skeleton" style="height:60px"></div>'
        : S.alertLog === null ? '<div class="err">Não foi possível ler o registro agora.</div>'
        : !log.length ? '<div class="empty">Ainda sem alertas registrados. O registro começa a partir da próxima rodada do robô (a cada 30 min).</div>'
        : `<div class="bt-row">
            <div class="stat"><div class="k">Alertas</div><div class="v num">${log.length}</div><div class="s">${ld.length} concluídos</div></div>
            <div class="stat"><div class="k">Com lucro</div><div class="v num ${winL == null ? '' : winL >= 0.5 ? 'up' : 'down'}">${winL == null ? '—' : pct0(winL)}</div><div class="s">em ${PARAMS.horizon} dias</div></div>
            <div class="stat"><div class="k">Média</div><div class="v num ${avgL == null ? '' : cls(avgL)}">${avgL == null ? '—' : pct(avgL, 1)}</div><div class="s">por alerta</div></div>
          </div>
          <div class="days">${dayGroups(log).map(([day, es]) => `<div class="day">
            <div class="day-h"><b>${fmtDate(es[0].t)}</b><span class="muted">${REG_IC[es[0].regime] || ''} ${es[0].fng != null ? `medo ${es[0].fng}` : ''} · ${es.length} alerta${es.length > 1 ? 's' : ''}</span></div>
            <div class="chips">${es.map(e => e.out ? resChip(e.sym, e.out.ret, e.out.done) : `<span class="res-chip open">${e.sym}</span>`).join('')}</div>
            ${es.some(e => e.out && !e.out.done) ? `<div class="muted small">Em andamento — resultado final em ${Math.max(...es.map(e => e.out?.daysLeft || 0))} dia(s). Cinza = parcial (preço de agora).</div>` : ''}
          </div>`).join('')}</div>`}
    </div>

    <div class="card proof">
      <h3>🧪 Simulação no histórico <span class="chip neutral">${firstT ? `desde ${new Date(firstT).getFullYear()}` : ''}</span></h3>
      <p class="note" style="margin-top:0">Todos os alertas que a regra atual teria dado com os dados diários disponíveis (${done.length} já concluídos), comprando no fechamento do dia do alerta.</p>
      <div class="seg mini" style="margin-bottom:12px"><button data-hmode="time" class="${mode === 'time' ? 'on' : ''}">Vender em ${PARAMS.horizon} dias</button><button data-hmode="st" class="${mode === 'st' ? 'on' : ''}">Usar stop e alvo</button></div>
      <div class="bt-row">
        <div class="stat"><div class="k">Com lucro</div><div class="v num ${winH >= 0.5 ? 'up' : 'down'}">${winH == null ? '—' : pct0(winH)}</div><div class="s">${done.length} alertas</div></div>
        <div class="stat"><div class="k">Média</div><div class="v num ${cls(avgH ?? 0)}">${avgH == null ? '—' : pct(avgH, 1)}</div><div class="s">por alerta</div></div>
        <div class="stat ${profitH >= 0 ? 'ath' : 'atl'}"><div class="k">${curSym()} 1.000 cada</div><div class="v num ${cls(profitH)}">${money(profitH, { sign: true, compact: true })}</div><div class="s">lucro somado</div></div>
      </div>
      <div class="wallet-chart-val num" id="hHover" style="padding:10px 0 0"></div>
      <canvas id="histChart" class="wallet-chart" style="height:170px"></canvas>
      <div class="legend"><span>Lucro acumulado investindo ${curSym()} 1.000 em cada alerta</span>${mode === 'st' ? '<span>🎯 alvo · 🛑 stop · ⏰ prazo</span>' : ''}</div>
      <h2 class="section" style="margin-top:16px">Alertas por dia</h2>
      <div class="days">${dayGroups(H).slice(0, S.histMore ? 999 : 12).map(([day, es]) => {
        const dd = es.filter(e => e.done), avg = dd.length ? dd.reduce((a, e) => a + r(e), 0) / dd.length : null;
        return `<div class="day">
          <div class="day-h"><b>${fmtDate(es[0].t)}</b><span class="muted">${REG_IC[es[0].regime] || ''} pânico ${pct0(es[0].share)}${avg != null ? ` · média <b class="${cls(avg)}">${pct(avg, 1)}</b>` : ' · em andamento'}</span></div>
          <div class="chips">${es.map(e => resChip(e.sym, r(e), e.done, mode === 'st' && e.done ? e.exit : null)).join('')}</div>
        </div>`;
      }).join('')}</div>
      ${dayGroups(H).length > 12 && !S.histMore ? '<button class="btn ghost" data-histmore="1">Ver todos os dias</button>' : ''}
      <p class="note">⚠️ É uma simulação: a regra foi desenhada olhando parte desses mesmos dados, então os números tendem a parecer melhores do que serão. A prova definitiva é o registro oficial acima, que cresce a cada alerta real.</p>
    </div>`;

  // curva de lucro acumulado (pela data de saída)
  const pts = [{ t: firstT ?? Date.now(), v: 0 }];
  let cum = 0;
  for (const x of done.slice().sort((a, b) => a.t - b.t)) { cum += r(x) * unitUsd; pts.push({ t: x.t + x.days * 864e5, v: cum }); }
  const series = pts.sort((a, b) => a.t - b.t).map(p => ({ t: p.t, o: p.v, h: p.v, l: p.v, c: p.v, v: 0 }));
  if (series.length > 1) {
    const ch = new PriceChart($('#histChart'), { fmt: v => money(v, { sign: true }),
      onHover: pt => { const h = $('#hHover'); if (h) h.innerHTML = pt ? `<span class="${cls(pt.c)}">${money(pt.c, { sign: true })}</span> <span class="muted">até ${fmtDate(pt.t)}</span>` : ''; } });
    ch.setData(series, { animate: true });
  }
}

function renderSignals() {
  const el = $('#view-signals');
  if (S.loading) { el.innerHTML = '<div class="skeleton" style="height:300px;margin-top:10px"></div>'; return; }
  const tabs = `<div class="seg" style="margin-top:10px"><button data-sigtab="now" class="${S.sigTab !== 'hist' ? 'on' : ''}">📡 Agora</button><button data-sigtab="hist" class="${S.sigTab === 'hist' ? 'on' : ''}">📒 Histórico de alertas</button></div>`;
  if (S.sigTab === 'hist') { renderHistory(el, tabs); return; }
  const list = ranked().filter(({ c }) => S.sigFilter === 'all' || isFav(c.sym));
  el.innerHTML = `${tabs}<h2 class="section">Ranking de oportunidades <small class="muted">horizonte ${PARAMS.horizon} dias</small></h2>
    <div class="seg" style="margin-bottom:12px"><button data-sigf="all" class="${S.sigFilter === 'all' ? 'on' : ''}">Todas</button><button data-sigf="fav" class="${S.sigFilter === 'fav' ? 'on' : ''}">★ Favoritas</button></div>
    ${!list.length ? '<div class="empty">Nenhuma favorita ainda. Toque na ☆ de uma moeda para adicioná-la.</div>' : ''}
    ${list.map(({ c, a }) => {
      const v = VERDICT[a.verdict];
      return `<button class="sig-card" data-open="${c.sym}">
        <div class="top">${coinIcon(c)}
          <div style="flex:1"><b>${esc(c.name)}</b>${star(c.sym)} <span class="chip ${v.cls}">${v.label}</span>
            <div class="muted" style="font-size:12px">${a.trigger ? `Gatilho ativo${a.trigger === 'strong' ? ' (forte)' : ''}` : `Queda ${pct0(Math.abs(a.dd30))} · RSI ${a.rsi != null ? a.rsi.toFixed(0) : '—'}`} · nesta moeda: ${a.bt.events ? `${pct0(a.bt.winRate)} em ${a.bt.events} casos` : 'sem casos'}</div></div>
          <div class="score num" style="color:${scoreColor(a.score)}">${a.score}</div></div>
        <div class="score-bar"><i style="width:${a.score}%;background-position:${-300 + a.score * 3}px 0"></i></div>
        <p>${esc(a.summary)}</p>
      </button>`;
    }).join('')}
    ${COINS.filter(c => S.analysis[c.sym] && !S.analysis[c.sym].ok).map(c => `<div class="note">${c.sym}: ${esc(S.analysis[c.sym].reason)}</div>`).join('')}`;
}

// ---------------------------------------------------------------------------
// Compras simuladas: stop, alvo, prazo e avisos de venda
// ---------------------------------------------------------------------------
const H_MS = () => PARAMS.horizon * 864e5;
function migratePositions() {
  let changed = false;
  for (const p of S.positions) {
    if (!p.id) { p.id = (p.at || Date.now()).toString(36) + Math.random().toString(36).slice(2, 5); changed = true; }
    if (!p.stop || !p.target) {
      const atr = S.analysis[p.sym]?.atrPct ?? 0.05;
      p.stop = p.entry * (1 - 2 * atr); p.target = p.entry * (1 + 2 * atr); changed = true;
    }
    if (!p.exp) { p.exp = p.at + H_MS(); changed = true; }
    if (!p.status) { p.status = 'open'; changed = true; }
    if (p.costUsd == null) { p.costUsd = p.amount / (p.cur === 'BRL' ? p.rate : 1); changed = true; }
    if (p.status === 'sold' && p.soldValueUsd == null) { p.soldValueUsd = (p.soldValue ?? p.amount) / (p.cur === 'BRL' ? p.rate : 1); changed = true; }
    p.alerts ||= {};
  }
  if (changed) savePositions();
}
const savePositions = () => store.set('positions', S.positions);
const localRate = p => (p.cur === 'BRL' ? (S.rate || p.rate) : 1);
const posValue = (p, usdPrice, rate = localRate(p)) => p.qty * usdPrice * rate * (1 - PARAMS.costPct / 2);
const valueUsd = (p, usdPrice) => p.qty * usdPrice * (1 - PARAMS.costPct / 2);   // valor de venda (já com taxa)

// ---------- carteira fictícia ----------
const saveWallet = () => store.set('wallet', S.wallet);
function initWallet() {
  if (S.wallet) return;
  const initialUsd = S.cur === 'BRL' && S.rate ? 10000 / S.rate : 2000;
  let cash = initialUsd;
  for (const p of S.positions) { cash -= p.costUsd; if (p.status === 'sold') cash += p.soldValueUsd; }
  S.wallet = { initialUsd: initialUsd + Math.max(0, -cash), cashUsd: Math.max(0, cash), createdAt: Math.min(Date.now(), ...S.positions.map(p => p.at)) };
  saveWallet();
}
function resetWallet(localAmount) {
  const usd = S.cur === 'BRL' && S.rate ? localAmount / S.rate : localAmount;
  S.positions = []; savePositions();
  S.wallet = { initialUsd: usd, cashUsd: usd, createdAt: Date.now() }; saveWallet();
  renderSim();
}

// preço de uma moeda num instante t (velas de 1h se houver, senão diárias)
function priceAt(sym, t) {
  const pick = arr => { if (!arr?.length || t < arr[0].t) return null; let lo = 0, hi = arr.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (arr[m].t <= t) lo = m; else hi = m - 1; } return arr[lo].c; };
  return pick(S.hourly[sym]) ?? pick(S.daily[sym]);
}

function walletSeries() {
  const W = S.wallet, now = Date.now();
  const start = Math.max(W.createdAt, S.walletRange === '7D' ? now - 7 * 864e5 : 0);
  const hourly = now - start <= 8 * 864e5;
  const ref = (hourly ? S.hourly.BTC : S.daily.BTC) || [];
  const times = [start, ...ref.map(k => k.t).filter(t => t > start), now];
  const lots = S.positions;
  const pts = times.map(t => {
    let cash = W.initialUsd, hold = 0;
    for (const p of lots) {
      if (p.at > t) continue;
      cash -= p.costUsd;
      if (p.status === 'sold' && p.soldAt <= t) { cash += p.soldValueUsd; continue; }
      const px = t === now ? (price(p.sym) ?? p.entry) : (priceAt(p.sym, t) ?? p.entry);
      hold += valueUsd(p, px);
    }
    const v = cash + hold;
    return { t, o: v, h: v, l: v, c: v, v: 0 };
  });
  // a carteira começa com o saldo inicial (sem compras antes de criada)
  return pts;
}

function walletTotals() {
  const W = S.wallet;
  const open = S.positions.filter(p => p.status !== 'sold');
  const sold = S.positions.filter(p => p.status === 'sold');
  const bySym = {};
  let holdUsd = 0, costOpen = 0, d24 = 0;
  for (const p of open) {
    const px = price(p.sym) ?? p.entry, v = valueUsd(p, px);
    const h = (bySym[p.sym] ||= { sym: p.sym, qty: 0, cost: 0, value: 0, lots: 0 });
    h.qty += p.qty; h.cost += p.costUsd; h.value += v; h.lots++;
    holdUsd += v; costOpen += p.costUsd;
    const t = S.tickers[p.sym]; if (t?.open) d24 += p.qty * (px - Math.max(t.open, p.at > Date.now() - 864e5 ? p.entry : 0)) * (1 - PARAMS.costPct / 2);
  }
  const realized = sold.reduce((a, p) => a + p.soldValueUsd - p.costUsd, 0);
  const wins = sold.filter(p => p.soldValueUsd > p.costUsd).length;
  const total = W.cashUsd + holdUsd;
  return { total, cash: W.cashUsd, holdUsd, costOpen, unrealized: holdUsd - costOpen, realized, wins, sold: sold.length,
    pl: total - W.initialUsd, d24, holdings: Object.values(bySym).sort((a, b) => b.value - a.value) };
}

async function alertPosition(p, type, priceUsd) {
  if (p.alerts[type]) return;
  p.alerts[type] = Date.now();
  if (type !== 'expire') { p.status = type; p.hitPrice = priceUsd; p.hitAt = Date.now(); }
  savePositions();
  const c = coinBySym[p.sym];
  const { title, body } = exitMessage(type, p, c?.name || p.sym, priceUsd);
  toast(`<b>${esc(title)}</b><br><span class="muted">${esc(body)}</span>`, () => { closeDetail(); switchView('sim'); });
  navigator.vibrate?.([30, 60, 30]);
  if ('Notification' in window && Notification.permission === 'granted') {
    const reg = await navigator.serviceWorker?.getRegistration();
    reg?.showNotification(title, { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: `pos-${p.id}-${type}`, data: { url: './?tab=sim' } });
  }
  if (S.view === 'sim') renderSim();
}

// ao vivo (a cada preço novo)
let lastPosCheck = 0;
function checkPositions(force) {
  if (!force && Date.now() - lastPosCheck < 1500) return;
  lastPosCheck = Date.now();
  for (const p of S.positions) {
    if (p.status !== 'open') continue;
    const cur = S.tickers[p.sym]?.price; if (!cur) continue;
    if (cur <= p.stop) alertPosition(p, 'stop', cur);
    else if (cur >= p.target) alertPosition(p, 'target', cur);
    else if (Date.now() >= p.exp) alertPosition(p, 'expire', cur);
  }
}

// ao abrir o app: confere o que aconteceu enquanto ele estava fechado (velas de 1h desde a compra)
async function reconcilePositions() {
  for (const p of S.positions.filter(p => p.status === 'open')) {
    try {
      const ks = await fetchKlines(p.sym, '1h', 1000, p.at - 36e5);
      const hit = firstHit(p, ks);
      if (hit) alertPosition(p, hit.type, hit.price);
    } catch {}
  }
  checkPositions(true);
}

function rangeBar(p, cur) {
  const f = x => Math.max(0, Math.min(1, (x - p.stop) / (p.target - p.stop))) * 100;
  return `<div class="pos-range"><i class="entry" style="left:${f(p.entry)}%"></i>${cur ? `<b class="now ${cur >= p.entry ? 'up' : 'down'}" style="left:${f(cur)}%"></b>` : ''}</div>
    <div class="pos-legend"><span class="down">🛑 ${money(p.stop)} (${pct(p.stop / p.entry - 1, 1)})</span><span class="up">🎯 ${money(p.target)} (${pct(p.target / p.entry - 1, 1)})</span></div>`;
}

const STATUS = {
  open: ['ABERTA', 'neutral'], target: ['🎯 ALVO ATINGIDO', 'buy'], stop: ['🛑 STOP ATINGIDO', 'avoid'], sold: ['VENDIDA', 'neutral'],
};

let walletChart = null, lastSimRender = 0;
function renderSim(fromTick) {
  const el = $('#view-sim');
  if (document.activeElement?.closest?.('#view-sim .pos-edit, #view-sim .wallet-reset')) return; // não atrapalhar quem está digitando
  if (fromTick && (walletChart?.hover != null || Date.now() - lastSimRender < 2000)) return;
  lastSimRender = Date.now();
  if (!S.wallet) { el.innerHTML = '<div class="skeleton" style="height:220px;margin-top:10px"></div>'; return; }
  const T = walletTotals(), W = S.wallet;
  const active = S.positions.filter(p => p.status !== 'sold');
  const cards = active.map(p => {
    const c = coinBySym[p.sym] || { sym: p.sym, name: p.sym, color: colorFor(p.sym) };
    const cur = price(p.sym);
    const v = cur ? valueUsd(p, cur) : null;
    const pl = v != null ? v - p.costUsd : 0;
    const [label, kls] = STATUS[p.status];
    const left = p.exp - Date.now();
    const timeTxt = left > 0 ? `prazo: ${left > 864e5 ? `${Math.ceil(left / 864e5)} dias` : `${Math.ceil(left / 36e5)} h`}` : '⏰ prazo de 7 dias encerrado';
    const hit = p.status === 'target' || p.status === 'stop';
    const hitVal = hit ? valueUsd(p, p.hitPrice) : null;
    return `<div class="pos-card${hit ? ` hit-${p.status}` : ''}">
      <div class="pos-top">${coinIcon(c)}
        <div class="meta" data-open="${p.sym}"><div class="name">${c.sym} <span class="chip ${kls}">${label}</span></div>
          <div class="sub">${money(p.costUsd)} em ${fmtDate(p.at)} · entrada ${money(p.entry)}</div></div>
        <div class="right"><div class="price num">${money(v)}</div><div class="chg num ${cls(pl)}">${money(pl, { sign: true })} (${pct(pl / p.costUsd)})</div></div>
      </div>
      ${rangeBar(p, cur)}
      <div class="pos-foot"><span class="muted">${timeTxt}</span><span class="muted">${p.alerts.expire && !hit ? 'reavalie a posição' : ''}</span></div>
      ${hit ? `<div class="pos-hit">${p.status === 'target' ? '🎯 Bateu o alvo' : '🛑 Bateu o stop'} em ${money(p.hitPrice)}. Vendendo nesse preço: <b class="${cls(hitVal - p.costUsd)}">${money(hitVal - p.costUsd, { sign: true })}</b></div>` : ''}
      ${S.editPos === p.id ? `<div class="pos-edit">
          <label>Stop (% abaixo da entrada)<input data-edit="stop" data-id="${p.id}" inputmode="decimal" value="${(Math.abs(p.stop / p.entry - 1) * 100).toFixed(1).replace('.', ',')}"></label>
          <label>Alvo (% acima da entrada)<input data-edit="target" data-id="${p.id}" inputmode="decimal" value="${((p.target / p.entry - 1) * 100).toFixed(1).replace('.', ',')}"></label>
          <button class="chip buy" data-editdone="1" style="padding:8px 14px">OK</button></div>` : ''}
      <div class="pos-actions">
        ${hit ? `<button class="chip buy" data-sell="${p.id}" data-at="hit">Registrar venda a ${money(p.hitPrice)}</button>` : `<button class="chip buy" data-sell="${p.id}">Vender agora</button>`}
        ${hit ? '' : `<button class="chip neutral" data-editpos="${p.id}">Ajustar stop/alvo</button>`}
        <button class="chip neutral" data-delpos="${p.id}">cancelar</button>
      </div>
    </div>`;
  });

  // donut: moedas + saldo
  const segs = [...T.holdings.map(h => ({ label: h.sym, value: h.value, color: (coinBySym[h.sym] || {}).color || colorFor(h.sym) })),
    { label: 'Saldo', value: T.cash, color: '#5B5B6B' }].filter(x => x.value > 0);
  const moves = [];
  for (const p of S.positions) {
    moves.push({ t: p.at, kind: 'buy', p });
    if (p.status === 'sold') moves.push({ t: p.soldAt, kind: 'sell', p });
  }
  moves.sort((a, b) => b.t - a.t);

  el.innerHTML = `
    <div class="hero wallet-hero">
      <div class="hero-label">Patrimônio da carteira fictícia</div>
      <div class="hero-big num">${money(T.total)}</div>
      <div class="hero-row" style="margin-top:6px">
        <span class="pill ${T.pl >= 0 ? 'pill-up' : 'pill-down'}">${T.pl >= 0 ? '▲' : '▼'} ${money(T.pl, { sign: true })} (${pct(T.pl / W.initialUsd)}) desde o início</span>
        ${T.holdings.length ? `<span class="pill">24h: ${money(T.d24, { sign: true })}</span>` : ''}
      </div>
      <div class="hero-sub" style="margin-top:10px">💵 Saldo disponível para comprar: <b>${money(T.cash)}</b></div>
    </div>

    ${pushCfgStale() ? `<div class="err" style="background:rgba(255,209,102,.12);color:var(--gold)">⚠️ Para receber avisos de stop/alvo com o app fechado, atualize o código do aparelho no GitHub. <button class="chip watch" data-goto="settings" style="margin-top:6px">Ir para Ajustes</button></div>` : ''}

    <div class="card" style="padding:14px 0 10px">
      <h3 style="padding:0 16px">Evolução <div class="seg mini">${['7D', 'TUDO'].map(r => `<button data-wrange="${r}" class="${S.walletRange === r ? 'on' : ''}">${r === 'TUDO' ? 'Tudo' : r}</button>`).join('')}</div></h3>
      <div class="wallet-chart-val num" id="wHover"></div>
      <canvas id="walletChart" class="wallet-chart"></canvas>
      <div class="legend" style="padding:0 16px"><span><i style="background:var(--up)"></i>Compras</span><span>Valor total = saldo + moedas (já com taxa de venda)</span></div>
    </div>

    <div class="card">
      <h3>Distribuição</h3>
      <div class="alloc">
        <div class="donut"><canvas id="donut"></canvas><div class="donut-c"><b class="num">${T.holdings.length}</b><span>moeda${T.holdings.length === 1 ? '' : 's'}</span></div></div>
        <div class="alloc-legend">${segs.map(g => `<div><i style="background:${g.color}"></i><span>${g.label}</span><b class="num">${pct0(g.value / T.total)}</b></div>`).join('')}</div>
      </div>
    </div>

    <div class="grid2" style="margin-top:14px">
      <div class="stat"><div class="k">Em moedas</div><div class="v num">${money(T.holdUsd)}</div><div class="s">investido ${money(T.costOpen)}</div></div>
      <div class="stat ${T.unrealized >= 0 ? 'ath' : 'atl'}"><div class="k">Lucro não realizado</div><div class="v num ${cls(T.unrealized)}">${money(T.unrealized, { sign: true })}</div><div class="s">${T.costOpen ? pct(T.unrealized / T.costOpen) : '—'}</div></div>
      <div class="stat ${T.realized >= 0 ? 'ath' : 'atl'}"><div class="k">Lucro realizado</div><div class="v num ${cls(T.realized)}">${money(T.realized, { sign: true })}</div><div class="s">${T.sold} venda${T.sold === 1 ? '' : 's'}</div></div>
      <div class="stat"><div class="k">Vendas com lucro</div><div class="v num">${T.sold ? pct0(T.wins / T.sold) : '—'}</div><div class="s">${T.wins} de ${T.sold}</div></div>
    </div>

    <h2 class="section">Seus ativos <small class="muted">${T.holdings.length ? 'toque para ver a moeda' : ''}</small></h2>
    ${T.holdings.length ? `<div class="list">${T.holdings.map(h => {
      const c = coinBySym[h.sym] || { sym: h.sym, name: h.sym, color: colorFor(h.sym) };
      const pl = h.value - h.cost;
      return `<button class="row" data-open="${h.sym}">${coinIcon(c)}
        <div class="meta"><div class="name">${esc(c.name)}</div><div class="sub num">${qty(h.qty, h.sym)}</div>
          <div class="alloc-bar"><i style="width:${(h.value / T.total) * 100}%;background:${c.color}"></i></div></div>
        <div class="right"><div class="price num">${money(h.value)}</div><div class="chg num ${cls(pl)}">${money(pl, { sign: true })} (${pct(pl / h.cost)})</div>
          <div class="sub" style="font-size:11px;color:var(--muted)">preço médio ${money((h.cost * (1 - PARAMS.costPct / 2)) / h.qty)}</div></div>
      </button>`;
    }).join('')}</div>`
      : `<div class="empty"><b>Sua carteira ainda não tem moedas.</b> Abra qualquer moeda e toque em <b>“Simular compra agora”</b>. O valor sai do seu saldo fictício de ${money(T.cash)}.</div>`}

    ${active.length ? `<h2 class="section">Operações abertas <small class="muted">stop · alvo · prazo</small></h2>${cards.join('')}` : ''}

    ${moves.length ? `<h2 class="section">Movimentações</h2><div class="list">${moves.slice(0, 30).map(m => {
      const c = coinBySym[m.p.sym] || { sym: m.p.sym, color: colorFor(m.p.sym) };
      if (m.kind === 'buy') return `<div class="row">${coinIcon(c)}<div class="meta"><div class="name">Compra · ${m.p.sym}</div><div class="sub">${fmtDateTime(m.t, '7D')} · ${qty(m.p.qty, '')} a ${money(m.p.entry)}</div></div>
        <div class="right"><div class="price num down">−${money(m.p.costUsd)}</div></div></div>`;
      const r = m.p.soldValueUsd - m.p.costUsd;
      return `<div class="row">${coinIcon(c)}<div class="meta"><div class="name">Venda · ${m.p.sym}</div><div class="sub">${fmtDateTime(m.t, '7D')} · ${m.p.soldReason || 'manual'}</div></div>
        <div class="right"><div class="price num up">+${money(m.p.soldValueUsd)}</div><div class="chg num ${cls(r)}">${money(r, { sign: true })}</div></div></div>`;
    }).join('')}</div>` : ''}

    <div class="card wallet-reset"><h3>Carteira fictícia</h3>
      <p class="note" style="margin-top:0">Começou em ${fmtDate(W.createdAt)} com ${money(W.initialUsd)}. Para recomeçar, escolha um novo saldo inicial (apaga compras e vendas).</p>
      <div class="pos-edit" style="margin-top:6px"><label>Novo saldo inicial (${curSym()})<input id="resetAmt" inputmode="decimal" value="${Math.round(conv(W.initialUsd)).toLocaleString('pt-BR')}"></label>
        <button class="chip avoid" id="resetWallet" style="padding:9px 14px">Reiniciar</button></div>
    </div>
    <p class="note">Simulação sem dinheiro real. Stop e alvo padrão = 2× a variação média diária (ATR). Taxas de ${(PARAMS.costPct * 100).toFixed(1).replace('.', ',')}% (compra + venda) já descontadas.</p>`;

  drawDonut($('#donut'), segs);
  walletChart = new PriceChart($('#walletChart'), {
    fmt: v => money(v),
    onHover: pt => { const h = $('#wHover'); if (!h) return; h.innerHTML = pt ? `${money(pt.c)} <span class="muted">· ${fmtDateTime(pt.t, '7D')}</span> <span class="${cls(pt.c - W.initialUsd)}">${pct(pt.c / W.initialUsd - 1)}</span>` : ''; },
  });
  const firstDraw = !renderSim._drawn || renderSim._range !== S.walletRange;
  renderSim._drawn = true; renderSim._range = S.walletRange;
  walletChart.setData(walletSeries(), { markers: S.positions.map(p => p.at), animate: firstDraw });
}

function renderSettings() {
  const el = $('#view-settings');
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  el.innerHTML = `
    <div class="card"><h3>Moeda</h3>
      <div class="seg" id="curSeg"><button data-cur="BRL" class="${S.cur === 'BRL' ? 'on' : ''}">Real (R$)</button><button data-cur="USD" class="${S.cur === 'USD' ? 'on' : ''}">Dólar (US$)</button></div>
    </div>
    ${!standalone ? `<div class="card"><h3>📲 Instalar no iPhone</h3><ol class="steps">
      <li>Abra este site no <b>Safari</b>.</li><li>Toque em <b>Compartilhar</b> (quadrado com seta).</li>
      <li>Escolha <b>“Adicionar à Tela de Início”</b>.</li><li>Abra o app pelo ícone e ative as notificações abaixo.</li></ol>
      <p class="note">No iPhone, notificações só funcionam com o app instalado na Tela de Início (iOS 16.4 ou superior).</p></div>` : ''}
    <div class="card"><h3>🔔 Notificações <span class="chip ${perm === 'granted' ? 'buy' : 'neutral'}">${{ granted: 'ATIVAS', denied: 'BLOQUEADAS', default: 'DESATIVADAS', unsupported: 'INDISPONÍVEL' }[perm]}</span></h3>
      <p class="note" style="margin-top:0">Com o app aberto, os alertas chegam na hora. Para receber <b>com o app fechado</b>, o robô de análise (GitHub Actions) verifica o mercado a cada 30 minutos e envia uma notificação push para este iPhone.</p>
      <div class="set-row"><div><b>Quais moedas notificar?</b><div class="note" style="margin:2px 0 0">${S.notifyMode === 'favorites' ? `Só as ${S.favs.length} favoritas` : `Todas as ${COINS.length} moedas`}</div></div></div>
      <div class="seg"><button data-notify="all" class="${S.notifyMode === 'all' ? 'on' : ''}">Todas</button><button data-notify="favorites" class="${S.notifyMode === 'favorites' ? 'on' : ''}">★ Só favoritas</button></div>
      ${pushCfgStale()
        ? '<div class="err" style="background:rgba(255,209,102,.12);color:var(--gold)">⚠️ Você mudou favoritas, moedas, compras simuladas, alertas de preço ou o tipo de notificação. Gere e copie o código de novo e atualize o segredo <b>PUSH_SUBSCRIPTIONS</b> no GitHub para o robô saber.</div>' : ''}
      <div class="set-row" style="margin-top:8px"><div><b>☀️ Resumo diário</b><div class="note" style="margin:2px 0 0">Clima, moedas mais perto do gatilho, oportunidades e suas compras simuladas</div></div></div>
      <div class="digest-row">
        <div class="seg"><button data-dgon="1" class="${S.digest.on ? 'on' : ''}">Ligado</button><button data-dgon="0" class="${!S.digest.on ? 'on' : ''}">Desligado</button></div>
        <select id="dgHour" ${S.digest.on ? '' : 'disabled'}>${Array.from({ length: 17 }, (_, k) => k + 6).map(h => `<option value="${h}" ${h === S.digest.h ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select>
      </div>
      <button class="btn ghost" id="dgPreview" style="margin-top:10px">Ver prévia do resumo</button>
      <button class="btn primary" id="enablePush">${perm === 'granted' ? 'Gerar código do aparelho' : 'Ativar notificações'}</button>
      <div id="pushOut"></div>
      <button class="btn ghost" id="testNotif">Enviar notificação de teste</button>
    </div>
    <div class="card"><h3>🪙 Moedas acompanhadas <span class="chip neutral">${COINS.length}</span></h3>
      <p class="note" style="margin-top:0">Adicione qualquer moeda negociada em dólar (USDT) na Binance. Ela ganha gráfico, análise, simulação e alertas.</p>
      <div class="amount" style="padding:2px 12px"><span>🔎</span><input id="coinSearch" placeholder="Buscar (ex.: JUP, WLD, TAO)" autocomplete="off" autocapitalize="characters" style="font-size:17px;font-weight:600"></div>
      <div id="coinResults"></div>
      ${customCoins().length ? `<div class="list" style="margin-top:12px">${customCoins().map(c => `<div class="row">${coinIcon(c)}<div class="meta"><div class="name">${c.sym}</div><div class="sub">adicionada por você</div></div><button class="del" data-rmcoin="${c.sym}" style="color:var(--down)">remover</button></div>`).join('')}</div>` : ''}
    </div>
    <div class="card method"><h3>🧠 Como o app decide</h3>
      <p><b>Estratégia: repique após queda forte.</b> O app avisa quando uma moeda caiu <b>25% ou mais</b> desde a máxima dos últimos 30 dias <b>e</b> o RSI(14) está <b>abaixo de 30</b> (vendedores esgotados). É uma operação de <b>curto prazo</b>: a ideia é comprar no pânico e reavaliar em cerca de ${PARAMS.horizon} dias. RSI abaixo de 25 = sinal <b>forte</b>.</p>
      <p><b>Por que essa?</b> Testamos ~15 estratégias (a pontuação antiga, rompimentos, cruzamentos de médias, Bollinger, filtros pelo Bitcoin…) em ${STUDY.coins} moedas desde ${STUDY.from.slice(0, 4)}, separando um período de estudo (até 2022) e um de prova (2023+). Só esta teve vantagem nos dois períodos, em todas as variações de parâmetros e com estatística robusta.</p>
      <div class="bt-row" style="margin:10px 0">
        <div class="stat"><div class="k">Casos</div><div class="v num">${STUDY.events}</div><div class="s">${STUDY.coins} moedas</div></div>
        <div class="stat"><div class="k">Subiram em ${PARAMS.horizon}d</div><div class="v num up">${pct0(STUDY.winRate)}</div><div class="s">dia qualquer: ${pct0(STUDY.baseWinRate)}</div></div>
        <div class="stat"><div class="k">Sinal forte</div><div class="v num up">${pct0(STUDY.strongWinRate)}</div><div class="s">${STUDY.strongEvents} casos</div></div>
      </div>
      <p><b>Só alerta em pânico de mercado:</b> é preciso que pelo menos ${PARAMS.minBreadth * 100}% das moedas estejam no gatilho juntas. Quedas isoladas (provável notícia ruim da própria moeda) tiveram só ${pct0(STUDY.breadth.isolatedWinRate)} de acerto; em pânico geral, ${pct0(STUDY.breadth.panicWinRate)}.</p>
      <p><b>Clima do mercado:</b> se o Bitcoin estiver em <b>baixa longa</b> (abaixo da média de 200 dias e ela caindo), o alerta vira "observar" — nesse clima o repique acertou só ${pct0(STUDY.climate.bear.win)}. Em correção dentro de alta, ${pct0(STUDY.climate.correction.win)}. Testado com janelas de 10 a 90 dias: mesmo resultado. O índice de Medo e Ganância foi testado e <b>não</b> melhorou o acerto — aparece só como informação.</p>
      <div class="bt-row" style="margin:10px 0">
        <div class="stat ath"><div class="k">Regra final</div><div class="v num up">${pct0(STUDY.alerts.win)}</div><div class="s">${STUDY.alerts.n} alertas</div></div>
        <div class="stat"><div class="k">Até 2022</div><div class="v num">${pct0(STUDY.alerts.study.win)}</div><div class="s">${STUDY.alerts.study.n} casos</div></div>
        <div class="stat"><div class="k">2023+</div><div class="v num">${pct0(STUDY.alerts.proof.win)}</div><div class="s">${STUDY.alerts.proof.n} casos</div></div>
      </div>
      <p class="muted">⚠️ Em mercados de baixa prolongados (2018, 2022, 2026) o acerto ficou perto de 50%. É exatamente por isso que existe o filtro de clima acima. Mediana do ganho em 7 dias é modesta e os 10% piores casos perdem 12–19%: use o stop e não concentre tudo.</p>
      <p><b>Ano a ano</b> (acerto, todos os gatilhos): ${Object.entries(STUDY.byYear).map(([y, v]) => `<span class="${v.win >= STUDY.baseWinRate ? 'up' : 'down'}">${y}: ${pct0(v.win)}</span>`).join(' · ')}</p>
      <p><b>Simulação</b> usa a distribuição real dos resultados (pessimista = 10% piores casos, provável = mediana, otimista = 10% melhores) da própria moeda, ou do estudo completo quando a moeda tem poucos casos.</p>
      <p class="muted">Estudo reproduzível em <i>research/</i> no repositório. Base teórica: reversão de curto prazo (Jegadeesh 1990; Lehmann 1990) e sobre-reação em criptomoedas após quedas extremas.</p>
    </div>
    <div class="disclaimer">⚠️ <b>Importante:</b> estatística reduz o “chute”, mas não elimina o risco. Resultados passados não garantem resultados futuros e criptomoedas podem cair muito rápido. Use o app como apoio à decisão, invista só o que pode perder e considere o stop sugerido. Isto não é recomendação de investimento.</div>
    <p class="note" style="text-align:center">Dados: Binance (tempo real) e CoinGecko (máx./mín. histórica e ícones).</p>`;
}

// ---------------------------------------------------------------------------
// Tela de detalhe
// ---------------------------------------------------------------------------
async function openDetail(sym) {
  const c = coinBySym[sym]; if (!c) return;
  S.detail = sym;
  history.replaceState(null, '', `?coin=${sym}`);
  const sheet = $('#sheet');
  sheet.classList.add('open'); sheet.setAttribute('aria-hidden', 'false'); sheet.scrollTop = 0;
  renderDetail();
  loadRange();
}

function closeDetail() {
  S.detail = null; S.chart = null;
  history.replaceState(null, '', location.pathname);
  $('#sheet').classList.remove('open'); $('#sheet').setAttribute('aria-hidden', 'true');
}

function athAtl(c) {
  const m = S.markets[c.id];
  if (m?.ath) return { ath: m.ath, athDate: m.athDate, atl: m.atl, atlDate: m.atlDate, src: 'cg' };
  const d = S.daily[c.sym]; if (!d?.length) return null;
  let hi = d[0], lo = d[0];
  for (const k of d) { if (k.h > hi.h) hi = k; if (k.l < lo.l) lo = k; }
  return { ath: hi.h, athDate: hi.t, atl: lo.l, atlDate: lo.t, src: 'bn' };
}

function renderDetail() {
  const sym = S.detail, c = coinBySym[sym], a = S.analysis[sym], t = S.tickers[sym] || {};
  const m = S.markets[c.id] || {};
  const x = athAtl(c);
  const p = price(sym);
  const v = a?.ok ? VERDICT[a.verdict] : null;
  $('#sheetInner').innerHTML = `
    <div class="sheet-nav"><button class="back" id="closeSheet" aria-label="Voltar"><svg width="20" height="20" viewBox="0 0 24 24"><path fill="currentColor" d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z"/></svg></button>
      <div style="display:flex;gap:8px;align-items:center">${v ? `<span class="chip ${v.cls}" style="font-size:12px;padding:5px 10px">${v.label}</span>` : ''}<button class="back" data-compare="${sym}" aria-label="Comparar" title="Comparar">⚖️</button>${detailStar(sym)}</div></div>
    <div class="d-head">${coinIcon(c, true)}<div><div class="d-name">${esc(c.name)}</div><div class="muted">${sym}${m.rank ? ` · #${m.rank} em valor de mercado` : ''}</div></div></div>
    <div class="d-price num" id="dPrice">${money(p)}</div>
    <div class="d-chg num" id="dChg"></div>
    <div class="chart-wrap"><canvas id="chart"></canvas></div>
    <div class="ranges" id="ranges">${Object.keys(RANGES).map(r => `<button data-range="${r}" class="${r === S.range ? 'on' : ''}">${r === 'TUDO' ? 'Tudo' : r}</button>`).join('')}</div>
    <div class="legend"><span><i style="background:var(--up)"></i>Sinais de compra passados</span><span><i style="background:var(--gold)"></i>Máx. histórica</span><span>Barras: volume (verde = alta)</span></div>

    <div class="grid2" style="margin-top:14px">
      <div class="stat ath"><div class="k">🏔️ Máxima histórica</div><div class="v num">${money(x?.ath)}</div><div class="s">${x ? fmtDate(x.athDate) : ''} · <span class="${cls(p / x?.ath - 1)}" data-dist-ath>${x ? pct(p / x.ath - 1, 1) : ''}</span></div></div>
      <div class="stat atl"><div class="k">🕳️ Mínima histórica</div><div class="v num">${money(x?.atl)}</div><div class="s">${x ? fmtDate(x.atlDate) : ''} · <span class="up" data-dist-atl>${x ? pct(p / x.atl - 1, 0) : ''}</span></div></div>
      <div class="stat"><div class="k">Máx. 24h</div><div class="v num" id="dHigh">${money(t.high)}</div></div>
      <div class="stat"><div class="k">Mín. 24h</div><div class="v num" id="dLow">${money(t.low)}</div></div>
      <div class="stat"><div class="k">Volume 24h</div><div class="v num" id="dVol">${money(t.quoteVol, { compact: true })}</div></div>
      <div class="stat"><div class="k">Valor de mercado</div><div class="v num">${money(m.marketCap, { compact: true })}</div></div>
    </div>
    ${x?.src === 'bn' ? '<p class="note">Máx./mín. calculadas pelos últimos 1.000 dias (CoinGecko indisponível no momento).</p>' : ''}

    ${a?.ok ? detailAnalysis(c, a) : `<div class="card"><p class="muted">${esc(a?.reason || 'Carregando análise…')}</p></div>`}
  `;
  // gráfico
  S.chart = new PriceChart($('#chart'), {
    fmt: v => money(v),
    onHover: pt => {
      if (!pt) { updateDetailLive(true); return; }
      $('#dPrice').textContent = money(pt.c);
      const ch = pt.c / pt.first.o - 1;
      $('#dChg').innerHTML = `<span class="${cls(ch)}">${pct(ch)}</span> <span class="muted">· ${fmtDateTime(pt.t, S.range)}</span>`;
    },
  });
  if (S.rangeData?.sym === sym && S.rangeData.range === S.range) setChartData(false);
  if (a?.ok) { drawScoreRing($('#ring'), a.score); updateSim(); }
}

// ---------------------------------------------------------------------------
// Alertas de preço manuais
// ---------------------------------------------------------------------------
const saveAlerts = () => store.set('priceAlerts', S.alerts);
const fmtLocal = usd => money(usd);

function chartAlertLines(sym) {
  return S.alerts.filter(a => a.sym === sym && !a.hitAt).map(a => ({ price: a.price, color: a.dir === 'above' ? '#2EE6A6' : '#FF9F5A', label: `🔔 ${money(a.price)}` }));
}

function alertsCard(c) {
  const list = S.alerts.filter(a => a.sym === c.sym);
  const p = price(c.sym);
  return `<div class="card" id="alertsCard"><h3>🔔 Alertas de preço ${list.filter(a => !a.hitAt).length ? `<span class="chip watch">${list.filter(a => !a.hitAt).length} ativo${list.filter(a => !a.hitAt).length > 1 ? 's' : ''}</span>` : ''}</h3>
    <p class="note" style="margin-top:0">Você recebe uma notificação quando ${c.sym} chegar no preço escolhido.</p>
    <div class="amount" style="padding:2px 12px"><span>${curSym()}</span><input id="alertPrice" inputmode="decimal" placeholder="${p ? fmtNum(conv(p)) : 'preço'}" style="font-size:22px"></div>
    <div class="quick">${[-10, -5, 5, 10].map(q => `<button data-alq="${q}" class="${q < 0 ? 'neg' : ''}">${q > 0 ? '+' : ''}${q}%</button>`).join('')}</div>
    <div id="alertHint" class="note"></div>
    <button class="btn primary" id="addAlert" style="margin-top:8px">Criar alerta</button>
    ${list.length ? `<div class="list" style="margin-top:12px">${list.map(a => alertRow(a, false)).join('')}</div>` : ''}
  </div>`;
}

function alertRow(a, withCoin) {
  const c = coinBySym[a.sym] || { sym: a.sym, name: a.sym, color: colorFor(a.sym) };
  const p = price(a.sym);
  const dist = p ? a.price / p - 1 : null;
  const up = a.dir === 'above';
  return `<div class="row alert-row${a.hitAt ? ' hit' : ''}">
    ${withCoin ? coinIcon(c) : `<div class="al-ic ${up ? 'up' : 'down'}">${up ? '▲' : '▼'}</div>`}
    <div class="meta"${withCoin ? ` data-open="${a.sym}"` : ''}><div class="name">${withCoin ? `${a.sym} ` : ''}${up ? 'Subir até' : 'Cair até'} ${money(a.price)}</div>
      <div class="sub">${a.hitAt ? `✅ Atingido em ${fmtDateTime(a.hitAt, '7D')}` : dist != null ? `faltam ${pct(Math.abs(dist), 1).replace(/^[+−]/, '')} · criado ${fmtDate(a.at)}` : ''}</div>
      ${!a.hitAt && dist != null ? `<div class="al-prog"><i style="width:${Math.max(4, 100 - Math.min(100, Math.abs(dist) / Math.max(1e-9, Math.abs(a.price / a.ref - 1)) * 100))}%;background:${up ? 'var(--up)' : 'var(--orange)'}"></i></div>` : ''}</div>
    <button class="del" data-delalert="${a.id}">${a.hitAt ? 'apagar' : 'remover'}</button>
  </div>`;
}

function alertsHomeSection() {
  if (!S.alerts.length) return '';
  const act = S.alerts.filter(a => !a.hitAt), hit = S.alerts.filter(a => a.hitAt);
  return `<h2 class="section">🔔 Alertas de preço <small class="muted">${act.length} ativo${act.length === 1 ? '' : 's'}</small></h2>
    <div class="list">${[...hit, ...act].map(a => alertRow(a, true)).join('')}</div>`;
}

const fmtNum = v => v >= 1 ? v.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) : v.toLocaleString('pt-BR', { maximumSignificantDigits: 4 });
function parseLocalPrice(str) {
  const t = String(str).trim(); if (!t) return null;
  // aceita "1.234,56", "1234,56", "0,0000123" e "1234.56"
  const n = /,/.test(t) || /^\d{1,3}(\.\d{3})+$/.test(t) ? parseFloat(t.replace(/\./g, '').replace(',', '.')) : parseFloat(t);
  return n > 0 ? n : null;
}
function alertHint() {
  const el = $('#alertHint'); if (!el) return;
  const v = parseLocalPrice($('#alertPrice').value), p = price(S.detail);
  if (!v || !p) { el.textContent = ''; return; }
  const usd = S.cur === 'BRL' && S.rate ? v / S.rate : v;
  const d = usd / p - 1;
  el.innerHTML = Math.abs(d) < 0.0005 ? 'Esse é praticamente o preço atual.'
    : `Avisar quando <b class="${d > 0 ? 'up' : 'down'}">${d > 0 ? 'SUBIR' : 'CAIR'}</b> ${pct(Math.abs(d), 1).replace(/^[+−]/, '')} até ${money(usd)}.`;
}
function addAlert() {
  const sym = S.detail, p = price(sym);
  const v = parseLocalPrice($('#alertPrice').value);
  if (!v || !p) return toast('Digite um preço válido.');
  const usd = S.cur === 'BRL' && S.rate ? v / S.rate : v;
  if (Math.abs(usd / p - 1) < 0.0005) return toast('Escolha um preço diferente do atual.');
  const a = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), sym, price: usd, dir: usd > p ? 'above' : 'below', at: Date.now(), ref: p };
  S.alerts.push(a); saveAlerts();
  toast(`🔔 Alerta criado: avisar quando ${sym} ${a.dir === 'above' ? 'subir' : 'cair'} até ${money(usd)}.${S.pushCfg ? '<br><span class="muted">Atualize o código do aparelho no GitHub para receber com o app fechado.</span>' : ''}`);
  refreshAlertUI();
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
}
function refreshAlertUI() {
  const card = $('#alertsCard'); if (card && S.detail) card.outerHTML = alertsCard(coinBySym[S.detail]);
  if (S.rangeData && S.detail) setChartData(false);
  renderHome(true);
}

async function fireAlert(a, priceUsd) {
  if (a.hitAt) return;
  a.hitAt = Date.now(); saveAlerts();
  const c = coinBySym[a.sym];
  const { title, body } = alertMessage(a, c?.name || a.sym, money(a.price));
  toast(`<b>${esc(title)}</b><br><span class="muted">${esc(body)} Agora: ${money(priceUsd)}.</span>`, () => openDetail(a.sym));
  navigator.vibrate?.([40, 60, 40]);
  if ('Notification' in window && Notification.permission === 'granted') {
    const reg = await navigator.serviceWorker?.getRegistration();
    reg?.showNotification(title, { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: `al-${a.id}`, data: { url: `./?coin=${a.sym}` } });
  }
  refreshAlertUI();
}
let lastAlCheck = 0;
function checkAlertsLive() {
  if (Date.now() - lastAlCheck < 1000) return; lastAlCheck = Date.now();
  for (const a of S.alerts) {
    if (a.hitAt) continue;
    const p = S.tickers[a.sym]?.price; if (!p) continue;
    if (a.dir === 'above' ? p >= a.price : p <= a.price) fireAlert(a, p);
  }
}
async function reconcileAlerts() {
  for (const a of S.alerts.filter(a => !a.hitAt)) {
    try { const ks = await fetchKlines(a.sym, '1h', 1000, a.at - 36e5); const h = alertHit(a, ks); if (h) fireAlert(a, ks.at(-1).c); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Comparar moedas lado a lado
// ---------------------------------------------------------------------------
const CMP_RANGES = { '7D': 7, '1M': 30, '1A': 365, 'TUDO': 5000 };
function openCompare(sym) {
  const base = sym ? [sym, sym === 'BTC' ? 'ETH' : 'BTC'] : (S.favs.length >= 2 ? S.favs.slice(0, 3) : ['BTC', 'ETH', 'SOL']);
  S.cmp = { syms: base.filter(x => coinBySym[x]), range: S.cmp?.range || '1A', picking: false };
  const sh = $('#cmpSheet'); sh.classList.add('open'); sh.setAttribute('aria-hidden', 'false'); sh.scrollTop = 0;
  renderCompare();
}
function closeCompare() { const sh = $('#cmpSheet'); sh.classList.remove('open'); sh.setAttribute('aria-hidden', 'true'); }

function cmpSeries(sym, days) {
  if (days === 7 && S.hourly[sym]?.length) return S.hourly[sym].map(k => ({ t: k.t, c: k.c }));
  const d = S.daily[sym] || []; return d.slice(-days - 1).map(k => ({ t: k.t, c: k.c }));
}
function cmpMetrics(sym, start) {
  const c = coinBySym[sym], d = S.daily[sym] || [], a = S.analysis[sym], t = S.tickers[sym] || {}, m = S.markets[c.id] || {};
  const p = price(sym) ?? d.at(-1)?.c;
  const back = n => (d.length > n ? p / d[d.length - 1 - n].c - 1 : null);
  const yr = d.slice(-365).map(k => k.c);
  let peak = -Infinity, mdd = 0; for (const v of yr) { peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); }
  // correlação dos retornos diários com o BTC (90 dias)
  let corr = null;
  const b = S.daily.BTC;
  if (b && sym !== 'BTC' && d.length > 91) {
    const bm = new Map(b.map(k => [k.t, k.c])); const xs = [], ys = [];
    for (let i = d.length - 90; i < d.length; i++) { const b0 = bm.get(d[i - 1].t), b1 = bm.get(d[i].t); if (b0 && b1) { xs.push(d[i].c / d[i - 1].c - 1); ys.push(b1 / b0 - 1); } }
    if (xs.length > 30) { const mx = xs.reduce((s, x) => s + x, 0) / xs.length, my = ys.reduce((s, y) => s + y, 0) / ys.length;
      let sxy = 0, sxx = 0, syy = 0; xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; syy += (ys[i] - my) ** 2; });
      corr = sxy / Math.sqrt(sxx * syy); }
  } else if (sym === 'BTC') corr = 1;
  const x = athAtl(c);
  const s0 = start != null ? (S.cmp.range === '7D' ? S.hourly[sym] : d)?.find(k => k.t >= start)?.c : null;
  const lots = S.positions.filter(q => q.sym === sym && q.status !== 'sold');
  return {
    price: p, ch24: t.change ?? null, r7: back(7), r30: back(30), r365: back(365),
    ath: x ? p / x.ath - 1 : null, vol: a?.atrPct ?? null, mdd: yr.length > 30 ? mdd : null, corr,
    mcap: m.marketCap ?? null, rank: m.rank ?? null, score: a?.ok ? a.score : null, verdict: a?.ok ? a.verdict : null,
    win: a?.bt?.events ? a.bt.winRate : null, events: a?.bt?.events ?? 0,
    k1000: s0 ? 1000 * (p / s0) * (1 - PARAMS.costPct) : null,
    hold: lots.length ? lots.reduce((s2, q) => s2 + valueUsd(q, p), 0) : null,
  };
}

function renderCompare() {
  const C = S.cmp, days = CMP_RANGES[C.range];
  const raw = C.syms.map(sym => ({ sym, pts: cmpSeries(sym, days) })).filter(x => x.pts.length > 1);
  // início em comum (a moeda mais nova define o começo) para a comparação ser justa
  const start = raw.length ? Math.max(...raw.map(x => x.pts[0].t)) : null;
  const series = raw.map(({ sym, pts }) => {
    const ps = pts.filter(p => p.t >= start); const p0 = ps[0]?.c;
    const live = price(sym); if (live && ps.length) ps[ps.length - 1] = { ...ps[ps.length - 1], c: live };
    return { label: sym, color: coinBySym[sym].color, points: ps.map(p => ({ t: p.t, v: p.c / p0 - 1 })) };
  });
  const M = Object.fromEntries(C.syms.map(sym => [sym, cmpMetrics(sym, start)]));
  const unit = S.cur === 'BRL' && S.rate ? 1000 / S.rate : 1000;
  const rows = [
    ['Preço agora', v => money(v.price), null],
    ['24 horas', v => pctCell(v.ch24), 'high', 'ch24'],
    ['7 dias', v => pctCell(v.r7), 'high', 'r7'],
    ['30 dias', v => pctCell(v.r30), 'high', 'r30'],
    ['1 ano', v => pctCell(v.r365), 'high', 'r365'],
    [`${curSym()} 1.000 no início do período`, v => v.k1000 == null ? '—' : `<span class="${cls(v.k1000 - 1000)}">${money(v.k1000 * unit / 1000)}</span>`, 'high', 'k1000'],
    ['Distância da máx. histórica', v => pctCell(v.ath, 0), 'high', 'ath'],
    ['Volatilidade diária', v => v.vol == null ? '—' : `${(v.vol * 100).toFixed(1).replace('.', ',')}%`, 'low', 'vol'],
    ['Pior queda em 1 ano', v => pctCell(v.mdd, 0), 'high', 'mdd'],
    ['Correlação com o BTC', v => v.corr == null ? '—' : v.corr.toFixed(2).replace('.', ','), null],
    ['Valor de mercado', v => v.mcap ? money(v.mcap, { compact: true }) : '—', 'high', 'mcap'],
    ['Distância do gatilho', v => v.score == null ? '—' : `<b style="color:${scoreColor(v.score)}">${v.score}</b>`, 'high', 'score'],
    ['Sinal do app', v => v.verdict ? `<span class="chip ${VERDICT[v.verdict].cls}">${VERDICT[v.verdict].label}</span>` : '—', null],
    ['Acerto do repique', v => v.win == null ? '—' : `${pct0(v.win)}<small> (${v.events})</small>`, 'high', 'win'],
    ['Na sua carteira', v => v.hold == null ? '—' : money(v.hold), null],
  ];
  const bestOf = (key, dir) => { if (!dir) return null; const vals = C.syms.map(s2 => M[s2][key]).filter(x => x != null); if (vals.length < 2) return null; return dir === 'high' ? Math.max(...vals) : Math.min(...vals); };
  const others = COINS.filter(c => !C.syms.includes(c.sym));
  $('#cmpInner').innerHTML = `
    <div class="sheet-nav"><button class="back" id="closeCmp" aria-label="Voltar"><svg width="20" height="20" viewBox="0 0 24 24"><path fill="currentColor" d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z"/></svg></button><b style="font-size:17px">⚖️ Comparar moedas</b><span style="width:38px"></span></div>
    <div class="cmp-pick">${C.syms.map(sym => { const c = coinBySym[sym]; return `<span class="cmp-chip" style="border-color:${c.color};background:${c.color}22">${coinIcon(c)}<b>${sym}</b>${C.syms.length > 2 ? `<button data-cmprm="${sym}" aria-label="Remover">×</button>` : ''}</span>`; }).join('')}
      ${C.syms.length < 4 ? `<button class="cmp-add" data-cmpadd="1">＋ Moeda</button>` : ''}</div>
    ${C.picking ? `<div class="cmp-list">${others.map(c => `<button class="cmp-opt" data-cmpput="${c.sym}">${coinIcon(c)}<span>${c.sym}</span></button>`).join('')}</div>` : ''}
    <div class="card" style="padding:12px 0 8px">
      <div class="cmp-legend" id="cmpLegend">${series.map(s2 => `<span><i style="background:${s2.color}"></i>${s2.label} <b class="${cls(s2.points.at(-1).v)}">${pct(s2.points.at(-1).v, 1)}</b></span>`).join('')}</div>
      <canvas id="cmpChart" class="cmp-chart"></canvas>
      <div class="ranges" style="margin:6px 12px 0">${Object.keys(CMP_RANGES).map(r => `<button data-cmprange="${r}" class="${r === C.range ? 'on' : ''}">${r === 'TUDO' ? 'Tudo' : r}</button>`).join('')}</div>
      <p class="note" style="padding:0 14px">Variação em % desde ${start ? fmtDate(start) : '—'}${C.range === 'TUDO' ? ' (início da moeda mais nova, para comparar no mesmo período)' : ''}.</p>
    </div>
    <div class="cmp-table-wrap"><table class="cmp-table">
      <thead><tr><th></th>${C.syms.map(sym => `<th style="color:${coinBySym[sym].color}" data-open="${sym}">${sym}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(([label, fmt, dir, key]) => { const best = key ? bestOf(key, dir) : null;
        return `<tr><td>${label}</td>${C.syms.map(sym => `<td class="${best != null && M[sym][key] === best ? 'best' : ''}">${fmt(M[sym])}</td>`).join('')}</tr>`; }).join('')}</tbody>
    </table></div>
    <p class="note">Destaque verde = melhor da linha. Volatilidade = variação média diária (ATR). Correlação perto de 1 = anda junto com o Bitcoin; diversifica pouco. "Acerto do repique" = quantas vezes a estratégia do app deu certo nessa moeda (casos entre parênteses).</p>`;
  const ch = new MultiLineChart($('#cmpChart'), {
    onHover: h => { const el = $('#cmpLegend'); if (!el) return;
      const vals = h ? h.values : series.map(s2 => ({ label: s2.label, color: s2.color, v: s2.points.at(-1).v }));
      el.innerHTML = vals.map(x => `<span><i style="background:${x.color}"></i>${x.label} <b class="${cls(x.v ?? 0)}">${x.v == null ? '—' : pct(x.v, 1)}</b></span>`).join('') + (h ? `<span class="muted">${fmtDateTime(h.t, C.range === '7D' ? '7D' : '1A')}</span>` : ''); },
  });
  ch.setData(series);
}
const pctCell = (v, d = 1) => (v == null ? '—' : `<span class="${cls(v)}">${pct(v, d)}</span>`);

function holdingCard(c) {
  const lots = S.positions.filter(p => p.sym === c.sym && p.status !== 'sold');
  if (!lots.length) return '';
  const px = price(c.sym) ?? lots[0].entry;
  const q = lots.reduce((a, p) => a + p.qty, 0), cost = lots.reduce((a, p) => a + p.costUsd, 0), v = lots.reduce((a, p) => a + valueUsd(p, px), 0);
  return `<div class="card holding" style="border:1px solid ${c.color}55;background:linear-gradient(135deg, ${c.color}22, var(--card) 60%)">
    <h3>👛 Na sua carteira <span class="chip neutral">${lots.length} compra${lots.length > 1 ? 's' : ''}</span></h3>
    <div class="grid2">
      <div class="stat"><div class="k">Quantidade</div><div class="v num">${qty(q, c.sym)}</div><div class="s">preço médio ${money((cost * (1 - PARAMS.costPct / 2)) / q)}</div></div>
      <div class="stat ${v >= cost ? 'ath' : 'atl'}"><div class="k">Vale agora</div><div class="v num">${money(v)}</div><div class="s ${cls(v - cost)}">${money(v - cost, { sign: true })} (${pct(v / cost - 1)})</div></div>
    </div>
    <button class="btn ghost" data-sellall="${c.sym}" style="margin-top:12px">Vender tudo de ${c.sym}</button>
  </div>`;
}

function detailAnalysis(c, a) {
  const v = VERDICT[a.verdict];
  const bt = a.bt;
  const groups = {};
  a.parts.forEach(p => { (groups[p.group] ||= []).push(p); });
    return `
    <div class="card">
      <div class="verdict">
        <div class="ring"><canvas id="ring"></canvas><div class="val num" style="color:${scoreColor(a.score)}">${a.score}<small>gatilho</small></div></div>
        <div><div class="verdict-title">${v.title}</div><div class="verdict-txt">${esc(a.summary)}</div></div>
      </div>
      <ul class="reasons">
        ${a.reasons.map(r => `<li>${esc(r)}</li>`).join('')}
        ${a.warnings.map(r => `<li class="warn">${esc(r)}</li>`).join('')}
      </ul>
    </div>

    <div class="card"><h3>📊 Prova estatística</h3>
      <div class="note" style="margin:0 0 8px">Estudo com ${STUDY.coins} moedas (${STUDY.events} casos, ${STUDY.from.slice(0, 4)}–${STUDY.to.slice(0, 4)})</div>
      <div class="compare" style="margin-top:0">
        <div class="lbl"><span><b>Alertas do app</b> (pânico + clima ok)</span><b class="up">${pct0(STUDY.alerts.win)}</b></div>
        <div class="track"><i style="width:${STUDY.alerts.win * 100}%;background:linear-gradient(90deg,var(--violet),var(--up))"></i></div>
        <div class="lbl"><span>Subiram em ${PARAMS.horizon} dias após o gatilho (todos)</span><b class="up">${pct0(STUDY.winRate)}</b></div>
        <div class="track"><i style="width:${STUDY.winRate * 100}%;background:var(--up)"></i></div>
        <div class="lbl"><span>Após gatilho forte (RSI &lt; 25)</span><b class="up">${pct0(STUDY.strongWinRate)}</b></div>
        <div class="track"><i style="width:${STUDY.strongWinRate * 100}%;background:linear-gradient(90deg,#1fbf87,var(--up))"></i></div>
        <div class="lbl"><span>Comprando num dia qualquer</span><b>${pct0(STUDY.baseWinRate)}</b></div>
        <div class="track"><i style="width:${STUDY.baseWinRate * 100}%;background:var(--muted)"></i></div>
      </div>
      <h3 style="margin:16px 0 10px;font-size:14px">Nesta moeda (${c.sym}) <span class="chip ${!bt.events ? 'neutral' : a.ruleWorks ? 'buy' : 'avoid'}">${!bt.events ? 'SEM CASOS' : bt.events < 5 ? 'POUCOS CASOS' : a.ruleWorks ? 'CONFIRMA' : 'FUNCIONOU POUCO'}</span></h3>
      <div class="bt-row">
        <div class="stat"><div class="k">Casos</div><div class="v num">${bt.events}</div></div>
        <div class="stat"><div class="k">Acerto ${bt.horizon}d</div><div class="v num ${bt.winRate == null ? '' : bt.winRate >= bt.baseWinRate ? 'up' : 'down'}">${pct0(bt.winRate)}</div><div class="s">base ${pct0(bt.baseWinRate)}</div></div>
        <div class="stat"><div class="k">Mediana</div><div class="v num ${cls(bt.medianRet ?? 0)}">${pct(bt.medianRet, 1)}</div><div class="s">base ${pct(bt.baseMedianRet, 1)}</div></div>
      </div>
      <p class="note">${esc(a.statsText)} Valores já descontam ${(PARAMS.costPct * 100).toFixed(1).replace('.', ',')}% de taxas.</p>
    </div>

    ${alertsCard(c)}
    ${holdingCard(c)}
    <div class="card"><h3>💰 Simulação de compra <span class="chip neutral">saldo ${S.wallet ? money(S.wallet.cashUsd) : '—'}</span></h3>
      <div class="amount"><span>${curSym()}</span><input id="amt" inputmode="decimal" value="${String(S.amount).replace('.', ',')}"></div>
      <div class="quick">${[100, 500, 1000, 5000].map(q => `<button data-amt="${q}">${q.toLocaleString('pt-BR')}</button>`).join('')}</div>
      <div id="simOut"></div>
      <button class="btn primary" id="simBuy">Simular compra agora</button>
    </div>

    <div class="card"><h3>🎯 Distância do gatilho</h3>
      ${Object.entries(groups).map(([g, ps]) => ps.map((p, i) => `
        <div class="factor"><div>${i === 0 ? `<div class="g">${g}</div>` : ''}${esc(p.text)}</div>
          <div class="pts num" style="color:${p.ok ? 'var(--up)' : 'var(--gold)'}">${p.max ? `${p.pts}/${p.max}` : p.ok ? '▲' : '▼'}</div>
          ${p.max ? `<div class="bar"><i style="width:${Math.max(0, p.pts) / p.max * 100}%;background:${p.ok ? 'var(--up)' : 'var(--gold)'}"></i></div>` : ''}</div>`).join('')).join('')}
    </div>

    <div class="card"><h3>🛡️ Gestão de risco</h3>
      <div class="grid2">
        <div class="stat atl"><div class="k">Stop sugerido</div><div class="v num">${money(a.stop)}</div><div class="s">${pct(a.stop / a.price - 1, 1)} (2× ATR)</div></div>
        <div class="stat ath"><div class="k">Alvo sugerido</div><div class="v num">${money(a.target)}</div><div class="s">${pct(a.target / a.price - 1, 1)} (2× ATR) · prazo ~${PARAMS.horizon} dias</div></div>
      </div>
      <p class="note">ATR = variação média diária (${pct0(a.atrPct)} ao dia). Stop é o ponto em que a tese de compra deixa de valer.</p>
    </div>`;
}

function parseAmount() {
  const raw = ($('#amt')?.value || '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(raw);
  return isFinite(n) && n > 0 ? n : 0;
}

const quantileMid = d => { const s = [...d].sort((x, y) => x - y); return s[s.length >> 1]; };
function updateSim() {
  const out = $('#simOut'); if (!out) return;
  const sym = S.detail, a = S.analysis[sym], p = price(sym);
  const amount = parseAmount();
  const priceLocal = conv(p);
  const q = priceLocal ? (amount * (1 - PARAMS.costPct / 2)) / priceLocal : 0;
  const sim = simulate(amount, a);
  // "e se eu tivesse comprado no último sinal?"
  const d = S.daily[sym];
  const lastSig = a.signalTimes.filter(t => t < Date.now() - 864e5).at(-1);
  let lastTxt = '';
  if (lastSig && d) {
    const k = d.find(k => k.t === lastSig);
    if (k) {
      const ret = p / k.c - 1 - PARAMS.costPct;
      lastTxt = `<div class="live-sim">⏱️ Se você tivesse investido <b>${moneyLocal(amount)}</b> no último sinal (${fmtDate(lastSig)}, a ${money(k.c)}), hoje teria <b class="${cls(ret)}" data-live-ret>${moneyLocal(amount * (1 + ret))}</b> <span class="${cls(ret)}">(${pct(ret, 1)})</span>.</div>`;
    }
  }
  out.innerHTML = `
    <p style="margin:12px 0 0;font-size:14px">Você compraria <b class="num">≈ ${qty(q, sym)}</b> a <b class="num">${money(p)}</b></p>
    ${sim ? `
      <div class="muted" style="font-size:12px;margin-top:12px">Resultado em ${sim.horizon} dias após o gatilho, com base em ${sim.cases} casos reais ${sim.source === 'coin' ? `de ${sym}` : `de ${STUDY.coins} moedas`}:</div>
      <div class="scen">
        <div class="stat atl"><div class="k">Pessimista</div><div class="v num ${cls(sim.pessimistic - amount)}">${moneyLocal(sim.pessimistic)}</div><div class="s">${pct(sim.pessimistic / amount - 1, 1)}</div></div>
        <div class="stat"><div class="k">Provável</div><div class="v num ${cls(sim.median - amount)}">${moneyLocal(sim.median)}</div><div class="s">${pct(sim.median / amount - 1, 1)}</div></div>
        <div class="stat ath"><div class="k">Otimista</div><div class="v num ${cls(sim.optimistic - amount)}">${moneyLocal(sim.optimistic)}</div><div class="s">${pct(sim.optimistic / amount - 1, 1)}</div></div>
      </div>
      <canvas class="hist" id="hist"></canvas>
      <div class="prob"><span>Chance de lucro</span><div class="track"><i style="width:${sim.probProfit * 100}%"></i></div><b class="num ${sim.probProfit >= 0.5 ? 'up' : 'down'}">${pct0(sim.probProfit)}</b></div>
      <p class="note">Lucro provável: <b class="${cls(sim.median - amount)}">${moneyLocal(sim.median - amount, true)}</b> · média esperada: ${moneyLocal(sim.expected - amount, true)}. Cada barra do gráfico mostra quantas vezes o resultado caiu naquela faixa.</p>`
      : '<p class="note">Ainda não há sinais suficientes no histórico desta moeda para simular resultados.</p>'}
    ${lastTxt}`;
  if (sim) drawHistogram($('#hist'), sim.dist, quantileMid(sim.dist));
}

async function loadRange() {
  const sym = S.detail, range = S.range;
  try {
    let data;
    if (range === '1A' && S.daily[sym]) data = S.daily[sym].slice(-365).map(k => ({ ...k }));
    else { const r = RANGES[range]; data = await fetchKlines(sym, r.interval, r.limit); }
    if (S.detail !== sym || S.range !== range) return;
    S.rangeData = { sym, range, data };
    setChartData(true);
  } catch {
    if (S.detail === sym) $('#dChg').innerHTML = '<span class="down">Falha ao carregar o gráfico.</span>';
  }
}

function setChartData(animate) {
  const { data, sym } = S.rangeData;
  const a = S.analysis[sym];
  const x = athAtl(coinBySym[sym]);
  const markers = ['1A', 'TUDO', '1M'].includes(S.range) && a?.ok ? a.signalTimes : [];
  S.chart?.setData(data, { markers, ath: x?.ath, animate, lines: chartAlertLines(sym) });
  updateDetailLive(true);
}

function updateDetailLive(force) {
  if (!S.detail || !S.chart || S.chart.hover != null) return;
  const sym = S.detail, p = price(sym), t = S.tickers[sym] || {};
  const el = $('#dPrice'); if (!el) return;
  const prev = el.dataset.v ? +el.dataset.v : null;
  el.textContent = money(p);
  if (prev != null && p !== prev && !force) { el.classList.remove('flash-up', 'flash-down'); void el.offsetWidth; el.classList.add(p > prev ? 'flash-up' : 'flash-down'); }
  el.dataset.v = p;
  const rd = S.rangeData?.sym === sym && S.rangeData.range === S.range ? S.rangeData.data : null;
  if (rd?.length) {
    const ch = p / rd[0].o - 1;
    const lbl = { '24H': 'nas últimas 24h', '7D': 'em 7 dias', '1M': 'em 1 mês', '1A': 'em 1 ano', 'TUDO': 'desde o início' }[S.range];
    $('#dChg').innerHTML = `<span class="${cls(ch)}">${pct(ch)} (${money(p - rd[0].o, { sign: true })})</span> <span class="muted">${lbl}</span>`;
  }
  $('#dHigh') && ($('#dHigh').textContent = money(t.high));
  $('#dLow') && ($('#dLow').textContent = money(t.low));
  const x = athAtl(coinBySym[sym]);
  const da = $('[data-dist-ath]'); if (da && x) { da.textContent = pct(p / x.ath - 1, 1); da.className = cls(p / x.ath - 1); }
  const dl = $('[data-dist-atl]'); if (dl && x) dl.textContent = pct(p / x.atl - 1, 0);
  if (!force) S.chart.updateLast(p);
  if (document.activeElement?.id !== 'amt') updateSim();
}

// ---------------------------------------------------------------------------
// Tempo real
// ---------------------------------------------------------------------------
let pending = new Set(), raf = 0;
function onTick(sym, tk) {
  if (sym === 'USDTBRL') { S.rate = tk.price; return; }
  const prev = S.tickers[sym]?.price;
  S.tickers[sym] = { ...S.tickers[sym], ...tk, prev };
  pending.add(sym);
  if (!raf) raf = requestAnimationFrame(flush);
}
function flush() {
  raf = 0;
  for (const sym of pending) {
    const t = S.tickers[sym];
    $$(`[data-price="${sym}"]`).forEach(el => {
      el.textContent = money(t.price);
      if (t.prev != null && t.prev !== t.price) { el.classList.remove('flash-up', 'flash-down'); void el.offsetWidth; el.classList.add(t.price > t.prev ? 'flash-up' : 'flash-down'); }
    });
    $$(`[data-chg="${sym}"]`).forEach(el => { el.textContent = pct(t.change); el.className = `chg num ${cls(t.change)}`; });
    if (S.detail === sym) updateDetailLive(false);
    const sp = S.spark[sym]; if (sp) sp[sp.length - 1] = t.price;
  }
  pending.clear();
  checkPositions();
  checkAlertsLive();
  if (S.view === 'sim' && S.positions.length) renderSim(true);
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------
function b64ToUint8(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, ch => ch.charCodeAt(0));
}

async function enablePush() {
  const out = $('#pushOut');
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    out.innerHTML = '<div class="err">Este navegador não suporta notificações. No iPhone, instale o app na Tela de Início (iOS 16.4+) e abra por lá.</div>'; return;
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { out.innerHTML = '<div class="err">Permissão negada. Ative em Ajustes do iPhone › Notificações › Radar Cripto.</div>'; renderSettingsKeepOut(); return; }
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(VAPID_PUBLIC_KEY) });
    const cfg = radarCfg();
    const json = JSON.stringify({ ...sub.toJSON(), radar: cfg });
    S.pushCfg = JSON.stringify(cfg); store.set('pushCfg', S.pushCfg);
    out.innerHTML = `<p class="note">✅ Notificações no app ativas. Para receber com o app <b>fechado</b>, copie o código abaixo e salve no GitHub em <b>Settings › Secrets and variables › Actions › New repository secret</b> com o nome <b>PUSH_SUBSCRIPTIONS</b> (só precisa fazer uma vez).</p>
      <textarea class="code" readonly id="subJson">${esc(json)}</textarea>
      <button class="btn ghost" id="copySub">Copiar código</button>`;
    $('#copySub').onclick = async () => { try { await navigator.clipboard.writeText(json); toast('Código copiado ✅'); } catch { $('#subJson').select(); } };
  } catch (e) {
    out.innerHTML = `<div class="err">Não foi possível registrar o push: ${esc(e.message)}. Abra o app pelo ícone da Tela de Início.</div>`;
  }
}
function renderSettingsKeepOut() { /* mantém a mensagem de erro visível */ }

// Configuração que vai junto do código do aparelho, para o robô no GitHub saber o que monitorar
const pushCfgStale = () => !!S.pushCfg && S.pushCfg !== JSON.stringify(radarCfg());
function radarCfg() {
  return { notify: S.notifyMode, favs: [...S.favs].sort(), extra: customCoins().map(c => c.sym).sort(),
    pos: S.positions.filter(p => p.status === 'open').map(compactPos),
    al: S.alerts.filter(a => !a.hitAt).map(compactAlert),
    dg: { on: S.digest.on, h: S.digest.h, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo' } };
}

// ---------------------------------------------------------------------------
// Adicionar / remover moedas
// ---------------------------------------------------------------------------
const customCoins = () => store.get('customCoins', []);
let searchSeq = 0;
async function searchCoins(q) {
  const out = $('#coinResults'); if (!out) return;
  q = q.trim().toUpperCase();
  if (!q) { out.innerHTML = ''; return; }
  const seq = ++searchSeq;
  out.innerHTML = '<p class="note">Buscando…</p>';
  try {
    const all = await fetchAllUsdtSymbols();
    if (seq !== searchSeq) return;
    const hits = all.filter(t => t.sym.startsWith(q)).slice(0, 8);
    out.innerHTML = hits.length ? `<div class="list" style="margin-top:10px">${hits.map(t => {
      const has = !!coinBySym[t.sym];
      return `<div class="row">${coinIcon({ sym: t.sym, color: colorFor(t.sym) })}<div class="meta"><div class="name">${t.sym}</div><div class="sub">Volume 24h ${money(t.quoteVol, { compact: true })}</div></div>
        ${has ? '<span class="chip buy">ADICIONADA</span>' : `<button class="chip watch" style="padding:6px 12px" data-add="${t.sym}">＋ Adicionar</button>`}</div>`;
    }).join('')}</div>` : '<p class="note">Nenhum par com USDT encontrado na Binance.</p>';
  } catch { out.innerHTML = '<div class="err">Não foi possível buscar agora. Tente de novo.</div>'; }
}

async function addCoin(sym) {
  if (coinBySym[sym]) return;
  const list = customCoins();
  list.push({ sym, name: sym, color: colorFor(sym), custom: true });
  store.set('customCoins', list);
  buildCoins(); startLive();
  toast(`✅ <b>${sym}</b> adicionada. Baixando histórico…`);
  const c = coinBySym[sym];
  try {
    const [d, h] = await Promise.all([fetchDaily(sym), fetchKlines(sym, '1h', 168).catch(() => null)]);
    S.daily[sym] = d; if (h) { S.spark[sym] = h.map(k => k.c); S.hourly[sym] = h; }
    S.analysis[sym] = analyze(d, PARAMS, STUDY);
    S.regime = marketRegime(S.daily.BTC); applyBreadth(S.analysis, PARAMS, STUDY, S.regime);
    Object.assign(S.tickers, await fetchTickers24h([c]).catch(() => ({})));
  } catch { toast(`Não consegui baixar os dados de ${sym}.`); }
  renderAll();
  const inp = $('#coinSearch'); if (inp) { inp.value = ''; }
}

function removeCoin(sym) {
  store.set('customCoins', customCoins().filter(c => c.sym !== sym));
  S.favs = S.favs.filter(f => f !== sym); store.set('favs', S.favs);
  delete S.analysis[sym]; delete S.daily[sym];
  buildCoins(); startLive(); renderAll();
}

function currentDigest() {
  const coins = Object.entries(S.analysis).filter(([, a]) => a?.ok).map(([sym, a]) => ({ sym, score: a.score, verdict: a.verdict }));
  const favs = S.notifyMode === 'favorites' ? S.favs : null;
  const buys = coins.filter(c => c.verdict === 'buy' && (!favs || favs.includes(c.sym))).map(c => c.sym);
  const positions = S.positions.filter(p => p.status !== 'sold' && price(p.sym)).map(p => ({ sym: p.sym, ret: price(p.sym) / p.entry - 1 - PARAMS.costPct }));
  return buildDigest({ btcChange: S.tickers.BTC?.change ?? null, regime: S.regime?.state, fng: S.fng?.at(-1)?.v ?? null, coins, favs, positions, buys });
}
async function previewDigest() {
  const { title, body } = currentDigest();
  toast(`<b>${esc(title)}</b><br><span class="muted" style="white-space:pre-line">${esc(body)}</span>`);
  if ('Notification' in window && Notification.permission === 'granted') {
    const reg = await navigator.serviceWorker?.getRegistration();
    reg?.showNotification(title, { body, icon: 'icons/icon-192.png', tag: 'radar-digest', data: { url: './' } });
  }
}

async function testNotif() {
  if (!('Notification' in window)) return toast('Notificações indisponíveis neste navegador.');
  if (Notification.permission !== 'granted') { const p = await Notification.requestPermission(); if (p !== 'granted') return toast('Permissão de notificação negada.'); }
  const reg = await navigator.serviceWorker?.getRegistration();
  const best = ranked()[0];
  const title = best ? `🧪 Teste · ${best.c.name} com pontuação ${best.a.score}` : '🧪 Teste do Radar Cripto';
  const body = 'É assim que você será avisado quando uma moeda estiver boa para compra.';
  if (reg) reg.showNotification(title, { body, icon: 'icons/icon-192.png', data: { url: best ? `./?coin=${best.c.sym}` : './' } });
  else new Notification(title, { body });
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------
function switchView(v) {
  S.view = v;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
  $$('.view').forEach(s => s.classList.toggle('active', s.id === `view-${v}`));
  window.scrollTo({ top: 0 });
  if (v === 'settings') renderSettings();
  if (v === 'sim') renderSim();
  if (v === 'home') requestAnimationFrame(() => { drawSparks(); drawClimate(); });
}

document.addEventListener('click', e => {
  const tab = e.target.closest('.tab'); if (tab) return switchView(tab.dataset.view);
  if (e.target.closest('#addAlert')) return addAlert();
  const cmp = e.target.closest('[data-compare]'); if (cmp) return openCompare(cmp.dataset.compare || null);
  if (e.target.closest('#closeCmp')) return closeCompare();
  const crm = e.target.closest('[data-cmprm]'); if (crm) { S.cmp.syms = S.cmp.syms.filter(x => x !== crm.dataset.cmprm); return renderCompare(); }
  if (e.target.closest('[data-cmpadd]')) { S.cmp.picking = !S.cmp.picking; return renderCompare(); }
  const cput = e.target.closest('[data-cmpput]'); if (cput) { S.cmp.syms.push(cput.dataset.cmpput); S.cmp.picking = false; return renderCompare(); }
  const crg = e.target.closest('[data-cmprange]'); if (crg) { S.cmp.range = crg.dataset.cmprange; return renderCompare(); }
  const alq = e.target.closest('[data-alq]');
  if (alq) { const p = price(S.detail); if (p) { $('#alertPrice').value = fmtNum(conv(p * (1 + alq.dataset.alq / 100))); alertHint(); } return; }
  const da = e.target.closest('[data-delalert]');
  if (da) { S.alerts = S.alerts.filter(a => a.id !== da.dataset.delalert); saveAlerts(); refreshAlertUI(); return; }
  const dp = e.target.closest('[data-delpos]');
  if (dp) {
    const p = S.positions.find(x => x.id === dp.dataset.delpos);
    if (p && S.wallet) { S.wallet.cashUsd += p.status === 'sold' ? p.costUsd - p.soldValueUsd : p.costUsd; saveWallet(); } // desfaz a operação
    S.positions = S.positions.filter(x => x.id !== dp.dataset.delpos); savePositions(); renderSim(); return;
  }
  const wr = e.target.closest('[data-wrange]'); if (wr) { S.walletRange = wr.dataset.wrange; renderSim(); return; }
  if (e.target.closest('#resetWallet')) {
    const v = parseFloat(($('#resetAmt').value || '').replace(/\./g, '').replace(',', '.'));
    if (!(v > 0)) return toast('Informe um saldo válido.');
    if (!confirm(`Reiniciar a carteira com ${curSym()} ${v.toLocaleString('pt-BR')}? Compras e vendas simuladas serão apagadas.`)) return;
    document.activeElement?.blur(); resetWallet(v); toast('Carteira reiniciada.'); return;
  }
  const sa = e.target.closest('[data-sellall]');
  if (sa) {
    const sym = sa.dataset.sellall, usd = price(sym); if (!usd) return;
    let got = 0;
    for (const p of S.positions.filter(x => x.sym === sym && x.status !== 'sold')) {
      Object.assign(p, { status: 'sold', soldAt: Date.now(), soldPrice: usd, soldValue: posValue(p, usd), soldValueUsd: valueUsd(p, usd), soldReason: 'vender tudo' });
      got += p.soldValueUsd;
    }
    S.wallet.cashUsd += got; saveWallet(); savePositions(); renderSim(); renderDetail();
    toast(`Vendeu todo o ${sym}: <b>+${money(got)}</b> voltou para o saldo.`); return;
  }
  const sl = e.target.closest('[data-sell]');
  if (sl) {
    const p = S.positions.find(x => x.id === sl.dataset.sell); if (!p) return;
    const usd = sl.dataset.at === 'hit' ? p.hitPrice : price(p.sym); if (!usd) return;
    Object.assign(p, { status: 'sold', soldAt: Date.now(), soldPrice: usd, soldValue: posValue(p, usd), soldValueUsd: valueUsd(p, usd),
      soldReason: sl.dataset.at === 'hit' ? (p.hitPrice >= p.entry ? 'no alvo' : 'no stop') : 'manual' });
    S.wallet.cashUsd += p.soldValueUsd; saveWallet();
    savePositions(); renderSim();
    toast(`Venda registrada: <b class="${cls(p.soldValueUsd - p.costUsd)}">${money(p.soldValueUsd - p.costUsd, { sign: true })}</b> · saldo ${money(S.wallet.cashUsd)}`);
    return;
  }
  const ep = e.target.closest('[data-editpos]'); if (ep) { S.editPos = ep.dataset.editpos; renderSim(); return; }
  if (e.target.closest('[data-editdone]')) { S.editPos = null; document.activeElement?.blur(); renderSim(); return; }
  const fv = e.target.closest('[data-fav]'); if (fv) { e.preventDefault(); return toggleFav(fv.dataset.fav); }
  const go = e.target.closest('[data-goto]'); if (go) return switchView(go.dataset.goto);
  const st = e.target.closest('[data-sigtab]'); if (st) { S.sigTab = st.dataset.sigtab; if (S.sigTab === 'hist') loadAlertLog(); renderSignals(); return; }
  const hm = e.target.closest('[data-hmode]'); if (hm) { S.histMode = hm.dataset.hmode; renderSignals(); return; }
  if (e.target.closest('[data-histmore]')) { S.histMore = true; renderSignals(); return; }
  const sf = e.target.closest('[data-sigf]'); if (sf) { S.sigFilter = sf.dataset.sigf; return renderSignals(); }
  const nm = e.target.closest('[data-notify]'); if (nm) { S.notifyMode = nm.dataset.notify; store.set('notifyMode', S.notifyMode); return renderSettings(); }
  const add = e.target.closest('[data-add]'); if (add) return addCoin(add.dataset.add);
  const rm = e.target.closest('[data-rmcoin]'); if (rm) return removeCoin(rm.dataset.rmcoin);
  const open = e.target.closest('[data-open]'); if (open) { if (open.closest('#cmpSheet')) closeCompare(); return openDetail(open.dataset.open); }
  if (e.target.closest('#closeSheet')) return closeDetail();
  const rg = e.target.closest('[data-range]');
  if (rg) { S.range = rg.dataset.range; $$('#ranges button').forEach(b => b.classList.toggle('on', b === rg)); loadRange(); return; }
  const qa = e.target.closest('[data-amt]');
  if (qa) { $('#amt').value = qa.dataset.amt; S.amount = +qa.dataset.amt; store.set('amount', S.amount); updateSim(); return; }
  if (e.target.closest('#simBuy')) {
    const sym = S.detail, p = price(sym), amount = parseAmount();
    if (!p || !amount) return toast('Informe um valor válido.');
    const rate = S.cur === 'BRL' ? S.rate : 1;
    initWallet();
    const costUsd = amount / (rate || 1);
    if (costUsd > S.wallet.cashUsd + 1e-9) return toast(`Saldo insuficiente na carteira fictícia: disponível ${money(S.wallet.cashUsd)}.`);
    S.wallet.cashUsd -= costUsd; saveWallet();
    const atr = S.analysis[sym]?.atrPct ?? 0.05, now = Date.now();
    S.positions.unshift({ id: now.toString(36) + Math.random().toString(36).slice(2, 5), sym, amount, cur: S.cur === 'BRL' && S.rate ? 'BRL' : 'USD', rate: rate || 1,
      entry: p, qty: (amount * (1 - PARAMS.costPct / 2)) / (p * (rate || 1)), at: now, costUsd,
      stop: p * (1 - 2 * atr), target: p * (1 + 2 * atr), exp: now + H_MS(), status: 'open', alerts: {} });
    savePositions(); renderSim();
    toast(`✅ Compra simulada de <b>${moneyLocal(amount)}</b> em ${sym}.<br><span class="muted">Stop ${money(p * (1 - 2 * atr))} · alvo ${money(p * (1 + 2 * atr))}. Você será avisado quando bater um deles.</span>`, () => { closeDetail(); switchView('sim'); });
    return;
  }
  const cb = e.target.closest('[data-cur]');
  if (cb) { S.cur = cb.dataset.cur; store.set('cur', S.cur); renderAll(); if (S.detail) renderDetail(); return; }
  if (e.target.closest('#enablePush')) return enablePush();
  if (e.target.closest('#testNotif')) return testNotif();
  if (e.target.closest('#dgPreview')) return previewDigest();
  const dgo = e.target.closest('[data-dgon]'); if (dgo) { S.digest.on = dgo.dataset.dgon === '1'; store.set('digest', S.digest); return renderSettings(); }
  if (e.target.closest('#refreshBtn')) return loadAll();
});

document.addEventListener('change', e => {
  if (e.target.id === 'dgHour') { S.digest.h = +e.target.value; store.set('digest', S.digest); renderSettings(); toast(`Resumo diário às ${String(S.digest.h).padStart(2, '0')}:00.${S.pushCfg ? '<br><span class="muted">Atualize o código do aparelho no GitHub.</span>' : ''}`); return; }
  const k = e.target.dataset?.edit; if (!k) return;
  const p = S.positions.find(x => x.id === e.target.dataset.id); if (!p) return;
  const v = parseFloat(e.target.value.replace(',', '.')); if (!(v > 0 && v < 95)) return toast('Valor inválido.');
  if (k === 'stop') p.stop = p.entry * (1 - v / 100); else p.target = p.entry * (1 + v / 100);
  p.alerts = {}; savePositions();
});

document.addEventListener('input', e => {
  if (e.target.id === 'coinSearch') return searchCoins(e.target.value);
  if (e.target.id === 'alertPrice') return alertHint();
  if (e.target.id === 'amt') { S.amount = parseAmount(); store.set('amount', S.amount); updateSim(); }
});

// deslizar para baixo no topo da tela de detalhe fecha
(() => {
  const sheet = $('#sheet'); let y0 = null;
  sheet.addEventListener('touchstart', e => { y0 = sheet.scrollTop <= 0 && !e.target.closest('canvas') ? e.touches[0].clientY : null; }, { passive: true });
  sheet.addEventListener('touchend', e => { if (y0 != null && e.changedTouches[0].clientY - y0 > 110) closeDetail(); y0 = null; });
})();

// ---------------------------------------------------------------------------
// Início
// ---------------------------------------------------------------------------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', e => { if (e.data?.coin) openDetail(e.data.coin); });
}

renderAll();
let live;
function startLive() {
  live?.close();
  live = connectLive(COINS, onTick, on => {
    $('#live').classList.toggle('on', on);
    $('#liveTxt').textContent = on ? 'Ao vivo' : 'Reconectando…';
  });
}
startLive();
loadAll().then(() => {
  migratePositions(); initWallet(); reconcilePositions(); reconcileAlerts(); renderSim();
  if (new URLSearchParams(location.search).get('tab') === 'sim') switchView('sim');
  const q = new URLSearchParams(location.search).get('coin');
  if (q && coinBySym[q]) openDetail(q);
});
setInterval(reanalyze, 60e3);             // reanalisa com preço ao vivo a cada 1 min
setInterval(loadAll, 15 * 60e3);          // recarrega candles a cada 15 min
document.addEventListener('visibilitychange', () => { if (!document.hidden) { live.ensure(); reanalyze(); } });
