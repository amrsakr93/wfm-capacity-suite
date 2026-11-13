export type Periodicity = 'daily' | 'weekly' | 'monthly';

export type ForecastModelId =
  | 'sma'
  | 'wma'
  | 'cma_decomposition'
  | 'ses'
  | 'ses_differenced'
  | 'holt'
  | 'holt_damped'
  | 'holt_winters_add'
  | 'holt_winters_mult'
  | 'linear_regression'
  | 'multiple_regression'
  | 'box_jenkins_ar';

export interface HistoricalPoint {
  id: string;
  label: string; // YYYY-MM-DD or period label
  date?: string; // ISO YYYY-MM-DD if parsed as date
  volume: number;
  isExcluded?: boolean;
  isSmoothed?: boolean;
  smoothedVolume?: number;
}

export interface ForecastConfig {
  periodicity: Periodicity;
  holdoutRatio: number; // default 0.20 (80/20 chronological)
  horizon: number; // number of future periods to forecast
  smaWindow: number;
  wmaWeights: number[]; // newest-first or oldest-first (we use oldest -> newest, documented cleanly)
  seasonLength: number; // e.g. 7 daily, 4/52 weekly, 12 monthly
  autoOptimize: boolean;
  manualModel: ForecastModelId;
  manualAlpha: number;
  manualGamma: number;
  manualDelta: number;
}

export interface ForecastMetrics {
  mape: number; // % skipping exact zeros
  wmape: number; // % sum(|e|)/sum(y) - safe for zeros
  smape: number; // %
  rmse: number; // standard error on holdout
  mae: number; // MAD
  bias: number; // % sum(yhat - y)/sum(y)
}

export interface ForecastModelResult {
  modelId: ForecastModelId;
  params: Record<string, number | number[]>;
  fittedTrain: number[];
  holdoutPreds: number[];
  futureForecast: number[];
  extendedFutureForecast: number[]; // always >= 60 future steps for Next Week / Current Month / Next Month cards
  holdoutMetrics: ForecastMetrics;
  trainMetrics: ForecastMetrics;
  r2?: number;
  slope?: number;
  intercept?: number;
  isBest: boolean;
  note?: string;
}

export interface ForecastDayItem {
  stepIndex: number;
  dateIso: string;
  label: string;
  dayKey: DayKey;
  volume: number;
}

export interface FutureHorizonSummary {
  nextWeekTotal: number;
  nextWeekDailyAvg: number;
  nextWeekPeakDay: ForecastDayItem;
  nextWeekDays: ForecastDayItem[];
  currentMonthTotal: number;
  currentMonthDailyAvg: number;
  currentMonthLabel: string;
  currentMonthDays: ForecastDayItem[];
  nextMonthTotal: number;
  nextMonthDailyAvg: number;
  nextMonthLabel: string;
  nextMonthGrowthPct: number;
  nextMonthDays: ForecastDayItem[];
  allFutureDays: ForecastDayItem[];
}

export interface ForecastingStudioOutput {
  cleanedSeries: number[];
  trainLength: number;
  holdoutLength: number;
  models: ForecastModelResult[];
  bestModelId: ForecastModelId;
}

export type IntervalGranularityMin = 60 | 30 | 15;
export type DayKey = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';
export type ErlangAgentMode = 'integer' | 'fractional';

export interface IntervalRowInput {
  index: number;
  timeLabel: string; // e.g. "00:00", "08:30"
  arrivalPct: number; // % of daily volume (0..100)
  ahtOverrideSec?: number | null;
}

export interface ErlangConfig {
  dailyVolume: number;
  granularityMin: IntervalGranularityMin;
  operating24x7: boolean;
  startHour: number; // 0..23
  endHour: number; // 1..24
  globalAhtSec: number;
  slTargetPct: number; // e.g. 80
  slThresholdSec: number; // e.g. 20
  maxAsaSec: number; // e.g. 30
  maxOccupancyPct: number; // e.g. 85
  enforceMaxAsa?: boolean; // default false (matches pure ErlangXL97)
  enforceOccupancyCap?: boolean; // default false (matches pure ErlangXL97)
  agentMode?: ErlangAgentMode; // 'integer' (Agents) | 'fractional' (FractionalAgents)
  preserveExactIntervalVolumes?: boolean; // when true, do not round interval volumes (e.g. flat 2075/24 = 86.46)
  minAgentsFloor: number; // e.g. 0 or 1
  useErlangA: boolean;
  avgPatienceSec: number; // e.g. 90
  selectedDay: DayKey;
  selectedDateIso?: string | null;
}

export interface IntervalStaffingRow {
  index: number;
  timeLabel: string;
  isOpen: boolean;
  arrivalPct: number;
  volume: number;
  ahtSec: number;
  erlangs: number; // A
  requiredSeats: number; // N (integer or fractional depending on agentMode)
  integerSeats: number; // Integer Agents (ErlangXL97 Agents)
  fractionalSeats: number; // Fractional Agents (ErlangXL97 FractionalAgents)
  occupancyPct: number; // A / N * 100 (effective in Erlang A)
  asaSec: number;
  slPct: number;
  probWaitPct: number;
  abandonPct: number | null;
  productiveHours: number; // requiredSeats * I_min / 60
  pureTalkHours: number; // A * I_min / 60
}

export interface ErlangSummary {
  rows: IntervalStaffingRow[];
  totalVolume: number;
  totalPureTalkHours: number;
  totalProductiveHours: number;
  totalIntegerProductiveHours: number;
  totalFractionalProductiveHours: number;
  peakSeats: number;
  peakTimeLabel: string;
  weightedSlPct: number;
  weightedAsaSec: number;
  avgOccupancyPct: number;
  weightedAbandonPct: number | null;
}

export type CapacityRoute = 'erlang_c' | 'flat_top_down';

export interface CapacityConfig {
  route: CapacityRoute;
  // From Tab 2
  erlangProductiveHoursPerDay: number;
  pureTalkHoursPerDay: number;
  flatTargetOccupancyPct: number;
  // Shift structure (avoids break double-counting)
  useShiftMinusBreak: boolean;
  grossShiftHours: number; // e.g. 9
  unpaidBreakHours: number; // e.g. 1 -> login = 8
  paidShiftHoursDirect: number; // used if useShiftMinusBreak === false
  // Weekly coverage
  operatingDaysPerWeek: number; // e.g. 7
  agentWorkdaysPerWeek: number; // e.g. 5
  // Shrinkage & Inefficiency
  scheduleInefficiencyPct: number; // e.g. 5% (or 10% inflex)
  inOfficeBreakdown: {
    trainingCoachingPct: number;
    meetingsHuddlesPct: number;
    systemDowntimePct: number;
    paidBreaksPct: number;
  };
  outOfOfficeBreakdown: {
    annualLeavePct: number;
    sickLeavePct: number;
    publicHolidaysPct: number;
    unplannedAbsencePct: number;
  };
  attritionRampBufferPct: number; // optional buffer e.g. 5%
}

export interface WaterfallStep {
  id: string;
  labelEn: string;
  labelAr: string;
  hours: number;
  fte: number;
  deltaFte: number;
  formulaNote: string;
}

export interface CapacityResult {
  effectivePaidShiftHours: number;
  inOfficeShrinkagePct: number;
  outOfOfficeShrinkagePct: number;
  compoundTotalShrinkagePct: number;
  netProductiveHoursPerShiftPerFte: number;
  baseRequiredProductiveHoursPerDay: number;
  weeklyCoverageMultiplier: number;
  dailyRequiredSeats: number;
  weeklyRequiredSeatsBeforeInflex: number;
  scheduledSeatsAfterInflex: number;
  grossFteBeforeBuffer: number;
  finalGrossFte: number;
  effectiveMultiplierOverPureTalk: number;
  waterfall: WaterfallStep[];
}

export interface WhatIfCell {
  ahtDeltaSec: number;
  shrinkageDeltaPct: number;
  effectiveAhtSec: number;
  effectiveTotalShrinkagePct: number;
  productiveHoursPerDay: number;
  finalGrossFte: number;
  deltaFte: number;
}

export interface ParsedDataset {
  format: 'simple_daily' | 'heatmap_48x7' | 'crosstab_pivot' | 'long_interval';
  periodicityGuess: Periodicity;
  dailySeries: HistoricalPoint[];
  granularityMinGuess: IntervalGranularityMin;
  dayCurves?: Record<DayKey, number[]>; // percentage arrays (sum = 100) aligned to 30m/60m/15m
  dayOfWeekShares?: Record<DayKey, number>; // % share of weekly volume per day
  byDateCurves?: Record<string, number[]>; // exact percentage arrival curve for each ISO date YYYY-MM-DD
  byDateVolumes?: Record<string, number[]>; // exact interval volumes for each ISO date YYYY-MM-DD
  byDateTotals?: Record<string, number>; // exact daily total volume for each ISO date YYYY-MM-DD
  timeLabels?: string[];
  summaryNote: string;
}

export type OtpChannel = 'outlook' | 'teams' | 'both';

// ============================================================================
// Tab 4: WFM Agent Shift Scheduling, Exceptions & 15-Min Break Optimizer Types
// ============================================================================

export type LeaveAllocationCode =
  | 'WORK'
  | 'OFF'
  | 'AL'
  | 'MAT'
  | 'RES'
  | 'TERM'
  | 'UPL'
  | 'PAT';

export type ExceptionCode = Exclude<LeaveAllocationCode, 'WORK' | 'OFF'>;

export interface LeaveCounts {
  annual: number;
  maternity: number;
  resignations: number;
  termination: number;
  upl: number;
  paternity: number;
}

export type RosterInputMode = 'headcount' | 'named';

export interface RosterAgentInput {
  id: string;
  name: string;
  lockedException?: ExceptionCode | null;
}

export interface ShiftTemplate {
  id: string;
  label: string;
  startMin: number; // 0..1439
  durationMin: number; // e.g. 540 for 9h gross shift
  endMinOfDay: number; // (startMin + durationMin) % 1440
  wrapsMidnight: boolean;
  enabled: boolean;
}

export interface BreakPlacementRules {
  firstBreakMin: number; // default 15
  lunchMin: number; // default 30
  lastBreakMin: number; // default 15
  maxContinuousLoginMin: number; // default 210 (3h 30m)
  minGapBetweenBreaksMin: number; // default 60 (1h)
  edgeBufferMin: number; // default 60
}

export interface BreakAssignment {
  firstBreakOffsetMin: number;
  lunchOffsetMin: number;
  lastBreakOffsetMin: number;
  firstBreakLabel: string;
  lunchLabel: string;
  lastBreakLabel: string;
  maxContinuousWorkMin: number;
  minInterBreakGapMin: number;
  isValid: boolean;
}

export interface SchedulingRules {
  maxWorkdaysPerWeek: number; // 5
  allowSunMonSplitOff: boolean; // true (Sun + Mon split wrap allowed)
  maxWeeklyStartDriftHours: number; // default 2h (08+09 OK, 10+12 OK, 15+08 blocked)
  minInterShiftRestHours: number; // default 12h (blocks clopening)
  annualVisibilityInOutput: 'exclude' | 'show_muted'; // default 'show_muted' -> AL shown full-week like other leaves
  shiftHeadcountOverrides?: Record<string, number | null>; // optional manual agent pool per shift ID
  shiftDayHeadcountOverrides?: Record<string, Partial<Record<DayKey, number | null>>>; // optional manual daily working count per shift × weekday
  breakRules: BreakPlacementRules;
}

export interface ShiftDailyMixRow {
  shiftId: string;
  shiftLabel: string;
  wrapsMidnight: boolean;
  durationHours: number;
  targetOverride: number | null;
  dayOverrides?: Partial<Record<DayKey, number | null>>;
  assignedPoolCount: number;
  avgPerDay: number;
  byDay: Record<DayKey, number>;
  totalWeeklyShifts: number;
  shareOfShiftsPct: number;
}

export interface AgentDayAssignment {
  dayKey: DayKey;
  status: LeaveAllocationCode;
  shiftId: string | null;
  breaks: BreakAssignment | null;
  isManualOverride?: boolean;
}

export interface ScheduledAgentRow {
  agentId: string;
  agentName: string;
  source: 'manual_count' | 'uploaded_name';
  preAllocatedException: ExceptionCode | null;
  offPatternLabel: string;
  assignments: Record<DayKey, AgentDayAssignment>;
  workDaysCount: number;
  offDaysCount: number;
  shiftBandSpanHours: number;
  minRestHoursObserved: number | null;
  violations: string[];
}

export interface IntervalCoverageCell {
  dayKey: DayKey;
  dateIso: string;
  slotIndex: number;
  timeLabel: string;
  forecastVolume: number;
  requiredSeats: number;
  scheduledGrossHeads: number;
  onBreakFte: number;
  effectiveScheduledFte: number;
  varianceFte: number;
  projectedSlPct: number;
}

export interface DailyCoverageSummary {
  dayKey: DayKey;
  dateIso: string;
  forecastVolume: number;
  requiredProdHours: number;
  scheduledGrossHours: number;
  scheduledNetHours: number;
  coveragePct: number;
  peakRequired: number;
  peakScheduledNet: number;
  understaffedIntervals: number;
  avgProjectedSlPct: number;
}

export interface ScheduleGenerationResult {
  agents: ScheduledAgentRow[];
  visibleOutputAgents: ScheduledAgentRow[];
  coverageByDay: Record<DayKey, IntervalCoverageCell[]>;
  dailyTotals: DailyCoverageSummary[];
  shiftDailyMix: ShiftDailyMixRow[];
  summary: {
    totalRosterInput: number;
    annualExcluded: number;
    fullWeekExceptionsCount: number;
    activeSchedulableCount: number;
    totalWorkShifts: number;
    totalRequiredProdHours: number;
    totalScheduledNetHours: number;
    avgCoveragePct: number;
    understaffedIntervalsTotal: number;
    overstaffedIntervalsTotal: number;
    projectedWeeklySlPct: number;
    violationAgentsCount: number;
    validBreakRatePct: number;
  };
}

