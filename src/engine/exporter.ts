import type ExcelJS from 'exceljs';
import type {
  CapacityConfig,
  CapacityResult,
  DayKey,
  ErlangConfig,
  ErlangSummary,
  ForecastConfig,
  ForecastingStudioOutput,
  FutureHorizonSummary,
  HistoricalPoint,
  IntervalRowInput,
  ScheduleGenerationResult,
  SchedulingRules,
  ShiftTemplate,
  WhatIfCell,
} from './types.ts';
import { buildFutureHorizonSummary, FORECAST_MODEL_NAMES } from './forecasting.ts';
import { runErlangPlanner, solveRequiredAgents } from './erlang.ts';
import { EXCEPTION_META, WEEK_DAYS } from './scheduling.ts';
import {
  buildDateSpecificCurve,
  buildIntervalInputsForGranularity,
  DEFAULT_30M_CURVES,
} from './samples.ts';
import {
  CNX,
  EXCEL_FONT,
  addDataBar,
  buildExecutiveBanner,
  embedPngChart,
  loadExcelJS,
  paintDashboardBackdrop,
  renderKpiCards,
  renderSectionHeading,
  renderStyledTable,
  stylePillCell,
  type PillTone,
  type TableColumnSpec,
} from './exportStyles.ts';
import {
  renderColumnDashboardChartPng,
  renderHorizontalBarChartPng,
  renderSplitHorizonLineChartPng,
} from './exportCharts.ts';

const JS_DAY_TO_KEY: DayKey[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Reliable browser download helper using ArrayBuffer + Blob + anchor click.
 */
export async function downloadWorkbook(wb: ExcelJS.Workbook, filename: string): Promise<void> {
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
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
      (d.sourceLabel === 'Historical'
        ? buildDateSpecificCurve(d.dateIso, d.dayKey, dayCurves)
        : dayCurves[d.dayKey]) ??
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

function createBrandedWorkbook(ExcelJSClass: typeof ExcelJS, title: string): ExcelJS.Workbook {
  const wb = new ExcelJSClass.Workbook();
  wb.creator = 'WFM & Capacity Suite (wfmforall.com)';
  wb.company = 'wfmforall.com';
  wb.created = new Date();
  wb.title = title;
  return wb;
}

function slaTone(slPct: number, targetPct: number): PillTone {
  if (slPct >= targetPct) return 'good';
  if (slPct >= targetPct - 5) return 'warn';
  return 'bad';
}

function solveHourlyAgents(hourlyCalls: number, erlangConfig: ErlangConfig) {
  return solveRequiredAgents(hourlyCalls, erlangConfig.globalAhtSec, 3600, {
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
}

function modelDisplayName(modelId: string): string {
  return FORECAST_MODEL_NAMES[modelId as keyof typeof FORECAST_MODEL_NAMES] ?? modelId.toUpperCase();
}

/**
 * Shared styled Next Week (Mon->Sun) forecast dashboard worksheet builder
 */
function appendNextWeekSheet(opts: {
  wb: ExcelJS.Workbook;
  sheetName: string;
  nextWeekSchedules: MultiDayScheduleItem[];
  futureSummary: FutureHorizonSummary;
  activeModelId: string;
  erlangConfig: ErlangConfig;
  isDashboardLead?: boolean;
}): void {
  const { wb, sheetName, nextWeekSchedules, futureSummary, activeModelId, erlangConfig, isDashboardLead } = opts;
  const colCount = 12;
  const ws = wb.addWorksheet(sheetName, {
    properties: { tabColor: { argb: CNX.BLUE_PRIMARY } },
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  buildExecutiveBanner({
    ws,
    colCount,
    title: 'NEXT WEEK FORECAST & ERLANG STAFFING DASHBOARD (MON → SUN)',
    subtitle: `Model: ${modelDisplayName(activeModelId)} · SLA Target: ${erlangConfig.slTargetPct}% in ${erlangConfig.slThresholdSec}s · ${erlangConfig.granularityMin}m Intervals`,
    badgeText: `wfmforall.com\n${stamp}`,
  });

  ws.getRow(4).height = 10;

  const avgSla =
    nextWeekSchedules.reduce((s, d) => s + d.summary.weightedSlPct, 0) /
    Math.max(1, nextWeekSchedules.length);
  const peakDay = futureSummary.nextWeekPeakDay;

  renderKpiCards(ws, 5, [
    {
      colStart: 1,
      colSpan: 3,
      label: 'Total Projected Weekly Calls',
      value: futureSummary.nextWeekTotal,
      numFmt: '#,##0',
      sublabel: '7-day forecast sum (Mon → Sun)',
      accentArgb: CNX.BLUE_PRIMARY,
    },
    {
      colStart: 4,
      colSpan: 3,
      label: 'Daily Average Calls',
      value: futureSummary.nextWeekDailyAvg,
      numFmt: '#,##0',
      sublabel: `Across 7 operating days · Model: ${activeModelId.toUpperCase()}`,
      accentArgb: CNX.NAVY_BRAND,
    },
    {
      colStart: 7,
      colSpan: 3,
      label: 'Peak Forecast Day',
      value: peakDay ? `${peakDay.dayKey} · ${peakDay.volume.toLocaleString('en-US')}` : 'N/A',
      sublabel: peakDay ? `Date: ${peakDay.dateIso}` : '',
      accentArgb: CNX.TEAL_ACCENT,
      valueArgb: CNX.TEAL_DARK,
    },
    {
      colStart: 10,
      colSpan: 3,
      label: 'Weekly Avg Expected SLA',
      value: avgSla,
      numFmt: '0.0"%"',
      sublabel: `Target ${erlangConfig.slTargetPct}% in ${erlangConfig.slThresholdSec}s (${erlangConfig.globalAhtSec}s AHT)`,
      accentArgb: avgSla >= erlangConfig.slTargetPct ? CNX.TEAL_ACCENT : CNX.NAVY_BRAND,
      valueArgb: avgSla >= erlangConfig.slTargetPct ? CNX.GREEN_FG : CNX.AMBER_FG,
    },
  ]);

  ws.getRow(8).height = 10;

  const chartPng = renderColumnDashboardChartPng({
    title: 'Next Week Daily Call Volume Forecast (Mon → Sun)',
    subtitle: `Model: ${modelDisplayName(activeModelId)} — Peak day highlighted in teal`,
    primaryLabel: 'Projected Calls',
    highlightLabel: 'Peak Day',
    width: 980,
    height: 260,
    bars: nextWeekSchedules.map((s) => ({
      label: `${s.dayKey} (${s.dateIso.slice(5)})`,
      value: s.dailyVolume,
      highlight: peakDay?.dateIso === s.dateIso,
    })),
  });

  let nextRow = 9;
  if (chartPng) {
    for (let r = 9; r <= 22; r++) ws.getRow(r).height = 20;
    embedPngChart(wb, ws, chartPng, 0.2, 8.2, 980, 260);
    nextRow = 23;
  }

  nextRow = renderSectionHeading(
    ws,
    nextRow,
    1,
    colCount,
    'DAILY FORECAST & ERLANG STAFFING BREAKDOWN (MONDAY → SUNDAY)',
    CNX.NAVY_BRAND
  );

  const columns: TableColumnSpec[] = [
    { header: 'Date (ISO)', align: 'center', minWidth: 14, summaryFn: 'label', summaryLabel: 'WEEKLY TOTAL / AVG' },
    { header: 'Day (Mon→Sun)', align: 'center', minWidth: 15, summaryFn: 'blank' },
    { header: 'Projected Calls', align: 'right', numFmt: '#,##0', minWidth: 16, summaryFn: 'sum' },
    { header: 'Weekly Share %', align: 'right', numFmt: '0.00"%"', minWidth: 16, summaryFn: 'sum' },
    { header: 'Pure Talk Hrs', align: 'right', numFmt: '#,##0.00', minWidth: 15, summaryFn: 'sum' },
    { header: 'Req Prod Hrs (=Agents)', align: 'right', numFmt: '#,##0.00', minWidth: 21, summaryFn: 'sum' },
    { header: 'Req Prod Hrs (=Frac)', align: 'right', numFmt: '#,##0.00', minWidth: 20, summaryFn: 'sum' },
    { header: 'Peak Interval', align: 'center', minWidth: 15, summaryFn: 'blank' },
    { header: 'Peak Seats', align: 'right', numFmt: '#,##0', minWidth: 13, summaryFn: 'average' },
    { header: 'Expected SLA %', align: 'right', numFmt: '0.0"%"', minWidth: 16, summaryFn: 'average' },
    { header: 'Expected ASA (s)', align: 'right', numFmt: '0.0', minWidth: 16, summaryFn: 'average' },
    { header: 'Avg Occupancy %', align: 'right', numFmt: '0.0"%"', minWidth: 17, summaryFn: 'average' },
  ];

  const tableRows = nextWeekSchedules.map((s) => [
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

  const tbl = renderStyledTable({
    ws,
    startRow: nextRow,
    columns,
    rows: tableRows,
    includeTotalsRow: true,
    freezeHeader: !isDashboardLead,
    showGridLines: false,
    onCell: (cell, val, rowVals, _rIdx, cIdx) => {
      if (cIdx === 1) {
        const isPeak = peakDay && String(rowVals[0]) === peakDay.dateIso;
        stylePillCell(cell, isPeak ? 'teal' : 'info');
      }
      if (cIdx === 9 && typeof val === 'number') {
        stylePillCell(cell, slaTone(val, erlangConfig.slTargetPct));
      }
    },
  });

  addDataBar(ws, 3, tbl.firstDataRow, tbl.lastDataRow, CNX.BLUE_PRIMARY);
  addDataBar(ws, 6, tbl.firstDataRow, tbl.lastDataRow, CNX.TEAL_ACCENT);
  paintDashboardBackdrop(ws, tbl.endRow + 2, colCount);
}

/**
 * Shared styled Current Month (1-30) & Next Month (31-60) worksheet builder
 */
function appendMonthsHorizonSheet(opts: {
  wb: ExcelJS.Workbook;
  sheetName: string;
  futureSummary: FutureHorizonSummary;
  erlangConfig: ErlangConfig;
  hoops: number;
}): void {
  const { wb, sheetName, futureSummary, erlangConfig, hoops } = opts;
  const colCount = 9;
  const ws = wb.addWorksheet(sheetName, {
    properties: { tabColor: { argb: CNX.NAVY_BRAND } },
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  buildExecutiveBanner({
    ws,
    colCount,
    title: 'CURRENT MONTH (DAYS 1–30) & NEXT MONTH (DAYS 31–60) FORECAST PLAN',
    subtitle: `60-Day Daily Call & Hourly Erlang Headcount Projection · ${hoops}h Operating Window`,
    badgeText: '60-Day Horizon\nwfmforall.com',
  });
  ws.getRow(4).height = 10;

  const delta = futureSummary.nextMonthTotal - futureSummary.currentMonthTotal;
  const deltaPct =
    futureSummary.currentMonthTotal > 0 ? (delta / futureSummary.currentMonthTotal) * 100 : 0;

  renderKpiCards(ws, 5, [
    {
      colStart: 1,
      colSpan: 3,
      label: 'Current Month (Days 1–30)',
      value: futureSummary.currentMonthTotal,
      numFmt: '#,##0',
      sublabel: `Avg ${Math.round(futureSummary.currentMonthTotal / 30).toLocaleString('en-US')} calls/day`,
      accentArgb: CNX.BLUE_PRIMARY,
    },
    {
      colStart: 4,
      colSpan: 3,
      label: 'Next Month (Days 31–60)',
      value: futureSummary.nextMonthTotal,
      numFmt: '#,##0',
      sublabel: `Avg ${Math.round(futureSummary.nextMonthTotal / 30).toLocaleString('en-US')} calls/day`,
      accentArgb: CNX.TEAL_ACCENT,
      valueArgb: CNX.TEAL_DARK,
    },
    {
      colStart: 7,
      colSpan: 3,
      label: 'Month-over-Month Trajectory',
      value: `${delta >= 0 ? '+' : ''}${delta.toLocaleString('en-US')} (${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}%)`,
      sublabel: 'Next 30d variance vs Current 30d',
      accentArgb: CNX.NAVY_BRAND,
      valueArgb: Math.abs(deltaPct) < 10 ? CNX.TEAL_DARK : CNX.NAVY_BRAND,
    },
  ]);

  ws.getRow(8).height = 10;

  const linePng = renderSplitHorizonLineChartPng({
    title: '60-Day Daily Call Volume Trajectory (Current vs Next Month)',
    subtitle: 'Days 1–30 in Ocean Blue transitioning to Days 31–60 in Concentrix Teal',
    phase1Label: 'Current Month (Days 1–30)',
    phase2Label: 'Next Month (Days 31–60)',
    splitIndex: 29,
    width: 960,
    height: 250,
    points: futureSummary.allFutureDays.map((d, idx) => ({
      label: d.dateIso,
      value: d.volume,
      isSecondPhase: idx >= 30,
    })),
  });

  let nextRow = 9;
  if (linePng) {
    for (let r = 9; r <= 21; r++) ws.getRow(r).height = 20;
    embedPngChart(wb, ws, linePng, 0.2, 8.2, 960, 250);
    nextRow = 22;
  }

  nextRow = renderSectionHeading(
    ws,
    nextRow,
    1,
    colCount,
    '60-DAY DAILY HORIZON & ERLANG CAPACITY SCHEDULE',
    CNX.NAVY_BRAND
  );

  const columns: TableColumnSpec[] = [
    { header: 'Day #', align: 'center', numFmt: '0', minWidth: 10, summaryFn: 'label', summaryLabel: '60-DAY TOTAL / AVG' },
    { header: 'Horizon Bucket', align: 'center', minWidth: 25, summaryFn: 'blank' },
    { header: 'Date (ISO)', align: 'center', minWidth: 14, summaryFn: 'blank' },
    { header: 'Day', align: 'center', minWidth: 10, summaryFn: 'blank' },
    { header: 'Projected Calls', align: 'right', numFmt: '#,##0', minWidth: 17, summaryFn: 'sum' },
    { header: `Hourly Calls (÷${hoops})`, align: 'right', numFmt: '#,##0.00', minWidth: 18, summaryFn: 'average' },
    { header: 'Erlang Int Agents/Hr', align: 'right', numFmt: '#,##0', minWidth: 20, summaryFn: 'average' },
    { header: 'Erlang Frac Agents/Hr', align: 'right', numFmt: '#,##0.00', minWidth: 21, summaryFn: 'average' },
    { header: 'Daily Req Prod Hours', align: 'right', numFmt: '#,##0.00', minWidth: 21, summaryFn: 'sum' },
  ];

  const rows = futureSummary.allFutureDays.map((d, idx) => {
    const hourlyCalls = d.volume / Math.max(1, hoops);
    const hrSolved = solveHourlyAgents(hourlyCalls, erlangConfig);
    return [
      idx + 1,
      idx < 30 ? 'Current Month (Days 1–30)' : 'Next Month (Days 31–60)',
      d.dateIso,
      d.dayKey,
      d.volume,
      Number(hourlyCalls.toFixed(2)),
      hrSolved.integerSeats,
      Number(hrSolved.fractionalSeats.toFixed(2)),
      Number((hrSolved.requiredSeats * hoops).toFixed(2)),
    ];
  });

  const tbl = renderStyledTable({
    ws,
    startRow: nextRow,
    columns,
    rows,
    includeTotalsRow: true,
    freezeHeader: true,
    autoFilter: true,
    showGridLines: false,
    onCell: (cell, val, _rowVals, _rIdx, cIdx) => {
      if (cIdx === 1) {
        stylePillCell(cell, String(val).startsWith('Current') ? 'info' : 'teal', false);
      }
    },
  });

  addDataBar(ws, 5, tbl.firstDataRow, tbl.lastDataRow, CNX.BLUE_PRIMARY);
  addDataBar(ws, 9, tbl.firstDataRow, tbl.lastDataRow, CNX.TEAL_ACCENT);
  paintDashboardBackdrop(ws, nextRow - 1, colCount);
}

/**
 * Shared styled Interval-by-Interval Breakdown Sheet (used by Tab 1 & Tab 2 exports)
 */
function appendMultiDayIntervalDetailSheet(opts: {
  wb: ExcelJS.Workbook;
  sheetName: string;
  title: string;
  subtitle: string;
  schedules: MultiDayScheduleItem[];
  erlangConfig: ErlangConfig;
}): void {
  const { wb, sheetName, title, subtitle, schedules, erlangConfig } = opts;
  const colCount = 15;
  const ws = wb.addWorksheet(sheetName, {
    properties: { tabColor: { argb: CNX.TEAL_ACCENT } },
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  buildExecutiveBanner({
    ws,
    colCount,
    title,
    subtitle,
    badgeText: `${schedules.length} Day(s) · ${erlangConfig.granularityMin}m\nwfmforall.com`,
  });
  ws.getRow(4).height = 8;

  const columns: TableColumnSpec[] = [
    { header: 'Date (ISO)', align: 'center', minWidth: 13, summaryFn: 'label', summaryLabel: 'INTERVAL TOTAL / AVG' },
    { header: 'Day', align: 'center', minWidth: 9, summaryFn: 'blank' },
    { header: 'Source', align: 'center', minWidth: 12, summaryFn: 'blank' },
    { header: 'Interval', align: 'center', minWidth: 11, summaryFn: 'blank' },
    { header: 'Status', align: 'center', minWidth: 11, summaryFn: 'blank' },
    { header: 'Arrival %', align: 'right', numFmt: '0.000"%"', minWidth: 13, summaryFn: 'average' },
    { header: 'Calls Offered', align: 'right', numFmt: '#,##0', minWidth: 14, summaryFn: 'sum' },
    { header: 'AHT (s)', align: 'right', numFmt: '0', minWidth: 10, summaryFn: 'average' },
    { header: 'Erlangs (A)', align: 'right', numFmt: '0.00', minWidth: 13, summaryFn: 'average' },
    { header: 'Int Agents', align: 'right', numFmt: '#,##0', minWidth: 12, summaryFn: 'average' },
    { header: 'Frac Agents', align: 'right', numFmt: '0.00', minWidth: 13, summaryFn: 'average' },
    { header: 'Active Seats', align: 'right', numFmt: '0.00', minWidth: 13, summaryFn: 'average' },
    { header: 'Occupancy %', align: 'right', numFmt: '0.0"%"', minWidth: 14, summaryFn: 'average' },
    { header: 'Expected SLA %', align: 'right', numFmt: '0.0"%"', minWidth: 15, summaryFn: 'average' },
    { header: 'Prod Hours', align: 'right', numFmt: '#,##0.00', minWidth: 13, summaryFn: 'sum' },
  ];

  const rows: (string | number)[][] = [];
  for (const s of schedules) {
    for (const r of s.summary.rows) {
      rows.push([
        s.dateIso,
        s.dayKey,
        s.sourceLabel,
        r.timeLabel,
        r.isOpen ? 'OPEN' : 'CLOSED',
        Number(r.arrivalPct.toFixed(3)),
        r.volume,
        r.ahtSec,
        Number(r.erlangs.toFixed(2)),
        r.integerSeats,
        Number(r.fractionalSeats.toFixed(2)),
        Number(r.requiredSeats.toFixed(2)),
        Number(r.occupancyPct.toFixed(1)),
        Number(r.slPct.toFixed(1)),
        Number(r.productiveHours.toFixed(2)),
      ]);
    }
  }

  const tbl = renderStyledTable({
    ws,
    startRow: 5,
    columns,
    rows,
    includeTotalsRow: true,
    freezeHeader: true,
    autoFilter: true,
    onCell: (cell, val, rowVals, _rIdx, cIdx) => {
      if (cIdx === 2) stylePillCell(cell, val === 'Historical' ? 'info' : 'teal', false);
      if (cIdx === 4) stylePillCell(cell, val === 'OPEN' ? 'good' : 'neutral');
      if (cIdx === 13 && typeof val === 'number' && rowVals[4] === 'OPEN') {
        stylePillCell(cell, slaTone(val, erlangConfig.slTargetPct));
      }
    },
  });

  addDataBar(ws, 7, tbl.firstDataRow, tbl.lastDataRow, CNX.BLUE_PRIMARY);
  addDataBar(ws, 12, tbl.firstDataRow, tbl.lastDataRow, CNX.TEAL_ACCENT);
}

/**
 * 1) Future Forecast Horizons Workbook Builder & Exporter (Tab 1)
 */
export async function buildHorizonForecastWorkbook(params: {
  history: HistoricalPoint[];
  forecastConfig: ForecastConfig;
  forecastOutput: ForecastingStudioOutput;
  selectedModelId: string;
  dowShares: Record<DayKey, number>;
  dayCurves: Record<DayKey, number[]>;
  byDateCurves: Record<string, number[]>;
  erlangConfig: ErlangConfig;
  focusHorizon?: 'next_week' | 'current_month' | 'next_month' | 'all';
}): Promise<ExcelJS.Workbook> {
  const {
    history,
    forecastConfig,
    forecastOutput,
    selectedModelId,
    dowShares,
    dayCurves,
    byDateCurves,
    erlangConfig,
  } = params;

  const ExcelJSClass = await loadExcelJS();
  const wb = createBrandedWorkbook(ExcelJSClass, 'WFM Forecast Horizons Report');

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

  appendNextWeekSheet({
    wb,
    sheetName: '1_Next_Week_Dashboard',
    nextWeekSchedules,
    futureSummary,
    activeModelId: activeModel.modelId,
    erlangConfig,
    isDashboardLead: true,
  });

  appendMultiDayIntervalDetailSheet({
    wb,
    sheetName: '2_Next_Week_Intervals',
    title: 'NEXT WEEK 7-DAY INTERVAL SCHEDULE (MON → SUN)',
    subtitle: `Model: ${modelDisplayName(activeModel.modelId)} · Interval Granularity: ${erlangConfig.granularityMin} min`,
    schedules: nextWeekSchedules,
    erlangConfig,
  });

  appendMonthsHorizonSheet({
    wb,
    sheetName: '3_Current_&_Next_Month',
    futureSummary,
    erlangConfig,
    hoops: 24,
  });

  return wb;
}

export async function exportHorizonForecastXlsx(params: {
  history: HistoricalPoint[];
  forecastConfig: ForecastConfig;
  forecastOutput: ForecastingStudioOutput;
  selectedModelId: string;
  dowShares: Record<DayKey, number>;
  dayCurves: Record<DayKey, number[]>;
  byDateCurves: Record<string, number[]>;
  erlangConfig: ErlangConfig;
  focusHorizon?: 'next_week' | 'current_month' | 'next_month' | 'all';
}): Promise<void> {
  const wb = await buildHorizonForecastWorkbook(params);
  const focusHorizon = params.focusHorizon ?? 'next_week';
  const suffix =
    focusHorizon === 'next_week'
      ? 'Next-Week-Mon-Sun'
      : focusHorizon === 'current_month'
        ? 'Current-Month-30d'
        : 'Future-Horizons';
  await downloadWorkbook(wb, `WFM-${suffix}-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

/**
 * 2) Per-Interval Erlang Staffing Workbook Builder & Exporter (Tab 2)
 */
export async function buildMultiDayIntervalScheduleWorkbook(params: {
  schedules: MultiDayScheduleItem[];
  scopeLabel: string;
  erlangConfig: ErlangConfig;
}): Promise<ExcelJS.Workbook> {
  const { schedules, scopeLabel, erlangConfig } = params;
  const ExcelJSClass = await loadExcelJS();
  const wb = createBrandedWorkbook(ExcelJSClass, `WFM Interval Staffing — ${scopeLabel}`);

  const colCount = 13;
  const ws = wb.addWorksheet('1_Staffing_Dashboard', {
    properties: { tabColor: { argb: CNX.TEAL_ACCENT } },
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  const agentModeLabel =
    (erlangConfig.agentMode ?? 'integer') === 'fractional'
      ? 'Fractional (=FractionalAgents)'
      : 'Integer (=Agents)';

  buildExecutiveBanner({
    ws,
    colCount,
    title: `INTRADAY ERLANG STAFFING DASHBOARD — ${scopeLabel.replace(/_/g, ' ').toUpperCase()}`,
    subtitle: `${erlangConfig.granularityMin}m Intervals · SLA ${erlangConfig.slTargetPct}% in ${erlangConfig.slThresholdSec}s · ${erlangConfig.globalAhtSec}s AHT · Mode: ${agentModeLabel}`,
    badgeText: `wfmforall.com\n${schedules.length} Day(s)`,
  });
  ws.getRow(4).height = 10;

  const totalCalls = schedules.reduce((s, d) => s + d.dailyVolume, 0);
  const totalProdHrs = schedules.reduce((s, d) => s + d.summary.totalProductiveHours, 0);
  const avgSla =
    schedules.reduce((s, d) => s + d.summary.weightedSlPct, 0) / Math.max(1, schedules.length);
  const peakDay = schedules.reduce(
    (best, d) => (d.summary.peakSeats > best.summary.peakSeats ? d : best),
    schedules[0]
  );

  renderKpiCards(ws, 5, [
    {
      colStart: 1,
      colSpan: 3,
      label: 'Days in Scope',
      value: schedules.length,
      numFmt: '#,##0',
      sublabel: `${schedules[0]?.dateIso ?? ''} → ${schedules[schedules.length - 1]?.dateIso ?? ''}`,
      accentArgb: CNX.NAVY_BRAND,
    },
    {
      colStart: 4,
      colSpan: 3,
      label: 'Total Offered Calls',
      value: totalCalls,
      numFmt: '#,##0',
      sublabel: `Avg ${Math.round(totalCalls / Math.max(1, schedules.length)).toLocaleString('en-US')}/day`,
      accentArgb: CNX.BLUE_PRIMARY,
    },
    {
      colStart: 7,
      colSpan: 4,
      label: 'Active Required Prod Hours',
      value: Number(totalProdHrs.toFixed(2)),
      numFmt: '#,##0.00',
      sublabel: peakDay ? `Peak ${peakDay.summary.peakSeats} seats @ ${peakDay.summary.peakTimeLabel}` : '',
      accentArgb: CNX.TEAL_ACCENT,
      valueArgb: CNX.TEAL_DARK,
    },
    {
      colStart: 11,
      colSpan: 3,
      label: 'Weighted Avg SLA %',
      value: Number(avgSla.toFixed(1)),
      numFmt: '0.0"%"',
      sublabel: `Target ${erlangConfig.slTargetPct}% in ${erlangConfig.slThresholdSec}s`,
      accentArgb: avgSla >= erlangConfig.slTargetPct ? CNX.TEAL_ACCENT : CNX.NAVY_BRAND,
      valueArgb: avgSla >= erlangConfig.slTargetPct ? CNX.GREEN_FG : CNX.AMBER_FG,
    },
  ]);

  ws.getRow(8).height = 10;

  // Embedded intraday staffing + SLA curve chart for peak/active day
  const focusSchedule = peakDay ?? schedules[0];
  let nextRow = 9;
  if (focusSchedule && focusSchedule.summary.rows.length > 0) {
    const chartPng = renderColumnDashboardChartPng({
      title: `Intraday Required Seats vs Expected SLA % (${focusSchedule.dayKey} · ${focusSchedule.dateIso})`,
      subtitle: 'Required staffing seats per interval with Erlang Expected SLA % trajectory',
      primaryLabel: 'Required Seats',
      highlightLabel: 'Peak Seat Interval',
      secondaryLineLabel: 'Expected SLA %',
      width: 1020,
      height: 265,
      bars: focusSchedule.summary.rows.map((r) => ({
        label: r.timeLabel,
        value: r.requiredSeats,
        highlight: r.timeLabel === focusSchedule.summary.peakTimeLabel,
        secondaryValue: r.isOpen ? r.slPct : undefined,
      })),
    });
    if (chartPng) {
      for (let r = 9; r <= 22; r++) ws.getRow(r).height = 20;
      embedPngChart(wb, ws, chartPng, 0.2, 8.2, 1020, 265);
      nextRow = 23;
    }
  }

  nextRow = renderSectionHeading(
    ws,
    nextRow,
    1,
    colCount,
    'DAILY STAFFING & SERVICE LEVEL SUMMARY',
    CNX.NAVY_BRAND
  );

  const columns: TableColumnSpec[] = [
    { header: 'Date (ISO)', align: 'center', minWidth: 14, summaryFn: 'label', summaryLabel: 'HORIZON TOTAL / AVG' },
    { header: 'Day', align: 'center', minWidth: 9, summaryFn: 'blank' },
    { header: 'Source', align: 'center', minWidth: 12, summaryFn: 'blank' },
    { header: 'Daily Calls', align: 'right', numFmt: '#,##0', minWidth: 14, summaryFn: 'sum' },
    { header: 'Pure Talk Hrs', align: 'right', numFmt: '#,##0.00', minWidth: 15, summaryFn: 'sum' },
    { header: 'Req Prod Hrs (=Agents)', align: 'right', numFmt: '#,##0.00', minWidth: 20, summaryFn: 'sum' },
    { header: 'Req Prod Hrs (=Frac)', align: 'right', numFmt: '#,##0.00', minWidth: 19, summaryFn: 'sum' },
    { header: 'Active Prod Hrs', align: 'right', numFmt: '#,##0.00', minWidth: 17, summaryFn: 'sum' },
    { header: 'Peak Interval', align: 'center', minWidth: 14, summaryFn: 'blank' },
    { header: 'Peak Seats', align: 'right', numFmt: '#,##0', minWidth: 13, summaryFn: 'average' },
    { header: 'Weighted SLA %', align: 'right', numFmt: '0.0"%"', minWidth: 16, summaryFn: 'average' },
    { header: 'Weighted ASA (s)', align: 'right', numFmt: '0.0', minWidth: 16, summaryFn: 'average' },
    { header: 'Avg Occ %', align: 'right', numFmt: '0.0"%"', minWidth: 13, summaryFn: 'average' },
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

  const tbl = renderStyledTable({
    ws,
    startRow: nextRow,
    columns,
    rows: summaryRows,
    includeTotalsRow: true,
    showGridLines: false,
    onCell: (cell, val, _rowVals, _rIdx, cIdx) => {
      if (cIdx === 2) stylePillCell(cell, val === 'Historical' ? 'info' : 'teal', false);
      if (cIdx === 10 && typeof val === 'number') {
        stylePillCell(cell, slaTone(val, erlangConfig.slTargetPct));
      }
    },
  });

  addDataBar(ws, 4, tbl.firstDataRow, tbl.lastDataRow, CNX.BLUE_PRIMARY);
  addDataBar(ws, 8, tbl.firstDataRow, tbl.lastDataRow, CNX.TEAL_ACCENT);
  paintDashboardBackdrop(ws, tbl.endRow + 2, colCount);

  appendMultiDayIntervalDetailSheet({
    wb,
    sheetName: '2_Interval_Schedule',
    title: `PER-INTERVAL ERLANG SCHEDULE MATRIX (${scopeLabel.replace(/_/g, ' ')})`,
    subtitle: `${schedules.length} Day(s) × ${focusSchedule?.summary.rows.length ?? 48} Intervals · Granularity: ${erlangConfig.granularityMin}m`,
    schedules,
    erlangConfig,
  });

  return wb;
}

export async function exportMultiDayIntervalScheduleXlsx(params: {
  schedules: MultiDayScheduleItem[];
  scopeLabel: string;
  erlangConfig: ErlangConfig;
}): Promise<void> {
  const wb = await buildMultiDayIntervalScheduleWorkbook(params);
  const safeSlug = params.scopeLabel.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 32);
  await downloadWorkbook(
    wb,
    `WFM-Intervals-${safeSlug}-${new Date().toISOString().slice(0, 10)}.xlsx`
  );
}

/**
 * 3) Full 8-Sheet Executive Master Workbook Builder & Exporter (Header & Tab 3)
 */
export async function buildFullSuiteWorkbook(params: {
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
}): Promise<ExcelJS.Workbook> {
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

  const ExcelJSClass = await loadExcelJS();
  const wb = createBrandedWorkbook(ExcelJSClass, 'WFM & Capacity Suite — Executive Master Report');

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

  const dailyOffered = monthlyVolume / Math.max(1, monthDays);
  const hourlyOffered = dailyOffered / Math.max(1, hoops);
  const hourlySolved = solveHourlyAgents(hourlyOffered, erlangConfig);
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

  // =========================================================================
  // SHEET 1: EXECUTIVE MINI-DASHBOARD (HERO OVERVIEW)
  // =========================================================================
  const dashCols = 13;
  const wsDash = wb.addWorksheet('1_Executive_Dashboard', {
    properties: { tabColor: { argb: CNX.TEAL_ACCENT } },
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 },
  });

  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  buildExecutiveBanner({
    ws: wsDash,
    colCount: dashCols,
    title: 'WFM & CAPACITY SUITE — EXECUTIVE DASHBOARD',
    subtitle: `Model: ${modelDisplayName(activeModel?.modelId ?? selectedModelId)} · SLA ${erlangConfig.slTargetPct}% in ${erlangConfig.slThresholdSec}s · ${erlangConfig.globalAhtSec}s AHT · ${capacityConfig.grossShiftHours}h Shift`,
    badgeText: `wfmforall.com\n${stamp}`,
  });
  wsDash.getRow(4).height = 10;

  renderKpiCards(wsDash, 5, [
    {
      colStart: 1,
      colSpan: 2,
      label: 'Monthly Forecast',
      value: monthlyVolume,
      numFmt: '#,##0',
      sublabel: `${monthDays} operating days (${hoops}h/d)`,
      accentArgb: CNX.BLUE_PRIMARY,
    },
    {
      colStart: 3,
      colSpan: 2,
      label: 'Daily Offered Avg',
      value: Math.round(dailyOffered),
      numFmt: '#,##0',
      sublabel: `${hourlyOffered.toFixed(1)} calls/hr average`,
      accentArgb: CNX.NAVY_BRAND,
    },
    {
      colStart: 5,
      colSpan: 2,
      label: 'Model Accuracy (WMAPE)',
      value: activeModel ? Number(activeModel.holdoutMetrics.wmape.toFixed(2)) : 0,
      numFmt: '0.00"%"',
      sublabel: `Model: ${(activeModel?.modelId ?? selectedModelId).toUpperCase()}`,
      accentArgb: CNX.BLUE_PRIMARY,
    },
    {
      colStart: 8,
      colSpan: 3,
      label: 'Active Prod Hours / Day',
      value: Number(capacityConfig.erlangProductiveHoursPerDay.toFixed(1)),
      numFmt: '#,##0.0" hrs"',
      sublabel: `Compound Total Shrinkage: ${capacityResult.compoundTotalShrinkagePct.toFixed(1)}%`,
      accentArgb: CNX.NAVY_BRAND,
    },
    {
      colStart: 11,
      colSpan: 3,
      label: 'Final Gross Headcount (FTE)',
      value: `${Math.round(capacityResult.finalGrossFte)} Agents (${capacityResult.finalGrossFte.toFixed(2)})`,
      sublabel: `×${capacityResult.effectiveMultiplierOverPureTalk.toFixed(2)} multiplier over pure talk`,
      accentArgb: CNX.TEAL_ACCENT,
      valueArgb: CNX.TEAL_DARK,
    },
  ]);

  wsDash.getRow(8).height = 10;

  // Set aligned column grid so Left panel (Cols 1-6) & Right panel (Cols 8-13) match charts cleanly
  const dashColWidths = [26, 14, 13, 13, 14, 15, 4, 14, 13, 13, 14, 14, 15];
  dashColWidths.forEach((w, idx) => {
    wsDash.getColumn(idx + 1).width = w;
  });

  // Embedded Charts Side-by-Side
  const nwChartPng = renderColumnDashboardChartPng({
    title: 'Next Week Forecast Volume (Mon → Sun)',
    subtitle: `Weekly Total: ${futureSummary.nextWeekTotal.toLocaleString('en-US')} calls`,
    primaryLabel: 'Forecast Calls',
    highlightLabel: 'Peak Day',
    width: 630,
    height: 270,
    bars: nextWeekSchedules.map((s) => ({
      label: s.dayKey,
      value: s.dailyVolume,
      highlight: futureSummary.nextWeekPeakDay?.dateIso === s.dateIso,
    })),
  });
  const pureTalkFte = capacityResult.waterfall[0]?.fte ?? 0;
  const wfChartPng = renderHorizontalBarChartPng({
    title: 'FTE Capacity Waterfall Bridge',
    subtitle: `From ${pureTalkFte.toFixed(1)} Pure Talk FTE → ${capacityResult.finalGrossFte.toFixed(1)} Gross Agents`,
    width: 620,
    height: 270,
    items: capacityResult.waterfall.map((w, idx) => ({
      label: w.labelEn,
      value: w.fte,
      valueLabel: `${w.fte.toFixed(1)} FTE${w.deltaFte > 0 ? ` (+${w.deltaFte.toFixed(1)})` : ''}`,
      highlight: idx === capacityResult.waterfall.length - 1,
    })),
  });

  for (let r = 9; r <= 22; r++) wsDash.getRow(r).height = 20;
  embedPngChart(wb, wsDash, nwChartPng, 0, 8.2, 630, 270);
  embedPngChart(wb, wsDash, wfChartPng, 7, 8.2, 620, 270);

  // Bottom Left Table: Capacity Waterfall Summary (Cols 1..6)
  renderSectionHeading(wsDash, 24, 1, 6, 'FTE CAPACITY WATERFALL SUMMARY', CNX.NAVY_BRAND);
  const wfMiniTbl = renderStyledTable({
    ws: wsDash,
    startRow: 25,
    startCol: 1,
    columns: [
      { header: 'Waterfall Stage', align: 'left', minWidth: 26 },
      { header: 'Hours', align: 'right', numFmt: '#,##0.0', minWidth: 12 },
      { header: 'FTE', align: 'right', numFmt: '0.00', minWidth: 11 },
      { header: 'Delta FTE', align: 'right', numFmt: '+0.00;-0.00;0.00', minWidth: 12 },
      { header: 'Note', align: 'left', minWidth: 14 },
      { header: 'Stage Impact', align: 'center', minWidth: 14 },
    ],
    rows: capacityResult.waterfall.map((w, idx) => [
      w.labelEn,
      Number(w.hours.toFixed(1)),
      Number(w.fte.toFixed(2)),
      Number(w.deltaFte.toFixed(2)),
      w.formulaNote,
      idx === capacityResult.waterfall.length - 1 ? 'FINAL FTE' : w.deltaFte > 0 ? '+BUFFER' : 'BASE',
    ]),
    showGridLines: false,
    onCell: (cell, _val, _rowVals, rIdx, cIdx) => {
      if (cIdx === 5) {
        const isLast = rIdx === capacityResult.waterfall.length - 1;
        stylePillCell(cell, isLast ? 'teal' : rIdx === 0 ? 'info' : 'neutral');
      }
      if (rIdx === capacityResult.waterfall.length - 1 && cIdx < 5) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CNX.TEAL_TINT } };
        cell.font = { name: EXCEL_FONT, size: 9.5, bold: true, color: { argb: CNX.TEAL_DARK } };
      }
    },
  });
  addDataBar(wsDash, 3, wfMiniTbl.firstDataRow, wfMiniTbl.lastDataRow, CNX.TEAL_ACCENT);

  // Bottom Right Table: Next Week Mon->Sun Quick Snapshot (Cols 8..13)
  renderSectionHeading(wsDash, 24, 8, 13, 'NEXT WEEK STAFFING SNAPSHOT (MON → SUN)', CNX.BLUE_PRIMARY);
  const nwMiniTbl = renderStyledTable({
    ws: wsDash,
    startRow: 25,
    startCol: 8,
    columns: [
      { header: 'Date (ISO)', align: 'center', minWidth: 13 },
      { header: 'Day', align: 'center', minWidth: 9 },
      { header: 'Calls', align: 'right', numFmt: '#,##0', minWidth: 11 },
      { header: 'Prod Hrs', align: 'right', numFmt: '#,##0.0', minWidth: 12 },
      { header: 'Peak Seats', align: 'right', numFmt: '#,##0', minWidth: 12 },
      { header: 'SLA %', align: 'right', numFmt: '0.0"%"', minWidth: 12 },
    ],
    rows: nextWeekSchedules.map((s) => [
      s.dateIso,
      s.dayKey,
      s.dailyVolume,
      Number(s.summary.totalProductiveHours.toFixed(1)),
      s.summary.peakSeats,
      Number(s.summary.weightedSlPct.toFixed(1)),
    ]),
    showGridLines: false,
    onCell: (cell, val, _rowVals, _rIdx, cIdx) => {
      if (cIdx === 1) stylePillCell(cell, 'info', true);
      if (cIdx === 5 && typeof val === 'number') {
        stylePillCell(cell, slaTone(val, erlangConfig.slTargetPct));
      }
    },
  });
  addDataBar(wsDash, 10, nwMiniTbl.firstDataRow, nwMiniTbl.lastDataRow, CNX.BLUE_PRIMARY);

  // Re-enforce clean dashboard column widths & backdrop
  dashColWidths.forEach((w, idx) => {
    wsDash.getColumn(idx + 1).width = w;
  });
  paintDashboardBackdrop(wsDash, Math.max(wfMiniTbl.endRow, nwMiniTbl.endRow) + 2, dashCols);

  // =========================================================================
  // SHEET 2: MONTHLY CAP PLAN BREAKDOWN (STYLED SPREADSHEET PARITY)
  // =========================================================================
  const wsCap = wb.addWorksheet('2_Monthly_Cap_Plan', {
    properties: { tabColor: { argb: CNX.NAVY_BRAND } },
    pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 1 },
  });
  buildExecutiveBanner({
    ws: wsCap,
    colCount: 4,
    title: 'MONTHLY CAPACITY PLAN BREAKDOWN & ASSUMPTIONS',
    subtitle: 'Complete audit trail from Monthly Offered Volume to Gross Agent FTE Requirement',
    badgeText: `Final FTE: ${Math.round(capacityResult.finalGrossFte)}\n(${capacityResult.finalGrossFte.toFixed(2)})`,
  });
  wsCap.getRow(4).height = 10;

  let rCap = renderSectionHeading(wsCap, 5, 1, 4, 'A. CAPACITY WATERFALL & SHIFT PARAMETERS', CNX.NAVY_BRAND);
  const capBreakdownRows: (string | number)[][] = [
    ['1. Monthly Offered Volume', monthlyVolume, '#,##0', 'Top-line monthly contact volume'],
    ['2. Operating Days / Month', monthDays, '#,##0', 'Calendar or operating days'],
    ['3. Daily Offered Volume (Monthly ÷ Days)', Number(dailyOffered.toFixed(2)), '#,##0.00', 'Average offered calls per day'],
    ['4. Hours of Operation / Day (HOOPS)', hoops, '#,##0', 'Operating coverage hours/day'],
    ['5. Hourly Volume (Daily ÷ HOOPS)', Number(hourlyOffered.toFixed(2)), '#,##0.00', 'Mean hourly workload rate'],
    ['6. SLA Target / Threshold / AHT', `${erlangConfig.slTargetPct}% in ${erlangConfig.slThresholdSec}s · ${erlangConfig.globalAhtSec}s AHT`, '@', 'Erlang C service level contract'],
    ['7. Erlang Required Agents / Hr (=Agents Int)', hourlySolved.integerSeats, '#,##0', 'Integer Erlang XL97 ceiling'],
    ['8. Erlang Required Agents / Hr (=FracAgents)', Number(hourlySolved.fractionalSeats.toFixed(2)), '0.00', 'Continuous fractional Erlang solver'],
    ['9. Active Required Productive Hours / Day', Number((hourlySolved.requiredSeats * hoops).toFixed(2)), '#,##0.00', 'Daily productive seat hours'],
    ['10. Shift Architecture (Work − Break = Login)', `${capacityConfig.grossShiftHours}h − ${capacityConfig.unpaidBreakHours}h = ${capacityResult.effectivePaidShiftHours}h`, '@', 'Unpaid break separated cleanly'],
    ['11. In-Office Shrinkage (%)', Number(capacityResult.inOfficeShrinkagePct.toFixed(2)), '0.00"%"', 'Training, coaching, meetings, downtime'],
    ['12. Productive Hours / Agent / Day', Number((capacityResult.effectivePaidShiftHours * (1 - capacityResult.inOfficeShrinkagePct / 100)).toFixed(2)), '0.00', 'Login × (1 − In-Office Shrinkage)'],
    ['13. Required / Day (Seats after In-Office)', Number(capacityResult.dailyRequiredSeats.toFixed(2)), '0.00', 'Daily seated headcount required'],
    ['14. Required / Week (×7/5 Roster Coverage)', Number(capacityResult.weeklyRequiredSeatsBeforeInflex.toFixed(2)), '0.00', 'Scaled by operating/agent days'],
    ['15. Schedule Inflexibility (+%)', Number(capacityConfig.scheduleInefficiencyPct.toFixed(2)), '0.00"%"', 'Shift matching inefficiency buffer'],
    ['16. Scheduled Seats (After Inflex)', Number(capacityResult.scheduledSeatsAfterInflex.toFixed(2)), '0.00', 'Scheduled rostered seats needed'],
    ['17. Out-of-Office Shrinkage (%)', Number(capacityResult.outOfOfficeShrinkagePct.toFixed(2)), '0.00"%"', 'Annual leave, sick, public hols, attrition'],
    ['18. Compound Total Shrinkage (%)', Number(capacityResult.compoundTotalShrinkagePct.toFixed(2)), '0.00"%"', 'Combined multiplicative shrinkage'],
    ['19. FINAL AGENTS REQUIRED (EXACT FTE)', Number(capacityResult.finalGrossFte.toFixed(2)), '#,##0.00', 'Total gross rostered FTE'],
    ['20. FINAL AGENTS REQUIRED (ROUNDED)', Math.round(capacityResult.finalGrossFte), '#,##0', 'Rounded hiring headcount target'],
  ];

  const capTbl = renderStyledTable({
    ws: wsCap,
    startRow: rCap,
    columns: [
      { header: 'Capacity Plan Line Item', align: 'left', minWidth: 44 },
      { header: 'Value', align: 'right', minWidth: 26 },
      { header: 'Display Unit / Format', align: 'center', minWidth: 16 },
      { header: 'Modeling Note', align: 'left', minWidth: 34 },
    ],
    rows: capBreakdownRows.map(([k, v, _fmt, note]) => [k, v, typeof v === 'number' ? 'Numeric' : 'Text', note]),
    showGridLines: false,
    onCell: (cell, _val, rowVals, rIdx, cIdx) => {
      if (cIdx === 1 && typeof rowVals[1] === 'number') {
        cell.numFmt = String(capBreakdownRows[rIdx][2]);
        cell.font = { name: EXCEL_FONT, size: 10, bold: true, color: { argb: rIdx >= 18 ? CNX.TEAL_DARK : CNX.BLUE_PRIMARY } };
      }
      if (cIdx === 2) {
        stylePillCell(cell, rIdx >= 18 ? 'teal' : 'neutral', false);
      }
      if (rIdx >= 18 && cIdx <= 3 && cIdx !== 2) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CNX.TEAL_TINT } };
        cell.font = { name: EXCEL_FONT, size: 10, bold: true, color: { argb: CNX.TEAL_DARK } };
      }
    },
  });

  const rFcstSec = renderSectionHeading(
    wsCap,
    capTbl.endRow + 1,
    1,
    4,
    'B. FORECASTING STUDIO EXECUTIVE SUMMARY',
    CNX.BLUE_PRIMARY
  );
  const fcstTbl = renderStyledTable({
    ws: wsCap,
    startRow: rFcstSec,
    columns: [
      { header: 'Forecast Metric', align: 'left', minWidth: 44 },
      { header: 'Value', align: 'right', minWidth: 26 },
      { header: 'Basis', align: 'center', minWidth: 16 },
      { header: 'Horizon Context', align: 'left', minWidth: 34 },
    ],
    rows: [
      ['Selected Forecast Model', activeModel?.modelId.toUpperCase() ?? '', 'Active', 'Currently selected in Studio'],
      ['Best Auto-Detected Model', forecastOutput.bestModelId.toUpperCase(), 'Winner', 'Lowest holdout WMAPE %'],
      ['Holdout WMAPE (%)', Number((activeModel?.holdoutMetrics.wmape ?? 0).toFixed(2)), 'Holdout 20%', 'Weighted mean absolute % error'],
      ['Next Week Projected Total (Mon → Sun)', futureSummary.nextWeekTotal, '7 Days', 'Disaggregated via DOW shares'],
      ['Current Month Projected Total (Days 1–30)', futureSummary.currentMonthTotal, '30 Days', 'First 30 future days sum'],
      ['Next Month Projected Total (Days 31–60)', futureSummary.nextMonthTotal, '30 Days', 'Days 31–60 forecast sum'],
    ],
    showGridLines: false,
    onCell: (cell, val, _rowVals, rIdx, cIdx) => {
      if (cIdx === 1 && typeof val === 'number') {
        cell.numFmt = rIdx === 2 ? '0.00"%"' : '#,##0';
        cell.font = { name: EXCEL_FONT, size: 10, bold: true, color: { argb: CNX.NAVY_BRAND } };
      }
      if (cIdx === 2) stylePillCell(cell, rIdx <= 1 ? 'teal' : 'info', false);
    },
  });
  paintDashboardBackdrop(wsCap, fcstTbl.endRow + 2, 4);

  // =========================================================================
  // SHEET 3: NEXT WEEK FORECAST (MON -> SUN)
  // =========================================================================
  appendNextWeekSheet({
    wb,
    sheetName: '3_Next_Week_Forecast',
    nextWeekSchedules,
    futureSummary,
    activeModelId: activeModel?.modelId ?? selectedModelId,
    erlangConfig,
  });

  // =========================================================================
  // SHEET 4: CURRENT MONTH (1-30) & NEXT MONTH (31-60)
  // =========================================================================
  appendMonthsHorizonSheet({
    wb,
    sheetName: '4_Current_&_Next_Month',
    futureSummary,
    erlangConfig,
    hoops,
  });

  // =========================================================================
  // SHEET 5: ALL HISTORICAL DAYS + NEXT WEEK ARRIVAL & SLA
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
      allDaysInput.push({ dateIso: iso, dayKey: dk, volume: vol, sourceLabel: 'Historical' });
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

  const wsAllDays = wb.addWorksheet('5_All_Days_Arrival_&_SLA', {
    properties: { tabColor: { argb: CNX.TEAL_ACCENT } },
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  buildExecutiveBanner({
    ws: wsAllDays,
    colCount: 14,
    title: 'ALL HISTORICAL DAYS + NEXT WEEK FORECAST — ARRIVAL PATTERNS & SLA',
    subtitle: `${allDaysSchedules.length} Days Total · Daily Summary followed by Interval-Level Arrival % & Erlang SLA Matrix`,
    badgeText: `Historical + Next Week\nwfmforall.com`,
  });
  wsAllDays.getRow(4).height = 8;

  const rAllHead = renderSectionHeading(
    wsAllDays,
    5,
    1,
    12,
    'PART 1: DAILY ARRIVAL & STAFFING SUMMARY',
    CNX.NAVY_BRAND
  );
  const allSummaryTbl = renderStyledTable({
    ws: wsAllDays,
    startRow: rAllHead,
    columns: [
      { header: 'Date', align: 'center', minWidth: 14, summaryFn: 'label', summaryLabel: 'ALL DAYS TOTAL / AVG' },
      { header: 'Day', align: 'center', minWidth: 9, summaryFn: 'blank' },
      { header: 'Type', align: 'center', minWidth: 13, summaryFn: 'blank' },
      { header: 'Daily Volume', align: 'right', numFmt: '#,##0', minWidth: 15, summaryFn: 'sum' },
      { header: 'Pure Talk Hrs', align: 'right', numFmt: '#,##0.00', minWidth: 15, summaryFn: 'sum' },
      { header: 'Req Prod Hrs (=Agents)', align: 'right', numFmt: '#,##0.00', minWidth: 20, summaryFn: 'sum' },
      { header: 'Req Prod Hrs (=Frac)', align: 'right', numFmt: '#,##0.00', minWidth: 19, summaryFn: 'sum' },
      { header: 'Peak Interval', align: 'center', minWidth: 14, summaryFn: 'blank' },
      { header: 'Peak Seats', align: 'right', numFmt: '#,##0', minWidth: 13, summaryFn: 'average' },
      { header: 'Weighted SLA %', align: 'right', numFmt: '0.0"%"', minWidth: 16, summaryFn: 'average' },
      { header: 'Weighted ASA (s)', align: 'right', numFmt: '0.0', minWidth: 16, summaryFn: 'average' },
      { header: 'Avg Occ %', align: 'right', numFmt: '0.0"%"', minWidth: 13, summaryFn: 'average' },
    ],
    rows: allDaysSchedules.map((s) => [
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
    ]),
    includeTotalsRow: true,
    onCell: (cell, val, _rowVals, _rIdx, cIdx) => {
      if (cIdx === 2) stylePillCell(cell, val === 'Historical' ? 'info' : 'teal');
      if (cIdx === 9 && typeof val === 'number') stylePillCell(cell, slaTone(val, erlangConfig.slTargetPct));
    },
  });
  addDataBar(wsAllDays, 4, allSummaryTbl.firstDataRow, allSummaryTbl.lastDataRow, CNX.BLUE_PRIMARY);

  const rAllIntHead = renderSectionHeading(
    wsAllDays,
    allSummaryTbl.endRow + 1,
    1,
    14,
    'PART 2: DETAILED INTERVAL-BY-INTERVAL ARRIVAL PATTERN (%) & SLA MATRIX',
    CNX.TEAL_ACCENT
  );
  const allIntervalRows: (string | number)[][] = [];
  for (const s of allDaysSchedules) {
    for (const r of s.summary.rows) {
      allIntervalRows.push([
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
  const allIntTbl = renderStyledTable({
    ws: wsAllDays,
    startRow: rAllIntHead,
    columns: [
      { header: 'Date', align: 'center', minWidth: 13 },
      { header: 'Day', align: 'center', minWidth: 9 },
      { header: 'Type', align: 'center', minWidth: 12 },
      { header: 'Interval', align: 'center', minWidth: 11 },
      { header: 'Arrival %', align: 'right', numFmt: '0.000"%"', minWidth: 12 },
      { header: 'Calls Offered', align: 'right', numFmt: '#,##0', minWidth: 14 },
      { header: 'AHT (s)', align: 'right', numFmt: '0', minWidth: 10 },
      { header: 'Erlangs (A)', align: 'right', numFmt: '0.00', minWidth: 13 },
      { header: 'Int Agents', align: 'right', numFmt: '#,##0', minWidth: 12 },
      { header: 'Frac Agents', align: 'right', numFmt: '0.00', minWidth: 13 },
      { header: 'Occupancy %', align: 'right', numFmt: '0.0"%"', minWidth: 13 },
      { header: 'Expected SLA %', align: 'right', numFmt: '0.0"%"', minWidth: 15 },
      { header: 'Expected ASA (s)', align: 'right', numFmt: '0.0', minWidth: 15 },
      { header: 'Prod Hours', align: 'right', numFmt: '#,##0.00', minWidth: 13 },
    ],
    rows: allIntervalRows,
    onCell: (cell, val, _rowVals, _rIdx, cIdx) => {
      if (cIdx === 2) stylePillCell(cell, val === 'Historical' ? 'info' : 'teal', false);
      if (cIdx === 11 && typeof val === 'number') stylePillCell(cell, slaTone(val, erlangConfig.slTargetPct), false);
    },
  });
  addDataBar(wsAllDays, 6, allIntTbl.firstDataRow, allIntTbl.lastDataRow, CNX.BLUE_PRIMARY);

  // =========================================================================
  // SHEET 6: ALL 12 FORECASTING MODELS LEADERBOARD + HISTORY AUDIT
  // =========================================================================
  const horizonCols = forecastConfig.horizon;
  const modelColCount = 10 + horizonCols;
  const wsModels = wb.addWorksheet('6_12_Forecast_Models', {
    properties: { tabColor: { argb: CNX.NAVY_BRAND } },
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  buildExecutiveBanner({
    ws: wsModels,
    colCount: Math.max(12, modelColCount),
    title: 'STATISTICAL FORECASTING LEADERBOARD & ACCURACY AUDIT (12 MODELS)',
    subtitle: `Chronological 80/20 Holdout Validation · Best Model: ${modelDisplayName(forecastOutput.bestModelId)}`,
    badgeText: `Winner: ${forecastOutput.bestModelId.toUpperCase()}\nwfmforall.com`,
  });
  wsModels.getRow(4).height = 8;

  const sortedModels = [...forecastOutput.models].sort(
    (a, b) => a.holdoutMetrics.wmape - b.holdoutMetrics.wmape
  );
  const leaderboardPng = renderHorizontalBarChartPng({
    title: 'Holdout Validation Leaderboard — WMAPE % (Lower = More Accurate)',
    subtitle: 'All 12 forecasting models ranked by chronological 20% unseen holdout accuracy',
    width: 820,
    height: 310,
    items: sortedModels.map((m) => ({
      label: modelDisplayName(m.modelId),
      value: m.holdoutMetrics.wmape,
      valueLabel: `${m.holdoutMetrics.wmape.toFixed(2)}%${m.isBest ? ' ★ BEST' : ''}`,
      highlight: m.isBest,
    })),
  });

  let rModStart = 5;
  if (leaderboardPng) {
    for (let r = 5; r <= 21; r++) wsModels.getRow(r).height = 19;
    embedPngChart(wb, wsModels, leaderboardPng, 0.1, 4.2, 820, 310);
    rModStart = 22;
  }

  rModStart = renderSectionHeading(
    wsModels,
    rModStart,
    1,
    modelColCount,
    'MODEL ACCURACY METRICS & FUTURE HORIZON PREDICTIONS',
    CNX.NAVY_BRAND
  );

  const modelTbl = renderStyledTable({
    ws: wsModels,
    startRow: rModStart,
    columns: [
      { header: 'Forecasting Model', align: 'left', minWidth: 28 },
      { header: 'Rank Status', align: 'center', minWidth: 14 },
      { header: 'WMAPE %', align: 'right', numFmt: '0.00"%"', minWidth: 12 },
      { header: 'MAPE %', align: 'right', numFmt: '0.00"%"', minWidth: 12 },
      { header: 'RMSE', align: 'right', numFmt: '#,##0.0', minWidth: 12 },
      { header: 'MAE / MAD', align: 'right', numFmt: '#,##0.0', minWidth: 13 },
      { header: 'Bias %', align: 'right', numFmt: '+0.00"%";-0.00"%";0.00"%"', minWidth: 12 },
      { header: 'Train RMSE', align: 'right', numFmt: '#,##0.0', minWidth: 13 },
      { header: 'R²', align: 'right', numFmt: '0.0000', minWidth: 11 },
      { header: 'Calibrated Params', align: 'left', minWidth: 26, maxWidth: 40 },
      ...Array.from({ length: horizonCols }, (_, i) => ({
        header: `Horizon +${i + 1}`,
        align: 'right' as const,
        numFmt: '#,##0',
        minWidth: 13,
      })),
    ],
    rows: forecastOutput.models.map((m) => [
      modelDisplayName(m.modelId),
      m.isBest ? '★ BEST' : m.modelId === selectedModelId ? 'ACTIVE' : 'CANDIDATE',
      Number(m.holdoutMetrics.wmape.toFixed(2)),
      Number(m.holdoutMetrics.mape.toFixed(2)),
      Number(m.holdoutMetrics.rmse.toFixed(2)),
      Number(m.holdoutMetrics.mae.toFixed(2)),
      Number(m.holdoutMetrics.bias.toFixed(2)),
      Number(m.trainMetrics.rmse.toFixed(2)),
      m.r2 != null ? Number(m.r2.toFixed(4)) : '',
      JSON.stringify(m.params),
      ...m.futureForecast.map((v) => Math.round(v)),
    ]),
    freezeHeader: !leaderboardPng,
    showGridLines: false,
    onCell: (cell, val, _rowVals, _rIdx, cIdx) => {
      if (cIdx === 1) {
        stylePillCell(cell, val === '★ BEST' ? 'good' : val === 'ACTIVE' ? 'teal' : 'neutral');
      }
      if (cIdx === 2 && typeof val === 'number') {
        stylePillCell(cell, val <= 10 ? 'good' : val <= 20 ? 'warn' : 'bad');
      }
    },
  });
  addDataBar(wsModels, 3, modelTbl.firstDataRow, modelTbl.lastDataRow, CNX.BLUE_PRIMARY);

  const rHistSec = renderSectionHeading(
    wsModels,
    modelTbl.endRow + 1,
    1,
    4,
    'HISTORICAL TIME-SERIES & OUTLIER CLEANING AUDIT',
    CNX.BLUE_PRIMARY
  );
  const histTbl = renderStyledTable({
    ws: wsModels,
    startRow: rHistSec,
    columns: [
      { header: 'Historical Period', align: 'center', minWidth: 18 },
      { header: 'Raw Volume', align: 'right', numFmt: '#,##0', minWidth: 15 },
      { header: 'Outlier Status', align: 'center', minWidth: 15 },
      { header: 'Cleaned Volume', align: 'right', numFmt: '#,##0', minWidth: 16 },
    ],
    rows: history.map((h) => [
      h.label,
      h.volume,
      h.isExcluded ? 'EXCLUDED' : h.isSmoothed ? 'SMOOTHED' : 'CLEAN',
      h.isExcluded ? '' : h.isSmoothed ? (h.smoothedVolume ?? h.volume) : h.volume,
    ]),
    showGridLines: false,
    onCell: (cell, val, _rowVals, _rIdx, cIdx) => {
      if (cIdx === 2) {
        stylePillCell(cell, val === 'CLEAN' ? 'good' : val === 'SMOOTHED' ? 'warn' : 'bad');
      }
    },
  });
  paintDashboardBackdrop(wsModels, histTbl.endRow + 2, Math.max(12, modelColCount));

  // =========================================================================
  // SHEET 7: ACTIVE TAB 2 INTERVAL STAFFING PLAN
  // =========================================================================
  const wsActiveInt = wb.addWorksheet('7_Active_Interval_Plan', {
    properties: { tabColor: { argb: CNX.BLUE_PRIMARY } },
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  buildExecutiveBanner({
    ws: wsActiveInt,
    colCount: 15,
    title: 'ACTIVE DAY INTRADAY ERLANG STAFFING PLAN',
    subtitle: `Selected Day: ${erlangConfig.selectedDateIso ?? erlangConfig.selectedDay} · Granularity: ${erlangConfig.granularityMin}m · SLA ${erlangConfig.slTargetPct}% in ${erlangConfig.slThresholdSec}s`,
    badgeText: `Peak ${erlangSummary.peakSeats} Seats\n@ ${erlangSummary.peakTimeLabel}`,
  });
  wsActiveInt.getRow(4).height = 10;

  renderKpiCards(wsActiveInt, 5, [
    {
      colStart: 1,
      colSpan: 4,
      label: 'Daily Volume Offered',
      value: erlangSummary.totalVolume,
      numFmt: '#,##0',
      sublabel: `Pure Talk: ${erlangSummary.totalPureTalkHours.toFixed(1)} hrs`,
      accentArgb: CNX.BLUE_PRIMARY,
    },
    {
      colStart: 5,
      colSpan: 4,
      label: 'Total Req Productive Hours',
      value: Number(erlangSummary.totalProductiveHours.toFixed(2)),
      numFmt: '#,##0.00" hrs"',
      sublabel: `Mode: ${(erlangConfig.agentMode ?? 'integer') === 'fractional' ? 'Fractional' : 'Integer'}`,
      accentArgb: CNX.TEAL_ACCENT,
      valueArgb: CNX.TEAL_DARK,
    },
    {
      colStart: 9,
      colSpan: 4,
      label: 'Peak Required Interval',
      value: `${erlangSummary.peakSeats} Seats @ ${erlangSummary.peakTimeLabel}`,
      sublabel: `Avg Occupancy: ${erlangSummary.avgOccupancyPct.toFixed(1)}%`,
      accentArgb: CNX.NAVY_BRAND,
    },
    {
      colStart: 13,
      colSpan: 3,
      label: 'Weighted Expected SLA',
      value: Number(erlangSummary.weightedSlPct.toFixed(1)),
      numFmt: '0.0"%"',
      sublabel: `Weighted ASA: ${erlangSummary.weightedAsaSec.toFixed(1)}s`,
      accentArgb: erlangSummary.weightedSlPct >= erlangConfig.slTargetPct ? CNX.TEAL_ACCENT : CNX.NAVY_BRAND,
      valueArgb: erlangSummary.weightedSlPct >= erlangConfig.slTargetPct ? CNX.GREEN_FG : CNX.AMBER_FG,
    },
  ]);
  wsActiveInt.getRow(8).height = 10;

  const activeChartPng = renderColumnDashboardChartPng({
    title: 'Active Intraday Staffing Curve (Required Seats) vs Expected SLA %',
    subtitle: `Date/Profile: ${erlangConfig.selectedDateIso ?? erlangConfig.selectedDay}`,
    primaryLabel: 'Required Seats',
    highlightLabel: 'Peak Seat Interval',
    secondaryLineLabel: 'Expected SLA %',
    width: 1020,
    height: 255,
    bars: erlangSummary.rows.map((r) => ({
      label: r.timeLabel,
      value: r.requiredSeats,
      highlight: r.timeLabel === erlangSummary.peakTimeLabel,
      secondaryValue: r.isOpen ? r.slPct : undefined,
    })),
  });

  let rActInt = 9;
  if (activeChartPng) {
    for (let r = 9; r <= 21; r++) wsActiveInt.getRow(r).height = 20;
    embedPngChart(wb, wsActiveInt, activeChartPng, 0.2, 8.2, 1020, 255);
    rActInt = 22;
  }

  rActInt = renderSectionHeading(
    wsActiveInt,
    rActInt,
    1,
    15,
    'PER-INTERVAL ERLANG C / A STAFFING SCHEDULE',
    CNX.NAVY_BRAND
  );

  const actIntTbl = renderStyledTable({
    ws: wsActiveInt,
    startRow: rActInt,
    columns: [
      { header: 'Interval', align: 'center', minWidth: 11, summaryFn: 'label', summaryLabel: 'DAY TOTAL / AVG' },
      { header: 'Status', align: 'center', minWidth: 11, summaryFn: 'blank' },
      { header: 'Arrival %', align: 'right', numFmt: '0.000"%"', minWidth: 12, summaryFn: 'sum' },
      { header: 'Volume', align: 'right', numFmt: '#,##0', minWidth: 12, summaryFn: 'sum' },
      { header: 'AHT (s)', align: 'right', numFmt: '0', minWidth: 10, summaryFn: 'average' },
      { header: 'Erlangs (A)', align: 'right', numFmt: '0.00', minWidth: 13, summaryFn: 'average' },
      { header: 'Int Agents', align: 'right', numFmt: '#,##0', minWidth: 12, summaryFn: 'average' },
      { header: 'Frac Agents', align: 'right', numFmt: '0.00', minWidth: 13, summaryFn: 'average' },
      { header: 'Active Seats', align: 'right', numFmt: '0.00', minWidth: 13, summaryFn: 'average' },
      { header: 'Prod Hours', align: 'right', numFmt: '#,##0.00', minWidth: 13, summaryFn: 'sum' },
      { header: 'Occupancy %', align: 'right', numFmt: '0.0"%"', minWidth: 14, summaryFn: 'average' },
      { header: 'Expected ASA (s)', align: 'right', numFmt: '0.0', minWidth: 15, summaryFn: 'average' },
      { header: 'Expected SLA %', align: 'right', numFmt: '0.0"%"', minWidth: 15, summaryFn: 'average' },
      { header: 'Prob Wait %', align: 'right', numFmt: '0.0"%"', minWidth: 13, summaryFn: 'average' },
      { header: 'Abandon % (Erlang A)', align: 'right', numFmt: '0.00"%"', minWidth: 18, summaryFn: 'blank' },
    ],
    rows: erlangSummary.rows.map((r) => [
      r.timeLabel,
      r.isOpen ? 'OPEN' : 'CLOSED',
      Number(r.arrivalPct.toFixed(3)),
      r.volume,
      r.ahtSec,
      Number(r.erlangs.toFixed(2)),
      r.integerSeats,
      Number(r.fractionalSeats.toFixed(2)),
      Number(r.requiredSeats.toFixed(2)),
      Number(r.productiveHours.toFixed(2)),
      Number(r.occupancyPct.toFixed(1)),
      Number(r.asaSec.toFixed(1)),
      Number(r.slPct.toFixed(1)),
      Number(r.probWaitPct.toFixed(1)),
      r.abandonPct != null ? Number(r.abandonPct.toFixed(2)) : 'N/A',
    ]),
    includeTotalsRow: true,
    showGridLines: false,
    onCell: (cell, val, rowVals, _rIdx, cIdx) => {
      if (cIdx === 1) stylePillCell(cell, val === 'OPEN' ? 'good' : 'neutral');
      if (cIdx === 12 && typeof val === 'number' && rowVals[1] === 'OPEN') {
        stylePillCell(cell, slaTone(val, erlangConfig.slTargetPct));
      }
    },
  });
  addDataBar(wsActiveInt, 4, actIntTbl.firstDataRow, actIntTbl.lastDataRow, CNX.BLUE_PRIMARY);
  addDataBar(wsActiveInt, 9, actIntTbl.firstDataRow, actIntTbl.lastDataRow, CNX.TEAL_ACCENT);
  paintDashboardBackdrop(wsActiveInt, actIntTbl.endRow + 2, 15);

  // =========================================================================
  // SHEET 8: FTE WATERFALL & COLOR-GRADED WHAT-IF SENSITIVITY MATRIX
  // =========================================================================
  const matrixCols = 1 + shrinkageDeltas.length;
  const wfColCount = Math.max(6, matrixCols);
  const wsCapWf = wb.addWorksheet('8_Waterfall_&_WhatIf', {
    properties: { tabColor: { argb: CNX.TEAL_ACCENT } },
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  buildExecutiveBanner({
    ws: wsCapWf,
    colCount: wfColCount,
    title: 'FTE CAPACITY WATERFALL & WHAT-IF SENSITIVITY HEATMAP',
    subtitle: `Baseline: ${capacityResult.finalGrossFte.toFixed(1)} FTE (${erlangConfig.globalAhtSec}s AHT · ${capacityResult.outOfOfficeShrinkagePct.toFixed(1)}% OOO Shrinkage)`,
    badgeText: `Baseline: ${Math.round(capacityResult.finalGrossFte)} Agents\nwfmforall.com`,
  });
  wsCapWf.getRow(4).height = 8;

  const rWfHead = renderSectionHeading(
    wsCapWf,
    5,
    1,
    wfColCount,
    '1. STEP-BY-STEP FTE CAPACITY WATERFALL BRIDGE',
    CNX.NAVY_BRAND
  );
  const wfFullTbl = renderStyledTable({
    ws: wsCapWf,
    startRow: rWfHead,
    columns: [
      { header: 'Waterfall Stage', align: 'left', minWidth: 34 },
      { header: 'Workload Hours', align: 'right', numFmt: '#,##0.00', minWidth: 18 },
      { header: 'FTE Equivalent', align: 'right', numFmt: '0.00', minWidth: 16 },
      { header: 'Incremental Delta FTE', align: 'right', numFmt: '+0.00;-0.00;0.00', minWidth: 20 },
      { header: 'Formula Note', align: 'left', minWidth: 28 },
      { header: 'Milestone', align: 'center', minWidth: 15 },
    ],
    rows: capacityResult.waterfall.map((w, idx) => [
      w.labelEn,
      Number(w.hours.toFixed(2)),
      Number(w.fte.toFixed(2)),
      Number(w.deltaFte.toFixed(2)),
      w.formulaNote,
      idx === capacityResult.waterfall.length - 1 ? 'GROSS FTE' : idx === 0 ? 'PURE TALK' : '+SHRINKAGE',
    ]),
    showGridLines: false,
    onCell: (cell, _val, _rowVals, rIdx, cIdx) => {
      const isLast = rIdx === capacityResult.waterfall.length - 1;
      if (cIdx === 5) stylePillCell(cell, isLast ? 'teal' : rIdx === 0 ? 'info' : 'neutral');
      if (isLast && cIdx < 5) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CNX.TEAL_TINT } };
        cell.font = { name: EXCEL_FONT, size: 10, bold: true, color: { argb: CNX.TEAL_DARK } };
      }
    },
  });
  addDataBar(wsCapWf, 3, wfFullTbl.firstDataRow, wfFullTbl.lastDataRow, CNX.TEAL_ACCENT);

  const rMatHead = renderSectionHeading(
    wsCapWf,
    wfFullTbl.endRow + 1,
    1,
    matrixCols,
    '2. WHAT-IF SENSITIVITY HEATMAP MATRIX (AHT Δ × OUT-OF-OFFICE SHRINKAGE Δ)',
    CNX.BLUE_PRIMARY
  );
  const matTbl = renderStyledTable({
    ws: wsCapWf,
    startRow: rMatHead,
    columns: [
      { header: 'AHT Delta \\ Shrinkage Delta', align: 'left', minWidth: 34 },
      ...shrinkageDeltas.map((d) => ({
        header: `${d >= 0 ? '+' : ''}${d}% Shrinkage`,
        align: 'center' as const,
        minWidth: 22,
      })),
    ],
    rows: whatIfMatrix.map((row) => [
      `${row[0].ahtDeltaSec >= 0 ? '+' : ''}${row[0].ahtDeltaSec}s (${row[0].effectiveAhtSec}s)`,
      ...row.map(
        (cell) =>
          `${cell.finalGrossFte.toFixed(1)} FTE (${cell.deltaFte >= 0 ? '+' : ''}${cell.deltaFte.toFixed(1)})`
      ),
    ]),
    showGridLines: false,
    onCell: (cell, _val, _rowVals, rIdx, cIdx) => {
      if (cIdx === 0) {
        cell.font = { name: EXCEL_FONT, size: 9.5, bold: true, color: { argb: CNX.NAVY_DARK } };
        return;
      }
      const wfCell = whatIfMatrix[rIdx]?.[cIdx - 1];
      if (!wfCell) return;
      const isBaseline = wfCell.ahtDeltaSec === 0 && wfCell.shrinkageDeltaPct === 0;
      if (isBaseline) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CNX.BLUE_TINT } };
        cell.font = { name: EXCEL_FONT, size: 10, bold: true, color: { argb: CNX.NAVY_BRAND } };
        cell.border = {
          top: { style: 'medium', color: { argb: CNX.BLUE_PRIMARY } },
          bottom: { style: 'medium', color: { argb: CNX.BLUE_PRIMARY } },
          left: { style: 'medium', color: { argb: CNX.BLUE_PRIMARY } },
          right: { style: 'medium', color: { argb: CNX.BLUE_PRIMARY } },
        };
      } else if (wfCell.deltaFte <= -2) {
        stylePillCell(cell, 'good');
      } else if (wfCell.deltaFte < 0) {
        stylePillCell(cell, 'teal', false);
      } else if (wfCell.deltaFte >= 3) {
        stylePillCell(cell, 'bad');
      } else if (wfCell.deltaFte > 0) {
        stylePillCell(cell, 'warn', false);
      }
    },
  });
  paintDashboardBackdrop(wsCapWf, matTbl.endRow + 2, wfColCount);

  return wb;
}

export async function exportFullSuiteWorkbook(params: {
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
}): Promise<void> {
  const wb = await buildFullSuiteWorkbook(params);
  await downloadWorkbook(
    wb,
    `WFM-Executive-Master-Report-${new Date().toISOString().slice(0, 10)}.xlsx`
  );
}

/**
 * Tab 4 Export: Styled Concentrix Weekly Agent Roster, 15-Min Break Schedule & Intraday Coverage Dashboard.
 */
export async function buildSchedulingWorkbook(params: {
  scheduleResult: ScheduleGenerationResult;
  shiftCatalog: ShiftTemplate[];
  rules: SchedulingRules;
  erlangConfig: ErlangConfig;
}): Promise<ExcelJS.Workbook> {
  const { scheduleResult, shiftCatalog, rules, erlangConfig } = params;
  const ExcelJSClass = await loadExcelJS();
  const wb = new ExcelJSClass.Workbook();
  wb.creator = 'WFM & Capacity Suite — wfmforall.com';
  wb.created = new Date();

  const shiftMap = new Map(shiftCatalog.map((s) => [s.id, s]));
  const { summary, visibleOutputAgents, dailyTotals, coverageByDay } = scheduleResult;

  // =========================================================================
  // SHEET 1: WEEKLY AGENT ROSTER & 15M BREAK STAGGERING
  // =========================================================================
  const wsRoster = wb.addWorksheet('1_Weekly_Agent_Roster', {
    properties: { tabColor: { argb: CNX.TEAL_ACCENT } },
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  const rCols = 13;
  buildExecutiveBanner({
    ws: wsRoster,
    colCount: rCols,
    title: 'WFM AGENT SHIFT SCHEDULE & STAGGERED BREAK ROSTER (MON → SUN)',
    subtitle: `Max ${rules.maxWorkdaysPerWeek}d/wk · OFF Pattern: Consecutive${rules.allowSunMonSplitOff ? ' + Sun+Mon Split' : ''} · Drift ≤${rules.maxWeeklyStartDriftHours}h · Rest ≥${rules.minInterShiftRestHours}h · Breaks: ${rules.breakRules.firstBreakMin}m/${rules.breakRules.lunchMin}m/${rules.breakRules.lastBreakMin}m`,
    badgeText: `Schedulable: ${summary.activeSchedulableCount}\nCov: ${summary.avgCoveragePct.toFixed(1)}%`,
  });
  wsRoster.getRow(4).height = 10;

  renderKpiCards(wsRoster, 5, [
    {
      colStart: 1,
      colSpan: 3,
      label: 'Schedulable Agents',
      value: summary.activeSchedulableCount,
      numFmt: '#,##0',
      sublabel: `Total Input: ${summary.totalRosterInput} (AL Input Excl: ${summary.annualExcluded})`,
      accentArgb: CNX.BLUE_PRIMARY,
    },
    {
      colStart: 4,
      colSpan: 2,
      label: 'Weekly Net Coverage',
      value: summary.avgCoveragePct,
      numFmt: '0.0"%"',
      sublabel: `${summary.totalScheduledNetHours.toFixed(1)}h / ${summary.totalRequiredProdHours.toFixed(1)}h req`,
      accentArgb: summary.avgCoveragePct >= 95 ? CNX.TEAL_ACCENT : CNX.NAVY_BRAND,
      valueArgb: summary.avgCoveragePct >= 95 ? CNX.GREEN_FG : CNX.AMBER_FG,
    },
    {
      colStart: 6,
      colSpan: 3,
      label: 'Projected Weekly SL %',
      value: summary.projectedWeeklySlPct,
      numFmt: '0.0"%"',
      sublabel: `Target ${erlangConfig.slTargetPct}% in ${erlangConfig.slThresholdSec}s (${summary.understaffedIntervalsTotal} low slots)`,
      accentArgb: summary.projectedWeeklySlPct >= erlangConfig.slTargetPct ? CNX.TEAL_ACCENT : CNX.NAVY_BRAND,
      valueArgb: summary.projectedWeeklySlPct >= erlangConfig.slTargetPct ? CNX.GREEN_FG : CNX.AMBER_FG,
    },
    {
      colStart: 9,
      colSpan: 3,
      label: 'Full-Week Exclusions',
      value: summary.fullWeekExceptionsCount,
      numFmt: '#,##0',
      sublabel: `MAT / RES / TERM / UPL / PAT locked`,
      accentArgb: CNX.NAVY_BRAND,
    },
    {
      colStart: 12,
      colSpan: 2,
      label: 'Rule Audit Status',
      value: summary.violationAgentsCount === 0 ? '100% COMPLIANT' : `${summary.violationAgentsCount} ALERTS`,
      sublabel: `Valid Breaks: ${summary.validBreakRatePct.toFixed(1)}%`,
      accentArgb: summary.violationAgentsCount === 0 ? CNX.TEAL_ACCENT : CNX.NAVY_BRAND,
      valueArgb: summary.violationAgentsCount === 0 ? CNX.GREEN_FG : CNX.ROSE_FG,
    },
  ]);
  wsRoster.getRow(8).height = 10;

  const rSecRow = renderSectionHeading(
    wsRoster,
    9,
    1,
    rCols,
    `1. AGENT ROSTER MATRIX (${visibleOutputAgents.length} DISPLAYED${rules.annualVisibilityInOutput === 'exclude' && summary.annualExcluded > 0 ? ` · ${summary.annualExcluded} ANNUAL LEAVE INPUTS EXCLUDED FROM OUTPUT` : ''})`,
    CNX.NAVY_DARK
  );

  const rosterCols: TableColumnSpec[] = [
    { header: 'Agent Name / ID', align: 'left', minWidth: 22 },
    { header: 'OFF Pattern', align: 'center', minWidth: 16 },
    ...WEEK_DAYS.map((dk) => {
      const dt = dailyTotals.find((d) => d.dayKey === dk);
      return {
        header: `${dk}${dt ? `\n(${dt.dateIso.slice(5)})` : ''}`,
        align: 'center' as const,
        minWidth: 21,
      };
    }),
    { header: 'Work d', align: 'center', minWidth: 9 },
    { header: 'Drift h', align: 'center', minWidth: 9 },
    { header: 'Min Rest', align: 'center', minWidth: 10 },
    { header: 'Audit', align: 'center', minWidth: 18 },
  ];

  const rosterRows = visibleOutputAgents.map((agent) => {
    const dayCells = WEEK_DAYS.map((dk) => {
      const a = agent.assignments[dk];
      if (!a) return 'OFF';
      if (a.status !== 'WORK') return a.status;
      const sh = a.shiftId ? shiftMap.get(a.shiftId) : null;
      const br = a.breaks;
      if (!sh) return 'WORK';
      if (!br) return sh.label;
      return `${sh.label}\nB1 ${br.firstBreakLabel.split('–')[0]} | L ${br.lunchLabel.split('–')[0]} | B2 ${br.lastBreakLabel.split('–')[0]}`;
    });
    return [
      agent.agentName,
      agent.offPatternLabel,
      ...dayCells,
      agent.workDaysCount,
      agent.workDaysCount > 0 ? `${agent.shiftBandSpanHours.toFixed(1)}h` : '—',
      agent.minRestHoursObserved !== null ? `${agent.minRestHoursObserved.toFixed(1)}h` : '—',
      agent.violations.length === 0 ? 'Valid' : agent.violations[0],
    ];
  });

  const rosterTbl = renderStyledTable({
    ws: wsRoster,
    startRow: rSecRow,
    columns: rosterCols,
    rows: rosterRows,
    freezeHeader: true,
    showGridLines: false,
    onCell: (cell, val, _rowVals, rIdx, cIdx) => {
      const agent = visibleOutputAgents[rIdx];
      if (!agent) return;
      cell.alignment = {
        horizontal: cIdx === 0 ? 'left' : 'center',
        vertical: 'middle',
        wrapText: true,
      };
      if (cIdx === 0) {
        cell.font = { name: EXCEL_FONT, size: 9.5, bold: true, color: { argb: CNX.NAVY_DARK } };
      } else if (cIdx >= 2 && cIdx <= 8) {
        const s = String(val ?? '');
        if (s === 'OFF') {
          stylePillCell(cell, 'neutral', true);
        } else if (['MAT', 'RES', 'TERM', 'UPL', 'PAT', 'AL'].includes(s)) {
          stylePillCell(cell, s === 'AL' ? 'info' : 'warn', true);
        } else {
          stylePillCell(cell, 'teal', false);
          cell.font = { name: EXCEL_FONT, size: 8.5, bold: true, color: { argb: CNX.NAVY_DARK } };
        }
      } else if (cIdx === 12) {
        stylePillCell(cell, agent.violations.length === 0 ? 'good' : 'bad', true);
      }
    },
  });
  for (let r = rosterTbl.firstDataRow; r <= rosterTbl.endRow; r++) {
    wsRoster.getRow(r).height = 28;
  }
  paintDashboardBackdrop(wsRoster, rosterTbl.endRow + 2, rCols);

  // =========================================================================
  // SHEET 2: DAILY SUMMARY & INTRADAY INTERVAL COVERAGE
  // =========================================================================
  const wsCov = wb.addWorksheet('2_Coverage_Matrix', {
    properties: { tabColor: { argb: CNX.BLUE_PRIMARY } },
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  const cCols = 11;
  buildExecutiveBanner({
    ws: wsCov,
    colCount: cCols,
    title: 'DAILY & INTRADAY INTERVAL COVERAGE VS ERLANG REQUIRED',
    subtitle: `Forecast Horizon: Next Week (Mon → Sun) · Granularity: ${erlangConfig.granularityMin} min · SLA ${erlangConfig.slTargetPct}% / ${erlangConfig.slThresholdSec}s`,
    badgeText: `Net Cov: ${summary.avgCoveragePct.toFixed(1)}%\nProj SL: ${summary.projectedWeeklySlPct.toFixed(1)}%`,
  });
  wsCov.getRow(4).height = 10;

  const peakVolDayIdx = dailyTotals.reduce(
    (bestIdx, d, idx, arr) => (d.forecastVolume > arr[bestIdx].forecastVolume ? idx : bestIdx),
    0
  );
  const covChartPng = renderColumnDashboardChartPng({
    title: 'Daily Net Scheduled Hours vs Peak Understaffing Risk (Mon → Sun)',
    subtitle: 'Productive agent hours after deducting 15m + 30m + 15m breaks',
    primaryLabel: 'Net Scheduled Hrs',
    highlightLabel: 'Highest Volume Day',
    secondaryLineLabel: 'Projected SL %',
    bars: dailyTotals.map((d, idx) => ({
      label: d.dayKey,
      value: d.scheduledNetHours,
      highlight: idx === peakVolDayIdx,
      secondaryLinePct: Math.min(100, d.avgProjectedSlPct),
    })),
    width: 980,
    height: 270,
  });
  let covRowCursor = 5;
  if (covChartPng) {
    embedPngChart(wb, wsCov, covChartPng, 0.15, 4.3, 980, 270);
    covRowCursor = 21;
  }

  const dSecRow = renderSectionHeading(
    wsCov,
    covRowCursor,
    1,
    cCols,
    '1. MON → SUN WEEKLY FORECAST VS SCHEDULED COVERAGE SUMMARY',
    CNX.NAVY_BRAND
  );
  const dailyTbl = renderStyledTable({
    ws: wsCov,
    startRow: dSecRow,
    columns: [
      { header: 'Day', align: 'center', minWidth: 10 },
      { header: 'Forecast Date', align: 'center', minWidth: 16 },
      { header: 'Forecast Calls', align: 'right', minWidth: 16, numFmt: '#,##0' },
      { header: 'Required Prod Hrs', align: 'right', minWidth: 18, numFmt: '#,##0.0' },
      { header: 'Gross Shift Hrs', align: 'right', minWidth: 16, numFmt: '#,##0.0' },
      { header: 'Net Paid Hrs (-Brk)', align: 'right', minWidth: 18, numFmt: '#,##0.0' },
      { header: 'Coverage %', align: 'right', minWidth: 14, numFmt: '0.0"%"' },
      { header: 'Peak Req Seats', align: 'right', minWidth: 15, numFmt: '0.0' },
      { header: 'Peak Net Seats', align: 'right', minWidth: 15, numFmt: '0.0' },
      { header: 'Low Intervals', align: 'center', minWidth: 14, numFmt: '#,##0' },
      { header: 'Projected SL %', align: 'right', minWidth: 15, numFmt: '0.0"%"' },
    ],
    rows: dailyTotals.map((d) => [
      d.dayKey,
      d.dateIso,
      d.forecastVolume,
      d.requiredProdHours,
      d.scheduledGrossHours,
      d.scheduledNetHours,
      d.coveragePct,
      d.peakRequired,
      d.peakScheduledNet,
      d.understaffedIntervals,
      d.avgProjectedSlPct,
    ]),
    showGridLines: false,
    onCell: (cell, _val, _r, rIdx, cIdx) => {
      const d = dailyTotals[rIdx];
      if (!d) return;
      if (cIdx === 6) {
        stylePillCell(cell, d.coveragePct >= 96 ? 'good' : d.coveragePct >= 88 ? 'warn' : 'bad');
      } else if (cIdx === 10) {
        stylePillCell(
          cell,
          d.avgProjectedSlPct >= erlangConfig.slTargetPct ? 'good' : 'warn'
        );
      }
    },
  });

  const intSecRow = renderSectionHeading(
    wsCov,
    dailyTbl.endRow + 2,
    1,
    cCols,
    '2. FULL INTRADAY INTERVAL COVERAGE TELEMETRY (GROSS VS BREAK DEDUCTION VS NET FTE)',
    CNX.NAVY_DARK
  );
  const allIntervalRows = WEEK_DAYS.flatMap((dk) =>
    (coverageByDay[dk] ?? []).map((c) => [
      c.dayKey,
      c.dateIso,
      c.timeLabel,
      c.forecastVolume,
      c.requiredSeats,
      c.scheduledGrossHeads,
      c.onBreakFte,
      c.effectiveScheduledFte,
      c.varianceFte,
      c.projectedSlPct,
      c.varianceFte >= 0 ? 'Covered' : c.varianceFte > -1 ? 'Tight' : 'Deficit',
    ])
  );
  const intTbl = renderStyledTable({
    ws: wsCov,
    startRow: intSecRow,
    columns: [
      { header: 'Day', align: 'center', minWidth: 10 },
      { header: 'Date', align: 'center', minWidth: 14 },
      { header: 'Interval', align: 'center', minWidth: 12 },
      { header: 'Fcst Calls', align: 'right', minWidth: 12, numFmt: '#,##0' },
      { header: 'Req Seats', align: 'right', minWidth: 12, numFmt: '0.0' },
      { header: 'Gross On Shift', align: 'right', minWidth: 14, numFmt: '0.0' },
      { header: 'On Break FTE', align: 'right', minWidth: 14, numFmt: '0.00' },
      { header: 'Net Effective', align: 'right', minWidth: 14, numFmt: '0.00' },
      { header: 'Variance (+/-)', align: 'right', minWidth: 14, numFmt: '+0.00;-0.00;0.00' },
      { header: 'Proj SL %', align: 'right', minWidth: 12, numFmt: '0.0"%"' },
      { header: 'Status', align: 'center', minWidth: 12 },
    ],
    rows: allIntervalRows,
    showGridLines: false,
    onCell: (cell, val, _r, _rIdx, cIdx) => {
      if (cIdx === 10) {
        const s = String(val ?? '');
        stylePillCell(cell, s === 'Covered' ? 'good' : s === 'Tight' ? 'warn' : 'bad');
      }
    },
  });
  paintDashboardBackdrop(wsCov, intTbl.endRow + 2, cCols);

  // =========================================================================
  // SHEET 3: LEAVE EXCLUSIONS, EXTERNAL SHIFT CATALOG & RULES
  // =========================================================================
  const wsRules = wb.addWorksheet('3_Leave_&_Shift_Rules', {
    properties: { tabColor: { argb: CNX.NAVY_BRAND } },
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  const sCols = 8;
  buildExecutiveBanner({
    ws: wsRules,
    colCount: sCols,
    title: 'ROSTER EXCEPTIONS INPUT, EXTERNAL SHIFT CATALOG & POLICY RULES',
    subtitle: 'Full audit trail of input leave deductions, imported shift catalog, and fatigue/break constraints',
    badgeText: `Catalog: ${shiftCatalog.filter((s) => s.enabled).length} Shifts`,
  });
  wsRules.getRow(4).height = 10;

  const exCounts: Record<string, number> = { AL: 0, MAT: 0, RES: 0, TERM: 0, UPL: 0, PAT: 0 };
  for (const a of scheduleResult.agents) {
    if (a.preAllocatedException) exCounts[a.preAllocatedException] = (exCounts[a.preAllocatedException] ?? 0) + 1;
  }

  const lSec = renderSectionHeading(
    wsRules,
    5,
    1,
    sCols,
    '1. ROSTER POOL & LEAVE / ATTRITION DEDUCTIONS',
    CNX.NAVY_DARK
  );
  const leaveTbl = renderStyledTable({
    ws: wsRules,
    startRow: lSec,
    columns: [
      { header: 'Code', align: 'center', minWidth: 12 },
      { header: 'Exception Category', align: 'left', minWidth: 26 },
      { header: 'Count', align: 'right', minWidth: 12, numFmt: '#,##0' },
      { header: 'Handling Mode', align: 'left', minWidth: 44 },
    ],
    rows: (Object.keys(EXCEPTION_META) as (keyof typeof EXCEPTION_META)[]).map((code) => [
      code,
      EXCEPTION_META[code].label,
      exCounts[code] ?? 0,
      code === 'AL'
        ? `Input-only deduction (${rules.annualVisibilityInOutput === 'exclude' ? 'Excluded from output roster' : 'Shown muted'}) · 0 interval coverage`
        : 'Locked full week (Mon → Sun) across same status code · 0 interval coverage',
    ]),
    showGridLines: false,
  });

  const shSec = renderSectionHeading(
    wsRules,
    leaveTbl.endRow + 2,
    1,
    sCols,
    '2. EXTERNAL SHIFT CATALOG & FATIGUE / BREAK CONSTRAINTS',
    CNX.BLUE_PRIMARY
  );
  const shiftTbl = renderStyledTable({
    ws: wsRules,
    startRow: shSec,
    columns: [
      { header: 'Shift ID', align: 'left', minWidth: 18 },
      { header: 'Window', align: 'center', minWidth: 18 },
      { header: 'Gross Mins', align: 'right', minWidth: 14, numFmt: '#,##0' },
      { header: 'Midnight Wrap', align: 'center', minWidth: 16 },
      { header: 'Status', align: 'center', minWidth: 14 },
    ],
    rows: shiftCatalog.map((s) => [
      s.id,
      s.label,
      s.durationMin,
      s.wrapsMidnight ? 'Yes (+1d)' : 'Same Day',
      s.enabled ? 'Active' : 'Disabled',
    ]),
    showGridLines: false,
    onCell: (cell, val, _r, _rIdx, cIdx) => {
      if (cIdx === 4) {
        stylePillCell(cell, val === 'Active' ? 'good' : 'neutral');
      }
    },
  });
  paintDashboardBackdrop(wsRules, shiftTbl.endRow + 2, sCols);

  return wb;
}

export async function exportSchedulingWorkbook(params: {
  scheduleResult: ScheduleGenerationResult;
  shiftCatalog: ShiftTemplate[];
  rules: SchedulingRules;
  erlangConfig: ErlangConfig;
}): Promise<void> {
  const wb = await buildSchedulingWorkbook(params);
  await downloadWorkbook(
    wb,
    `WFM-Agent-Shift-Schedule-${new Date().toISOString().slice(0, 10)}.xlsx`
  );
}
