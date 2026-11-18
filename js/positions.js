// Regras de saída das compras simuladas — compartilhado entre o app e o robô.

// Verifica, vela a vela (desde a compra), se o preço tocou o stop ou o alvo primeiro.
// Se os dois foram tocados na mesma vela, assume o stop (conservador).
// candles: [{t, h, l, c}] em ordem; pos: {at, stop, target}
export function firstHit(pos, candles) {
  for (const k of candles) {
    if (k.t + 36e5 <= pos.at) continue;              // vela inteira antes da compra
    if (k.l <= pos.stop) return { type: 'stop', price: pos.stop, t: Math.max(k.t, pos.at) };
    if (k.h >= pos.target) return { type: 'target', price: pos.target, t: Math.max(k.t, pos.at) };
  }
  return null;
}

// Versão compacta enviada ao robô (vai dentro do código do aparelho)
export const compactPos = p => ({ id: p.id, s: p.sym, e: +p.entry.toPrecision(8), st: +p.stop.toPrecision(8), tg: +p.target.toPrecision(8), at: p.at, exp: p.exp });
export const expandPos = c => ({ id: c.id, sym: c.s, entry: c.e, stop: c.st, target: c.tg, at: c.at, exp: c.exp });

export const fmtPct = x => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1).replace('.', ',')}%`;

// Texto das notificações (mesmo no app e no robô)
export function exitMessage(type, pos, name, price) {
  const ret = price / pos.entry - 1;
  if (type === 'target') return {
    title: `🎯 ${name}: alvo atingido (${fmtPct(ret)})`,
    body: `${pos.sym} chegou ao alvo. Pela estratégia, é hora de vender e garantir o lucro da compra simulada.`,
  };
  if (type === 'stop') return {
    title: `🛑 ${name}: stop atingido (${fmtPct(ret)})`,
    body: `${pos.sym} caiu até o stop. Pela estratégia, venda para limitar a perda — a tese de repique deixou de valer.`,
  };
  return {
    title: `⏰ ${name}: prazo de 7 dias encerrado (${fmtPct(ret)})`,
    body: `A compra simulada de ${pos.sym} completou o prazo da estratégia sem bater alvo nem stop. Hora de reavaliar ou vender.`,
  };
}
