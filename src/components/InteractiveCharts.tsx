import React, { useEffect, useRef, useState } from 'react';
import type { ErlangAgentMode, IntervalStaffingRow } from '../engine/types.ts';

function useContainerWidth(defaultWidth = 1360): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number>(defaultWidth);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 240) {
        setWidth(Math.round(rect.width - 32));
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  return [ref, width];
}

export interface TrajectoryPoint {
  index: number;
  label: string;
  actual?: number;
  trainFit?: number;
  holdoutPred?: number;
  futurePred?: number;
}

/** Smooth Catmull-Rom / Cubic Bezier SVG path generator */
function toSmoothSpline(coords: { x: number; y: number }[]): string {
  if (coords.length === 0) return '';
  if (coords.length === 1) return `M${coords[0].x.toFixed(1)},${coords[0].y.toFixed(1)}`;
  let d = `M${coords[0].x.toFixed(1)},${coords[0].y.toFixed(1)}`;
  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = coords[Math.max(0, i - 1)];
    const p1 = coords[i];
    const p2 = coords[i + 1];
    const p3 = coords[Math.min(coords.length - 1, i + 2)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

/** Shared magnetic proximity ripple transform & focus opacity across all bar charts */
function getBarWaveStyle(
  idx: number,
  hoverIdx: number | null,
  baseOpacity = 0.88,
  scaleBoost = 1
): React.CSSProperties {
  if (hoverIdx === null) {
    return {
      opacity: baseOpacity,
      transform: 'translateY(0px) scaleX(1) scaleY(1)',
    };
  }
  const dist = Math.abs(idx - hoverIdx);
  if (dist === 0) {
    return {
      opacity: 1,
      transform: `translateY(-2px) scaleX(${(1 + 0.12 * scaleBoost).toFixed(3)}) scaleY(${(1 + 0.07 * scaleBoost).toFixed(3)})`,
      filter: 'brightness(1.16) drop-shadow(0 0 7px var(--cnx-bar-glow))',
    };
  }
  if (dist === 1) {
    return {
      opacity: 0.96,
      transform: `translateY(-1px) scaleX(${(1 + 0.05 * scaleBoost).toFixed(3)}) scaleY(${(1 + 0.038 * scaleBoost).toFixed(3)})`,
      filter: 'brightness(1.06)',
    };
  }
  if (dist === 2) {
    return {
      opacity: 0.9,
      transform: `translateY(-0.5px) scaleX(${(1 + 0.02 * scaleBoost).toFixed(3)}) scaleY(${(1 + 0.016 * scaleBoost).toFixed(3)})`,
    };
  }
  return {
    opacity: Math.max(0.54, baseOpacity - 0.28),
    transform: 'translateY(0px) scaleX(1) scaleY(1)',
  };
}

export const InteractiveForecastChart: React.FC<{ data: TrajectoryPoint[] }> = ({ data }) => {
  const [containerRef, w] = useContainerWidth(1480);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [pinnedIdx, setPinnedIdx] = useState<number | null>(null);
  const [chartStyle, setChartStyle] = useState<'spline' | 'bars'>('spline');
  const [zoomFuture, setZoomFuture] = useState<boolean>(false);
  const [showSeries, setShowSeries] = useState({
    actual: true,
    train: true,
    holdout: true,
    future: true,
  });

  if (data.length === 0) return null;

  const visibleData = zoomFuture ? data.slice(Math.max(0, data.length - 28)) : data;

  const h = 285;
  const padL = 48;
  const padR = 18;
  const padT = 24;
  const padB = 34;
  const plotW = Math.max(200, w - padL - padR);
  const plotH = h - padT - padB;

  const allVals = visibleData.flatMap((d) =>
    [
      showSeries.actual ? d.actual : undefined,
      showSeries.train ? d.trainFit : undefined,
      showSeries.holdout ? d.holdoutPred : undefined,
      showSeries.future ? d.futurePred : undefined,
    ].filter((v): v is number => v !== undefined && Number.isFinite(v))
  );
  const maxV = Math.max(300, ...(allVals.length ? allVals : [1000])) * 1.08;
  const rawMin = allVals.length ? Math.min(...allVals) : 200;
  const minV = rawMin >= 200 ? 200 : 0;
  const spanV = Math.max(1, maxV - minV);
  const totalPts = Math.max(2, visibleData.length);

  const xOf = (idx: number) => padL + (idx / (totalPts - 1)) * plotW;
  const yOf = (val: number) => padT + plotH - ((val - minV) / spanV) * plotH;

  const actualCoords: { idx: number; x: number; y: number; val: number }[] = [];
  const trainCoords: { idx: number; x: number; y: number; val: number }[] = [];
  const holdoutCoords: { idx: number; x: number; y: number; val: number }[] = [];
  const futureCoords: { idx: number; x: number; y: number; val: number }[] = [];

  visibleData.forEach((d, idx) => {
    const x = xOf(idx);
    if (showSeries.actual && d.actual !== undefined)
      actualCoords.push({ idx, x, y: yOf(d.actual), val: d.actual });
    if (showSeries.train && d.trainFit !== undefined)
      trainCoords.push({ idx, x, y: yOf(d.trainFit), val: d.trainFit });
    if (showSeries.holdout && d.holdoutPred !== undefined)
      holdoutCoords.push({ idx, x, y: yOf(d.holdoutPred), val: d.holdoutPred });
    if (showSeries.future && d.futurePred !== undefined)
      futureCoords.push({ idx, x, y: yOf(d.futurePred), val: d.futurePred });
  });

  if (trainCoords.length > 0 && holdoutCoords.length > 0) {
    const lastTrain = trainCoords[trainCoords.length - 1];
    if (holdoutCoords[0].idx > lastTrain.idx) holdoutCoords.unshift(lastTrain);
  }
  if (futureCoords.length > 0) {
    const anchor =
      holdoutCoords.length > 0
        ? holdoutCoords[holdoutCoords.length - 1]
        : actualCoords.length > 0
          ? actualCoords[actualCoords.length - 1]
          : null;
    if (anchor && futureCoords[0].idx > anchor.idx) futureCoords.unshift(anchor);
  }

  const toArea = (coords: { x: number; y: number }[]) => {
    if (coords.length < 2) return '';
    const line = toSmoothSpline(coords);
    const firstX = coords[0].x.toFixed(1);
    const lastX = coords[coords.length - 1].x.toFixed(1);
    const baseY = (padT + plotH).toFixed(1);
    return `${line} L${lastX},${baseY} L${firstX},${baseY} Z`;
  };

  const firstFutureIdx = visibleData.findIndex((d) => d.futurePred !== undefined);
  const futureStartX = firstFutureIdx >= 0 ? xOf(firstFutureIdx) : null;

  const activeIdx = hoverIdx ?? pinnedIdx;
  const hovered = activeIdx !== null && visibleData[activeIdx] ? visibleData[activeIdx] : null;
  const hoverX = activeIdx !== null ? xOf(activeIdx) : 0;

  return (
    <div
      ref={containerRef}
      className="cnx-chart-surface relative w-full select-none rounded-2xl border p-4 shadow-inner"
    >
      {/* Interactive Controls Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3 pb-2.5 border-b border-slate-200 dark:border-[#00A3E0]/15">
        {/* Clickable Series Toggle Pills */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowSeries((s) => ({ ...s, actual: !s.actual }))}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-bold border transition cursor-pointer ${
              showSeries.actual
                ? 'border-[#0073A8]/35 bg-[#0073A8]/10 text-[#0073A8] dark:border-[#00A3E0]/50 dark:bg-[#00A3E0]/15 dark:text-[#00A3E0]'
                : 'border-slate-300 dark:border-slate-700/50 opacity-50 text-slate-500 dark:text-slate-400'
            }`}
          >
            <span className="w-2.5 h-2.5 rounded-full bg-[#0073A8] dark:bg-[#00A3E0] inline-block" />
            Actual History
          </button>

          <button
            type="button"
            onClick={() => setShowSeries((s) => ({ ...s, train: !s.train }))}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-bold border transition cursor-pointer ${
              showSeries.train
                ? 'border-slate-400/50 bg-slate-200/75 text-slate-700 dark:border-[#5B8FA8]/50 dark:bg-[#003D5B]/40 dark:text-slate-200'
                : 'border-slate-300 dark:border-slate-700/50 opacity-50 text-slate-500 dark:text-slate-400'
            }`}
          >
            <span className="w-3 h-0.5 border-t-2 border-dashed border-slate-500 dark:border-[#5B8FA8] inline-block" />
            Train Fit (80%)
          </button>

          <button
            type="button"
            onClick={() => setShowSeries((s) => ({ ...s, holdout: !s.holdout }))}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-bold border transition cursor-pointer ${
              showSeries.holdout
                ? 'border-[#0D826E]/35 bg-[#0D826E]/10 text-[#0D826E] dark:border-[#00C389]/50 dark:bg-[#00C389]/15 dark:text-[#00C389]'
                : 'border-slate-300 dark:border-slate-700/50 opacity-50 text-slate-500 dark:text-slate-400'
            }`}
          >
            <span className="w-2.5 h-2.5 rounded-full bg-[#0D826E] dark:bg-[#00C389] inline-block" />
            Holdout Backtest (20%)
          </button>

          <button
            type="button"
            onClick={() => setShowSeries((s) => ({ ...s, future: !s.future }))}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-bold border transition cursor-pointer ${
              showSeries.future
                ? 'border-[#0D9488]/40 bg-[#0D9488]/10 text-[#0F766E] dark:border-[#25E2CC]/60 dark:bg-[#25E2CC]/15 dark:text-[#25E2CC]'
                : 'border-slate-300 dark:border-slate-700/50 opacity-50 text-slate-500 dark:text-slate-400'
            }`}
          >
            <span className="w-2.5 h-2.5 rounded-full bg-[#0D9488] dark:bg-[#25E2CC] animate-ping inline-block" />
            Future Forecast
          </button>
        </div>

        {/* Interactive Chart Style & Zoom Switchers */}
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg border border-slate-300 bg-white dark:border-[#00A3E0]/30 dark:bg-[#001421] p-0.5 text-[11px]">
            <button
              type="button"
              onClick={() => setChartStyle('spline')}
              className={`px-2.5 py-1 rounded-md font-bold transition cursor-pointer ${
                chartStyle === 'spline'
                  ? 'cnx-btn-active'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
              }`}
            >
              Glowing Spline
            </button>
            <button
              type="button"
              onClick={() => setChartStyle('bars')}
              className={`px-2.5 py-1 rounded-md font-bold transition cursor-pointer ${
                chartStyle === 'bars'
                  ? 'cnx-btn-active'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
              }`}
            >
              Volume Bars
            </button>
          </div>

          <button
            type="button"
            onClick={() => {
              setZoomFuture((z) => !z);
              setPinnedIdx(null);
            }}
            className={`px-2.5 py-1 rounded-lg border text-[11px] font-bold transition cursor-pointer ${
              zoomFuture
                ? 'border-[#0D9488] bg-[#0D9488]/15 text-[#0F766E] dark:border-[#25E2CC] dark:bg-[#25E2CC]/20 dark:text-[#25E2CC]'
                : 'border-slate-300 bg-white text-slate-700 hover:border-[#0073A8] dark:border-[#00A3E0]/30 dark:bg-[#001421] dark:text-slate-300 dark:hover:border-[#00A3E0]'
            }`}
          >
            {zoomFuture ? 'Zoom: Last 28d + Future' : 'Zoom: Full Horizon'}
          </button>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full h-64 overflow-visible cursor-crosshair"
        onMouseLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient id="actualAreaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--cnx-chart-actual)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--cnx-chart-actual)" stopOpacity="0.0" />
          </linearGradient>
          <linearGradient id="holdoutAreaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--cnx-chart-holdout)" stopOpacity="0.24" />
            <stop offset="100%" stopColor="var(--cnx-chart-holdout)" stopOpacity="0.0" />
          </linearGradient>
          <linearGradient id="futureAreaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--cnx-chart-future)" stopOpacity="0.32" />
            <stop offset="100%" stopColor="var(--cnx-chart-future)" stopOpacity="0.02" />
          </linearGradient>
          <filter id="cnx-line-glow" x="-10%" y="-20%" width="120%" height="140%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {futureStartX !== null && (
          <g>
            <rect
              x={futureStartX}
              y={padT}
              width={Math.max(0, w - padR - futureStartX)}
              height={plotH}
              fill="var(--cnx-chart-horizon-bg)"
              rx={8}
            />
            <line
              x1={futureStartX}
              y1={padT}
              x2={futureStartX}
              y2={padT + plotH}
              stroke="var(--cnx-chart-future)"
              strokeWidth={1.6}
              strokeDasharray="4 4"
            />
            <rect
              x={futureStartX + 8}
              y={padT + 4}
              width={132}
              height={18}
              rx={5}
              fill="var(--cnx-chart-horizon-badge)"
              stroke="var(--cnx-chart-future)"
              strokeWidth={1}
            />
            <text
              x={futureStartX + 15}
              y={padT + 16}
              fill="var(--cnx-chart-future-text)"
              fontSize="10"
              fontWeight="700"
            >
              FUTURE HORIZON →
            </text>
          </g>
        )}

        {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
          const y = padT + frac * plotH;
          const val = Math.round(maxV - frac * spanV);
          return (
            <g key={frac}>
              <line
                x1={padL}
                y1={y}
                x2={w - padR}
                y2={y}
                stroke="var(--cnx-chart-grid)"
                strokeDasharray="3 3"
              />
              <text
                x={padL - 8}
                y={y + 4}
                textAnchor="end"
                fill="var(--cnx-chart-axis)"
                className="text-[10px] font-mono"
              >
                {val.toLocaleString()}
              </text>
            </g>
          );
        })}

        {chartStyle === 'spline' ? (
          <>
            {actualCoords.length > 1 && <path d={toArea(actualCoords)} fill="url(#actualAreaGrad)" />}
            {holdoutCoords.length > 1 && <path d={toArea(holdoutCoords)} fill="url(#holdoutAreaGrad)" />}
            {futureCoords.length > 1 && <path d={toArea(futureCoords)} fill="url(#futureAreaGrad)" />}

            {actualCoords.length > 1 && (
              <path
                d={toSmoothSpline(actualCoords)}
                fill="none"
                stroke="var(--cnx-chart-actual)"
                strokeWidth={2.8}
                filter="url(#cnx-line-glow)"
                className="cnx-svg-glow"
                strokeLinecap="round"
              />
            )}
            {trainCoords.length > 1 && (
              <path
                d={toSmoothSpline(trainCoords)}
                fill="none"
                stroke="var(--cnx-chart-train)"
                strokeWidth={1.8}
                strokeDasharray="5 4"
                opacity={0.75}
              />
            )}
            {holdoutCoords.length > 1 && (
              <path
                d={toSmoothSpline(holdoutCoords)}
                fill="none"
                stroke="var(--cnx-chart-holdout)"
                strokeWidth={3}
                filter="url(#cnx-line-glow)"
                className="cnx-svg-glow"
                strokeLinecap="round"
              />
            )}
            {futureCoords.length > 1 && (
              <path
                d={toSmoothSpline(futureCoords)}
                fill="none"
                stroke="var(--cnx-chart-future)"
                strokeWidth={3.2}
                filter="url(#cnx-line-glow)"
                strokeLinecap="round"
                className="cnx-chart-pulse-line cnx-svg-glow"
              />
            )}
            {/* Visible glowing nodes on Future Forecast points */}
            {futureCoords.slice(1).map((c) => (
              <circle
                key={`fnode-${c.idx}`}
                cx={c.x}
                cy={c.y}
                r={3.2}
                fill="var(--cnx-chart-future)"
                stroke="var(--cnx-chart-node-stroke)"
                strokeWidth={1.2}
              />
            ))}
          </>
        ) : (
          /* Interactive Grouped Bar Mode */
          visibleData.map((d, idx) => {
            const xCenter = xOf(idx);
            const barW = Math.max(4, (plotW / visibleData.length) * 0.62);
            const primaryVal = d.futurePred ?? d.holdoutPred ?? d.actual ?? 0;
            const barColor =
              d.futurePred !== undefined
                ? 'var(--cnx-chart-future)'
                : d.holdoutPred !== undefined
                  ? 'var(--cnx-chart-holdout)'
                  : 'var(--cnx-chart-actual)';
            const topY = yOf(primaryVal);
            const barH = Math.max(2, padT + plotH - topY);
            const delayMs = Math.round((idx / Math.max(1, visibleData.length - 1)) * 280);
            return (
              <g
                key={idx}
                className="cnx-svg-bar-enter"
                style={{ animationDelay: `${delayMs}ms` }}
              >
                <rect
                  x={xCenter - barW / 2}
                  y={topY}
                  width={barW}
                  height={barH}
                  rx={2.5}
                  fill={barColor}
                  className="cnx-svg-bar"
                  style={getBarWaveStyle(idx, activeIdx, 0.85, visibleData.length > 35 ? 1 : 0.75)}
                />
              </g>
            );
          })
        )}

        {/* X Axis Date Labels */}
        {visibleData.map((d, idx) => {
          const step = Math.max(1, Math.floor(visibleData.length / 9));
          if (idx % step !== 0 && idx !== visibleData.length - 1) return null;
          return (
            <text
              key={idx}
              x={xOf(idx)}
              y={h - 8}
              textAnchor="middle"
              fill={
                d.futurePred !== undefined
                  ? 'var(--cnx-chart-future-text)'
                  : 'var(--cnx-chart-axis)'
              }
              className={`text-[10px] font-mono ${
                d.futurePred !== undefined ? 'font-bold' : ''
              }`}
            >
              {d.label.slice(-5)}
            </text>
          );
        })}

        {/* Hover / Pinned Crosshair & Active Circles */}
        {hovered && activeIdx !== null && (
          <g>
            <line
              x1={hoverX}
              y1={padT}
              x2={hoverX}
              y2={padT + plotH}
              stroke="var(--cnx-chart-future)"
              strokeWidth={1.6}
              strokeDasharray="3 3"
            />
            {hovered.actual !== undefined && showSeries.actual && (
              <circle
                cx={hoverX}
                cy={yOf(hovered.actual)}
                r={6}
                fill="var(--cnx-chart-actual)"
                stroke="#ffffff"
                strokeWidth={2}
              />
            )}
            {hovered.holdoutPred !== undefined && showSeries.holdout && (
              <circle
                cx={hoverX}
                cy={yOf(hovered.holdoutPred)}
                r={6}
                fill="var(--cnx-chart-holdout)"
                stroke="#ffffff"
                strokeWidth={2}
              />
            )}
            {hovered.futurePred !== undefined && showSeries.future && (
              <circle
                cx={hoverX}
                cy={yOf(hovered.futurePred)}
                r={6.5}
                fill="var(--cnx-chart-future)"
                stroke="#ffffff"
                strokeWidth={2}
              />
            )}
          </g>
        )}

        {/* Invisible Hit Columns (Hover + Click to Pin) */}
        {visibleData.map((_, idx) => {
          const colW = plotW / Math.max(1, visibleData.length);
          return (
            <rect
              key={idx}
              x={xOf(idx) - colW / 2}
              y={padT}
              width={colW}
              height={plotH}
              fill="transparent"
              onMouseEnter={() => setHoverIdx(idx)}
              onClick={() => setPinnedIdx((p) => (p === idx ? null : idx))}
            />
          );
        })}
      </svg>

      {hovered && activeIdx !== null && (
        <div
          className="cnx-chart-tooltip cnx-tooltip-glide pointer-events-none absolute top-14 z-30 rounded-xl border border-[#25E2CC]/45 bg-[#001421]/95 px-3.5 py-2.5 text-xs text-white shadow-xl backdrop-blur-md"
          style={{
            left: `${Math.min(72, Math.max(4, (activeIdx / Math.max(1, visibleData.length - 1)) * 100))}%`,
          }}
        >
          <div className="font-mono font-bold text-[#0B2234] dark:text-white mb-1 flex items-center justify-between gap-4">
            <span>{hovered.label}</span>
            <span className="px-1.5 py-0.5 rounded bg-[#0073A8]/15 text-[#0F766E] dark:bg-[#00A3E0]/25 dark:text-[#25E2CC] text-[10px] font-semibold">
              {hovered.futurePred !== undefined
                ? 'Future Forecast'
                : hovered.holdoutPred !== undefined
                  ? 'Holdout Backtest'
                  : 'Historical Train'}
            </span>
          </div>
          <div className="space-y-0.5 font-mono text-[11px]">
            {hovered.actual !== undefined && (
              <div className="flex justify-between gap-4 text-[#0073A8] dark:text-[#00A3E0]">
                <span>Actual Volume:</span>
                <span className="font-bold">{hovered.actual.toLocaleString()}</span>
              </div>
            )}
            {hovered.trainFit !== undefined && (
              <div className="flex justify-between gap-4 text-slate-600 dark:text-slate-300">
                <span>Model Fit (Train):</span>
                <span className="font-bold">{hovered.trainFit.toLocaleString()}</span>
              </div>
            )}
            {hovered.holdoutPred !== undefined && (
              <div className="flex justify-between gap-4 text-[#0D826E] dark:text-[#00C389]">
                <span>Holdout Forecast:</span>
                <span className="font-bold">{hovered.holdoutPred.toLocaleString()}</span>
              </div>
            )}
            {hovered.futurePred !== undefined && (
              <div className="flex justify-between gap-4 text-[#0F766E] dark:text-[#25E2CC]">
                <span>Projected Volume:</span>
                <span className="font-bold">{hovered.futurePred.toLocaleString()}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export interface ArrivalIntervalItem {
  time: string;
  arrivalPct: number;
  calls: number;
}

export const InteractiveArrivalBarChart: React.FC<{
  intervals: ArrivalIntervalItem[];
  peakSlot: ArrivalIntervalItem;
}> = ({ intervals, peakSlot }) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<'bars' | 'wave'>('bars');
  const maxPct = Math.max(1, ...intervals.map((d) => d.arrivalPct));
  const activeSlot = hoverIdx !== null && intervals[hoverIdx] ? intervals[hoverIdx] : peakSlot;

  const w = 960;
  const h = 180;
  const padX = 28;
  const padY = 18;
  const plotW = w - padX * 2;
  const plotH = h - padY * 2;

  const waveCoords = intervals.map((s, idx) => ({
    x: padX + (idx / Math.max(1, intervals.length - 1)) * plotW,
    y: padY + plotH - (s.arrivalPct / maxPct) * plotH,
  }));

  return (
    <div className="cnx-chart-surface rounded-2xl border p-4 shadow-inner">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs mb-3">
        <div className="flex items-center gap-2">
          <span className="font-bold text-slate-800 dark:text-slate-200">
            Intraday Arrival Pattern (%) Curve ({intervals.length} intervals)
          </span>
          <div className="inline-flex rounded-lg border border-slate-300 bg-white dark:border-[#00A3E0]/30 dark:bg-[#001421] p-0.5 text-[10px]">
            <button
              type="button"
              onClick={() => setViewMode('bars')}
              className={`px-2 py-0.5 rounded font-bold transition cursor-pointer ${
                viewMode === 'bars' ? 'cnx-btn-active' : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              3D Bars
            </button>
            <button
              type="button"
              onClick={() => setViewMode('wave')}
              className={`px-2 py-0.5 rounded font-bold transition cursor-pointer ${
                viewMode === 'wave' ? 'cnx-btn-active' : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              Spline Wave
            </button>
          </div>
        </div>
        <span className="px-3 py-1 rounded-lg bg-[#0D9488]/10 border border-[#0D9488]/35 font-mono font-bold text-[#0F766E] dark:bg-[#00A3E0]/15 dark:border-[#25E2CC]/40 dark:text-[#25E2CC]">
          {hoverIdx !== null ? `Slot ${activeSlot.time}` : `Peak @ ${peakSlot.time}`} —{' '}
          {activeSlot.arrivalPct}% · {activeSlot.calls.toLocaleString()} calls
        </span>
      </div>

      {viewMode === 'bars' ? (
        <div
          className="h-44 flex items-end gap-1 pt-3 px-1"
          onMouseLeave={() => setHoverIdx(null)}
        >
          {intervals.map((slot, idx) => {
            const hPct = Math.max(6, (slot.arrivalPct / maxPct) * 100);
            const isPeak = slot.time === peakSlot.time;
            const isHovered = idx === hoverIdx;
            const waveStyle = getBarWaveStyle(idx, hoverIdx, 0.88);
            const delayMs = Math.round((idx / Math.max(1, intervals.length - 1)) * 280);
            return (
              <div
                key={slot.time}
                onMouseEnter={() => setHoverIdx(idx)}
                className={`relative flex-1 h-full flex flex-col justify-end items-center cursor-pointer group ${
                  isHovered ? 'z-10' : 'z-0'
                }`}
              >
                <div
                  style={{
                    height: `${hPct}%`,
                    animationDelay: `${delayMs}ms`,
                  }}
                  className="w-full flex items-end cnx-html-bar-slot cnx-bar-enter"
                >
                  <div
                    style={{
                      ...waveStyle,
                      background: isHovered
                        ? 'linear-gradient(180deg, var(--cnx-bar-hover-top) 0%, var(--cnx-bar-hover-bot) 100%)'
                        : isPeak
                          ? 'linear-gradient(180deg, var(--cnx-bar-peak-top) 0%, var(--cnx-bar-peak-bot) 100%)'
                          : 'linear-gradient(180deg, var(--cnx-bar-norm-top) 0%, var(--cnx-bar-norm-bot) 100%)',
                    }}
                    className={`w-full h-full rounded-t-md cnx-html-bar ${
                      isHovered || isPeak ? 'shadow-md shadow-[#0D9488]/30 dark:shadow-[#25E2CC]/40' : ''
                    }`}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <svg
          viewBox={`0 0 ${w} ${h}`}
          className="w-full h-44 overflow-visible cursor-crosshair"
          onMouseLeave={() => setHoverIdx(null)}
        >
          <defs>
            <linearGradient id="cnxArrivalWaveGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--cnx-chart-future)" stopOpacity="0.38" />
              <stop offset="100%" stopColor="var(--cnx-chart-actual)" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {waveCoords.length > 1 && (
            <>
              <path
                d={`${toSmoothSpline(waveCoords)} L${waveCoords[waveCoords.length - 1].x},${padY + plotH} L${waveCoords[0].x},${padY + plotH} Z`}
                fill="url(#cnxArrivalWaveGrad)"
              />
              <path
                d={toSmoothSpline(waveCoords)}
                fill="none"
                stroke="var(--cnx-chart-future)"
                strokeWidth={3}
              />
            </>
          )}
          {intervals.map((_, idx) => {
            const colW = plotW / Math.max(1, intervals.length);
            return (
              <rect
                key={idx}
                x={padX + idx * colW}
                y={padY}
                width={colW}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setHoverIdx(idx)}
              />
            );
          })}
        </svg>
      )}

      <div className="flex justify-between text-[10px] font-mono text-slate-600 dark:text-slate-400 mt-1.5">
        <span>00:00</span>
        <span>06:00</span>
        <span>12:00</span>
        <span>18:00</span>
        <span>23:30</span>
      </div>
    </div>
  );
};

export const InteractiveStaffingChart: React.FC<{
  rows: IntervalStaffingRow[];
  agentMode?: ErlangAgentMode;
}> = ({ rows, agentMode = 'integer' }) => {
  const [containerRef, w] = useContainerWidth(1480);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [layers, setLayers] = useState({
    seats: true,
    traffic: true,
    sla: true,
    occupancy: true,
  });

  if (rows.length === 0) return null;

  const h = 255;
  const padX = 42;
  const padY = 22;
  const count = Math.max(1, rows.length);
  const maxSeats = Math.max(1, ...rows.map((r) => r.requiredSeats));
  const yMaxSeats = Math.max(5, Math.ceil(maxSeats * 1.15));
  const plotW = Math.max(200, w - padX * 2);
  const plotH = h - padY * 2;
  const slotW = plotW / count;
  const ySeat = (v: number) => h - padY - (v / yMaxSeats) * plotH;
  const yOcc = (pct: number) => h - padY - (Math.min(100, Math.max(0, pct)) / 100) * plotH;

  const occCoords = rows.map((r, idx) => ({
    x: padX + (idx + 0.5) * slotW,
    y: yOcc(r.occupancyPct),
  }));
  const slaCoords = rows.map((r, idx) => ({
    x: padX + (idx + 0.5) * slotW,
    y: yOcc(r.slPct),
  }));

  const hovered = hoverIdx !== null && rows[hoverIdx] ? rows[hoverIdx] : null;

  return (
    <div
      ref={containerRef}
      className="cnx-chart-surface relative w-full select-none rounded-2xl border p-4 shadow-inner"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs mb-3 pb-2 border-b border-slate-200 dark:border-[#00A3E0]/15">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setLayers((l) => ({ ...l, seats: !l.seats }))}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-bold border transition cursor-pointer ${
              layers.seats
                ? 'border-[#0073A8]/35 bg-[#0073A8]/10 text-[#0073A8] dark:border-[#00A3E0]/50 dark:bg-[#00A3E0]/15 dark:text-[#00A3E0]'
                : 'border-slate-300 dark:border-slate-700 opacity-50 text-slate-500 dark:text-slate-400'
            }`}
          >
            <span className="w-2.5 h-2.5 rounded-xs bg-[#0073A8] dark:bg-[#00A3E0] inline-block" />
            {agentMode === 'fractional'
              ? 'Required Seats (=FractionalAgents)'
              : 'Required Seats (=Agents)'}
          </button>

          <button
            type="button"
            onClick={() => setLayers((l) => ({ ...l, traffic: !l.traffic }))}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-bold border transition cursor-pointer ${
              layers.traffic
                ? 'border-[#0D826E]/35 bg-[#0D826E]/10 text-[#0D826E] dark:border-[#00C389]/50 dark:bg-[#00C389]/15 dark:text-[#00C389]'
                : 'border-slate-300 dark:border-slate-700 opacity-50 text-slate-500 dark:text-slate-400'
            }`}
          >
            <span className="w-2.5 h-2.5 rounded-xs bg-[#0D826E] dark:bg-[#00C389] inline-block" />
            Offered Traffic (Erlangs A)
          </button>

          <button
            type="button"
            onClick={() => setLayers((l) => ({ ...l, sla: !l.sla }))}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-bold border transition cursor-pointer ${
              layers.sla
                ? 'border-[#0D9488]/40 bg-[#0D9488]/10 text-[#0F766E] dark:border-[#25E2CC]/50 dark:bg-[#25E2CC]/15 dark:text-[#25E2CC]'
                : 'border-slate-300 dark:border-slate-700 opacity-50 text-slate-500 dark:text-slate-400'
            }`}
          >
            <span className="w-3 h-0.5 border-t-2 border-dashed border-[#0D9488] dark:border-[#25E2CC] inline-block" />
            Expected SLA %
          </button>

          <button
            type="button"
            onClick={() => setLayers((l) => ({ ...l, occupancy: !l.occupancy }))}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-bold border transition cursor-pointer ${
              layers.occupancy
                ? 'border-[#005A8D]/35 bg-[#005A8D]/10 text-[#005A8D] dark:border-[#7CC4E4]/50 dark:bg-[#003D5B]/40 dark:text-[#7CC4E4]'
                : 'border-slate-300 dark:border-slate-700 opacity-50 text-slate-500 dark:text-slate-400'
            }`}
          >
            <span className="w-3 h-0.5 bg-[#005A8D] dark:bg-[#7CC4E4] inline-block" />
            Occupancy %
          </button>
        </div>
        <span className="text-[11px] text-slate-600 dark:text-slate-400">
          Click any legend pill to toggle layer · Hover any interval for telemetry
        </span>
      </div>

      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full h-56 overflow-visible cursor-crosshair"
        onMouseLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient id="cnxSeatBarGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--cnx-seat-top)" />
            <stop offset="100%" stopColor="var(--cnx-seat-bot)" />
          </linearGradient>
          <linearGradient id="cnxErlangBarGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--cnx-erlang-top)" />
            <stop offset="100%" stopColor="var(--cnx-erlang-bot)" />
          </linearGradient>
        </defs>

        {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
          const y = padY + frac * plotH;
          const seatLbl = Math.round(yMaxSeats * (1 - frac));
          const occLbl = Math.round(100 * (1 - frac));
          return (
            <g key={frac}>
              <line
                x1={padX}
                y1={y}
                x2={w - padX}
                y2={y}
                stroke="var(--cnx-chart-grid)"
                strokeDasharray="3 3"
              />
              <text
                x={padX - 6}
                y={y + 4}
                textAnchor="end"
                fill="var(--cnx-chart-axis)"
                className="text-[10px] font-mono"
              >
                {seatLbl}
              </text>
              <text
                x={w - padX + 6}
                y={y + 4}
                textAnchor="start"
                fill="var(--cnx-chart-future-text)"
                className="text-[10px] font-mono font-semibold"
              >
                {occLbl}%
              </text>
            </g>
          );
        })}

        {rows.map((r, idx) => {
          const xCenter = padX + (idx + 0.5) * slotW;
          const barW = Math.max(3, slotW * 0.72);
          const hSeats = Math.max(0, (r.requiredSeats / yMaxSeats) * plotH);
          const hErlangs = Math.max(0, (r.erlangs / yMaxSeats) * plotH);
          const delayMs = Math.round((idx / Math.max(1, rows.length - 1)) * 280);
          const seatWave = getBarWaveStyle(idx, hoverIdx, 0.9);
          const erlangWave = getBarWaveStyle(idx, hoverIdx, 0.95, 0.85);
          return (
            <g
              key={r.index}
              className="cnx-svg-bar-enter"
              style={{ animationDelay: `${delayMs}ms` }}
            >
              {layers.seats && (
                <rect
                  x={xCenter - barW / 2}
                  y={ySeat(r.requiredSeats)}
                  width={barW}
                  height={hSeats}
                  rx={2.5}
                  fill="url(#cnxSeatBarGrad)"
                  className="cnx-svg-bar"
                  style={seatWave}
                />
              )}
              {layers.traffic && (
                <rect
                  x={xCenter - barW * 0.28}
                  y={ySeat(r.erlangs)}
                  width={barW * 0.56}
                  height={hErlangs}
                  rx={1.5}
                  fill="url(#cnxErlangBarGrad)"
                  className="cnx-svg-bar"
                  style={erlangWave}
                />
              )}
            </g>
          );
        })}

        {layers.occupancy && (
          <path d={toSmoothSpline(occCoords)} fill="none" stroke="var(--cnx-chart-occ)" strokeWidth={2.3} />
        )}
        {layers.sla && (
          <path
            d={toSmoothSpline(slaCoords)}
            fill="none"
            stroke="var(--cnx-chart-future)"
            strokeWidth={2.3}
            strokeDasharray="4 3"
          />
        )}

        {hovered && hoverIdx !== null && (
          <line
            x1={padX + (hoverIdx + 0.5) * slotW}
            y1={padY}
            x2={padX + (hoverIdx + 0.5) * slotW}
            y2={padY + plotH}
            stroke="var(--cnx-chart-future)"
            strokeWidth={1.6}
            strokeDasharray="3 3"
          />
        )}

        {rows.map((_, idx) => (
          <rect
            key={idx}
            x={padX + idx * slotW}
            y={padY}
            width={slotW}
            height={plotH}
            fill="transparent"
            onMouseEnter={() => setHoverIdx(idx)}
          />
        ))}
      </svg>

      {hovered && hoverIdx !== null && (
        <div
          className="cnx-chart-tooltip cnx-tooltip-glide pointer-events-none absolute top-12 z-30 rounded-xl border border-[#25E2CC]/45 bg-[#001421]/95 px-3.5 py-2.5 text-xs text-white shadow-xl backdrop-blur-md"
          style={{
            left: `${Math.min(74, Math.max(5, (hoverIdx / Math.max(1, rows.length - 1)) * 100))}%`,
          }}
        >
          <div className="font-mono font-bold text-[#0F766E] dark:text-[#25E2CC] mb-1">
            Interval {hovered.timeLabel}
          </div>
          <div className="space-y-0.5 font-mono text-[11px]">
            <div className="flex justify-between gap-4 text-slate-700 dark:text-slate-200">
              <span>Calls Offered:</span>
              <span className="font-bold">{hovered.volume.toLocaleString()}</span>
            </div>
            <div className="flex justify-between gap-4 text-[#0D826E] dark:text-[#00C389]">
              <span>Traffic (Erlangs A):</span>
              <span className="font-bold">{hovered.erlangs.toFixed(2)} E</span>
            </div>
            <div className="flex justify-between gap-4 text-[#0073A8] dark:text-[#00A3E0]">
              <span>Integer / Fractional:</span>
              <span className="font-bold">
                {hovered.integerSeats} / {hovered.fractionalSeats.toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between gap-4 text-[#0F766E] dark:text-[#25E2CC]">
              <span>Expected SLA / ASA:</span>
              <span className="font-bold">
                {hovered.slPct.toFixed(1)}% ({hovered.asaSec.toFixed(1)}s)
              </span>
            </div>
            <div className="flex justify-between gap-4 text-[#005A8D] dark:text-[#7CC4E4]">
              <span>Occupancy:</span>
              <span className="font-bold">{hovered.occupancyPct.toFixed(1)}%</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
