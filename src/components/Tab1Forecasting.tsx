import React, { useRef, useState } from 'react';
import {
  Upload,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  Sliders,
  Database,
  ClipboardPaste,
  Award,
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

const MODEL_NAMES: Record<ForecastModelId, { name: string; badge: string; desc: string }> = {
  sma: {
    name: 'Unweighted Moving Average (SMA)',
    badge: 'Moving Avg',
    desc: 'Equal-weight rolling window of last N observations (Carlberg Ch. 3)',
  },
  wma: {
    name: 'Weighted Moving Average (WMA)',
    badge: 'Weighted MA',
    desc: 'Custom recency-weighted moving window with Σw = 1',
  },
  ses: {
    name: 'Simple Exponential Smoothing (SES)',
    badge: 'Single Exp',
    desc: 'Level smoothing F(t+1) = αY(t) + (1-α)F(t) with auto α search (Carlberg Ch. 4)',
  },
  holt: {
    name: "Holt's Linear Exponential Smoothing",
    badge: 'Level + Trend',
    desc: 'Dual smoothing for level (α) and linear trend (γ) (Carlberg Ch. 4)',
  },
  holt_winters_add: {
    name: 'Holt-Winters Additive Seasonal',
    badge: 'Triple Add',
    desc: 'Level (α), trend (γ), and additive seasonal index (δ) over cycle m',
  },
  holt_winters_mult: {
    name: 'Holt-Winters Multiplicative Seasonal',
    badge: 'Triple Mult',
    desc: 'Proportional seasonality (Y / L) ideal for growing contact center volume',
  },
  linear_regression: {
    name: 'Linear Regression (OLS Time-Series)',
    badge: 'y = a + bt',
    desc: 'Ordinary Least Squares trend line with Slope, Intercept & R² (Carlberg Ch. 2)',
  },
};

const DAY_KEYS: DayKey[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

interface Props {
  history: HistoricalPoint[];
  setHistory: React.Dispatch<React.SetStateAction<HistoricalPoint[]>>;
  config: ForecastConfig;
  setConfig: React.Dispatch<React.SetStateAction<ForecastConfig>>;
  output: ForecastingStudioOutput;
  selectedModelId: ForecastModelId;
  setSelectedModelId: (id: ForecastModelId) => void;
  dowShares: Record<DayKey, number>;
  setDowShares: React.Dispatch<React.SetStateAction<Record<DayKey, number>>>;
  operatingDaysPerMonth: number;
  setOperatingDaysPerMonth: (d: number) => void;
  onDatasetImported: (dataset: ParsedDataset) => void;
  onLoadSampleDaily: () => void;
  onLoadSampleMonthly: () => void;
  onPushToErlang: (dailyVolume: number, targetDay?: DayKey) => void;
}

export const Tab1Forecasting: React.FC<Props> = ({
  history,
  setHistory,
  config,
  setConfig,
  output,
  selectedModelId,
  setSelectedModelId,
  dowShares,
  setDowShares,
  operatingDaysPerMonth,
  setOperatingDaysPerMonth,
  onDatasetImported,
  onLoadSampleDaily,
  onLoadSampleMonthly,
  onPushToErlang,
}) => {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [showPaste, setShowPaste] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [importBanner, setImportBanner] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [bridgeIndex, setBridgeIndex] = useState<number>(0);
  const [bridgeDay, setBridgeDay] = useState<DayKey>('Mon');

  const activeModel =
    output.models.find((m) => m.modelId === selectedModelId) ?? output.models[0];

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError(null);
    try {
      const parsed = await parseFileDataset(file);
      onDatasetImported(parsed);
      setImportBanner(`${file.name}: ${parsed.summaryNote}`);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Failed to parse file.');
    } finally {
      e.target.value = '';
    }
  };

  const handlePasteApply = () => {
    if (!pasteText.trim()) return;
    setImportError(null);
    try {
      const parsed = parseTextDataset(pasteText);
      onDatasetImported(parsed);
      setImportBanner(`Pasted data: ${parsed.summaryNote}`);
      setShowPaste(false);
      setPasteText('');
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Failed to parse pasted text.');
    }
  };

  const updatePointFlag = (
    idx: number,
    mode: 'clean' | 'smooth' | 'exclude',
    customVal?: number
  ) => {
    setHistory((prev) =>
      prev.map((pt, i) => {
        if (i !== idx) return pt;
        if (mode === 'clean') {
          return { ...pt, isExcluded: false, isSmoothed: false, smoothedVolume: undefined };
        }
        if (mode === 'exclude') {
          return { ...pt, isExcluded: true, isSmoothed: false };
        }
        return {
          ...pt,
          isExcluded: false,
          isSmoothed: true,
          smoothedVolume: customVal ?? pt.smoothedVolume,
        };
      })
    );
  };

  // Compute Granularity Bridge Daily Volume
  const selectedHorizonValue =
    activeModel?.futureForecast[Math.min(bridgeIndex, (activeModel?.futureForecast.length ?? 1) - 1)] ?? 0;

  const dowShareTotal = DAY_KEYS.reduce((s, d) => s + (dowShares[d] ?? 0), 0) || 100;
  const normalizedDowShare = (dowShares[bridgeDay] ?? 14.28) / dowShareTotal;

  let bridgedDailyVolume = Math.round(selectedHorizonValue);
  if (config.periodicity === 'weekly') {
    bridgedDailyVolume = Math.round(selectedHorizonValue * normalizedDowShare);
  } else if (config.periodicity === 'monthly') {
    const avgWeeklyVol = (selectedHorizonValue / Math.max(1, operatingDaysPerMonth)) * 7;
    bridgedDailyVolume = Math.round(avgWeeklyVol * normalizedDowShare);
  }

  return (
    <div className="space-y-6">
      {/* Data Source & Controls Header */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 dark:border-slate-800 pb-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <Database className="w-4 h-4 text-sky-500" />
              Historical Data &amp; Backtesting Setup
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Supports Simple Daily/Monthly CSV, 48×7 Intraday Heatmap, or Cross-Tab Pivot (Interval × Dates).
            </p>
          </div>

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
              className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white px-3.5 py-2 text-xs font-medium transition cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              Upload CSV / Excel
            </button>
            <button
              type="button"
              onClick={() => setShowPaste((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 px-3 py-2 text-xs font-medium transition cursor-pointer"
            >
              <ClipboardPaste className="w-3.5 h-3.5" />
              Paste Spreadsheet
            </button>
            <button
              type="button"
              onClick={() => {
                onLoadSampleDaily();
                setImportBanner('Loaded 56-day contact center daily sample (with Day 25 outage anomaly).');
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
            >
              Sample: 56d Daily
            </button>
            <button
              type="button"
              onClick={() => {
                onLoadSampleMonthly();
                setImportBanner('Loaded 24-month seasonal billing sample.');
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
            >
              Sample: 24m Monthly
            </button>
          </div>
        </div>

        {importBanner && (
          <div className="mt-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3.5 py-2 text-xs text-emerald-700 dark:text-emerald-300 flex items-center justify-between">
            <span className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              {importBanner}
            </span>
            <button
              type="button"
              onClick={() => setImportBanner(null)}
              className="text-[11px] underline opacity-75 hover:opacity-100 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {importError && (
          <div className="mt-3 rounded-lg bg-rose-500/10 border border-rose-500/20 px-3.5 py-2 text-xs text-rose-700 dark:text-rose-300 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {importError}
          </div>
        )}

        {showPaste && (
          <div className="mt-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 p-3.5 space-y-2.5">
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              Paste rows directly from Excel or CSV (Date + Volume, 48×7 Heatmap, or Interval × Dates Pivot):
            </label>
            <textarea
              rows={5}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder={`Date\tVolume\n2026-06-01\t2620\n2026-06-02\t2490...`}
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-2.5 text-xs font-mono text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-sky-500"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowPaste(false)}
                className="px-3 py-1.5 text-xs text-slate-600 dark:text-slate-400 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handlePasteApply}
                className="rounded-lg bg-sky-600 hover:bg-sky-500 text-white px-3.5 py-1.5 text-xs font-medium cursor-pointer"
              >
                Parse &amp; Load Data
              </button>
            </div>
          </div>
        )}

        {/* Configuration Parameters Grid */}
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <div>
            <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
              Periodicity
            </label>
            <select
              value={config.periodicity}
              onChange={(e) => {
                const p = e.target.value as ForecastConfig['periodicity'];
                setConfig((c) => ({
                  ...c,
                  periodicity: p,
                  seasonLength: p === 'daily' ? 7 : p === 'weekly' ? 4 : 12,
                  horizon: p === 'daily' ? 7 : p === 'weekly' ? 4 : 6,
                }));
              }}
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2.5 py-1.5 text-xs font-medium"
            >
              <option value="daily">Daily (m = 7)</option>
              <option value="weekly">Weekly (m = 4/52)</option>
              <option value="monthly">Monthly (m = 12)</option>
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
              Seasonal Cycle (m)
            </label>
            <input
              type="number"
              min={2}
              max={52}
              value={config.seasonLength}
              onChange={(e) =>
                setConfig((c) => ({ ...c, seasonLength: Math.max(2, Number(e.target.value) || 7) }))
              }
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2.5 py-1.5 text-xs tabular-nums"
            />
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
              Holdout Validation %
            </label>
            <input
              type="number"
              min={10}
              max={40}
              step={5}
              value={Math.round(config.holdoutRatio * 100)}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  holdoutRatio: Math.max(0.1, Math.min(0.4, (Number(e.target.value) || 20) / 100)),
                }))
              }
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2.5 py-1.5 text-xs tabular-nums"
            />
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
              Forecast Horizon
            </label>
            <input
              type="number"
              min={1}
              max={31}
              value={config.horizon}
              onChange={(e) => {
                const h = Math.max(1, Math.min(31, Number(e.target.value) || 7));
                setConfig((c) => ({ ...c, horizon: h }));
                setBridgeIndex(0);
              }}
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2.5 py-1.5 text-xs tabular-nums"
            />
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
              SMA Window (N)
            </label>
            <input
              type="number"
              min={2}
              max={24}
              value={config.smaWindow}
              onChange={(e) =>
                setConfig((c) => ({ ...c, smaWindow: Math.max(2, Number(e.target.value) || 7) }))
              }
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2.5 py-1.5 text-xs tabular-nums"
            />
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
              Parameter Tuning
            </label>
            <button
              type="button"
              onClick={() => setConfig((c) => ({ ...c, autoOptimize: !c.autoOptimize }))}
              className={`w-full rounded-lg px-2.5 py-1.5 text-xs font-medium flex items-center justify-center gap-1.5 border transition cursor-pointer ${
                config.autoOptimize
                  ? 'bg-sky-500/10 border-sky-500/40 text-sky-600 dark:text-sky-300'
                  : 'bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300'
              }`}
            >
              {config.autoOptimize ? (
                <>
                  <Sparkles className="w-3.5 h-3.5" />
                  Auto-Optimizer ON
                </>
              ) : (
                <>
                  <Sliders className="w-3.5 h-3.5" />
                  Manual α / γ / δ
                </>
              )}
            </button>
          </div>
        </div>

        {!config.autoOptimize && (
          <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800 grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">Level Alpha (α: 0.01–0.99)</label>
              <input
                type="number"
                step={0.05}
                min={0.01}
                max={0.99}
                value={config.manualAlpha}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    manualAlpha: Math.max(0.01, Math.min(0.99, Number(e.target.value) || 0.3)),
                  }))
                }
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2.5 py-1.5 text-xs tabular-nums"
              />
            </div>
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">Trend Gamma (γ: 0.01–0.99)</label>
              <input
                type="number"
                step={0.05}
                min={0.01}
                max={0.99}
                value={config.manualGamma}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    manualGamma: Math.max(0.01, Math.min(0.99, Number(e.target.value) || 0.1)),
                  }))
                }
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2.5 py-1.5 text-xs tabular-nums"
              />
            </div>
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">Seasonal Delta (δ: 0.01–0.99)</label>
              <input
                type="number"
                step={0.05}
                min={0.01}
                max={0.99}
                value={config.manualDelta}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    manualDelta: Math.max(0.01, Math.min(0.99, Number(e.target.value) || 0.3)),
                  }))
                }
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2.5 py-1.5 text-xs tabular-nums"
              />
            </div>
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">
                WMA Weights (comma-separated, oldest→newest)
              </label>
              <input
                type="text"
                defaultValue={config.wmaWeights.join(', ')}
                onBlur={(e) => {
                  const arr = e.target.value
                    .split(',')
                    .map((s) => Number(s.trim()))
                    .filter((n) => Number.isFinite(n) && n > 0);
                  if (arr.length > 0) setConfig((c) => ({ ...c, wmaWeights: arr }));
                }}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2.5 py-1.5 text-xs font-mono"
              />
            </div>
          </div>
        )}
      </div>

      {/* Forecast Backtest & Future Horizon SVG Chart */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Train (80%) / Holdout Backtest (20%) &amp; Future Forecast —{' '}
              <span className="text-sky-600 dark:text-sky-400">
                {MODEL_NAMES[activeModel.modelId].name}
              </span>
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Train: {output.trainLength} periods · Holdout validation: {output.holdoutLength} unseen periods · Future horizon: +{config.horizon} periods
            </p>
          </div>
          <div className="flex items-center gap-4 text-xs">
            <span className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
              <span className="w-2.5 h-2.5 rounded-full bg-slate-500 inline-block" />
              Actuals (Cleaned)
            </span>
            <span className="flex items-center gap-1.5 text-sky-600 dark:text-sky-400">
              <span className="w-2.5 h-2.5 rounded-full bg-sky-500 inline-block" />
              Fitted &amp; Holdout Pred
            </span>
            <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block" />
              Future Forecast
            </span>
          </div>
        </div>

        <ForecastSvgChart
          cleanedSeries={output.cleanedSeries}
          trainLength={output.trainLength}
          fittedTrain={activeModel.fittedTrain}
          holdoutPreds={activeModel.holdoutPreds}
          futureForecast={activeModel.futureForecast}
        />
      </div>

      {/* Holdout Accuracy Comparison Table */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Holdout Validation Leaderboard (Unseen 20% Test Set)
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Click any model row to inspect its curve and select it for the Tab 2 Staffing Bridge.
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 border border-amber-500/30 px-3 py-1 text-xs font-medium text-amber-700 dark:text-amber-300">
            <Award className="w-3.5 h-3.5" />
            Winner: {MODEL_NAMES[output.bestModelId].name}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                <th className="py-2.5 px-3 font-medium">Model</th>
                <th className="py-2.5 px-3 font-medium text-right">WMAPE %</th>
                <th className="py-2.5 px-3 font-medium text-right">MAPE %</th>
                <th className="py-2.5 px-3 font-medium text-right">RMSE (Std Err)</th>
                <th className="py-2.5 px-3 font-medium text-right">MAE / MAD</th>
                <th className="py-2.5 px-3 font-medium text-right">Forecast Bias %</th>
                <th className="py-2.5 px-3 font-medium">Calibrated Parameters / R²</th>
                <th className="py-2.5 px-3 font-medium text-right">Next Period (+1)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
              {output.models.map((m) => {
                const isSelected = m.modelId === activeModel.modelId;
                const meta = MODEL_NAMES[m.modelId];
                const bias = m.holdoutMetrics.bias;
                return (
                  <tr
                    key={m.modelId}
                    onClick={() => setSelectedModelId(m.modelId)}
                    className={`transition cursor-pointer ${
                      isSelected
                        ? 'bg-sky-500/10 dark:bg-sky-500/15'
                        : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
                    }`}
                  >
                    <td className="py-2.5 px-3">
                      <div className="flex items-center gap-2">
                        <input
                          type="radio"
                          checked={isSelected}
                          onChange={() => setSelectedModelId(m.modelId)}
                          className="accent-sky-600"
                        />
                        <div>
                          <div className="font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                            {meta.name}
                            {m.isBest && (
                              <span className="rounded-md bg-emerald-500/15 border border-emerald-500/30 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                                BEST MODEL
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400">
                            {meta.desc}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="py-2.5 px-3 text-right tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                      {m.holdoutMetrics.wmape.toFixed(2)}%
                    </td>
                    <td className="py-2.5 px-3 text-right tabular-nums text-slate-700 dark:text-slate-300">
                      {m.holdoutMetrics.mape.toFixed(2)}%
                    </td>
                    <td className="py-2.5 px-3 text-right tabular-nums text-slate-700 dark:text-slate-300">
                      {m.holdoutMetrics.rmse.toFixed(1)}
                    </td>
                    <td className="py-2.5 px-3 text-right tabular-nums text-slate-700 dark:text-slate-300">
                      {m.holdoutMetrics.mae.toFixed(1)}
                    </td>
                    <td className="py-2.5 px-3 text-right tabular-nums">
                      <span
                        className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${
                          Math.abs(bias) <= 3
                            ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                            : bias > 0
                              ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                              : 'bg-rose-500/10 text-rose-700 dark:text-rose-300'
                        }`}
                      >
                        {bias >= 0 ? '+' : ''}
                        {bias.toFixed(2)}% {bias > 1 ? '(Over)' : bias < -1 ? '(Under)' : ''}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[11px] text-slate-600 dark:text-slate-400">
                      {Object.entries(m.params)
                        .map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.join(',')}]` : v}`)
                        .join(' · ')}
                      {m.r2 != null ? ` · R²=${m.r2.toFixed(3)}` : ''}
                    </td>
                    <td className="py-2.5 px-3 text-right tabular-nums font-semibold text-emerald-600 dark:text-emerald-400">
                      {Math.round(m.futureForecast[0] ?? 0).toLocaleString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Bottom 2-Column: Granularity Bridge to Tab 2 + Outlier & Holiday Cleaner */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Granularity Bridge Card */}
        <div className="lg:col-span-6 rounded-xl border border-sky-500/30 bg-sky-500/5 dark:bg-sky-950/20 p-5 flex flex-col justify-between space-y-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Granularity Bridge → Tab 2 (Interval &amp; Erlang Planner)
              </h3>
              <span className="text-xs font-mono px-2 py-0.5 rounded bg-sky-500/15 text-sky-700 dark:text-sky-300">
                {config.periodicity.toUpperCase()} → DAILY
              </span>
            </div>

            <p className="text-xs text-slate-600 dark:text-slate-300">
              {config.periodicity === 'daily'
                ? 'Select which forecasted future day to transfer directly into the Tab 2 Interval Planner.'
                : 'Converts Weekly/Monthly forecast into Daily Volume using your Day-of-Week distribution (%).'}
            </p>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
                  Forecast Horizon Step
                </label>
                <select
                  value={bridgeIndex}
                  onChange={(e) => setBridgeIndex(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs tabular-nums"
                >
                  {activeModel.futureForecast.map((val, i) => (
                    <option key={i} value={i}>
                      Period +{i + 1}: {Math.round(val).toLocaleString()} calls
                    </option>
                  ))}
                </select>
              </div>

              {config.periodicity !== 'daily' && (
                <div>
                  <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
                    Target Day of Week
                  </label>
                  <select
                    value={bridgeDay}
                    onChange={(e) => setBridgeDay(e.target.value as DayKey)}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs"
                  >
                    {DAY_KEYS.map((d) => (
                      <option key={d} value={d}>
                        {d} ({dowShares[d].toFixed(1)}%)
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {config.periodicity === 'monthly' && (
                <div>
                  <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
                    Calendar / Operating Days
                  </label>
                  <input
                    type="number"
                    min={20}
                    max={31}
                    value={operatingDaysPerMonth}
                    onChange={(e) =>
                      setOperatingDaysPerMonth(Math.max(20, Math.min(31, Number(e.target.value) || 30)))
                    }
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs tabular-nums"
                  />
                </div>
              )}
            </div>

            {config.periodicity !== 'daily' && (
              <div className="pt-2">
                <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1.5">
                  Day-of-Week Volume Share (%) — Total: {dowShareTotal.toFixed(1)}%
                </label>
                <div className="grid grid-cols-7 gap-1.5">
                  {DAY_KEYS.map((d) => (
                    <div key={d} className="text-center">
                      <span className="block text-[10px] font-medium text-slate-500 mb-0.5">{d}</span>
                      <input
                        type="number"
                        step={0.5}
                        min={0}
                        max={100}
                        value={dowShares[d]}
                        onChange={(e) =>
                          setDowShares((prev) => ({
                            ...prev,
                            [d]: Math.max(0, Number(e.target.value) || 0),
                          }))
                        }
                        className="w-full rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-1 py-1 text-center text-[11px] tabular-nums"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="pt-3 border-t border-sky-500/20 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                Bridged Daily Offered Volume
              </div>
              <div className="text-2xl font-bold tabular-nums text-slate-900 dark:text-white">
                {bridgedDailyVolume.toLocaleString()}{' '}
                <span className="text-xs font-normal text-slate-500">calls / day</span>
              </div>
            </div>

            <button
              type="button"
              onClick={() =>
                onPushToErlang(
                  bridgedDailyVolume,
                  config.periodicity !== 'daily' ? bridgeDay : undefined
                )
              }
              className="inline-flex items-center gap-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white px-4 py-2.5 text-xs font-semibold shadow-xs transition cursor-pointer"
            >
              Send Selected Forecast to Intervals &amp; Capacity
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Outlier & Holiday Handling Table */}
        <div className="lg:col-span-6 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Outlier &amp; Holiday Handling ({history.length} observations)
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Smooth or exclude technical outages and holidays so they do not distort model parameters.
              </p>
            </div>
            <span className="text-xs tabular-nums text-amber-600 dark:text-amber-400 font-medium">
              {history.filter((h) => h.isExcluded || h.isSmoothed).length} flagged
            </span>
          </div>

          <div className="max-h-56 overflow-y-auto border border-slate-100 dark:border-slate-800 rounded-lg">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800/90 text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="py-2 px-2.5 font-medium">#</th>
                  <th className="py-2 px-2.5 font-medium">Period / Date</th>
                  <th className="py-2 px-2.5 font-medium text-right">Raw Vol</th>
                  <th className="py-2 px-2.5 font-medium">Treatment</th>
                  <th className="py-2 px-2.5 font-medium text-right">Model Vol</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                {history.map((pt, idx) => {
                  const state = pt.isExcluded ? 'exclude' : pt.isSmoothed ? 'smooth' : 'clean';
                  return (
                    <tr
                      key={pt.id}
                      className={
                        state !== 'clean'
                          ? 'bg-amber-500/10 dark:bg-amber-500/15'
                          : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                      }
                    >
                      <td className="py-1.5 px-2.5 tabular-nums text-slate-400">{idx + 1}</td>
                      <td className="py-1.5 px-2.5 font-mono">{pt.label}</td>
                      <td className="py-1.5 px-2.5 text-right tabular-nums">{pt.volume.toLocaleString()}</td>
                      <td className="py-1.5 px-2.5">
                        <select
                          value={state}
                          onChange={(e) =>
                            updatePointFlag(idx, e.target.value as 'clean' | 'smooth' | 'exclude')
                          }
                          className="rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 py-0.5 text-[11px]"
                        >
                          <option value="clean">Normal (Keep)</option>
                          <option value="smooth">Smooth (Outage/Holiday)</option>
                          <option value="exclude">Exclude Point</option>
                        </select>
                      </td>
                      <td className="py-1.5 px-2.5 text-right tabular-nums font-medium">
                        {pt.isExcluded ? (
                          <span className="text-rose-500 line-through">Excluded</span>
                        ) : pt.isSmoothed ? (
                          <input
                            type="number"
                            value={pt.smoothedVolume ?? pt.volume}
                            onChange={(e) =>
                              updatePointFlag(idx, 'smooth', Math.max(0, Number(e.target.value) || 0))
                            }
                            className="w-20 rounded border border-amber-500/50 bg-white dark:bg-slate-900 px-1.5 py-0.5 text-right tabular-nums text-amber-600 dark:text-amber-300"
                          />
                        ) : (
                          pt.volume.toLocaleString()
                        )}
                      </td>
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

const ForecastSvgChart: React.FC<{
  cleanedSeries: number[];
  trainLength: number;
  fittedTrain: number[];
  holdoutPreds: number[];
  futureForecast: number[];
}> = ({ cleanedSeries, trainLength, fittedTrain, holdoutPreds, futureForecast }) => {
  const totalLen = cleanedSeries.length + futureForecast.length;
  if (totalLen < 2) return null;

  const width = 920;
  const height = 250;
  const padL = 52;
  const padR = 20;
  const padT = 18;
  const padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const allValues = [
    ...cleanedSeries,
    ...fittedTrain,
    ...holdoutPreds,
    ...futureForecast,
  ].filter((v) => Number.isFinite(v));
  const minVal = Math.max(0, Math.min(...allValues) * 0.88);
  const maxVal = Math.max(...allValues, 10) * 1.08;
  const span = Math.max(1, maxVal - minVal);

  const xAt = (idx: number) => padL + (idx / Math.max(1, totalLen - 1)) * plotW;
  const yAt = (val: number) => padT + plotH - ((val - minVal) / span) * plotH;

  const actualPath = cleanedSeries
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`)
    .join(' ');

  const modelHistory = [...fittedTrain, ...holdoutPreds];
  const modelPath = modelHistory
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`)
    .join(' ');

  const futureStartIdx = cleanedSeries.length - 1;
  const futurePoints = [
    { idx: futureStartIdx, val: modelHistory[futureStartIdx] ?? cleanedSeries[futureStartIdx] ?? 0 },
    ...futureForecast.map((v, h) => ({ idx: cleanedSeries.length + h, val: v })),
  ];
  const futurePath = futurePoints
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${xAt(p.idx).toFixed(1)},${yAt(p.val).toFixed(1)}`)
    .join(' ');

  const holdoutStartX = xAt(Math.max(0, trainLength - 0.5));
  const futureStartX = xAt(Math.max(0, cleanedSeries.length - 0.5));

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => minVal + t * span);

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto select-none">
        {/* Holdout & Future background bands */}
        <rect
          x={holdoutStartX}
          y={padT}
          width={Math.max(0, futureStartX - holdoutStartX)}
          height={plotH}
          className="fill-amber-500/8 dark:fill-amber-400/8"
        />
        <rect
          x={futureStartX}
          y={padT}
          width={Math.max(0, padL + plotW - futureStartX)}
          height={plotH}
          className="fill-emerald-500/8 dark:fill-emerald-400/8"
        />

        {/* Horizontal grid lines */}
        {yTicks.map((tv, i) => {
          const y = yAt(tv);
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
              <text
                x={padL - 6}
                y={y + 3}
                textAnchor="end"
                className="fill-slate-400 text-[10px] font-mono"
              >
                {Math.round(tv).toLocaleString()}
              </text>
            </g>
          );
        })}

        {/* Zone divider labels */}
        <line
          x1={holdoutStartX}
          y1={padT}
          x2={holdoutStartX}
          y2={padT + plotH}
          stroke="#f59e0b"
          strokeDasharray="4 4"
          strokeWidth={1.2}
        />
        <text x={holdoutStartX + 5} y={padT + 12} className="fill-amber-500 text-[10px] font-semibold">
          Holdout (20%)
        </text>

        <line
          x1={futureStartX}
          y1={padT}
          x2={futureStartX}
          y2={padT + plotH}
          stroke="#10b981"
          strokeDasharray="4 4"
          strokeWidth={1.2}
        />
        <text x={futureStartX + 5} y={padT + 12} className="fill-emerald-500 text-[10px] font-semibold">
          Forecast (+{futureForecast.length})
        </text>

        {/* Actuals Line */}
        <path
          d={actualPath}
          fill="none"
          stroke="currentColor"
          className="text-slate-400 dark:text-slate-500"
          strokeWidth={1.75}
        />

        {/* Fitted + Holdout Prediction Line */}
        <path d={modelPath} fill="none" stroke="#0284c7" strokeWidth={2.2} />

        {/* Future Forecast Line */}
        <path
          d={futurePath}
          fill="none"
          stroke="#10b981"
          strokeWidth={2.5}
          strokeDasharray="5 3"
        />
        {futurePoints.slice(1).map((p, i) => (
          <circle
            key={i}
            cx={xAt(p.idx)}
            cy={yAt(p.val)}
            r={3.5}
            className="fill-emerald-500 stroke-white dark:stroke-slate-900"
            strokeWidth={1.5}
          />
        ))}
      </svg>
    </div>
  );
};
