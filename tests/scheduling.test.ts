import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SHIFT_CATALOG,
  DEFAULT_SCHEDULING_RULES,
  sortShiftCatalogChronologically,
  parseShiftCatalogText,
  parseAgentRosterText,
  computeCircularStartSpanHours,
  validateAgentScheduleRow,
  assignOptimalBreaksForShift,
  generateWeeklySchedule,
  recalculateScheduleCoverage,
} from '../src/engine/scheduling.ts';
import { buildSchedulingWorkbook } from '../src/engine/exporter.ts';
import {
  buildSampleDailyHistory,
  buildIntervalInputsForGranularity,
  DEFAULT_30M_CURVES,
  DEFAULT_DOW_SHARES,
} from '../src/engine/samples.ts';
import { buildWhatIfMatrix } from '../src/engine/capacity.ts';
import { runForecastingStudio, buildFutureHorizonSummary } from '../src/engine/forecasting.ts';
import type {
  CapacityConfig,
  DayKey,
  ErlangConfig,
  ForecastConfig,
  LeaveCounts,
  SchedulingRules,
} from '../src/engine/types.ts';

const DEFAULT_ERLANG: ErlangConfig = {
  dailyVolume: 2719,
  granularityMin: 30,
  operating24x7: true,
  startHour: 0,
  endHour: 24,
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
};

function sampleNextWeekDays() {
  const history = buildSampleDailyHistory();
  const fCfg: ForecastConfig = {
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
  };
  const out = runForecastingStudio(history, fCfg);
  const best = out.models.find((m) => m.isBest) ?? out.models[0];
  return buildFutureHorizonSummary(history, best, 'daily', DEFAULT_DOW_SHARES).nextWeekDays;
}

describe('WFM Agent Shift Scheduling & Break Optimizer Engine', () => {
  it('parses external shift catalog strings (24h, 12h AM/PM, overnight wrap) cleanly', () => {
    const raw = [
      '08:00-17:00',
      '9:00 AM - 6:00 PM',
      '15:00 to 00:00',
      '22:00 - 07:00',
      '10:00\t19:00',
    ].join('\n');
    const shifts = parseShiftCatalogText(raw);
    assert.equal(shifts.length, 5);
    // Chronologically auto-sorted (08:00 -> 09:00 -> 10:00 -> 15:00 -> 22:00)
    assert.deepEqual(
      shifts.map((s) => s.id),
      ['08:00-17:00', '09:00-18:00', '10:00-19:00', '15:00-00:00', '22:00-07:00']
    );
    assert.equal(shifts[0].startMin, 480);
    assert.equal(shifts[0].durationMin, 540);
    assert.equal(shifts[0].wrapsMidnight, false);

    assert.equal(shifts[1].startMin, 540);
    assert.equal(shifts[1].durationMin, 540);

    // 15:00 -> 00:00 is 9h finishing at midnight
    assert.equal(shifts[3].startMin, 900);
    assert.equal(shifts[3].durationMin, 540);

    // Overnight 22:00 -> 07:00 wraps past midnight cleanly
    assert.equal(shifts[4].startMin, 1320);
    assert.equal(shifts[4].durationMin, 540);
    assert.equal(shifts[4].wrapsMidnight, true);
    assert.equal(shifts[4].endMinOfDay, 420);
  });

  it('parses uploaded/pasted agent names & recognizes optional exception columns', () => {
    const raw = [
      'Agent Name, Status',
      'Ahmed Hassan,',
      'Sara Adel, Maternity',
      'Omar Tarek, AL',
      'Nourhan Ali, Resignation',
      'Karim Maged, Termination',
      'Heba Youssef, UPL',
      'Mostafa Nabil, Paternity',
    ].join('\n');
    const parsed = parseAgentRosterText(raw);
    assert.equal(parsed.length, 7);
    assert.equal(parsed[0].name, 'Ahmed Hassan');
    assert.equal(parsed[0].lockedException, null);
    assert.equal(parsed[1].lockedException, 'MAT');
    assert.equal(parsed[2].lockedException, 'AL');
    assert.equal(parsed[3].lockedException, 'RES');
    assert.equal(parsed[4].lockedException, 'TERM');
    assert.equal(parsed[5].lockedException, 'UPL');
    assert.equal(parsed[6].lockedException, 'PAT');
  });

  it('computes circular 24h start drift accurately (treats 22:00 & 00:00 as 2h, blocks 15:00 & 08:00 as 7h)', () => {
    assert.equal(computeCircularStartSpanHours([480, 540]), 1); // 08:00 & 09:00 = 1h
    assert.equal(computeCircularStartSpanHours([600, 720]), 2); // 10:00 & 12:00 = 2h
    assert.equal(computeCircularStartSpanHours([1320, 0]), 2); // 22:00 & 00:00 = 2h
    assert.equal(computeCircularStartSpanHours([900, 480]), 7); // 15:00 & 08:00 = 7h
  });

  it('generates Agent 1..N from headcount, deducts AL input from output & locks full-week MAT/RES/TERM/UPL/PAT', () => {
    const leaveCounts: LeaveCounts = {
      annual: 5,
      maternity: 2,
      resignations: 1,
      termination: 1,
      upl: 1,
      paternity: 1,
    };
    const result = generateWeeklySchedule({
      inputMode: 'headcount',
      headcountInput: 50,
      namedAgents: [],
      leaveCounts,
      shiftCatalog: DEFAULT_SHIFT_CATALOG,
      rules: DEFAULT_SCHEDULING_RULES,
      nextWeekDays: sampleNextWeekDays(),
      dayCurves: DEFAULT_30M_CURVES,
      erlangConfig: DEFAULT_ERLANG,
    });

    // Total input = 50; 5 AL + 6 non-AL exceptions -> 39 active schedulable
    assert.equal(result.summary.totalRosterInput, 50);
    assert.equal(result.summary.annualExcluded, 5);
    assert.equal(result.summary.fullWeekExceptionsCount, 6);
    assert.equal(result.summary.activeSchedulableCount, 39);

    // By default, AL agents appear locked full-week in output table just like other leaves (50 total rows)
    assert.equal(result.visibleOutputAgents.length, 50);
    assert.equal(
      result.visibleOutputAgents.filter((a) => a.preAllocatedException === 'AL').length,
      5
    );

    // Optional exclude toggle hides AL rows cleanly while preserving active pool math
    const excludedView = generateWeeklySchedule({
      inputMode: 'headcount',
      headcountInput: 50,
      namedAgents: [],
      leaveCounts,
      shiftCatalog: DEFAULT_SHIFT_CATALOG,
      rules: { ...DEFAULT_SCHEDULING_RULES, annualVisibilityInOutput: 'exclude' },
      nextWeekDays: sampleNextWeekDays(),
      dayCurves: DEFAULT_30M_CURVES,
      erlangConfig: DEFAULT_ERLANG,
    });
    assert.equal(excludedView.visibleOutputAgents.length, 45);
    assert.equal(
      excludedView.visibleOutputAgents.filter((a) => a.preAllocatedException === 'AL').length,
      0
    );

    // Exceptions keep exact same code on all 7 days (both MAT and AL)
    const days: DayKey[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const matAgents = result.visibleOutputAgents.filter((a) => a.preAllocatedException === 'MAT');
    assert.equal(matAgents.length, 2);
    for (const m of matAgents) {
      for (const dk of days) {
        assert.equal(m.assignments[dk].status, 'MAT');
        assert.equal(m.assignments[dk].shiftId, null);
      }
    }
    const alAgents = result.visibleOutputAgents.filter((a) => a.preAllocatedException === 'AL');
    assert.equal(alAgents.length, 5);
    for (const al of alAgents) {
      for (const dk of days) {
        assert.equal(al.assignments[dk].status, 'AL');
        assert.equal(al.assignments[dk].shiftId, null);
      }
    }

    // Active agents stay Agent 1..50 named, <= 5 workdays, 2 OFF (adjacent or Sun+Mon), <= 2h drift, >= 12h rest
    const active = result.visibleOutputAgents.filter((a) => !a.preAllocatedException);
    assert.equal(active.length, 39);
    for (const agent of active) {
      assert.ok(agent.workDaysCount <= 5, `${agent.agentName} worked ${agent.workDaysCount} days`);
      assert.equal(agent.offDaysCount, 2, `${agent.agentName} did not get 2 OFF days`);
      assert.ok(
        agent.shiftBandSpanHours <= DEFAULT_SCHEDULING_RULES.maxWeeklyStartDriftHours + 1e-9,
        `${agent.agentName} shift span ${agent.shiftBandSpanHours}h exceeded 2h`
      );
      if (agent.minRestHoursObserved !== null) {
        assert.ok(
          agent.minRestHoursObserved >= DEFAULT_SCHEDULING_RULES.minInterShiftRestHours - 1e-9,
          `${agent.agentName} rest ${agent.minRestHoursObserved}h < 12h`
        );
      }
      assert.deepEqual(agent.violations, []);
    }
  });

  it('places First 15m + Lunch 30m + Last 15m breaks strictly honoring <= 3h 30m login streak & >= 1h break gap & avoids peak', () => {
    // Artificial high-peak arrival on slot 16..20 (08:00-10:00 for a 06:00-15:00 shift, or mid-morning for 09:00-18:00)
    const shift = parseShiftCatalogText('09:00-18:00')[0]; // 540 min = 36 quarter-hours
    const surplus15 = new Array(96).fill(10);
    // Make 12:30-14:00 (q=50..55) heavily understaffed (negative surplus) so Lunch prefers outside it if valid
    for (let q = 50; q <= 55; q++) surplus15[q] = -8;
    const br = assignOptimalBreaksForShift(
      shift,
      surplus15,
      DEFAULT_SCHEDULING_RULES.breakRules
    );
    assert.equal(br.isValid, true);
    assert.ok(
      br.maxContinuousWorkMin <= 210,
      `Continuous stretch ${br.maxContinuousWorkMin} exceeded 210m`
    );
    assert.ok(
      br.minInterBreakGapMin >= 60,
      `Inter-break gap ${br.minInterBreakGapMin} < 60m`
    );

    // Check lunch avoids the deep deficit band [12:30..14:00] when valid surplus slots exist inside 09:00-18:00
    const lunchAbsMin = shift.startMin + br.lunchOffsetMin;
    const touchesHeavyDeficit = lunchAbsMin >= 12 * 60 + 30 && lunchAbsMin < 14 * 60;
    assert.equal(touchesHeavyDeficit, false);
  });

  it('conserves exact net productive hours after breaks (Gross 9h - 1h Breaks = 8.0h per shift)', () => {
    const oneShift = parseShiftCatalogText('09:00-18:00');
    const result = generateWeeklySchedule({
      inputMode: 'headcount',
      headcountInput: 10,
      namedAgents: [],
      leaveCounts: { annual: 0, maternity: 0, resignations: 0, termination: 0, upl: 0, paternity: 0 },
      shiftCatalog: oneShift,
      rules: DEFAULT_SCHEDULING_RULES,
      nextWeekDays: sampleNextWeekDays(),
      dayCurves: DEFAULT_30M_CURVES,
      erlangConfig: DEFAULT_ERLANG,
    });

    // 10 active agents * 5 shifts/week * 9h gross = 450h gross, 400h net (after 1h breaks)
    const totalGross = result.dailyTotals.reduce((s, d) => s + d.scheduledGrossHours, 0);
    const totalNet = result.dailyTotals.reduce((s, d) => s + d.scheduledNetHours, 0);
    assert.ok(Math.abs(totalGross - 450) < 0.01, `Expected 450h gross, got ${totalGross}`);
    assert.ok(Math.abs(totalNet - 400) < 0.01, `Expected 400h net, got ${totalNet}`);
  });

  it('detects manual override rule violations cleanly (e.g. >5 workdays, clopening <12h, drift >2h, non-Sun+Mon split OFF)', () => {
    const result = generateWeeklySchedule({
      inputMode: 'headcount',
      headcountInput: 5,
      namedAgents: [],
      leaveCounts: { annual: 0, maternity: 0, resignations: 0, termination: 0, upl: 0, paternity: 0 },
      shiftCatalog: parseShiftCatalogText('08:00-17:00\n15:00-00:00'),
      rules: { ...DEFAULT_SCHEDULING_RULES, allowSunMonSplitOff: true },
      nextWeekDays: sampleNextWeekDays(),
      dayCurves: DEFAULT_30M_CURVES,
      erlangConfig: DEFAULT_ERLANG,
    });

    const edited = structuredClone(result.agents[0]);
    const days: DayKey[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    // Force an illegal clopening: 15:00-00:00 on Mon, then 08:00-17:00 on Tue (only 8h rest!) + make Sun WORK -> 6 workdays
    for (const dk of days) {
      edited.assignments[dk] = {
        dayKey: dk,
        status: dk === 'Thu' ? 'OFF' : 'WORK',
        shiftId: dk === 'Thu' ? null : dk === 'Mon' ? '15:00-00:00' : '08:00-17:00',
        breaks: null,
        isManualOverride: true,
      };
    }
    const rulesStrict: SchedulingRules = DEFAULT_SCHEDULING_RULES;
    const audited = validateAgentScheduleRow(
      edited,
      parseShiftCatalogText('08:00-17:00\n15:00-00:00'),
      rulesStrict
    );
    assert.equal(audited.workDaysCount, 6);
    assert.ok(audited.violations.length >= 3); // >5 days, <12h rest, >2h drift, !=2 OFF

    // Confirm Sun + Mon split OFF is valid when remaining days share safe shifts
    const splitOk = structuredClone(result.agents[1]);
    for (const dk of days) {
      const isOff = dk === 'Sun' || dk === 'Mon';
      splitOk.assignments[dk] = {
        dayKey: dk,
        status: isOff ? 'OFF' : 'WORK',
        shiftId: isOff ? null : '08:00-17:00',
        breaks: null,
      };
    }
    const auditedSplit = validateAgentScheduleRow(
      splitOk,
      parseShiftCatalogText('08:00-17:00'),
      rulesStrict
    );
    assert.deepEqual(auditedSplit.violations, []);

    // Verify recalculateScheduleCoverage updates metrics cleanly after edit
    const updated = recalculateScheduleCoverage({
      agents: result.agents.map((a, idx) => (idx === 0 ? audited : a)),
      shiftCatalog: parseShiftCatalogText('08:00-17:00\n15:00-00:00'),
      rules: rulesStrict,
      nextWeekDays: sampleNextWeekDays(),
      dayCurves: DEFAULT_30M_CURVES,
      erlangConfig: DEFAULT_ERLANG,
    });
    assert.ok(updated.summary.violationAgentsCount >= 1);
  });

  it('does not over-allocate overnight shifts when overnight calls are tiny (1-2 calls) vs daytime peak', () => {
    const withOvernight = parseShiftCatalogText(
      ['08:00-17:00', '09:00-18:00', '10:00-19:00', '12:00-21:00', '15:00-00:00', '22:00-07:00'].join('\n')
    );
    const result = generateWeeklySchedule({
      inputMode: 'headcount',
      headcountInput: 60,
      namedAgents: [],
      leaveCounts: { annual: 4, maternity: 2, resignations: 0, termination: 0, upl: 0, paternity: 0 },
      shiftCatalog: withOvernight,
      rules: DEFAULT_SCHEDULING_RULES,
      nextWeekDays: sampleNextWeekDays(),
      dayCurves: DEFAULT_30M_CURVES,
      erlangConfig: DEFAULT_ERLANG,
    });

    const nightRow = result.shiftDailyMix.find((r) => r.shiftId === '22:00-07:00');
    assert.ok(nightRow, 'Overnight shift should be tracked in shiftDailyMix');
    // Overnight curve only needs ~1 seat at 00:00-06:00 -> pool should stay tiny (<= 3 agents total, avg/day <= 2.2), never 5+
    assert.ok(
      nightRow.assignedPoolCount <= 3 && nightRow.avgPerDay <= 2.2,
      `Overnight shift was over-allocated: pool=${nightRow.assignedPoolCount}, avg/day=${nightRow.avgPerDay}`
    );

    // Majority of agents cover daytime / afternoon peak bands proportionally
    const daytimeShifts = result.shiftDailyMix
      .filter((r) => !r.wrapsMidnight)
      .reduce((s, r) => s + r.totalWeeklyShifts, 0);
    assert.ok(daytimeShifts > nightRow.totalWeeklyShifts * 8);
  });

  it('auto-sorts added shifts chronologically & enforces per-shift manual target overrides + shiftDailyMix totals', () => {
    const unsorted = parseShiftCatalogText(
      ['15:00-00:00', '22:00-07:00', '09:00-18:00', '07:00-16:00', '12:00-21:00'].join('\n')
    );
    const sorted = sortShiftCatalogChronologically(unsorted);
    assert.deepEqual(
      sorted.map((s) => s.id),
      ['07:00-16:00', '09:00-18:00', '12:00-21:00', '15:00-00:00', '22:00-07:00']
    );

    const rulesWithPins: SchedulingRules = {
      ...DEFAULT_SCHEDULING_RULES,
      shiftHeadcountOverrides: {
        '22:00-07:00': 2,
        '07:00-16:00': 6,
      },
    };
    const result = generateWeeklySchedule({
      inputMode: 'headcount',
      headcountInput: 30,
      namedAgents: [],
      leaveCounts: { annual: 2, maternity: 0, resignations: 0, termination: 0, upl: 0, paternity: 0 },
      shiftCatalog: unsorted,
      rules: rulesWithPins,
      nextWeekDays: sampleNextWeekDays(),
      dayCurves: DEFAULT_30M_CURVES,
      erlangConfig: DEFAULT_ERLANG,
    });

    const nightMix = result.shiftDailyMix.find((m) => m.shiftId === '22:00-07:00');
    const earlyMix = result.shiftDailyMix.find((m) => m.shiftId === '07:00-16:00');
    assert.equal(nightMix?.assignedPoolCount, 2);
    assert.equal(nightMix?.targetOverride, 2);
    assert.equal(earlyMix?.assignedPoolCount, 6);
    assert.equal(earlyMix?.targetOverride, 6);

    // Every shiftDailyMix row must sum exactly across Mon..Sun = totalWeeklyShifts, and total across catalog == totalWorkShifts
    let sumWeekly = 0;
    for (const row of result.shiftDailyMix) {
      const rowDaySum = (Object.values(row.byDay) as number[]).reduce((a, b) => a + b, 0);
      assert.equal(rowDaySum, row.totalWeeklyShifts);
      sumWeekly += row.totalWeeklyShifts;
    }
    assert.equal(sumWeekly, result.summary.totalWorkShifts);
  });

  it('builds a styled Concentrix Tab 4 Scheduling Dashboard Excel workbook without losing rules or totals', async () => {
    const result = generateWeeklySchedule({
      inputMode: 'headcount',
      headcountInput: 24,
      namedAgents: [],
      leaveCounts: { annual: 2, maternity: 1, resignations: 0, termination: 0, upl: 1, paternity: 0 },
      shiftCatalog: DEFAULT_SHIFT_CATALOG,
      rules: DEFAULT_SCHEDULING_RULES,
      nextWeekDays: sampleNextWeekDays(),
      dayCurves: DEFAULT_30M_CURVES,
      erlangConfig: DEFAULT_ERLANG,
    });
    const wb = await buildSchedulingWorkbook({
      scheduleResult: result,
      shiftCatalog: DEFAULT_SHIFT_CATALOG,
      rules: DEFAULT_SCHEDULING_RULES,
      erlangConfig: DEFAULT_ERLANG,
    });
    assert.ok(wb.worksheets.length >= 2);
    const buf = await wb.xlsx.writeBuffer();
    assert.ok(buf.byteLength > 5000);
  });

  it('strictly isolates pinned shifts when an Auto shift remains and routes surplus strictly away from overnight when all shifts are pinned', () => {
    const catalog8 = parseShiftCatalogText(
      [
        '00:00-09:00',
        '07:00-16:00',
        '08:00-17:00',
        '09:00-18:00',
        '10:00-19:00',
        '12:00-21:00',
        '13:00-22:00',
        '15:00-00:00',
      ].join('\n')
    );

    // Case A: 7 shifts pinned (49 heads), 1 shift left Auto ('15:00-00:00'), 58 active heads -> all 9 remaining MUST go to '15:00-00:00'
    const rulesWithOneAuto: SchedulingRules = {
      ...DEFAULT_SCHEDULING_RULES,
      shiftHeadcountOverrides: {
        '00:00-09:00': 1,
        '07:00-16:00': 4,
        '08:00-17:00': 15,
        '09:00-18:00': 12,
        '10:00-19:00': 7,
        '12:00-21:00': 5,
        '13:00-22:00': 5,
      },
    };
    const resOneAuto = generateWeeklySchedule({
      inputMode: 'headcount',
      headcountInput: 66,
      namedAgents: [],
      leaveCounts: { annual: 6, maternity: 2, resignations: 0, termination: 0, upl: 0, paternity: 0 },
      shiftCatalog: catalog8,
      rules: rulesWithOneAuto,
      nextWeekDays: sampleNextWeekDays(),
      dayCurves: DEFAULT_30M_CURVES,
      erlangConfig: DEFAULT_ERLANG,
    });
    const mixA = new Map(resOneAuto.shiftDailyMix.map((m) => [m.shiftId, m]));
    assert.equal(mixA.get('00:00-09:00')?.assignedPoolCount, 1);
    assert.equal(mixA.get('07:00-16:00')?.assignedPoolCount, 4);
    assert.equal(mixA.get('08:00-17:00')?.assignedPoolCount, 15);
    assert.equal(mixA.get('09:00-18:00')?.assignedPoolCount, 12);
    assert.equal(mixA.get('15:00-00:00')?.assignedPoolCount, 9);

    // Stratified OFF check: 07:00-16:00 pinned at 4 must NOT dump all 4 into Sat+Sun OFF (weekend > 0)
    const early07 = mixA.get('07:00-16:00')!;
    assert.ok(early07.byDay.Sat > 0 && early07.byDay.Sun > 0, `Expected non-zero weekend coverage on 07:00-16:00, got Sat=${early07.byDay.Sat}, Sun=${early07.byDay.Sun}`);

    // Case B: ALL 8 shifts pinned summing to 54 (< 58 active), leaving 4 unpinned overflow -> overnight '00:00-09:00' stays strictly at 1
    const rulesAllPinned: SchedulingRules = {
      ...DEFAULT_SCHEDULING_RULES,
      shiftHeadcountOverrides: {
        '00:00-09:00': 1,
        '07:00-16:00': 4,
        '08:00-17:00': 15,
        '09:00-18:00': 12,
        '10:00-19:00': 7,
        '12:00-21:00': 5,
        '13:00-22:00': 5,
        '15:00-00:00': 5,
      },
    };
    const resAllPinned = generateWeeklySchedule({
      inputMode: 'headcount',
      headcountInput: 66,
      namedAgents: [],
      leaveCounts: { annual: 6, maternity: 2, resignations: 0, termination: 0, upl: 0, paternity: 0 },
      shiftCatalog: catalog8,
      rules: rulesAllPinned,
      nextWeekDays: sampleNextWeekDays(),
      dayCurves: DEFAULT_30M_CURVES,
      erlangConfig: DEFAULT_ERLANG,
    });
    const mixB = new Map(resAllPinned.shiftDailyMix.map((m) => [m.shiftId, m]));
    assert.equal(mixB.get('00:00-09:00')?.assignedPoolCount, 1);
    assert.equal(resAllPinned.summary.violationAgentsCount, 0);
  });

  it('honors per-shift × per-day manual overrides (e.g. Saturday override) with zero WFM rule violations', () => {
    const rulesWithDayPin: SchedulingRules = {
      ...DEFAULT_SCHEDULING_RULES,
      shiftHeadcountOverrides: {
        '08:00-17:00': 12,
      },
      shiftDayHeadcountOverrides: {
        '08:00-17:00': { Sat: 8, Sun: 7 },
      },
    };
    const res = generateWeeklySchedule({
      inputMode: 'headcount',
      headcountInput: 45,
      namedAgents: [],
      leaveCounts: { annual: 3, maternity: 0, resignations: 0, termination: 0, upl: 0, paternity: 0 },
      shiftCatalog: DEFAULT_SHIFT_CATALOG,
      rules: rulesWithDayPin,
      nextWeekDays: sampleNextWeekDays(),
      dayCurves: DEFAULT_30M_CURVES,
      erlangConfig: DEFAULT_ERLANG,
    });
    const row08 = res.shiftDailyMix.find((m) => m.shiftId === '08:00-17:00');
    assert.ok(row08);
    assert.equal(row08.assignedPoolCount, 12);
    assert.equal(row08.byDay.Sat, 8);
    assert.equal(row08.byDay.Sun, 7);
    assert.deepEqual(row08.dayOverrides, { Sat: 8, Sun: 7 });
    assert.equal(res.summary.violationAgentsCount, 0);
    assert.equal(res.summary.validBreakRatePct, 100);
  });

  it('auto-optimizes full 8-shift 58-agent roster with balanced Mon..Sun coverage and zero violations', () => {
    const catalog8 = parseShiftCatalogText(
      [
        '00:00-09:00',
        '07:00-16:00',
        '08:00-17:00',
        '09:00-18:00',
        '10:00-19:00',
        '12:00-21:00',
        '13:00-22:00',
        '15:00-00:00',
      ].join('\n')
    );
    const res = generateWeeklySchedule({
      inputMode: 'headcount',
      headcountInput: 66,
      namedAgents: [],
      leaveCounts: { annual: 6, maternity: 2, resignations: 0, termination: 0, upl: 0, paternity: 0 },
      shiftCatalog: catalog8,
      rules: DEFAULT_SCHEDULING_RULES,
      nextWeekDays: sampleNextWeekDays(),
      dayCurves: DEFAULT_30M_CURVES,
      erlangConfig: DEFAULT_ERLANG,
    });

    assert.equal(res.summary.activeSchedulableCount, 58);
    assert.equal(res.summary.violationAgentsCount, 0);
    assert.equal(res.summary.validBreakRatePct, 100);
    // Overnight 00:00-09:00 stays lean (not overloaded) and every weekday has positive staffed hours
    const night00 = res.shiftDailyMix.find((m) => m.shiftId === '00:00-09:00');
    assert.ok(night00 && night00.avgPerDay <= 2.5);
    assert.ok(res.summary.projectedWeeklySlPct >= 75);
  });

  it('honors Palm Erlang-A abandonment modeling in recalculateScheduleCoverage under tight staffing', () => {
    const tightRes = generateWeeklySchedule({
      inputMode: 'headcount',
      headcountInput: 36,
      namedAgents: [],
      leaveCounts: { annual: 0, maternity: 0, resignations: 0, termination: 0, upl: 0, paternity: 0 },
      shiftCatalog: DEFAULT_SHIFT_CATALOG,
      rules: DEFAULT_SCHEDULING_RULES,
      nextWeekDays: sampleNextWeekDays(),
      dayCurves: DEFAULT_30M_CURVES,
      erlangConfig: DEFAULT_ERLANG,
    });

    const commonArgs = {
      agents: tightRes.agents,
      shiftCatalog: DEFAULT_SHIFT_CATALOG,
      rules: DEFAULT_SCHEDULING_RULES,
      nextWeekDays: sampleNextWeekDays(),
      dayCurves: DEFAULT_30M_CURVES,
    };

    const strictC = recalculateScheduleCoverage({
      ...commonArgs,
      erlangConfig: { ...DEFAULT_ERLANG, useErlangA: false },
    });
    const palmA = recalculateScheduleCoverage({
      ...commonArgs,
      erlangConfig: { ...DEFAULT_ERLANG, useErlangA: true, avgPatienceSec: 120 },
    });

    assert.ok(
      palmA.summary.projectedWeeklySlPct > strictC.summary.projectedWeeklySlPct,
      `Expected Erlang-A SL (${palmA.summary.projectedWeeklySlPct}%) > strict Erlang-C SL (${strictC.summary.projectedWeeklySlPct}%) under tight staffing`
    );
  });

  it('maintains smooth continuous AHT sensitivity in buildWhatIfMatrix anchored to custom Cap Plan hours', () => {
    const intervalInputs = buildIntervalInputsForGranularity(DEFAULT_30M_CURVES.Mon, 30);
    const customCapCfg: CapacityConfig = {
      route: 'erlang_c',
      erlangProductiveHoursPerDay: 312,
      pureTalkHoursPerDay: 226.58,
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
        sickLeavePct: 5,
        publicHolidaysPct: 4,
        unplannedAbsencePct: 3,
      },
      attritionRampBufferPct: 0,
    };

    const ahtDeltas = [-10, 0, 10];
    const shrinkDeltas = [-2, 0, 2];
    const matrix = buildWhatIfMatrix(intervalInputs, DEFAULT_ERLANG, customCapCfg, ahtDeltas, shrinkDeltas);

    const rowNeg = matrix[0];
    const rowBase = matrix[1];
    const rowPos = matrix[2];
    const baseCell = rowBase[1];

    assert.equal(baseCell.deltaFte, 0);
    assert.ok(rowNeg[1].finalGrossFte < baseCell.finalGrossFte, `Expected -10s AHT FTE (${rowNeg[1].finalGrossFte}) < base (${baseCell.finalGrossFte})`);
    assert.ok(rowPos[1].finalGrossFte > baseCell.finalGrossFte, `Expected +10s AHT FTE (${rowPos[1].finalGrossFte}) > base (${baseCell.finalGrossFte})`);
    assert.ok(rowBase[0].finalGrossFte < baseCell.finalGrossFte && rowBase[2].finalGrossFte > baseCell.finalGrossFte);
  });

  it('applies top-card pinned distribution (1,4,15,12,7,5,5,4) strictly to Mon–Thu and auto-distributes remaining shifts across Fri–Sun', () => {
    const catalog8 = parseShiftCatalogText(
      [
        '00:00-09:00',
        '07:00-16:00',
        '08:00-17:00',
        '09:00-18:00',
        '10:00-19:00',
        '12:00-21:00',
        '13:00-22:00',
        '15:00-00:00',
      ].join('\n')
    );
    const expectedMonThu: Record<string, number> = {
      '00:00-09:00': 1,
      '07:00-16:00': 4,
      '08:00-17:00': 15,
      '09:00-18:00': 12,
      '10:00-19:00': 7,
      '12:00-21:00': 5,
      '13:00-22:00': 5,
      '15:00-00:00': 4,
    };
    const res = generateWeeklySchedule({
      inputMode: 'headcount',
      headcountInput: 66,
      namedAgents: [],
      leaveCounts: { annual: 5, maternity: 2, resignations: 0, termination: 0, upl: 0, paternity: 0 },
      shiftCatalog: catalog8,
      rules: {
        ...DEFAULT_SCHEDULING_RULES,
        shiftHeadcountOverrides: expectedMonThu,
      },
      nextWeekDays: sampleNextWeekDays(),
      dayCurves: DEFAULT_30M_CURVES,
      erlangConfig: DEFAULT_ERLANG,
    });

    assert.equal(res.summary.activeSchedulableCount, 59);
    assert.equal(res.summary.totalWorkShifts, 295);
    assert.equal(res.summary.violationAgentsCount, 0);

    let friSatSunTotal = 0;
    for (const row of res.shiftDailyMix) {
      const target = expectedMonThu[row.shiftId];
      assert.equal(row.assignedPoolCount, target, `${row.shiftId} pool badge mismatch`);
      assert.equal(row.byDay.Mon, target, `${row.shiftId} Mon`);
      assert.equal(row.byDay.Tue, target, `${row.shiftId} Tue`);
      assert.equal(row.byDay.Wed, target, `${row.shiftId} Wed`);
      assert.equal(row.byDay.Thu, target, `${row.shiftId} Thu`);
      friSatSunTotal += row.byDay.Fri + row.byDay.Sat + row.byDay.Sun;
    }
    assert.equal(friSatSunTotal, 83);
  });

  it('locks manually edited Sun column cells (1,2,5,5,3,2,3,3) into the agent roster while auto-balancing unedited days', () => {
    const catalog8 = parseShiftCatalogText(
      [
        '00:00-09:00',
        '07:00-16:00',
        '08:00-17:00',
        '09:00-18:00',
        '10:00-19:00',
        '12:00-21:00',
        '13:00-22:00',
        '15:00-00:00',
      ].join('\n')
    );
    const monThuPins: Record<string, number> = {
      '00:00-09:00': 1,
      '07:00-16:00': 4,
      '08:00-17:00': 15,
      '09:00-18:00': 12,
      '10:00-19:00': 7,
      '12:00-21:00': 5,
      '13:00-22:00': 5,
      '15:00-00:00': 4,
    };
    const sunExpected: Record<string, number> = {
      '00:00-09:00': 1,
      '07:00-16:00': 2,
      '08:00-17:00': 5,
      '09:00-18:00': 5,
      '10:00-19:00': 3,
      '12:00-21:00': 2,
      '13:00-22:00': 3,
      '15:00-00:00': 3,
    };
    const sunDayOverrides = Object.fromEntries(
      Object.entries(sunExpected).map(([shId, val]) => [shId, { Sun: val }])
    );

    const resCombined = generateWeeklySchedule({
      inputMode: 'headcount',
      headcountInput: 66,
      namedAgents: [],
      leaveCounts: { annual: 5, maternity: 2, resignations: 0, termination: 0, upl: 0, paternity: 0 },
      shiftCatalog: catalog8,
      rules: {
        ...DEFAULT_SCHEDULING_RULES,
        shiftHeadcountOverrides: monThuPins,
        shiftDayHeadcountOverrides: sunDayOverrides,
      },
      nextWeekDays: sampleNextWeekDays(),
      dayCurves: DEFAULT_30M_CURVES,
      erlangConfig: DEFAULT_ERLANG,
    });

    assert.equal(resCombined.summary.totalWorkShifts, 295);
    assert.equal(resCombined.summary.violationAgentsCount, 0);

    for (const row of resCombined.shiftDailyMix) {
      assert.equal(row.byDay.Sun, sunExpected[row.shiftId], `${row.shiftId} Sun in shiftDailyMix`);
      const rosterSunCount = resCombined.agents.filter(
        (ag) => ag.assignments.Sun.status === 'WORK' && ag.assignments.Sun.shiftId === row.shiftId
      ).length;
      assert.equal(rosterSunCount, sunExpected[row.shiftId], `${row.shiftId} Sun in agents roster`);
      assert.equal(row.byDay.Mon, monThuPins[row.shiftId]);
      assert.equal(row.byDay.Tue, monThuPins[row.shiftId]);
      assert.equal(row.byDay.Wed, monThuPins[row.shiftId]);
      assert.equal(row.byDay.Thu, monThuPins[row.shiftId]);
    }
  });
});
