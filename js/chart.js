// Gráficos em <canvas> leves e animados (sem bibliotecas).

const UP = '#2EE6A6', DOWN = '#FF5C7A', VIOLET = '#AB9FF2';

function setupCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

const hexA = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
};

// ---------------------------------------------------------------------------
export class PriceChart {
  constructor(canvas, { onHover, fmt } = {}) {
    this.canvas = canvas; this.onHover = onHover; this.fmt = fmt || (x => x.toFixed(2));
    this.data = []; this.markers = []; this.hover = null; this.progress = 1;
    const move = e => {
      const r = canvas.getBoundingClientRect();
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
      this.setHover(x);
    };
    const end = () => { this.hover = null; this.draw(); this.onHover?.(null); };
    canvas.addEventListener('touchstart', e => { move(e); }, { passive: true });
    canvas.addEventListener('touchmove', e => { e.preventDefault(); move(e); }, { passive: false });
    canvas.addEventListener('touchend', end);
    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseleave', end);
    this._ro = new ResizeObserver(() => this.draw());
    this._ro.observe(canvas);
  }

  setData(candles, { markers = [], ath = null, lines = [], animate = true } = {}) {
    this.data = candles; this.markers = markers; this.ath = ath; this.lines = lines;
    if (animate) {
      const start = performance.now();
      const step = now => {
        this.progress = Math.min(1, (now - start) / 700);
        this.progress = 1 - (1 - this.progress) ** 3;
        this.draw();
        if (this.progress < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    } else { this.progress = 1; this.draw(); }
  }

  updateLast(price) {
    const last = this.data[this.data.length - 1];
    if (!last) return;
    last.c = price; last.h = Math.max(last.h, price); last.l = Math.min(last.l, price);
    if (this.progress >= 1) this.draw();
  }

  get color() {
    const d = this.data;
    return d.length && d[d.length - 1].c >= d[0].o ? UP : DOWN;
  }

  setHover(x) {
    if (!this.data.length) return;
    const i = Math.max(0, Math.min(this.data.length - 1, Math.round((x - this.pad.l) / this.stepX)));
    if (i !== this.hover) {
      this.hover = i; this.draw();
      navigator.vibrate?.(1);
      this.onHover?.({ ...this.data[i], i, first: this.data[0] });
    }
  }

  draw() {
    const { ctx, w, h } = setupCanvas(this.canvas);
    ctx.clearRect(0, 0, w, h);
    const d = this.data;
    if (d.length < 2) return;

    const pad = this.pad = { l: 6, r: 6, t: 26, b: 34 };
    const volH = 34;
    const chartH = h - pad.t - pad.b - 6;
    let min = Infinity, max = -Infinity, iMin = 0, iMax = 0, vMax = 0;
    d.forEach((k, i) => {
      if (k.c < min) { min = k.c; iMin = i; }
      if (k.c > max) { max = k.c; iMax = i; }
      if (k.v > vMax) vMax = k.v;
    });
    // linhas de alerta próximas (até 25% do preço atual) entram na escala para ficarem visíveis
    const lastC = d[d.length - 1].c;
    const lines = (this.lines || []).filter(l => Math.abs(l.price / lastC - 1) < 0.25);
    for (const l of lines) { min = Math.min(min, l.price); max = Math.max(max, l.price); }
    const span = (max - min) || max * 0.01;
    const lo = min - span * 0.08, hi = max + span * 0.08;
    this.stepX = (w - pad.l - pad.r) / (d.length - 1);
    const X = i => pad.l + i * this.stepX;
    const Y = v => pad.t + (1 - (v - lo) / (hi - lo)) * chartH;
    const color = this.color;
    const n = Math.max(2, Math.ceil(d.length * this.progress));

    // grade suave
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
    for (let g = 1; g < 4; g++) { const y = pad.t + chartH * g / 4; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }

    // volume colorido (verde = candle de alta, vermelho = baixa)
    const baseY = h - pad.b + volH - 6;
    const bw = Math.max(1, this.stepX * 0.6);
    for (let i = 0; i < n; i++) {
      const k = d[i];
      const vh = vMax ? (k.v / vMax) * volH : 0;
      ctx.fillStyle = hexA(k.c >= k.o ? UP : DOWN, this.hover === i ? 0.6 : 0.22);
      ctx.fillRect(X(i) - bw / 2, baseY - vh, bw, vh);
    }

    // linha da máxima histórica (ATH), se estiver dentro da faixa
    if (this.ath && this.ath <= hi * 1.0001 && this.ath >= lo) {
      const y = Y(this.ath);
      ctx.setLineDash([4, 4]); ctx.strokeStyle = hexA('#FFD166', 0.7);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#FFD166'; ctx.font = '600 10px -apple-system, system-ui';
      ctx.fillText('MÁX. HISTÓRICA', 8, y - 4);
    }

    // linhas de alerta de preço
    for (const l of lines) {
      const y = Y(l.price);
      ctx.setLineDash([6, 5]); ctx.strokeStyle = hexA(l.color, 0.85); ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = '700 10px -apple-system, system-ui';
      const txt = l.label; const tw = ctx.measureText(txt).width;
      ctx.fillStyle = hexA(l.color, 0.2); ctx.fillRect(w - tw - 14, y - 9, tw + 10, 16);
      ctx.fillStyle = l.color; ctx.fillText(txt, w - tw - 9, y + 3);
    }

    // área com degradê
    const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + chartH);
    grad.addColorStop(0, hexA(color, 0.38)); grad.addColorStop(0.6, hexA(color, 0.08)); grad.addColorStop(1, hexA(color, 0));
    ctx.beginPath(); ctx.moveTo(X(0), Y(d[0].c));
    for (let i = 1; i < n; i++) ctx.lineTo(X(i), Y(d[i].c));
    ctx.lineTo(X(n - 1), pad.t + chartH); ctx.lineTo(X(0), pad.t + chartH); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();

    // linha com brilho
    ctx.save();
    ctx.shadowColor = hexA(color, 0.8); ctx.shadowBlur = 12;
    const lg = ctx.createLinearGradient(0, 0, w, 0);
    lg.addColorStop(0, hexA(color, 0.55)); lg.addColorStop(1, color);
    ctx.strokeStyle = lg; ctx.lineWidth = 2.4; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(X(0), Y(d[0].c));
    for (let i = 1; i < n; i++) ctx.lineTo(X(i), Y(d[i].c));
    ctx.stroke(); ctx.restore();

    // marcadores de sinais de compra históricos
    if (this.markers.length && this.progress >= 1) {
      const set = new Set(this.markers);
      const t0 = d[0].t, dt = d.length > 1 ? d[1].t - d[0].t : 0;
      d.forEach((k, i) => {
        // marcador cai no candle cujo intervalo contém o horário do sinal
        const hit = [...set].some(t => t >= k.t && t < k.t + dt);
        if (!hit || k.t < t0) return;
        const x = X(i), y = Y(k.c);
        ctx.fillStyle = hexA(UP, 0.25); ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.fill();
        ctx.fillStyle = UP; ctx.beginPath(); ctx.arc(x, y, 3.2, 0, 7); ctx.fill();
        ctx.strokeStyle = '#0E0E12'; ctx.lineWidth = 1.2; ctx.stroke();
      });
    }

    // rótulos de mínima e máxima do período
    if (this.progress >= 1 && this.hover == null) {
      ctx.font = '600 11px -apple-system, system-ui';
      const label = (i, v, above, col) => {
        const txt = this.fmt(v);
        const tw = ctx.measureText(txt).width;
        let x = X(i) - tw / 2; x = Math.max(4, Math.min(w - tw - 4, x));
        const y = above ? Y(v) - 9 : Y(v) + 17;
        ctx.fillStyle = col; ctx.fillText(txt, x, y);
      };
      label(iMax, max, true, UP);
      label(iMin, min, false, DOWN);
    }

    // ponto pulsante no último preço
    if (this.progress >= 1) {
      const x = X(d.length - 1), y = Y(d[d.length - 1].c);
      const pulse = (performance.now() % 1600) / 1600;
      ctx.fillStyle = hexA(color, 0.35 * (1 - pulse)); ctx.beginPath(); ctx.arc(x, y, 4 + pulse * 10, 0, 7); ctx.fill();
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill();
      if (!this._pulsing) { this._pulsing = true; const loop = () => { if (!this.canvas.isConnected) { this._pulsing = false; return; } if (this.hover == null) this.draw(); setTimeout(() => requestAnimationFrame(loop), 50); }; loop(); }
    }

    // cursor de toque
    if (this.hover != null) {
      const i = this.hover, x = X(i), y = Y(d[i].c);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, pad.t - 10); ctx.lineTo(x, h - 4); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 5.5, 0, 7); ctx.fill();
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, 3.5, 0, 7); ctx.fill();
    }
  }
}

// ---------------------------------------------------------------------------
export function drawSpark(canvas, values, up) {
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  if (!values || values.length < 2) return;
  const min = Math.min(...values), max = Math.max(...values);
  const X = i => (i / (values.length - 1)) * w;
  const Y = v => 3 + (1 - (v - min) / ((max - min) || 1)) * (h - 6);
  const col = up ? UP : DOWN;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, hexA(col, 0.3)); g.addColorStop(1, hexA(col, 0));
  ctx.beginPath(); values.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
  ctx.beginPath(); values.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.stroke();
}

// Histograma dos resultados históricos da simulação (vermelho = prejuízo, verde = lucro)
export function drawHistogram(canvas, dist, highlight) {
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  if (!dist?.length) return;
  const lo = Math.max(dist[0], -0.5), hi = Math.min(dist[dist.length - 1], 0.8);
  const bins = 24, bw = (hi - lo) / bins || 0.01;
  const counts = new Array(bins).fill(0);
  dist.forEach(x => { const b = Math.max(0, Math.min(bins - 1, Math.floor((x - lo) / bw))); counts[b]++; });
  const cMax = Math.max(...counts);
  const gap = 2, barW = (w - gap * (bins - 1)) / bins;
  counts.forEach((cnt, b) => {
    const mid = lo + (b + 0.5) * bw;
    const bh = (cnt / cMax) * (h - 18);
    const x = b * (barW + gap), y = h - 14 - bh;
    const col = mid >= 0 ? UP : DOWN;
    const g = ctx.createLinearGradient(0, y, 0, h - 14);
    g.addColorStop(0, col); g.addColorStop(1, hexA(col, 0.25));
    ctx.fillStyle = g;
    const r = Math.min(4, barW / 2);
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, barW, bh, [r, r, 0, 0]) : ctx.rect(x, y, barW, bh); ctx.fill();
  });
  // linha do zero
  if (lo < 0 && hi > 0) {
    const x0 = ((0 - lo) / (hi - lo)) * w;
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x0, 0); ctx.lineTo(x0, h - 14); ctx.stroke(); ctx.setLineDash([]);
  }
  if (highlight != null && highlight >= lo && highlight <= hi) {
    const xm = ((highlight - lo) / (hi - lo)) * w;
    ctx.strokeStyle = VIOLET; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(xm, 0); ctx.lineTo(xm, h - 14); ctx.stroke();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.font = '500 10px -apple-system, system-ui';
  ctx.fillText(`${(lo * 100).toFixed(0)}%`, 0, h - 2);
  const t = `+${(hi * 100).toFixed(0)}%`; ctx.fillText(t, w - ctx.measureText(t).width, h - 2);
}

// Anel de pontuação (0–100) com gradiente vermelho → amarelo → verde
export function drawScoreRing(canvas, score) {
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 7;
  const start = Math.PI * 0.75, full = Math.PI * 1.5;
  ctx.lineCap = 'round'; ctx.lineWidth = 9;
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.beginPath(); ctx.arc(cx, cy, r, start, start + full); ctx.stroke();
  const g = ctx.createConicGradient ? ctx.createConicGradient(start, cx, cy) : null;
  if (g) { g.addColorStop(0, DOWN); g.addColorStop(0.35, '#FFD166'); g.addColorStop(0.7, UP); g.addColorStop(1, UP); }
  ctx.strokeStyle = g || scoreColor(score);
  ctx.beginPath(); ctx.arc(cx, cy, r, start, start + full * Math.max(0.01, score / 100)); ctx.stroke();
}

export function scoreColor(s) {
  if (s >= 65) return UP;
  if (s >= 50) return '#FFD166';
  if (s >= 35) return '#FF9F5A';
  return DOWN;
}

// Rosca de distribuição da carteira
export function drawDonut(canvas, segs) {
  if (!canvas) return;
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 8, lw = 16;
  if (r <= 0) return;   // tela ainda não visível
  const total = segs.reduce((a, g) => a + g.value, 0);
  ctx.lineWidth = lw; ctx.lineCap = 'butt';
  if (!total) { ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.stroke(); return; }
  let a0 = -Math.PI / 2;
  const gap = segs.length > 1 ? 0.04 : 0;
  for (const g of segs) {
    const a1 = a0 + (g.value / total) * Math.PI * 2;
    ctx.strokeStyle = g.color;
    ctx.shadowColor = g.color; ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.arc(cx, cy, r, a0 + gap / 2, Math.max(a0 + gap / 2 + 0.001, a1 - gap / 2)); ctx.stroke();
    a0 = a1;
  }
  ctx.shadowBlur = 0;
}

// Velocímetro 0–100 (Medo e Ganância): vermelho → laranja → amarelo → verde
export function drawGauge(canvas, value) {
  if (!canvas) return;
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h - 8, r = Math.min(w / 2, h) - 12;
  if (r <= 0) return;
  const cols = ['#FF5C7A', '#FF9F5A', '#FFD166', '#9BE564', '#2EE6A6'];
  ctx.lineWidth = 12; ctx.lineCap = 'butt';
  cols.forEach((c, k) => { ctx.strokeStyle = hexA(c, 0.9); ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI + k * Math.PI / 5 + 0.02, Math.PI + (k + 1) * Math.PI / 5 - 0.02); ctx.stroke(); });
  if (value == null) return;
  const a = Math.PI + (value / 100) * Math.PI;
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * (r - 4), cy + Math.sin(a) * (r - 4)); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(cx, cy, 5, 0, 7); ctx.fill();
}

// Barrinhas do histórico do índice (30 dias)
export function drawFngBars(canvas, data) {
  if (!canvas || !data?.length) return;
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const bw = w / data.length;
  data.forEach((d, i) => {
    const col = d.v <= 20 ? '#FF5C7A' : d.v <= 40 ? '#FF9F5A' : d.v <= 60 ? '#FFD166' : d.v <= 80 ? '#9BE564' : '#2EE6A6';
    const bh = Math.max(2, (d.v / 100) * h);
    ctx.fillStyle = hexA(col, i === data.length - 1 ? 1 : 0.7);
    ctx.fillRect(i * bw + 1, h - bh, bw - 2, bh);
  });
}
