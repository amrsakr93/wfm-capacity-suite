/**
 * Offscreen HiDPI Canvas Chart Renderer for Excel Mini-Dashboards
 * Produces crisp Concentrix-palette PNG data URLs to embed inside ExcelJS sheets.
 * Gracefully returns null in headless Node environments without a DOM canvas.
 */

const CHART_PALETTE = {
  bg: '#FFFFFF',
  headerBg: '#F8FAFC',
  border: '#D5E2EE',
  grid: '#E2E8F0',
  navy: '#0B2234',
  muted: '#475569',
  subtle: '#64748B',
  blueTop: '#00A3E0',
  blueBot: '#005A8D',
  tealTop: '#14B8A6',
  tealBot: '#0F766E',
  navyBarTop: '#005A8D',
  navyBarBot: '#003D5B',
  slaLine: '#0F766E',
  warn: '#D97706',
} as const;

interface CanvasSurface {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
}

function createHiDpiCanvas(width: number, height: number): CanvasSurface | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  const scale = 2;
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(scale, scale);
  ctx.textBaseline = 'middle';
  return { canvas, ctx, width, height };
}

function fillRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function drawCardFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  title: string,
  subtitle: string
): void {
  ctx.fillStyle = CHART_PALETTE.bg;
  fillRoundedRect(ctx, 0.5, 0.5, width - 1, height - 1, 10);
  ctx.fill();
  ctx.strokeStyle = CHART_PALETTE.border;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Top header band
  ctx.fillStyle = CHART_PALETTE.headerBg;
  ctx.fillRect(1, 1, width - 2, 46);
  ctx.fillStyle = CHART_PALETTE.blueTop;
  ctx.fillRect(1, 1, 5, 46);
  ctx.strokeStyle = CHART_PALETTE.grid;
  ctx.beginPath();
  ctx.moveTo(1, 47);
  ctx.lineTo(width - 1, 47);
  ctx.stroke();

  ctx.fillStyle = CHART_PALETTE.navy;
  ctx.font = '700 13px "Segoe UI", "Inter", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(title, 16, 17);

  ctx.fillStyle = CHART_PALETTE.subtle;
  ctx.font = '500 10.5px "Segoe UI", "Inter", sans-serif';
  ctx.fillText(subtitle, 16, 34);
}

function formatCompactVal(v: number): string {
  if (Math.abs(v) >= 100000) return `${(v / 1000).toFixed(0)}k`;
  if (Math.abs(v) >= 10000) return `${(v / 1000).toFixed(1)}k`;
  if (Math.abs(v) >= 100) return Math.round(v).toLocaleString('en-US');
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

export interface ColumnChartBar {
  label: string;
  value: number;
  highlight?: boolean;
  secondaryValue?: number;
}

export function renderColumnDashboardChartPng(opts: {
  title: string;
  subtitle: string;
  bars: ColumnChartBar[];
  primaryLabel: string;
  highlightLabel?: string;
  secondaryLineLabel?: string;
  width?: number;
  height?: number;
}): string | null {
  const {
    title,
    subtitle,
    bars,
    primaryLabel,
    highlightLabel,
    secondaryLineLabel,
    width = 620,
    height = 290,
  } = opts;
  const surface = createHiDpiCanvas(width, height);
  if (!surface || bars.length === 0) return null;

  const { ctx } = surface;
  drawCardFrame(ctx, width, height, title, subtitle);

  // Legend badges in top-right of card header
  let legendX = width - 16;
  ctx.font = '600 10px "Segoe UI", sans-serif';
  const legendItems: { label: string; color: string; isLine?: boolean }[] = [];
  if (secondaryLineLabel) legendItems.push({ label: secondaryLineLabel, color: CHART_PALETTE.slaLine, isLine: true });
  if (highlightLabel) legendItems.push({ label: highlightLabel, color: CHART_PALETTE.tealTop });
  legendItems.push({ label: primaryLabel, color: CHART_PALETTE.blueTop });

  for (const item of legendItems) {
    const tw = ctx.measureText(item.label).width;
    ctx.fillStyle = CHART_PALETTE.muted;
    ctx.textAlign = 'right';
    ctx.fillText(item.label, legendX, 24);
    const dotX = legendX - tw - 14;
    if (item.isLine) {
      ctx.strokeStyle = item.color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(dotX - 6, 24);
      ctx.lineTo(dotX + 6, 24);
      ctx.stroke();
    } else {
      ctx.fillStyle = item.color;
      fillRoundedRect(ctx, dotX - 4, 20, 8, 8, 2);
      ctx.fill();
    }
    legendX = dotX - 18;
  }

  const padL = 52;
  const padR = secondaryLineLabel ? 46 : 20;
  const padT = 68;
  const padB = 40;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const maxVal = Math.max(1, ...bars.map((b) => b.value)) * 1.15;

  // Gridlines & Y labels
  const ticks = 4;
  ctx.font = '500 10px "Segoe UI", sans-serif';
  for (let i = 0; i <= ticks; i++) {
    const ratio = i / ticks;
    const y = padT + plotH * (1 - ratio);
    ctx.strokeStyle = CHART_PALETTE.grid;
    ctx.lineWidth = i === 0 ? 1.2 : 0.8;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();

    ctx.fillStyle = CHART_PALETTE.subtle;
    ctx.textAlign = 'right';
    ctx.fillText(formatCompactVal(maxVal * ratio), padL - 8, y);

    if (secondaryLineLabel) {
      ctx.textAlign = 'left';
      ctx.fillStyle = CHART_PALETTE.slaLine;
      ctx.fillText(`${Math.round(ratio * 100)}%`, padL + plotW + 6, y);
    }
  }

  // Bars
  const slotW = plotW / bars.length;
  const barW = Math.max(4, Math.min(38, slotW * 0.64));
  const showValueAbove = bars.length <= 14;
  const labelEvery = bars.length > 24 ? Math.ceil(bars.length / 8) : bars.length > 12 ? 2 : 1;

  bars.forEach((b, idx) => {
    const barH = Math.max(2, (b.value / maxVal) * plotH);
    const x = padL + idx * slotW + (slotW - barW) / 2;
    const y = padT + plotH - barH;

    const grad = ctx.createLinearGradient(0, y, 0, y + barH);
    if (b.highlight) {
      grad.addColorStop(0, CHART_PALETTE.tealTop);
      grad.addColorStop(1, CHART_PALETTE.tealBot);
    } else {
      grad.addColorStop(0, CHART_PALETTE.blueTop);
      grad.addColorStop(1, CHART_PALETTE.blueBot);
    }
    ctx.fillStyle = grad;
    fillRoundedRect(ctx, x, y, barW, barH, Math.min(4, barW / 2));
    ctx.fill();

    if (showValueAbove) {
      ctx.fillStyle = b.highlight ? CHART_PALETTE.tealBot : CHART_PALETTE.navy;
      ctx.font = '700 10px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(formatCompactVal(b.value), x + barW / 2, y - 9);
    }

    if (idx % labelEvery === 0) {
      ctx.fillStyle = CHART_PALETTE.muted;
      ctx.font = '600 9.5px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(b.label, x + barW / 2, padT + plotH + 15);
    }
  });

  // Optional Secondary Line (e.g. Expected SLA % 0-100%)
  if (secondaryLineLabel) {
    const pts = bars
      .map((b, idx) =>
        b.secondaryValue != null
          ? {
              x: padL + idx * slotW + slotW / 2,
              y: padT + plotH * (1 - Math.max(0, Math.min(100, b.secondaryValue)) / 100),
            }
          : null
      )
      .filter((p): p is { x: number; y: number } => p !== null);

    if (pts.length >= 2) {
      ctx.strokeStyle = CHART_PALETTE.slaLine;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      pts.forEach((p, idx) => (idx === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  return surface.canvas.toDataURL('image/png');
}

export interface HorizontalBarItem {
  label: string;
  value: number;
  valueLabel: string;
  highlight?: boolean;
}

export function renderHorizontalBarChartPng(opts: {
  title: string;
  subtitle: string;
  items: HorizontalBarItem[];
  width?: number;
  height?: number;
}): string | null {
  const { title, subtitle, items, width = 620, height = 290 } = opts;
  const surface = createHiDpiCanvas(width, height);
  if (!surface || items.length === 0) return null;

  const { ctx } = surface;
  drawCardFrame(ctx, width, height, title, subtitle);

  const topY = 60;
  const bottomPad = 14;
  const availH = height - topY - bottomPad;
  const rowH = availH / items.length;
  const labelW = 195;
  const valueW = 98;
  const trackX = labelW + 10;
  const trackW = width - trackX - valueW - 16;
  const maxVal = Math.max(1e-6, ...items.map((i) => Math.abs(i.value)));

  items.forEach((item, idx) => {
    const cy = topY + idx * rowH + rowH / 2;
    const barH = Math.max(10, Math.min(20, rowH * 0.52));

    // Row divider
    if (idx > 0) {
      ctx.strokeStyle = '#F1F5F9';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(14, topY + idx * rowH);
      ctx.lineTo(width - 14, topY + idx * rowH);
      ctx.stroke();
    }

    // Label
    ctx.fillStyle = item.highlight ? CHART_PALETTE.navy : CHART_PALETTE.muted;
    ctx.font = item.highlight ? '700 10.5px "Segoe UI", sans-serif' : '600 10px "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    const trimmed = item.label.length > 30 ? `${item.label.slice(0, 29)}…` : item.label;
    ctx.fillText(trimmed, 16, cy);

    // Track
    ctx.fillStyle = '#EEF3F8';
    fillRoundedRect(ctx, trackX, cy - barH / 2, trackW, barH, 4);
    ctx.fill();

    // Fill Bar
    const fillW = Math.max(6, (Math.abs(item.value) / maxVal) * trackW);
    const grad = ctx.createLinearGradient(trackX, 0, trackX + fillW, 0);
    if (item.highlight) {
      grad.addColorStop(0, CHART_PALETTE.tealBot);
      grad.addColorStop(1, CHART_PALETTE.tealTop);
    } else {
      grad.addColorStop(0, CHART_PALETTE.navyBarBot);
      grad.addColorStop(1, CHART_PALETTE.blueTop);
    }
    ctx.fillStyle = grad;
    fillRoundedRect(ctx, trackX, cy - barH / 2, fillW, barH, 4);
    ctx.fill();

    // Value Callout
    ctx.fillStyle = item.highlight ? CHART_PALETTE.tealBot : CHART_PALETTE.navy;
    ctx.font = '700 10.5px "Segoe UI", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(item.valueLabel, width - 16, cy);
  });

  return surface.canvas.toDataURL('image/png');
}

export function renderSplitHorizonLineChartPng(opts: {
  title: string;
  subtitle: string;
  points: { label: string; value: number; isSecondPhase: boolean }[];
  phase1Label: string;
  phase2Label: string;
  splitIndex: number;
  width?: number;
  height?: number;
}): string | null {
  const {
    title,
    subtitle,
    points,
    phase1Label,
    phase2Label,
    splitIndex,
    width = 660,
    height = 270,
  } = opts;
  const surface = createHiDpiCanvas(width, height);
  if (!surface || points.length < 2) return null;

  const { ctx } = surface;
  drawCardFrame(ctx, width, height, title, subtitle);

  // Legend
  ctx.font = '600 10px "Segoe UI", sans-serif';
  ctx.textAlign = 'right';
  ctx.fillStyle = CHART_PALETTE.tealBot;
  ctx.fillText(`● ${phase2Label}`, width - 16, 24);
  ctx.fillStyle = CHART_PALETTE.blueBot;
  ctx.fillText(`● ${phase1Label}`, width - 175, 24);

  const padL = 54;
  const padR = 20;
  const padT = 66;
  const padB = 36;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const vals = points.map((p) => p.value);
  const minVal = Math.min(...vals) * 0.85;
  const maxVal = Math.max(minVal + 1, Math.max(...vals) * 1.1);

  for (let i = 0; i <= 4; i++) {
    const ratio = i / 4;
    const y = padT + plotH * (1 - ratio);
    ctx.strokeStyle = CHART_PALETTE.grid;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();

    ctx.fillStyle = CHART_PALETTE.subtle;
    ctx.font = '500 10px "Segoe UI", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(formatCompactVal(minVal + (maxVal - minVal) * ratio), padL - 8, y);
  }

  const coords = points.map((p, idx) => ({
    x: padL + (idx / (points.length - 1)) * plotW,
    y: padT + plotH * (1 - (p.value - minVal) / (maxVal - minVal)),
    label: p.label,
    isSecondPhase: p.isSecondPhase,
  }));

  // Phase 2 shaded backdrop
  const splitCoord = coords[Math.min(splitIndex, coords.length - 1)];
  ctx.fillStyle = 'rgba(20, 184, 166, 0.08)';
  ctx.fillRect(splitCoord.x, padT, padL + plotW - splitCoord.x, plotH);

  // Phase divider
  ctx.strokeStyle = CHART_PALETTE.tealTop;
  ctx.lineWidth = 1.2;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(splitCoord.x, padT);
  ctx.lineTo(splitCoord.x, padT + plotH);
  ctx.stroke();
  ctx.setLineDash([]);

  // Draw area + line per segment cleanly
  const drawPhase = (segment: typeof coords, lineColor: string, fillColor: string) => {
    if (segment.length < 2) return;
    ctx.fillStyle = fillColor;
    ctx.beginPath();
    ctx.moveTo(segment[0].x, padT + plotH);
    segment.forEach((pt) => ctx.lineTo(pt.x, pt.y));
    ctx.lineTo(segment[segment.length - 1].x, padT + plotH);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    segment.forEach((pt, idx) => (idx === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)));
    ctx.stroke();
  };

  const phase1Pts = coords.slice(0, Math.min(splitIndex + 1, coords.length));
  const phase2Pts = coords.slice(Math.max(0, splitIndex));
  drawPhase(phase1Pts, CHART_PALETTE.blueTop, 'rgba(0, 163, 224, 0.14)');
  drawPhase(phase2Pts, CHART_PALETTE.tealTop, 'rgba(20, 184, 166, 0.16)');

  // Sparse X labels
  const step = Math.max(1, Math.floor(coords.length / 8));
  ctx.fillStyle = CHART_PALETTE.muted;
  ctx.font = '600 9.5px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  coords.forEach((pt, idx) => {
    if (idx % step === 0 || idx === coords.length - 1) {
      ctx.fillText(pt.label.slice(5), pt.x, padT + plotH + 15);
    }
  });

  return surface.canvas.toDataURL('image/png');
}
