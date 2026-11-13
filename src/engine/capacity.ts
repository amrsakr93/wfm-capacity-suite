import type {
  CapacityConfig,
  CapacityResult,
  ErlangConfig,
  IntervalRowInput,
  WaterfallStep,
  WhatIfCell,
} from './types.ts';
import { runErlangPlanner } from './erlang.ts';

/**
 * Calculates Compound Shrinkage & Full FTE Waterfall without Occupancy double-counting
 * or Unpaid Break double-deduction.
 */
export function calculateCapacityWaterfall(config: CapacityConfig): CapacityResult {
  const effectivePaidShiftHours = config.useShiftMinusBreak
    ? Math.max(0.5, config.grossShiftHours - config.unpaidBreakHours)
    : Math.max(0.5, config.paidShiftHoursDirect);

  const inOfficePct = clampPct(
    config.inOfficeBreakdown.trainingCoachingPct +
      config.inOfficeBreakdown.meetingsHuddlesPct +
      config.inOfficeBreakdown.systemDowntimePct +
      config.inOfficeBreakdown.paidBreaksPct
  );

  const outOfOfficePct = clampPct(
    config.outOfOfficeBreakdown.annualLeavePct +
      config.outOfOfficeBreakdown.sickLeavePct +
      config.outOfOfficeBreakdown.publicHolidaysPct +
      config.outOfOfficeBreakdown.unplannedAbsencePct
  );

  // Compound shrinkage: In-Office applies to hours remaining after Out-of-Office leave
  const inFrac = inOfficePct / 100;
  const outFrac = outOfOfficePct / 100;
  const compoundFrac = 1 - (1 - inFrac) * (1 - outFrac);
  const compoundTotalShrinkagePct = compoundFrac * 100;

  const netProductiveHoursPerShiftPerFte = Math.max(
    0.1,
    effectivePaidShiftHours * (1 - compoundFrac)
  );

  // Route selection avoids Occupancy double-counting when coming from Erlang C
  const flatOccFrac = Math.max(0.1, Math.min(0.99, config.flatTargetOccupancyPct / 100));
  const baseRequiredProductiveHoursPerDay =
    config.route === 'erlang_c'
      ? Math.max(0, config.erlangProductiveHoursPerDay)
      : Math.max(0, config.pureTalkHoursPerDay / flatOccFrac);

  const weeklyCoverageMultiplier =
    config.agentWorkdaysPerWeek > 0
      ? Math.max(0.1, config.operatingDaysPerWeek / config.agentWorkdaysPerWeek)
      : 1;

  // Productive hours per day required per logged-in agent (after in-office shrinkage)
  const loginProductiveHoursPerAgent = Math.max(0.1, effectivePaidShiftHours * (1 - inFrac));

  const pureTalkDailySeats = config.pureTalkHoursPerDay / effectivePaidShiftHours;
  const dailyProductiveSeats = baseRequiredProductiveHoursPerDay / effectivePaidShiftHours;
  const afterWeeklyDailySeats = dailyProductiveSeats * weeklyCoverageMultiplier;
  const afterInOfficeSeats =
    (baseRequiredProductiveHoursPerDay / loginProductiveHoursPerAgent) * weeklyCoverageMultiplier;

  const inflexMultiplier = 1 + Math.max(0, config.scheduleInefficiencyPct) / 100;
  const scheduledSeatsAfterInflex = afterInOfficeSeats * inflexMultiplier;

  const grossFteBeforeBuffer = scheduledSeatsAfterInflex / Math.max(0.05, 1 - outFrac);
  const bufferMultiplier = 1 + Math.max(0, config.attritionRampBufferPct) / 100;
  const finalGrossFte = grossFteBeforeBuffer * bufferMultiplier;

  const effectiveMultiplierOverPureTalk =
    pureTalkDailySeats > 0 ? finalGrossFte / pureTalkDailySeats : 0;

  // Waterfall steps matching exact decomposition
  const erlangSlackSeats = Math.max(0, dailyProductiveSeats - pureTalkDailySeats);
  const weeklyCoverageDelta = afterWeeklyDailySeats - dailyProductiveSeats;
  const inOfficeDelta = afterInOfficeSeats - afterWeeklyDailySeats;
  const inflexDelta = scheduledSeatsAfterInflex - afterInOfficeSeats;
  const outOfOfficeDelta = grossFteBeforeBuffer - scheduledSeatsAfterInflex;
  const bufferDelta = finalGrossFte - grossFteBeforeBuffer;

  const waterfall: WaterfallStep[] = [
    {
      id: 'pure_talk',
      labelEn: 'Pure Talk Workload (Erlangs)',
      labelAr: 'ساعات التحدث الصافية (Erlangs)',
      hours: config.pureTalkHoursPerDay,
      fte: pureTalkDailySeats,
      deltaFte: pureTalkDailySeats,
      formulaNote: `${config.pureTalkHoursPerDay.toFixed(1)}h ÷ ${effectivePaidShiftHours.toFixed(2)}h`,
    },
    {
      id: 'queuing_occ',
      labelEn:
        config.route === 'erlang_c'
          ? 'Erlang C Queuing & Occ Cap Buffer'
          : `Top-Down Occupancy (${config.flatTargetOccupancyPct.toFixed(0)}%)`,
      labelAr:
        config.route === 'erlang_c'
          ? 'هامش انتظار Erlang C وسقف الإشغال'
          : `معدل الإشغال المستهدف (${config.flatTargetOccupancyPct.toFixed(0)}%)`,
      hours: baseRequiredProductiveHoursPerDay,
      fte: dailyProductiveSeats,
      deltaFte: erlangSlackSeats,
      formulaNote: `${baseRequiredProductiveHoursPerDay.toFixed(1)} prod hrs/day`,
    },
    {
      id: 'weekly_coverage',
      labelEn: `Weekly Roster (${config.operatingDaysPerWeek}d ÷ ${config.agentWorkdaysPerWeek}d)`,
      labelAr: `تغطية الأسبوع (${config.operatingDaysPerWeek} ÷ ${config.agentWorkdaysPerWeek} أيام)`,
      hours: baseRequiredProductiveHoursPerDay * weeklyCoverageMultiplier,
      fte: afterWeeklyDailySeats,
      deltaFte: weeklyCoverageDelta,
      formulaNote: `× ${weeklyCoverageMultiplier.toFixed(2)} coverage`,
    },
    {
      id: 'in_office',
      labelEn: `In-Office Shrinkage (${inOfficePct.toFixed(1)}%)`,
      labelAr: `الفقد داخل المكتب (${inOfficePct.toFixed(1)}%)`,
      hours: baseRequiredProductiveHoursPerDay * weeklyCoverageMultiplier / Math.max(0.05, 1 - inFrac),
      fte: afterInOfficeSeats,
      deltaFte: inOfficeDelta,
      formulaNote: `Login productive = ${loginProductiveHoursPerAgent.toFixed(2)}h/shift`,
    },
    {
      id: 'schedule_inflex',
      labelEn: `Schedule Inefficiency (+${config.scheduleInefficiencyPct.toFixed(1)}%)`,
      labelAr: `عدم كفاءة الجدولة (+${config.scheduleInefficiencyPct.toFixed(1)}%)`,
      hours:
        (baseRequiredProductiveHoursPerDay * weeklyCoverageMultiplier * inflexMultiplier) /
        Math.max(0.05, 1 - inFrac),
      fte: scheduledSeatsAfterInflex,
      deltaFte: inflexDelta,
      formulaNote: `× ${inflexMultiplier.toFixed(3)}`,
    },
    {
      id: 'out_of_office',
      labelEn: `Out-of-Office Shrinkage (${outOfOfficePct.toFixed(1)}%)`,
      labelAr: `الفقد خارج المكتب (${outOfOfficePct.toFixed(1)}%)`,
      hours: finalGrossFte / bufferMultiplier * effectivePaidShiftHours,
      fte: grossFteBeforeBuffer,
      deltaFte: outOfOfficeDelta,
      formulaNote: `÷ (1 - ${outOfOfficePct.toFixed(1)}%)`,
    },
  ];

  if (config.attritionRampBufferPct > 0) {
    waterfall.push({
      id: 'ramp_buffer',
      labelEn: `Attrition / Ramp Buffer (+${config.attritionRampBufferPct.toFixed(1)}%)`,
      labelAr: `احتياطي الدوران والتعيين (+${config.attritionRampBufferPct.toFixed(1)}%)`,
      hours: finalGrossFte * effectivePaidShiftHours,
      fte: finalGrossFte,
      deltaFte: bufferDelta,
      formulaNote: `× ${bufferMultiplier.toFixed(3)}`,
    });
  }

  return {
    effectivePaidShiftHours,
    inOfficeShrinkagePct: inOfficePct,
    outOfOfficeShrinkagePct: outOfOfficePct,
    compoundTotalShrinkagePct,
    netProductiveHoursPerShiftPerFte,
    baseRequiredProductiveHoursPerDay,
    weeklyCoverageMultiplier,
    dailyRequiredSeats: dailyProductiveSeats,
    weeklyRequiredSeatsBeforeInflex: afterInOfficeSeats,
    scheduledSeatsAfterInflex,
    grossFteBeforeBuffer,
    finalGrossFte,
    effectiveMultiplierOverPureTalk,
    waterfall,
  };
}

/**
 * Builds interactive 2D Sensitivity Matrix: AHT deltas x Total Shrinkage deltas
 * using live Erlang C recalculation so non-linear queuing effects are captured accurately!
 */
export function buildWhatIfMatrix(
  intervals: IntervalRowInput[],
  erlangConfig: ErlangConfig,
  baseCapacityConfig: CapacityConfig,
  ahtDeltas: number[] = [-20, -10, 0, 10, 20],
  shrinkageDeltasPct: number[] = [-4, -2, 0, 2, 4]
): WhatIfCell[][] {
  const baseCap = calculateCapacityWaterfall(baseCapacityConfig);

  // Cache Erlang calculations per AHT delta (only 5 Erlang passes instead of 25!)
  // Anchor dAht !== 0 smoothly onto baseCapacityConfig (whether driven by Tab 2 intraday curve or Monthly Cap Plan)
  const basePlannerSummary = runErlangPlanner(intervals, erlangConfig);
  const prodScale =
    baseCapacityConfig.erlangProductiveHoursPerDay > 0 && basePlannerSummary.totalProductiveHours > 0
      ? baseCapacityConfig.erlangProductiveHoursPerDay / basePlannerSummary.totalProductiveHours
      : 1;
  const pureScale =
    baseCapacityConfig.pureTalkHoursPerDay > 0 && basePlannerSummary.totalPureTalkHours > 0
      ? baseCapacityConfig.pureTalkHoursPerDay / basePlannerSummary.totalPureTalkHours
      : 1;

  const erlangByAhtDelta = new Map<number, { prodHours: number; pureHours: number }>();
  for (const dAht of ahtDeltas) {
    const newAht = Math.max(30, erlangConfig.globalAhtSec + dAht);
    if (dAht === 0) {
      erlangByAhtDelta.set(dAht, {
        prodHours: baseCapacityConfig.erlangProductiveHoursPerDay,
        pureHours: baseCapacityConfig.pureTalkHoursPerDay,
      });
    } else {
      const scaledIntervals = intervals.map((row) => ({
        ...row,
        ahtOverrideSec:
          row.ahtOverrideSec != null && row.ahtOverrideSec > 0
            ? Math.max(30, row.ahtOverrideSec + dAht)
            : null,
      }));
      const summary = runErlangPlanner(scaledIntervals, {
        ...erlangConfig,
        globalAhtSec: newAht,
      });
      erlangByAhtDelta.set(dAht, {
        prodHours: summary.totalProductiveHours * prodScale,
        pureHours: summary.totalPureTalkHours * pureScale,
      });
    }
  }

  const baseOOOSum =
    baseCapacityConfig.outOfOfficeBreakdown.annualLeavePct +
    baseCapacityConfig.outOfOfficeBreakdown.sickLeavePct +
    baseCapacityConfig.outOfOfficeBreakdown.publicHolidaysPct +
    baseCapacityConfig.outOfOfficeBreakdown.unplannedAbsencePct;

  return ahtDeltas.map((dAht) => {
    const erlangRes = erlangByAhtDelta.get(dAht)!;
    return shrinkageDeltasPct.map((dShrink) => {
      // Apply shrinkage delta proportionally onto Out-of-Office breakdown so dShrink = 0 reproduces baseline exactly
      const nextOOO = clampPct(baseCap.outOfOfficeShrinkagePct + dShrink);
      const nextOutBreakdown =
        baseOOOSum > 1e-6
          ? {
              annualLeavePct:
                (baseCapacityConfig.outOfOfficeBreakdown.annualLeavePct / baseOOOSum) * nextOOO,
              sickLeavePct:
                (baseCapacityConfig.outOfOfficeBreakdown.sickLeavePct / baseOOOSum) * nextOOO,
              publicHolidaysPct:
                (baseCapacityConfig.outOfOfficeBreakdown.publicHolidaysPct / baseOOOSum) * nextOOO,
              unplannedAbsencePct:
                (baseCapacityConfig.outOfOfficeBreakdown.unplannedAbsencePct / baseOOOSum) * nextOOO,
            }
          : {
              annualLeavePct: nextOOO,
              sickLeavePct: 0,
              publicHolidaysPct: 0,
              unplannedAbsencePct: 0,
            };
      const nextConfig: CapacityConfig = {
        ...baseCapacityConfig,
        erlangProductiveHoursPerDay: erlangRes.prodHours,
        pureTalkHoursPerDay: erlangRes.pureHours,
        outOfOfficeBreakdown: nextOutBreakdown,
      };
      const sim = calculateCapacityWaterfall(nextConfig);
      return {
        ahtDeltaSec: dAht,
        shrinkageDeltaPct: dShrink,
        effectiveAhtSec: Math.max(30, erlangConfig.globalAhtSec + dAht),
        effectiveTotalShrinkagePct: sim.compoundTotalShrinkagePct,
        productiveHoursPerDay: erlangRes.prodHours,
        finalGrossFte: sim.finalGrossFte,
        deltaFte: sim.finalGrossFte - baseCap.finalGrossFte,
      };
    });
  });
}

function clampPct(v: number): number {
  return Math.max(0, Math.min(90, v));
}

