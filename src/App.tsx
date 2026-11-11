import React, { useEffect, useMemo, useState } from 'react';
import {
  TrendingUp,
  Clock,
  Users,
  Sun,
  Moon,
  Download,
  Printer,
  CheckCircle2,
  Globe,
  Sparkles,
} from 'lucide-react';
import type {
  CapacityConfig,
  DayKey,
  ErlangConfig,
  ForecastConfig,
  ForecastModelId,
  HistoricalPoint,
  IntervalGranularityMin,
  IntervalRowInput,
  ParsedDataset,
} from './engine/types.ts';
import {
  buildIntervalInputsForGranularity,
  buildSampleDailyHistory,
  buildSampleMonthlyHistory,
  DEFAULT_30M_CURVES,
  DEFAULT_DOW_SHARES,
} from './engine/samples.ts';
import { runForecastingStudio } from './engine/forecasting.ts';
import { runErlangPlanner } from './engine/erlang.ts';
import { buildWhatIfMatrix, calculateCapacityWaterfall } from './engine/capacity.ts';
import { exportFullSuiteWorkbook } from './engine/exporter.ts';
import { Tab1Forecasting } from './components/Tab1Forecasting.tsx';
import { Tab2Erlang } from './components/Tab2Erlang.tsx';
import { Tab3Capacity } from './components/Tab3Capacity.tsx';

type ActiveTab = 'tab1' | 'tab2' | 'tab3';

const SHRINKAGE_DELTAS = [-4, -2, 0, 2, 4];
const AHT_DELTAS = [-20, -10, 0, 10, 20];
const JS_DAY_TO_KEY: DayKey[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const App: React.FC = () => {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = localStorage.getItem('wfm_theme');
    return saved === 'light' || saved === 'dark' ? saved : 'dark';
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    localStorage.setItem('wfm_theme', theme);
  }, [theme]);

  const [activeTab, setActiveTab] = useState<ActiveTab>('tab1');
  const [toast, setToast] = useState<string | null>(null);

  const showNotice = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  };

  // Tab 1 State
  const [history, setHistory] = useState<HistoricalPoint[]>(() => buildSampleDailyHistory());
  const [forecastConfig, setForecastConfig] = useState<ForecastConfig>({
    periodicity: 'daily',
    holdoutRatio: 0.2,
    horizon: 14,
    smaWindow: 7,
    wmaWeights: [0.15, 0.25, 0.6],
    seasonLength: 7,
    autoOptimize: true,
    manualModel: 'holt_winters_mult',
    manualAlpha: 0.3,
    manualGamma: 0.1,
    manualDelta: 0.3,
  });

  const forecastOutput = useMemo(
    () => runForecastingStudio(history, forecastConfig),
    [history, forecastConfig]
  );

  const [selectedModelId, setSelectedModelId] = useState<ForecastModelId>(
    forecastOutput.bestModelId
  );

  useEffect(() => {
    if (forecastConfig.autoOptimize) {
      setSelectedModelId(forecastOutput.bestModelId);
    }
  }, [forecastOutput.bestModelId, forecastConfig.autoOptimize]);

  // Shared Day-of-Week distribution, 7-day Intraday Arrival Curves, and Per-Date Curves
  const [dowShares, setDowShares] = useState<Record<DayKey, number>>(() => ({
    ...DEFAULT_DOW_SHARES,
  }));
  const [dayCurves, setDayCurves] = useState<Record<DayKey, number[]>>(() => ({
    ...DEFAULT_30M_CURVES,
  }));
  const [byDateCurves, setByDateCurves] = useState<Record<string, number[]>>({});
  const [byDateTotals, setByDateTotals] = useState<Record<string, number>>({});
  const [operatingDaysPerMonth, setOperatingDaysPerMonth] = useState<number>(30);

  // Shared Monthly Volume Breakdown Context (for Cap Plan Sheet Breakdown)
  const [monthlyVolume, setMonthlyVolume] = useState<number>(62245);
  const [monthDays, setMonthDays] = useState<number>(30);
  const [hoops, setHoops] = useState<number>(24);

  // Tab 2 State (Pure ErlangXL97 mode by default: enforceMaxAsa=false, enforceOccupancyCap=false)
  const [erlangConfig, setErlangConfig] = useState<ErlangConfig>({
    dailyVolume: 2075,
    granularityMin: 30,
    operating24x7: true,
    startHour: 8,
    endHour: 22,
    globalAhtSec: 300,
    slTargetPct: 80,
    slThresholdSec: 30,
    maxAsaSec: 30,
    maxOccupancyPct: 85,
    enforceMaxAsa: false,
    enforceOccupancyCap: false,
    agentMode: 'integer',
    minAgentsFloor: 0,
    useErlangA: false,
    avgPatienceSec: 90,
    selectedDay: 'Mon',
    selectedDateIso: null,
  });

  const [intervals, setIntervals] = useState<IntervalRowInput[]>(() =>
    buildIntervalInputsForGranularity(DEFAULT_30M_CURVES.Mon, 30)
  );

  const erlangSummary = useMemo(
    () => runErlangPlanner(intervals, erlangConfig),
    [intervals, erlangConfig]
  );

  // Tab 3 State
  const [capacityConfig, setCapacityConfig] = useState<CapacityConfig>({
    route: 'erlang_c',
    erlangProductiveHoursPerDay: 240,
    pureTalkHoursPerDay: 172.9,
    flatTargetOccupancyPct: 85,
    useShiftMinusBreak: true,
    grossShiftHours: 9,
    unpaidBreakHours: 1,
    paidShiftHoursDirect: 8,
    operatingDaysPerWeek: 7,
    agentWorkdaysPerWeek: 5,
    scheduleInefficiencyPct: 10,
    inOfficeBreakdown: {
      trainingCoachingPct: 1.5,
      meetingsHuddlesPct: 1.0,
      systemDowntimePct: 0.5,
      paidBreaksPct: 0,
    },
    outOfOfficeBreakdown: {
      annualLeavePct: 10,
      sickLeavePct: 4,
      publicHolidaysPct: 3,
      unplannedAbsencePct: 3,
    },
    attritionRampBufferPct: 0,
  });

  // Automatically sync Tab 2 productive & pure talk hours into Tab 3 whenever Tab 2 recalculates
  useEffect(() => {
    setCapacityConfig((prev) => ({
      ...prev,
      erlangProductiveHoursPerDay: erlangSummary.totalProductiveHours,
      pureTalkHoursPerDay: erlangSummary.totalPureTalkHours,
    }));
  }, [erlangSummary.totalProductiveHours, erlangSummary.totalPureTalkHours]);

  const capacityResult = useMemo(
    () => calculateCapacityWaterfall(capacityConfig),
    [capacityConfig]
  );

  const whatIfMatrix = useMemo(
    () =>
      buildWhatIfMatrix(
        intervals,
        erlangConfig,
        capacityConfig,
        AHT_DELTAS,
        SHRINKAGE_DELTAS
      ),
    [intervals, erlangConfig, capacityConfig]
  );

  // Handlers
  const handleDatasetImported = (dataset: ParsedDataset) => {
    if (dataset.dailySeries.length > 0) {
      setHistory(dataset.dailySeries);
      setForecastConfig((c) => ({
        ...c,
        periodicity: dataset.periodicityGuess,
        seasonLength:
          dataset.periodicityGuess === 'daily'
            ? 7
            : dataset.periodicityGuess === 'weekly'
              ? 4
              : 12,
      }));
    }
    if (dataset.dayOfWeekShares) {
      setDowShares(dataset.dayOfWeekShares);
    }
    if (dataset.byDateCurves) {
      setByDateCurves(dataset.byDateCurves);
    }
    if (dataset.byDateTotals) {
      setByDateTotals(dataset.byDateTotals);
    }
    if (dataset.dayCurves) {
      setDayCurves(dataset.dayCurves);
      const g = dataset.granularityMinGuess;
      setErlangConfig((c) => ({ ...c, granularityMin: g, selectedDateIso: null }));
      setIntervals(
        buildIntervalInputsForGranularity(
          dataset.dayCurves[erlangConfig.selectedDay] ?? dataset.dayCurves.Mon,
          g
        )
      );
    }
  };

  const handleGranularityChange = (g: IntervalGranularityMin) => {
    setErlangConfig((c) => ({ ...c, granularityMin: g }));
    const activeCurve =
      (erlangConfig.selectedDateIso && byDateCurves[erlangConfig.selectedDateIso]) ||
      dayCurves[erlangConfig.selectedDay] ||
      dayCurves.Mon;
    setIntervals(buildIntervalInputsForGranularity(activeCurve, g));
  };

  const handleSelectDay = (d: DayKey) => {
    setErlangConfig((c) => ({ ...c, selectedDay: d, selectedDateIso: null }));
    setIntervals(
      buildIntervalInputsForGranularity(
        dayCurves[d] ?? dayCurves.Mon,
        erlangConfig.granularityMin
      )
    );
  };

  const handleSelectSpecificDate = (iso: string) => {
    const jsDay = new Date(`${iso}T00:00:00Z`).getUTCDay();
    const dk = JS_DAY_TO_KEY[jsDay] ?? 'Mon';
    const curve = byDateCurves[iso] ?? dayCurves[dk] ?? dayCurves.Mon;
    const vol = byDateTotals[iso] ?? erlangConfig.dailyVolume;
    setErlangConfig((c) => ({
      ...c,
      dailyVolume: vol,
      selectedDay: dk,
      selectedDateIso: iso,
    }));
    setIntervals(buildIntervalInputsForGranularity(curve, erlangConfig.granularityMin));
    showNotice(`Loaded exact date ${iso} (${vol.toLocaleString()} calls) & arrival pattern.`);
  };

  const handleResetCurveToDefault = () => {
    setDayCurves({ ...DEFAULT_30M_CURVES });
    setErlangConfig((c) => ({ ...c, selectedDateIso: null }));
    setIntervals(
      buildIntervalInputsForGranularity(
        DEFAULT_30M_CURVES[erlangConfig.selectedDay],
        erlangConfig.granularityMin
      )
    );
    showNotice('Reset intraday arrival curves to standard contact center profile.');
  };

  const handlePushToErlang = (
    dailyVolume: number,
    targetDay?: DayKey,
    dateIso?: string | null,
    customCurvePct?: number[]
  ) => {
    const nextDay = targetDay ?? erlangConfig.selectedDay;
    const cleanDaily = Math.max(0, Math.round(dailyVolume));
    setMonthlyVolume(cleanDaily * monthDays);
    setErlangConfig((c) => ({
      ...c,
      dailyVolume: cleanDaily,
      selectedDay: nextDay,
      selectedDateIso: dateIso ?? null,
    }));
    const curveToUse =
      customCurvePct ??
      (dateIso ? byDateCurves[dateIso] : undefined) ??
      dayCurves[nextDay] ??
      dayCurves.Mon;
    setIntervals(buildIntervalInputsForGranularity(curveToUse, erlangConfig.granularityMin));
    setActiveTab('tab2');
    showNotice(
      `Transferred ${cleanDaily.toLocaleString()} daily calls (${dateIso ?? nextDay}) to Tab 2 Erlang Planner.`
    );
  };

  const handlePushMonthlyToSuite = (targetMonthlyVol: number, targetMonthDays: number = 30) => {
    const cleanMonthly = Math.max(0, Math.round(targetMonthlyVol));
    const safeDays = Math.max(1, targetMonthDays);
    const dailyVol = Math.round(cleanMonthly / safeDays);
    setMonthlyVolume(cleanMonthly);
    setMonthDays(safeDays);
    setErlangConfig((c) => ({
      ...c,
      dailyVolume: dailyVol,
      selectedDateIso: null,
    }));
    setActiveTab('tab2');
    showNotice(
      `Loaded Monthly Forecast (${cleanMonthly.toLocaleString()} calls ÷ ${safeDays}d = ${dailyVol.toLocaleString()}/day) into Tab 2 & Tab 3.`
    );
  };

  const handleApplyFlatMonthlyBreakdown = (
    prodHoursPerDay: number,
    pureTalkHoursPerDay: number
  ) => {
    setCapacityConfig((c) => ({
      ...c,
      route: 'erlang_c',
      erlangProductiveHoursPerDay: prodHoursPerDay,
      pureTalkHoursPerDay: pureTalkHoursPerDay,
    }));
    setActiveTab('tab3');
    showNotice(
      `Applied Monthly Cap Plan Breakdown (${prodHoursPerDay.toFixed(1)} Prod Hrs/day) to Tab 3.`
    );
  };

  const handlePushToCapacity = () => {
    setCapacityConfig((c) => ({
      ...c,
      route: 'erlang_c',
      erlangProductiveHoursPerDay: erlangSummary.totalProductiveHours,
      pureTalkHoursPerDay: erlangSummary.totalPureTalkHours,
    }));
    setActiveTab('tab3');
    showNotice(
      `Synced ${erlangSummary.totalProductiveHours.toFixed(2)} Required Productive Hours to Tab 3.`
    );
  };

  const handleLoadCnxBenchmark = () => {
    setMonthlyVolume(62245);
    setMonthDays(30);
    setHoops(24);
    setErlangConfig((c) => ({
      ...c,
      dailyVolume: 2075,
      globalAhtSec: 300,
      slTargetPct: 80,
      slThresholdSec: 30,
      enforceMaxAsa: false,
      enforceOccupancyCap: false,
      agentMode: 'integer',
    }));
    setCapacityConfig({
      route: 'erlang_c',
      erlangProductiveHoursPerDay: 240,
      pureTalkHoursPerDay: 172.9,
      flatTargetOccupancyPct: 85,
      useShiftMinusBreak: true,
      grossShiftHours: 9,
      unpaidBreakHours: 1,
      paidShiftHoursDirect: 8,
      operatingDaysPerWeek: 7,
      agentWorkdaysPerWeek: 5,
      scheduleInefficiencyPct: 10,
      inOfficeBreakdown: {
        trainingCoachingPct: 1.5,
        meetingsHuddlesPct: 1.0,
        systemDowntimePct: 0.5,
        paidBreaksPct: 0,
      },
      outOfOfficeBreakdown: {
        annualLeavePct: 10,
        sickLeavePct: 4,
        publicHolidaysPct: 3,
        unplannedAbsencePct: 3,
      },
      attritionRampBufferPct: 0,
    });
    showNotice(
      'Loaded 62,245 Monthly Cap Plan Benchmark (2,075/d · 86/hr · 10/hr · 240h/d → 60 Agents Required).'
    );
  };

  const handleExportExcel = () => {
    exportFullSuiteWorkbook({
      history,
      forecastConfig,
      forecastOutput,
      selectedModelId,
      erlangConfig,
      erlangSummary,
      capacityConfig,
      capacityResult,
      whatIfMatrix,
      shrinkageDeltas: SHRINKAGE_DELTAS,
    });
    showNotice('Exported 4-sheet Excel workbook (.xlsx).');
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 transition-colors">
      {/* Top Command Bar */}
      <header className="sticky top-0 z-30 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md no-print">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="icon-badge-glow w-10 h-10 rounded-xl bg-gradient-to-br from-sky-500 to-indigo-600 text-white flex items-center justify-center font-extrabold text-xs shadow-md shadow-sky-600/25">
              <Sparkles className="w-5 h-5 animate-float" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-sm sm:text-base font-extrabold tracking-tight text-slate-900 dark:text-white">
                  WFM &amp; Capacity Suite
                </h1>
                <span className="hidden sm:inline-flex items-center gap-1 rounded-full bg-sky-500/10 border border-sky-500/30 px-2.5 py-0.5 text-[11px] font-semibold text-sky-600 dark:text-sky-400">
                  <Globe className="w-3 h-3" />
                  wfmforall.com
                </span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                12 Carlberg Forecast Models · Pure ErlangXL97 (Agents &amp; Fractional) · Monthly &amp; Daily Cap Plan
              </p>
            </div>
          </div>

          {/* Live Pipeline Ribbon */}
          <div className="hidden xl:flex items-center gap-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/70 px-4 py-1.5 text-xs">
            <div>
              <span className="text-slate-400">Monthly:</span>{' '}
              <strong className="tabular-nums text-indigo-600 dark:text-indigo-400">
                {monthlyVolume.toLocaleString()}
              </strong>
            </div>
            <span className="text-slate-300 dark:text-slate-700">→</span>
            <div>
              <span className="text-slate-400">Daily:</span>{' '}
              <strong className="tabular-nums text-slate-800 dark:text-slate-200">
                {erlangConfig.dailyVolume.toLocaleString()}
              </strong>
            </div>
            <span className="text-slate-300 dark:text-slate-700">→</span>
            <div>
              <span className="text-slate-400">Prod Hrs:</span>{' '}
              <strong className="tabular-nums text-sky-600 dark:text-sky-400">
                {capacityConfig.erlangProductiveHoursPerDay.toFixed(1)}h
              </strong>
            </div>
            <span className="text-slate-300 dark:text-slate-700">→</span>
            <div>
              <span className="text-slate-400">Required FTE:</span>{' '}
              <strong className="tabular-nums text-emerald-600 dark:text-emerald-400">
                {Math.round(capacityResult.finalGrossFte)} ({capacityResult.finalGrossFte.toFixed(1)})
              </strong>
            </div>
          </div>

          {/* Right Actions: Export, Print, Day/Night Theme Toggle */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleExportExcel}
              className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white px-3.5 py-1.5 text-xs font-semibold shadow-xs transition cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Export .xlsx</span>
            </button>

            <button
              type="button"
              onClick={() => window.print()}
              title="Print or Save as PDF"
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 px-2.5 py-1.5 text-xs font-medium transition cursor-pointer"
            >
              <Printer className="w-3.5 h-3.5" />
              <span className="hidden md:inline">PDF</span>
            </button>

            <button
              type="button"
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
              aria-label="Toggle Day and Night mode"
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 px-3 py-1.5 text-xs font-semibold transition cursor-pointer"
            >
              {theme === 'dark' ? (
                <>
                  <Sun className="w-3.5 h-3.5 text-amber-400" />
                  <span>Day Mode</span>
                </>
              ) : (
                <>
                  <Moon className="w-3.5 h-3.5 text-slate-700" />
                  <span>Night Mode</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* 3-Tab Navigation Bar */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex items-center gap-2 overflow-x-auto border-t border-slate-100 dark:border-slate-800/80">
          <button
            type="button"
            onClick={() => setActiveTab('tab1')}
            className={`flex items-center gap-2 px-4 py-3 text-xs font-bold border-b-2 transition whitespace-nowrap cursor-pointer ${
              activeTab === 'tab1'
                ? 'border-sky-500 text-sky-600 dark:text-sky-400 bg-sky-500/5'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
          >
            <TrendingUp className="w-4 h-4" />
            1. Forecasting Studio &amp; Future Horizons
            <span className="rounded-md bg-sky-500/15 text-sky-600 dark:text-sky-300 px-1.5 py-0.5 text-[10px] font-mono">
              12 Models
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('tab2')}
            className={`flex items-center gap-2 px-4 py-3 text-xs font-bold border-b-2 transition whitespace-nowrap cursor-pointer ${
              activeTab === 'tab2'
                ? 'border-sky-500 text-sky-600 dark:text-sky-400 bg-sky-500/5'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
          >
            <Clock className="w-4 h-4" />
            2. Interval &amp; Erlang C/A Planner (Agents / Fractional)
            <span className="rounded-md bg-slate-200 dark:bg-slate-800 px-1.5 py-0.5 text-[10px] font-mono">
              {erlangSummary.totalProductiveHours.toFixed(1)}h
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('tab3')}
            className={`flex items-center gap-2 px-4 py-3 text-xs font-bold border-b-2 transition whitespace-nowrap cursor-pointer ${
              activeTab === 'tab3'
                ? 'border-sky-500 text-sky-600 dark:text-sky-400 bg-sky-500/5'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
          >
            <Users className="w-4 h-4" />
            3. Monthly Cap Plan &amp; Shrinkage Waterfall
            <span className="rounded-md bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 px-1.5 py-0.5 text-[10px] font-mono">
              {Math.round(capacityResult.finalGrossFte)} FTE
            </span>
          </button>
        </div>
      </header>

      {/* Toast Notification */}
      {toast && (
        <div className="fixed bottom-5 right-5 z-50 rounded-xl bg-slate-900 dark:bg-sky-950 border border-sky-500/40 text-white px-4 py-2.5 text-xs font-medium shadow-lg flex items-center gap-2 no-print">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          {toast}
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6">
        {activeTab === 'tab1' && (
          <Tab1Forecasting
            history={history}
            setHistory={setHistory}
            config={forecastConfig}
            setConfig={setForecastConfig}
            output={forecastOutput}
            selectedModelId={selectedModelId}
            setSelectedModelId={setSelectedModelId}
            dowShares={dowShares}
            setDowShares={setDowShares}
            dayCurves={dayCurves}
            byDateCurves={byDateCurves}
            byDateTotals={byDateTotals}
            operatingDaysPerMonth={operatingDaysPerMonth}
            setOperatingDaysPerMonth={setOperatingDaysPerMonth}
            onDatasetImported={handleDatasetImported}
            onLoadSampleDaily={() => {
              setHistory(buildSampleDailyHistory());
              setForecastConfig((c) => ({
                ...c,
                periodicity: 'daily',
                seasonLength: 7,
                horizon: 14,
              }));
            }}
            onLoadSampleMonthly={() => {
              setHistory(buildSampleMonthlyHistory());
              setForecastConfig((c) => ({
                ...c,
                periodicity: 'monthly',
                seasonLength: 12,
                horizon: 6,
              }));
            }}
            onPushToErlang={handlePushToErlang}
            onPushMonthlyToSuite={handlePushMonthlyToSuite}
          />
        )}

        {activeTab === 'tab2' && (
          <Tab2Erlang
            config={erlangConfig}
            setConfig={setErlangConfig}
            intervals={intervals}
            setIntervals={setIntervals}
            dayCurves={dayCurves}
            byDateCurves={byDateCurves}
            byDateTotals={byDateTotals}
            dowShares={dowShares}
            summary={erlangSummary}
            monthlyVolume={monthlyVolume}
            setMonthlyVolume={setMonthlyVolume}
            monthDays={monthDays}
            setMonthDays={setMonthDays}
            hoops={hoops}
            setHoops={setHoops}
            onGranularityChange={handleGranularityChange}
            onSelectDay={handleSelectDay}
            onSelectSpecificDate={handleSelectSpecificDate}
            onDatasetImported={handleDatasetImported}
            onResetCurveToDefault={handleResetCurveToDefault}
            onApplyFlatMonthlyBreakdown={handleApplyFlatMonthlyBreakdown}
            onPushToCapacity={handlePushToCapacity}
          />
        )}

        {activeTab === 'tab3' && (
          <Tab3Capacity
            config={capacityConfig}
            setConfig={setCapacityConfig}
            result={capacityResult}
            whatIfMatrix={whatIfMatrix}
            shrinkageDeltas={SHRINKAGE_DELTAS}
            baseGlobalAhtSec={erlangConfig.globalAhtSec}
            monthlyVolume={monthlyVolume}
            setMonthlyVolume={setMonthlyVolume}
            monthDays={monthDays}
            setMonthDays={setMonthDays}
            hoops={hoops}
            setHoops={setHoops}
            slTargetPct={erlangConfig.slTargetPct}
            slThresholdSec={erlangConfig.slThresholdSec}
            onLoadCnxBenchmark={handleLoadCnxBenchmark}
            onExportExcel={handleExportExcel}
          />
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-200 dark:border-slate-800/80 py-4 px-4 sm:px-6 text-center text-xs text-slate-400 no-print">
        WFM &amp; Capacity Suite · wfmforall.com · 100% Client-Side Computation (Zero Data Leaves Your Browser)
      </footer>
    </div>
  );
};
