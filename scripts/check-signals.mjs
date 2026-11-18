// Robô de alertas: roda no GitHub Actions a cada 30 min, aplica a MESMA análise
// do app e envia notificação push ao iPhone quando uma moeda vira "compra forte".
import webpush from 'web-push';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { COINS as BASE } from '../js/coins.js';
import { analyze, applyBreadth, marketRegime, PARAMS } from '../js/analysis.js';
import { STUDY } from '../js/study.js';
import { firstHit, expandPos, exitMessage } from '../js/positions.js';
import { alertHit, expandAlert, alertMessage } from '../js/alerts.js';
import { buildDigest, localHourDate } from '../js/summary.js';
import { VAPID_PUBLIC_KEY } from '../js/config.js';

const BASES = ['https://data-api.binance.vision/api/v3', 'https://api.binance.com/api/v3'];
const STATE_FILE = '.state/notified.json';
const COOLDOWN_H = Number(process.env.COOLDOWN_HOURS || 24);
const SITE = process.env.SITE_URL || './';

async function klines(sym, interval = '1d', extra = '') {
  let err;
  for (const b of BASES) {
    try {
      const r = await fetch(`${b}/klines?symbol=${sym}USDT&interval=${interval}&limit=1000${extra}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()).map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[7] }));
    } catch (e) { err = e; }
  }
  throw err;
}

function loadState() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) { mkdirSync('.state', { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

function subscriptions() {
  const raw = process.env.PUSH_SUBSCRIPTIONS;
  if (!raw) return [];
  const v = JSON.parse(raw);
  return Array.isArray(v) ? v : [v];
}

const subs = subscriptions();
// Moedas extras adicionadas no app (vêm junto do código do aparelho)
const COINS = [...BASE];
for (const s of subs) for (const sym of s.radar?.extra || []) {
  if (/^[A-Z0-9]{2,15}$/.test(sym) && !COINS.some(c => c.sym === sym)) COINS.push({ sym, name: sym });
}

const state = loadState();
const now = Date.now();
const results = {};
let btcCandles = null;
const table = [];

for (const c of COINS) {
  try {
    const cs = await klines(c.sym);
    if (c.sym === 'BTC') btcCandles = cs;
    const a = analyze(cs, PARAMS, STUDY);
    if (!a.ok) { table.push(`${c.sym.padEnd(6)} sem histórico suficiente`); continue; }
    results[c.sym] = a;
  } catch (e) {
    table.push(`${c.sym.padEnd(6)} erro: ${e.message}`);
  }
}
const regime = marketRegime(btcCandles);
const share = applyBreadth(results, PARAMS, STUDY, regime);
const alerts = [];
for (const c of COINS) {
  const a = results[c.sym]; if (!a) continue;
  table.push(`${c.sym.padEnd(6)} gatilho ${String(a.score).padStart(3)}  queda30d ${String(Math.round(a.dd30 * 100)).padStart(4)}%  RSI ${String(Math.round(a.rsi)).padStart(3)}  ${a.verdict.padEnd(7)}  nesta moeda: ${a.bt.winRate != null ? Math.round(a.bt.winRate * 100) + '%' : '—'} em ${a.bt.events} casos (base ${Math.round(a.bt.baseWinRate * 100)}%)`);
  if (a.verdict === 'buy' && now - (state[c.sym] || 0) > COOLDOWN_H * 3600e3) alerts.push({ c, a });
  if (!a.trigger) delete state[c.sym]; // gatilho desarmou: permite novo alerta na próxima queda
}
console.log(table.join('\n'));
console.log(`\nClima: ${regime ? `${{ bull: 'alta', correction: 'correção na alta', bear: 'BAIXA LONGA (alertas pausados)' }[regime.state]} — BTC ${Math.round(regime.dist * 100)}% da MM200, MM200 ${(regime.slope * 100).toFixed(1)}% em ${PARAMS.regimeSlopeDays}d` : 'indisponível'}`);
console.log(`Amplitude: ${Math.round(share * 100)}% das moedas no gatilho (mínimo para alertar: ${PARAMS.minBreadth * 100}%).`);

// ---------------------------------------------------------------------------
// Registro oficial: cada alerta é gravado na hora em data/alerts-log.json (commit no repositório)
// ---------------------------------------------------------------------------
const LOG = 'data/alerts-log.json';
let log = []; try { log = JSON.parse(readFileSync(LOG, 'utf8')); } catch {}
let fngNow = null;
try { const r = await fetch('https://api.alternative.me/fng/?limit=1'); fngNow = +(await r.json()).data[0].value; } catch {}
let logged = 0;
for (const c of COINS) {
  const a = results[c.sym];
  if (a?.verdict !== 'buy') continue;
  // um registro por episódio: não repete a mesma moeda dentro do prazo da estratégia
  if (log.some(e => e.sym === c.sym && now - e.t < PARAMS.horizon * 864e5)) continue;
  log.push({ t: now, sym: c.sym, price: +a.price.toPrecision(8), strong: a.trigger === 'strong', regime: regime?.state ?? null,
    share: +share.toFixed(3), rsi: +a.rsi.toFixed(1), drop30: +a.dd30.toFixed(4), fng: fngNow });
  logged++;
}
if (logged) { mkdirSync('data', { recursive: true }); writeFileSync(LOG, JSON.stringify(log, null, 1) + '\n'); }
console.log(`Registro oficial: ${logged} alerta(s) novo(s) gravado(s) (${log.length} no total).`);

const pct = x => `${Math.round(x * 100)}%`;
function payloadFor(list) {
  if (list.length >= 3) {
    const strong = list.filter(x => x.a.trigger === 'strong').map(x => x.c.sym);
    return {
      title: `🟢 Pânico no mercado: ${list.length} moedas em oportunidade de repique`,
      body: `${list.map(x => x.c.sym).join(', ')}.${strong.length ? ` Sinal forte: ${strong.join(', ')}.` : ''} Historicamente ${pct(STUDY.alerts?.win ?? STUDY.winRate)} subiram em ${PARAMS.horizon} dias.`,
      url: SITE, tag: 'radar-buy',
    };
  }
  const { c, a } = list[0];
  return {
    title: `🟢 ${c.name} (${c.sym}): oportunidade de repique${a.trigger === 'strong' ? ' FORTE' : ''}`,
    body: `${a.reasons[0]}. Historicamente ${pct(a.trigger === 'strong' ? STUDY.strongWinRate : STUDY.winRate)} subiram em ${PARAMS.horizon} dias.${list[1] ? ` Também: ${list[1].c.sym}.` : ''}`,
    url: `${SITE}?coin=${c.sym}`, tag: 'radar-buy',
  };
}

const { VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
if (!alerts.length) console.log('Nenhuma nova oportunidade de compra.');
else if (!subs.length || !VAPID_PRIVATE_KEY) console.log(`${alerts.length} alerta(s): ${alerts.map(x => x.c.sym).join(', ')} — mas faltam os segredos PUSH_SUBSCRIPTIONS / VAPID_PRIVATE_KEY.`);
else {
  webpush.setVapidDetails(VAPID_SUBJECT || (SITE.startsWith('https') ? SITE : 'mailto:radar-cripto@users.noreply.github.com'), VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  const sentCoins = new Set();
  for (const sub of subs) {
    const mine = alerts.filter(x => sub.radar?.notify !== 'favorites' || (sub.radar.favs || []).includes(x.c.sym));
    if (!mine.length) { console.log('Um aparelho: nenhum alerta nas favoritas.'); continue; }
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payloadFor(mine)), { TTL: 6 * 3600, urgency: 'high' });
      mine.forEach(x => sentCoins.add(x.c.sym));
      console.log(`Enviado para um aparelho: ${mine.map(x => x.c.sym).join(', ')}`);
    } catch (e) { console.error(`Falha ao enviar para um aparelho (${e.statusCode || e.message}). Se for 404/410, gere um novo código no app.`); }
  }
  for (const sym of sentCoins) state[sym] = now;
}

// ---------------------------------------------------------------------------
// Avisos de venda das compras simuladas (stop, alvo e prazo)
// ---------------------------------------------------------------------------
if (VAPID_PRIVATE_KEY) webpush.setVapidDetails(VAPID_SUBJECT || (SITE.startsWith('https') ? SITE : 'mailto:radar-cripto@users.noreply.github.com'), VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
let posCount = 0;
for (const sub of subs) {
  for (const raw of sub.radar?.pos || []) {
    const p = expandPos(raw); posCount++;
    if (state[`pos:${p.id}:done`]) continue;
    try {
      const ks = await klines(p.sym, '1h', `&startTime=${p.at - 36e5}`);
      const hit = firstHit(p, ks);
      const last = ks.at(-1)?.c;
      let ev = hit ? hit.type : (Date.now() >= p.exp ? 'expire' : null);
      if (!ev || state[`pos:${p.id}:${ev}`]) continue;
      const name = COINS.find(c => c.sym === p.sym)?.name || p.sym;
      const msg = exitMessage(ev, p, name, hit ? hit.price : last);
      console.log(`Compra simulada ${p.sym} (${p.id}): ${ev}`);
      if (!VAPID_PRIVATE_KEY) continue;
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify({ ...msg, url: `${SITE}?tab=sim`, tag: `pos-${p.id}-${ev}` }), { TTL: 12 * 3600, urgency: 'high' });
      state[`pos:${p.id}:${ev}`] = now;
      if (ev !== 'expire') state[`pos:${p.id}:done`] = now;
    } catch (e) { console.error(`Compra simulada ${p.sym}: erro ${e.statusCode || e.message}`); }
  }
}
console.log(`Compras simuladas verificadas: ${posCount}.`);

// ---------------------------------------------------------------------------
// Alertas de preço manuais
// ---------------------------------------------------------------------------
const fmtUsd = v => `US$ ${v >= 1 ? v.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) : v.toLocaleString('pt-BR', { maximumSignificantDigits: 4 })}`;
let alCount = 0;
for (const sub of subs) {
  for (const raw of sub.radar?.al || []) {
    const a = expandAlert(raw); alCount++;
    if (state[`al:${a.id}`]) continue;
    try {
      const ks = await klines(a.sym, '1h', `&startTime=${a.at - 36e5}`);
      if (!alertHit(a, ks)) continue;
      const name = COINS.find(c => c.sym === a.sym)?.name || a.sym;
      const msg = alertMessage(a, name, fmtUsd(a.price));
      console.log(`Alerta de preço ${a.sym} ${a.dir} ${a.price}: atingido`);
      if (!VAPID_PRIVATE_KEY) continue;
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify({ ...msg, url: `${SITE}?coin=${a.sym}`, tag: `al-${a.id}` }), { TTL: 12 * 3600, urgency: 'high' });
      state[`al:${a.id}`] = now;
    } catch (e) { console.error(`Alerta de preço ${a.sym}: erro ${e.statusCode || e.message}`); }
  }
}
console.log(`Alertas de preço verificados: ${alCount}.`);

// ---------------------------------------------------------------------------
// Resumo diário (uma vez por dia, no horário escolhido no app; padrão 9h)
// ---------------------------------------------------------------------------
const hashStr = x => { let h = 0; for (const ch of x) h = (h * 31 + ch.charCodeAt(0)) | 0; return (h >>> 0).toString(36); };
let btcChange = null;
try { const r = await fetch(`${BASES[0]}/ticker/24hr?symbol=BTCUSDT`); btcChange = +(await r.json()).priceChangePercent / 100; } catch {}
const coinsForDigest = Object.entries(results).map(([sym, a]) => ({ sym, score: a.score, verdict: a.verdict }));
const buysNow = Object.entries(results).filter(([, a]) => a.verdict === 'buy').map(([sym]) => sym);
for (const sub of subs) {
  const dg = { on: true, h: 9, tz: 'America/Sao_Paulo', ...(sub.radar?.dg || {}) };
  if (!dg.on) continue;
  const { hour, date } = localHourDate(dg.tz);
  const key = `dg:${hashStr(sub.endpoint)}:${date}`;
  if (hour !== dg.h || state[key]) continue;
  const positions = (sub.radar?.pos || []).map(expandPos).filter(p => results[p.sym]).map(p => ({ sym: p.sym, ret: results[p.sym].price / p.entry - 1 - PARAMS.costPct }));
  const favs = sub.radar?.notify === 'favorites' ? sub.radar.favs : null;
  const msg = buildDigest({ btcChange, regime: regime?.state, fng: fngNow, coins: coinsForDigest, favs, positions,
    buys: favs ? buysNow.filter(s => favs.includes(s)) : buysNow });
  console.log(`Resumo diário (${date} ${dg.h}h ${dg.tz}):\n${msg.title}\n${msg.body}`);
  if (!VAPID_PRIVATE_KEY) continue;
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify({ ...msg, url: SITE, tag: 'radar-digest' }), { TTL: 6 * 3600 });
    state[key] = now;
  } catch (e) { console.error(`Resumo diário: falha ${e.statusCode || e.message}`); }
}
saveState(state);
