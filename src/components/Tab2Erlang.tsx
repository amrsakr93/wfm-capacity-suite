import React, { useRef, useState } from 'react';
import {
  Clock,
  Activity,
  ArrowRight,
  RotateCcw,
  Upload,
  Grid,
  Table as TableIcon,
  CheckCircle2,
} from 'lucide-react';
import type {
  DayKey,
  ErlangConfig,
  ErlangSummary,
  IntervalGranularityMin,
  IntervalRowInput,
  ParsedDataset,
} from '../engine/types.ts';
import { parseFileDataset } from '../engine/parsers.ts';
import { solveRequiredAgents } from '../engine/erlang.ts';
import { buildIntervalInputsForGranularity } from '../engine/samples.ts';

const DAY_KEYS: DayKey[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

interface Props {
  config: ErlangConfig;
  setConfig: React.Dispatch<React.SetStateAction<ErlangConfig>>;
  intervals: IntervalRowInput[];
  setIntervals: React.Dispatch<React.SetStateAction<IntervalRowInput[]>>;
  dayCurves: Record<DayKey, number[]>;
  dowShares: Record<DayKey, number>;
  summary: ErlangSummary;
  onGranularityChange: (g: IntervalGranularityMin) => void;
  onSelectDay: (d: DayKey) => void;
  onDatasetImported: (dataset: ParsedDataset) => void;
  onResetCurveToDefault: () => void;
  onPushToCapacity: () => void;
}

export const Tab2Erlang: React.FC<Props> = ({
  config,
  setConfig,
  intervals,
  setIntervals,
  dayCurves,
  dowShares,
  summary,
  onGranularityChange,
  onSelectDay,
  onDatasetImported,
  onResetCurveToDefault,
  onPushToCapacity,
}) => {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [viewMode, setViewMode] = useState<'table' | 'heatmap'>('table');
  const [heatmapMetric, setHeatmapMetric] = useState<'volume' | 'seats'>('volume');
  const [uploadNote, setUploadNote] = useState<string | null>(null);

  const handleIntervalFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = await parseFileDataset(file);
      onDatasetImported(parsed);
      setUploadNote(`Extracted curves from ${file.name}: ${parsed.summaryNote}`);
    } catch (err) {
      setUploadNote(err instanceof Error ? err.message : 'Failed to parse interval file.');
    } finally {
      e.target.value = '';
    }
  };

  const updateRowArrival = (idx: number, val: number) => {
    setIntervals((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, arrivalPct: Math.max(0, val) } : r))
    );
  };

  const updateRowAht = (idx: number, raw: string) => {
    const trimmed = raw.trim();
    const num = trimmed === '' ? null : Math.max(10, Number(trimmed) || config.globalAhtSec);
    setIntervals((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, ahtOverrideSec: num } : r))
    );
  };

  const clearAllAhtOverrides = () => {
    setIntervals((prev) => prev.map((r) => ({ ...r, ahtOverrideSec: null })));
  };

  return (
    <div className="space-y-6">
      {/* Top 6 KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3.5">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5">
          <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
            Daily Offered Volume
          </div>
          <div className="mt-1 text-xl font-bold tabular-nums text-slate-900 dark:text-white">
            {summary.totalVolume.toLocaleString()}
          </div>
          <div className="mt-0.5 text-[11px] text-slate-400">
            Day Curve: {config.selectedDay} ({config.granularityMin}m)
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5">
          <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
            Pure Talk Workload
          </div>
          <div className="mt-1 text-xl font-bold tabular-nums text-slate-900 dark:text-white">
            {summary.totalPureTalkHours.toFixed(1)} <span className="text-xs font-normal">hrs</span>
          </div>
          <div className="mt-0.5 text-[11px] text-slate-400">
            Σ (Volume × AHT) ÷ 3,600
          </div>
        </div>

        <div className="rounded-xl border border-sky-500/40 bg-sky-500/10 dark:bg-sky-950/30 p-3.5">
          <div className="text-[11px] font-semibold text-sky-700 dark:text-sky-300">
            Required Productive Hours
          </div>
          <div className="mt-1 text-xl font-bold tabular-nums text-sky-700 dark:text-sky-200">
            {summary.totalProductiveHours.toFixed(1)} <span className="text-xs font-normal">hrs</span>
          </div>
          <div className="mt-0.5 text-[11px] text-sky-600/80 dark:text-sky-300/80">
            Σ (N_i × {config.granularityMin} / 60) → Tab 3
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5">
          <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
            Peak Interval Seats
          </div>
          <div className="mt-1 text-xl font-bold tabular-nums text-slate-900 dark:text-white">
            {summary.peakSeats} <span className="text-xs font-normal">seats</span>
          </div>
          <div className="mt-0.5 text-[11px] text-slate-400">
            Peak @ {summary.peakTimeLabel}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5">
          <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
            Weighted Expected SLA / ASA
          </div>
          <div className="mt-1 text-xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
            {summary.weightedSlPct.toFixed(1)}%{' '}
            <span className="text-xs font-normal text-slate-500">
              ({summary.weightedAsaSec.toFixed(1)}s)
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-slate-400">
            Target: {config.slTargetPct}% / {config.slThresholdSec}s
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5">
          <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
            Avg Occupancy {config.useErlangA ? '& Abandon' : 'Cap'}
          </div>
          <div className="mt-1 text-xl font-bold tabular-nums text-slate-900 dark:text-white">
            {summary.avgOccupancyPct.toFixed(1)}%
            {summary.weightedAbandonPct != null && (
              <span className="text-xs font-normal text-amber-500 ml-1.5">
                · {summary.weightedAbandonPct.toFixed(1)}% abn
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[11px] text-slate-400">
            Max Cap: {config.maxOccupancyPct}%
          </div>
        </div>
      </div>

      {/* Erlang Parameters & Guardrails Panel */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 dark:border-slate-800 pb-3.5">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <Clock className="w-4 h-4 text-sky-500" />
              Interval &amp; Erlang C / A Staffing Guardrails
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Selects smallest integer N &gt; A satisfying SL ≥ Target, ASA ≤ Max ASA, and Occupancy ≤ Max Cap simultaneously.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.tsv,.txt,.xlsx,.xls"
              onChange={handleIntervalFile}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 px-3 py-1.5 text-xs font-medium cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5 text-sky-500" />
              Extract Curves from File
            </button>
            <button
              type="button"
              onClick={onResetCurveToDefault}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset Arrival Curve
            </button>
            <button
              type="button"
              onClick={onPushToCapacity}
              className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white px-3.5 py-1.5 text-xs font-semibold cursor-pointer"
            >
              Send {summary.totalProductiveHours.toFixed(1)} Prod Hrs to Tab 3
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {uploadNote && (
          <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300 flex items-center justify-between">
            <span className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" />
              {uploadNote}
            </span>
            <button
              type="button"
              onClick={() => setUploadNote(null)}
              className="text-[11px] underline cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
          <div>
            <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
              Daily Volume
            </label>
            <input
              type="number"
              min={0}
              value={config.dailyVolume}
              onChange={(e) =>
                setConfig((c) => ({ ...c, dailyVolume: Math.max(0, Number(e.target.value) || 0) }))
              }
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2.5 py-1.5 text-xs font-semibold tabular-nums"
            />
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
              Interval Length
            </label>
            <select
              value={config.granularityMin}
              onChange={(e) => onGranularityChange(Number(e.target.value) as IntervalGranularityMin)}
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2.5 py-1.5 text-xs font-medium"
            >
              <option value={60}>60 min (3,600s)</option>
              <option value={30}>30 min (1,800s)</option>
              <option value={15}>15 min (900s)</option>
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
              Day Arrival Curve
            </label>
            <select
              value={config.selectedDay}
              onChange={(e) => onSelectDay(e.target.value as DayKey)}
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2.5 py-1.5 text-xs font-medium"
            >
              {DAY_KEYS.map((d) => (
                <option key={d} value={d}>
                  {d} Profile
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
              Global AHT (sec)
            </label>
            <input
              type="number"
              min={10}
              max={7200}
              value={config.globalAhtSec}
              onChange={(e) =>
                setConfig((c) => ({ ...c, globalAhtSec: Math.max(10, Number(e.target.value) || 300) }))
              }
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2.5 py-1.5 text-xs tabular-nums"
            />
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
              SLA Target (%)
            </label>
            <input
              type="number"
              min={10}
              max={99.9}
              value={config.slTargetPct}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  slTargetPct: Math.max(1, Math.min(99.9, Number(e.target.value) || 80)),
                }))
              }
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2.5 py-1.5 text-xs tabular-nums"
            />
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
              SL Threshold (sec)
            </label>
            <input
              type="number"
              min={1}
              max={600}
              value={config.slThresholdSec}
              onChange={(e) =>
                setConfig((c) => ({ ...c, slThresholdSec: Math.max(1, Number(e.target.value) || 20) }))
              }
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2.5 py-1.5 text-xs tabular-nums"
            />
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
              Max ASA Cap (sec)
            </label>
            <input
              type="number"
              min={1}
              max={1800}
              value={config.maxAsaSec}
              onChange={(e) =>
                setConfig((c) => ({ ...c, maxAsaSec: Math.max(1, Number(e.target.value) || 30) }))
              }
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2.5 py-1.5 text-xs tabular-nums"
            />
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
              Max Occupancy (%)
            </label>
            <input
              type="number"
              min={50}
              max={99}
              value={config.maxOccupancyPct}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  maxOccupancyPct: Math.max(50, Math.min(99, Number(e.target.value) || 85)),
                }))
              }
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2.5 py-1.5 text-xs tabular-nums"
            />
          </div>
        </div>

        {/* Second row: Operating Hours + Min Floor + Erlang A */}
        <div className="pt-2 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={config.operating24x7}
                onChange={(e) => setConfig((c) => ({ ...c, operating24x7: e.target.checked }))}
                className="accent-sky-600 rounded"
              />
              24/7 Operating Hours
            </label>

            {!config.operating24x7 && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-slate-500">From:</span>
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={config.startHour}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      startHour: Math.max(0, Math.min(23, Number(e.target.value) || 0)),
                    }))
                  }
                  className="w-14 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2 py-1 tabular-nums"
                />
                <span className="text-slate-500">To:</span>
                <input
                  type="number"
                  min={1}
                  max={24}
                  value={config.endHour}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      endHour: Math.max(1, Math.min(24, Number(e.target.value) || 24)),
                    }))
                  }
                  className="w-14 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2 py-1 tabular-nums"
                />
              </div>
            )}

            <div className="flex items-center gap-2 text-xs pl-2 border-l border-slate-200 dark:border-slate-800">
              <span className="text-slate-500">Min Seats Floor:</span>
              <input
                type="number"
                min={0}
                max={50}
                value={config.minAgentsFloor}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    minAgentsFloor: Math.max(0, Number(e.target.value) || 0),
                  }))
                }
                className="w-14 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2 py-1 tabular-nums"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex items-center gap-2 text-xs font-medium text-amber-700 dark:text-amber-300 cursor-pointer">
              <input
                type="checkbox"
                checked={config.useErlangA}
                onChange={(e) => setConfig((c) => ({ ...c, useErlangA: e.target.checked }))}
                className="accent-amber-500 rounded"
              />
              Enable Erlang A (Caller Abandonment / Patience)
            </label>

            {config.useErlangA && (
              <div className="flex items-center gap-1.5 text-xs">
                <span className="text-slate-500">Avg Patience (s):</span>
                <input
                  type="number"
                  min={15}
                  max={1800}
                  value={config.avgPatienceSec}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      avgPatienceSec: Math.max(15, Number(e.target.value) || 90),
                    }))
                  }
                  className="w-16 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 tabular-nums font-medium"
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Interactive Erlangs vs Seats vs Occupancy SVG Chart */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <Activity className="w-4 h-4 text-sky-500" />
              Intraday Staffing Curve: Required Seats (N) vs Offered Traffic (Erlangs) &amp; Occupancy %
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Identifies peak hours and optimal windows for breaks, coaching, and team huddles.
            </p>
          </div>
          <div className="flex items-center gap-4 text-xs">
            <span className="flex items-center gap-1.5 text-sky-600 dark:text-sky-400">
              <span className="w-3 h-2.5 rounded-xs bg-sky-500/70 inline-block" />
              Required Seats (N)
            </span>
            <span className="flex items-center gap-1.5 text-indigo-600 dark:text-indigo-400">
              <span className="w-3 h-2.5 rounded-xs bg-indigo-500/85 inline-block" />
              Offered Traffic (Erlangs A)
            </span>
            <span className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
              <span className="w-3 h-0.5 bg-amber-500 inline-block" />
              Occupancy % (Cap {config.maxOccupancyPct}%)
            </span>
          </div>
        </div>

        <ErlangSvgChart rows={summary.rows} maxOccCap={config.maxOccupancyPct} />
      </div>

      {/* View Switcher: Interval Table vs 7-Day Intraday Heatmap */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setViewMode('table')}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition cursor-pointer ${
                viewMode === 'table'
                  ? 'bg-sky-600 text-white'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
              }`}
            >
              <TableIcon className="w-3.5 h-3.5" />
              Interval Staffing Schedule ({summary.rows.length} slots)
            </button>
            <button
              type="button"
              onClick={() => setViewMode('heatmap')}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition cursor-pointer ${
                viewMode === 'heatmap'
                  ? 'bg-sky-600 text-white'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
              }`}
            >
              <Grid className="w-3.5 h-3.5" />
              7-Day Intraday Matrix (Mon–Sun Heatmap)
            </button>
          </div>

          {viewMode === 'table' ? (
            <button
              type="button"
              onClick={clearAllAhtOverrides}
              className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 underline cursor-pointer"
            >
              Clear Per-Interval AHT Overrides
            </button>
          ) : (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-slate-500">Heatmap Metric:</span>
              <button
                type="button"
                onClick={() => setHeatmapMetric('volume')}
                className={`px-2.5 py-1 rounded font-medium cursor-pointer ${
                  heatmapMetric === 'volume'
                    ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border border-sky-500/30'
                    : 'text-slate-500'
                }`}
              >
                Interval Calls
              </button>
              <button
                type="button"
                onClick={() => setHeatmapMetric('seats')}
                className={`px-2.5 py-1 rounded font-medium cursor-pointer ${
                  heatmapMetric === 'seats'
                    ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border border-sky-500/30'
                    : 'text-slate-500'
                }`}
              >
                Required Seats (N)
              </button>
            </div>
          )}
        </div>

        {viewMode === 'table' ? (
          <div className="max-h-[480px] overflow-auto border border-slate-100 dark:border-slate-800 rounded-lg">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800/95 text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="py-2.5 px-3 font-medium">Interval</th>
                  <th className="py-2.5 px-3 font-medium text-right">Arrival %</th>
                  <th className="py-2.5 px-3 font-medium text-right">Volume</th>
                  <th className="py-2.5 px-3 font-medium text-right">AHT (s)</th>
                  <th className="py-2.5 px-3 font-medium text-right">Erlangs (A)</th>
                  <th className="py-2.5 px-3 font-medium text-right">Req Seats (N)</th>
                  <th className="py-2.5 px-3 font-medium text-right">Prod Hrs</th>
                  <th className="py-2.5 px-3 font-medium text-right">Occupancy %</th>
                  <th className="py-2.5 px-3 font-medium text-right">ASA (s)</th>
                  <th className="py-2.5 px-3 font-medium text-right">SLA %</th>
                  {config.useErlangA && (
                    <th className="py-2.5 px-3 font-medium text-right">Abandon %</th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                {summary.rows.map((row, idx) => {
                  const rawInput = intervals[idx];
                  const isPeak = row.requiredSeats === summary.peakSeats && summary.peakSeats > 0;
                  return (
                    <tr
                      key={row.index}
                      className={
                        !row.isOpen
                          ? 'opacity-45 bg-slate-50/40 dark:bg-slate-950/40'
                          : isPeak
                            ? 'bg-sky-500/10 dark:bg-sky-500/15'
                            : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                      }
                    >
                      <td className="py-1.5 px-3 font-mono font-medium flex items-center gap-2">
                        {row.timeLabel}
                        {!row.isOpen && (
                          <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-200 dark:bg-slate-800 text-slate-500">
                            CLOSED
                          </span>
                        )}
                        {isPeak && (
                          <span className="text-[10px] px-1.5 py-0.2 rounded bg-sky-500/20 text-sky-600 dark:text-sky-300 font-semibold">
                            PEAK
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 px-3 text-right">
                        <input
                          type="number"
                          step={0.1}
                          min={0}
                          max={100}
                          value={rawInput?.arrivalPct ?? row.arrivalPct}
                          onChange={(e) => updateRowArrival(idx, Number(e.target.value) || 0)}
                          className="w-16 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 py-0.5 text-right tabular-nums"
                        />
                      </td>
                      <td className="py-1.5 px-3 text-right tabular-nums font-medium">
                        {row.volume.toLocaleString()}
                      </td>
                      <td className="py-1.5 px-3 text-right">
                        <input
                          type="number"
                          min={10}
                          placeholder={String(config.globalAhtSec)}
                          value={rawInput?.ahtOverrideSec ?? ''}
                          onChange={(e) => updateRowAht(idx, e.target.value)}
                          className={`w-16 rounded border px-1.5 py-0.5 text-right tabular-nums ${
                            rawInput?.ahtOverrideSec != null
                              ? 'border-amber-500 bg-amber-500/10 text-amber-700 dark:text-amber-300 font-semibold'
                              : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400'
                          }`}
                        />
                      </td>
                      <td className="py-1.5 px-3 text-right tabular-nums text-slate-600 dark:text-slate-300">
                        {row.erlangs.toFixed(2)}
                      </td>
                      <td className="py-1.5 px-3 text-right tabular-nums font-bold text-sky-600 dark:text-sky-400">
                        {row.requiredSeats}
                      </td>
                      <td className="py-1.5 px-3 text-right tabular-nums font-medium">
                        {row.productiveHours.toFixed(2)}
                      </td>
                      <td className="py-1.5 px-3 text-right tabular-nums">
                        <span
                          className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${
                            row.occupancyPct > config.maxOccupancyPct - 2
                              ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                              : 'text-slate-700 dark:text-slate-300'
                          }`}
                        >
                          {row.occupancyPct.toFixed(1)}%
                        </span>
                      </td>
                      <td className="py-1.5 px-3 text-right tabular-nums">
                        {row.asaSec.toFixed(1)}s
                      </td>
                      <td className="py-1.5 px-3 text-right tabular-nums font-medium text-emerald-600 dark:text-emerald-400">
                        {row.slPct.toFixed(1)}%
                      </td>
                      {config.useErlangA && (
                        <td className="py-1.5 px-3 text-right tabular-nums text-amber-600 dark:text-amber-400">
                          {(row.abandonPct ?? 0).toFixed(2)}%
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <SevenDayHeatmapMatrix
            config={config}
            dayCurves={dayCurves}
            dowShares={dowShares}
            metric={heatmapMetric}
          />
        )}
      </div>
    </div>
  );
};

const ErlangSvgChart: React.FC<{
  rows: ErlangSummary['rows'];
  maxOccCap: number;
}> = ({ rows, maxOccCap }) => {
  if (rows.length === 0) return null;
  const width = 920;
  const height = 240;
  const padL = 46;
  const padR = 46;
  const padT = 18;
  const padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const maxSeats = Math.max(...rows.map((r) => Math.max(r.requiredSeats, r.erlangs)), 5) * 1.12;
  const slotW = plotW / rows.length;

  const yLeft = (val: number) => padT + plotH - (val / maxSeats) * plotH;
  const yRightOcc = (occ: number) => padT + plotH - (Math.min(100, Math.max(0, occ)) / 100) * plotH;

  const occPath = rows
    .map((r, i) => {
      const cx = padL + (i + 0.5) * slotW;
      const cy = yRightOcc(r.occupancyPct);
      return `${i === 0 ? 'M' : 'L'}${cx.toFixed(1)},${cy.toFixed(1)}`;
    })
    .join(' ');

  const capY = yRightOcc(maxOccCap);

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto select-none">
        {[0, 0.25, 0.5, 0.75, 1].map((t, i) => {
          const y = padT + plotH * (1 - t);
          return (
            <g key={i}>
              <line
                x1={padL}
                y1={y}
                x2={padL + plotW}
                y2={y}
                stroke="currentColor"
                className="text-slate-200 dark:text-slate-800"
                strokeDasharray="3 3"
              />
              <text x={padL - 6} y={y + 3} textAnchor="end" className="fill-slate-400 text-[10px] font-mono">
                {Math.round(t * maxSeats)}
              </text>
              <text x={padL + plotW + 6} y={y + 3} className="fill-amber-500/80 text-[10px] font-mono">
                {Math.round(t * 100)}%
              </text>
            </g>
          );
        })}

        {/* Bars: Required Seats & Offered Erlangs */}
        {rows.map((r, i) => {
          const x = padL + i * slotW;
          const bw = Math.max(2, slotW * 0.74);
          const bx = x + (slotW - bw) / 2;
          const seatY = yLeft(r.requiredSeats);
          const erlY = yLeft(r.erlangs);
          const showLabel = i % Math.max(1, Math.floor(rows.length / 12)) === 0;
          return (
            <g key={r.index}>
              <rect
                x={bx}
                y={seatY}
                width={bw}
                height={Math.max(0, padT + plotH - seatY)}
                rx={1.5}
                className="fill-sky-500/65 dark:fill-sky-400/60"
              />
              <rect
                x={bx + bw * 0.18}
                y={erlY}
                width={bw * 0.64}
                height={Math.max(0, padT + plotH - erlY)}
                rx={1}
                className="fill-indigo-600/85 dark:fill-indigo-400/85"
              />
              {showLabel && (
                <text
                  x={x + slotW / 2}
                  y={height - 8}
                  textAnchor="middle"
                  className="fill-slate-400 text-[10px] font-mono"
                >
                  {r.timeLabel}
                </text>
              )}
            </g>
          );
        })}

        {/* Max Occupancy Cap Guardrail Line */}
        <line
          x1={padL}
          y1={capY}
          x2={padL + plotW}
          y2={capY}
          stroke="#f59e0b"
          strokeDasharray="5 3"
          strokeWidth={1.3}
        />

        {/* Occupancy Line */}
        <path d={occPath} fill="none" stroke="#f59e0b" strokeWidth={2} />
      </svg>
    </div>
  );
};

const SevenDayHeatmapMatrix: React.FC<{
  config: ErlangConfig;
  dayCurves: Record<DayKey, number[]>;
  dowShares: Record<DayKey, number>;
  metric: 'volume' | 'seats';
}> = ({ config, dayCurves, dowShares, metric }) => {
  // Weekly total volume inferred from selectedDay's dailyVolume & share
  const shareSum = DAY_KEYS.reduce((s, d) => s + (dowShares[d] || 0), 0) || 100;
  const selectedDayShare = Math.max(0.01, (dowShares[config.selectedDay] || 14.28) / shareSum);
  const impliedWeeklyVol = config.dailyVolume / selectedDayShare;

  const dayDailyVols = Object.fromEntries(
    DAY_KEYS.map((d) => [d, Math.round(impliedWeeklyVol * ((dowShares[d] || 14.28) / shareSum))])
  ) as Record<DayKey, number>;

  const resampledByDay = Object.fromEntries(
    DAY_KEYS.map((d) => [
      d,
      buildIntervalInputsForGranularity(dayCurves[d] ?? dayCurves.Mon, config.granularityMin),
    ])
  ) as Record<DayKey, IntervalRowInput[]>;

  const rowCount = resampledByDay.Mon.length;
  const intervalSec = config.granularityMin * 60;

  const grid: { timeLabel: string; values: Record<DayKey, number> }[] = [];
  let maxCell = 1;
  const colTotals = Object.fromEntries(DAY_KEYS.map((d) => [d, 0])) as Record<DayKey, number>;

  for (let i = 0; i < rowCount; i++) {
    const timeLabel = resampledByDay.Mon[i].timeLabel;
    const values = {} as Record<DayKey, number>;
    for (const d of DAY_KEYS) {
      const pct = resampledByDay[d][i]?.arrivalPct ?? 0;
      const vol = Math.round((dayDailyVols[d] * pct) / 100);
      if (metric === 'volume') {
        values[d] = vol;
      } else {
        const solved = solveRequiredAgents(vol, config.globalAhtSec, intervalSec, config);
        values[d] = solved.requiredSeats;
      }
      colTotals[d] += values[d];
      if (values[d] > maxCell) maxCell = values[d];
    }
    grid.push({ timeLabel, values });
  }

  const heatColor = (val: number) => {
    const r = val / Math.max(1, maxCell);
    if (r < 0.2) return 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-200';
    if (r < 0.45) return 'bg-lime-500/20 text-lime-900 dark:text-lime-200';
    if (r < 0.7) return 'bg-amber-500/25 text-amber-900 dark:text-amber-100';
    if (r < 0.88) return 'bg-orange-500/30 text-orange-950 dark:text-orange-100 font-semibold';
    return 'bg-rose-500/35 text-rose-950 dark:text-rose-100 font-bold';
  };

  return (
    <div className="max-h-[480px] overflow-auto border border-slate-200 dark:border-slate-800 rounded-lg">
      <table className="w-full text-center border-collapse text-xs">
        <thead className="sticky top-0 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200">
          <tr>
            <th className="py-2 px-3 text-left font-semibold">Interval</th>
            {DAY_KEYS.map((d) => (
              <th key={d} className="py-2 px-3 font-semibold">
                {d}{' '}
                <span className="block text-[10px] font-normal text-slate-500">
                  {dowShares[d].toFixed(1)}%
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200/60 dark:divide-slate-800/60">
          {grid.map((row) => (
            <tr key={row.timeLabel}>
              <td className="py-1 px-3 text-left font-mono font-medium bg-slate-50 dark:bg-slate-900">
                {row.timeLabel}
              </td>
              {DAY_KEYS.map((d) => (
                <td
                  key={d}
                  className={`py-1 px-2 tabular-nums border-l border-slate-200/50 dark:border-slate-800/50 ${heatColor(
                    row.values[d]
                  )}`}
                >
                  {row.values[d].toLocaleString()}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot className="sticky bottom-0 bg-slate-900 text-white font-semibold">
          <tr>
            <td className="py-2 px-3 text-left">
              {metric === 'volume' ? 'Total Calls' : 'Total Seat-Intervals'}
            </td>
            {DAY_KEYS.map((d) => (
              <td key={d} className="py-2 px-2 tabular-nums">
                {colTotals[d].toLocaleString()}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
};
