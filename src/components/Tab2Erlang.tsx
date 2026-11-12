import React, { useMemo, useRef, useState } from 'react';
import {
  Clock,
  Upload,
  RotateCcw,
  ArrowRight,
  Activity,
  Calculator,
  Calendar,
  Sliders,
  ChevronDown,
  ChevronUp,
  Download,
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
import {
  buildMultiDayErlangSchedules,
  exportMultiDayIntervalScheduleXlsx,
} from '../engine/exporter.ts';
import { SmartNumberInput } from './SmartNumberInput.tsx';
import { InteractiveStaffingChart } from './InteractiveCharts.tsx';
import { ErlangQueueIcon, ProMaxIconBadge } from './ProMaxIcons.tsx';

export type IntervalPlanScope = 'single_day' | 'next_week' | 'custom_days' | 'all_days';

export interface HorizonDaySpec {
  dateIso: string;
  dayKey: DayKey;
  volume: number;
  sourceLabel: 'Historical' | 'Forecast';
}

interface Tab2Props {
  config: ErlangConfig;
  setConfig: React.Dispatch<React.SetStateAction<ErlangConfig>>;
  intervals: IntervalRowInput[];
  setIntervals: React.Dispatch<React.SetStateAction<IntervalRowInput[]>>;
  dayCurves: Record<DayKey, number[]>;
  byDateCurves: Record<string, number[]>;
  byDateTotals: Record<string, number>;
  dowShares: Record<DayKey, number>;
  summary: ErlangSummary;
  monthlyVolume: number;
  setMonthlyVolume: (vol: number) => void;
  monthDays: number;
  setMonthDays: (days: number) => void;
  hoops: number;
  setHoops: (h: number) => void;
  historyDays: HorizonDaySpec[];
  futureDays: HorizonDaySpec[];
  intervalScope: IntervalPlanScope;
  setIntervalScope: (s: IntervalPlanScope) => void;
  customHorizonDays: number;
  setCustomHorizonDays: (n: number) => void;
  onGranularityChange: (g: IntervalGranularityMin) => void;
  onSelectDay: (d: DayKey) => void;
  onSelectSpecificDate: (iso: string) => void;
  onDatasetImported: (dataset: ParsedDataset) => void;
  onResetCurveToDefault: () => void;
  onApplyFlatMonthlyBreakdown: (prodHoursPerDay: number, pureTalkHoursPerDay: number) => void;
  onPushToCapacity: () => void;
}

const DAY_KEYS: DayKey[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function heatBg(ratio: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  if (clamped < 0.35) return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  if (clamped < 0.7) return 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
  return 'bg-rose-500/20 text-rose-700 dark:text-rose-300 font-semibold';
}

export const Tab2Erlang: React.FC<Tab2Props> = ({
  config,
  setConfig,
  intervals,
  setIntervals,
  dayCurves,
  byDateCurves,
  byDateTotals,
  dowShares,
  summary,
  monthlyVolume,
  setMonthlyVolume,
  monthDays,
  setMonthDays,
  hoops,
  setHoops,
  historyDays,
  futureDays,
  intervalScope,
  setIntervalScope,
  customHorizonDays,
  setCustomHorizonDays,
  onGranularityChange,
  onSelectDay,
  onSelectSpecificDate,
  onDatasetImported,
  onResetCurveToDefault,
  onApplyFlatMonthlyBreakdown,
  onPushToCapacity,
}) => {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [showGuardrails, setShowGuardrails] = useState(false);
  const [multiDayFilterDate, setMultiDayFilterDate] = useState<string>('ALL');

  // Build active multi-day horizon list based on intervalScope
  const activeHorizonDays = useMemo<HorizonDaySpec[]>(() => {
    if (intervalScope === 'next_week') {
      return futureDays.slice(0, 7);
    }
    if (intervalScope === 'custom_days') {
      const n = Math.max(1, Math.min(60, customHorizonDays));
      return futureDays.slice(0, n);
    }
    if (intervalScope === 'all_days') {
      return [...historyDays, ...futureDays.slice(0, 14)];
    }
    // single_day
    return [
      {
        dateIso: config.selectedDateIso || 'Active-Day',
        dayKey: config.selectedDay,
        volume: config.dailyVolume,
        sourceLabel: config.selectedDateIso ? 'Historical' : 'Forecast',
      },
    ];
  }, [intervalScope, futureDays, historyDays, customHorizonDays, config]);

  const multiDaySchedules = useMemo(() => {
    return buildMultiDayErlangSchedules({
      days: activeHorizonDays,
      erlangConfig: config,
      dayCurves,
      byDateCurves,
    });
  }, [activeHorizonDays, config, dayCurves, byDateCurves]);

  const filteredMultiDaySchedules = useMemo(() => {
    if (multiDayFilterDate === 'ALL') return multiDaySchedules;
    const found = multiDaySchedules.filter((d) => d.dateIso === multiDayFilterDate);
    return found.length > 0 ? found : multiDaySchedules;
  }, [multiDaySchedules, multiDayFilterDate]);

  const multiDayTotals = useMemo(() => {
    const totalCalls = filteredMultiDaySchedules.reduce((s, d) => s + d.dailyVolume, 0);
    const totalProdHrs = filteredMultiDaySchedules.reduce(
      (s, d) => s + d.summary.totalProductiveHours,
      0
    );
    const avgSla =
      filteredMultiDaySchedules.length > 0
        ? filteredMultiDaySchedules.reduce((s, d) => s + d.summary.weightedSlPct, 0) /
          filteredMultiDaySchedules.length
        : 0;
    const peakSeats = filteredMultiDaySchedules.reduce(
      (m, d) => Math.max(m, d.summary.peakSeats),
      0
    );
    return {
      daysCount: filteredMultiDaySchedules.length,
      totalCalls,
      totalProdHrs,
      avgSla,
      peakSeats,
    };
  }, [filteredMultiDaySchedules]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = await parseFileDataset(file);
      onDatasetImported(parsed);
      setImportMsg(parsed.summaryNote);
    } catch (err) {
      setImportMsg(err instanceof Error ? err.message : 'Failed to parse interval file.');
    } finally {
      e.target.value = '';
    }
  };

  // Monthly-to-Daily-to-Hourly Macro Breakdown ("التقسيمة والتنفيطة للفوليوم")
  const macroBreakdown = useMemo(() => {
    const safeDays = Math.max(1, monthDays);
    const safeHoops = Math.max(1, Math.min(24, hoops));
    const dailyOffered = monthlyVolume / safeDays;
    const hourlyVolume = dailyOffered / safeHoops;
    const solved = solveRequiredAgents(hourlyVolume, config.globalAhtSec, 3600, {
      ...config,
      enforceMaxAsa: false,
      enforceOccupancyCap: false,
    });
    const reqPerHour =
      config.agentMode === 'fractional' ? solved.fractionalSeats : solved.integerSeats;
    const reqPerDayHours = reqPerHour * safeHoops;
    const pureTalkPerDayHours = ((dailyOffered * config.globalAhtSec) / 3600);
    return {
      dailyOffered,
      hourlyVolume,
      integerPerHour: solved.integerSeats,
      fractionalPerHour: solved.fractionalSeats,
      reqPerHour,
      reqPerDayHours,
      pureTalkPerDayHours,
      slAchievedPct: solved.metrics.slPct,
      asaAchievedSec: solved.metrics.asaSec,
    };
  }, [monthlyVolume, monthDays, hoops, config]);

  const maxSeats = useMemo(
    () => Math.max(1, ...summary.rows.map((r) => r.requiredSeats)),
    [summary.rows]
  );

  const maxVol = useMemo(
    () => Math.max(1, ...summary.rows.map((r) => r.volume)),
    [summary.rows]
  );

  const updateRowOverride = (idx: number, field: 'arrivalPct' | 'ahtOverrideSec', val: string) => {
    setIntervals((prev) =>
      prev.map((row, i) => {
        if (i !== idx) return row;
        if (field === 'arrivalPct') {
          return { ...row, arrivalPct: Math.max(0, Number(val) || 0) };
        }
        const num = val.trim() === '' ? null : Math.max(1, Number(val) || config.globalAhtSec);
        return { ...row, ahtOverrideSec: num };
      })
    );
  };

  return (
    <div className="space-y-6 animate-slide-up">
      {/* Top KPI Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="card-elevated rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 shadow-xs">
          <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
            Daily Offered Volume
          </div>
          <div className="mt-1 text-xl font-extrabold tabular-nums text-slate-900 dark:text-white">
            {summary.totalVolume.toLocaleString()}
          </div>
          <div className="mt-0.5 text-[11px] text-slate-400">
            {config.selectedDateIso
              ? `Date: ${config.selectedDateIso}`
              : `Day Curve: ${config.selectedDay} (${config.granularityMin}m)`}
          </div>
        </div>

        <div className="card-elevated rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 shadow-xs">
          <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
            Pure Talk Workload
          </div>
          <div className="mt-1 text-xl font-extrabold tabular-nums text-slate-900 dark:text-white">
            {summary.totalPureTalkHours.toFixed(1)}{' '}
            <span className="text-xs font-normal">hrs</span>
          </div>
          <div className="mt-0.5 text-[11px] text-slate-400">Σ (Volume × AHT) ÷ 3,600</div>
        </div>

        <div className="card-elevated rounded-xl border-2 border-sky-500/40 bg-sky-500/5 dark:bg-sky-950/30 p-3.5 shadow-xs">
          <div className="text-[11px] font-bold text-sky-600 dark:text-sky-400">
            Required Productive Hours
          </div>
          <div className="mt-1 text-xl font-extrabold tabular-nums text-sky-600 dark:text-sky-300">
            {summary.totalProductiveHours.toFixed(2)}{' '}
            <span className="text-xs font-normal">hrs</span>
          </div>
          <div className="mt-0.5 text-[10px] font-mono text-sky-600/80 dark:text-sky-400/80">
            Int: {summary.totalIntegerProductiveHours.toFixed(1)}h · Frac:{' '}
            {summary.totalFractionalProductiveHours.toFixed(2)}h
          </div>
        </div>

        <div className="card-elevated rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 shadow-xs">
          <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
            Peak Interval Seats
          </div>
          <div className="mt-1 text-xl font-extrabold tabular-nums text-slate-900 dark:text-white">
            {summary.peakSeats} <span className="text-xs font-normal">seats</span>
          </div>
          <div className="mt-0.5 text-[11px] text-slate-400">
            Peak @ {summary.peakTimeLabel}
          </div>
        </div>

        <div className="card-elevated rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 shadow-xs">
          <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
            Weighted Expected SLA / ASA
          </div>
          <div className="mt-1 text-xl font-extrabold tabular-nums text-emerald-600 dark:text-emerald-400">
            {summary.weightedSlPct.toFixed(1)}%{' '}
            <span className="text-xs font-normal text-slate-400">
              ({summary.weightedAsaSec.toFixed(1)}s)
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-slate-400">
            Target: {config.slTargetPct}% in {config.slThresholdSec}s
          </div>
        </div>

        <div className="card-elevated rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 shadow-xs">
          <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
            Resulting Avg Occupancy
          </div>
          <div className="mt-1 text-xl font-extrabold tabular-nums text-slate-900 dark:text-white">
            {summary.avgOccupancyPct.toFixed(1)}%
          </div>
          <div className="mt-0.5 text-[11px] text-slate-400">
            {config.enforceOccupancyCap
              ? `Cap Enforced: ${config.maxOccupancyPct}%`
              : 'Pure ErlangXL97 SLA Mode'}
          </div>
        </div>
      </div>

      {/* =====================================================================
          MONTHLY -> DAILY -> HOURLY VOLUME BREAKDOWN CARD
          ("التقسيمة والتنفيطة للفوليوم زي الشيت")
          ===================================================================== */}
      <div className="bento-card-promax card-elevated rounded-2xl border-2 border-indigo-500/30 bg-gradient-to-r from-indigo-500/10 via-white to-emerald-500/5 dark:from-indigo-950/40 dark:via-slate-900 dark:to-emerald-950/20 p-5 shadow-xs">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="flex items-start gap-3">
            <ProMaxIconBadge tone="violet" size="lg" pulse>
              <ErlangQueueIcon size={24} />
            </ProMaxIconBadge>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white">
                  Monthly → Daily → Hourly Volume Breakdown (Cap Plan Sheet Formula)
                </h3>
                <span className="rounded-full bg-indigo-500/15 border border-indigo-500/30 px-2.5 py-0.5 text-[10px] font-bold text-indigo-600 dark:text-indigo-300">
                  Monthly Volume Decomposer
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Type any Monthly Volume (e.g. 62,245) to automatically break it down into Daily Offered (÷ Month Days), Hourly Volume (÷ HOOPS), Erlang C Seats/Hour, and Required Productive Hours/Day.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() =>
                onApplyFlatMonthlyBreakdown(
                  macroBreakdown.reqPerDayHours,
                  macroBreakdown.pureTalkPerDayHours
                )
              }
              className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white px-3.5 py-1.5 text-xs font-semibold shadow-xs transition cursor-pointer"
            >
              Send {macroBreakdown.reqPerDayHours.toFixed(1)}h/day to Tab 3
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Step-by-Step Visual Pipeline matching User's Excel Sheet */}
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2.5 items-stretch">
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-3">
            <label className="block text-[10px] uppercase font-bold text-slate-400">
              1. Monthly Offered
            </label>
            <SmartNumberInput
              min={0}
              decimals={0}
              value={monthlyVolume}
              onChange={(mv) => {
                const cleanMv = Math.max(0, mv);
                setMonthlyVolume(cleanMv);
                setConfig((c) => ({
                  ...c,
                  dailyVolume: Math.round(cleanMv / Math.max(1, monthDays)),
                }));
              }}
              className="mt-1 w-full rounded-lg border border-indigo-500/40 bg-indigo-500/5 px-2 py-1 text-sm font-extrabold tabular-nums text-indigo-600 dark:text-indigo-300"
            />
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-3">
            <label className="block text-[10px] uppercase font-bold text-slate-400">
              2. Month Days
            </label>
            <SmartNumberInput
              min={1}
              max={31}
              decimals={0}
              value={monthDays}
              onChange={(v) => {
                const md = Math.max(1, Math.min(31, Math.round(v)));
                setMonthDays(md);
                setConfig((c) => ({
                  ...c,
                  dailyVolume: Math.round(monthlyVolume / md),
                }));
              }}
              className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-2 py-1 text-sm font-bold tabular-nums"
            />
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/70 p-3">
            <div className="text-[10px] uppercase font-bold text-slate-400">
              3. Daily Offered
            </div>
            <div className="mt-1.5 text-base font-extrabold tabular-nums text-slate-900 dark:text-white">
              {Math.round(macroBreakdown.dailyOffered).toLocaleString()}
            </div>
            <div className="text-[10px] text-slate-400 font-mono">
              = {monthlyVolume.toLocaleString()} ÷ {monthDays}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-3">
            <label className="block text-[10px] uppercase font-bold text-slate-400">
              4. HOOPS (Hrs/Day)
            </label>
            <SmartNumberInput
              min={1}
              max={24}
              decimals={0}
              value={hoops}
              onChange={(v) => setHoops(Math.max(1, Math.min(24, v)))}
              className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-2 py-1 text-sm font-bold tabular-nums"
            />
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/70 p-3">
            <div className="text-[10px] uppercase font-bold text-slate-400">
              5. Hourly Volume
            </div>
            <div className="mt-1.5 text-base font-extrabold tabular-nums text-sky-600 dark:text-sky-400">
              {macroBreakdown.hourlyVolume.toFixed(1)}{' '}
              <span className="text-xs font-normal">({Math.round(macroBreakdown.hourlyVolume)})</span>
            </div>
            <div className="text-[10px] text-slate-400 font-mono">
              = Daily ÷ {hoops}h
            </div>
          </div>

          <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 p-3">
            <div className="text-[10px] uppercase font-bold text-sky-600 dark:text-sky-300">
              6. Required / Hour
            </div>
            <div className="mt-1.5 text-base font-extrabold tabular-nums text-sky-700 dark:text-sky-200">
              {macroBreakdown.reqPerHour}{' '}
              <span className="text-[11px] font-normal">agents/hr</span>
            </div>
            <div className="text-[10px] text-sky-600/80 dark:text-sky-300/80 font-mono">
              Int: {macroBreakdown.integerPerHour} · Frac: {macroBreakdown.fractionalPerHour}
            </div>
          </div>

          <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3">
            <div className="text-[10px] uppercase font-bold text-emerald-600 dark:text-emerald-300">
              7. Required / Day
            </div>
            <div className="mt-1.5 text-base font-extrabold tabular-nums text-emerald-700 dark:text-emerald-200">
              {macroBreakdown.reqPerDayHours.toFixed(1)}{' '}
              <span className="text-[11px] font-normal">prod hrs</span>
            </div>
            <div className="text-[10px] text-emerald-600/80 dark:text-emerald-300/80 font-mono">
              = {macroBreakdown.reqPerHour} × {hoops}h
            </div>
          </div>
        </div>
      </div>

      {/* =====================================================================
          SIMPLIFIED ERLANG C CONFIG + AGENTS VS FRACTIONAL AGENTS TOGGLE
          ===================================================================== */}
      <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 pb-4 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-start gap-3">
            <div className="icon-badge-glow w-10 h-10 rounded-xl bg-sky-600 text-white flex items-center justify-center shrink-0 shadow-md shadow-sky-600/20">
              <Calculator className="w-5 h-5" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-bold text-slate-900 dark:text-white">
                  Erlang C Staffing Calculator (100% ErlangXL97 Parity)
                </h2>
                <span className="rounded-full bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                  Pure SLA Solver Active
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Choose between <strong>Integer Agents (Agents)</strong> and{' '}
                <strong>Fractional Agents (FractionalAgents)</strong> exactly as implemented in{' '}
                <code>ErlangXL97 1.xls</code>.
              </p>
            </div>
          </div>

          {/* Prominent Toggle: Integer Agents vs Fractional Agents */}
          <div className="flex flex-wrap items-center gap-2">
            <div
              role="group"
              aria-label="Erlang C Agent Counting Mode"
              className="inline-flex rounded-xl border-2 border-sky-500/30 bg-slate-100 dark:bg-slate-950 p-1"
            >
              <button
                type="button"
                onClick={() => setConfig((c) => ({ ...c, agentMode: 'integer' }))}
                className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                  (config.agentMode ?? 'integer') === 'integer'
                    ? 'bg-sky-600 text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                Integer Agents (=Agents)
              </button>
              <button
                type="button"
                onClick={() => setConfig((c) => ({ ...c, agentMode: 'fractional' }))}
                className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                  config.agentMode === 'fractional'
                    ? 'bg-sky-600 text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                Fractional Agents (=FractionalAgents)
              </button>
            </div>

            <button
              type="button"
              onClick={onPushToCapacity}
              className="inline-flex items-center gap-1.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white px-4 py-2 text-xs font-semibold shadow-xs transition cursor-pointer"
            >
              Send {summary.totalProductiveHours.toFixed(1)} Prod Hrs to Tab 3
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Clean 6-Field Core Input Bar (No Confusing Forced Caps!) */}
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <div>
            <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
              Daily Offered Volume
            </label>
            <SmartNumberInput
              min={0}
              decimals={0}
              value={config.dailyVolume}
              onChange={(v) => {
                const dv = Math.max(0, Math.round(v));
                setConfig((c) => ({ ...c, dailyVolume: dv }));
                setMonthlyVolume(dv * monthDays);
              }}
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs font-bold tabular-nums"
            />
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
              Weekday Profile
            </label>
            <select
              value={config.selectedDay}
              onChange={(e) => onSelectDay(e.target.value as DayKey)}
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs font-semibold"
            >
              {DAY_KEYS.map((d) => (
                <option key={d} value={d}>
                  {d} Profile ({dowShares[d]?.toFixed(1)}% wk)
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
              Specific Date (Historical / Forecast)
            </label>
            <select
              value={config.selectedDateIso ?? ''}
              onChange={(e) => {
                onSelectSpecificDate(e.target.value);
              }}
              aria-label="Pick specific historical or forecasted date"
              className="w-full rounded-xl border border-sky-500/40 bg-sky-500/5 px-3 py-2 text-xs font-semibold text-sky-700 dark:text-sky-300"
            >
              <option value="">-- Weekday Average ({config.selectedDay}) --</option>
              {historyDays.length > 0 && (
                <optgroup label="Historical Dates (Exact Date Arrival Pattern)">
                  {historyDays.map((hd) => (
                    <option key={hd.dateIso} value={hd.dateIso}>
                      {hd.dateIso} ({hd.dayKey}) · {(byDateTotals[hd.dateIso] ?? hd.volume).toLocaleString()} calls
                    </option>
                  ))}
                </optgroup>
              )}
              {futureDays.length > 0 && (
                <optgroup label="Next Week Forecast (Mon → Sun)">
                  {futureDays.slice(0, 7).map((fd) => (
                    <option key={fd.dateIso} value={fd.dateIso}>
                      {fd.dateIso} ({fd.dayKey}) · {fd.volume.toLocaleString()} calls (Forecast)
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
              Interval Length
            </label>
            <select
              value={config.granularityMin}
              onChange={(e) => onGranularityChange(Number(e.target.value) as IntervalGranularityMin)}
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs"
            >
              <option value={15}>15 min (96 slots)</option>
              <option value={30}>30 min (48 slots)</option>
              <option value={60}>60 min (24 slots)</option>
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
              AHT (Seconds)
            </label>
            <SmartNumberInput
              min={1}
              decimals={0}
              value={config.globalAhtSec}
              onChange={(v) =>
                setConfig((c) => ({ ...c, globalAhtSec: Math.max(1, v) }))
              }
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs font-bold tabular-nums"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
                SLA %
              </label>
              <SmartNumberInput
                min={1}
                max={99.9}
                decimals={1}
                value={config.slTargetPct}
                onChange={(v) =>
                  setConfig((c) => ({
                    ...c,
                    slTargetPct: Math.min(99.9, Math.max(1, v)),
                  }))
                }
                className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-2 text-xs font-bold tabular-nums"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
                Time (sec)
              </label>
              <SmartNumberInput
                min={1}
                decimals={0}
                value={config.slThresholdSec}
                onChange={(v) =>
                  setConfig((c) => ({
                    ...c,
                    slThresholdSec: Math.max(1, v),
                  }))
                }
                className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-2 text-xs font-bold tabular-nums"
              />
            </div>
          </div>
        </div>

        {/* Secondary Toolbar: Extract Curve from File, Reset Curve, Optional Guardrails Toggle */}
        <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.tsv,.txt,.xlsx,.xls"
              onChange={handleFileChange}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-1.5 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              Upload Interval Matrix (48×7 or Pivot)
            </button>
            <button
              type="button"
              onClick={onResetCurveToDefault}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-1.5 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset Curve
            </button>
          </div>

          <button
            type="button"
            onClick={() => setShowGuardrails((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100/70 dark:bg-slate-950 px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white cursor-pointer"
          >
            <Sliders className="w-3.5 h-3.5" />
            Optional Guardrails (Max Occupancy / Max ASA / Operating Hours / Erlang A)
            {showGuardrails ? (
              <ChevronUp className="w-3.5 h-3.5" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5" />
            )}
          </button>
        </div>

        {importMsg && (
          <div className="mt-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 px-3 py-1.5 text-xs text-emerald-700 dark:text-emerald-300">
            {importMsg}
          </div>
        )}

        {/* Collapsible Optional Guardrails Drawer (OFF by default so SLA math matches ErlangXL97!) */}
        {showGuardrails && (
          <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 rounded-xl p-4 space-y-3">
            <div className="text-xs text-slate-500 dark:text-slate-400">
              By default, standard Erlang C solves strictly for <code>SL ≥ Target SLA</code> (matching{' '}
              <code>ErlangXL97 1.xls</code>). Enable optional constraints below only if you want to force extra agents for Occupancy or ASA caps:
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3">
                <label className="flex items-center gap-2 text-xs font-semibold cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(config.enforceOccupancyCap)}
                    onChange={(e) =>
                      setConfig((c) => ({ ...c, enforceOccupancyCap: e.target.checked }))
                    }
                    className="accent-sky-500"
                  />
                  Enforce Max Occupancy Cap (%)
                </label>
                {config.enforceOccupancyCap && (
                  <input
                    type="number"
                    min={50}
                    max={99}
                    value={config.maxOccupancyPct}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        maxOccupancyPct: Math.min(99, Math.max(50, Number(e.target.value) || 85)),
                      }))
                    }
                    className="mt-2 w-full rounded border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2 py-1 text-xs tabular-nums"
                  />
                )}
              </div>

              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3">
                <label className="flex items-center gap-2 text-xs font-semibold cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(config.enforceMaxAsa)}
                    onChange={(e) =>
                      setConfig((c) => ({ ...c, enforceMaxAsa: e.target.checked }))
                    }
                    className="accent-sky-500"
                  />
                  Enforce Max ASA Cap (sec)
                </label>
                {config.enforceMaxAsa && (
                  <input
                    type="number"
                    min={1}
                    value={config.maxAsaSec}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        maxAsaSec: Math.max(1, Number(e.target.value) || 30),
                      }))
                    }
                    className="mt-2 w-full rounded border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2 py-1 text-xs tabular-nums"
                  />
                )}
              </div>

              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3">
                <label className="flex items-center gap-2 text-xs font-semibold cursor-pointer">
                  <input
                    type="checkbox"
                    checked={config.useErlangA}
                    onChange={(e) =>
                      setConfig((c) => ({ ...c, useErlangA: e.target.checked }))
                    }
                    className="accent-amber-500"
                  />
                  Enable Erlang A (Patience sec)
                </label>
                {config.useErlangA && (
                  <input
                    type="number"
                    min={10}
                    value={config.avgPatienceSec}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        avgPatienceSec: Math.max(10, Number(e.target.value) || 90),
                      }))
                    }
                    className="mt-2 w-full rounded border border-amber-500/40 bg-slate-50 dark:bg-slate-950 px-2 py-1 text-xs tabular-nums"
                  />
                )}
              </div>

              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3">
                <label className="flex items-center gap-2 text-xs font-semibold cursor-pointer">
                  <input
                    type="checkbox"
                    checked={config.operating24x7}
                    onChange={(e) =>
                      setConfig((c) => ({ ...c, operating24x7: e.target.checked }))
                    }
                    className="accent-sky-500"
                  />
                  24/7 Operating Hours
                </label>
                {!config.operating24x7 && (
                  <div className="mt-2 flex items-center gap-1.5 text-xs">
                    <input
                      type="number"
                      min={0}
                      max={23}
                      value={config.startHour}
                      onChange={(e) =>
                        setConfig((c) => ({ ...c, startHour: Number(e.target.value) || 0 }))
                      }
                      className="w-14 rounded border border-slate-300 dark:border-slate-700 px-1.5 py-0.5 tabular-nums"
                    />
                    <span>to</span>
                    <input
                      type="number"
                      min={1}
                      max={24}
                      value={config.endHour}
                      onChange={(e) =>
                        setConfig((c) => ({ ...c, endHour: Number(e.target.value) || 24 }))
                      }
                      className="w-14 rounded border border-slate-300 dark:border-slate-700 px-1.5 py-0.5 tabular-nums"
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Intraday Staffing Curve Chart */}
      <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
          <div>
            <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Activity className="w-4 h-4 text-sky-500" />
              Intraday Staffing Curve: Required Seats (N) vs Traffic Intensity (Erlangs A)
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Visualizes peak intervals, pure traffic workload (Erlangs), and resulting agent occupancy across the day.
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 text-xs font-semibold text-sky-600 dark:text-sky-400">
            <Calendar className="w-3.5 h-3.5" />
            {config.selectedDateIso
              ? `Exact Date Pattern: ${config.selectedDateIso} (${config.selectedDay})`
              : `Weekday Profile: ${config.selectedDay} Average`}
          </span>
        </div>

        <div>
          <InteractiveStaffingChart rows={summary.rows} agentMode={config.agentMode} />
        </div>
      </div>

      {/* Detailed Interval Schedule Table showing BOTH Integer Agents & Fractional Agents + Multi-Day Horizon & Export */}
      <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-xs">
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex flex-col gap-3">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Clock className="w-4 h-4 text-sky-500" />
                Per-Interval Erlang Staffing Schedule (
                {intervalScope === 'single_day'
                  ? `${summary.rows.length} intervals × ${config.granularityMin} min`
                  : `${multiDayTotals.daysCount} Days × ${summary.rows.length} intervals`}
                )
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Displays both <code>Integer Agents (=Agents)</code> and{' '}
                <code>Fractional Agents (=FractionalAgents)</code> side-by-side.{' '}
                {intervalScope === 'single_day' ? (
                  <>
                    Total Volume: <strong>{summary.totalVolume.toLocaleString()}</strong> · Total Productive Hours:{' '}
                    <strong className="text-sky-600 dark:text-sky-400">
                      {summary.totalProductiveHours.toFixed(2)} hrs
                    </strong>
                  </>
                ) : (
                  <>
                    Horizon Calls: <strong>{multiDayTotals.totalCalls.toLocaleString()}</strong> · Total Prod Hours:{' '}
                    <strong className="text-sky-600 dark:text-sky-400">
                      {multiDayTotals.totalProdHrs.toFixed(2)} hrs
                    </strong>{' '}
                    · Avg SLA:{' '}
                    <strong className="text-emerald-600 dark:text-emerald-400">
                      {multiDayTotals.avgSla.toFixed(1)}%
                    </strong>
                  </>
                )}
              </p>
            </div>

            {/* Export Buttons */}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  if (intervalScope === 'single_day') {
                    exportMultiDayIntervalScheduleXlsx({
                      schedules: [
                        {
                          dateIso: config.selectedDateIso || `Active-${config.selectedDay}`,
                          dayKey: config.selectedDay,
                          dailyVolume: summary.totalVolume,
                          sourceLabel: config.selectedDateIso ? 'Historical' : 'Forecast',
                          summary,
                        },
                      ],
                      erlangConfig: config,
                      scopeLabel: `Single_Day_${config.selectedDateIso || config.selectedDay}`,
                    });
                  } else {
                    exportMultiDayIntervalScheduleXlsx({
                      schedules: filteredMultiDaySchedules,
                      erlangConfig: config,
                      scopeLabel:
                        multiDayFilterDate === 'ALL'
                          ? `Horizon_${intervalScope}_${filteredMultiDaySchedules.length}d`
                          : `Day_${multiDayFilterDate}`,
                    });
                  }
                }}
                className="btn-cnx-teal inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold shadow-xs transition cursor-pointer"
                title="Download Excel (.xlsx) for the currently displayed day or view"
              >
                <Download className="w-3.5 h-3.5" />
                {intervalScope === 'single_day' || multiDayFilterDate !== 'ALL'
                  ? 'Export Selected Day (.xlsx)'
                  : `Export ${filteredMultiDaySchedules.length}d Schedule (.xlsx)`}
              </button>

              {intervalScope !== 'single_day' && multiDayFilterDate !== 'ALL' && (
                <button
                  type="button"
                  onClick={() =>
                    exportMultiDayIntervalScheduleXlsx({
                      schedules: multiDaySchedules,
                      erlangConfig: config,
                      scopeLabel: `Full_Horizon_${multiDaySchedules.length}d`,
                    })
                  }
                  className="btn-cnx-primary inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold shadow-xs transition cursor-pointer"
                  title="Download Excel (.xlsx) for the entire multi-day horizon"
                >
                  <Download className="w-3.5 h-3.5" />
                  Export All {multiDaySchedules.length} Days (.xlsx)
                </button>
              )}
            </div>
          </div>

          {/* Scope Bar: Single Day | Next Week (7d) | Custom N Days (e.g. 10d) | Full Period (All Days) */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-200/70 dark:border-slate-800/70">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mr-1">
                Planning Horizon:
              </span>
              <button
                type="button"
                onClick={() => {
                  setIntervalScope('single_day');
                  setMultiDayFilterDate('ALL');
                }}
                className={`rounded-lg px-2.5 py-1 text-xs font-bold transition cursor-pointer ${
                  intervalScope === 'single_day'
                    ? 'bg-[#00A3E0] text-white shadow-xs'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                }`}
              >
                Single Day ({config.selectedDateIso || config.selectedDay})
              </button>

              <button
                type="button"
                onClick={() => {
                  setIntervalScope('next_week');
                  setMultiDayFilterDate('ALL');
                }}
                className={`rounded-lg px-2.5 py-1 text-xs font-bold transition cursor-pointer ${
                  intervalScope === 'next_week'
                    ? 'bg-[#00A3E0] text-white shadow-xs'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                }`}
              >
                Next Week (7 Days · Mon → Sun)
              </button>

              <div className="inline-flex items-center gap-1 rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5">
                <button
                  type="button"
                  onClick={() => {
                    setIntervalScope('custom_days');
                    setMultiDayFilterDate('ALL');
                  }}
                  className={`rounded-md px-2.5 py-1 text-xs font-bold transition cursor-pointer ${
                    intervalScope === 'custom_days'
                      ? 'bg-[#00A3E0] text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                  }`}
                >
                  Custom N Days:
                </button>
                <SmartNumberInput
                  value={customHorizonDays}
                  min={1}
                  max={60}
                  step={1}
                  onChange={(v) => {
                    setCustomHorizonDays(Math.round(v));
                    setIntervalScope('custom_days');
                    setMultiDayFilterDate('ALL');
                  }}
                  className="w-14 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 py-0.5 text-xs font-bold text-center tabular-nums"
                />
              </div>

              <button
                type="button"
                onClick={() => {
                  setIntervalScope('all_days');
                  setMultiDayFilterDate('ALL');
                }}
                className={`rounded-lg px-2.5 py-1 text-xs font-bold transition cursor-pointer ${
                  intervalScope === 'all_days'
                    ? 'bg-[#00A3E0] text-white shadow-xs'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                }`}
              >
                Full Period ({historyDays.length + Math.min(14, futureDays.length)} Days)
              </button>
            </div>

            {/* Day Filter when in Multi-Day Horizon Mode */}
            {intervalScope !== 'single_day' && (
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                  Inspect Day:
                </span>
                <select
                  value={multiDayFilterDate}
                  onChange={(e) => setMultiDayFilterDate(e.target.value)}
                  className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1 text-xs font-semibold text-slate-800 dark:text-slate-100"
                >
                  <option value="ALL">
                    All {multiDaySchedules.length} Days Combined ({multiDaySchedules.length * summary.rows.length} rows)
                  </option>
                  {multiDaySchedules.map((d) => (
                    <option key={d.dateIso} value={d.dateIso}>
                      {d.dateIso} ({d.dayKey}) · {d.dailyVolume.toLocaleString()} calls · {d.sourceLabel}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>

        <div className="max-h-96 overflow-y-auto">
          {intervalScope === 'single_day' ? (
            <table className="w-full text-left border-collapse text-xs">
              <thead className="sticky top-0 z-10 bg-slate-100 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th className="py-2.5 px-3 font-semibold">Interval</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Arrival %</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Calls</th>
                  <th className="py-2.5 px-3 font-semibold text-right">AHT (s)</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Erlangs (A)</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Integer Agents</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Fractional Agents</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Occupancy %</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Expected SLA %</th>
                  <th className="py-2.5 px-3 font-semibold text-right">ASA (s)</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Prod. Hours</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200/60 dark:divide-slate-800/60">
                {summary.rows.map((r, idx) => (
                  <tr
                    key={r.index}
                    className={
                      r.isOpen ? 'hover:bg-slate-50/80 dark:hover:bg-slate-800/40' : 'opacity-45'
                    }
                  >
                    <td className="py-1.5 px-3 font-mono font-medium">
                      <span className="inline-flex items-center gap-1.5">
                        <Calendar className="w-3 h-3 text-slate-400" />
                        {r.timeLabel}
                      </span>
                    </td>
                    <td className="py-1.5 px-3 text-right">
                      <input
                        type="number"
                        step={0.1}
                        min={0}
                        value={Number(intervals[idx]?.arrivalPct.toFixed(3) ?? 0)}
                        onChange={(e) => updateRowOverride(idx, 'arrivalPct', e.target.value)}
                        className="w-16 text-right rounded border border-slate-200 dark:border-slate-700 bg-transparent px-1.5 py-0.5 tabular-nums"
                      />
                    </td>
                    <td
                      className={`py-1.5 px-3 text-right tabular-nums ${heatBg(r.volume / maxVol)}`}
                    >
                      {r.volume.toLocaleString()}
                    </td>
                    <td className="py-1.5 px-3 text-right">
                      <input
                        type="number"
                        min={1}
                        placeholder={String(config.globalAhtSec)}
                        value={intervals[idx]?.ahtOverrideSec ?? ''}
                        onChange={(e) => updateRowOverride(idx, 'ahtOverrideSec', e.target.value)}
                        className="w-16 text-right rounded border border-slate-200 dark:border-slate-700 bg-transparent px-1.5 py-0.5 tabular-nums placeholder:text-slate-400"
                      />
                    </td>
                    <td className="py-1.5 px-3 text-right tabular-nums text-slate-600 dark:text-slate-300">
                      {r.erlangs.toFixed(2)}
                    </td>
                    <td
                      className={`py-1.5 px-3 text-right tabular-nums ${
                        (config.agentMode ?? 'integer') === 'integer'
                          ? heatBg(r.requiredSeats / maxSeats)
                          : 'text-slate-500'
                      }`}
                    >
                      {r.integerSeats}
                    </td>
                    <td
                      className={`py-1.5 px-3 text-right tabular-nums ${
                        config.agentMode === 'fractional'
                          ? heatBg(r.requiredSeats / maxSeats)
                          : 'text-sky-600 dark:text-sky-400 font-medium'
                      }`}
                    >
                      {r.fractionalSeats.toFixed(2)}
                    </td>
                    <td className="py-1.5 px-3 text-right tabular-nums">
                      {r.occupancyPct.toFixed(1)}%
                    </td>
                    <td className="py-1.5 px-3 text-right tabular-nums font-semibold text-emerald-600 dark:text-emerald-400">
                      {r.slPct.toFixed(1)}%
                    </td>
                    <td className="py-1.5 px-3 text-right tabular-nums">
                      {r.asaSec.toFixed(1)}s
                    </td>
                    <td className="py-1.5 px-3 text-right tabular-nums font-semibold text-sky-600 dark:text-sky-400">
                      {r.productiveHours.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="w-full text-left border-collapse text-xs">
              <thead className="sticky top-0 z-10 bg-slate-100 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th className="py-2.5 px-3 font-semibold">Date (Day)</th>
                  <th className="py-2.5 px-3 font-semibold">Source</th>
                  <th className="py-2.5 px-3 font-semibold">Interval</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Arrival %</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Calls</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Erlangs (A)</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Integer Agents</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Fractional Agents</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Occupancy %</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Expected SLA %</th>
                  <th className="py-2.5 px-3 font-semibold text-right">ASA (s)</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Prod. Hours</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200/60 dark:divide-slate-800/60">
                {filteredMultiDaySchedules.map((daySched) =>
                  daySched.summary.rows.map((r) => (
                    <tr
                      key={`${daySched.dateIso}-${r.index}`}
                      className={
                        r.isOpen ? 'hover:bg-slate-50/80 dark:hover:bg-slate-800/40' : 'opacity-45'
                      }
                    >
                      <td className="py-1.5 px-3 font-mono font-semibold text-slate-800 dark:text-slate-200">
                        {daySched.dateIso} ({daySched.dayKey})
                      </td>
                      <td className="py-1.5 px-3">
                        <span
                          className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${
                            daySched.sourceLabel === 'Forecast'
                              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                              : 'bg-sky-500/15 text-sky-700 dark:text-sky-300'
                          }`}
                        >
                          {daySched.sourceLabel}
                        </span>
                      </td>
                      <td className="py-1.5 px-3 font-mono font-medium">{r.timeLabel}</td>
                      <td className="py-1.5 px-3 text-right tabular-nums">
                        {r.arrivalPct.toFixed(3)}%
                      </td>
                      <td className="py-1.5 px-3 text-right tabular-nums font-semibold">
                        {r.volume.toLocaleString()}
                      </td>
                      <td className="py-1.5 px-3 text-right tabular-nums text-slate-600 dark:text-slate-300">
                        {r.erlangs.toFixed(2)}
                      </td>
                      <td className="py-1.5 px-3 text-right tabular-nums font-bold text-emerald-600 dark:text-emerald-400">
                        {r.integerSeats}
                      </td>
                      <td className="py-1.5 px-3 text-right tabular-nums font-bold text-sky-600 dark:text-sky-400">
                        {r.fractionalSeats.toFixed(2)}
                      </td>
                      <td className="py-1.5 px-3 text-right tabular-nums">
                        {r.occupancyPct.toFixed(1)}%
                      </td>
                      <td className="py-1.5 px-3 text-right tabular-nums font-semibold text-emerald-600 dark:text-emerald-400">
                        {r.slPct.toFixed(1)}%
                      </td>
                      <td className="py-1.5 px-3 text-right tabular-nums">{r.asaSec.toFixed(1)}s</td>
                      <td className="py-1.5 px-3 text-right tabular-nums font-semibold text-sky-600 dark:text-sky-400">
                        {r.productiveHours.toFixed(2)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
};
