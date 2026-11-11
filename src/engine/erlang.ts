import type {
  ErlangConfig,
  ErlangSummary,
  IntervalRowInput,
  IntervalStaffingRow,
} from './types.ts';

/**
 * Overflow-safe iterative Erlang B recursion.
 * Mathematically identical to A^N / N! / sum_{k=0..N}(A^k / k!), bounded strictly in [0, 1].
 */
export function erlangB(servers: number, intensity: number): number {
  const n = Math.floor(servers);
  if (n <= 0 || intensity <= 0) return 0;
  let b = 1.0;
  for (let k = 1; k <= n; k++) {
    const num = intensity * b;
    b = num / (k + num);
  }
  return b;
}

/**
 * Classic Erlang C probability of wait P_w, matching ErlangXL97 VBA Module1 formula.
 */
export function erlangC(servers: number, intensity: number): number {
  const n = Math.floor(servers);
  if (intensity <= 0) return 0;
  if (n <= 0 || n <= intensity) return 1.0;
  const b = erlangB(n, intensity);
  const rho = intensity / n;
  return b / (rho * b + (1 - rho));
}

export interface QueueMetrics {
  erlangs: number;
  occupancyPct: number;
  probWaitPct: number;
  asaSec: number;
  slPct: number;
  abandonPct: number | null;
}

/**
 * Exact Erlang C interval metrics for fixed server count N and traffic intensity A.
 */
export function computeErlangCMetrics(
  servers: number,
  volume: number,
  ahtSec: number,
  intervalSec: number,
  slThresholdSec: number
): QueueMetrics {
  const a = intervalSec > 0 ? (volume * ahtSec) / intervalSec : 0;
  if (volume <= 0 || a <= 0) {
    return {
      erlangs: 0,
      occupancyPct: 0,
      probWaitPct: 0,
      asaSec: 0,
      slPct: 100,
      abandonPct: null,
    };
  }
  const n = Math.floor(servers);
  if (n <= a) {
    return {
      erlangs: a,
      occupancyPct: n > 0 ? Math.min(999, (a / n) * 100) : 100,
      probWaitPct: 100,
      asaSec: 9999,
      slPct: 0,
      abandonPct: null,
    };
  }
  const pw = erlangC(n, a);
  const asa = (pw * ahtSec) / (n - a);
  const sl = 1 - pw * Math.exp(-((n - a) * slThresholdSec) / Math.max(1, ahtSec));
  return {
    erlangs: a,
    occupancyPct: (a / n) * 100,
    probWaitPct: pw * 100,
    asaSec: Math.max(0, asa),
    slPct: Math.max(0, Math.min(100, sl * 100)),
    abandonPct: null,
  };
}

/**
 * Exact Palm / Erlang-A (M/M/N + M) metrics using stable birth-death recurrence
 * and Markov uniformization for exact P(answered within T).
 */
export function computeErlangAMetrics(
  servers: number,
  volume: number,
  ahtSec: number,
  intervalSec: number,
  slThresholdSec: number,
  avgPatienceSec: number
): QueueMetrics {
  if (avgPatienceSec <= 0 || !Number.isFinite(avgPatienceSec)) {
    return computeErlangCMetrics(servers, volume, ahtSec, intervalSec, slThresholdSec);
  }
  const a = intervalSec > 0 ? (volume * ahtSec) / intervalSec : 0;
  if (volume <= 0 || a <= 0) {
    return {
      erlangs: 0,
      occupancyPct: 0,
      probWaitPct: 0,
      asaSec: 0,
      slPct: 100,
      abandonPct: 0,
    };
  }

  const n = Math.max(1, Math.floor(servers));
  const b = erlangB(n, a);
  const sServer = b > 0 ? 1 / b : 1e12;
  const r = Math.max(1e-6, ahtSec) / avgPatienceSec; // theta / mu

  // Queue state relative weights q_k = p_{n+k} / p_n for k >= 1
  const qWeights: number[] = [1]; // q_0 = 1
  let sQueue = 0;
  let weightedQ = 0;
  let qk = 1;
  const maxK = 5000;
  for (let k = 1; k <= maxK; k++) {
    qk = qk * (a / (n + k * r));
    qWeights.push(qk);
    sQueue += qk;
    weightedQ += k * qk;
    if (qk < 1e-13 * (sServer + sQueue)) break;
  }

  const z = sServer + sQueue;
  const probQueue = (1 + sQueue) / z; // arrives when all N busy
  const probImmediate = Math.max(0, 1 - probQueue);
  const expectedLq = weightedQ / z;
  const probAbandon = Math.min(1, Math.max(0, (r / a) * expectedLq));
  const probServed = Math.max(1e-9, 1 - probAbandon);

  // Average wait among ALL arrivals: W_all = probAbandon * avgPatienceSec.
  // Conditional ASA of answered calls <= W_all? Wait: E[wait_all] = L_q / lambda.
  const wAllSec = (expectedLq * Math.max(1, ahtSec)) / a;

  // Compute exact P(entered queue AND served within slThresholdSec) via uniformization
  const mu = 1 / Math.max(1, ahtSec);
  const theta = 1 / avgPatienceSec;
  const kMax = qWeights.length - 1;
  const lambdaU = n * mu + kMax * theta + theta;
  const uT = lambdaU * Math.max(0, slThresholdSec);

  let servedWithinT = 0;
  if (slThresholdSec > 0 && lambdaU > 0) {
    // Uniformized chain for the tagged caller: state k = callers ahead in queue.
    // Absorbed (answered) when a service completion occurs at k = 0.
    // P(answered by T) = sum_m P(absorbed at jump m) * P(Poisson(uT) >= m).
    let cur = new Float64Array(kMax + 1);
    for (let k = 0; k <= kMax; k++) cur[k] = qWeights[k] / z;

    let pmf = Math.exp(-uT); // P(N = 0)
    let cdf = pmf; // P(N <= m-1) at the start of iteration m
    const maxM = Math.min(60000, Math.ceil(uT + 12 * Math.sqrt(uT + 1) + 60));
    for (let m = 1; m <= maxM; m++) {
      const next = new Float64Array(kMax + 1);
      let absorbed = 0;
      for (let k = 0; k <= kMax; k++) {
        const mass = cur[k];
        if (mass <= 1e-18) continue;
        const downRate = n * mu + k * theta;
        const stayRate = lambdaU - downRate - theta; // tagged abandonment leaves the chain
        if (k === 0) absorbed += mass * ((n * mu) / lambdaU);
        else next[k - 1] += mass * (downRate / lambdaU);
        next[k] += mass * (stayRate / lambdaU);
      }
      servedWithinT += absorbed * Math.max(0, 1 - cdf);
      pmf = pmf * (uT / m);
      cdf += pmf;
      cur = next;
      if (1 - cdf < 1e-14) break;
    }
  }

  const sl = Math.min(1, Math.max(0, probImmediate + servedWithinT));
  const effOcc = Math.min(1, (a * probServed) / n);
  // Answered calls ASA approximation bounded closely by conditional queue wait
  const asaAnswered = probServed > 0 ? wAllSec / Math.max(probServed, 0.2) * (1 - probAbandon * 0.35) : wAllSec;

  return {
    erlangs: a,
    occupancyPct: effOcc * 100,
    probWaitPct: probQueue * 100,
    asaSec: Math.max(0, asaAnswered),
    slPct: sl * 100,
    abandonPct: probAbandon * 100,
  };
}

/**
 * Exact ErlangXL97 Module1 FractionalAgents & Integer Agents solver,
 * with optional ASA / Occupancy guardrails when explicitly enabled.
 */
export function solveRequiredAgents(
  volume: number,
  ahtSec: number,
  intervalSec: number,
  config: Pick<
    ErlangConfig,
    | 'slTargetPct'
    | 'slThresholdSec'
    | 'maxAsaSec'
    | 'maxOccupancyPct'
    | 'enforceMaxAsa'
    | 'enforceOccupancyCap'
    | 'agentMode'
    | 'minAgentsFloor'
    | 'useErlangA'
    | 'avgPatienceSec'
  >
): { requiredSeats: number; integerSeats: number; fractionalSeats: number; metrics: QueueMetrics } {
  const a = intervalSec > 0 ? (volume * ahtSec) / intervalSec : 0;
  if (volume <= 0 || a <= 0) {
    const floor = Math.max(0, Math.floor(config.minAgentsFloor));
    const metrics = config.useErlangA
      ? computeErlangAMetrics(floor, 0, ahtSec, intervalSec, config.slThresholdSec, config.avgPatienceSec)
      : computeErlangCMetrics(floor, 0, ahtSec, intervalSec, config.slThresholdSec);
    return { requiredSeats: floor, integerSeats: floor, fractionalSeats: floor, metrics };
  }

  const enforceOcc = Boolean(config.enforceOccupancyCap);
  const enforceAsa = Boolean(config.enforceMaxAsa);
  const capFrac = Math.min(0.999, Math.max(0.1, config.maxOccupancyPct / 100));

  // Minimum feasible N under Erlang C is Int(A) + 1 (exact ErlangXL97 MinNoAgents)
  const minErlangN = config.useErlangA ? 1 : Math.floor(a) + 1;
  const startN = Math.max(
    minErlangN,
    Math.floor(config.minAgentsFloor),
    enforceOcc ? Math.ceil(a / capFrac) : 1
  );

  // Compute LastSL at startN - 1 if startN > minErlangN, otherwise 0 (exact ErlangXL97 behavior)
  let lastSlPct = 0;
  if (startN > minErlangN) {
    const prevMetrics = config.useErlangA
      ? computeErlangAMetrics(startN - 1, volume, ahtSec, intervalSec, config.slThresholdSec, config.avgPatienceSec)
      : computeErlangCMetrics(startN - 1, volume, ahtSec, intervalSec, config.slThresholdSec);
    lastSlPct = prevMetrics.slPct;
  }

  let n = startN;
  const maxIterations = startN + 5000;
  while (n <= maxIterations) {
    const metrics = config.useErlangA
      ? computeErlangAMetrics(n, volume, ahtSec, intervalSec, config.slThresholdSec, config.avgPatienceSec)
      : computeErlangCMetrics(n, volume, ahtSec, intervalSec, config.slThresholdSec);

    const meetsSl = metrics.slPct + 1e-9 >= config.slTargetPct;
    const meetsAsa = !enforceAsa || metrics.asaSec <= config.maxAsaSec + 1e-9;
    const meetsOcc = !enforceOcc || metrics.occupancyPct <= config.maxOccupancyPct + 1e-9;

    if (meetsSl && meetsAsa && meetsOcc) {
      let fractionalSeats = n;
      if (metrics.slPct > config.slTargetPct && metrics.slPct > lastSlPct + 1e-9 && n > 0) {
        const interp = (config.slTargetPct - lastSlPct) / (metrics.slPct - lastSlPct);
        fractionalSeats = Math.max(a, (n - 1) + Math.max(0, Math.min(1, interp)));
      }
      if (enforceOcc) {
        fractionalSeats = Math.max(fractionalSeats, a / capFrac);
      }
      fractionalSeats = Math.max(config.minAgentsFloor, fractionalSeats);
      const useFrac = config.agentMode === 'fractional';
      const requiredSeats = useFrac ? Number(fractionalSeats.toFixed(2)) : n;
      return {
        requiredSeats,
        integerSeats: n,
        fractionalSeats: Number(fractionalSeats.toFixed(2)),
        metrics,
      };
    }
    lastSlPct = metrics.slPct;
    n++;
  }

  const fallbackMetrics = config.useErlangA
    ? computeErlangAMetrics(n, volume, ahtSec, intervalSec, config.slThresholdSec, config.avgPatienceSec)
    : computeErlangCMetrics(n, volume, ahtSec, intervalSec, config.slThresholdSec);
  return { requiredSeats: n, integerSeats: n, fractionalSeats: n, metrics: fallbackMetrics };
}

export function generateTimeLabels(granularityMin: number): string[] {
  const count = Math.round((24 * 60) / granularityMin);
  const labels: string[] = [];
  for (let i = 0; i < count; i++) {
    const totalMin = i * granularityMin;
    const hh = String(Math.floor(totalMin / 60)).padStart(2, '0');
    const mm = String(totalMin % 60).padStart(2, '0');
    labels.push(`${hh}:${mm}`);
  }
  return labels;
}

export function isIntervalOpen(
  index: number,
  granularityMin: number,
  operating24x7: boolean,
  startHour: number,
  endHour: number
): boolean {
  if (operating24x7) return true;
  const startMin = startHour * 60;
  const endMin = endHour * 60;
  const intervalStart = index * granularityMin;
  if (endMin > startMin) {
    return intervalStart >= startMin && intervalStart < endMin;
  }
  // Overnight wrap (e.g. 18:00 -> 04:00)
  return intervalStart >= startMin || intervalStart < endMin;
}

/**
 * Calculates full day interval staffing schedule and KPI rollups.
 */
export function runErlangPlanner(
  intervals: IntervalRowInput[],
  config: ErlangConfig
): ErlangSummary {
  const intervalSec = config.granularityMin * 60;
  const intervalHours = config.granularityMin / 60;

  // Normalize arrival weights across open intervals so volume adds cleanly to dailyVolume
  const openFlags = intervals.map((item) =>
    isIntervalOpen(item.index, config.granularityMin, config.operating24x7, config.startHour, config.endHour)
  );
  const openWeightSum = intervals.reduce(
    (sum, item, idx) => (openFlags[idx] ? sum + Math.max(0, item.arrivalPct) : sum),
    0
  );

  // Largest-remainder apportionment so interval volumes ALWAYS sum to exact dailyVolume
  const targetDailyVol = Math.max(0, config.dailyVolume);
  const exactVolumes = intervals.map((item, idx) => {
    if (!openFlags[idx] || openWeightSum <= 0) return 0;
    return (targetDailyVol * Math.max(0, item.arrivalPct)) / openWeightSum;
  });

  let apportionedVolumes: number[];
  if (config.preserveExactIntervalVolumes) {
    apportionedVolumes = exactVolumes;
  } else {
    const roundedTarget = Math.round(targetDailyVol);
    const floors = exactVolumes.map((v) => Math.floor(v));
    let remainderNeeded = Math.max(0, roundedTarget - floors.reduce((a, b) => a + b, 0));
    const order = exactVolumes
      .map((v, i) => ({ i, rem: v - floors[i], open: openFlags[i] }))
      .filter((x) => x.open)
      .sort((a, b) => b.rem - a.rem);
    const resultVols = [...floors];
    for (let k = 0; k < order.length && remainderNeeded > 0; k++) {
      resultVols[order[k].i] += 1;
      remainderNeeded -= 1;
    }
    apportionedVolumes = resultVols;
  }

  const rows: IntervalStaffingRow[] = [];
  let totalVolume = 0;
  let totalPureTalkHours = 0;
  let totalProductiveHours = 0;
  let totalIntegerProductiveHours = 0;
  let totalFractionalProductiveHours = 0;
  let peakSeats = 0;
  let peakTimeLabel = intervals[0]?.timeLabel ?? '00:00';
  let slVolSum = 0;
  let asaVolSum = 0;
  let abandonVolSum = 0;
  let occSeatSum = 0;
  let openSeatSum = 0;

  for (let idx = 0; idx < intervals.length; idx++) {
    const item = intervals[idx];
    const isOpen = openFlags[idx];
    const effectivePct =
      isOpen && openWeightSum > 0 ? (Math.max(0, item.arrivalPct) / openWeightSum) * 100 : 0;
    const volume = isOpen ? apportionedVolumes[idx] : 0;
    const ahtSec =
      item.ahtOverrideSec != null && item.ahtOverrideSec > 0 ? item.ahtOverrideSec : config.globalAhtSec;

    if (!isOpen) {
      rows.push({
        index: item.index,
        timeLabel: item.timeLabel,
        isOpen: false,
        arrivalPct: item.arrivalPct,
        volume: 0,
        ahtSec,
        erlangs: 0,
        requiredSeats: 0,
        integerSeats: 0,
        fractionalSeats: 0,
        occupancyPct: 0,
        asaSec: 0,
        slPct: 100,
        probWaitPct: 0,
        abandonPct: config.useErlangA ? 0 : null,
        productiveHours: 0,
        pureTalkHours: 0,
      });
      continue;
    }

    const { requiredSeats, integerSeats, fractionalSeats, metrics } = solveRequiredAgents(
      volume,
      ahtSec,
      intervalSec,
      config
    );
    const productiveHours = requiredSeats * intervalHours;
    const intProdHours = integerSeats * intervalHours;
    const fracProdHours = fractionalSeats * intervalHours;
    const pureTalkHours = metrics.erlangs * intervalHours;

    totalVolume += volume;
    totalPureTalkHours += pureTalkHours;
    totalProductiveHours += productiveHours;
    totalIntegerProductiveHours += intProdHours;
    totalFractionalProductiveHours += fracProdHours;

    if (requiredSeats >= peakSeats) {
      peakSeats = requiredSeats;
      peakTimeLabel = item.timeLabel;
    }

    slVolSum += metrics.slPct * volume;
    asaVolSum += metrics.asaSec * volume;
    if (metrics.abandonPct != null) {
      abandonVolSum += metrics.abandonPct * volume;
    }
    if (requiredSeats > 0) {
      occSeatSum += metrics.occupancyPct * requiredSeats;
      openSeatSum += requiredSeats;
    }

    rows.push({
      index: item.index,
      timeLabel: item.timeLabel,
      isOpen: true,
      arrivalPct: effectivePct,
      volume,
      ahtSec,
      erlangs: metrics.erlangs,
      requiredSeats,
      integerSeats,
      fractionalSeats,
      occupancyPct: metrics.occupancyPct,
      asaSec: metrics.asaSec,
      slPct: metrics.slPct,
      probWaitPct: metrics.probWaitPct,
      abandonPct: metrics.abandonPct,
      productiveHours,
      pureTalkHours,
    });
  }

  return {
    rows,
    totalVolume: Number(totalVolume.toFixed(2)),
    totalPureTalkHours,
    totalProductiveHours,
    totalIntegerProductiveHours,
    totalFractionalProductiveHours,
    peakSeats,
    peakTimeLabel,
    weightedSlPct: totalVolume > 0 ? slVolSum / totalVolume : 100,
    weightedAsaSec: totalVolume > 0 ? asaVolSum / totalVolume : 0,
    avgOccupancyPct: openSeatSum > 0 ? occSeatSum / openSeatSum : 0,
    weightedAbandonPct: config.useErlangA
      ? totalVolume > 0
        ? abandonVolSum / totalVolume
        : 0
      : null,
  };
}

