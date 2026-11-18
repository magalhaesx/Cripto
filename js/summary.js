// Resumo diário — o mesmo texto no app (prévia) e no robô (notificação).
const REG = { bull: '🐂 alta', correction: '🔄 correção na alta', bear: '🐻 baixa longa (alertas pausados)' };
const fng = v => (v <= 20 ? 'medo extremo' : v <= 40 ? 'medo' : v <= 60 ? 'neutro' : v <= 80 ? 'ganância' : 'ganância extrema');
const pc = x => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1).replace('.', ',')}%`;

// d = { btcChange, regime, fng, coins: [{sym, score, verdict}], favs?: [], positions: [{sym, ret}], buys: [sym] }
export function buildDigest(d) {
  const pool = d.favs?.length ? d.coins.filter(c => d.favs.includes(c.sym)) : d.coins;
  const buys = new Set(d.buys || []);
  const top = [...pool].filter(c => !buys.has(c.sym)).sort((a, b) => b.score - a.score).slice(0, 3);
  const lines = [];
  lines.push(`Mercado: ${d.regime ? REG[d.regime] : '—'}${d.fng != null ? ` · índice ${d.fng} (${fng(d.fng)})` : ''}${d.btcChange != null ? ` · BTC ${pc(d.btcChange)} em 24h` : ''}.`);
  if (d.buys?.length) lines.push(`🟢 Oportunidade de repique: ${d.buys.slice(0, 6).join(', ')}${d.buys.length > 6 ? ` e mais ${d.buys.length - 6}` : ''}.`);
  if (top.length) lines.push(`${d.buys?.length ? 'Próximas candidatas' : 'Mais perto do gatilho'}${d.favs?.length ? ' (favoritas)' : ''}: ${top.map(c => `${c.sym} ${c.score}/100`).join(' · ')}.`);
  if (d.positions?.length) {
    const avg = d.positions.reduce((s, p) => s + p.ret, 0) / d.positions.length;
    lines.push(`Suas compras simuladas (${d.positions.length}): média ${pc(avg)}.`);
  }
  const title = d.buys?.length ? `☀️ Resumo do dia · ${d.buys.length} oportunidade${d.buys.length > 1 ? 's' : ''}` : '☀️ Resumo do dia';
  return { title, body: lines.join('\n') };
}

// hora local (0–23) e data local (AAAA-MM-DD) num fuso horário
export function localHourDate(tz, now = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(now).map(x => [x.type, x.value]));
  return { hour: +p.hour, date: `${p.year}-${p.month}-${p.day}` };
}
