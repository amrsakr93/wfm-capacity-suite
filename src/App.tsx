import React, { useEffect, useMemo, useState } from 'react';
import {
  Sun,
  Moon,
  Download,
  Printer,
  CheckCircle2,
  Globe,
} from 'lucide-react';
import {
  BrandWfmEmblem,
  ForecastStudioIcon,
  ErlangQueueIcon,
  CapacityWaterfallIcon,
} from './components/ProMaxIcons.tsx';
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
  buildDateSpecificCurve,
  buildDefaultByDateCurves,
  buildIntervalInputsForGranularity,
  buildSampleDailyHistory,
  DEFAULT_30M_CURVES,
  DEFAULT_DOW_SHARES,
} from './engine/samples.ts';
import { buildFutureHorizonSummary, runForecastingStudio } from './engine/forecasting.ts';
import { runErlangPlanner, solveRequiredAgents } from './engine/erlang.ts';
import { buildWhatIfMatrix, calculateCapacityWaterfall } from './engine/capacity.ts';
import { exportFullSuiteWorkbook, exportHorizonForecastXlsx } from './engine/exporter.ts';
import { Tab1Forecasting } from './components/Tab1Forecasting.tsx';
import { Tab2Erlang, type IntervalPlanScope, type HorizonDaySpec } from './components/Tab2Erlang.tsx';
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
      root.classList.remove('light');
    } else {
      root.classList.remove('dark');
      root.classList.add('light');
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
  const [byDateCurves, setByDateCurves] = useState<Record<string, number[]>>(
    () => buildDefaultByDateCurves(buildSampleDailyHistory(), DEFAULT_30M_CURVES).byDateCurves
  );
  const [byDateTotals, setByDateTotals] = useState<Record<string, number>>(
    () => buildDefaultByDateCurves(buildSampleDailyHistory(), DEFAULT_30M_CURVES).byDateTotals
  );
  const [operatingDaysPerMonth, setOperatingDaysPerMonth] = useState<number>(30);

  // Shared Monthly Volume Breakdown Context (for Cap Plan Sheet Breakdown)
  const [monthlyVolume, setMonthlyVolume] = useState<number>(81563);
  const [monthDays, setMonthDays] = useState<number>(30);
  const [hoops, setHoops] = useState<number>(24);

  // Tab 2 State (Pure ErlangXL97 mode by default: enforceMaxAsa=false, enforceOccupancyCap=false)
  const [erlangConfig, setErlangConfig] = useState<ErlangConfig>({
    dailyVolume: 2719,
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

  // Multi-Day Interval Planning Scope State (Tab 2)
  const [intervalScope, setIntervalScope] = useState<IntervalPlanScope>('single_day');
  const [customHorizonDays, setCustomHorizonDays] = useState<number>(10);

  // Build Historical & 60-Day Future Horizon Day Specs (aligned to Monday start)
  const { historyDays, futureDays } = useMemo(() => {
    const histList: HorizonDaySpec[] = history.map((pt, idx) => {
      const parsed = new Date(pt.label.length <= 10 ? `${pt.label}T00:00:00` : pt.label);
      const dk: DayKey = !Number.isNaN(parsed.getTime())
        ? JS_DAY_TO_KEY[parsed.getDay()]
        : JS_DAY_TO_KEY[idx % 7];
      return {
        dateIso: pt.label,
        dayKey: dk,
        volume: Math.max(0, Math.round(pt.volume)),
        sourceLabel: 'Historical',
      };
    });

    const activeModel =
      forecastOutput.models.find((m) => m.modelId === selectedModelId) ??
      forecastOutput.models.find((m) => m.isBest) ??
      forecastOutput.models[0];

    const futSummary = buildFutureHorizonSummary(
      history,
      activeModel,
      forecastConfig.periodicity,
      dowShares
    );
    const futList: HorizonDaySpec[] = futSummary.allFutureDays.map((d) => ({
      dateIso: d.dateIso,
      dayKey: d.dayKey,
      volume: d.volume,
      sourceLabel: 'Forecast',
    }));

    return { historyDays: histList, futureDays: futList };
  }, [history, forecastOutput, selectedModelId, forecastConfig, dowShares]);

  // Live Monthly Cap Plan Erlang C calculation (Monthly -> Daily -> Hourly -> Erlang Required/Hr -> Required/Day)
  const monthlyCapPlanHours = useMemo(() => {
    const safeDays = Math.max(1, monthDays);
    const safeHoops = Math.max(1, Math.min(24, hoops));
    const dailyOff = monthlyVolume / safeDays;
    const hourlyVol = dailyOff / safeHoops;
    const solved = solveRequiredAgents(hourlyVol, erlangConfig.globalAhtSec, 3600, {
      ...erlangConfig,
      enforceMaxAsa: false,
      enforceOccupancyCap: false,
    });
    const reqPerHour =
      erlangConfig.agentMode === 'fractional' ? solved.fractionalSeats : solved.integerSeats;
    return {
      prodHoursPerDay: Number((reqPerHour * safeHoops).toFixed(2)),
      pureTalkHoursPerDay: Number(((dailyOff * erlangConfig.globalAhtSec) / 3600).toFixed(2)),
    };
  }, [
    monthlyVolume,
    monthDays,
    hoops,
    erlangConfig,
  ]);

  // Tab 3 State (Defaulting to 3% In-Office & 22% Out-of-Office Shrinkage matching Cap Plan spreadsheet)
  const [capacityConfig, setCapacityConfig] = useState<CapacityConfig>({
    route: 'erlang_c',
    erlangProductiveHoursPerDay: 312,
    pureTalkHoursPerDay: 226.56,
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
      annualLeavePct: 11,
      sickLeavePct: 5,
      publicHolidaysPct: 3,
      unplannedAbsencePct: 3,
    },
    attritionRampBufferPct: 0,
  });

  // Automatically sync Monthly Cap Plan productive & pure talk hours into Tab 3 whenever Monthly Volume / Erlang config changes
  useEffect(() => {
    setCapacityConfig((prev) => ({
      ...prev,
      erlangProductiveHoursPerDay: monthlyCapPlanHours.prodHoursPerDay,
      pureTalkHoursPerDay: monthlyCapPlanHours.pureTalkHoursPerDay,
    }));
  }, [monthlyCapPlanHours.prodHoursPerDay, monthlyCapPlanHours.pureTalkHoursPerDay]);

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
    const nextDayCurves = dataset.dayCurves ?? dayCurves;
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
    if (dataset.byDateCurves && Object.keys(dataset.byDateCurves).length > 0) {
      setByDateCurves(dataset.byDateCurves);
    } else if (dataset.dailySeries.length > 0) {
      const synth = buildDefaultByDateCurves(dataset.dailySeries, nextDayCurves);
      setByDateCurves(synth.byDateCurves);
    }
    if (dataset.byDateTotals && Object.keys(dataset.byDateTotals).length > 0) {
      setByDateTotals(dataset.byDateTotals);
    } else if (dataset.dailySeries.length > 0) {
      const synth = buildDefaultByDateCurves(dataset.dailySeries, nextDayCurves);
      setByDateTotals(synth.byDateTotals);
    }
    if (dataset.dayCurves) {
      setDayCurves(dataset.dayCurves);
      const g = dataset.granularityMinGuess;
      const firstDateIso =
        dataset.byDateCurves && Object.keys(dataset.byDateCurves).length > 0
          ? Object.keys(dataset.byDateCurves).sort().slice(-1)[0]
          : null;
      const firstCurve =
        (firstDateIso && dataset.byDateCurves?.[firstDateIso]) ||
        dataset.dayCurves[erlangConfig.selectedDay] ||
        dataset.dayCurves.Mon;
      setErlangConfig((c) => ({ ...c, granularityMin: g, selectedDateIso: firstDateIso }));
      setIntervals(buildIntervalInputsForGranularity(firstCurve, g));
    }
  };

  const handleGranularityChange = (g: IntervalGranularityMin) => {
    setErlangConfig((c) => ({ ...c, granularityMin: g }));
    const activeCurve =
      (erlangConfig.selectedDateIso &&
        (byDateCurves[erlangConfig.selectedDateIso] ??
          buildDateSpecificCurve(erlangConfig.selectedDateIso, erlangConfig.selectedDay, dayCurves))) ||
      dayCurves[erlangConfig.selectedDay] ||
      dayCurves.Mon;
    setIntervals(buildIntervalInputsForGranularity(activeCurve, g));
  };

  const handleSelectDay = (d: DayKey) => {
    setErlangConfig((c) => ({ ...c, selectedDay: d, selectedDateIso: null }));
    setIntervalScope('single_day');
    setIntervals(
      buildIntervalInputsForGranularity(
        dayCurves[d] ?? dayCurves.Mon,
        erlangConfig.granularityMin
      )
    );
  };

  const handleSelectSpecificDate = (iso: string) => {
    if (!iso) {
      handleSelectDay(erlangConfig.selectedDay);
      return;
    }
    const parsedMs = Date.parse(iso.length <= 10 ? `${iso}T00:00:00Z` : iso);
    const dk: DayKey = !Number.isNaN(parsedMs)
      ? JS_DAY_TO_KEY[new Date(parsedMs).getUTCDay()] ?? 'Mon'
      : erlangConfig.selectedDay;
    const isHist = historyDays.some((h) => h.dateIso === iso);
    const curve =
      byDateCurves[iso] ??
      (isHist
        ? buildDateSpecificCurve(iso, dk, dayCurves)
        : dayCurves[dk] ?? dayCurves.Mon);
    const histMatch = historyDays.find((h) => h.dateIso === iso);
    const futMatch = futureDays.find((f) => f.dateIso === iso);
    const vol =
      byDateTotals[iso] ?? histMatch?.volume ?? futMatch?.volume ?? erlangConfig.dailyVolume;
    setErlangConfig((c) => ({
      ...c,
      dailyVolume: vol,
      selectedDay: dk,
      selectedDateIso: iso,
    }));
    setMonthlyVolume(vol * monthDays);
    setIntervalScope('single_day');
    setIntervals(buildIntervalInputsForGranularity(curve, erlangConfig.granularityMin));
    showNotice(`Loaded exact date ${iso} (${dk} · ${vol.toLocaleString()} calls) & its own arrival pattern.`);
  };

  const handleResetCurveToDefault = () => {
    setDayCurves({ ...DEFAULT_30M_CURVES });
    const synth = buildDefaultByDateCurves(history, DEFAULT_30M_CURVES);
    setByDateCurves(synth.byDateCurves);
    setErlangConfig((c) => ({ ...c, selectedDateIso: null }));
    setIntervals(
      buildIntervalInputsForGranularity(
        DEFAULT_30M_CURVES[erlangConfig.selectedDay],
        erlangConfig.granularityMin
      )
    );
    showNotice('Reset intraday arrival curves to 7-day contact center profiles.');
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
    const isHistDate = Boolean(dateIso && historyDays.some((h) => h.dateIso === dateIso));
    const curveToUse =
      customCurvePct ??
      (dateIso
        ? byDateCurves[dateIso] ??
          (isHistDate
            ? buildDateSpecificCurve(dateIso, nextDay, dayCurves)
            : dayCurves[nextDay])
        : undefined) ??
      dayCurves[nextDay] ??
      dayCurves.Mon;
    setIntervals(buildIntervalInputsForGranularity(curveToUse, erlangConfig.granularityMin));
    setIntervalScope('single_day');
    setActiveTab('tab2');
    showNotice(
      `Transferred ${cleanDaily.toLocaleString()} daily calls (${dateIso ? `${dateIso} · ${nextDay}` : nextDay}) & exact arrival pattern to Tab 2.`
    );
  };

  const handlePlanMultiDayInErlang = (
    scope: 'next_week' | 'custom_days' | 'all_days',
    daysCount?: number
  ) => {
    setIntervalScope(scope);
    if (daysCount !== undefined) {
      setCustomHorizonDays(daysCount);
    }
    setActiveTab('tab2');
    showNotice(
      scope === 'next_week'
        ? 'Opened Next Week (7 Days · Mon → Sun) Per-Interval Schedule in Tab 2.'
        : scope === 'custom_days'
          ? `Opened Custom ${daysCount ?? customHorizonDays}-Day Per-Interval Schedule in Tab 2.`
          : 'Opened Full Period Per-Interval Schedule in Tab 2.'
    );
  };

  const handleExportHorizonForecast = (
    focusHorizon: 'next_week' | 'current_month' | 'next_month' | 'all'
  ) => {
    exportHorizonForecastXlsx({
      history,
      forecastConfig,
      forecastOutput,
      selectedModelId,
      dowShares,
      dayCurves,
      byDateCurves,
      erlangConfig,
      focusHorizon,
    });
    showNotice(
      focusHorizon === 'next_week'
        ? 'Downloaded Next Week (Mon → Sun) Forecast & Interval Schedule (.xlsx).'
        : 'Downloaded Future Forecast Horizons (.xlsx).'
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
    setActiveTab('tab3');
    showNotice(
      `Loaded Monthly Forecast (${cleanMonthly.toLocaleString()} calls ÷ ${safeDays}d = ${dailyVol.toLocaleString()}/day) into Capacity Plan.`
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
      `Synced ${erlangSummary.totalProductiveHours.toFixed(2)} Intraday Required Productive Hours to Tab 3.`
    );
  };

  const handleExportExcel = () => {
    exportFullSuiteWorkbook({
      history,
      forecastConfig,
      forecastOutput,
      selectedModelId,
      dowShares,
      dayCurves,
      byDateCurves,
      byDateTotals,
      monthlyVolume,
      monthDays,
      hoops,
      erlangConfig,
      erlangSummary,
      capacityConfig,
      capacityResult,
      whatIfMatrix,
      shrinkageDeltas: SHRINKAGE_DELTAS,
    });
    showNotice(
      'Downloaded 7-Sheet Executive WFM Report (.xlsx) with Next Week, Monthly & All-Days Arrival + SLA!'
    );
  };

  return (
    <div className="min-h-screen flex flex-col w-full bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 transition-colors">
      {/* Top Command Bar (Full-Width Responsive Layout) */}
      <header className="sticky top-0 z-30 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md no-print">
        <div className="w-full max-w-[1920px] mx-auto px-4 sm:px-8 2xl:px-12 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3.5 group">
            <div className="promax-icon-3d promax-badge-cyan animate-icon-glow w-11 h-11 rounded-2xl flex items-center justify-center">
              <BrandWfmEmblem size={30} />
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
                12 Statistical Forecast Models · Pure ErlangXL97 (=Agents &amp; =FractionalAgents) · Monthly &amp; Daily Cap Plan
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
                {Math.round(monthlyVolume / Math.max(1, monthDays)).toLocaleString()}
              </strong>
            </div>
            <span className="text-slate-300 dark:text-slate-700">→</span>
            <div>
              <span className="text-slate-400">Prod Hrs:</span>{' '}
              <strong className="tabular-nums text-sky-600 dark:text-sky-400">
                {capacityConfig.erlangProductiveHoursPerDay.toFixed(1)}h/d
              </strong>
            </div>
            <span className="text-slate-300 dark:text-slate-700">→</span>
            <div>
              <span className="text-slate-400">Agents Required:</span>{' '}
              <strong className="tabular-nums text-emerald-600 dark:text-emerald-400">
                {Math.round(capacityResult.finalGrossFte)} Agents ({capacityResult.finalGrossFte.toFixed(2)})
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
                  <Moon className="w-3.5 h-3.5 text-indigo-600" />
                  <span>Night Mode</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* 3-Tab Navigation Bar */}
        <div className="w-full max-w-[1920px] mx-auto px-4 sm:px-8 2xl:px-12 flex items-center gap-2 overflow-x-auto border-t border-slate-100 dark:border-slate-800/80">
          <button
            type="button"
            onClick={() => setActiveTab('tab1')}
            className={`flex items-center gap-2.5 px-4 py-3 text-xs font-bold border-b-2 transition whitespace-nowrap cursor-pointer ${
              activeTab === 'tab1'
                ? 'border-sky-500 text-sky-600 dark:text-sky-400 bg-sky-500/5'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
          >
            <ForecastStudioIcon size={20} />
            1. Forecasting Studio &amp; Future Horizons (Mon → Sun)
            <span className="rounded-md bg-sky-500/15 text-sky-600 dark:text-sky-300 px-1.5 py-0.5 text-[10px] font-mono">
              12 Models
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('tab2')}
            className={`flex items-center gap-2.5 px-4 py-3 text-xs font-bold border-b-2 transition whitespace-nowrap cursor-pointer ${
              activeTab === 'tab2'
                ? 'border-sky-500 text-sky-600 dark:text-sky-400 bg-sky-500/5'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
          >
            <ErlangQueueIcon size={20} />
            2. Interval &amp; Erlang C/A Planner (=Agents / =FractionalAgents)
            <span className="rounded-md bg-slate-200 dark:bg-slate-800 px-1.5 py-0.5 text-[10px] font-mono">
              {erlangSummary.totalProductiveHours.toFixed(1)}h
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('tab3')}
            className={`flex items-center gap-2.5 px-4 py-3 text-xs font-bold border-b-2 transition whitespace-nowrap cursor-pointer ${
              activeTab === 'tab3'
                ? 'border-sky-500 text-sky-600 dark:text-sky-400 bg-sky-500/5'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
          >
            <CapacityWaterfallIcon size={20} />
            3. Monthly Cap Plan &amp; Shrinkage Waterfall
            <span className="rounded-md bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 px-1.5 py-0.5 text-[10px] font-mono">
              {Math.round(capacityResult.finalGrossFte)} Agents
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

      {/* Main Content Area (Full-Width Responsive Container) */}
      <main className="flex-1 w-full max-w-[1920px] mx-auto px-4 sm:px-8 2xl:px-12 py-6">
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
            onLoadSampleDaily={() => {}}
            onLoadSampleMonthly={() => {}}
            onPushToErlang={handlePushToErlang}
            onPushMonthlyToSuite={handlePushMonthlyToSuite}
            onExportHorizonForecast={handleExportHorizonForecast}
            onPlanMultiDayInErlang={handlePlanMultiDayInErlang}
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
            historyDays={historyDays}
            futureDays={futureDays}
            intervalScope={intervalScope}
            setIntervalScope={setIntervalScope}
            customHorizonDays={customHorizonDays}
            setCustomHorizonDays={setCustomHorizonDays}
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
            erlangConfig={erlangConfig}
            setErlangConfig={setErlangConfig}
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
            onExportExcel={handleExportExcel}
          />
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-200 dark:border-slate-800/80 py-4 px-4 sm:px-8 text-center text-xs text-slate-400 no-print">
        WFM &amp; Capacity Suite · wfmforall.com · 100% Client-Side Computation (Zero Data Leaves Your Browser)
      </footer>
    </div>
  );
};
export default App;
