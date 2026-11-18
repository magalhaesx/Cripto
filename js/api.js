// Acesso a dados públicos: Binance (candles + tempo real) e CoinGecko (ícones, máx/mín histórica).
import { BINANCE_REST, BINANCE_WS, COINGECKO } from './config.js';

const REST_FALLBACKS = [BINANCE_REST, 'https://api.binance.com/api/v3'];

async function getJSON(url, timeout = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function binance(path) {
  let err;
  for (const base of REST_FALLBACKS) {
    try { return await getJSON(base + path); } catch (e) { err = e; }
  }
  throw err;
}

// Intervalos para cada período do gráfico
export const RANGES = {
  '24H': { interval: '15m', limit: 96 },
  '7D':  { interval: '1h',  limit: 168 },
  '1M':  { interval: '4h',  limit: 180 },
  '1A':  { interval: '1d',  limit: 365 },
  'TUDO': { interval: '1w', limit: 1000 },
};

export async function fetchKlines(sym, interval, limit, startTime) {
  const raw = await binance(`/klines?symbol=${sym}USDT&interval=${interval}&limit=${limit}${startTime ? `&startTime=${startTime}` : ''}`);
  return raw.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[7] /* volume em USDT */ }));
}

export const fetchDaily = sym => fetchKlines(sym, '1d', 1000);

// Cotação do dólar (USDT) em reais
export async function fetchUsdBrl() {
  try {
    const r = await binance('/ticker/price?symbol=USDTBRL');
    return +r.price;
  } catch { return null; }
}

export async function fetchTickers24h(coins) {
  const syms = JSON.stringify(coins.map(c => `${c.sym}USDT`));
  let arr;
  try { arr = await binance(`/ticker/24hr?symbols=${encodeURIComponent(syms)}`); }
  catch { // um símbolo inválido derruba o lote inteiro: busca um por um
    arr = (await Promise.all(coins.map(c => binance(`/ticker/24hr?symbol=${c.sym}USDT`).catch(() => null)))).filter(Boolean);
  }
  const out = {};
  for (const t of arr) out[t.symbol.replace('USDT', '')] = { price: +t.lastPrice, open: +t.openPrice, high: +t.highPrice, low: +t.lowPrice, quoteVol: +t.quoteVolume, change: +t.priceChangePercent / 100 };
  return out;
}

// CoinGecko em USD (convertido no app). Cache de 15 min para respeitar o limite gratuito.
export async function fetchMarkets(coins) {
  const ids = coins.filter(c => c.id).map(c => c.id).join(',');
  const KEY = 'cg-markets-v2';
  try {
    const cached = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (cached && cached.ids === ids && Date.now() - cached.at < 15 * 60e3) return cached.data;
  } catch {}
  try {
    const arr = await getJSON(`${COINGECKO}/coins/markets?vs_currency=usd&ids=${ids}&price_change_percentage=7d`);
    const data = {};
    for (const m of arr) data[m.id] = {
      image: m.image, marketCap: m.market_cap, rank: m.market_cap_rank,
      ath: m.ath, athDate: m.ath_date, atl: m.atl, atlDate: m.atl_date,
      supply: m.circulating_supply, change7d: m.price_change_percentage_7d_in_currency / 100,
    };
    try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), ids, data })); } catch {}
    return data;
  } catch {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null')?.data || {}; } catch { return {}; }
  }
}

// WebSocket com reconexão automática. onTick(sym, {price, open, high, low, quoteVol})
export function connectLive(coins, onTick, onStatus) {
  const streams = [...coins.map(c => `${c.sym.toLowerCase()}usdt@miniTicker`), 'usdtbrl@miniTicker'].join('/');
  let ws, retry = 0, closed = false;
  const open = () => {
    ws = new WebSocket(`${BINANCE_WS}?streams=${streams}`);
    ws.onopen = () => { retry = 0; onStatus?.(true); };
    ws.onmessage = ev => {
      const { data: d } = JSON.parse(ev.data);
      if (!d?.s) return;
      const sym = d.s === 'USDTBRL' ? 'USDTBRL' : d.s.replace(/USDT$/, '');
      onTick(sym, { price: +d.c, open: +d.o, high: +d.h, low: +d.l, quoteVol: +d.q, change: +d.c / +d.o - 1 });
    };
    ws.onclose = () => {
      onStatus?.(false);
      if (closed) return;
      setTimeout(open, Math.min(30000, 1000 * 2 ** retry++));
    };
    ws.onerror = () => ws.close();
  };
  open();
  return {
    close() { closed = true; ws?.close(); },
    ensure() { if (!closed && ws && ws.readyState > 1) open(); },
  };
}

// Todos os pares XXX/USDT negociados na Binance (para buscar e adicionar moedas)
let allPairs = null;
export async function fetchAllUsdtSymbols() {
  if (allPairs) return allPairs;
  const arr = await binance('/ticker/24hr?type=MINI');
  allPairs = arr.filter(t => t.symbol.endsWith('USDT') && +t.quoteVolume > 0)
    .map(t => ({ sym: t.symbol.slice(0, -4), quoteVol: +t.quoteVolume }))
    .filter(t => !['USDC', 'FDUSD', 'TUSD', 'USDP', 'DAI', 'EUR', 'BUSD'].includes(t.sym))
    .sort((a, b) => b.quoteVol - a.quoteVol);
  return allPairs;
}

// Índice de Medo e Ganância (alternative.me) — últimos 30 dias, cache de 1 h
export async function fetchFearGreed() {
  const KEY = 'fng-v1';
  try { const c = JSON.parse(localStorage.getItem(KEY) || 'null'); if (c && Date.now() - c.at < 36e5) return c.data; } catch {}
  try {
    const j = await getJSON('https://api.alternative.me/fng/?limit=30&format=json');
    const data = j.data.map(x => ({ t: +x.timestamp * 1000, v: +x.value })).reverse();
    try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), data })); } catch {}
    return data;
  } catch { try { return JSON.parse(localStorage.getItem(KEY) || 'null')?.data || null; } catch { return null; } }
}
