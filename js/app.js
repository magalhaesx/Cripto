import { COINS, coinBySym } from './coins.js';
import { analyze, simulate, PARAMS } from './analysis.js';
import { fetchDaily, fetchKlines, fetchTickers24h, fetchUsdBrl, fetchMarkets, connectLive, RANGES } from './api.js';
import { PriceChart, drawSpark, drawHistogram, drawScoreRing, scoreColor } from './chart.js';
import { VAPID_PUBLIC_KEY } from './config.js';

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const S = {
  cur: store.get('cur', 'BRL'),
  rate: store.get('rate', null),     // USDT → BRL
  tickers: {}, daily: {}, analysis: {}, markets: {}, spark: {},
  amount: store.get('amount', 1000),
  positions: store.get('positions', []),
  notified: store.get('notified', {}),
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
  buy: { label: 'COMPRA FORTE', title: 'Ótimo momento de compra', cls: 'buy' },
  watch: { label: 'OBSERVAR', title: 'Quase no ponto', cls: 'watch' },
  neutral: { label: 'NEUTRO', title: 'Sem vantagem clara', cls: 'neutral' },
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
  const [tick, rate, markets] = await Promise.allSettled([fetchTickers24h(), fetchUsdBrl(), fetchMarkets()]);
  if (tick.status === 'fulfilled') Object.assign(S.tickers, tick.value);
  if (rate.status === 'fulfilled' && rate.value) { S.rate = rate.value; store.set('rate', S.rate); }
  if (markets.status === 'fulfilled') S.markets = markets.value;

  const results = await Promise.allSettled(COINS.map(async c => {
    const [d, h] = await Promise.all([fetchDaily(c.sym), fetchKlines(c.sym, '1h', 168).catch(() => null)]);
    S.daily[c.sym] = d;
    if (h) S.spark[c.sym] = h.map(k => k.c);
    S.analysis[c.sym] = analyze(d);
  }));
  const failed = results.filter(r => r.status === 'rejected').length;
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
    S.analysis[c.sym] = analyze(d);
  }
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
  for (const { c, a } of ranked()) {
    if (a.verdict !== 'buy') continue;
    if (now - (S.notified[c.sym] || 0) < 24 * 3600e3) continue;
    S.notified[c.sym] = now; store.set('notified', S.notified);
    const title = `🟢 ${c.name} (${c.sym}) está boa para compra`;
    const body = `Pontuação ${a.score}/100 · chance histórica de alta em ${PARAMS.horizon}d: ${pct0(a.bt.winRate)}. ${a.reasons[0] || ''}`;
    toast(`<b>${esc(title)}</b><br><span class="muted">${esc(body)}</span>`, () => openDetail(c.sym));
    if ('Notification' in window && Notification.permission === 'granted') {
      const reg = await navigator.serviceWorker?.getRegistration();
      reg?.showNotification(title, { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: `buy-${c.sym}`, data: { url: `./?coin=${c.sym}` } });
    }
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
  renderHome(soft); renderSignals(); renderSim(); if (!soft) renderSettings();
  const n = ranked().filter(x => x.a.verdict === 'buy').length;
  const b = $('#sigBadge'); b.hidden = !n; b.textContent = n;
  if (S.detail) updateDetailLive(true);
}

function coinRow(c) {
  const t = S.tickers[c.sym], a = S.analysis[c.sym];
  const chg = t?.change;
  const v = a?.ok ? VERDICT[a.verdict] : null;
  return `<button class="row" data-open="${c.sym}">
    ${coinIcon(c)}
    <div class="meta">
      <div class="name">${esc(c.name)}</div>
      <div class="sub">${c.sym}${v ? ` <span class="chip ${v.cls}">${a.score}</span>` : ''}</div>
    </div>
    <canvas class="spark" data-spark="${c.sym}"></canvas>
    <div class="right">
      <div class="price num" data-price="${c.sym}">${money(price(c.sym))}</div>
      <div class="chg num ${cls(chg ?? 0)}" data-chg="${c.sym}">${pct(chg)}</div>
    </div>
  </button>`;
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
    <h2 class="section">Destaques <small class="muted">score 0–100</small></h2>
    ${opps.length ? `<div class="opps">${opps.map(({ c, a }) => `
      <button class="opp ${a.verdict}" data-open="${c.sym}">
        <div class="opp-head">${coinIcon(c)}<div class="grow"><b>${c.sym}</b><div class="muted num" style="font-size:13px" data-price="${c.sym}">${money(price(c.sym))}</div></div>
          <span class="chip ${VERDICT[a.verdict].cls}">${VERDICT[a.verdict].label}</span></div>
        <div class="score-bar"><i style="width:${a.score}%;background-position:${-300 + a.score * 3}px 0"></i></div>
        <div class="opp-txt">${esc(a.reasons.slice(0, 2).join(' · ') || a.summary)}</div>
      </button>`).join('')}</div>`
      : `<div class="empty"><b>Mercado sem sinais fortes.</b> Fique tranquilo: você será notificado quando uma moeda ficar boa para compra.</div>`}
    <h2 class="section">Mercado <small class="muted">24h</small></h2>
    <div class="list">${COINS.map(coinRow).join('')}</div>`;
  if (soft) $('.opps', el)?.scrollTo(scrollX, 0);
  drawSparks();
}

function drawSparks() {
  $$('canvas[data-spark]').forEach(cv => {
    const s = S.spark[cv.dataset.spark];
    if (s) drawSpark(cv, s, s.at(-1) >= s[0]);
  });
}

function renderSignals() {
  const el = $('#view-signals');
  if (S.loading) { el.innerHTML = '<div class="skeleton" style="height:300px;margin-top:10px"></div>'; return; }
  el.innerHTML = `<h2 class="section">Ranking de oportunidades <small class="muted">horizonte ${PARAMS.horizon} dias</small></h2>
    ${ranked().map(({ c, a }) => {
      const v = VERDICT[a.verdict];
      return `<button class="sig-card" data-open="${c.sym}">
        <div class="top">${coinIcon(c)}
          <div style="flex:1"><b>${esc(c.name)}</b> <span class="chip ${v.cls}">${v.label}</span>
            <div class="muted" style="font-size:12px">Acerto histórico do sinal: ${a.statsOk ? pct0(a.bt.winRate) : 'amostra pequena'} · base ${pct0(a.bt.baseWinRate)}</div></div>
          <div class="score num" style="color:${scoreColor(a.score)}">${a.score}</div></div>
        <div class="score-bar"><i style="width:${a.score}%;background-position:${-300 + a.score * 3}px 0"></i></div>
        <p>${esc(a.summary)}</p>
      </button>`;
    }).join('')}
    ${COINS.filter(c => S.analysis[c.sym] && !S.analysis[c.sym].ok).map(c => `<div class="note">${c.sym}: ${esc(S.analysis[c.sym].reason)}</div>`).join('')}`;
}

function renderSim() {
  const el = $('#view-sim');
  const pos = S.positions;
  let inv = 0, val = 0;
  const rows = pos.map((p, idx) => {
    const c = coinBySym[p.sym]; const cur = price(p.sym);
    const valueLocal = cur ? p.qty * cur * (p.cur === 'BRL' ? (S.rate || p.rate) : 1) : null;
    const valueOut = valueLocal != null ? valueLocal * (1 - PARAMS.costPct / 2) : null;
    inv += p.amount; val += valueOut ?? p.amount;
    const pl = valueOut != null ? valueOut - p.amount : 0;
    return `<div class="row pos">
      ${coinIcon(c)}
      <div class="meta" data-open="${p.sym}"><div class="name">${c.sym} <span class="muted" style="font-size:12px;font-weight:500">${qty(p.qty, '')}</span></div>
        <div class="sub">Entrada ${p.cur === 'BRL' ? 'R$' : 'US$'} ${(p.entry * (p.cur === 'BRL' ? p.rate : 1)).toLocaleString('pt-BR', { maximumSignificantDigits: 6 })} · ${fmtDate(p.at)}</div></div>
      <div class="right"><div class="price num">${moneyLocal(valueOut)}</div>
        <div class="chg num ${cls(pl)}">${moneyLocal(pl, true)} (${pct(pl / p.amount)})</div>
        <button class="del" data-del="${idx}">remover</button></div>
    </div>`;
  });
  const pl = val - inv;
  el.innerHTML = `
    <div class="balance"><div class="muted">Carteira simulada (valor de venda agora)</div>
      <div class="big num">${moneyLocal(val)}</div>
      <div class="pl num ${cls(pl)}">${moneyLocal(pl, true)} · ${inv ? pct(pl / inv) : '0,00%'}</div></div>
    ${pos.length ? `<div class="list">${rows.join('')}</div>`
      : `<div class="empty" style="margin-top:12px"><b>Nenhuma compra simulada.</b> Abra uma moeda e toque em <b>“Simular compra agora”</b> para acompanhar, em tempo real, quanto você estaria ganhando ou perdendo — sem gastar nada.</div>`}
    <p class="note">Valores atualizados ao vivo. Já descontamos ${(PARAMS.costPct * 100).toFixed(1).replace('.', ',')}% de taxas (compra + venda). Simulações não são dinheiro real.</p>`;
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
      <button class="btn primary" id="enablePush">${perm === 'granted' ? 'Gerar código do aparelho' : 'Ativar notificações'}</button>
      <div id="pushOut"></div>
      <button class="btn ghost" id="testNotif">Enviar notificação de teste</button>
    </div>
    <div class="card method"><h3>🧠 Como o app decide</h3>
      <p><b>1. Pontuação (0–100)</b> com 5 grupos de fatores: <b>Tendência</b> (médias de 50/200 dias), <b>Momentum</b> (retorno de 90 dias, MACD), <b>Ponto de entrada</b> (RSI e distância da média de 20 dias — comprar correções dentro de alta, não topos), <b>Volume</b> (fluxo comprador/OBV) e <b>Risco</b> (volatilidade e quedas extremas).</p>
      <p><b>2. Prova no histórico (backtest).</b> A mesma regra é aplicada em ~1.000 dias de cada moeda. Medimos quantas vezes, ${PARAMS.horizon} dias depois de um sinal, o preço estava mais alto — já descontando taxas — e comparamos com um dia qualquer.</p>
      <p><b>3. Alerta só se tudo bater:</b> pontuação ≥ ${PARAMS.threshold}, pelo menos ${PARAMS.minSignalDays} dias-sinal e ${PARAMS.minEvents} episódios independentes, acerto ≥ ${PARAMS.minWinRate * 100}%, vantagem ≥ ${PARAMS.minEdge * 100} p.p. sobre um dia aleatório e retorno mediano positivo. RSI acima de 72 bloqueia o alerta.</p>
      <p><b>4. Simulação</b> usa a distribuição real dos resultados passados (pessimista = 10% piores casos, provável = mediana, otimista = 10% melhores).</p>
      <p class="muted">Referências: Liu & Tsyvinski (2021, <i>Review of Financial Studies</i>) — momentum e atenção em cripto; Moskowitz, Ooi & Pedersen (2012) — time-series momentum; Jegadeesh (1990) — reversão de curto prazo; Brock, Lakonishok & LeBaron (1992) — médias móveis.</p>
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
      ${v ? `<span class="chip ${v.cls}" style="font-size:12px;padding:5px 10px">${v.label}</span>` : ''}</div>
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

function detailAnalysis(c, a) {
  const v = VERDICT[a.verdict];
  const bt = a.bt;
  const groups = {};
  a.parts.forEach(p => { (groups[p.group] ||= []).push(p); });
  const edgeTxt = a.edge != null ? `${a.edge >= 0 ? '+' : ''}${(a.edge * 100).toFixed(1).replace('.', ',')} p.p.` : '—';
  return `
    <div class="card">
      <div class="verdict">
        <div class="ring"><canvas id="ring"></canvas><div class="val num" style="color:${scoreColor(a.score)}">${a.score}<small>de 100</small></div></div>
        <div><div class="verdict-title">${v.title}</div><div class="verdict-txt">${esc(a.summary)}</div></div>
      </div>
      <ul class="reasons">
        ${a.reasons.map(r => `<li>${esc(r)}</li>`).join('')}
        ${a.warnings.map(r => `<li class="warn">${esc(r)}</li>`).join('')}
      </ul>
    </div>

    <div class="card"><h3>📊 Prova estatística <span class="chip ${a.ruleWorks ? 'buy' : 'neutral'}">${a.ruleWorks ? 'REGRA VALIDADA' : 'NÃO VALIDADA'}</span></h3>
      <div class="bt-row">
        <div class="stat"><div class="k">Episódios</div><div class="v num">${bt.events}</div><div class="s">${bt.signalDays} dias-sinal</div></div>
        <div class="stat"><div class="k">Acerto ${bt.horizon}d</div><div class="v num ${bt.winRate >= PARAMS.minWinRate ? 'up' : 'down'}">${pct0(bt.winRate)}</div><div class="s">base ${pct0(bt.baseWinRate)}</div></div>
        <div class="stat"><div class="k">Vantagem</div><div class="v num ${cls(a.edge ?? 0)}">${edgeTxt}</div><div class="s">${bt.pValue != null ? `p ≈ ${bt.pValue.toFixed(2).replace('.', ',')}` : ''}</div></div>
      </div>
      <div class="compare">
        <div class="lbl"><span>Retorno mediano após sinal</span><b class="${cls(bt.medianRet ?? 0)}">${pct(bt.medianRet, 1)}</b></div>
        <div class="track"><i style="width:${Math.min(100, Math.max(3, 50 + (bt.medianRet ?? 0) * 250))}%;background:${(bt.medianRet ?? 0) >= 0 ? 'var(--up)' : 'var(--down)'}"></i></div>
        <div class="lbl"><span>Retorno mediano de um dia qualquer</span><b class="${cls(bt.baseMedianRet ?? 0)}">${pct(bt.baseMedianRet, 1)}</b></div>
        <div class="track"><i style="width:${Math.min(100, Math.max(3, 50 + (bt.baseMedianRet ?? 0) * 250))}%;background:var(--muted)"></i></div>
      </div>
      <p class="note">${esc(a.statsText)} Valores já descontam ${(PARAMS.costPct * 100).toFixed(1).replace('.', ',')}% de taxas. p-valor: probabilidade de a vantagem ser só sorte (quanto menor, melhor).</p>
    </div>

    <div class="card"><h3>💰 Simulação de compra</h3>
      <div class="amount"><span>${curSym()}</span><input id="amt" inputmode="decimal" value="${String(S.amount).replace('.', ',')}"></div>
      <div class="quick">${[100, 500, 1000, 5000].map(q => `<button data-amt="${q}">${q.toLocaleString('pt-BR')}</button>`).join('')}</div>
      <div id="simOut"></div>
      <button class="btn primary" id="simBuy">Simular compra agora</button>
    </div>

    <div class="card"><h3>🔬 Raio-X dos fatores</h3>
      ${Object.entries(groups).map(([g, ps]) => ps.map((p, i) => `
        <div class="factor"><div>${i === 0 ? `<div class="g">${g}</div>` : ''}${esc(p.text)}</div>
          <div class="pts num" style="color:${p.pts < 0 ? 'var(--down)' : p.ok ? 'var(--up)' : p.pts > 0 ? 'var(--gold)' : 'var(--muted)'}">${p.pts > 0 ? '+' : ''}${p.pts}/${p.max}</div>
          <div class="bar"><i style="width:${Math.max(0, p.pts) / p.max * 100}%;background:${p.ok ? 'var(--up)' : 'var(--gold)'}"></i></div></div>`).join('')).join('')}
    </div>

    <div class="card"><h3>🛡️ Gestão de risco</h3>
      <div class="grid2">
        <div class="stat atl"><div class="k">Stop sugerido</div><div class="v num">${money(a.stop)}</div><div class="s">${pct(a.stop / a.price - 1, 1)} (2× ATR)</div></div>
        <div class="stat ath"><div class="k">Alvo sugerido</div><div class="v num">${money(a.target)}</div><div class="s">${pct(a.target / a.price - 1, 1)} (3× ATR)</div></div>
      </div>
      <p class="note">ATR = variação média diária (${pct0(a.atrPct)} ao dia). Stop é o ponto em que a tese de compra deixa de valer.</p>
    </div>`;
}

function parseAmount() {
  const raw = ($('#amt')?.value || '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(raw);
  return isFinite(n) && n > 0 ? n : 0;
}

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
      <div class="muted" style="font-size:12px;margin-top:12px">Resultado em ${sim.horizon} dias, com base em ${sim.dist.length} casos reais parecidos:</div>
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
  if (sim) drawHistogram($('#hist'), sim.dist, a.bt.medianRet);
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
  S.chart?.setData(data, { markers, ath: x?.ath, animate });
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
  if (S.view === 'sim' && S.positions.length) renderSim();
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
    const json = JSON.stringify(sub);
    out.innerHTML = `<p class="note">✅ Notificações no app ativas. Para receber com o app <b>fechado</b>, copie o código abaixo e salve no GitHub em <b>Settings › Secrets and variables › Actions › New repository secret</b> com o nome <b>PUSH_SUBSCRIPTIONS</b> (só precisa fazer uma vez).</p>
      <textarea class="code" readonly id="subJson">${esc(json)}</textarea>
      <button class="btn ghost" id="copySub">Copiar código</button>`;
    $('#copySub').onclick = async () => { try { await navigator.clipboard.writeText(json); toast('Código copiado ✅'); } catch { $('#subJson').select(); } };
  } catch (e) {
    out.innerHTML = `<div class="err">Não foi possível registrar o push: ${esc(e.message)}. Abra o app pelo ícone da Tela de Início.</div>`;
  }
}
function renderSettingsKeepOut() { /* mantém a mensagem de erro visível */ }

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
  if (v === 'home') requestAnimationFrame(drawSparks);
}

document.addEventListener('click', e => {
  const tab = e.target.closest('.tab'); if (tab) return switchView(tab.dataset.view);
  const del = e.target.closest('[data-del]');
  if (del) { S.positions.splice(+del.dataset.del, 1); store.set('positions', S.positions); renderSim(); return; }
  const open = e.target.closest('[data-open]'); if (open) return openDetail(open.dataset.open);
  if (e.target.closest('#closeSheet')) return closeDetail();
  const rg = e.target.closest('[data-range]');
  if (rg) { S.range = rg.dataset.range; $$('#ranges button').forEach(b => b.classList.toggle('on', b === rg)); loadRange(); return; }
  const qa = e.target.closest('[data-amt]');
  if (qa) { $('#amt').value = qa.dataset.amt; S.amount = +qa.dataset.amt; store.set('amount', S.amount); updateSim(); return; }
  if (e.target.closest('#simBuy')) {
    const sym = S.detail, p = price(sym), amount = parseAmount();
    if (!p || !amount) return toast('Informe um valor válido.');
    const rate = S.cur === 'BRL' ? S.rate : 1;
    S.positions.unshift({ sym, amount, cur: S.cur === 'BRL' && S.rate ? 'BRL' : 'USD', rate: rate || 1, entry: p, qty: (amount * (1 - PARAMS.costPct / 2)) / (p * (rate || 1)), at: Date.now() });
    store.set('positions', S.positions); renderSim();
    toast(`✅ Compra simulada de <b>${moneyLocal(amount)}</b> em ${sym}. Acompanhe na aba Simulador.`, () => { closeDetail(); switchView('sim'); });
    return;
  }
  const cb = e.target.closest('[data-cur]');
  if (cb) { S.cur = cb.dataset.cur; store.set('cur', S.cur); renderAll(); if (S.detail) renderDetail(); return; }
  if (e.target.closest('#enablePush')) return enablePush();
  if (e.target.closest('#testNotif')) return testNotif();
  if (e.target.closest('#refreshBtn')) return loadAll();
});

document.addEventListener('input', e => {
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
const live = connectLive(onTick, on => {
  $('#live').classList.toggle('on', on);
  $('#liveTxt').textContent = on ? 'Ao vivo' : 'Reconectando…';
});
loadAll().then(() => {
  const q = new URLSearchParams(location.search).get('coin');
  if (q && coinBySym[q]) openDetail(q);
});
setInterval(reanalyze, 60e3);             // reanalisa com preço ao vivo a cada 1 min
setInterval(loadAll, 15 * 60e3);          // recarrega candles a cada 15 min
document.addEventListener('visibilitychange', () => { if (!document.hidden) { live.ensure(); reanalyze(); } });
