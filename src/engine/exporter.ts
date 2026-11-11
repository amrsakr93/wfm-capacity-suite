import * as XLSX from 'xlsx';
import type {
  CapacityConfig,
  CapacityResult,
  DayKey,
  ErlangConfig,
  ErlangSummary,
  ForecastConfig,
  ForecastingStudioOutput,
  HistoricalPoint,
  IntervalRowInput,
  WhatIfCell,
} from './types.ts';
import { buildFutureHorizonSummary } from './forecasting.ts';
import { runErlangPlanner, solveRequiredAgents } from './erlang.ts';
import { buildIntervalInputsForGranularity, DEFAULT_30M_CURVES } from './samples.ts';

const JS_DAY_TO_KEY: DayKey[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Reliable browser download helper using Blob + anchor click.
 * Works consistently across Chrome, Edge, Firefox, and Safari in Vite ESM builds.
 */
export function downloadWorkbook(wb: XLSX.WorkBook, filename: string): void {
  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([wbout], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.style.display = 'none';
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    if (a.parentNode) a.parentNode.removeChild(a);
    URL.revokeObjectURL(url);
  }, 500);
}

export interface MultiDayScheduleItem {
  dateIso: string;
  dayKey: DayKey;
  sourceLabel: 'Historical' | 'Forecast';
  dailyVolume: number;
  summary: ErlangSummary;
}

/**
 * Builds per-interval Erlang C/A schedules across a list of days
 */
export function buildMultiDayErlangSchedules(params: {
  days: { dateIso: string; dayKey: DayKey; volume: number; sourceLabel: 'Historical' | 'Forecast' }[];
  erlangConfig: ErlangConfig;
  dayCurves: Record<DayKey, number[]>;
  byDateCurves: Record<string, number[]>;
}): MultiDayScheduleItem[] {
  const { days, erlangConfig, dayCurves, byDateCurves } = params;
  return days.map((d) => {
    const curve30 =
      byDateCurves[d.dateIso] ??
      dayCurves[d.dayKey] ??
      DEFAULT_30M_CURVES[d.dayKey] ??
      DEFAULT_30M_CURVES.Mon;
    const intervalInputs: IntervalRowInput[] = buildIntervalInputsForGranularity(
      curve30,
      erlangConfig.granularityMin
    );
    const dayCfg: ErlangConfig = {
      ...erlangConfig,
      dailyVolume: Math.max(0, Math.round(d.volume)),
      selectedDay: d.dayKey,
      selectedDateIso: d.dateIso,
    };
    const summary = runErlangPlanner(intervalInputs, dayCfg);
    return {
      dateIso: d.dateIso,
      dayKey: d.dayKey,
      sourceLabel: d.sourceLabel,
      dailyVolume: dayCfg.dailyVolume,
      summary,
    };
  });
}

/**
 * Dedicated Export for Future Forecast Horizons (Next Week Mon->Sun, Current Month, Next Month)
 */
export function exportHorizonForecastXlsx(params: {
  history: HistoricalPoint[];
  forecastConfig: ForecastConfig;
  forecastOutput: ForecastingStudioOutput;
  selectedModelId: string;
  dowShares: Record<DayKey, number>;
  dayCurves: Record<DayKey, number[]>;
  byDateCurves: Record<string, number[]>;
  erlangConfig: ErlangConfig;
  focusHorizon?: 'next_week' | 'current_month' | 'next_month' | 'all';
}): void {
  const {
    history,
    forecastConfig,
    forecastOutput,
    selectedModelId,
    dowShares,
    dayCurves,
    byDateCurves,
    erlangConfig,
    focusHorizon = 'next_week',
  } = params;

  const activeModel =
    forecastOutput.models.find((m) => m.modelId === selectedModelId) ??
    forecastOutput.models.find((m) => m.isBest) ??
    forecastOutput.models[0];

  const futureSummary = buildFutureHorizonSummary(
    history,
    activeModel,
    forecastConfig.periodicity,
    dowShares
  );

  const wb = XLSX.utils.book_new();

  // Compute Erlang staffing for Next Week (7 Days Mon -> Sun)
  const nextWeekSchedules = buildMultiDayErlangSchedules({
    days: futureSummary.nextWeekDays.map((d) => ({
      dateIso: d.dateIso,
      dayKey: d.dayKey,
      volume: d.volume,
      sourceLabel: 'Forecast' as const,
    })),
    erlangConfig,
    dayCurves,
    byDateCurves,
  });

  // Sheet 1: Next Week Forecast Summary & 7-Day Intervals (Mon -> Sun)
  const nextWeekSummaryHeader = [
    'Date (ISO)',
    'Day of Week (Mon→Sun)',
    'Projected Call Volume',
    'Share of Weekly Volume %',
    'Pure Talk Hours',
    'Req Productive Hours (=Agents)',
    'Req Productive Hours (=FractionalAgents)',
    'Peak Interval Time',
    'Peak Integer Agents',
    'Weighted Expected SLA %',
    'Weighted Expected ASA (s)',
    'Avg Occupancy %',
  ];

  const nextWeekSummaryRows = nextWeekSchedules.map((s) => [
    s.dateIso,
    s.dayKey,
    s.dailyVolume,
    Number(((s.dailyVolume / Math.max(1, futureSummary.nextWeekTotal)) * 100).toFixed(2)),
    Number(s.summary.totalPureTalkHours.toFixed(2)),
    Number(s.summary.totalIntegerProductiveHours.toFixed(2)),
    Number(s.summary.totalFractionalProductiveHours.toFixed(2)),
    s.summary.peakTimeLabel,
    s.summary.peakSeats,
    Number(s.summary.weightedSlPct.toFixed(2)),
    Number(s.summary.weightedAsaSec.toFixed(2)),
    Number(s.summary.avgOccupancyPct.toFixed(2)),
  ]);

  const wsNextWeek = XLSX.utils.aoa_to_sheet([
    ['NEXT WEEK FORECAST & STAFFING PLAN (MONDAY → SUNDAY)', ''],
    ['Active Forecast Model', activeModel.modelId.toUpperCase()],
    ['Total Projected Weekly Calls', futureSummary.nextWeekTotal],
    ['Daily Average Calls', futureSummary.nextWeekDailyAvg],
    ['Peak Day', `${futureSummary.nextWeekPeakDay?.dayKey ?? 'Mon'} (${futureSummary.nextWeekPeakDay?.dateIso ?? ''}) — ${futureSummary.nextWeekPeakDay?.volume ?? 0} calls`],
    [],
    nextWeekSummaryHeader,
    ...nextWeekSummaryRows,
  ]);
  wsNextWeek['!cols'] = Array.from({ length: 12 }, () => ({ wch: 22 }));
  XLSX.utils.book_append_sheet(wb, wsNextWeek, '1_Next_Week_Mon_Sun');

  // Sheet 2: Next Week 7-Day Interval-by-Interval Breakdown
  const weekIntervalHeader = [
    'Date',
    'Day (Mon→Sun)',
    'Interval',
    'Arrival %',
    'Projected Calls',
    'AHT (s)',
    'Traffic (Erlangs A)',
    'Integer Agents (=Agents)',
    'Fractional Agents (=FractionalAgents)',
    'Active Required Seats',
    'Productive Hours',
    'Occupancy %',
    'Expected SLA %',
    'Expected ASA (s)',
  ];
  const weekIntervalRows: (string | number)[][] = [];
  for (const s of nextWeekSchedules) {
    for (const r of s.summary.rows) {
      weekIntervalRows.push([
        s.dateIso,
        s.dayKey,
        r.timeLabel,
        Number(r.arrivalPct.toFixed(3)),
        r.volume,
        r.ahtSec,
        Number(r.erlangs.toFixed(2)),
        r.integerSeats,
        Number(r.fractionalSeats.toFixed(2)),
        r.requiredSeats,
        Number(r.productiveHours.toFixed(2)),
        Number(r.occupancyPct.toFixed(1)),
        Number(r.slPct.toFixed(1)),
        Number(r.asaSec.toFixed(1)),
      ]);
    }
  }
  const wsWeekIntervals = XLSX.utils.aoa_to_sheet([weekIntervalHeader, ...weekIntervalRows]);
  wsWeekIntervals['!cols'] = Array.from({ length: 14 }, () => ({ wch: 18 }));
  XLSX.utils.book_append_sheet(wb, wsWeekIntervals, '2_Next_Week_Intervals');

  // Sheet 3: Current Month & Next Month (60-Day Horizon)
  const monthHeader = [
    'Day #',
    'Horizon Bucket',
    'Date (ISO)',
    'Day of Week',
    'Projected Daily Calls',
    'Hourly Calls (÷24)',
    'Erlang Integer Agents/Hr',
    'Erlang Fractional Agents/Hr',
    'Daily Req Productive Hours',
  ];
  const monthRows = futureSummary.allFutureDays.map((d, idx) => {
    const hourlyCalls = d.volume / 24;
    const hrSolved = solveRequiredAgents(hourlyCalls, erlangConfig.globalAhtSec, 3600, {
      slTargetPct: erlangConfig.slTargetPct,
      slThresholdSec: erlangConfig.slThresholdSec,
      maxAsaSec: erlangConfig.maxAsaSec,
      maxOccupancyPct: erlangConfig.maxOccupancyPct,
      enforceMaxAsa: erlangConfig.enforceMaxAsa,
      enforceOccupancyCap: erlangConfig.enforceOccupancyCap,
      agentMode: erlangConfig.agentMode ?? 'integer',
      minAgentsFloor: erlangConfig.minAgentsFloor,
      useErlangA: erlangConfig.useErlangA,
      avgPatienceSec: erlangConfig.avgPatienceSec,
    });
    return [
      idx + 1,
      idx < 30 ? 'Current Month (Days 1–30)' : 'Next Month (Days 31–60)',
      d.dateIso,
      d.dayKey,
      d.volume,
      Number(hourlyCalls.toFixed(2)),
      hrSolved.integerSeats,
      Number(hrSolved.fractionalSeats.toFixed(2)),
      Number((hrSolved.requiredSeats * 24).toFixed(2)),
    ];
  });
  const wsMonths = XLSX.utils.aoa_to_sheet([
    ['CURRENT MONTH (DAYS 1–30) & NEXT MONTH (DAYS 31–60) FORECAST', ''],
    ['Current Month Projected Total (30d)', futureSummary.currentMonthTotal],
    ['Next Month Projected Total (30d)', futureSummary.nextMonthTotal],
    [],
    monthHeader,
    ...monthRows,
  ]);
  wsMonths['!cols'] = Array.from({ length: 9 }, () => ({ wch: 22 }));
  XLSX.utils.book_append_sheet(wb, wsMonths, '3_Current_&_Next_Month');

  const suffix =
    focusHorizon === 'next_week'
      ? 'Next-Week-Mon-Sun'
      : focusHorizon === 'current_month'
        ? 'Current-Month-30d'
        : 'Future-Horizons';
  downloadWorkbook(wb, `WFM-${suffix}-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

/**
 * Dedicated Export for Tab 2 Per-Interval Erlang Staffing Schedule
 * Supports exporting a single day OR a multi-day horizon (7d, 10d, custom N days, or full period).
 */
export function exportMultiDayIntervalScheduleXlsx(params: {
  schedules: MultiDayScheduleItem[];
  scopeLabel: string;
  erlangConfig: ErlangConfig;
}): void {
  const { schedules, scopeLabel, erlangConfig } = params;
  const wb = XLSX.utils.book_new();

  // Sheet 1: Daily Summary across all exported days
  const summaryHeader = [
    'Date (ISO)',
    'Day of Week',
    'Source',
    'Daily Calls Offered',
    'Pure Talk Workload (Hrs)',
    'Required Prod Hours (=Agents)',
    'Required Prod Hours (=FractionalAgents)',
    'Active Prod Hours',
    'Peak Interval',
    'Peak Integer Seats',
    'Weighted Expected SLA %',
    'Weighted Expected ASA (s)',
    'Avg Occupancy %',
  ];
  const summaryRows = schedules.map((s) => [
    s.dateIso,
    s.dayKey,
    s.sourceLabel,
    s.dailyVolume,
    Number(s.summary.totalPureTalkHours.toFixed(2)),
    Number(s.summary.totalIntegerProductiveHours.toFixed(2)),
    Number(s.summary.totalFractionalProductiveHours.toFixed(2)),
    Number(s.summary.totalProductiveHours.toFixed(2)),
    s.summary.peakTimeLabel,
    s.summary.peakSeats,
    Number(s.summary.weightedSlPct.toFixed(2)),
    Number(s.summary.weightedAsaSec.toFixed(2)),
    Number(s.summary.avgOccupancyPct.toFixed(2)),
  ]);

  const wsSummary = XLSX.utils.aoa_to_sheet([
    [`PER-INTERVAL ERLANG STAFFING SUMMARY — ${scopeLabel.toUpperCase()}`, ''],
    ['Total Days Included', schedules.length],
    ['Interval Granularity', `${erlangConfig.granularityMin} min`],
    ['SLA Target', `${erlangConfig.slTargetPct}% in ${erlangConfig.slThresholdSec}s`],
    ['Global AHT (s)', erlangConfig.globalAhtSec],
    ['Agent Mode', (erlangConfig.agentMode ?? 'integer') === 'fractional' ? 'Fractional (=FractionalAgents)' : 'Integer (=Agents)'],
    [],
    summaryHeader,
    ...summaryRows,
  ]);
  wsSummary['!cols'] = Array.from({ length: 13 }, () => ({ wch: 20 }));
  XLSX.utils.book_append_sheet(wb, wsSummary, '1_Daily_Summary');

  // Sheet 2: Detailed Interval-by-Interval Schedule
  const intervalHeader = [
    'Date (ISO)',
    'Day of Week',
    'Source',
    'Interval',
    'Arrival %',
    'Calls Offered',
    'AHT (s)',
    'Traffic (Erlangs A)',
    'Integer Agents (=Agents)',
    'Fractional Agents (=FractionalAgents)',
    'Active Required Seats',
    'Occupancy %',
    'Expected SLA %',
    'Expected ASA (s)',
    'Productive Hours',
  ];
  const intervalRows: (string | number)[][] = [];
  for (const s of schedules) {
    for (const r of s.summary.rows) {
      intervalRows.push([
        s.dateIso,
        s.dayKey,
        s.sourceLabel,
        r.timeLabel,
        Number(r.arrivalPct.toFixed(3)),
        r.volume,
        r.ahtSec,
        Number(r.erlangs.toFixed(2)),
        r.integerSeats,
        Number(r.fractionalSeats.toFixed(2)),
        r.requiredSeats,
        Number(r.occupancyPct.toFixed(1)),
        Number(r.slPct.toFixed(1)),
        Number(r.asaSec.toFixed(1)),
        Number(r.productiveHours.toFixed(2)),
      ]);
    }
  }
  const wsIntervals = XLSX.utils.aoa_to_sheet([intervalHeader, ...intervalRows]);
  wsIntervals['!cols'] = Array.from({ length: 15 }, () => ({ wch: 18 }));
  XLSX.utils.book_append_sheet(wb, wsIntervals, '2_Interval_Schedule');

  const safeSlug = scopeLabel.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 32);
  downloadWorkbook(wb, `WFM-Intervals-${safeSlug}-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

/**
 * Full 7-Sheet Executive Master Workbook (Top Header "Export .xlsx" & Tab 3 "Export .xlsx")
 */
export function exportFullSuiteWorkbook(params: {
  history: HistoricalPoint[];
  forecastConfig: ForecastConfig;
  forecastOutput: ForecastingStudioOutput;
  selectedModelId: string;
  dowShares?: Record<DayKey, number>;
  dayCurves?: Record<DayKey, number[]>;
  byDateCurves?: Record<string, number[]>;
  byDateTotals?: Record<string, number>;
  erlangConfig: ErlangConfig;
  erlangSummary: ErlangSummary;
  capacityConfig: CapacityConfig;
  capacityResult: CapacityResult;
  monthlyVolume?: number;
  monthDays?: number;
  hoops?: number;
  whatIfMatrix: WhatIfCell[][];
  shrinkageDeltas: number[];
}): void {
  const {
    history,
    forecastConfig,
    forecastOutput,
    selectedModelId,
    dowShares,
    dayCurves = DEFAULT_30M_CURVES,
    byDateCurves = {},
    byDateTotals = {},
    erlangConfig,
    erlangSummary,
    capacityConfig,
    capacityResult,
    monthlyVolume = 81563,
    monthDays = 30,
    hoops = 24,
    whatIfMatrix,
    shrinkageDeltas,
  } = params;

  const wb = XLSX.utils.book_new();

  const activeModel =
    forecastOutput.models.find((m) => m.modelId === selectedModelId) ??
    forecastOutput.models.find((m) => m.isBest) ??
    forecastOutput.models[0];

  const futureSummary = buildFutureHorizonSummary(
    history,
    activeModel,
    forecastConfig.periodicity,
    dowShares
  );

  // Monthly Cap Plan Breakdown metrics
  const dailyOffered = monthlyVolume / Math.max(1, monthDays);
  const hourlyOffered = dailyOffered / Math.max(1, hoops);
  const hourlySolved = solveRequiredAgents(hourlyOffered, erlangConfig.globalAhtSec, 3600, {
    slTargetPct: erlangConfig.slTargetPct,
    slThresholdSec: erlangConfig.slThresholdSec,
    maxAsaSec: erlangConfig.maxAsaSec,
    maxOccupancyPct: erlangConfig.maxOccupancyPct,
    enforceMaxAsa: erlangConfig.enforceMaxAsa,
    enforceOccupancyCap: erlangConfig.enforceOccupancyCap,
    agentMode: erlangConfig.agentMode ?? 'integer',
    minAgentsFloor: erlangConfig.minAgentsFloor,
    useErlangA: erlangConfig.useErlangA,
    avgPatienceSec: erlangConfig.avgPatienceSec,
  });

  // =========================================================================
  // SHEET 1: EXECUTIVE SUMMARY & MONTHLY CAP PLAN BREAKDOWN
  // =========================================================================
  const summaryRows = [
    ['WFM & CAPACITY SUITE — EXECUTIVE MASTER REPORT (wfmforall.com)', ''],
    ['Generated At (UTC)', new Date().toISOString()],
    ['', ''],
    ['A. EXECUTIVE MONTHLY CAP PLAN BREAKDOWN (SPREADSHEET PARITY)', ''],
    ['1. Monthly Offered Volume', monthlyVolume],
    ['2. Operating Days / Month', monthDays],
    ['3. Daily Offered Volume (Monthly ÷ Days)', Number(dailyOffered.toFixed(2))],
    ['4. Hours of Operation / Day (HOOPS)', hoops],
    ['5. Hourly Volume (Daily ÷ HOOPS)', Number(hourlyOffered.toFixed(2))],
    ['6. SLA Target / Threshold / AHT', `${erlangConfig.slTargetPct}% in ${erlangConfig.slThresholdSec}s · ${erlangConfig.globalAhtSec}s AHT`],
    ['7. Erlang Required Agents / Hour (=Agents Integer)', hourlySolved.integerSeats],
    ['8. Erlang Required Agents / Hour (=FractionalAgents)', Number(hourlySolved.fractionalSeats.toFixed(2))],
    ['9. Active Required Productive Hours / Day', Number((hourlySolved.requiredSeats * hoops).toFixed(2))],
    ['10. Shift Architecture (Work − Break = Login)', `${capacityConfig.grossShiftHours}h − ${capacityConfig.unpaidBreakHours}h = ${capacityResult.effectivePaidShiftHours}h`],
    ['11. In-Office Shrinkage (%)', Number(capacityResult.inOfficeShrinkagePct.toFixed(2))],
    ['12. Productive Hours / Agent / Day (Login × (1 − In-Office%))', Number((capacityResult.effectivePaidShiftHours * (1 - capacityResult.inOfficeShrinkagePct / 100)).toFixed(2))],
    ['13. Required / Day (Seats after In-Office)', Number(capacityResult.dailyRequiredSeats.toFixed(2))],
    ['14. Required / Week (×7/5 Roster)', Number(capacityResult.weeklyRequiredSeatsBeforeInflex.toFixed(2))],
    ['15. Schedule Inflexibility (+%)', Number(capacityConfig.scheduleInefficiencyPct.toFixed(2))],
    ['16. Scheduled Seats (After Inflex)', Number(capacityResult.scheduledSeatsAfterInflex.toFixed(2))],
    ['17. Out-of-Office Shrinkage (%)', Number(capacityResult.outOfOfficeShrinkagePct.toFixed(2))],
    ['18. Compound Total Shrinkage (%)', Number(capacityResult.compoundTotalShrinkagePct.toFixed(2))],
    ['19. FINAL AGENTS REQUIRED (EXACT FTE)', Number(capacityResult.finalGrossFte.toFixed(2))],
    ['20. FINAL AGENTS REQUIRED (ROUNDED)', Math.round(capacityResult.finalGrossFte)],
    ['', ''],
    ['B. FORECASTING STUDIO SUMMARY', ''],
    ['Selected Forecast Model', activeModel?.modelId.toUpperCase() ?? ''],
    ['Best Auto-Detected Model', forecastOutput.bestModelId.toUpperCase()],
    ['Holdout WMAPE (%)', Number((activeModel?.holdoutMetrics.wmape ?? 0).toFixed(2))],
    ['Next Week Projected Total (Mon → Sun)', futureSummary.nextWeekTotal],
    ['Current Month Projected Total (Days 1–30)', futureSummary.currentMonthTotal],
    ['Next Month Projected Total (Days 31–60)', futureSummary.nextMonthTotal],
  ];
  const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
  wsSummary['!cols'] = [{ wch: 46 }, { wch: 36 }];
  XLSX.utils.book_append_sheet(wb, wsSummary, '1_Exec_Summary_CapPlan');

  // =========================================================================
  // SHEET 2: NEXT WEEK FORECAST (MON -> SUN) & INTERVALS
  // =========================================================================
  const nextWeekSchedules = buildMultiDayErlangSchedules({
    days: futureSummary.nextWeekDays.map((d) => ({
      dateIso: d.dateIso,
      dayKey: d.dayKey,
      volume: d.volume,
      sourceLabel: 'Forecast' as const,
    })),
    erlangConfig,
    dayCurves,
    byDateCurves,
  });

  const nwHeader = [
    'Date (ISO)',
    'Day (Mon→Sun)',
    'Projected Calls',
    'Weekly Share %',
    'Pure Talk Hrs',
    'Req Prod Hrs (=Agents)',
    'Req Prod Hrs (=FractionalAgents)',
    'Peak Slot',
    'Peak Integer Agents',
    'Expected SLA %',
    'Expected ASA (s)',
    'Avg Occupancy %',
  ];
  const nwRows = nextWeekSchedules.map((s) => [
    s.dateIso,
    s.dayKey,
    s.dailyVolume,
    Number(((s.dailyVolume / Math.max(1, futureSummary.nextWeekTotal)) * 100).toFixed(2)),
    Number(s.summary.totalPureTalkHours.toFixed(2)),
    Number(s.summary.totalIntegerProductiveHours.toFixed(2)),
    Number(s.summary.totalFractionalProductiveHours.toFixed(2)),
    s.summary.peakTimeLabel,
    s.summary.peakSeats,
    Number(s.summary.weightedSlPct.toFixed(2)),
    Number(s.summary.weightedAsaSec.toFixed(2)),
    Number(s.summary.avgOccupancyPct.toFixed(2)),
  ]);
  const wsNextWeek = XLSX.utils.aoa_to_sheet([
    ['NEXT WEEK FORECAST & ERLANG STAFFING SUMMARY (MON → SUN)', ''],
    ['Total Weekly Projected Calls', futureSummary.nextWeekTotal],
    ['Daily Average Calls', futureSummary.nextWeekDailyAvg],
    [],
    nwHeader,
    ...nwRows,
  ]);
  wsNextWeek['!cols'] = Array.from({ length: 12 }, () => ({ wch: 20 }));
  XLSX.utils.book_append_sheet(wb, wsNextWeek, '2_Next_Week_Forecast');

  // =========================================================================
  // SHEET 3: CURRENT MONTH (1-30) & NEXT MONTH (31-60) FORECAST
  // =========================================================================
  const horizonHeader = [
    'Day #',
    'Horizon Period',
    'Date (ISO)',
    'Day of Week',
    'Projected Calls',
    `Hourly Calls (÷${hoops})`,
    'Erlang Integer Agents/Hr',
    'Erlang Fractional Agents/Hr',
    'Daily Req Productive Hours',
  ];
  const horizonRows = futureSummary.allFutureDays.map((d, idx) => {
    const hrCalls = d.volume / Math.max(1, hoops);
    const solved = solveRequiredAgents(hrCalls, erlangConfig.globalAhtSec, 3600, {
      slTargetPct: erlangConfig.slTargetPct,
      slThresholdSec: erlangConfig.slThresholdSec,
      maxAsaSec: erlangConfig.maxAsaSec,
      maxOccupancyPct: erlangConfig.maxOccupancyPct,
      enforceMaxAsa: erlangConfig.enforceMaxAsa,
      enforceOccupancyCap: erlangConfig.enforceOccupancyCap,
      agentMode: erlangConfig.agentMode ?? 'integer',
      minAgentsFloor: erlangConfig.minAgentsFloor,
      useErlangA: erlangConfig.useErlangA,
      avgPatienceSec: erlangConfig.avgPatienceSec,
    });
    return [
      idx + 1,
      idx < 30 ? 'Current Month (Days 1–30)' : 'Next Month (Days 31–60)',
      d.dateIso,
      d.dayKey,
      d.volume,
      Number(hrCalls.toFixed(2)),
      solved.integerSeats,
      Number(solved.fractionalSeats.toFixed(2)),
      Number((solved.requiredSeats * hoops).toFixed(2)),
    ];
  });
  const wsHorizons = XLSX.utils.aoa_to_sheet([
    ['CURRENT MONTH (DAYS 1–30) & NEXT MONTH (DAYS 31–60) FORECAST PLAN', ''],
    ['Current Month Total (Days 1–30)', futureSummary.currentMonthTotal],
    ['Next Month Total (Days 31–60)', futureSummary.nextMonthTotal],
    [],
    horizonHeader,
    ...horizonRows,
  ]);
  wsHorizons['!cols'] = Array.from({ length: 9 }, () => ({ wch: 22 }));
  XLSX.utils.book_append_sheet(wb, wsHorizons, '3_Current_&_Next_Month');

  // =========================================================================
  // SHEET 4: ALL UPLOADED HISTORICAL DAYS + NEXT WEEK ARRIVAL PATTERNS & SLA
  // =========================================================================
  const allDaysInput: {
    dateIso: string;
    dayKey: DayKey;
    volume: number;
    sourceLabel: 'Historical' | 'Forecast';
  }[] = [];

  for (const pt of history) {
    if (!pt.isExcluded) {
      const iso = pt.date ?? pt.label;
      const parsedMs = pt.date ? Date.parse(`${pt.date}T00:00:00Z`) : NaN;
      const dk: DayKey = !Number.isNaN(parsedMs)
        ? JS_DAY_TO_KEY[new Date(parsedMs).getUTCDay()] ?? 'Mon'
        : 'Mon';
      const vol = (pt.date ? byDateTotals[pt.date] : undefined) ?? pt.volume;
      allDaysInput.push({
        dateIso: iso,
        dayKey: dk,
        volume: vol,
        sourceLabel: 'Historical',
      });
    }
  }
  for (const fd of futureSummary.nextWeekDays) {
    allDaysInput.push({
      dateIso: fd.dateIso,
      dayKey: fd.dayKey,
      volume: fd.volume,
      sourceLabel: 'Forecast',
    });
  }

  const allDaysSchedules = buildMultiDayErlangSchedules({
    days: allDaysInput,
    erlangConfig,
    dayCurves,
    byDateCurves,
  });

  const allDaysSummaryHeader = [
    'Date',
    'Day',
    'Type (Historical / Forecast)',
    'Daily Volume',
    'Pure Talk Hours',
    'Req Prod Hrs (=Agents)',
    'Req Prod Hrs (=FractionalAgents)',
    'Peak Interval',
    'Peak Integer Agents',
    'Weighted Expected SLA %',
    'Weighted Expected ASA (s)',
    'Avg Occupancy %',
  ];
  const allDaysSummaryRows = allDaysSchedules.map((s) => [
    s.dateIso,
    s.dayKey,
    s.sourceLabel,
    s.dailyVolume,
    Number(s.summary.totalPureTalkHours.toFixed(2)),
    Number(s.summary.totalIntegerProductiveHours.toFixed(2)),
    Number(s.summary.totalFractionalProductiveHours.toFixed(2)),
    s.summary.peakTimeLabel,
    s.summary.peakSeats,
    Number(s.summary.weightedSlPct.toFixed(2)),
    Number(s.summary.weightedAsaSec.toFixed(2)),
    Number(s.summary.avgOccupancyPct.toFixed(2)),
  ]);

  const allDaysIntervalHeader = [
    'Date',
    'Day',
    'Type',
    'Interval',
    'Arrival %',
    'Calls Offered',
    'AHT (s)',
    'Traffic (Erlangs A)',
    'Integer Agents (=Agents)',
    'Fractional Agents (=FractionalAgents)',
    'Occupancy %',
    'Expected SLA %',
    'Expected ASA (s)',
    'Productive Hours',
  ];
  const allDaysIntervalRows: (string | number)[][] = [];
  for (const s of allDaysSchedules) {
    for (const r of s.summary.rows) {
      allDaysIntervalRows.push([
        s.dateIso,
        s.dayKey,
        s.sourceLabel,
        r.timeLabel,
        Number(r.arrivalPct.toFixed(3)),
        r.volume,
        r.ahtSec,
        Number(r.erlangs.toFixed(2)),
        r.integerSeats,
        Number(r.fractionalSeats.toFixed(2)),
        Number(r.occupancyPct.toFixed(1)),
        Number(r.slPct.toFixed(1)),
        Number(r.asaSec.toFixed(1)),
        Number(r.productiveHours.toFixed(2)),
      ]);
    }
  }

  const wsAllDays = XLSX.utils.aoa_to_sheet([
    ['ALL UPLOADED HISTORICAL DAYS + NEXT WEEK FORECAST — ARRIVAL PATTERNS & SLA SUMMARY', ''],
    allDaysSummaryHeader,
    ...allDaysSummaryRows,
    [],
    ['DETAILED INTERVAL-BY-INTERVAL ARRIVAL PATTERN (%) & SLA MATRIX FOR ALL DAYS', ''],
    allDaysIntervalHeader,
    ...allDaysIntervalRows,
  ]);
  wsAllDays['!cols'] = Array.from({ length: 14 }, () => ({ wch: 18 }));
  XLSX.utils.book_append_sheet(wb, wsAllDays, '4_All_Days_Arrival_&_SLA');

  // =========================================================================
  // SHEET 5: ALL 12 CONRAD CARLBERG FORECASTING MODELS LEADERBOARD
  // =========================================================================
  const modelHeader = [
    'Model ID',
    'Winner',
    'Holdout WMAPE %',
    'Holdout MAPE %',
    'Holdout RMSE',
    'Holdout MAE/MAD',
    'Forecast Bias %',
    'Train RMSE',
    'R²',
    'Parameters',
    ...Array.from({ length: forecastConfig.horizon }, (_, i) => `Forecast +${i + 1}`),
  ];
  const modelRows = forecastOutput.models.map((m) => [
    m.modelId.toUpperCase(),
    m.isBest ? 'BEST' : '',
    Number(m.holdoutMetrics.wmape.toFixed(2)),
    Number(m.holdoutMetrics.mape.toFixed(2)),
    Number(m.holdoutMetrics.rmse.toFixed(2)),
    Number(m.holdoutMetrics.mae.toFixed(2)),
    Number(m.holdoutMetrics.bias.toFixed(2)),
    Number(m.trainMetrics.rmse.toFixed(2)),
    m.r2 != null ? Number(m.r2.toFixed(4)) : '',
    JSON.stringify(m.params),
    ...m.futureForecast.map((v) => Math.round(v)),
  ]);
  const wsModels = XLSX.utils.aoa_to_sheet([
    modelHeader,
    ...modelRows,
    [],
    ['Historical Period', 'Raw Volume', 'Outlier Flag', 'Cleaned Volume'],
    ...history.map((h) => [
      h.label,
      h.volume,
      h.isExcluded ? 'EXCLUDED' : h.isSmoothed ? 'SMOOTHED' : 'CLEAN',
      h.isExcluded ? '' : h.isSmoothed ? (h.smoothedVolume ?? h.volume) : h.volume,
    ]),
  ]);
  XLSX.utils.book_append_sheet(wb, wsModels, '5_12_Carlberg_Models');

  // =========================================================================
  // SHEET 6: ACTIVE TAB 2 INTERVAL STAFFING SCHEDULE
  // =========================================================================
  const intervalHeader = [
    'Interval',
    'Status',
    'Arrival %',
    'Volume',
    'AHT (s)',
    'Traffic (Erlangs)',
    'Integer Agents (=Agents)',
    'Fractional Agents (=FractionalAgents)',
    'Active Required Seats',
    'Productive Hours',
    'Occupancy %',
    'Expected ASA (s)',
    'Expected SLA %',
    'Prob Wait %',
    'Abandon % (Erlang A)',
  ];
  const intervalRows = erlangSummary.rows.map((r) => [
    r.timeLabel,
    r.isOpen ? 'OPEN' : 'CLOSED',
    Number(r.arrivalPct.toFixed(3)),
    r.volume,
    r.ahtSec,
    Number(r.erlangs.toFixed(2)),
    r.integerSeats,
    Number(r.fractionalSeats.toFixed(2)),
    r.requiredSeats,
    Number(r.productiveHours.toFixed(2)),
    Number(r.occupancyPct.toFixed(1)),
    Number(r.asaSec.toFixed(1)),
    Number(r.slPct.toFixed(1)),
    Number(r.probWaitPct.toFixed(1)),
    r.abandonPct != null ? Number(r.abandonPct.toFixed(2)) : 'N/A',
  ]);
  const wsIntervals = XLSX.utils.aoa_to_sheet([intervalHeader, ...intervalRows]);
  wsIntervals['!cols'] = Array.from({ length: 15 }, () => ({ wch: 18 }));
  XLSX.utils.book_append_sheet(wb, wsIntervals, '6_Active_Interval_Plan');

  // =========================================================================
  // SHEET 7: FTE WATERFALL & WHAT-IF SENSITIVITY MATRIX
  // =========================================================================
  const wfHeader = [
    'Waterfall Stage',
    'Workload Hours',
    'FTE Equivalent',
    'Incremental Delta FTE',
    'Formula Note',
  ];
  const wfRows = capacityResult.waterfall.map((w) => [
    w.labelEn,
    Number(w.hours.toFixed(2)),
    Number(w.fte.toFixed(2)),
    Number(w.deltaFte.toFixed(2)),
    w.formulaNote,
  ]);
  const matrixHeader = [
    'AHT Delta \\ Shrinkage Delta',
    ...shrinkageDeltas.map((d) => `${d >= 0 ? '+' : ''}${d}% Shrinkage`),
  ];
  const matrixRows = whatIfMatrix.map((row) => [
    `${row[0].ahtDeltaSec >= 0 ? '+' : ''}${row[0].ahtDeltaSec}s (${row[0].effectiveAhtSec}s)`,
    ...row.map(
      (cell) =>
        `${cell.finalGrossFte.toFixed(1)} FTE (${cell.deltaFte >= 0 ? '+' : ''}${cell.deltaFte.toFixed(1)})`
    ),
  ]);

  const wsCapacity = XLSX.utils.aoa_to_sheet([
    wfHeader,
    ...wfRows,
    [],
    ['WHAT-IF SENSITIVITY MATRIX (FINAL GROSS FTE)', ''],
    matrixHeader,
    ...matrixRows,
  ]);
  wsCapacity['!cols'] = [
    { wch: 34 },
    { wch: 22 },
    { wch: 22 },
    { wch: 22 },
    { wch: 24 },
    { wch: 22 },
  ];
  XLSX.utils.book_append_sheet(wb, wsCapacity, '7_Waterfall_&_WhatIf');

  downloadWorkbook(wb, `WFM-Executive-Master-Report-${new Date().toISOString().slice(0, 10)}.xlsx`);
}
