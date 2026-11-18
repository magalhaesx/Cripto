// Alertas de preço manuais — compartilhado entre o app e o robô.
// alert: { id, sym, price (USD), dir: 'above' | 'below', at }

// Primeira vela (desde a criação) em que o preço alvo foi tocado
export function alertHit(a, candles) {
  for (const k of candles) {
    if (k.t + 36e5 <= a.at) continue;
    if (a.dir === 'above' ? k.h >= a.price : k.l <= a.price) return { t: Math.max(k.t, a.at), price: a.price };
  }
  return null;
}

export const compactAlert = a => ({ id: a.id, s: a.sym, p: +a.price.toPrecision(8), d: a.dir === 'above' ? 1 : 0, at: a.at });
export const expandAlert = c => ({ id: c.id, sym: c.s, price: c.p, dir: c.d ? 'above' : 'below', at: c.at });

export function alertMessage(a, name, priceTxt) {
  return a.dir === 'above'
    ? { title: `🔔 ${name} passou de ${priceTxt} ▲`, body: `Seu alerta de preço de ${a.sym} foi atingido (acima de ${priceTxt}).` }
    : { title: `🔔 ${name} caiu abaixo de ${priceTxt} ▼`, body: `Seu alerta de preço de ${a.sym} foi atingido (abaixo de ${priceTxt}).` };
}
