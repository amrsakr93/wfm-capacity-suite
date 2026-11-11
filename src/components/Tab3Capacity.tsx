import React from 'react';
import {
  Users,
  Layers,
  ShieldCheck,
  Grid,
  Download,
  Printer,
  Info,
} from 'lucide-react';
import type {
  CapacityConfig,
  CapacityResult,
  ErlangConfig,
  WhatIfCell,
} from '../engine/types.ts';
import { solveRequiredAgents } from '../engine/erlang.ts';
import { SmartNumberInput } from './SmartNumberInput.tsx';
import { CapacityWaterfallIcon, AgentPrecisionIcon, ProMaxIconBadge } from './ProMaxIcons.tsx';

interface Props {
  config: CapacityConfig;
  setConfig: React.Dispatch<React.SetStateAction<CapacityConfig>>;
  erlangConfig: ErlangConfig;
  setErlangConfig: React.Dispatch<React.SetStateAction<ErlangConfig>>;
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
  onExportExcel: () => void;
}

export const Tab3Capacity: React.FC<Props> = ({
  config,
  setConfig,
  erlangConfig,
  setErlangConfig,
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
  onExportExcel,
}) => {
  const maxWaterfallFte = Math.max(...result.waterfall.map((w) => w.fte), 1);

  // Live Monthly Cap Plan Erlang C calculation (Spreadsheet Parity: e.g. 81,563 -> 2,719/d -> 113.28/hr -> 13/hr -> 312h/d -> 79 Agents)
  const safeDays = Math.max(1, monthDays);
  const safeHoops = Math.max(1, Math.min(24, hoops));
  const dailyOfferedFromMonth = monthlyVolume / safeDays;
  const hourlyVolFromMonth = dailyOfferedFromMonth / safeHoops;

  const liveHourlySolved = solveRequiredAgents(hourlyVolFromMonth, erlangConfig.globalAhtSec, 3600, {
    ...erlangConfig,
    enforceMaxAsa: false,
    enforceOccupancyCap: false,
  });

  const reqPerHourFromMonth =
    erlangConfig.agentMode === 'fractional'
      ? liveHourlySolved.fractionalSeats
      : liveHourlySolved.integerSeats;
  const reqHoursPerDayFromMonth = reqPerHourFromMonth * safeHoops;

  // Helper to sync Monthly Cap Plan edits immediately into CapacityConfig & ErlangConfig
  const syncMonthlyCapPlanToSuite = (
    nextMonthly: number,
    nextDays: number,
    nextHoops: number,
    nextErlang: ErlangConfig
  ) => {
    const dOff = nextMonthly / Math.max(1, nextDays);
    const hOff = dOff / Math.max(1, Math.min(24, nextHoops));
    const solved = solveRequiredAgents(hOff, nextErlang.globalAhtSec, 3600, {
      ...nextErlang,
      enforceMaxAsa: false,
      enforceOccupancyCap: false,
    });
    const reqHr =
      nextErlang.agentMode === 'fractional' ? solved.fractionalSeats : solved.integerSeats;
    const prodHrsDay = reqHr * Math.max(1, Math.min(24, nextHoops));
    const pureTalkDay = (dOff * nextErlang.globalAhtSec) / 3600;

    setConfig((c) => ({
      ...c,
      route: 'erlang_c',
      erlangProductiveHoursPerDay: Number(prodHrsDay.toFixed(2)),
      pureTalkHoursPerDay: Number(pureTalkDay.toFixed(2)),
    }));
  };

  // Scale In-Office or Out-of-Office Shrinkage breakdown when edited directly in the Cap Plan row
  const setDirectInOfficeShrinkage = (targetPct: number) => {
    const clamped = Math.max(0, Math.min(80, targetPct));
    setConfig((c) => {
      const curSum =
        c.inOfficeBreakdown.trainingCoachingPct +
        c.inOfficeBreakdown.meetingsHuddlesPct +
        c.inOfficeBreakdown.systemDowntimePct +
        c.inOfficeBreakdown.paidBreaksPct;
      if (curSum <= 1e-6) {
        return {
          ...c,
          inOfficeBreakdown: {
            trainingCoachingPct: Number((clamped * 0.5).toFixed(2)),
            meetingsHuddlesPct: Number((clamped * 0.5).toFixed(2)),
            systemDowntimePct: 0,
            paidBreaksPct: 0,
          },
        };
      }
      const ratio = clamped / curSum;
      return {
        ...c,
        inOfficeBreakdown: {
          trainingCoachingPct: Number((c.inOfficeBreakdown.trainingCoachingPct * ratio).toFixed(2)),
          meetingsHuddlesPct: Number((c.inOfficeBreakdown.meetingsHuddlesPct * ratio).toFixed(2)),
          systemDowntimePct: Number((c.inOfficeBreakdown.systemDowntimePct * ratio).toFixed(2)),
          paidBreaksPct: Number((c.inOfficeBreakdown.paidBreaksPct * ratio).toFixed(2)),
        },
      };
    });
  };

  const setDirectOutOfOfficeShrinkage = (targetPct: number) => {
    const clamped = Math.max(0, Math.min(80, targetPct));
    setConfig((c) => {
      const curSum =
        c.outOfOfficeBreakdown.annualLeavePct +
        c.outOfOfficeBreakdown.sickLeavePct +
        c.outOfOfficeBreakdown.publicHolidaysPct +
        c.outOfOfficeBreakdown.unplannedAbsencePct;
      if (curSum <= 1e-6) {
        return {
          ...c,
          outOfOfficeBreakdown: {
            annualLeavePct: Number((clamped * 0.5).toFixed(2)),
            sickLeavePct: Number((clamped * 0.5).toFixed(2)),
            publicHolidaysPct: 0,
            unplannedAbsencePct: 0,
          },
        };
      }
      const ratio = clamped / curSum;
      return {
        ...c,
        outOfOfficeBreakdown: {
          annualLeavePct: Number((c.outOfOfficeBreakdown.annualLeavePct * ratio).toFixed(2)),
          sickLeavePct: Number((c.outOfOfficeBreakdown.sickLeavePct * ratio).toFixed(2)),
          publicHolidaysPct: Number((c.outOfOfficeBreakdown.publicHolidaysPct * ratio).toFixed(2)),
          unplannedAbsencePct: Number((c.outOfOfficeBreakdown.unplannedAbsencePct * ratio).toFixed(2)),
        },
      };
    });
  };

  // Cap Plan Sheet derived steps from live reqHoursPerDayFromMonth
  const inOfficeProdHoursPerShift =
    result.effectivePaidShiftHours * (1 - result.inOfficeShrinkagePct / 100);
  const reqPerDayAfterInOffice =
    inOfficeProdHoursPerShift > 0 ? reqHoursPerDayFromMonth / inOfficeProdHoursPerShift : 0;
  const reqPerWeekAfterInOffice = reqPerDayAfterInOffice * result.weeklyCoverageMultiplier;
  const scheduledAfterInflexFromMonth =
    reqPerWeekAfterInOffice * (1 + config.scheduleInefficiencyPct / 100);
  const outRetention = Math.max(0.05, 1 - result.outOfOfficeShrinkagePct / 100);
  const finalCapPlanAgentsExact =
    (scheduledAfterInflexFromMonth / outRetention) * (1 + config.attritionRampBufferPct / 100);

  return (
    <div className="space-y-6 animate-slide-up">
      {/* Executive Monthly Cap Plan Step-by-Step Sheet ("التقسيمة والتنفيطة الشهرية") */}
      <div className="bento-card-promax card-elevated rounded-2xl border-2 border-emerald-500/35 bg-gradient-to-r from-emerald-500/10 via-white to-sky-500/5 dark:from-emerald-950/35 dark:via-slate-900 dark:to-sky-950/20 p-5 shadow-xs">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 pb-4 border-b border-slate-200/80 dark:border-slate-800">
          <div className="flex items-start gap-3">
            <ProMaxIconBadge tone="emerald" size="lg" pulse>
              <CapacityWaterfallIcon size={24} />
            </ProMaxIconBadge>
            <div>
              <h2 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white">
                Executive Monthly Cap Plan Breakdown (Monthly → Daily → Hourly → Final Agents Required)
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Type or paste any value directly below. Switch between{' '}
                <strong>Integer Agents (=Agents)</strong> and{' '}
                <strong>Fractional Agents (=FractionalAgents)</strong> at any time.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Agent vs Fractional Agents Toggle inside Capacity Plan */}
            <div
              role="group"
              aria-label="Capacity Plan Agent Mode"
              className="inline-flex rounded-xl border-2 border-sky-500/30 bg-slate-100 dark:bg-slate-950 p-1"
            >
              <button
                type="button"
                onClick={() => {
                  const next = { ...erlangConfig, agentMode: 'integer' as const };
                  setErlangConfig(next);
                  syncMonthlyCapPlanToSuite(monthlyVolume, monthDays, hoops, next);
                }}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                  (erlangConfig.agentMode ?? 'integer') === 'integer'
                    ? 'bg-sky-600 text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <AgentPrecisionIcon fractional={false} size={15} />
                Integer Agents (=Agents)
              </button>
              <button
                type="button"
                onClick={() => {
                  const next = { ...erlangConfig, agentMode: 'fractional' as const };
                  setErlangConfig(next);
                  syncMonthlyCapPlanToSuite(monthlyVolume, monthDays, hoops, next);
                }}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                  erlangConfig.agentMode === 'fractional'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <AgentPrecisionIcon fractional={true} size={15} />
                Fractional (=FractionalAgents)
              </button>
            </div>

            <button
              type="button"
              onClick={onExportExcel}
              className="inline-flex items-center gap-1.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white px-3.5 py-2 text-xs font-semibold shadow-xs cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              Export .xlsx
            </button>
          </div>
        </div>

        {/* 16-Cell Structured Cap Plan Grid (Live Self-Contained Recalculation) */}
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2.5 text-xs">
          <div className="rounded-xl border border-emerald-500/40 bg-white dark:bg-slate-950 p-2.5">
            <div className="text-[10px] font-bold uppercase text-emerald-600 dark:text-emerald-400">
              Monthly Offered
            </div>
            <SmartNumberInput
              min={0}
              decimals={0}
              value={monthlyVolume}
              onChange={(v) => {
                const mv = Math.max(0, v);
                setMonthlyVolume(mv);
                setErlangConfig((c) => ({
                  ...c,
                  dailyVolume: Math.round(mv / Math.max(1, monthDays)),
                }));
                syncMonthlyCapPlanToSuite(mv, monthDays, hoops, erlangConfig);
              }}
              className="mt-1 w-full rounded border border-emerald-500/40 bg-emerald-500/5 px-1.5 py-0.5 text-sm font-extrabold tabular-nums text-emerald-600 dark:text-emerald-300"
            />
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-2.5">
            <div className="text-[10px] font-bold uppercase text-slate-400">Month Days</div>
            <SmartNumberInput
              min={1}
              max={31}
              decimals={0}
              value={monthDays}
              onChange={(v) => {
                const md = Math.max(1, Math.min(31, Math.round(v)));
                setMonthDays(md);
                setErlangConfig((c) => ({
                  ...c,
                  dailyVolume: Math.round(monthlyVolume / md),
                }));
                syncMonthlyCapPlanToSuite(monthlyVolume, md, hoops, erlangConfig);
              }}
              className="mt-1 w-full rounded border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-1.5 py-0.5 text-sm font-bold tabular-nums"
            />
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/70 p-2.5">
            <div className="text-[10px] font-bold uppercase text-slate-400">Daily Offered</div>
            <div className="mt-1.5 text-sm font-extrabold tabular-nums text-slate-900 dark:text-white">
              {Math.round(dailyOfferedFromMonth).toLocaleString()}
            </div>
            <div className="text-[10px] font-mono text-slate-400">
              ({dailyOfferedFromMonth.toFixed(1)}/d)
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-2.5">
            <div className="text-[10px] font-bold uppercase text-slate-400">HOOPS (Hrs)</div>
            <SmartNumberInput
              min={1}
              max={24}
              decimals={0}
              value={hoops}
              onChange={(v) => {
                const h = Math.max(1, Math.min(24, v));
                setHoops(h);
                syncMonthlyCapPlanToSuite(monthlyVolume, monthDays, h, erlangConfig);
              }}
              className="mt-1 w-full rounded border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-1.5 py-0.5 text-sm font-bold tabular-nums"
            />
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/70 p-2.5">
            <div className="text-[10px] font-bold uppercase text-slate-400">Hourly Volume</div>
            <div className="mt-1.5 text-sm font-extrabold tabular-nums text-sky-600 dark:text-sky-400">
              {Math.round(hourlyVolFromMonth).toLocaleString()}{' '}
              <span className="text-[10px] font-normal">({hourlyVolFromMonth.toFixed(2)})</span>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-2.5">
            <div className="text-[10px] font-bold uppercase text-slate-400">SLA % / ASA / AHT</div>
            <div className="mt-1 grid grid-cols-3 gap-1">
              <SmartNumberInput
                min={1}
                max={99.9}
                decimals={0}
                value={slTargetPct}
                onChange={(v) => {
                  const next = { ...erlangConfig, slTargetPct: Math.min(99.9, Math.max(1, v)) };
                  setErlangConfig(next);
                  syncMonthlyCapPlanToSuite(monthlyVolume, monthDays, hoops, next);
                }}
                className="w-full rounded border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-1 py-0.5 text-[11px] font-bold tabular-nums text-center"
              />
              <SmartNumberInput
                min={1}
                decimals={0}
                value={slThresholdSec}
                onChange={(v) => {
                  const next = { ...erlangConfig, slThresholdSec: Math.max(1, v) };
                  setErlangConfig(next);
                  syncMonthlyCapPlanToSuite(monthlyVolume, monthDays, hoops, next);
                }}
                className="w-full rounded border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-1 py-0.5 text-[11px] font-bold tabular-nums text-center"
              />
              <SmartNumberInput
                min={1}
                decimals={0}
                value={baseGlobalAhtSec}
                onChange={(v) => {
                  const next = { ...erlangConfig, globalAhtSec: Math.max(1, v) };
                  setErlangConfig(next);
                  syncMonthlyCapPlanToSuite(monthlyVolume, monthDays, hoops, next);
                }}
                className="w-full rounded border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-1 py-0.5 text-[11px] font-bold tabular-nums text-center"
              />
            </div>
          </div>

          <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 p-2.5">
            <div className="text-[10px] font-bold uppercase text-sky-600 dark:text-sky-300">
              Required / Hr &amp; Day
            </div>
            <div className="mt-1.5 text-xs font-extrabold tabular-nums text-sky-700 dark:text-sky-200">
              {reqPerHourFromMonth.toFixed(erlangConfig.agentMode === 'fractional' ? 2 : 0)}/hr ·{' '}
              {reqHoursPerDayFromMonth.toFixed(erlangConfig.agentMode === 'fractional' ? 1 : 0)}h/d
            </div>
            <div className="text-[9px] font-mono text-sky-600/80 dark:text-sky-300/80">
              Int: {liveHourlySolved.integerSeats} · Frac: {liveHourlySolved.fractionalSeats}
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
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-2.5">
            <div className="text-[10px] font-bold uppercase text-slate-400">
              In-Office Shrinkage (%)
            </div>
            <SmartNumberInput
              min={0}
              max={80}
              decimals={1}
              value={Number(result.inOfficeShrinkagePct.toFixed(2))}
              onChange={setDirectInOfficeShrinkage}
              className="mt-1 w-full rounded border border-amber-500/40 bg-amber-500/5 px-1.5 py-0.5 text-sm font-bold tabular-nums text-amber-600 dark:text-amber-400"
            />
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/70 p-2.5">
            <div className="text-[10px] font-bold uppercase text-slate-400">
              Productive Hrs / Agent
            </div>
            <div className="mt-1.5 text-sm font-extrabold tabular-nums text-slate-900 dark:text-white">
              {inOfficeProdHoursPerShift.toFixed(2)} hrs
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/70 p-2.5">
            <div className="text-[10px] font-bold uppercase text-slate-400">
              Required / Day (Seats)
            </div>
            <div className="mt-1.5 text-sm font-extrabold tabular-nums text-slate-900 dark:text-white">
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
            <div className="mt-1.5 text-sm font-extrabold tabular-nums text-slate-900 dark:text-white">
              {Math.round(reqPerWeekAfterInOffice)}{' '}
              <span className="text-[10px] font-normal text-slate-400">
                ({reqPerWeekAfterInOffice.toFixed(2)})
              </span>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-2.5">
            <div className="text-[10px] font-bold uppercase text-slate-400">
              Schedule Inflex (+%) → #
            </div>
            <div className="mt-1 flex items-center justify-between gap-1.5">
              <SmartNumberInput
                min={0}
                max={50}
                decimals={1}
                value={config.scheduleInefficiencyPct}
                onChange={(v) =>
                  setConfig((c) => ({ ...c, scheduleInefficiencyPct: Math.max(0, v) }))
                }
                className="w-14 rounded border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-1.5 py-0.5 text-xs font-bold tabular-nums"
              />
              <span className="text-sm font-extrabold tabular-nums text-slate-900 dark:text-white">
                {Math.round(scheduledAfterInflexFromMonth)}{' '}
                <span className="text-[10px] font-normal text-slate-400">
                  ({scheduledAfterInflexFromMonth.toFixed(1)})
                </span>
              </span>
            </div>
          </div>

          <div className="rounded-xl border-2 border-emerald-500 bg-emerald-500/15 p-2.5">
            <div className="flex items-center justify-between text-[10px] font-bold uppercase text-emerald-700 dark:text-emerald-300">
              <span>Agents Required [A]</span>
              <span className="inline-flex items-center gap-1">
                Out%:
                <SmartNumberInput
                  min={0}
                  max={80}
                  decimals={1}
                  value={Number(result.outOfOfficeShrinkagePct.toFixed(1))}
                  onChange={setDirectOutOfOfficeShrinkage}
                  className="w-11 rounded border border-emerald-500/40 bg-white/80 dark:bg-slate-900 px-1 py-0 text-[10px] font-bold text-center"
                />
              </span>
            </div>
            <div className="mt-1 text-lg font-extrabold tabular-nums text-emerald-700 dark:text-emerald-300">
              {Math.round(finalCapPlanAgentsExact)} Agents{' '}
              <span className="text-xs font-semibold">
                ({finalCapPlanAgentsExact.toFixed(2)})
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
            {config.route === 'erlang_c' ? 'Synced with Erlang C' : 'Flat Top-Down Route'}
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
              ([{Math.round(result.finalGrossFte)}])
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
              <option value="erlang_c">Erlang C Route (Uses Productive Hours)</option>
              <option value="flat_top_down">Flat Top-Down (Pure Talk ÷ Target Occ %)</option>
            </select>

            {config.route === 'erlang_c' ? (
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">
                  Required Productive Hours / Day
                </label>
                <SmartNumberInput
                  min={0}
                  decimals={2}
                  value={Number(config.erlangProductiveHoursPerDay.toFixed(2))}
                  onChange={(v) =>
                    setConfig((c) => ({
                      ...c,
                      erlangProductiveHoursPerDay: Math.max(0, v),
                    }))
                  }
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs tabular-nums font-semibold"
                />
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">Pure Talk Hrs</label>
                  <SmartNumberInput
                    min={0}
                    decimals={2}
                    value={Number(config.pureTalkHoursPerDay.toFixed(2))}
                    onChange={(v) =>
                      setConfig((c) => ({
                        ...c,
                        pureTalkHoursPerDay: Math.max(0, v),
                      }))
                    }
                    className="w-full rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-xs tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">Target Occ %</label>
                  <SmartNumberInput
                    min={50}
                    max={98}
                    decimals={1}
                    value={config.flatTargetOccupancyPct}
                    onChange={(v) =>
                      setConfig((c) => ({
                        ...c,
                        flatTargetOccupancyPct: Math.max(50, Math.min(98, v)),
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
                  <SmartNumberInput
                    min={1}
                    max={16}
                    decimals={2}
                    value={config.grossShiftHours}
                    onChange={(v) =>
                      setConfig((c) => ({
                        ...c,
                        grossShiftHours: Math.max(1, v),
                      }))
                    }
                    className="w-full rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-xs tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">Unpaid Break (h)</label>
                  <SmartNumberInput
                    min={0}
                    max={4}
                    decimals={2}
                    value={config.unpaidBreakHours}
                    onChange={(v) =>
                      setConfig((c) => ({
                        ...c,
                        unpaidBreakHours: Math.max(0, v),
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
                <SmartNumberInput
                  min={1}
                  max={16}
                  decimals={2}
                  value={config.paidShiftHoursDirect}
                  onChange={(v) =>
                    setConfig((c) => ({
                      ...c,
                      paidShiftHoursDirect: Math.max(1, v),
                    }))
                  }
                  className="w-full rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-xs tabular-nums"
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
                <SmartNumberInput
                  min={1}
                  max={7}
                  decimals={1}
                  value={config.operatingDaysPerWeek}
                  onChange={(v) =>
                    setConfig((c) => ({
                      ...c,
                      operatingDaysPerWeek: Math.max(1, Math.min(7, v)),
                    }))
                  }
                  className="w-full rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-xs tabular-nums"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Agent Days/Wk</label>
                <SmartNumberInput
                  min={1}
                  max={7}
                  decimals={1}
                  value={config.agentWorkdaysPerWeek}
                  onChange={(v) =>
                    setConfig((c) => ({
                      ...c,
                      agentWorkdaysPerWeek: Math.max(1, Math.min(7, v)),
                    }))
                  }
                  className="w-full rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-xs tabular-nums"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Sched Inflex %</label>
                <SmartNumberInput
                  min={0}
                  max={40}
                  decimals={1}
                  value={config.scheduleInefficiencyPct}
                  onChange={(v) =>
                    setConfig((c) => ({
                      ...c,
                      scheduleInefficiencyPct: Math.max(0, v),
                    }))
                  }
                  className="w-full rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-xs tabular-nums"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Ramp Buffer %</label>
                <SmartNumberInput
                  min={0}
                  max={40}
                  decimals={1}
                  value={config.attritionRampBufferPct}
                  onChange={(v) =>
                    setConfig((c) => ({
                      ...c,
                      attritionRampBufferPct: Math.max(0, v),
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
                  <SmartNumberInput
                    min={0}
                    decimals={2}
                    value={config.inOfficeBreakdown.trainingCoachingPct}
                    onChange={(v) =>
                      setConfig((c) => ({
                        ...c,
                        inOfficeBreakdown: {
                          ...c.inOfficeBreakdown,
                          trainingCoachingPct: Math.max(0, v),
                        },
                      }))
                    }
                    className="w-12 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-1 py-0.5 text-right tabular-nums"
                  />
                </label>
                <label className="flex justify-between items-center mb-1">
                  <span>Meetings</span>
                  <SmartNumberInput
                    min={0}
                    decimals={2}
                    value={config.inOfficeBreakdown.meetingsHuddlesPct}
                    onChange={(v) =>
                      setConfig((c) => ({
                        ...c,
                        inOfficeBreakdown: {
                          ...c.inOfficeBreakdown,
                          meetingsHuddlesPct: Math.max(0, v),
                        },
                      }))
                    }
                    className="w-12 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-1 py-0.5 text-right tabular-nums"
                  />
                </label>
                <label className="flex justify-between items-center mb-1">
                  <span>Sys Downtime</span>
                  <SmartNumberInput
                    min={0}
                    decimals={2}
                    value={config.inOfficeBreakdown.systemDowntimePct}
                    onChange={(v) =>
                      setConfig((c) => ({
                        ...c,
                        inOfficeBreakdown: {
                          ...c.inOfficeBreakdown,
                          systemDowntimePct: Math.max(0, v),
                        },
                      }))
                    }
                    className="w-12 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-1 py-0.5 text-right tabular-nums"
                  />
                </label>
                <label className="flex justify-between items-center">
                  <span>Paid Breaks</span>
                  <SmartNumberInput
                    min={0}
                    decimals={2}
                    value={config.inOfficeBreakdown.paidBreaksPct}
                    onChange={(v) =>
                      setConfig((c) => ({
                        ...c,
                        inOfficeBreakdown: {
                          ...c.inOfficeBreakdown,
                          paidBreaksPct: Math.max(0, v),
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
                  <SmartNumberInput
                    min={0}
                    decimals={2}
                    value={config.outOfOfficeBreakdown.annualLeavePct}
                    onChange={(v) =>
                      setConfig((c) => ({
                        ...c,
                        outOfOfficeBreakdown: {
                          ...c.outOfOfficeBreakdown,
                          annualLeavePct: Math.max(0, v),
                        },
                      }))
                    }
                    className="w-12 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-1 py-0.5 text-right tabular-nums"
                  />
                </label>
                <label className="flex justify-between items-center mb-1">
                  <span>Sick Leave</span>
                  <SmartNumberInput
                    min={0}
                    decimals={2}
                    value={config.outOfOfficeBreakdown.sickLeavePct}
                    onChange={(v) =>
                      setConfig((c) => ({
                        ...c,
                        outOfOfficeBreakdown: {
                          ...c.outOfOfficeBreakdown,
                          sickLeavePct: Math.max(0, v),
                        },
                      }))
                    }
                    className="w-12 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-1 py-0.5 text-right tabular-nums"
                  />
                </label>
                <label className="flex justify-between items-center mb-1">
                  <span>Public Hol</span>
                  <SmartNumberInput
                    min={0}
                    decimals={2}
                    value={config.outOfOfficeBreakdown.publicHolidaysPct}
                    onChange={(v) =>
                      setConfig((c) => ({
                        ...c,
                        outOfOfficeBreakdown: {
                          ...c.outOfOfficeBreakdown,
                          publicHolidaysPct: Math.max(0, v),
                        },
                      }))
                    }
                    className="w-12 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-1 py-0.5 text-right tabular-nums"
                  />
                </label>
                <label className="flex justify-between items-center">
                  <span>Unplanned</span>
                  <SmartNumberInput
                    min={0}
                    decimals={2}
                    value={config.outOfOfficeBreakdown.unplannedAbsencePct}
                    onChange={(v) =>
                      setConfig((c) => ({
                        ...c,
                        outOfOfficeBreakdown: {
                          ...c.outOfOfficeBreakdown,
                          unplannedAbsencePct: Math.max(0, v),
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
              Final: {Math.round(result.finalGrossFte)} Agents ({result.finalGrossFte.toFixed(1)})
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
