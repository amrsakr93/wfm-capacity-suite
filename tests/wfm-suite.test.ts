import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  erlangB,
  erlangC,
  computeErlangCMetrics,
  computeErlangAMetrics,
  solveRequiredAgents,
  runErlangPlanner,
  generateTimeLabels,
} from '../src/engine/erlang.ts';
import { calculateCapacityWaterfall } from '../src/engine/capacity.ts';
import { runForecastingStudio, fitOLS, buildFutureHorizonSummary } from '../src/engine/forecasting.ts';
import { parseTextDataset } from '../src/engine/parsers.ts';
import { buildSampleDailyHistory, DEFAULT_30M_CURVES, buildIntervalInputsForGranularity } from '../src/engine/samples.ts';
import {
  handleRequestOtp,
  handleVerifyOtp,
  handleGetSession,
  resolveAuthMode,
} from '../lib/auth-core.ts';

describe('Erlang C & Palm/Erlang A Mathematical Engine', () => {
  it('matches ErlangXL97 VBA precision & avoids factorial overflow at high traffic (A=650)', () => {
    // Low traffic textbook sanity check: A = 2.5 (30 calls/hr * 300s / 3600 = 2.5), N = 5
    const pw = erlangC(5, 2.5);
    assert.ok(pw > 0.12 && pw < 0.14, `Expected Pw ~0.1304, got ${pw}`);

    const m = computeErlangCMetrics(5, 30, 300, 3600, 20);
    // ASA = 0.13037 * 300 / 2.5 ~= 15.64s
    assert.ok(Math.abs(m.asaSec - 15.64) < 0.25, `ASA mismatch: ${m.asaSec}`);
    // SL(20s) = 1 - Pw * exp(-2.5 * 20 / 300) ~= 88.96%
    assert.ok(Math.abs(m.slPct - 88.96) < 0.3, `SL mismatch: ${m.slPct}`);

    // Overflow test: A = 650, N = 685 (685! would overflow IEEE754 Number to Infinity if naive)
    const bHigh = erlangB(685, 650);
    const cHigh = erlangC(685, 650);
    assert.ok(Number.isFinite(bHigh) && bHigh > 0 && bHigh < 1);
    assert.ok(Number.isFinite(cHigh) && cHigh > 0 && cHigh < 1);
  });

  it('matches Erlang-C asymptotically when Erlang-A patience is very high (1e9)', () => {
    const c = computeErlangCMetrics(14, 100, 300, 3600, 20);
    const a = computeErlangAMetrics(14, 100, 300, 3600, 20, 1e9);
    assert.ok(Math.abs(c.probWaitPct - a.probWaitPct) < 1e-4, `Pw diff: ${c.probWaitPct} vs ${a.probWaitPct}`);
    assert.ok(Math.abs(c.slPct - a.slPct) < 1e-3, `SL diff: ${c.slPct} vs ${a.slPct}`);
    assert.ok((a.abandonPct ?? 1) < 1e-5);
  });

  it('models abandonment savings properly in Erlang-A with realistic patience', () => {
    const c = computeErlangCMetrics(10, 110, 300, 3600, 20); // A = 9.17 -> tight
    const a = computeErlangAMetrics(10, 110, 300, 3600, 20, 90);
    assert.ok((a.abandonPct ?? 0) > 0 && (a.abandonPct ?? 0) < 35);
    assert.ok(a.slPct >= c.slPct, 'Abandonment reduces queue buildup and improves remaining caller SL');
  });

  it('matches ErlangXL97 Module1 Agents & FractionalAgents in pure SLA mode and supports optional guardrails', () => {
    // Pure ErlangXL97 Example sheet test: SLA=85%, ServiceTime=7s, CallsPerHour=100, AHT=180s (A=5.0)
    // In ErlangXL97 Sheet "Example" Row 8: Agents(85%, 7, 100, 180) = 8 agents (SL(7)=70.2%, SL(8)=85.3%)
    const ex = solveRequiredAgents(100, 180, 3600, {
      slTargetPct: 85,
      slThresholdSec: 7,
      maxAsaSec: 30,
      maxOccupancyPct: 85,
      enforceMaxAsa: false,
      enforceOccupancyCap: false,
      agentMode: 'fractional',
      minAgentsFloor: 0,
      useErlangA: false,
      avgPatienceSec: 90,
    });
    assert.equal(ex.integerSeats, 8);
    assert.ok(ex.fractionalSeats > 7.9 && ex.fractionalSeats < 8.0, `Expected fractional ~7.98, got ${ex.fractionalSeats}`);

    // Guardrail enforcement when explicitly enabled
    const solved = solveRequiredAgents(120, 300, 3600, {
      slTargetPct: 80,
      slThresholdSec: 20,
      maxAsaSec: 25,
      maxOccupancyPct: 80,
      enforceMaxAsa: true,
      enforceOccupancyCap: true,
      minAgentsFloor: 2,
      useErlangA: false,
      avgPatienceSec: 90,
    });
    assert.ok(solved.metrics.slPct >= 80);
    assert.ok(solved.metrics.asaSec <= 25);
    assert.ok(solved.metrics.occupancyPct <= 80);
    assert.ok(solved.requiredSeats >= 13); // A = 10 -> Occ <= 80% forces N >= 13
  });

  it('runs 30-min interval schedule conserving exact daily volume (zero rounding drift on 2904)', () => {
    const inputs = buildIntervalInputsForGranularity(DEFAULT_30M_CURVES.Mon, 30);
    const res = runErlangPlanner(inputs, {
      dailyVolume: 2904,
      granularityMin: 30,
      operating24x7: true,
      startHour: 8,
      endHour: 22,
      globalAhtSec: 300,
      slTargetPct: 80,
      slThresholdSec: 20,
      maxAsaSec: 30,
      maxOccupancyPct: 85,
      enforceMaxAsa: false,
      enforceOccupancyCap: false,
      agentMode: 'integer',
      minAgentsFloor: 0,
      useErlangA: false,
      avgPatienceSec: 90,
      selectedDay: 'Mon',
    });
    assert.equal(res.rows.length, 48);
    assert.equal(res.totalVolume, 2904); // Exact largest-remainder volume conservation!
    assert.ok(res.totalProductiveHours > res.totalPureTalkHours);
    assert.ok(res.totalFractionalProductiveHours <= res.totalIntegerProductiveHours);
  });
});

describe('Capacity & Shrinkage FTE Waterfall (No Double-Counting)', () => {
  it('reproduces Cap Plan Sheet benchmark math cleanly (240 prod hrs, 9-1=8 login, 3% in-office, 7/5 weekly, 10% inflex, 20% OOO -> ~60 FTE)', () => {
    const cap = calculateCapacityWaterfall({
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
        meetingsHuddlesPct: 1,
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

    assert.equal(cap.effectivePaidShiftHours, 8);
    assert.equal(cap.dailyRequiredSeats, 30); // 240 / 8 = 30
    // 240 / (8 * 0.97) * (7/5) * 1.1 / 0.8 = 59.536 -> rounds to 60 agents!
    assert.ok(Math.abs(cap.finalGrossFte - 59.54) < 0.25, `Expected ~59.54 FTE, got ${cap.finalGrossFte}`);
    // Compound shrinkage = 1 - (0.97 * 0.80) = 22.4%
    assert.ok(Math.abs(cap.compoundTotalShrinkagePct - 22.4) < 0.01);
  });
});

describe('Conrad Carlberg Forecasting Studio Engine (All 12 Book Methods)', () => {
  it('computes exact OLS slope, intercept and R2 = 1 on noiseless linear series', () => {
    const series = [110, 120, 130, 140, 150, 160];
    const ols = fitOLS(series);
    assert.ok(Math.abs(ols.slope - 10) < 1e-6);
    assert.ok(Math.abs(ols.intercept - 100) < 1e-6);
    assert.ok(Math.abs(ols.r2 - 1) < 1e-6);
  });

  it('auto-optimizes all 12 Carlberg models with chronological 80/20 holdout & builds Next Week / Current Month / Next Month horizons', () => {
    const sample = buildSampleDailyHistory();
    const out = runForecastingStudio(sample, {
      periodicity: 'daily',
      holdoutRatio: 0.2,
      horizon: 7,
      smaWindow: 7,
      wmaWeights: [0.1, 0.2, 0.3, 0.4],
      seasonLength: 7,
      autoOptimize: true,
      manualModel: 'holt_winters_mult',
      manualAlpha: 0.3,
      manualGamma: 0.1,
      manualDelta: 0.3,
    });

    assert.equal(out.cleanedSeries.length, 56);
    assert.equal(out.trainLength, 45);
    assert.equal(out.holdoutLength, 11);
    assert.equal(out.models.length, 12); // All 12 Conrad Carlberg methods!
    const best = out.models.find((m) => m.isBest)!;
    assert.ok(best.holdoutMetrics.wmape < 12, `Expected accurate seasonal holdout <12%, got ${best.holdoutMetrics.wmape}`);
    assert.equal(best.futureForecast.length, 7);
    assert.equal(best.extendedFutureForecast.length, 60);

    const horizonSummary = buildFutureHorizonSummary(sample, best, 'daily');
    assert.equal(horizonSummary.nextWeekDays.length, 7);
    assert.equal(horizonSummary.currentMonthDays.length, 30);
    assert.equal(horizonSummary.nextMonthDays.length, 30);
    assert.ok(horizonSummary.nextWeekTotal > 5000);
    assert.ok(horizonSummary.currentMonthTotal > 20000);
    assert.ok(horizonSummary.nextMonthTotal > 20000);
  });
});

describe('Smart Multi-Format Historical Parsers', () => {
  it('parses Cross-Tab Pivot (12h AM/PM intervals x M/D/YYYY dates, blank=0, ignores Total row)', () => {
    const tsv = [
      'Interval\t3/27/2026\t3/28/2026\t3/29/2026\tTotal',
      '12:00:00 AM\t4\t\t5\t9',
      '8:00:00 AM\t40\t10\t50\t100',
      '12:30:00 PM\t60\t20\t70\t150',
      'Total\t104\t30\t125\t259',
    ].join('\n');

    const parsed = parseTextDataset(tsv);
    assert.equal(parsed.format, 'crosstab_pivot');
    assert.equal(parsed.dailySeries.length, 3);
    assert.equal(parsed.dailySeries[0].date, '2026-03-27');
    assert.equal(parsed.dailySeries[0].volume, 104);
    assert.equal(parsed.dailySeries[1].volume, 30);
    assert.ok(parsed.dayCurves && parsed.dayOfWeekShares);
  });

  it('parses 48x7 Heatmap format cleanly', () => {
    const labels = generateTimeLabels(30);
    const lines = ['Interval\tMon\tTue\tWed\tThu\tFri\tSat\tSun'];
    for (const lbl of labels) {
      lines.push(`${lbl}\t10\t10\t10\t10\t5\t2\t2`);
    }
    lines.push('Total\t480\t480\t480\t480\t240\t96\t96');
    const parsed = parseTextDataset(lines.join('\n'));
    assert.equal(parsed.format, 'heatmap_48x7');
    assert.equal(parsed.granularityMinGuess, 30);
    assert.ok(parsed.dayCurves!.Mon.length === 48);
    assert.ok(Math.abs(parsed.dayOfWeekShares!.Mon - parsed.dayOfWeekShares!.Sat * 5) < 0.2);
  });
});

describe('SharePoint + Power Automate Auth Core Security', () => {
  it('fails closed (503) when unconfigured (no PA URLs and AUTH_MODE != demo)', async () => {
    assert.equal(resolveAuthMode({}), 'unconfigured');
    const res = await handleRequestOtp({ email: 'agent@company.com', channel: 'both' }, {});
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'AUTH_NOT_CONFIGURED');
  });

  it('supports demo challenge OTP lifecycle & sets signed HttpOnly cookie verification', async () => {
    const env = { AUTH_MODE: 'demo', SESSION_SECRET: 'super-secret-test-signing-key-32ch' };
    const reqRes = await handleRequestOtp({ email: 'Planner@Company.com', channel: 'teams' }, env);
    assert.equal(reqRes.status, 200);
    assert.equal(reqRes.body.channel, 'teams');
    const code = String(reqRes.body.demoCodePreview);
    const challengeToken = String(reqRes.body.challengeToken);

    // Wrong code must fail 401
    const badVerify = await handleVerifyOtp(
      { email: 'planner@company.com', code: '000000', challengeToken },
      env,
      true
    );
    assert.equal(badVerify.status, 401);

    // Correct code issues HttpOnly cookie & validates session
    const goodVerify = await handleVerifyOtp(
      { email: 'planner@company.com', code, challengeToken },
      env,
      true
    );
    assert.equal(goodVerify.status, 200);
    assert.equal(goodVerify.body.authenticated, true);
    assert.ok(goodVerify.cookies && goodVerify.cookies[0].includes('HttpOnly'));

    const cookiePair = goodVerify.cookies![0].split(';')[0];
    const sessRes = await handleGetSession(cookiePair, env);
    assert.equal(sessRes.body.authenticated, true);
    assert.equal(sessRes.body.email, 'planner@company.com');
  });

  it('forwards Teams + Outlook OTP payloads securely to Power Automate HTTP triggers', async () => {
    const capturedCalls: { url: string; body: string; secret: string | null }[] = [];
    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      capturedCalls.push({
        url: String(url),
        body: String(init?.body ?? ''),
        secret: headers['x-wfm-secret'] ?? null,
      });
      if (String(url).includes('send')) {
        return new Response(JSON.stringify({ sent: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ authenticated: true }), { status: 200 });
    }) as typeof fetch;

    const env = {
      PA_SEND_OTP_URL: 'https://prod-00.westeurope.logic.azure.com/send',
      PA_VERIFY_OTP_URL: 'https://prod-00.westeurope.logic.azure.com/verify',
      PA_SHARED_SECRET: 'shared-pa-token',
      SESSION_SECRET: 'prod-session-signing-secret-123456',
    };

    const r1 = await handleRequestOtp({ email: 'amr@company.com', channel: 'both' }, env, mockFetch);
    assert.equal(r1.status, 200);
    assert.equal(r1.body.mode, 'power_automate');
    assert.equal(r1.body.demoCodePreview, undefined);
    assert.equal(capturedCalls[0].secret, 'shared-pa-token');
    assert.match(capturedCalls[0].body, /"channel":"both"/);

    const r2 = await handleVerifyOtp({ email: 'amr@company.com', code: '654321' }, env, true, mockFetch);
    assert.equal(r2.status, 200);
    assert.equal(r2.body.authenticated, true);
    assert.equal(capturedCalls.length, 2);
  });

  it('reproduces exact 81,563 Monthly Cap Plan spreadsheet (13/hr -> 312h/day -> 79 Agents) and Monday-start Next Week', () => {
    const monthlyOffered = 81563;
    const monthDays = 30;
    const hoops = 24;
    const dailyOffered = monthlyOffered / monthDays; // 2718.7667
    const hourlyOffered = dailyOffered / hoops; // 113.2819

    const hourlyErlang = solveRequiredAgents(hourlyOffered, 300, 3600, {
      slTargetPct: 80,
      slThresholdSec: 30,
      enforceMaxAsa: false,
      maxAsaSec: 9999,
      enforceOccupancyCap: false,
      maxOccupancyPct: 85,
      useErlangA: false,
      avgPatienceSec: 180,
      minAgentsFloor: 0,
      agentMode: 'integer',
    });

    assert.equal(hourlyErlang.integerSeats, 13);
    assert.equal(hourlyErlang.requiredSeats, 13);
    assert.ok(hourlyErlang.fractionalSeats > 12 && hourlyErlang.fractionalSeats < 13);
    const reqPerDayHours = hourlyErlang.requiredSeats * hoops;
    assert.equal(reqPerDayHours, 312);

    const cap = calculateCapacityWaterfall({
      route: 'erlang_c',
      erlangProductiveHoursPerDay: reqPerDayHours,
      pureTalkHoursPerDay: (dailyOffered * 300) / 3600,
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
        annualLeavePct: 10.0,
        sickLeavePct: 5.0,
        publicHolidaysPct: 4.0,
        unplannedAbsencePct: 3.0,
      },
      attritionRampBufferPct: 0,
    });

    assert.ok(Math.abs(cap.netProductiveHoursPerShiftPerFte - 6.0528) < 1e-4);
    assert.equal(Math.round(cap.finalGrossFte), 79);

    // Also verify Next Week Forecast starts on Monday (Mon -> Sun) even when history ends on Wednesday
    const wedEndHistory = buildSampleDailyHistory().slice(0, 52); // ends on Wednesday
    const studio = runForecastingStudio(wedEndHistory, {
      periodicity: 'daily',
      holdoutRatio: 0.2,
      horizon: 14,
      smaWindow: 7,
      wmaWeights: [0.1, 0.2, 0.3, 0.4],
      seasonLength: 7,
      autoOptimize: true,
      manualModel: 'holt_winters_mult',
      manualAlpha: 0.3,
      manualGamma: 0.1,
      manualDelta: 0.3,
    });
    const futureHorizon = buildFutureHorizonSummary(
      wedEndHistory,
      studio.models[0],
      'daily'
    );
    assert.equal(futureHorizon.nextWeekDays.length, 7);
    assert.equal(futureHorizon.nextWeekDays[0].dayKey, 'Mon');
    assert.equal(futureHorizon.nextWeekDays[6].dayKey, 'Sun');
  });
});


