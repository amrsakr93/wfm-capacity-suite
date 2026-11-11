import React from 'react';
import {
  Users,
  Layers,
  ShieldCheck,
  Sparkles,
  Grid,
  Download,
  Printer,
  Info,
} from 'lucide-react';
import type {
  CapacityConfig,
  CapacityResult,
  WhatIfCell,
} from '../engine/types.ts';

interface Props {
  config: CapacityConfig;
  setConfig: React.Dispatch<React.SetStateAction<CapacityConfig>>;
  result: CapacityResult;
  whatIfMatrix: WhatIfCell[][];
  shrinkageDeltas: number[];
  baseGlobalAhtSec: number;
  monthlyVolume: number;
  setMonthlyVolume: (vol: number) => void;
  monthDays: number;
  setMonthDays: (days: number) => void;
  hoops: number;
  setHoops: (h: number) => void;
  slTargetPct: number;
  slThresholdSec: number;
  onLoadCnxBenchmark: () => void;
  onExportExcel: () => void;
}

export const Tab3Capacity: React.FC<Props> = ({
  config,
  setConfig,
  result,
  whatIfMatrix,
  shrinkageDeltas,
  baseGlobalAhtSec,
  monthlyVolume,
  setMonthlyVolume,
  monthDays,
  setMonthDays,
  hoops,
  setHoops,
  slTargetPct,
  slThresholdSec,
  onLoadCnxBenchmark,
  onExportExcel,
}) => {
  const maxWaterfallFte = Math.max(...result.waterfall.map((w) => w.fte), 1);
  const dailyOfferedFromMonth = monthlyVolume / Math.max(1, monthDays);
  const hourlyVolFromMonth = dailyOfferedFromMonth / Math.max(1, hoops);
  const reqPerHourEquiv = result.baseRequiredProductiveHoursPerDay / Math.max(1, hoops);
  const inOfficeProdHoursPerShift =
    result.effectivePaidShiftHours * (1 - result.inOfficeShrinkagePct / 100);
  const reqPerDayAfterInOffice =
    inOfficeProdHoursPerShift > 0
      ? result.baseRequiredProductiveHoursPerDay / inOfficeProdHoursPerShift
      : 0;
  const reqPerWeekAfterInOffice = reqPerDayAfterInOffice * result.weeklyCoverageMultiplier;

  return (
    <div className="space-y-6 animate-slide-up">
      {/* Executive Monthly Cap Plan Step-by-Step Sheet ("التقسيمة والتنفيطة الشهرية") */}
      <div className="card-elevated rounded-2xl border-2 border-emerald-500/35 bg-gradient-to-r from-emerald-500/10 via-white to-sky-500/5 dark:from-emerald-950/35 dark:via-slate-900 dark:to-sky-950/20 p-5 shadow-xs">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 pb-4 border-b border-slate-200/80 dark:border-slate-800">
          <div className="flex items-start gap-3">
            <div className="icon-badge-glow w-10 h-10 rounded-xl bg-emerald-600 text-white flex items-center justify-center shrink-0 shadow-md shadow-emerald-600/25">
              <Layers className="w-5 h-5 animate-float" />
            </div>
            <div>
              <h2 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white">
                Executive Monthly Cap Plan Breakdown (Monthly → Daily → Hourly → Final Agents Required)
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Complete step-by-step volume &amp; headcount decomposition matching your standard Capacity Plan spreadsheet.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onLoadCnxBenchmark}
              className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-700 dark:text-emerald-300 px-3.5 py-1.5 text-xs font-bold transition cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Load 62,245 Monthly Benchmark (→ 60 Agents)
            </button>
            <button
              type="button"
              onClick={onExportExcel}
              className="inline-flex items-center gap-1.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white px-3.5 py-1.5 text-xs font-semibold shadow-xs cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              Export .xlsx
            </button>
          </div>
        </div>

        {/* 16-Cell Structured Cap Plan Grid */}
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2.5 text-xs">
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-2.5">
            <div className="text-[10px] font-bold uppercase text-slate-400">Monthly Offered</div>
            <input
              type="number"
              value={monthlyVolume}
              onChange={(e) => setMonthlyVolume(Math.max(0, Number(e.target.value) || 0))}
              className="mt-1 w-full rounded border border-emerald-500/40 bg-emerald-500/5 px-1.5 py-0.5 text-sm font-extrabold tabular-nums text-emerald-600 dark:text-emerald-300"
            />
          </div>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-2.5">
            <div className="text-[10px] font-bold uppercase text-slate-400">Month Days</div>
            <input
              type="number"
              min={1}
              max={31}
              value={monthDays}
              onChange={(e) => setMonthDays(Math.max(1, Number(e.target.value) || 30))}
              className="mt-1 w-full rounded border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-1.5 py-0.5 text-sm font-bold tabular-nums"
            />
          </div>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/70 p-2.5">
            <div className="text-[10px] font-bold uppercase text-slate-400">Daily Offered</div>
            <div className="mt-1.5 text-sm font-extrabold tabular-nums text-slate-900 dark:text-white">
              {Math.round(dailyOfferedFromMonth).toLocaleString()}
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-2.5">
            <div className="text-[10px] font-bold uppercase text-slate-400">HOOPS (Hrs)</div>
            <input
              type="number"
              min={1}
              max={24}
              value={hoops}
              onChange={(e) => setHoops(Math.max(1, Math.min(24, Number(e.target.value) || 24)))}
              className="mt-1 w-full rounded border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-1.5 py-0.5 text-sm font-bold tabular-nums"
            />
          </div>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/70 p-2.5">
            <div className="text-[10px] font-bold uppercase text-slate-400">Hourly Volume</div>
            <div className="mt-1.5 text-sm font-extrabold tabular-nums text-sky-600 dark:text-sky-400">
              {Math.round(hourlyVolFromMonth).toLocaleString()}{' '}
              <span className="text-[10px] font-normal">({hourlyVolFromMonth.toFixed(1)})</span>
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/70 p-2.5">
            <div className="text-[10px] font-bold uppercase text-slate-400">SLA / ASA / AHT</div>
            <div className="mt-1.5 text-xs font-bold tabular-nums text-slate-800 dark:text-slate-200">
              {slTargetPct}% / {slThresholdSec}s / {baseGlobalAhtSec}s
            </div>
          </div>
          <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 p-2.5">
            <div className="text-[10px] font-bold uppercase text-sky-600 dark:text-sky-300">
              Required / Hr &amp; Day
            </div>
            <div className="mt-1.5 text-xs font-extrabold tabular-nums text-sky-700 dark:text-sky-200">
              {reqPerHourEquiv.toFixed(1)}/hr · {result.baseRequiredProductiveHoursPerDay.toFixed(0)}h/d
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/70 p-2.5">
            <div className="text-[10px] font-bold uppercase text-slate-400">
              Work − Break = Login
            </div>
            <div className="mt-1.5 text-xs font-bold tabular-nums text-slate-800 dark:text-slate-200">
              {config.grossShiftHours}h − {config.unpaidBreakHours}h ={' '}
              {result.effectivePaidShiftHours.toFixed(1)}h
            </div>
          </div>
        </div>

        {/* Second Row of Cap Plan Breakdown */}
        <div className="mt-2.5 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 text-xs">
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/70 p-2.5">
            <div className="text-[10px] font-bold uppercase text-slate-400">
              In-Office Shrinkage
            </div>
            <div className="mt-1 text-sm font-bold tabular-nums text-amber-600 dark:text-amber-400">
              {result.inOfficeShrinkagePct.toFixed(1)}%
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/70 p-2.5">
            <div className="text-[10px] font-bold uppercase text-slate-400">
              Productive Hrs / Agent
            </div>
            <div className="mt-1 text-sm font-extrabold tabular-nums text-slate-900 dark:text-white">
              {inOfficeProdHoursPerShift.toFixed(2)} hrs
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/70 p-2.5">
            <div className="text-[10px] font-bold uppercase text-slate-400">
              Required / Day (Seats)
            </div>
            <div className="mt-1 text-sm font-extrabold tabular-nums text-slate-900 dark:text-white">
              {Math.round(reqPerDayAfterInOffice)}{' '}
              <span className="text-[10px] font-normal text-slate-400">
                ({reqPerDayAfterInOffice.toFixed(2)})
              </span>
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/70 p-2.5">
            <div className="text-[10px] font-bold uppercase text-slate-400">
              Required / Week (×{config.operatingDaysPerWeek}/{config.agentWorkdaysPerWeek})
            </div>
            <div className="mt-1 text-sm font-extrabold tabular-nums text-slate-900 dark:text-white">
              {Math.round(reqPerWeekAfterInOffice)}{' '}
              <span className="text-[10px] font-normal text-slate-400">
                ({reqPerWeekAfterInOffice.toFixed(2)})
              </span>
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/70 p-2.5">
            <div className="text-[10px] font-bold uppercase text-slate-400">
              Schedule Inflex (+{config.scheduleInefficiencyPct}%)
            </div>
            <div className="mt-1 text-sm font-extrabold tabular-nums text-slate-900 dark:text-white">
              {Math.round(result.scheduledSeatsAfterInflex)}{' '}
              <span className="text-[10px] font-normal text-slate-400">
                ({result.scheduledSeatsAfterInflex.toFixed(2)})
              </span>
            </div>
          </div>
          <div className="rounded-xl border-2 border-emerald-500 bg-emerald-500/15 p-2.5">
            <div className="text-[10px] font-bold uppercase text-emerald-700 dark:text-emerald-300">
              Agents Required [A] (÷{100 - result.outOfOfficeShrinkagePct}% Out)
            </div>
            <div className="mt-1 text-lg font-extrabold tabular-nums text-emerald-700 dark:text-emerald-300">
              {Math.round(result.finalGrossFte)} Agents{' '}
              <span className="text-xs font-semibold">
                ({result.finalGrossFte.toFixed(1)})
              </span>
            </div>
          </div>
        </div>
      </div>
      {/* Executive Gross Headcount Banner */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3.5">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5">
          <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
            Base Productive Hours / Day
          </div>
          <div className="mt-1 text-xl font-bold tabular-nums text-slate-900 dark:text-white">
            {result.baseRequiredProductiveHoursPerDay.toFixed(1)} <span className="text-xs font-normal">hrs</span>
          </div>
          <div className="mt-0.5 text-[11px] text-slate-400">
            {config.route === 'erlang_c' ? 'From Tab 2 Erlang C' : 'Flat Top-Down Route'}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5">
          <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
            Paid / Login Shift Length
          </div>
          <div className="mt-1 text-xl font-bold tabular-nums text-slate-900 dark:text-white">
            {result.effectivePaidShiftHours.toFixed(2)} <span className="text-xs font-normal">hrs</span>
          </div>
          <div className="mt-0.5 text-[11px] text-slate-400">
            Net Prod: {result.netProductiveHoursPerShiftPerFte.toFixed(2)}h / shift
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5">
          <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
            Compound Total Shrinkage
          </div>
          <div className="mt-1 text-xl font-bold tabular-nums text-amber-600 dark:text-amber-400">
            {result.compoundTotalShrinkagePct.toFixed(2)}%
          </div>
          <div className="mt-0.5 text-[11px] text-slate-400">
            In {result.inOfficeShrinkagePct.toFixed(1)}% · Out {result.outOfOfficeShrinkagePct.toFixed(1)}%
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5">
          <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
            Daily Productive Seats
          </div>
          <div className="mt-1 text-xl font-bold tabular-nums text-slate-900 dark:text-white">
            {result.dailyRequiredSeats.toFixed(1)}
          </div>
          <div className="mt-0.5 text-[11px] text-slate-400">
            Roster ×{result.weeklyCoverageMultiplier.toFixed(2)} ({config.operatingDaysPerWeek}/{config.agentWorkdaysPerWeek}d)
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5">
          <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
            Scheduled Seats (Post Inflex)
          </div>
          <div className="mt-1 text-xl font-bold tabular-nums text-slate-900 dark:text-white">
            {result.scheduledSeatsAfterInflex.toFixed(1)}
          </div>
          <div className="mt-0.5 text-[11px] text-slate-400">
            Schedule Inflex: +{config.scheduleInefficiencyPct.toFixed(1)}%
          </div>
        </div>

        <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 dark:bg-emerald-950/30 p-3.5">
          <div className="text-[11px] font-semibold text-emerald-800 dark:text-emerald-300">
            Final Gross Headcount (FTE)
          </div>
          <div className="mt-1 text-2xl font-bold tabular-nums text-emerald-700 dark:text-emerald-300">
            {result.finalGrossFte.toFixed(1)}{' '}
            <span className="text-xs font-semibold">
              (⌈{Math.ceil(result.finalGrossFte)}⌉)
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-emerald-700/80 dark:text-emerald-300/80">
            ×{result.effectiveMultiplierOverPureTalk.toFixed(2)} over Pure Talk
          </div>
        </div>
      </div>

      {/* Route & Shift Configuration */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 dark:border-slate-800 pb-3.5">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <Layers className="w-4 h-4 text-sky-500" />
              Capacity Route, Shift Architecture &amp; Shrinkage Breakdown
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Prevents double-counting Occupancy (in Erlang C mode) and prevents double-deducting unpaid lunch breaks.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onLoadCnxBenchmark}
              className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/10 hover:bg-sky-500/20 text-sky-700 dark:text-sky-300 px-3 py-1.5 text-xs font-medium cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Load Cap Plan Benchmark (240h → 60 FTE)
            </button>
            <button
              type="button"
              onClick={onExportExcel}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3.5 py-1.5 text-xs font-semibold cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              Export Multi-Sheet Excel (.xlsx)
            </button>
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
            >
              <Printer className="w-3.5 h-3.5" />
              Print / Save PDF
            </button>
          </div>
        </div>

        {/* Calculation Route + Shift Parameters */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3.5 space-y-2.5 bg-slate-50/50 dark:bg-slate-950/40">
            <div className="text-xs font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-sky-500" />
              1. Workload Route (No Double-Counting)
            </div>
            <select
              value={config.route}
              onChange={(e) =>
                setConfig((c) => ({ ...c, route: e.target.value as CapacityConfig['route'] }))
              }
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-medium"
            >
              <option value="erlang_c">Erlang C Route (Uses Tab 2 Prod Hours)</option>
              <option value="flat_top_down">Flat Top-Down (Pure Talk ÷ Target Occ %)</option>
            </select>

            {config.route === 'erlang_c' ? (
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">
                  Required Productive Hours / Day (Tab 2)
                </label>
                <input
                  type="number"
                  step={0.5}
                  min={0}
                  value={Number(config.erlangProductiveHoursPerDay.toFixed(2))}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      erlangProductiveHoursPerDay: Math.max(0, Number(e.target.value) || 0),
                    }))
                  }
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs tabular-nums font-semibold"
                />
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">Pure Talk Hrs</label>
                  <input
                    type="number"
                    step={0.5}
                    value={Number(config.pureTalkHoursPerDay.toFixed(2))}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        pureTalkHoursPerDay: Math.max(0, Number(e.target.value) || 0),
                      }))
                    }
                    className="w-full rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-xs tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">Target Occ %</label>
                  <input
                    type="number"
                    min={50}
                    max={98}
                    value={config.flatTargetOccupancyPct}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        flatTargetOccupancyPct: Math.max(50, Math.min(98, Number(e.target.value) || 85)),
                      }))
                    }
                    className="w-full rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-xs tabular-nums"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Shift Length & Break Accounting */}
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3.5 space-y-2.5 bg-slate-50/50 dark:bg-slate-950/40">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                2. Shift &amp; Break Accounting
              </span>
              <label className="inline-flex items-center gap-1 text-[11px] text-sky-600 dark:text-sky-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.useShiftMinusBreak}
                  onChange={(e) =>
                    setConfig((c) => ({ ...c, useShiftMinusBreak: e.target.checked }))
                  }
                  className="accent-sky-600"
                />
                Gross − Break
              </label>
            </div>

            {config.useShiftMinusBreak ? (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">Working Shift (h)</label>
                  <input
                    type="number"
                    step={0.5}
                    min={1}
                    max={16}
                    value={config.grossShiftHours}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        grossShiftHours: Math.max(1, Number(e.target.value) || 9),
                      }))
                    }
                    className="w-full rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-xs tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">Unpaid Break (h)</label>
                  <input
                    type="number"
                    step={0.25}
                    min={0}
                    max={4}
                    value={config.unpaidBreakHours}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        unpaidBreakHours: Math.max(0, Number(e.target.value) || 0),
                      }))
                    }
                    className="w-full rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-xs tabular-nums"
                  />
                </div>
              </div>
            ) : (
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">
                  Paid / Login Shift Hours (Excl. Unpaid Lunch)
                </label>
                <input
                  type="number"
                  step={0.25}
                  min={1}
                  max={16}
                  value={config.paidShiftHoursDirect}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      paidShiftHoursDirect: Math.max(1, Number(e.target.value) || 8),
                    }))
                  }
                  className="w-full rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs tabular-nums"
                />
              </div>
            )}

            <p className="text-[11px] text-slate-500 flex items-center gap-1">
              <Info className="w-3.5 h-3.5 text-sky-500 shrink-0" />
              Login Hours = <strong>{result.effectivePaidShiftHours.toFixed(2)}h</strong> (do not re-deduct unpaid lunch in In-Office Shrinkage).
            </p>
          </div>

          {/* Weekly Roster & Schedule Inefficiency */}
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3.5 space-y-2.5 bg-slate-50/50 dark:bg-slate-950/40">
            <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
              3. Weekly Roster &amp; Schedule Inflex
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Center Days/Wk</label>
                <input
                  type="number"
                  min={1}
                  max={7}
                  step={0.5}
                  value={config.operatingDaysPerWeek}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      operatingDaysPerWeek: Math.max(1, Math.min(7, Number(e.target.value) || 7)),
                    }))
                  }
                  className="w-full rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-xs tabular-nums"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Agent Days/Wk</label>
                <input
                  type="number"
                  min={1}
                  max={7}
                  step={0.5}
                  value={config.agentWorkdaysPerWeek}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      agentWorkdaysPerWeek: Math.max(1, Math.min(7, Number(e.target.value) || 5)),
                    }))
                  }
                  className="w-full rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-xs tabular-nums"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Sched Inflex %</label>
                <input
                  type="number"
                  step={0.5}
                  min={0}
                  max={40}
                  value={config.scheduleInefficiencyPct}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      scheduleInefficiencyPct: Math.max(0, Number(e.target.value) || 0),
                    }))
                  }
                  className="w-full rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-xs tabular-nums"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Ramp Buffer %</label>
                <input
                  type="number"
                  step={0.5}
                  min={0}
                  max={40}
                  value={config.attritionRampBufferPct}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      attritionRampBufferPct: Math.max(0, Number(e.target.value) || 0),
                    }))
                  }
                  className="w-full rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-xs tabular-nums"
                />
              </div>
            </div>
          </div>

          {/* Shrinkage Sub-factors */}
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3.5 space-y-2.5 bg-slate-50/50 dark:bg-slate-950/40">
            <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
              4. Shrinkage Components (%)
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div>
                <span className="font-medium text-sky-600 dark:text-sky-400 block mb-1">
                  In-Office ({result.inOfficeShrinkagePct.toFixed(1)}%)
                </span>
                <label className="flex justify-between items-center mb-1">
                  <span>Coaching/Train</span>
                  <input
                    type="number"
                    step={0.5}
                    min={0}
                    value={config.inOfficeBreakdown.trainingCoachingPct}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        inOfficeBreakdown: {
                          ...c.inOfficeBreakdown,
                          trainingCoachingPct: Math.max(0, Number(e.target.value) || 0),
                        },
                      }))
                    }
                    className="w-12 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-1 py-0.5 text-right tabular-nums"
                  />
                </label>
                <label className="flex justify-between items-center mb-1">
                  <span>Meetings</span>
                  <input
                    type="number"
                    step={0.5}
                    min={0}
                    value={config.inOfficeBreakdown.meetingsHuddlesPct}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        inOfficeBreakdown: {
                          ...c.inOfficeBreakdown,
                          meetingsHuddlesPct: Math.max(0, Number(e.target.value) || 0),
                        },
                      }))
                    }
                    className="w-12 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-1 py-0.5 text-right tabular-nums"
                  />
                </label>
                <label className="flex justify-between items-center mb-1">
                  <span>Sys Downtime</span>
                  <input
                    type="number"
                    step={0.5}
                    min={0}
                    value={config.inOfficeBreakdown.systemDowntimePct}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        inOfficeBreakdown: {
                          ...c.inOfficeBreakdown,
                          systemDowntimePct: Math.max(0, Number(e.target.value) || 0),
                        },
                      }))
                    }
                    className="w-12 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-1 py-0.5 text-right tabular-nums"
                  />
                </label>
                <label className="flex justify-between items-center">
                  <span>Paid Breaks</span>
                  <input
                    type="number"
                    step={0.5}
                    min={0}
                    value={config.inOfficeBreakdown.paidBreaksPct}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        inOfficeBreakdown: {
                          ...c.inOfficeBreakdown,
                          paidBreaksPct: Math.max(0, Number(e.target.value) || 0),
                        },
                      }))
                    }
                    className="w-12 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-1 py-0.5 text-right tabular-nums"
                  />
                </label>
              </div>

              <div>
                <span className="font-medium text-amber-600 dark:text-amber-400 block mb-1">
                  Out-of-Office ({result.outOfOfficeShrinkagePct.toFixed(1)}%)
                </span>
                <label className="flex justify-between items-center mb-1">
                  <span>Annual PTO</span>
                  <input
                    type="number"
                    step={0.5}
                    min={0}
                    value={config.outOfOfficeBreakdown.annualLeavePct}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        outOfOfficeBreakdown: {
                          ...c.outOfOfficeBreakdown,
                          annualLeavePct: Math.max(0, Number(e.target.value) || 0),
                        },
                      }))
                    }
                    className="w-12 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-1 py-0.5 text-right tabular-nums"
                  />
                </label>
                <label className="flex justify-between items-center mb-1">
                  <span>Sick Leave</span>
                  <input
                    type="number"
                    step={0.5}
                    min={0}
                    value={config.outOfOfficeBreakdown.sickLeavePct}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        outOfOfficeBreakdown: {
                          ...c.outOfOfficeBreakdown,
                          sickLeavePct: Math.max(0, Number(e.target.value) || 0),
                        },
                      }))
                    }
                    className="w-12 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-1 py-0.5 text-right tabular-nums"
                  />
                </label>
                <label className="flex justify-between items-center mb-1">
                  <span>Public Hol</span>
                  <input
                    type="number"
                    step={0.5}
                    min={0}
                    value={config.outOfOfficeBreakdown.publicHolidaysPct}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        outOfOfficeBreakdown: {
                          ...c.outOfOfficeBreakdown,
                          publicHolidaysPct: Math.max(0, Number(e.target.value) || 0),
                        },
                      }))
                    }
                    className="w-12 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-1 py-0.5 text-right tabular-nums"
                  />
                </label>
                <label className="flex justify-between items-center">
                  <span>Unplanned</span>
                  <input
                    type="number"
                    step={0.5}
                    min={0}
                    value={config.outOfOfficeBreakdown.unplannedAbsencePct}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        outOfOfficeBreakdown: {
                          ...c.outOfOfficeBreakdown,
                          unplannedAbsencePct: Math.max(0, Number(e.target.value) || 0),
                        },
                      }))
                    }
                    className="w-12 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-1 py-0.5 text-right tabular-nums"
                  />
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* FTE Waterfall Bridge + What-If Sensitivity Matrix */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* FTE Waterfall Visual Bridge */}
        <div className="lg:col-span-6 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                <Users className="w-4 h-4 text-sky-500" />
                FTE Capacity Waterfall Bridge
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Step-by-step progression from Pure Talk Workload to Gross Headcount.
              </p>
            </div>
            <span className="text-xs font-mono px-2.5 py-1 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-semibold">
              Ceiling: {Math.ceil(result.finalGrossFte)} Agents
            </span>
          </div>

          <div className="space-y-3">
            {result.waterfall.map((step, idx) => {
              const widthPct = Math.min(100, Math.max(6, (step.fte / maxWaterfallFte) * 100));
              const isFinal = idx === result.waterfall.length - 1;
              return (
                <div key={step.id} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-800 dark:text-slate-200">
                      {idx + 1}. {step.labelEn}
                    </span>
                    <div className="flex items-center gap-2 tabular-nums">
                      {idx > 0 && (
                        <span className="text-[11px] text-amber-600 dark:text-amber-400">
                          +{step.deltaFte.toFixed(2)} FTE
                        </span>
                      )}
                      <span
                        className={`font-bold ${
                          isFinal
                            ? 'text-emerald-600 dark:text-emerald-400 text-sm'
                            : 'text-slate-900 dark:text-white'
                        }`}
                      >
                        {step.fte.toFixed(2)} FTE
                      </span>
                    </div>
                  </div>
                  <div className="w-full h-5 rounded-md bg-slate-100 dark:bg-slate-800 overflow-hidden flex items-center px-2">
                    <div
                      style={{ width: `${widthPct}%` }}
                      className={`h-3 rounded-xs transition-all ${
                        isFinal
                          ? 'bg-emerald-500'
                          : idx === 0
                            ? 'bg-indigo-500'
                            : 'bg-sky-500'
                      }`}
                    />
                  </div>
                  <div className="text-[11px] text-slate-400 font-mono">{step.formulaNote}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 2D What-If Sensitivity Matrix */}
        <div className="lg:col-span-6 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <Grid className="w-4 h-4 text-sky-500" />
              What-If Sensitivity Matrix (AHT Δ × Shrinkage Δ)
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Live Erlang C re-simulation across AHT shifts (±10s, ±20s) and Out-of-Office Shrinkage shifts (±2%, ±4%).
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-center border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                  <th className="py-2 px-2.5 text-left font-medium">AHT \ Shrinkage</th>
                  {shrinkageDeltas.map((d) => (
                    <th key={d} className="py-2 px-2 font-medium">
                      {d >= 0 ? `+${d}%` : `${d}%`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                {whatIfMatrix.map((row) => {
                  const dAht = row[0].ahtDeltaSec;
                  return (
                    <tr key={dAht}>
                      <td className="py-2.5 px-2.5 text-left font-mono font-medium bg-slate-50/70 dark:bg-slate-800/40">
                        {dAht >= 0 ? `+${dAht}s` : `${dAht}s`}{' '}
                        <span className="text-[10px] text-slate-400 block">
                          ({Math.max(30, baseGlobalAhtSec + dAht)}s AHT)
                        </span>
                      </td>
                      {row.map((cell) => {
                        const isBase = cell.ahtDeltaSec === 0 && cell.shrinkageDeltaPct === 0;
                        const delta = cell.deltaFte;
                        return (
                          <td
                            key={cell.shrinkageDeltaPct}
                            className={`py-2.5 px-2 tabular-nums border-l border-slate-100 dark:border-slate-800 ${
                              isBase
                                ? 'bg-sky-500/15 ring-1 ring-inset ring-sky-500 font-bold'
                                : delta > 3
                                  ? 'bg-rose-500/10'
                                  : delta < -3
                                    ? 'bg-emerald-500/10'
                                    : ''
                            }`}
                          >
                            <div className="font-semibold text-slate-900 dark:text-slate-100">
                              {cell.finalGrossFte.toFixed(1)}
                            </div>
                            <div
                              className={`text-[10px] ${
                                isBase
                                  ? 'text-sky-600 dark:text-sky-300'
                                  : delta > 0
                                    ? 'text-rose-600 dark:text-rose-400'
                                    : 'text-emerald-600 dark:text-emerald-400'
                              }`}
                            >
                              {isBase ? 'Baseline' : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} FTE`}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};

