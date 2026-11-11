import * as XLSX from 'xlsx';
import type {
  CapacityConfig,
  CapacityResult,
  ErlangConfig,
  ErlangSummary,
  ForecastConfig,
  ForecastingStudioOutput,
  HistoricalPoint,
  WhatIfCell,
} from './types.ts';

export function exportFullSuiteWorkbook(params: {
  history: HistoricalPoint[];
  forecastConfig: ForecastConfig;
  forecastOutput: ForecastingStudioOutput;
  selectedModelId: string;
  erlangConfig: ErlangConfig;
  erlangSummary: ErlangSummary;
  capacityConfig: CapacityConfig;
  capacityResult: CapacityResult;
  whatIfMatrix: WhatIfCell[][];
  shrinkageDeltas: number[];
}): void {
  const {
    history,
    forecastConfig,
    forecastOutput,
    selectedModelId,
    erlangConfig,
    erlangSummary,
    capacityConfig,
    capacityResult,
    whatIfMatrix,
    shrinkageDeltas,
  } = params;

  const wb = XLSX.utils.book_new();

  // Sheet 1: Executive Summary
  const activeModel =
    forecastOutput.models.find((m) => m.modelId === selectedModelId) ?? forecastOutput.models[0];
  const summaryRows = [
    ['WFM & CAPACITY SUITE — EXECUTIVE SUMMARY (wfmforall.com)', ''],
    ['Generated At (UTC)', new Date().toISOString()],
    ['', ''],
    ['1. FORECASTING STUDIO', ''],
    ['Periodicity', forecastConfig.periodicity.toUpperCase()],
    ['Historical Observations', forecastOutput.cleanedSeries.length],
    ['Train / Holdout Split', `${forecastOutput.trainLength} / ${forecastOutput.holdoutLength} (80/20 Chronological)`],
    ['Selected Forecast Model', activeModel?.modelId.toUpperCase() ?? ''],
    ['Best Auto-Detected Model', forecastOutput.bestModelId.toUpperCase()],
    ['Holdout WMAPE (%)', Number((activeModel?.holdoutMetrics.wmape ?? 0).toFixed(2))],
    ['Holdout MAPE (%)', Number((activeModel?.holdoutMetrics.mape ?? 0).toFixed(2))],
    ['Holdout RMSE (Std Error)', Number((activeModel?.holdoutMetrics.rmse ?? 0).toFixed(2))],
    ['Holdout MAE / MAD', Number((activeModel?.holdoutMetrics.mae ?? 0).toFixed(2))],
    ['Holdout Bias (%)', Number((activeModel?.holdoutMetrics.bias ?? 0).toFixed(2))],
    ['Next Period Forecast Volume', Math.round(activeModel?.futureForecast[0] ?? 0)],
    ['', ''],
    ['2. INTERVAL & ERLANG PLANNER', ''],
    ['Planned Daily Volume', erlangConfig.dailyVolume],
    ['Interval Granularity (Minutes)', erlangConfig.granularityMin],
    ['Queue Model', erlangConfig.useErlangA ? `Erlang A (Patience ${erlangConfig.avgPatienceSec}s)` : 'Erlang C'],
    ['Global AHT (Seconds)', erlangConfig.globalAhtSec],
    ['SLA Target', `${erlangConfig.slTargetPct}% within ${erlangConfig.slThresholdSec}s`],
    ['Max Acceptable ASA (Seconds)', erlangConfig.maxAsaSec],
    ['Max Occupancy Cap (%)', erlangConfig.maxOccupancyPct],
    ['Total Pure Talk Hours (Erlang Hours)', Number(erlangSummary.totalPureTalkHours.toFixed(2))],
    ['Total Required Productive Hours', Number(erlangSummary.totalProductiveHours.toFixed(2))],
    ['Peak Interval Required Seats', `${erlangSummary.peakSeats} (@ ${erlangSummary.peakTimeLabel})`],
    ['Weighted Expected SLA (%)', Number(erlangSummary.weightedSlPct.toFixed(2))],
    ['Weighted Expected ASA (s)', Number(erlangSummary.weightedAsaSec.toFixed(2))],
    ['Average Agent Occupancy (%)', Number(erlangSummary.avgOccupancyPct.toFixed(2))],
    ['', ''],
    ['3. CAPACITY & SHRINKAGE WATERFALL', ''],
    ['Calculation Route', capacityConfig.route === 'erlang_c' ? 'Erlang C Route (No Occ Double-Count)' : 'Flat Top-Down Route'],
    ['Effective Paid / Login Shift Hours', Number(capacityResult.effectivePaidShiftHours.toFixed(2))],
    ['Weekly Roster Ratio', `${capacityConfig.operatingDaysPerWeek} Operating / ${capacityConfig.agentWorkdaysPerWeek} Agent Days (×${capacityResult.weeklyCoverageMultiplier.toFixed(2)})`],
    ['In-Office Shrinkage (%)', Number(capacityResult.inOfficeShrinkagePct.toFixed(2))],
    ['Out-of-Office Shrinkage (%)', Number(capacityResult.outOfOfficeShrinkagePct.toFixed(2))],
    ['Compound Total Shrinkage (%)', Number(capacityResult.compoundTotalShrinkagePct.toFixed(2))],
    ['Schedule Inefficiency (%)', Number(capacityConfig.scheduleInefficiencyPct.toFixed(2))],
    ['Attrition / Ramp Buffer (%)', Number(capacityConfig.attritionRampBufferPct.toFixed(2))],
    ['Net Productive Hours / FTE / Shift', Number(capacityResult.netProductiveHoursPerShiftPerFte.toFixed(2))],
    ['Daily Productive Seats Required', Number(capacityResult.dailyRequiredSeats.toFixed(2))],
    ['Scheduled Seats (Post Inefficiency)', Number(capacityResult.scheduledSeatsAfterInflex.toFixed(2))],
    ['Gross FTE Before Buffer', Number(capacityResult.grossFteBeforeBuffer.toFixed(2))],
    ['FINAL GROSS HEADCOUNT (FTE)', Number(capacityResult.finalGrossFte.toFixed(2))],
    ['Rounded Headcount (Ceiling)', Math.ceil(capacityResult.finalGrossFte)],
  ];
  const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
  wsSummary['!cols'] = [{ wch: 36 }, { wch: 34 }];
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Executive Summary');

  // Sheet 2: Model Comparison & Forecast
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
  XLSX.utils.book_append_sheet(wb, wsModels, 'Forecasting Studio');

  // Sheet 3: Interval Staffing Schedule
  const intervalHeader = [
    'Interval',
    'Status',
    'Arrival %',
    'Volume',
    'AHT (s)',
    'Traffic (Erlangs)',
    'Required Seats (N)',
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
    Number(r.arrivalPct.toFixed(2)),
    r.volume,
    r.ahtSec,
    Number(r.erlangs.toFixed(2)),
    r.requiredSeats,
    Number(r.productiveHours.toFixed(2)),
    Number(r.occupancyPct.toFixed(1)),
    Number(r.asaSec.toFixed(1)),
    Number(r.slPct.toFixed(1)),
    Number(r.probWaitPct.toFixed(1)),
    r.abandonPct != null ? Number(r.abandonPct.toFixed(2)) : 'N/A',
  ]);
  const wsIntervals = XLSX.utils.aoa_to_sheet([intervalHeader, ...intervalRows]);
  XLSX.utils.book_append_sheet(wb, wsIntervals, 'Interval Staffing');

  // Sheet 4: FTE Waterfall & What-If Matrix
  const wfHeader = ['Waterfall Stage', 'Workload Hours', 'FTE Equivalent', 'Incremental Delta FTE', 'Formula Note'];
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
    ...row.map((cell) => `${cell.finalGrossFte.toFixed(1)} FTE (${cell.deltaFte >= 0 ? '+' : ''}${cell.deltaFte.toFixed(1)})`),
  ]);

  const wsCapacity = XLSX.utils.aoa_to_sheet([
    wfHeader,
    ...wfRows,
    [],
    ['WHAT-IF SENSITIVITY MATRIX (FINAL GROSS FTE)', ''],
    matrixHeader,
    ...matrixRows,
  ]);
  wsCapacity['!cols'] = [{ wch: 34 }, { wch: 22 }, { wch: 22 }, { wch: 22 }, { wch: 24 }, { wch: 22 }];
  XLSX.utils.book_append_sheet(wb, wsCapacity, 'Capacity & What-If');

  XLSX.writeFile(wb, `WFM-Capacity-Plan-${new Date().toISOString().slice(0, 10)}.xlsx`);
}
