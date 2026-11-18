// Robô de alertas: roda no GitHub Actions a cada 30 min, aplica a MESMA análise
// do app e envia notificação push ao iPhone quando uma moeda vira "compra forte".
import webpush from 'web-push';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { COINS as BASE } from '../js/coins.js';
import { analyze, applyBreadth, PARAMS } from '../js/analysis.js';
import { STUDY } from '../js/study.js';
import { VAPID_PUBLIC_KEY } from '../js/config.js';

const BASES = ['https://data-api.binance.vision/api/v3', 'https://api.binance.com/api/v3'];
const STATE_FILE = '.state/notified.json';
const COOLDOWN_H = Number(process.env.COOLDOWN_HOURS || 24);
const SITE = process.env.SITE_URL || './';

async function klines(sym) {
  let err;
  for (const b of BASES) {
    try {
      const r = await fetch(`${b}/klines?symbol=${sym}USDT&interval=1d&limit=1000`);
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
const table = [];

for (const c of COINS) {
  try {
    const a = analyze(await klines(c.sym), PARAMS, STUDY);
    if (!a.ok) { table.push(`${c.sym.padEnd(6)} sem histórico suficiente`); continue; }
    results[c.sym] = a;
  } catch (e) {
    table.push(`${c.sym.padEnd(6)} erro: ${e.message}`);
  }
}
const share = applyBreadth(results, PARAMS, STUDY);
const alerts = [];
for (const c of COINS) {
  const a = results[c.sym]; if (!a) continue;
  table.push(`${c.sym.padEnd(6)} gatilho ${String(a.score).padStart(3)}  queda30d ${String(Math.round(a.dd30 * 100)).padStart(4)}%  RSI ${String(Math.round(a.rsi)).padStart(3)}  ${a.verdict.padEnd(7)}  nesta moeda: ${a.bt.winRate != null ? Math.round(a.bt.winRate * 100) + '%' : '—'} em ${a.bt.events} casos (base ${Math.round(a.bt.baseWinRate * 100)}%)`);
  if (a.verdict === 'buy' && now - (state[c.sym] || 0) > COOLDOWN_H * 3600e3) alerts.push({ c, a });
  if (!a.trigger) delete state[c.sym]; // gatilho desarmou: permite novo alerta na próxima queda
}
console.log(table.join('\n'));
console.log(`\nAmplitude: ${Math.round(share * 100)}% das moedas no gatilho (mínimo para alertar: ${PARAMS.minBreadth * 100}%).`);

const pct = x => `${Math.round(x * 100)}%`;
function payloadFor(list) {
  if (list.length >= 3) {
    const strong = list.filter(x => x.a.trigger === 'strong').map(x => x.c.sym);
    return {
      title: `🟢 Pânico no mercado: ${list.length} moedas em oportunidade de repique`,
      body: `${list.map(x => x.c.sym).join(', ')}.${strong.length ? ` Sinal forte: ${strong.join(', ')}.` : ''} Historicamente ${pct(STUDY.breadth?.panicWinRate ?? STUDY.winRate)} subiram em ${PARAMS.horizon} dias.`,
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
saveState(state);
