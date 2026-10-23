function fit(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || name;
}

function grid(g, w, h, lines, pad) {
  g.strokeStyle = 'rgba(255,255,255,0.06)';
  g.lineWidth = 1;
  for (let i = 0; i <= lines; i++) {
    const y = Math.round(pad.t + ((h - pad.t - pad.b) * i) / lines) + 0.5;
    g.beginPath();
    g.moveTo(pad.l, y);
    g.lineTo(w - pad.r, y);
    g.stroke();
  }
}

function path(g, pts) {
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
}

// Minimal time-series chart drawn straight onto a canvas.
export class LineChart {
  constructor(canvas, series, { window = 120, minMax = 1, unit = '' } = {}) {
    this.canvas = canvas;
    this.series = series.map((s) => ({ ...s, color: s.color.startsWith('--') ? css(s.color) : s.color }));
    this.window = window;
    this.minMax = minMax;
    this.unit = unit;
  }

  draw(data) {
    const { g, w, h } = fit(this.canvas);
    const pad = { l: 34, r: 8, t: 8, b: 14 };
    const rows = data.slice(-this.window);
    let max = this.minMax;
    for (const r of rows) for (const s of this.series) max = Math.max(max, r[s.key] ?? 0);
    max = niceMax(max);
    grid(g, w, h, 3, pad);
    g.fillStyle = 'rgba(200,210,230,0.45)';
    g.font = '10px "JetBrains Mono", monospace';
    g.textAlign = 'right';
    for (let i = 0; i <= 3; i++) {
      const v = max - (max * i) / 3;
      g.fillText(fmt(v), pad.l - 6, pad.t + ((h - pad.t - pad.b) * i) / 3 + 3);
    }
    if (rows.length < 2) {
      g.textAlign = 'center';
      g.fillText('collecting samples…', w / 2, h / 2);
      return;
    }
    const X = (i) => pad.l + ((w - pad.l - pad.r) * i) / (this.window - 1);
    const offset = this.window - rows.length;
    const Y = (v) => pad.t + (h - pad.t - pad.b) * (1 - v / max);
    for (const s of this.series) {
      const pts = rows.map((r, i) => [X(i + offset), Y(r[s.key] ?? 0)]);
      if (s.fill) {
        const grad = g.createLinearGradient(0, pad.t, 0, h - pad.b);
        grad.addColorStop(0, hexA(s.color, 0.35));
        grad.addColorStop(1, hexA(s.color, 0));
        path(g, pts);
        g.lineTo(pts.at(-1)[0], h - pad.b);
        g.lineTo(pts[0][0], h - pad.b);
        g.closePath();
        g.fillStyle = grad;
        g.fill();
      }
      path(g, pts);
      g.strokeStyle = s.color;
      g.lineWidth = 1.8;
      g.lineJoin = 'round';
      g.stroke();
      const [lx, ly] = pts.at(-1);
      g.fillStyle = s.color;
      g.beginPath();
      g.arc(lx, ly, 2.8, 0, Math.PI * 2);
      g.fill();
    }
  }
}

// Serving RSRP and SINR over the last 30 s, with handover markers.
export function drawUeChart(canvas, history, colors) {
  const { g, w, h } = fit(canvas);
  const pad = { l: 30, r: 30, t: 8, b: 8 };
  grid(g, w, h, 4, pad);
  if (history.length < 2) return;
  const t0 = history.at(-1).t - 30_000;
  const X = (t) => pad.l + ((w - pad.l - pad.r) * (t - t0)) / 30_000;
  const Yr = (v) => pad.t + (h - pad.t - pad.b) * (1 - (Math.max(-130, Math.min(-40, v)) + 130) / 90);
  const Ys = (v) => pad.t + (h - pad.t - pad.b) * (1 - (Math.max(-10, Math.min(35, v)) + 10) / 45);

  g.font = '9.5px "JetBrains Mono", monospace';
  g.fillStyle = 'rgba(200,210,230,0.45)';
  g.textAlign = 'right';
  g.fillText('-40', pad.l - 4, pad.t + 7);
  g.fillText('-130', pad.l - 4, h - pad.b);
  g.textAlign = 'left';
  g.fillText('35', w - pad.r + 4, pad.t + 7);
  g.fillText('-10', w - pad.r + 4, h - pad.b);

  // Handover / outage markers
  for (let i = 1; i < history.length; i++) {
    const a = history[i - 1];
    const b = history[i];
    if (b.serving !== a.serving) {
      const x = X(b.t);
      g.strokeStyle = b.serving ? 'rgba(255,255,255,0.5)' : 'rgba(255,82,82,0.8)';
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(x, pad.t);
      g.lineTo(x, h - pad.b);
      g.stroke();
      g.setLineDash([]);
    }
  }

  const segs = (key, Y, color, width) => {
    g.strokeStyle = color;
    g.lineWidth = width;
    g.beginPath();
    let pen = false;
    for (const r of history) {
      if (r.t < t0) continue;
      if (!r.serving) {
        pen = false;
        continue;
      }
      const x = X(r.t);
      const y = Y(r[key]);
      if (pen) g.lineTo(x, y);
      else g.moveTo(x, y);
      pen = true;
    }
    g.stroke();
  };
  segs('sinr', Ys, colors.sinr, 1.4);
  segs('rsrp', Yr, colors.rsrp, 2);
}

function niceMax(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function fmt(v) {
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`;
  return v >= 10 ? v.toFixed(0) : v.toFixed(1);
}

function hexA(color, a) {
  const m = color.match(/^#([0-9a-f]{6})$/i);
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
