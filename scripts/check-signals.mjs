// Robô de alertas: roda no GitHub Actions a cada 30 min, aplica a MESMA análise
// do app e envia notificação push ao iPhone quando uma moeda vira "compra forte".
import webpush from 'web-push';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { COINS as BASE } from '../js/coins.js';
import { analyze, PARAMS } from '../js/analysis.js';
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
const alerts = [];
const table = [];

for (const c of COINS) {
  try {
    const a = analyze(await klines(c.sym));
    if (!a.ok) { table.push(`${c.sym.padEnd(5)} sem histórico suficiente`); continue; }
    table.push(`${c.sym.padEnd(5)} score ${String(a.score).padStart(3)}  ${a.verdict.padEnd(7)}  acerto ${a.bt.winRate != null ? Math.round(a.bt.winRate * 100) : '-'}% (base ${Math.round(a.bt.baseWinRate * 100)}%)  eventos ${a.bt.events}`);
    if (a.verdict === 'buy' && now - (state[c.sym] || 0) > COOLDOWN_H * 3600e3) alerts.push({ c, a });
    if (a.verdict !== 'buy' && a.score < PARAMS.threshold - 10) delete state[c.sym]; // permite novo alerta no próximo ciclo de alta
  } catch (e) {
    table.push(`${c.sym.padEnd(5)} erro: ${e.message}`);
  }
}
console.log(table.join('\n'));

const { VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
if (!alerts.length) console.log('\nNenhuma nova oportunidade de compra.');
else if (!subs.length || !VAPID_PRIVATE_KEY) console.log(`\n${alerts.length} alerta(s), mas faltam os segredos PUSH_SUBSCRIPTIONS / VAPID_PRIVATE_KEY.`);
else {
  webpush.setVapidDetails(VAPID_SUBJECT || (SITE.startsWith('https') ? SITE : 'mailto:radar-cripto@users.noreply.github.com'), VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  for (const { c, a } of alerts) {
    const payload = JSON.stringify({
      title: `🟢 ${c.name} (${c.sym}) está boa para compra`,
      body: `Pontuação ${a.score}/100 · alta em ${PARAMS.horizon}d em ${Math.round(a.bt.winRate * 100)}% dos casos parecidos. ${a.reasons[0] || ''}`,
      url: `${SITE}?coin=${c.sym}`,
      tag: `buy-${c.sym}`,
    });
    let delivered = 0;
    const targets = subs.filter(s => s.radar?.notify !== 'favorites' || (s.radar.favs || []).includes(c.sym));
    if (!targets.length) { console.log(`Alerta ${c.sym}: ignorado (não está nas favoritas).`); continue; }
    for (const s of targets) {
      try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, { TTL: 6 * 3600, urgency: 'high' }); delivered++; }
      catch (e) { console.error(`Falha ao enviar para um aparelho (${e.statusCode || e.message}). Se for 404/410, gere um novo código no app.`); }
    }
    if (delivered) state[c.sym] = now;
    console.log(`Alerta ${c.sym}: enviado para ${delivered}/${targets.length} aparelho(s).`);
  }
}
saveState(state);
