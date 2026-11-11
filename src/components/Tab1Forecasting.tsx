import React, { useMemo, useRef, useState } from 'react';
import {
  Upload,
  FileSpreadsheet,
  Sparkles,
  Award,
  ArrowRight,
  Sliders,
  AlertTriangle,
  CheckCircle2,
  BarChart3,
  Layers,
  Clock,
  ChevronDown,
  ChevronUp,
  Zap,
  Download,
} from 'lucide-react';
import type {
  DayKey,
  ForecastConfig,
  ForecastModelId,
  ForecastingStudioOutput,
  HistoricalPoint,
  ParsedDataset,
} from '../engine/types.ts';
import { parseFileDataset, parseTextDataset } from '../engine/parsers.ts';
import { buildFutureHorizonSummary } from '../engine/forecasting.ts';
import { SmartNumberInput } from './SmartNumberInput.tsx';
import { InteractiveForecastChart, InteractiveArrivalBarChart } from './InteractiveCharts.tsx';
import {
  ForecastStudioIcon,
  ErlangQueueIcon,
  CalendarHorizonIcon,
  WinnerTrophyIcon,
  ProMaxIconBadge,
} from './ProMaxIcons.tsx';

interface Tab1Props {
  history: HistoricalPoint[];
  setHistory: React.Dispatch<React.SetStateAction<HistoricalPoint[]>>;
  config: ForecastConfig;
  setConfig: React.Dispatch<React.SetStateAction<ForecastConfig>>;
  output: ForecastingStudioOutput;
  selectedModelId: ForecastModelId;
  setSelectedModelId: (id: ForecastModelId) => void;
  dowShares: Record<DayKey, number>;
  setDowShares: React.Dispatch<React.SetStateAction<Record<DayKey, number>>>;
  dayCurves: Record<DayKey, number[]>;
  byDateCurves: Record<string, number[]>;
  byDateTotals: Record<string, number>;
  operatingDaysPerMonth: number;
  setOperatingDaysPerMonth: (days: number) => void;
  onDatasetImported: (dataset: ParsedDataset) => void;
  onLoadSampleDaily: () => void;
  onLoadSampleMonthly: () => void;
  onPushToErlang: (
    dailyVolume: number,
    targetDay?: DayKey,
    dateIso?: string | null,
    customCurvePct?: number[]
  ) => void;
  onPushMonthlyToSuite: (monthlyVolume: number, monthDays: number) => void;
  onExportHorizonForecast?: (
    focusHorizon: 'next_week' | 'current_month' | 'next_month' | 'all'
  ) => void;
  onPlanMultiDayInErlang?: (
    scope: 'next_week' | 'custom_days' | 'all_days',
    customDaysCount?: number
  ) => void;
}

const DAY_KEYS: DayKey[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const JS_DAY_TO_KEY: DayKey[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const ALL_12_MODEL_META: Record<
  ForecastModelId,
  { nameEn: string; chapterTag: string; badgeColor: string; descEn: string }
> = {
  sma: {
    nameEn: '1. Unweighted Moving Average (SMA)',
    chapterTag: 'Carlberg Ch. 3',
    badgeColor: 'bg-slate-500/15 text-slate-600 dark:text-slate-300',
    descEn: 'Equal-weight rolling average of the last N observations.',
  },
  wma: {
    nameEn: '2. Weighted Moving Average (WMA)',
    chapterTag: 'Carlberg Ch. 3',
    badgeColor: 'bg-slate-500/15 text-slate-600 dark:text-slate-300',
    descEn: 'Recency-weighted rolling window assigning highest weight to latest periods.',
  },
  cma_decomposition: {
    nameEn: '3. Classical CMA Seasonal Decomposition',
    chapterTag: 'Carlberg Ch. 3 & 7',
    badgeColor: 'bg-purple-500/15 text-purple-600 dark:text-purple-300',
    descEn: 'Centered Moving Average (CMA) ratio-to-MA seasonal indices + deseasonalized trend.',
  },
  ses: {
    nameEn: '4. Simple Exponential Smoothing (SES)',
    chapterTag: 'Carlberg Ch. 4',
    badgeColor: 'bg-sky-500/15 text-sky-600 dark:text-sky-300',
    descEn: 'Single-parameter level smoothing F(t+1) = αY(t) + (1-α)F(t) via MultiStart.',
  },
  ses_differenced: {
    nameEn: '5. First-Differenced Exponential Smoothing (ΔY)',
    chapterTag: 'Carlberg Ch. 4',
    badgeColor: 'bg-sky-500/15 text-sky-600 dark:text-sky-300',
    descEn: 'Applies SES to first differences ΔY(t) = Y(t) - Y(t-1) to eliminate trend lag.',
  },
  holt: {
    nameEn: "6. Holt's Linear Exponential Smoothing",
    chapterTag: 'Carlberg Ch. 4',
    badgeColor: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-300',
    descEn: 'Two-parameter smoothing tracking both level (α) and linear trend slope (γ).',
  },
  holt_damped: {
    nameEn: '7. Damped-Trend Exponential Smoothing (φ)',
    chapterTag: 'Carlberg Ch. 4 & 12',
    badgeColor: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-300',
    descEn: 'Dampens runaway linear trends over longer horizons using autoregressive damping φ.',
  },
  holt_winters_add: {
    nameEn: '8. Holt-Winters Additive Seasonal',
    chapterTag: 'Carlberg Ch. 8',
    badgeColor: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
    descEn: 'Triple smoothing for level (α), trend (γ), and additive seasonal cycle (δ).',
  },
  holt_winters_mult: {
    nameEn: '9. Holt-Winters Multiplicative Seasonal',
    chapterTag: 'Carlberg Ch. 8',
    badgeColor: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
    descEn: 'Proportional seasonal ratios (Y / L) ideal for scaling contact center volume.',
  },
  linear_regression: {
    nameEn: '10. Simple Linear Regression (OLS TREND)',
    chapterTag: 'Carlberg Ch. 2 & 5',
    badgeColor: 'bg-amber-500/15 text-amber-600 dark:text-amber-300',
    descEn: 'Ordinary Least Squares trend line Y = a + bt with Slope, Intercept & R².',
  },
  multiple_regression: {
    nameEn: '11. Multiple Regression (Trend + Seasonal Dummies)',
    chapterTag: 'Carlberg Ch. 6',
    badgeColor: 'bg-amber-500/15 text-amber-600 dark:text-amber-300',
    descEn: 'Simultaneous OLS regression on time trend t plus m-1 seasonal indicator variables.',
  },
  box_jenkins_ar: {
    nameEn: '12. Box-Jenkins Autoregressive (AR / Seasonal ARIMA)',
    chapterTag: 'Carlberg Ch. 9 & 10',
    badgeColor: 'bg-rose-500/15 text-rose-600 dark:text-rose-300',
    descEn: 'Autoregressive lag model combining Lag-1 ACF (φ₁) and Seasonal Lag-m (Φₘ).',
  },
};

export const Tab1Forecasting: React.FC<Tab1Props> = ({
  history,
  setHistory,
  config,
  setConfig,
  output,
  selectedModelId,
  setSelectedModelId,
  dowShares,
  dayCurves,
  byDateCurves,
  byDateTotals,
  onDatasetImported,
  onPushToErlang,
  onPushMonthlyToSuite,
  onExportHorizonForecast,
  onPlanMultiDayInErlang,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [showAdvancedTuning, setShowAdvancedTuning] = useState(false);
  const [showOutlierTable, setShowOutlierTable] = useState(false);

  const activeModel = useMemo(
    () =>
      output.models.find((m) => m.modelId === selectedModelId) ??
      output.models.find((m) => m.isBest) ??
      output.models[0],
    [output.models, selectedModelId]
  );

  // Build Future Forecast Horizon Summary (Next Week / Current Month / Next Month)
  const futureSummary = useMemo(
    () => buildFutureHorizonSummary(history, activeModel, config.periodicity, dowShares),
    [history, activeModel, config.periodicity, dowShares]
  );

  // Date & Day Inspector State
  const [inspectMode, setInspectMode] = useState<'specific_date' | 'day_of_week'>('specific_date');
  const [selectedInspectDate, setSelectedInspectDate] = useState<string>('');
  const [selectedInspectDay, setSelectedInspectDay] = useState<DayKey>('Mon');

  // Available dates (both uploaded history dates and forecasted future dates)
  const availableDates = useMemo(() => {
    const list: { iso: string; label: string; volume: number; isForecast: boolean; dayKey: DayKey }[] = [];
    for (const pt of history) {
      if (pt.date && !pt.isExcluded) {
        const jsDay = new Date(`${pt.date}T00:00:00Z`).getUTCDay();
        const dk = JS_DAY_TO_KEY[jsDay] ?? 'Mon';
        list.push({
          iso: pt.date,
          label: `${pt.date} (${dk}) — Historical`,
          volume: byDateTotals[pt.date] ?? pt.volume,
          isForecast: false,
          dayKey: dk,
        });
      }
    }
    for (const fd of futureSummary.allFutureDays.slice(0, 30)) {
      list.push({
        iso: fd.dateIso,
        label: `${fd.dateIso} (${fd.dayKey}) — Forecast`,
        volume: fd.volume,
        isForecast: true,
        dayKey: fd.dayKey,
      });
    }
    return list;
  }, [history, byDateTotals, futureSummary.allFutureDays]);

  const effectiveInspectDateObj = useMemo(() => {
    if (selectedInspectDate) {
      const found = availableDates.find((d) => d.iso === selectedInspectDate);
      if (found) return found;
    }
    // Default to first Next Week forecast day or last historical date
    return (
      availableDates.find((d) => d.isForecast) ??
      availableDates[availableDates.length - 1] ?? {
        iso: '2026-11-12',
        label: '2026-11-12 (Thu)',
        volume: futureSummary.nextWeekDailyAvg,
        isForecast: true,
        dayKey: 'Thu' as DayKey,
      }
    );
  }, [selectedInspectDate, availableDates, futureSummary.nextWeekDailyAvg]);

  // Compute inspected day's volume & arrival curve
  const inspectedProfile = useMemo(() => {
    if (inspectMode === 'specific_date') {
      const iso = effectiveInspectDateObj.iso;
      const dk = effectiveInspectDateObj.dayKey;
      const curve = byDateCurves[iso] ?? dayCurves[dk] ?? dayCurves.Mon;
      const volume = effectiveInspectDateObj.volume;
      return {
        title: `${iso} (${dk}) ${effectiveInspectDateObj.isForecast ? '· Forecasted Day' : '· Historical Actual'}`,
        dateIso: iso,
        dayKey: dk,
        volume,
        curve,
        hasExactDateCurve: Boolean(byDateCurves[iso]),
      };
    } else {
      const dk = selectedInspectDay;
      const matchFuture = futureSummary.nextWeekDays.find((d) => d.dayKey === dk);
      const volume =
        matchFuture?.volume ??
        Math.round((futureSummary.nextWeekTotal * (dowShares[dk] ?? 100 / 7)) / 100);
      const curve = dayCurves[dk] ?? dayCurves.Mon;
      return {
        title: `${dk} Standard Profile · Next Week Projection`,
        dateIso: matchFuture?.dateIso ?? null,
        dayKey: dk,
        volume,
        curve,
        hasExactDateCurve: false,
      };
    }
  }, [
    inspectMode,
    effectiveInspectDateObj,
    selectedInspectDay,
    byDateCurves,
    dayCurves,
    futureSummary,
    dowShares,
  ]);

  const inspectedIntervalData = useMemo(() => {
    const curve = inspectedProfile.curve;
    const slots = curve.length;
    const gran = Math.round(1440 / Math.max(1, slots));
    return curve.map((pct, i) => {
      const totalMin = i * gran;
      const hh = String(Math.floor(totalMin / 60)).padStart(2, '0');
      const mm = String(totalMin % 60).padStart(2, '0');
      const calls = Math.round((inspectedProfile.volume * pct) / 100);
      return {
        time: `${hh}:${mm}`,
        arrivalPct: Number(pct.toFixed(2)),
        calls,
      };
    });
  }, [inspectedProfile]);

  const peakInspectedSlot = useMemo(() => {
    return inspectedIntervalData.reduce(
      (best, cur) => (cur.calls > best.calls ? cur : best),
      inspectedIntervalData[0] ?? { time: '11:00', arrivalPct: 4.5, calls: 0 }
    );
  }, [inspectedIntervalData]);

  // Build chart data combining Train, Holdout, and Future Forecast
  const chartData = useMemo(() => {
    const activePts = history.filter((p) => !p.isExcluded);
    const rows: Array<{
      index: number;
      label: string;
      actual?: number;
      trainFit?: number;
      holdoutPred?: number;
      futurePred?: number;
    }> = [];

    const trainLen = output.trainLength;
    for (let i = 0; i < activePts.length; i++) {
      const pt = activePts[i];
      const val = pt.isSmoothed
        ? (output.cleanedSeries[i] ?? pt.volume)
        : pt.volume;
      if (i < trainLen) {
        rows.push({
          index: i + 1,
          label: pt.label,
          actual: val,
          trainFit: Math.round(activeModel.fittedTrain[i] ?? val),
        });
      } else {
        const hIdx = i - trainLen;
        rows.push({
          index: i + 1,
          label: pt.label,
          actual: val,
          holdoutPred: Math.round(activeModel.holdoutPreds[hIdx] ?? val),
        });
      }
    }

    const previewHorizon = Math.min(14, activeModel.extendedFutureForecast.length);
    for (let h = 0; h < previewHorizon; h++) {
      const fDay = futureSummary.allFutureDays[h];
      rows.push({
        index: activePts.length + h + 1,
        label: fDay ? fDay.dateIso.slice(5) : `+${h + 1}`,
        futurePred: Math.round(activeModel.extendedFutureForecast[h]),
      });
    }
    return rows;
  }, [history, output, activeModel, futureSummary.allFutureDays]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError(null);
    try {
      const parsed = await parseFileDataset(file);
      onDatasetImported(parsed);
      setImportNotice(parsed.summaryNote);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Could not parse uploaded file.');
    } finally {
      e.target.value = '';
    }
  };

  const handlePasteSubmit = () => {
    setImportError(null);
    try {
      const parsed = parseTextDataset(pasteText);
      onDatasetImported(parsed);
      setImportNotice(parsed.summaryNote);
      setPasteOpen(false);
      setPasteText('');
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Could not parse pasted data.');
    }
  };

  const togglePointFlag = (id: string, field: 'isExcluded' | 'isSmoothed') => {
    setHistory((prev) =>
      prev.map((pt) => {
        if (pt.id !== id) return pt;
        const nextVal = !pt[field];
        return {
          ...pt,
          [field]: nextVal,
          ...(field === 'isExcluded' && nextVal ? { isSmoothed: false } : {}),
          ...(field === 'isSmoothed' && nextVal ? { isExcluded: false } : {}),
        };
      })
    );
  };

  const winnerMeta = ALL_12_MODEL_META[output.bestModelId] ?? ALL_12_MODEL_META.holt_winters_mult;
  const activeMeta = ALL_12_MODEL_META[activeModel.modelId] ?? ALL_12_MODEL_META.holt_winters_mult;

  return (
    <div className="space-y-6 animate-slide-up">
      {/* Guided 3-Step Onboarding Strip */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bento-card-promax card-elevated rounded-2xl border border-sky-500/30 bg-gradient-to-br from-sky-500/10 via-white to-white dark:from-sky-950/50 dark:via-slate-900 dark:to-slate-900 p-4 flex items-center gap-3.5 shadow-xs">
          <ProMaxIconBadge tone="cyan" size="lg" pulse>
            <Upload className="w-5 h-5" />
          </ProMaxIconBadge>
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-sky-600 dark:text-sky-400">
              Step 1 · Auto-Ingest Data
            </div>
            <div className="text-xs font-semibold text-slate-900 dark:text-white mt-0.5">
              Upload Excel/CSV or Paste Spreadsheet Table
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Auto-detects dates, intervals &amp; tests all 12 Carlberg models.
            </p>
          </div>
        </div>

        <div className="bento-card-promax card-elevated rounded-2xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 via-white to-white dark:from-emerald-950/40 dark:via-slate-900 dark:to-slate-900 p-4 flex items-center gap-3.5 shadow-xs">
          <ProMaxIconBadge tone="emerald" size="lg" pulse>
            <ForecastStudioIcon size={24} />
          </ProMaxIconBadge>
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
              Step 2 · Future Forecast Hub
            </div>
            <div className="text-xs font-semibold text-slate-900 dark:text-white mt-0.5">
              Next Week (Mon → Sun) · Current Month · Next Month
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Instant totals, daily splits &amp; 1-click capacity transfer.
            </p>
          </div>
        </div>

        <div className="bento-card-promax card-elevated rounded-2xl border border-indigo-500/30 bg-gradient-to-br from-indigo-500/10 via-white to-white dark:from-indigo-950/40 dark:via-slate-900 dark:to-slate-900 p-4 flex items-center gap-3.5 shadow-xs">
          <ProMaxIconBadge tone="violet" size="lg">
            <ErlangQueueIcon size={24} />
          </ProMaxIconBadge>
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
              Step 3 · Day &amp; Arrival Inspector
            </div>
            <div className="text-xs font-semibold text-slate-900 dark:text-white mt-0.5">
              Pick Any Date or Weekday Profile
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Inspect exact intraday arrival % &amp; staff it in Tab 2.
            </p>
          </div>
        </div>
      </div>

      {/* Simplified Action & Data Upload Bar (No Cryptic Statistical Jargon!) */}
      <div className="bento-card-promax rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="flex items-start gap-3">
            <ProMaxIconBadge tone="cyan" size="md">
              <FileSpreadsheet className="w-5 h-5" />
            </ProMaxIconBadge>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-bold text-slate-900 dark:text-white">
                  Data Source &amp; Auto-Forecasting Engine
                </h2>
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                  <Sparkles className="w-3 h-3" />
                  12 Carlberg Models Active
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Upload any Daily/Monthly CSV, 48×7 Heatmap, or Interval×Dates Pivot — periodicity and optimal smoothing parameters are calibrated automatically.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.tsv,.txt,.xlsx,.xls"
              onChange={handleFileUpload}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white px-4 py-2 text-xs font-semibold shadow-sm shadow-sky-600/20 transition cursor-pointer"
            >
              <Upload className="w-4 h-4" />
              Upload CSV / Excel
            </button>

            <button
              type="button"
              onClick={() => setPasteOpen((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 px-3.5 py-2 text-xs font-medium transition cursor-pointer"
            >
              Paste Table
            </button>

            <button
              type="button"
              onClick={() => setShowAdvancedTuning((v) => !v)}
              className="inline-flex items-center gap-1 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100/70 dark:bg-slate-950 px-3 py-2 text-[11px] font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition cursor-pointer"
            >
              <Sliders className="w-3.5 h-3.5" />
              Advanced Tuning
              {showAdvancedTuning ? (
                <ChevronUp className="w-3.5 h-3.5" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        </div>

        {importNotice && (
          <div className="mt-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 px-3.5 py-2 text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{importNotice}</span>
          </div>
        )}

        {importError && (
          <div className="mt-3 rounded-xl bg-rose-500/10 border border-rose-500/30 px-3.5 py-2 text-xs text-rose-600 dark:text-rose-300 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{importError}</span>
          </div>
        )}

        {pasteOpen && (
          <div className="mt-4 space-y-2 border-t border-slate-200 dark:border-slate-800 pt-4">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
              Paste Tab- or Comma-Separated rows from Excel (Date + Volume, 48×7 Heatmap, or Interval × Dates Pivot):
            </label>
            <textarea
              rows={4}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder={'2026-10-01\t2150\n2026-10-02\t1980\n2026-10-03\t1420'}
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 p-3 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-sky-500"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPasteOpen(false)}
                className="px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handlePasteSubmit}
                className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-sky-600 text-white hover:bg-sky-500"
              >
                Parse &amp; Auto-Calibrate
              </button>
            </div>
          </div>
        )}

        {/* Optional Collapsible Advanced Model Tuning Drawer (Hidden by default!) */}
        {showAdvancedTuning && (
          <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-950/50 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                Optional Statistical Overrides (Auto-Detected by Default)
              </span>
              <button
                type="button"
                onClick={() =>
                  setConfig((c) => ({
                    ...c,
                    autoOptimize: !c.autoOptimize,
                  }))
                }
                className={`px-3 py-1 rounded-lg text-xs font-semibold border transition cursor-pointer ${
                  config.autoOptimize
                    ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-700 dark:text-emerald-300'
                    : 'bg-amber-500/15 border-amber-500/40 text-amber-700 dark:text-amber-300'
                }`}
              >
                {config.autoOptimize ? 'Auto-Optimizer: ON (Recommended)' : 'Manual α / γ / δ Mode'}
              </button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  Data Periodicity
                </label>
                <select
                  value={config.periodicity}
                  onChange={(e) => {
                    const p = e.target.value as ForecastConfig['periodicity'];
                    setConfig((c) => ({
                      ...c,
                      periodicity: p,
                      seasonLength: p === 'daily' ? 7 : p === 'weekly' ? 4 : 12,
                    }));
                  }}
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs"
                >
                  <option value="daily">Daily Series</option>
                  <option value="weekly">Weekly Series</option>
                  <option value="monthly">Monthly Series</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  Seasonal Cycle (m)
                </label>
                <SmartNumberInput
                  min={2}
                  max={52}
                  decimals={0}
                  value={config.seasonLength}
                  onChange={(v) =>
                    setConfig((c) => ({
                      ...c,
                      seasonLength: Math.max(2, Math.round(v)),
                    }))
                  }
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs tabular-nums"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  Holdout Split %
                </label>
                <SmartNumberInput
                  min={10}
                  max={40}
                  decimals={0}
                  value={Math.round(config.holdoutRatio * 100)}
                  onChange={(v) =>
                    setConfig((c) => ({
                      ...c,
                      holdoutRatio: Math.min(0.4, Math.max(0.1, v / 100)),
                    }))
                  }
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs tabular-nums"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  SMA Window (N)
                </label>
                <SmartNumberInput
                  min={2}
                  max={30}
                  decimals={0}
                  value={config.smaWindow}
                  onChange={(v) =>
                    setConfig((c) => ({
                      ...c,
                      smaWindow: Math.max(2, Math.round(v)),
                    }))
                  }
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs tabular-nums"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  Chart Horizon
                </label>
                <SmartNumberInput
                  min={1}
                  max={60}
                  decimals={0}
                  value={config.horizon}
                  onChange={(v) =>
                    setConfig((c) => ({
                      ...c,
                      horizon: Math.max(1, Math.min(60, Math.round(v))),
                    }))
                  }
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs tabular-nums"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* =====================================================================
          FUTURE FORECAST COMMAND CENTER: NEXT WEEK · CURRENT MONTH · NEXT MONTH
          ===================================================================== */}
      <div className="space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div className="flex items-center gap-3">
            <ProMaxIconBadge tone="emerald" size="md" pulse>
              <Zap className="w-4 h-4" />
            </ProMaxIconBadge>
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-white">
                Future Forecast Command Center (Next Week · Current Month · Next Month)
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Powered by active model:{' '}
                <strong className="text-sky-600 dark:text-sky-400">{activeMeta.nameEn}</strong>{' '}
                (Holdout WMAPE: <strong>{activeModel.holdoutMetrics.wmape.toFixed(2)}%</strong>)
              </p>
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 border border-amber-500/30 px-3 py-1 text-xs font-semibold text-amber-600 dark:text-amber-400">
            <WinnerTrophyIcon size={16} />
            Best Model: {winnerMeta.nameEn}
          </span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Card 1: Next Week Forecast (7 Days) */}
          <div className="bento-card-promax card-elevated rounded-2xl border-2 border-sky-500/35 bg-gradient-to-b from-sky-500/10 via-white to-white dark:from-sky-950/40 dark:via-slate-900 dark:to-slate-900 p-5 shadow-sm flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500/15 px-2.5 py-1 text-xs font-bold text-sky-600 dark:text-sky-400">
                  <CalendarHorizonIcon tone="cyan" size={16} />
                  Next Week Forecast (Mon → Sun)
                </span>
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-mono text-slate-400">
                    {futureSummary.nextWeekDays[0]?.dateIso.slice(5)} →{' '}
                    {futureSummary.nextWeekDays[6]?.dateIso.slice(5)}
                  </span>
                  {onExportHorizonForecast && (
                    <button
                      type="button"
                      onClick={() => onExportHorizonForecast('next_week')}
                      title="Export Next Week Forecast & 7-Day Intervals (.xlsx)"
                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-2 py-1 text-[10px] font-bold shadow-xs transition cursor-pointer"
                    >
                      <Download className="w-3 h-3" />
                      Export .xlsx
                    </button>
                  )}
                </div>
              </div>

              <div className="mt-4 flex items-baseline justify-between">
                <div>
                  <div className="text-[11px] uppercase tracking-wider font-semibold text-slate-400">
                    Total Projected Weekly Calls
                  </div>
                  <div className="text-3xl font-extrabold tabular-nums text-slate-900 dark:text-white mt-0.5">
                    {futureSummary.nextWeekTotal.toLocaleString()}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] text-slate-400">Daily Avg</div>
                  <div className="text-lg font-bold tabular-nums text-sky-600 dark:text-sky-400">
                    {futureSummary.nextWeekDailyAvg.toLocaleString()}/d
                  </div>
                </div>
              </div>

              {/* 7-Day Interactive Breakdown Strip */}
              <div className="mt-4 pt-3 border-t border-slate-200/80 dark:border-slate-800">
                <div className="text-[11px] font-semibold text-slate-500 mb-2 flex items-center justify-between">
                  <span>Click any day to inspect or plan intervals:</span>
                  <span className="text-amber-600 dark:text-amber-400">
                    Peak: {futureSummary.nextWeekPeakDay?.dayKey} (
                    {futureSummary.nextWeekPeakDay?.volume.toLocaleString()})
                  </span>
                </div>
                <div className="grid grid-cols-7 gap-1">
                  {futureSummary.nextWeekDays.map((d) => {
                    const isPeak = d.dateIso === futureSummary.nextWeekPeakDay?.dateIso;
                    const activeNextDayIso =
                      futureSummary.nextWeekDays.find((nd) => nd.dateIso === selectedInspectDate)
                        ?.dateIso ?? futureSummary.nextWeekDays[0]?.dateIso;
                    const isSelectedDay = d.dateIso === activeNextDayIso;
                    return (
                      <button
                        key={d.dateIso}
                        type="button"
                        onClick={() => {
                          setInspectMode('specific_date');
                          setSelectedInspectDate(d.dateIso);
                        }}
                        className={`rounded-lg p-1.5 text-center border transition cursor-pointer ${
                          isSelectedDay
                            ? 'border-sky-500 bg-sky-500/15 ring-2 ring-sky-500'
                            : isPeak
                              ? 'border-amber-500/40 bg-amber-500/10'
                              : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 hover:border-sky-400'
                        }`}
                      >
                        <div className="text-[10px] font-bold text-slate-600 dark:text-slate-300">
                          {d.dayKey}
                        </div>
                        <div className="text-[9px] text-slate-400">{d.dateIso.slice(8)}</div>
                        <div className="text-[11px] font-bold tabular-nums text-slate-900 dark:text-white mt-0.5">
                          {d.volume >= 1000 ? `${(d.volume / 1000).toFixed(1)}k` : d.volume}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {(() => {
              const chosenDay =
                futureSummary.nextWeekDays.find((nd) => nd.dateIso === selectedInspectDate) ??
                futureSummary.nextWeekDays[0];
              return (
                <div className="mt-4 pt-3 border-t border-slate-200/70 dark:border-slate-800 space-y-2">
                  {/* Primary Row: Plan Selected Day Intervals OR Plan Full Week (7d) Intervals */}
                  <div className="flex items-center gap-2">
                    {chosenDay && (
                      <button
                        type="button"
                        onClick={() =>
                          onPushToErlang(
                            chosenDay.volume,
                            chosenDay.dayKey,
                            chosenDay.dateIso,
                            byDateCurves[chosenDay.dateIso] ?? dayCurves[chosenDay.dayKey]
                          )
                        }
                        className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white px-3 py-2 text-xs font-bold shadow-xs transition cursor-pointer"
                      >
                        Plan {chosenDay.dayKey} {chosenDay.dateIso.slice(8)} (
                        {chosenDay.volume.toLocaleString()})
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {onPlanMultiDayInErlang && (
                      <button
                        type="button"
                        onClick={() => onPlanMultiDayInErlang('next_week')}
                        className="inline-flex items-center justify-center gap-1 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-2 text-xs font-bold shadow-xs transition cursor-pointer"
                      >
                        Plan 7d Week
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  {/* Secondary Quick Actions Row: Avg Day, Peak Day, 10 Days, All Days */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        onPushToErlang(
                          futureSummary.nextWeekDailyAvg,
                          futureSummary.nextWeekPeakDay?.dayKey ?? 'Mon'
                        )
                      }
                      className="flex-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 hover:border-sky-400 px-2 py-1 text-[11px] font-semibold transition cursor-pointer"
                    >
                      Avg Day ({futureSummary.nextWeekDailyAvg.toLocaleString()})
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        onPushToErlang(
                          futureSummary.nextWeekPeakDay.volume,
                          futureSummary.nextWeekPeakDay.dayKey,
                          futureSummary.nextWeekPeakDay.dateIso
                        )
                      }
                      className="rounded-lg border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 px-2 py-1 text-[11px] font-semibold text-amber-700 dark:text-amber-300 transition cursor-pointer"
                    >
                      Peak ({futureSummary.nextWeekPeakDay?.dayKey})
                    </button>
                    {onPlanMultiDayInErlang && (
                      <button
                        type="button"
                        onClick={() => onPlanMultiDayInErlang('custom_days', 10)}
                        className="rounded-lg border border-sky-500/40 bg-sky-500/10 hover:bg-sky-500/20 px-2 py-1 text-[11px] font-semibold text-sky-700 dark:text-sky-300 transition cursor-pointer"
                      >
                        10d Intervals
                      </button>
                    )}
                  </div>
                </div>
              );
            })()}
          </div>

          {/* Card 2: Current Month Forecast (Days 1–30) */}
          <div className="card-elevated rounded-2xl border-2 border-emerald-500/35 bg-gradient-to-b from-emerald-500/10 via-white to-white dark:from-emerald-950/40 dark:via-slate-900 dark:to-slate-900 p-5 shadow-sm flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/15 px-2.5 py-1 text-xs font-bold text-emerald-600 dark:text-emerald-400">
                  <BarChart3 className="w-3.5 h-3.5" />
                  Current Month Forecast (30d)
                </span>
                <span className="text-[11px] font-mono text-slate-400">
                  {futureSummary.currentMonthLabel}
                </span>
              </div>

              <div className="mt-4 flex items-baseline justify-between">
                <div>
                  <div className="text-[11px] uppercase tracking-wider font-semibold text-slate-400">
                    Projected Current Month Volume
                  </div>
                  <div className="text-3xl font-extrabold tabular-nums text-slate-900 dark:text-white mt-0.5">
                    {futureSummary.currentMonthTotal.toLocaleString()}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] text-slate-400">Daily Offered (÷30)</div>
                  <div className="text-lg font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                    {futureSummary.currentMonthDailyAvg.toLocaleString()}/d
                  </div>
                </div>
              </div>

              {/* 4-Week Breakdown inside Current Month */}
              <div className="mt-4 pt-3 border-t border-slate-200/80 dark:border-slate-800 space-y-1.5">
                <div className="text-[11px] font-semibold text-slate-500 flex justify-between">
                  <span>Weekly Split (Current Month):</span>
                  <span className="font-mono">
                    Hourly (÷24): {Math.round(futureSummary.currentMonthDailyAvg / 24)} calls/hr
                  </span>
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  {[0, 1, 2, 3].map((wIdx) => {
                    const slice = futureSummary.currentMonthDays.slice(
                      wIdx * 7,
                      wIdx === 3 ? 30 : (wIdx + 1) * 7
                    );
                    const wSum = slice.reduce((a, b) => a + b.volume, 0);
                    return (
                      <div
                        key={wIdx}
                        className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-2 text-center"
                      >
                        <div className="text-[10px] font-semibold text-slate-400">
                          {wIdx === 3 ? 'Wk 4 (+2d)' : `Week ${wIdx + 1}`}
                        </div>
                        <div className="text-xs font-bold tabular-nums text-slate-800 dark:text-slate-200 mt-0.5">
                          {wSum.toLocaleString()}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-slate-200/70 dark:border-slate-800">
              <button
                type="button"
                onClick={() => onPushMonthlyToSuite(futureSummary.currentMonthTotal, 30)}
                className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white px-3.5 py-2 text-xs font-semibold shadow-xs transition cursor-pointer"
              >
                Plan Current Month Capacity ({futureSummary.currentMonthTotal.toLocaleString()})
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Card 3: Next Month Forecast (Days 31–60) */}
          <div className="card-elevated rounded-2xl border-2 border-indigo-500/35 bg-gradient-to-b from-indigo-500/10 via-white to-white dark:from-indigo-950/40 dark:via-slate-900 dark:to-slate-900 p-5 shadow-sm flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-500/15 px-2.5 py-1 text-xs font-bold text-indigo-600 dark:text-indigo-400">
                  <Layers className="w-3.5 h-3.5" />
                  Next Month Forecast (Days 31–60)
                </span>
                <span
                  className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
                    futureSummary.nextMonthGrowthPct >= 0
                      ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                      : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                  }`}
                >
                  {futureSummary.nextMonthGrowthPct >= 0 ? '+' : ''}
                  {futureSummary.nextMonthGrowthPct.toFixed(1)}% vs Cur Month
                </span>
              </div>

              <div className="mt-4 flex items-baseline justify-between">
                <div>
                  <div className="text-[11px] uppercase tracking-wider font-semibold text-slate-400">
                    Projected Next Month Volume
                  </div>
                  <div className="text-3xl font-extrabold tabular-nums text-slate-900 dark:text-white mt-0.5">
                    {futureSummary.nextMonthTotal.toLocaleString()}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] text-slate-400">Daily Offered (÷30)</div>
                  <div className="text-lg font-bold tabular-nums text-indigo-600 dark:text-indigo-400">
                    {futureSummary.nextMonthDailyAvg.toLocaleString()}/d
                  </div>
                </div>
              </div>

              {/* 4-Week Breakdown inside Next Month */}
              <div className="mt-4 pt-3 border-t border-slate-200/80 dark:border-slate-800 space-y-1.5">
                <div className="text-[11px] font-semibold text-slate-500 flex justify-between">
                  <span>Weekly Split (Next Month):</span>
                  <span className="font-mono">
                    Hourly (÷24): {Math.round(futureSummary.nextMonthDailyAvg / 24)} calls/hr
                  </span>
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  {[0, 1, 2, 3].map((wIdx) => {
                    const slice = futureSummary.nextMonthDays.slice(
                      wIdx * 7,
                      wIdx === 3 ? 30 : (wIdx + 1) * 7
                    );
                    const wSum = slice.reduce((a, b) => a + b.volume, 0);
                    return (
                      <div
                        key={wIdx}
                        className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-2 text-center"
                      >
                        <div className="text-[10px] font-semibold text-slate-400">
                          {wIdx === 3 ? 'Wk 8 (+2d)' : `Week ${wIdx + 5}`}
                        </div>
                        <div className="text-xs font-bold tabular-nums text-slate-800 dark:text-slate-200 mt-0.5">
                          {wSum.toLocaleString()}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-slate-200/70 dark:border-slate-800">
              <button
                type="button"
                onClick={() => onPushMonthlyToSuite(futureSummary.nextMonthTotal, 30)}
                className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white px-3.5 py-2 text-xs font-semibold shadow-xs transition cursor-pointer"
              >
                Plan Next Month Capacity ({futureSummary.nextMonthTotal.toLocaleString()})
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* =====================================================================
          INTERACTIVE DATE & DAY ARRIVAL PATTERN INSPECTOR
          ("اختار يوم معين يطلعلي الداتا بتاعته و Arrival Pattern")
          ===================================================================== */}
      <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 pb-4 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-start gap-3">
            <div className="icon-badge-glow w-10 h-10 rounded-xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-600 dark:text-indigo-400 shrink-0">
              <Clock className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white">
                Specific Date &amp; Day-of-Week Arrival Pattern Inspector
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Select any historical or forecasted date (or a weekday profile) to inspect its exact call volume and intraday arrival pattern (%) curve.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Mode Switcher: Specific Date vs Day of Week */}
            <div className="inline-flex rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-950 p-1">
              <button
                type="button"
                onClick={() => setInspectMode('specific_date')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                  inspectMode === 'specific_date'
                    ? 'bg-white dark:bg-slate-800 text-sky-600 dark:text-sky-400 shadow-xs'
                    : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                Pick Specific Date
              </button>
              <button
                type="button"
                onClick={() => setInspectMode('day_of_week')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                  inspectMode === 'day_of_week'
                    ? 'bg-white dark:bg-slate-800 text-sky-600 dark:text-sky-400 shadow-xs'
                    : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                Pick Weekday (Mon–Sun)
              </button>
            </div>

            {inspectMode === 'specific_date' ? (
              <select
                value={effectiveInspectDateObj.iso}
                onChange={(e) => setSelectedInspectDate(e.target.value)}
                aria-label="Select specific date to inspect"
                className="rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100"
              >
                {availableDates.map((d) => (
                  <option key={d.iso} value={d.iso}>
                    {d.label} ({d.volume.toLocaleString()} calls)
                  </option>
                ))}
              </select>
            ) : (
              <div className="flex items-center gap-1">
                {DAY_KEYS.map((dk) => (
                  <button
                    key={dk}
                    type="button"
                    onClick={() => setSelectedInspectDay(dk)}
                    className={`px-2.5 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                      selectedInspectDay === dk
                        ? 'bg-sky-600 text-white shadow-xs'
                        : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200'
                    }`}
                  >
                    {dk}
                  </button>
                ))}
              </div>
            )}

            <button
              type="button"
              onClick={() =>
                onPushToErlang(
                  inspectedProfile.volume,
                  inspectedProfile.dayKey,
                  inspectedProfile.dateIso,
                  inspectedProfile.curve
                )
              }
              className="inline-flex items-center gap-1.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white px-4 py-2 text-xs font-semibold shadow-xs transition cursor-pointer"
            >
              Staff This Day in Tab 2 ({inspectedProfile.volume.toLocaleString()})
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Summary KPI Strip + Intraday Arrival Pattern Chart */}
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 mt-4 items-center">
          <div className="space-y-3">
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 p-3.5">
              <div className="text-[11px] font-medium text-slate-400">Selected Day / Date</div>
              <div className="text-sm font-bold text-slate-900 dark:text-white mt-0.5">
                {inspectedProfile.title}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 p-3">
                <div className="text-[10px] uppercase font-semibold text-slate-400">
                  Day Call Volume
                </div>
                <div className="text-xl font-extrabold tabular-nums text-sky-600 dark:text-sky-400 mt-0.5">
                  {inspectedProfile.volume.toLocaleString()}
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 p-3">
                <div className="text-[10px] uppercase font-semibold text-slate-400">
                  Peak Interval
                </div>
                <div className="text-sm font-extrabold tabular-nums text-emerald-600 dark:text-emerald-400 mt-0.5">
                  {peakInspectedSlot.time} ({peakInspectedSlot.arrivalPct}%)
                </div>
                <div className="text-[10px] text-slate-400 tabular-nums">
                  {peakInspectedSlot.calls.toLocaleString()} calls
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 p-3 text-[11px] text-slate-500 dark:text-slate-400">
              Weekday Share ({inspectedProfile.dayKey}):{' '}
              <strong className="text-slate-800 dark:text-slate-200">
                {(dowShares[inspectedProfile.dayKey] ?? 14.3).toFixed(1)}%
              </strong>{' '}
              of weekly volume · Curve Sum: <strong>100.0%</strong>
            </div>
          </div>

          <div className="lg:col-span-3">
            <InteractiveArrivalBarChart
              intervals={inspectedIntervalData}
              peakSlot={peakInspectedSlot}
            />
          </div>
        </div>
      </div>

      {/* =====================================================================
          ALL 12 CONRAD CARLBERG FORECASTING MODELS LEADERBOARD & TRAJECTORY
          ===================================================================== */}
      <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-xs">
        <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h3 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
              All 12 Conrad Carlberg Forecasting Methods (Holdout Validation Leaderboard)
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Every method from Conrad Carlberg&apos;s <em>Predictive Analytics: Microsoft Excel</em> (Ch. 2–10) evaluated on the unseen {Math.round(config.holdoutRatio * 100)}% chronological holdout set. Click any row to switch the active forecast.
            </p>
          </div>
          <div className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 border border-amber-500/30 px-3 py-1 text-xs font-semibold text-amber-600 dark:text-amber-400">
            <Award className="w-3.5 h-3.5" />
            Winner: {winnerMeta.nameEn}
          </div>
        </div>

        {/* Interactive Trajectory SVG Chart */}
        <div className="p-5 border-b border-slate-100 dark:border-slate-800/80">
          <InteractiveForecastChart data={chartData} />
        </div>

        {/* 12-Model Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-500">
                <th className="py-2.5 px-4 font-semibold">Forecasting Method (Conrad Carlberg Book)</th>
                <th className="py-2.5 px-3 font-semibold">Book Ref</th>
                <th className="py-2.5 px-3 font-semibold text-right">WMAPE %</th>
                <th className="py-2.5 px-3 font-semibold text-right">MAPE %</th>
                <th className="py-2.5 px-3 font-semibold text-right">RMSE (Std Err)</th>
                <th className="py-2.5 px-3 font-semibold text-right">MAE / MAD</th>
                <th className="py-2.5 px-3 font-semibold text-right">Bias %</th>
                <th className="py-2.5 px-3 font-semibold">Calibrated Parameters</th>
                <th className="py-2.5 px-4 font-semibold text-right">Next Week (7d)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200/70 dark:divide-slate-800/70">
              {output.models.map((m) => {
                const meta = ALL_12_MODEL_META[m.modelId] ?? {
                  nameEn: m.modelId,
                  chapterTag: 'Carlberg',
                  badgeColor: 'bg-slate-500/15 text-slate-400',
                  descEn: '',
                };
                const isSelected = m.modelId === activeModel.modelId;
                const paramStr = Object.entries(m.params)
                  .map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.join(',')}]` : v}`)
                  .join(' · ');
                const next7Sum = m.extendedFutureForecast
                  .slice(0, 7)
                  .reduce((s, v) => s + Math.round(v), 0);

                return (
                  <tr
                    key={m.modelId}
                    onClick={() => setSelectedModelId(m.modelId)}
                    className={`cursor-pointer transition ${
                      isSelected
                        ? 'bg-sky-500/10 dark:bg-sky-500/15'
                        : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
                    }`}
                  >
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <input
                          type="radio"
                          checked={isSelected}
                          onChange={() => setSelectedModelId(m.modelId)}
                          className="accent-sky-500"
                        />
                        <div>
                          <div className="font-bold text-slate-900 dark:text-white flex items-center gap-2">
                            {meta.nameEn}
                            {m.isBest && (
                              <span className="rounded bg-emerald-500/15 border border-emerald-500/40 px-1.5 py-0.5 text-[10px] font-bold text-emerald-600 dark:text-emerald-300">
                                BEST MODEL
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400">
                            {meta.descEn}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-3">
                      <span
                        className={`inline-block rounded-md px-2 py-0.5 text-[10px] font-bold ${meta.badgeColor}`}
                      >
                        {meta.chapterTag}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-right font-bold tabular-nums text-slate-900 dark:text-white">
                      {m.holdoutMetrics.wmape.toFixed(2)}%
                    </td>
                    <td className="py-3 px-3 text-right tabular-nums">
                      {m.holdoutMetrics.mape.toFixed(2)}%
                    </td>
                    <td className="py-3 px-3 text-right tabular-nums">
                      {m.holdoutMetrics.rmse.toFixed(1)}
                    </td>
                    <td className="py-3 px-3 text-right tabular-nums">
                      {m.holdoutMetrics.mae.toFixed(1)}
                    </td>
                    <td className="py-3 px-3 text-right tabular-nums">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${
                          Math.abs(m.holdoutMetrics.bias) <= 3
                            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                            : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                        }`}
                      >
                        {m.holdoutMetrics.bias > 0 ? '+' : ''}
                        {m.holdoutMetrics.bias.toFixed(2)}%
                      </span>
                    </td>
                    <td className="py-3 px-3 font-mono text-[11px] text-slate-500 dark:text-slate-400">
                      {paramStr}
                      {m.r2 !== undefined ? ` · R²=${m.r2.toFixed(3)}` : ''}
                    </td>
                    <td className="py-3 px-4 text-right font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                      {next7Sum.toLocaleString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Collapsible Outlier & Holiday Cleaner */}
      <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-xs">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300">
              Outlier &amp; Holiday Data Cleaner ({history.length} observations)
            </h3>
            <p className="text-[11px] text-slate-500">
              Optional: Flag technical outages or public holidays to smooth or exclude them before training.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowOutlierTable((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
          >
            {showOutlierTable ? 'Hide Historical Rows' : 'Manage Outliers / Holidays'}
            {showOutlierTable ? (
              <ChevronUp className="w-3.5 h-3.5" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5" />
            )}
          </button>
        </div>

        {showOutlierTable && (
          <div className="mt-3 max-h-60 overflow-y-auto border border-slate-200 dark:border-slate-800 rounded-xl">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="sticky top-0 bg-slate-100 dark:bg-slate-950 text-slate-500">
                <tr>
                  <th className="py-2 px-3">#</th>
                  <th className="py-2 px-3">Date / Period</th>
                  <th className="py-2 px-3 text-right">Raw Volume</th>
                  <th className="py-2 px-3 text-center">Holiday / Outage Handling</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200/60 dark:divide-slate-800/60">
                {history.map((pt, idx) => (
                  <tr key={pt.id}>
                    <td className="py-1.5 px-3 font-mono text-slate-400">{idx + 1}</td>
                    <td className="py-1.5 px-3 font-mono">{pt.label}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums font-medium">
                      {pt.volume.toLocaleString()}
                    </td>
                    <td className="py-1.5 px-3 text-center">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => togglePointFlag(pt.id, 'isSmoothed')}
                          className={`px-2 py-0.5 rounded text-[11px] font-medium border cursor-pointer ${
                            pt.isSmoothed
                              ? 'bg-amber-500/20 border-amber-500/50 text-amber-600 dark:text-amber-300'
                              : 'border-slate-300 dark:border-slate-700 text-slate-500'
                          }`}
                        >
                          Smooth
                        </button>
                        <button
                          type="button"
                          onClick={() => togglePointFlag(pt.id, 'isExcluded')}
                          className={`px-2 py-0.5 rounded text-[11px] font-medium border cursor-pointer ${
                            pt.isExcluded
                              ? 'bg-rose-500/20 border-rose-500/50 text-rose-600 dark:text-rose-300'
                              : 'border-slate-300 dark:border-slate-700 text-slate-500'
                          }`}
                        >
                          Exclude
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
