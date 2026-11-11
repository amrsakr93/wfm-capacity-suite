import type {
  DayKey,
  ForecastConfig,
  ForecastDayItem,
  ForecastMetrics,
  ForecastModelResult,
  ForecastingStudioOutput,
  FutureHorizonSummary,
  HistoricalPoint,
  Periodicity,
} from './types.ts';

export function computeAccuracyMetrics(actuals: number[], preds: number[]): ForecastMetrics {
  const n = Math.min(actuals.length, preds.length);
  if (n === 0) {
    return { mape: 0, wmape: 0, smape: 0, rmse: 0, mae: 0, bias: 0 };
  }
  let sqErr = 0;
  let absErr = 0;
  let absPctSum = 0;
  let nonZeroCount = 0;
  let smapeSum = 0;
  let sumActual = 0;
  let sumSignedDiff = 0;

  for (let i = 0; i < n; i++) {
    const y = actuals[i];
    const yhat = preds[i];
    const err = yhat - y;
    const abs = Math.abs(err);
    sqErr += err * err;
    absErr += abs;
    sumActual += y;
    sumSignedDiff += err;
    if (Math.abs(y) > 1e-9) {
      absPctSum += (abs / Math.abs(y)) * 100;
      nonZeroCount++;
    }
    const denom = Math.abs(y) + Math.abs(yhat);
    if (denom > 1e-9) {
      smapeSum += ((2 * abs) / denom) * 100;
    }
  }

  return {
    mape: nonZeroCount > 0 ? absPctSum / nonZeroCount : 0,
    wmape: Math.abs(sumActual) > 1e-9 ? (absErr / Math.abs(sumActual)) * 100 : 0,
    smape: smapeSum / n,
    rmse: Math.sqrt(sqErr / n),
    mae: absErr / n,
    bias: Math.abs(sumActual) > 1e-9 ? (sumSignedDiff / Math.abs(sumActual)) * 100 : 0,
  };
}

/**
 * Applies user's Outlier & Holiday exclusions or smoothing before model calibration.
 */
export function prepareCleanedSeries(points: HistoricalPoint[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    if (pt.isExcluded) continue;
    if (pt.isSmoothed) {
      if (pt.smoothedVolume != null && Number.isFinite(pt.smoothedVolume)) {
        out.push(Math.max(0, pt.smoothedVolume));
      } else {
        // Auto smooth from clean neighbors +/-7 days (same weekday) or immediate neighbors
        const candidates: number[] = [];
        for (const offset of [-7, 7, -1, 1]) {
          const nb = points[i + offset];
          if (nb && !nb.isExcluded && !nb.isSmoothed) {
            candidates.push(nb.volume);
          }
        }
        const avg =
          candidates.length > 0
            ? candidates.reduce((a, b) => a + b, 0) / candidates.length
            : pt.volume;
        out.push(Math.max(0, Math.round(avg)));
      }
    } else {
      out.push(Math.max(0, pt.volume));
    }
  }
  return out;
}

export function splitChronological(
  series: number[],
  holdoutRatio: number
): { train: number[]; holdout: number[] } {
  const n = series.length;
  if (n <= 3) return { train: series, holdout: [] };
  const clampedRatio = Math.max(0.05, Math.min(0.45, holdoutRatio));
  const holdoutLen = Math.max(1, Math.min(n - 3, Math.round(n * clampedRatio)));
  const trainLen = n - holdoutLen;
  return {
    train: series.slice(0, trainLen),
    holdout: series.slice(trainLen),
  };
}

function fitAndForecastSMA(
  series: number[],
  windowN: number,
  horizon: number
): { fitted: number[]; forecast: number[] } {
  const w = Math.max(1, Math.min(series.length, Math.floor(windowN)));
  const fitted = new Array<number>(series.length);
  for (let t = 0; t < series.length; t++) {
    const start = Math.max(0, t - w);
    const slice = series.slice(start, Math.max(1, t));
    fitted[t] = t === 0 ? series[0] : slice.reduce((a, b) => a + b, 0) / slice.length;
  }
  const history = [...series];
  const forecast: number[] = [];
  for (let h = 0; h < horizon; h++) {
    const slice = history.slice(Math.max(0, history.length - w));
    const pred = Math.max(0, slice.reduce((a, b) => a + b, 0) / slice.length);
    forecast.push(pred);
    history.push(pred);
  }
  return { fitted, forecast };
}

function normalizeWeights(weights: number[]): number[] {
  const cleaned = weights.map((w) => Math.max(0, w));
  const sum = cleaned.reduce((a, b) => a + b, 0);
  if (sum <= 0) return [1];
  return cleaned.map((w) => w / sum);
}

function fitAndForecastWMA(
  series: number[],
  weightsOldToNew: number[],
  horizon: number
): { fitted: number[]; forecast: number[] } {
  const norm = normalizeWeights(weightsOldToNew);
  const k = norm.length;
  const fitted = new Array<number>(series.length);
  for (let t = 0; t < series.length; t++) {
    if (t === 0) {
      fitted[t] = series[0];
      continue;
    }
    const avail = Math.min(k, t);
    const subWeights = normalizeWeights(norm.slice(k - avail));
    let acc = 0;
    for (let j = 0; j < avail; j++) {
      acc += series[t - avail + j] * subWeights[j];
    }
    fitted[t] = acc;
  }

  const history = [...series];
  const forecast: number[] = [];
  for (let h = 0; h < horizon; h++) {
    const avail = Math.min(k, history.length);
    const subWeights = normalizeWeights(norm.slice(k - avail));
    let pred = 0;
    for (let j = 0; j < avail; j++) {
      pred += history[history.length - avail + j] * subWeights[j];
    }
    pred = Math.max(0, pred);
    forecast.push(pred);
    history.push(pred);
  }
  return { fitted, forecast };
}

/**
 * Carlberg Ch. 4 Simple Exponential Smoothing:
 * F_0 = Y_0, F_t = alpha * Y_{t-1} + (1 - alpha) * F_{t-1}
 */
function runSES(
  series: number[],
  alpha: number,
  horizon: number
): { fitted: number[]; forecast: number[]; sse: number } {
  const fitted = new Array<number>(series.length);
  fitted[0] = series[0];
  let sse = 0;
  for (let t = 1; t < series.length; t++) {
    fitted[t] = alpha * series[t - 1] + (1 - alpha) * fitted[t - 1];
    const err = series[t] - fitted[t];
    sse += err * err;
  }
  const lastLevel =
    series.length > 0 ? alpha * series[series.length - 1] + (1 - alpha) * fitted[series.length - 1] : 0;
  const forecast = new Array<number>(horizon).fill(Math.max(0, lastLevel));
  return { fitted, forecast, sse };
}

/**
 * Carlberg Ch. 4 Holt Linear Exponential Smoothing:
 * L_0 = Y_0, b_0 = 0
 * F_t = L_{t-1} + b_{t-1}
 */
function runHolt(
  series: number[],
  alpha: number,
  gamma: number,
  horizon: number
): { fitted: number[]; forecast: number[]; sse: number } {
  if (series.length === 0) return { fitted: [], forecast: [], sse: 0 };
  const fitted = new Array<number>(series.length);
  let level = series[0];
  let trend = 0;
  fitted[0] = level;
  let sse = 0;

  for (let t = 1; t < series.length; t++) {
    const pred = level + trend;
    fitted[t] = pred;
    const err = series[t] - pred;
    sse += err * err;

    const prevLevel = level;
    level = alpha * series[t] + (1 - alpha) * (level + trend);
    trend = gamma * (level - prevLevel) + (1 - gamma) * trend;
  }

  const forecast: number[] = [];
  for (let h = 1; h <= horizon; h++) {
    forecast.push(Math.max(0, level + h * trend));
  }
  return { fitted, forecast, sse };
}

/**
 * Holt-Winters Triple Exponential Smoothing (Additive or Multiplicative)
 * with safe Seasonal Index + Trend fallback when length < 2 * m.
 */
function runHoltWinters(
  series: number[],
  mode: 'additive' | 'multiplicative',
  m: number,
  alpha: number,
  gamma: number,
  delta: number,
  horizon: number
): { fitted: number[]; forecast: number[]; sse: number; fallbackUsed: boolean } {
  const n = series.length;
  const seasonLen = Math.max(2, Math.floor(m));

  // Fallback for short history (< 2 full seasonal cycles): Seasonal Index + OLS trend
  if (n < seasonLen * 2) {
    const mean = series.reduce((a, b) => a + b, 0) / Math.max(1, n);
    const sums = new Array(seasonLen).fill(0);
    const counts = new Array(seasonLen).fill(0);
    for (let i = 0; i < n; i++) {
      const idx = i % seasonLen;
      sums[idx] += series[i];
      counts[idx]++;
    }
    const seasonAdj = sums.map((s, idx) => {
      const avgSlot = counts[idx] > 0 ? s / counts[idx] : mean;
      return mode === 'additive' ? avgSlot - mean : mean > 1e-6 ? avgSlot / mean : 1;
    });
    const deseasonalized = series.map((v, i) =>
      mode === 'additive' ? v - seasonAdj[i % seasonLen] : seasonAdj[i % seasonLen] > 1e-6 ? v / seasonAdj[i % seasonLen] : v
    );
    const { slope, intercept } = fitOLS(deseasonalized);
    const fitted = series.map((_, t) => {
      const base = intercept + slope * (t + 1);
      const s = seasonAdj[t % seasonLen];
      return Math.max(0, mode === 'additive' ? base + s : base * s);
    });
    let sse = 0;
    for (let t = 0; t < n; t++) sse += (series[t] - fitted[t]) ** 2;

    const forecast: number[] = [];
    for (let h = 1; h <= horizon; h++) {
      const t = n + h;
      const base = intercept + slope * t;
      const s = seasonAdj[(n + h - 1) % seasonLen];
      forecast.push(Math.max(0, mode === 'additive' ? base + s : base * s));
    }
    return { fitted, forecast, sse, fallbackUsed: true };
  }

  // Multi-cycle textbook Holt-Winters initialization (Carlberg Ch. 8 / Excel manual parity):
  // Compute average seasonal indices across all complete seasonal cycles in the series
  const numCycles = Math.max(1, Math.floor(n / seasonLen));
  const cycleMeans: number[] = [];
  for (let c = 0; c < numCycles; c++) {
    const slice = series.slice(c * seasonLen, (c + 1) * seasonLen);
    cycleMeans.push(slice.reduce((a, b) => a + b, 0) / seasonLen);
  }

  const rawSeason = new Array<number>(seasonLen).fill(0);
  for (let s = 0; s < seasonLen; s++) {
    let acc = 0;
    for (let c = 0; c < numCycles; c++) {
      const val = series[c * seasonLen + s];
      const cm = cycleMeans[c];
      acc += mode === 'additive' ? val - cm : cm > 1e-6 ? val / cm : 1;
    }
    rawSeason[s] = acc / numCycles;
  }

  // Normalize initial seasonal indices so additive sums to 0 and multiplicative sums to seasonLen
  const seasonal = new Array<number>(n + horizon);
  if (mode === 'additive') {
    const avgS = rawSeason.reduce((a, b) => a + b, 0) / seasonLen;
    for (let s = 0; s < seasonLen; s++) seasonal[s] = rawSeason[s] - avgS;
  } else {
    const sumS = rawSeason.reduce((a, b) => a + b, 0);
    const scale = sumS > 1e-6 ? seasonLen / sumS : 1;
    for (let s = 0; s < seasonLen; s++) seasonal[s] = Math.max(0.05, rawSeason[s] * scale);
  }

  // Fit OLS on deseasonalized first 2 cycles for clean initial Level & Trend
  const initLen = Math.min(n, seasonLen * 2);
  const deseasonInit: number[] = [];
  for (let i = 0; i < initLen; i++) {
    const s = seasonal[i % seasonLen];
    deseasonInit.push(mode === 'additive' ? series[i] - s : s > 1e-6 ? series[i] / s : series[i]);
  }
  const initOls = fitOLS(deseasonInit);
  let level = initOls.intercept + initOls.slope * seasonLen;
  let trend = initOls.slope;

  const fitted = new Array<number>(n);
  for (let i = 0; i < seasonLen; i++) {
    const base = initOls.intercept + initOls.slope * (i + 1);
    fitted[i] = Math.max(0, mode === 'additive' ? base + seasonal[i] : base * seasonal[i]);
  }

  let sse = 0;
  for (let t = seasonLen; t < n; t++) {
    const prevS = seasonal[t - seasonLen];
    const pred = Math.max(0, mode === 'additive' ? level + trend + prevS : (level + trend) * prevS);
    fitted[t] = pred;
    const err = series[t] - pred;
    sse += err * err;

    const prevLevel = level;
    if (mode === 'additive') {
      level = alpha * (series[t] - prevS) + (1 - alpha) * (level + trend);
      trend = gamma * (level - prevLevel) + (1 - gamma) * trend;
      seasonal[t] = delta * (series[t] - level) + (1 - delta) * prevS;
    } else {
      const safeS = Math.max(0.01, prevS);
      level = alpha * (series[t] / safeS) + (1 - alpha) * (level + trend);
      trend = gamma * (level - prevLevel) + (1 - gamma) * trend;
      const safeL = Math.max(1e-6, level);
      seasonal[t] = Math.max(0.01, delta * (series[t] / safeL) + (1 - delta) * safeS);
    }
  }

  const forecast: number[] = [];
  for (let h = 1; h <= horizon; h++) {
    const k = ((h - 1) % seasonLen) + 1;
    const sIdx = n - seasonLen + k - 1;
    const s = seasonal[Math.max(0, sIdx)];
    forecast.push(Math.max(0, mode === 'additive' ? level + h * trend + s : (level + h * trend) * s));
  }

  return { fitted, forecast, sse, fallbackUsed: false };
}

export function fitOLS(series: number[]): {
  slope: number;
  intercept: number;
  r2: number;
  fitted: number[];
} {
  const n = series.length;
  if (n === 0) return { slope: 0, intercept: 0, r2: 0, fitted: [] };
  if (n === 1) return { slope: 0, intercept: series[0], r2: 1, fitted: [series[0]] };

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    const x = i + 1;
    const y = series[i];
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const denom = n * sumXX - sumX * sumX;
  const slope = Math.abs(denom) > 1e-12 ? (n * sumXY - sumX * sumY) / denom : 0;
  const intercept = (sumY - slope * sumX) / n;

  const meanY = sumY / n;
  let ssRes = 0;
  let ssTot = 0;
  const fitted = series.map((y, i) => {
    const yhat = Math.max(0, intercept + slope * (i + 1));
    ssRes += (y - yhat) ** 2;
    ssTot += (y - meanY) ** 2;
    return yhat;
  });
  const r2 = ssTot > 1e-9 ? Math.max(0, Math.min(1, 1 - ssRes / ssTot)) : 1;
  return { slope, intercept, r2, fitted };
}

function optimizeAlphaSES(train: number[]): number {
  let bestAlpha = 0.2;
  let bestSse = Infinity;
  for (let a = 0.05; a <= 0.951; a += 0.05) {
    const { sse } = runSES(train, a, 0);
    if (sse < bestSse) {
      bestSse = sse;
      bestAlpha = a;
    }
  }
  // Fine local refinement around bestAlpha
  for (let a = Math.max(0.01, bestAlpha - 0.05); a <= Math.min(0.99, bestAlpha + 0.05); a += 0.005) {
    const { sse } = runSES(train, a, 0);
    if (sse < bestSse) {
      bestSse = sse;
      bestAlpha = a;
    }
  }
  return Number(bestAlpha.toFixed(3));
}

function optimizeHoltParams(train: number[]): { alpha: number; gamma: number } {
  let best = { alpha: 0.2, gamma: 0.1, sse: Infinity };
  for (let a = 0.05; a <= 0.9; a += 0.1) {
    for (let g = 0.02; g <= 0.7; g += 0.1) {
      const { sse } = runHolt(train, a, g, 0);
      if (sse < best.sse) best = { alpha: a, gamma: g, sse };
    }
  }
  for (let a = Math.max(0.02, best.alpha - 0.08); a <= Math.min(0.95, best.alpha + 0.08); a += 0.02) {
    for (let g = Math.max(0.01, best.gamma - 0.08); g <= Math.min(0.85, best.gamma + 0.08); g += 0.02) {
      const { sse } = runHolt(train, a, g, 0);
      if (sse < best.sse) best = { alpha: a, gamma: g, sse };
    }
  }
  return { alpha: Number(best.alpha.toFixed(3)), gamma: Number(best.gamma.toFixed(3)) };
}

function optimizeHoltWintersParams(
  train: number[],
  mode: 'additive' | 'multiplicative',
  m: number
): { alpha: number; gamma: number; delta: number } {
  let best = { alpha: 0.25, gamma: 0.05, delta: 0.25, sse: Infinity };
  for (let a = 0.1; a <= 0.8; a += 0.15) {
    for (let g = 0.02; g <= 0.4; g += 0.12) {
      for (let d = 0.1; d <= 0.8; d += 0.15) {
        const { sse } = runHoltWinters(train, mode, m, a, g, d, 0);
        if (sse < best.sse) best = { alpha: a, gamma: g, delta: d, sse };
      }
    }
  }
  return {
    alpha: Number(best.alpha.toFixed(2)),
    gamma: Number(best.gamma.toFixed(2)),
    delta: Number(best.delta.toFixed(2)),
  };
}

/**
 * Carlberg Ch. 3 & 7: Classical Ratio-to-Moving-Average Decomposition (CMA + Seasonal Index + Trend)
 */
function runCmaDecomposition(
  series: number[],
  m: number,
  horizon: number
): { fitted: number[]; forecast: number[]; seasonalIndices: number[]; r2: number } {
  const n = series.length;
  const seasonLen = Math.max(2, Math.floor(m));
  if (n < seasonLen) {
    const ols = fitOLS(series);
    const forecast: number[] = [];
    for (let h = 1; h <= horizon; h++) {
      forecast.push(Math.max(0, ols.intercept + ols.slope * (n + h)));
    }
    return { fitted: ols.fitted, forecast, seasonalIndices: new Array(seasonLen).fill(1), r2: ols.r2 };
  }

  // Step 1: Centered Moving Average (CMA)
  const cma = new Array<number>(n).fill(0);
  const half = Math.floor(seasonLen / 2);
  for (let t = 0; t < n; t++) {
    let sum = 0;
    let cnt = 0;
    for (let k = -half; k <= half; k++) {
      const idx = t + k;
      if (idx >= 0 && idx < n) {
        const weight = seasonLen % 2 === 0 && (k === -half || k === half) ? 0.5 : 1;
        sum += series[idx] * weight;
        cnt += weight;
      }
    }
    cma[t] = cnt > 0 ? sum / cnt : series[t];
  }

  // Step 2: Ratio-to-Moving-Average per seasonal slot
  const slotSums = new Array<number>(seasonLen).fill(0);
  const slotCounts = new Array<number>(seasonLen).fill(0);
  for (let t = 0; t < n; t++) {
    const ratio = cma[t] > 1e-6 ? series[t] / cma[t] : 1;
    const s = t % seasonLen;
    slotSums[s] += ratio;
    slotCounts[s] += 1;
  }
  const rawIndices = slotSums.map((s, idx) => (slotCounts[idx] > 0 ? s / slotCounts[idx] : 1));
  const idxSum = rawIndices.reduce((a, b) => a + b, 0) || seasonLen;
  const seasonalIndices = rawIndices.map((v) => Math.max(0.05, (v * seasonLen) / idxSum));

  // Step 3: Deseasonalize & fit OLS trend
  const deseason = series.map((y, t) => y / Math.max(0.05, seasonalIndices[t % seasonLen]));
  const ols = fitOLS(deseason);

  const fitted = series.map((_, t) =>
    Math.max(0, (ols.intercept + ols.slope * (t + 1)) * seasonalIndices[t % seasonLen])
  );
  const forecast: number[] = [];
  for (let h = 1; h <= horizon; h++) {
    const t = n + h;
    const s = seasonalIndices[(t - 1) % seasonLen];
    forecast.push(Math.max(0, (ols.intercept + ols.slope * t) * s));
  }
  return { fitted, forecast, seasonalIndices, r2: ols.r2 };
}

/**
 * Carlberg Ch. 4: First-Differenced Simple Exponential Smoothing (Delta Y_t = Y_t - Y_{t-1})
 * Prevents SES lagging behind strong positive or negative trends.
 */
function runDifferencedSES(
  series: number[],
  alpha: number,
  horizon: number
): { fitted: number[]; forecast: number[]; sse: number } {
  const n = series.length;
  if (n <= 1) {
    return {
      fitted: [...series],
      forecast: new Array(horizon).fill(series[0] ?? 0),
      sse: 0,
    };
  }
  const diffs: number[] = [];
  for (let t = 1; t < n; t++) {
    diffs.push(series[t] - series[t - 1]);
  }
  // Smooth first differences
  const fDiff = new Array<number>(diffs.length);
  fDiff[0] = diffs[0];
  for (let i = 1; i < diffs.length; i++) {
    fDiff[i] = alpha * diffs[i - 1] + (1 - alpha) * fDiff[i - 1];
  }
  const lastDiff =
    alpha * diffs[diffs.length - 1] + (1 - alpha) * fDiff[fDiff.length - 1];

  const fitted = new Array<number>(n);
  fitted[0] = series[0];
  let sse = 0;
  for (let t = 1; t < n; t++) {
    fitted[t] = Math.max(0, series[t - 1] + fDiff[t - 1]);
    sse += (series[t] - fitted[t]) ** 2;
  }
  const lastActual = series[n - 1];
  const forecast: number[] = [];
  for (let h = 1; h <= horizon; h++) {
    forecast.push(Math.max(0, lastActual + h * lastDiff));
  }
  return { fitted, forecast, sse };
}

/**
 * Carlberg Ch. 4 / Damped Trend: Holt's Damped Exponential Smoothing (alpha, gamma, phi)
 */
function runDampedHolt(
  series: number[],
  alpha: number,
  gamma: number,
  phi: number,
  horizon: number
): { fitted: number[]; forecast: number[]; sse: number } {
  if (series.length === 0) return { fitted: [], forecast: [], sse: 0 };
  const fitted = new Array<number>(series.length);
  let level = series[0];
  let trend = series.length > 1 ? series[1] - series[0] : 0;
  fitted[0] = level;
  let sse = 0;

  for (let t = 1; t < series.length; t++) {
    const pred = Math.max(0, level + phi * trend);
    fitted[t] = pred;
    sse += (series[t] - pred) ** 2;
    const prevLevel = level;
    level = alpha * series[t] + (1 - alpha) * (level + phi * trend);
    trend = gamma * (level - prevLevel) + (1 - gamma) * phi * trend;
  }

  const forecast: number[] = [];
  let phiSum = 0;
  let phiPow = 1;
  for (let h = 1; h <= horizon; h++) {
    phiPow *= phi;
    phiSum += phiPow;
    forecast.push(Math.max(0, level + phiSum * trend));
  }
  return { fitted, forecast, sse };
}

/**
 * Carlberg Ch. 6: Multiple Linear Regression with Linear Trend + Seasonal Dummy Variables (m-1 indicators)
 */
function runMultipleRegressionSeasonal(
  series: number[],
  m: number,
  horizon: number
): { fitted: number[]; forecast: number[]; slope: number; r2: number; adjR2: number } {
  const n = series.length;
  const seasonLen = Math.max(2, Math.floor(m));
  if (n < seasonLen + 2) {
    const ols = fitOLS(series);
    const forecast: number[] = [];
    for (let h = 1; h <= horizon; h++) {
      forecast.push(Math.max(0, ols.intercept + ols.slope * (n + h)));
    }
    return { fitted: ols.fitted, forecast, slope: ols.slope, r2: ols.r2, adjR2: ols.r2 };
  }

  // Within-group demeaning (exact Frisch-Waugh-Lovell fixed-effects dummy solver)
  const slotTimes: number[][] = Array.from({ length: seasonLen }, () => []);
  const slotVals: number[][] = Array.from({ length: seasonLen }, () => []);
  for (let i = 0; i < n; i++) {
    const s = i % seasonLen;
    slotTimes[s].push(i + 1);
    slotVals[s].push(series[i]);
  }
  const meanTBySlot = slotTimes.map((arr) =>
    arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0
  );
  const meanYBySlot = slotVals.map((arr) =>
    arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0
  );

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const s = i % seasonLen;
    const dt = i + 1 - meanTBySlot[s];
    const dy = series[i] - meanYBySlot[s];
    num += dt * dy;
    den += dt * dt;
  }
  const slope = Math.abs(den) > 1e-12 ? num / den : 0;
  const interceptsBySlot = meanYBySlot.map((my, s) => my - slope * meanTBySlot[s]);

  const meanY = series.reduce((a, b) => a + b, 0) / n;
  let ssRes = 0;
  let ssTot = 0;
  const fitted = series.map((y, i) => {
    const s = i % seasonLen;
    const yhat = Math.max(0, interceptsBySlot[s] + slope * (i + 1));
    ssRes += (y - yhat) ** 2;
    ssTot += (y - meanY) ** 2;
    return yhat;
  });
  const r2 = ssTot > 1e-9 ? Math.max(0, Math.min(1, 1 - ssRes / ssTot)) : 1;
  const k = seasonLen; // 1 slope + (m-1) dummies
  const adjR2 = n > k + 1 ? Math.max(0, 1 - ((1 - r2) * (n - 1)) / (n - k - 1)) : r2;

  const forecast: number[] = [];
  for (let h = 1; h <= horizon; h++) {
    const idx = n + h - 1;
    const s = idx % seasonLen;
    forecast.push(Math.max(0, interceptsBySlot[s] + slope * (n + h)));
  }

  return { fitted, forecast, slope, r2, adjR2 };
}

/**
 * Carlberg Ch. 9 & 10: Box-Jenkins Autoregressive Model AR(p) with Lag-1 and Seasonal Lag-m
 */
function runBoxJenkinsAR(
  series: number[],
  m: number,
  horizon: number
): { fitted: number[]; forecast: number[]; phi1: number; phiM: number; acf1: number } {
  const n = series.length;
  const seasonLen = Math.max(2, Math.floor(m));
  if (n < 4) {
    const mean = n > 0 ? series.reduce((a, b) => a + b, 0) / n : 0;
    return {
      fitted: [...series],
      forecast: new Array(horizon).fill(mean),
      phi1: 0.5,
      phiM: 0,
      acf1: 0,
    };
  }

  const mean = series.reduce((a, b) => a + b, 0) / n;
  // Compute Lag-1 ACF (Carlberg Ch. 9)
  let cov1 = 0;
  let var0 = 0;
  for (let t = 0; t < n; t++) {
    const d = series[t] - mean;
    var0 += d * d;
    if (t >= 1) cov1 += d * (series[t - 1] - mean);
  }
  const acf1 = var0 > 1e-9 ? Math.max(-0.98, Math.min(0.98, cov1 / var0)) : 0;

  // If n >= seasonLen + 2, use Box-Jenkins Seasonal Differencing AR(1)_m:
  // (Y_t - Y_{t-m}) = c + phi1 * (Y_{t-1} - Y_{t-1-m})
  if (n >= seasonLen + 2) {
    const sDiffs: number[] = [];
    for (let t = seasonLen; t < n; t++) {
      sDiffs.push(series[t] - series[t - seasonLen]);
    }
    const meanDiff = sDiffs.reduce((a, b) => a + b, 0) / Math.max(1, sDiffs.length);
    let num = 0;
    let den = 0;
    for (let i = 1; i < sDiffs.length; i++) {
      num += (sDiffs[i] - meanDiff) * (sDiffs[i - 1] - meanDiff);
      den += (sDiffs[i - 1] - meanDiff) ** 2;
    }
    const phi1 = den > 1e-9 ? Math.max(-0.85, Math.min(0.92, num / den)) : 0.35;
    const fitted = new Array<number>(n);
    for (let t = 0; t < n; t++) {
      if (t < seasonLen) {
        fitted[t] = series[t];
      } else if (t === seasonLen) {
        fitted[t] = Math.max(0, series[t - seasonLen] + meanDiff);
      } else {
        const prevDiff = series[t - 1] - series[t - 1 - seasonLen];
        fitted[t] = Math.max(
          0,
          series[t - seasonLen] + meanDiff + phi1 * (prevDiff - meanDiff)
        );
      }
    }

    const history = [...series];
    const forecast: number[] = [];
    for (let h = 0; h < horizon; h++) {
      const cur = history.length;
      const lagM = history[cur - seasonLen];
      const prevDiff = history[cur - 1] - history[cur - 1 - seasonLen];
      const pred = Math.max(0, lagM + meanDiff + phi1 * (prevDiff - meanDiff));
      forecast.push(pred);
      history.push(pred);
    }

    return {
      fitted,
      forecast,
      phi1: Number(phi1.toFixed(2)),
      phiM: 1,
      acf1: Number(acf1.toFixed(3)),
    };
  }

  const phi1 = Math.max(0, Math.min(0.95, acf1));
  const phiM = 0;
  const wMean = Math.max(0, 1 - phi1);
  const fitted = new Array<number>(n);
  for (let t = 0; t < n; t++) {
    fitted[t] = t === 0 ? series[0] : Math.max(0, phi1 * series[t - 1] + wMean * mean);
  }

  const history = [...series];
  const forecast: number[] = [];
  for (let h = 0; h < horizon; h++) {
    const lag1 = history[history.length - 1] ?? mean;
    const pred = Math.max(0, phi1 * lag1 + wMean * mean);
    forecast.push(pred);
    history.push(pred);
  }

  return {
    fitted,
    forecast,
    phi1: Number(phi1.toFixed(2)),
    phiM,
    acf1: Number(acf1.toFixed(3)),
  };
}

/**
 * Runs all 12 Conrad Carlberg forecasting models with strict chronological 80/20 Holdout backtest
 * and recalibrates winning parameters across full series for out-of-sample future horizon.
 */
export function runForecastingStudio(
  points: HistoricalPoint[],
  config: ForecastConfig
): ForecastingStudioOutput {
  const cleanedSeries = prepareCleanedSeries(points);
  const { train, holdout } = splitChronological(cleanedSeries, config.holdoutRatio);
  const holdLen = holdout.length;
  const extHorizon = Math.max(60, config.horizon);
  const m = Math.max(2, config.seasonLength);

  const results: ForecastModelResult[] = [];

  // 1. Unweighted Moving Average (SMA — Carlberg Ch. 3)
  let bestSmaN = config.smaWindow;
  if (config.autoOptimize && train.length >= 4) {
    let bestTrainRmse = Infinity;
    for (let w = 2; w <= Math.min(12, train.length - 1); w++) {
      const res = fitAndForecastSMA(train, w, 0);
      const rmse = computeAccuracyMetrics(train.slice(w), res.fitted.slice(w)).rmse;
      if (rmse < bestTrainRmse) {
        bestTrainRmse = rmse;
        bestSmaN = w;
      }
    }
  }
  const smaEval = fitAndForecastSMA(train, bestSmaN, holdLen);
  const smaFull = fitAndForecastSMA(cleanedSeries, bestSmaN, extHorizon);
  results.push({
    modelId: 'sma',
    params: { windowN: bestSmaN },
    fittedTrain: smaEval.fitted,
    holdoutPreds: smaEval.forecast,
    futureForecast: smaFull.forecast.slice(0, config.horizon),
    extendedFutureForecast: smaFull.forecast,
    holdoutMetrics: computeAccuracyMetrics(holdout, smaEval.forecast),
    trainMetrics: computeAccuracyMetrics(train, smaEval.fitted),
    isBest: false,
  });

  // 2. Weighted Moving Average (WMA — Carlberg Ch. 3)
  const wmaWeights = normalizeWeights(config.wmaWeights.length > 0 ? config.wmaWeights : [0.15, 0.35, 0.5]);
  const wmaEval = fitAndForecastWMA(train, wmaWeights, holdLen);
  const wmaFull = fitAndForecastWMA(cleanedSeries, wmaWeights, extHorizon);
  results.push({
    modelId: 'wma',
    params: { weights: wmaWeights.map((w) => Number(w.toFixed(3))) },
    fittedTrain: wmaEval.fitted,
    holdoutPreds: wmaEval.forecast,
    futureForecast: wmaFull.forecast.slice(0, config.horizon),
    extendedFutureForecast: wmaFull.forecast,
    holdoutMetrics: computeAccuracyMetrics(holdout, wmaEval.forecast),
    trainMetrics: computeAccuracyMetrics(train, wmaEval.fitted),
    isBest: false,
  });

  // 3. Classical Ratio-to-Moving-Average Decomposition (CMA — Carlberg Ch. 3 & 7)
  const cmaEval = runCmaDecomposition(train, m, holdLen);
  const cmaFull = runCmaDecomposition(cleanedSeries, m, extHorizon);
  results.push({
    modelId: 'cma_decomposition',
    params: { seasonLength: m, r2: Number(cmaFull.r2.toFixed(3)) },
    fittedTrain: cmaEval.fitted,
    holdoutPreds: cmaEval.forecast,
    futureForecast: cmaFull.forecast.slice(0, config.horizon),
    extendedFutureForecast: cmaFull.forecast,
    holdoutMetrics: computeAccuracyMetrics(holdout, cmaEval.forecast),
    trainMetrics: computeAccuracyMetrics(train, cmaEval.fitted),
    r2: cmaFull.r2,
    isBest: false,
  });

  // 4. Simple Exponential Smoothing (SES — Carlberg Ch. 4)
  const alphaSes = config.autoOptimize ? optimizeAlphaSES(train) : config.manualAlpha;
  const sesEval = runSES(train, alphaSes, holdLen);
  const sesFull = runSES(cleanedSeries, alphaSes, extHorizon);
  results.push({
    modelId: 'ses',
    params: { alpha: alphaSes },
    fittedTrain: sesEval.fitted,
    holdoutPreds: sesEval.forecast,
    futureForecast: sesFull.forecast.slice(0, config.horizon),
    extendedFutureForecast: sesFull.forecast,
    holdoutMetrics: computeAccuracyMetrics(holdout, sesEval.forecast),
    trainMetrics: computeAccuracyMetrics(train, sesEval.fitted),
    isBest: false,
  });

  // 5. First-Differenced Exponential Smoothing (Delta Y_t — Carlberg Ch. 4)
  let bestDiffAlpha = config.manualAlpha;
  if (config.autoOptimize && train.length >= 4) {
    let bestSse = Infinity;
    for (let a = 0.05; a <= 0.95; a += 0.05) {
      const r = runDifferencedSES(train, a, 0);
      if (r.sse < bestSse) {
        bestSse = r.sse;
        bestDiffAlpha = Number(a.toFixed(2));
      }
    }
  }
  const diffEval = runDifferencedSES(train, bestDiffAlpha, holdLen);
  const diffFull = runDifferencedSES(cleanedSeries, bestDiffAlpha, extHorizon);
  results.push({
    modelId: 'ses_differenced',
    params: { alphaDiff: bestDiffAlpha },
    fittedTrain: diffEval.fitted,
    holdoutPreds: diffEval.forecast,
    futureForecast: diffFull.forecast.slice(0, config.horizon),
    extendedFutureForecast: diffFull.forecast,
    holdoutMetrics: computeAccuracyMetrics(holdout, diffEval.forecast),
    trainMetrics: computeAccuracyMetrics(train, diffEval.fitted),
    isBest: false,
  });

  // 6. Holt Linear Exponential Smoothing (Carlberg Ch. 4)
  const holtParams = config.autoOptimize
    ? optimizeHoltParams(train)
    : { alpha: config.manualAlpha, gamma: config.manualGamma };
  const holtEval = runHolt(train, holtParams.alpha, holtParams.gamma, holdLen);
  const holtFull = runHolt(cleanedSeries, holtParams.alpha, holtParams.gamma, extHorizon);
  results.push({
    modelId: 'holt',
    params: { alpha: holtParams.alpha, gamma: holtParams.gamma },
    fittedTrain: holtEval.fitted,
    holdoutPreds: holtEval.forecast,
    futureForecast: holtFull.forecast.slice(0, config.horizon),
    extendedFutureForecast: holtFull.forecast,
    holdoutMetrics: computeAccuracyMetrics(holdout, holtEval.forecast),
    trainMetrics: computeAccuracyMetrics(train, holtEval.fitted),
    isBest: false,
  });

  // 7. Damped-Trend Exponential Smoothing (Carlberg Ch. 4 / Damped phi)
  let bestPhi = 0.9;
  if (config.autoOptimize && train.length >= 4) {
    let bestDampedSse = Infinity;
    for (const p of [0.82, 0.88, 0.92, 0.96]) {
      const r = runDampedHolt(train, holtParams.alpha, holtParams.gamma, p, 0);
      if (r.sse < bestDampedSse) {
        bestDampedSse = r.sse;
        bestPhi = p;
      }
    }
  }
  const dampedEval = runDampedHolt(train, holtParams.alpha, holtParams.gamma, bestPhi, holdLen);
  const dampedFull = runDampedHolt(cleanedSeries, holtParams.alpha, holtParams.gamma, bestPhi, extHorizon);
  results.push({
    modelId: 'holt_damped',
    params: { alpha: holtParams.alpha, gamma: holtParams.gamma, phi: bestPhi },
    fittedTrain: dampedEval.fitted,
    holdoutPreds: dampedEval.forecast,
    futureForecast: dampedFull.forecast.slice(0, config.horizon),
    extendedFutureForecast: dampedFull.forecast,
    holdoutMetrics: computeAccuracyMetrics(holdout, dampedEval.forecast),
    trainMetrics: computeAccuracyMetrics(train, dampedEval.fitted),
    isBest: false,
  });

  // 8. Holt-Winters Additive Seasonal (Carlberg Ch. 8)
  const hwAddParams = config.autoOptimize
    ? optimizeHoltWintersParams(train, 'additive', m)
    : { alpha: config.manualAlpha, gamma: config.manualGamma, delta: config.manualDelta };
  const hwAddEval = runHoltWinters(
    train,
    'additive',
    m,
    hwAddParams.alpha,
    hwAddParams.gamma,
    hwAddParams.delta,
    holdLen
  );
  const hwAddFull = runHoltWinters(
    cleanedSeries,
    'additive',
    m,
    hwAddParams.alpha,
    hwAddParams.gamma,
    hwAddParams.delta,
    extHorizon
  );
  results.push({
    modelId: 'holt_winters_add',
    params: { ...hwAddParams, seasonLength: m },
    fittedTrain: hwAddEval.fitted,
    holdoutPreds: hwAddEval.forecast,
    futureForecast: hwAddFull.forecast.slice(0, config.horizon),
    extendedFutureForecast: hwAddFull.forecast,
    holdoutMetrics: computeAccuracyMetrics(holdout, hwAddEval.forecast),
    trainMetrics: computeAccuracyMetrics(train, hwAddEval.fitted),
    isBest: false,
    note: hwAddEval.fallbackUsed ? 'Seasonal index fallback (< 2 full cycles in train set)' : undefined,
  });

  // 9. Holt-Winters Multiplicative Seasonal (Carlberg Ch. 8)
  const hwMultParams = config.autoOptimize
    ? optimizeHoltWintersParams(train, 'multiplicative', m)
    : { alpha: config.manualAlpha, gamma: config.manualGamma, delta: config.manualDelta };
  const hwMultEval = runHoltWinters(
    train,
    'multiplicative',
    m,
    hwMultParams.alpha,
    hwMultParams.gamma,
    hwMultParams.delta,
    holdLen
  );
  const hwMultFull = runHoltWinters(
    cleanedSeries,
    'multiplicative',
    m,
    hwMultParams.alpha,
    hwMultParams.gamma,
    hwMultParams.delta,
    extHorizon
  );
  results.push({
    modelId: 'holt_winters_mult',
    params: { ...hwMultParams, seasonLength: m },
    fittedTrain: hwMultEval.fitted,
    holdoutPreds: hwMultEval.forecast,
    futureForecast: hwMultFull.forecast.slice(0, config.horizon),
    extendedFutureForecast: hwMultFull.forecast,
    holdoutMetrics: computeAccuracyMetrics(holdout, hwMultEval.forecast),
    trainMetrics: computeAccuracyMetrics(train, hwMultEval.fitted),
    isBest: false,
    note: hwMultEval.fallbackUsed ? 'Seasonal index fallback (< 2 full cycles in train set)' : undefined,
  });

  // 10. Simple Linear Regression OLS (Carlberg Ch. 2 & 5 — TREND / LINEST)
  const olsTrain = fitOLS(train);
  const olsHoldoutPreds: number[] = [];
  for (let h = 1; h <= holdLen; h++) {
    olsHoldoutPreds.push(Math.max(0, olsTrain.intercept + olsTrain.slope * (train.length + h)));
  }
  const olsFull = fitOLS(cleanedSeries);
  const olsFuture: number[] = [];
  for (let h = 1; h <= extHorizon; h++) {
    olsFuture.push(Math.max(0, olsFull.intercept + olsFull.slope * (cleanedSeries.length + h)));
  }
  results.push({
    modelId: 'linear_regression',
    params: {
      slope: Number(olsFull.slope.toFixed(3)),
      intercept: Number(olsFull.intercept.toFixed(2)),
    },
    fittedTrain: olsTrain.fitted,
    holdoutPreds: olsHoldoutPreds,
    futureForecast: olsFuture.slice(0, config.horizon),
    extendedFutureForecast: olsFuture,
    holdoutMetrics: computeAccuracyMetrics(holdout, olsHoldoutPreds),
    trainMetrics: computeAccuracyMetrics(train, olsTrain.fitted),
    r2: olsFull.r2,
    slope: olsFull.slope,
    intercept: olsFull.intercept,
    isBest: false,
  });

  // 11. Multiple Linear Regression with Seasonal Dummy Indicators (Carlberg Ch. 6)
  const mlrEval = runMultipleRegressionSeasonal(train, m, holdLen);
  const mlrFull = runMultipleRegressionSeasonal(cleanedSeries, m, extHorizon);
  results.push({
    modelId: 'multiple_regression',
    params: {
      slope: Number(mlrFull.slope.toFixed(3)),
      dummies: m - 1,
      adjR2: Number(mlrFull.adjR2.toFixed(3)),
    },
    fittedTrain: mlrEval.fitted,
    holdoutPreds: mlrEval.forecast,
    futureForecast: mlrFull.forecast.slice(0, config.horizon),
    extendedFutureForecast: mlrFull.forecast,
    holdoutMetrics: computeAccuracyMetrics(holdout, mlrEval.forecast),
    trainMetrics: computeAccuracyMetrics(train, mlrEval.fitted),
    r2: mlrFull.r2,
    slope: mlrFull.slope,
    isBest: false,
  });

  // 12. Box-Jenkins Autoregressive Model AR(p) / Seasonal ARIMA (Carlberg Ch. 9 & 10)
  const arEval = runBoxJenkinsAR(train, m, holdLen);
  const arFull = runBoxJenkinsAR(cleanedSeries, m, extHorizon);
  results.push({
    modelId: 'box_jenkins_ar',
    params: {
      phi1: arFull.phi1,
      phiSeasonal: arFull.phiM,
      lag1ACF: arFull.acf1,
    },
    fittedTrain: arEval.fitted,
    holdoutPreds: arEval.forecast,
    futureForecast: arFull.forecast.slice(0, config.horizon),
    extendedFutureForecast: arFull.forecast,
    holdoutMetrics: computeAccuracyMetrics(holdout, arEval.forecast),
    trainMetrics: computeAccuracyMetrics(train, arEval.fitted),
    isBest: false,
  });

  // Rank best model by Holdout WMAPE (safe for zeros) + RMSE tie-breaker
  let bestIdx = 0;
  for (let i = 1; i < results.length; i++) {
    const a = results[i].holdoutMetrics;
    const b = results[bestIdx].holdoutMetrics;
    if (a.wmape < b.wmape - 1e-6 || (Math.abs(a.wmape - b.wmape) <= 1e-6 && a.rmse < b.rmse)) {
      bestIdx = i;
    }
  }
  results[bestIdx].isBest = true;

  return {
    cleanedSeries,
    trainLength: train.length,
    holdoutLength: holdout.length,
    models: results,
    bestModelId: results[bestIdx].modelId,
  };
}

const JS_DAY_KEYS: DayKey[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ORDERED_DAYS: DayKey[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Builds Next Week (7d), Current Month (Days 1-30), and Next Month (Days 31-60)
 * Future Forecast Horizon Summary from the active model's extended forecast.
 */
export function buildFutureHorizonSummary(
  points: HistoricalPoint[],
  activeModel: ForecastModelResult,
  periodicity: Periodicity,
  dayOfWeekShares?: Record<DayKey, number>
): FutureHorizonSummary {
  const ext = activeModel.extendedFutureForecast.length > 0
    ? activeModel.extendedFutureForecast
    : activeModel.futureForecast;

  // Determine anchor date from the last historical point (or today)
  const lastPt = points[points.length - 1];
  const baseDateMs =
    lastPt?.date && !Number.isNaN(Date.parse(`${lastPt.date}T00:00:00Z`))
      ? Date.parse(`${lastPt.date}T00:00:00Z`)
      : Date.parse('2026-11-11T00:00:00Z');

  const allFutureDays: ForecastDayItem[] = [];

  if (periodicity === 'daily') {
    for (let i = 0; i < 60; i++) {
      const d = new Date(baseDateMs + (i + 1) * 86400000);
      const iso = d.toISOString().slice(0, 10);
      const dayKey = JS_DAY_KEYS[d.getUTCDay()];
      const vol = Math.max(0, Math.round(ext[i] ?? ext[ext.length - 1] ?? 0));
      allFutureDays.push({
        stepIndex: i + 1,
        dateIso: iso,
        label: `${dayKey} ${iso.slice(5)}`,
        dayKey,
        volume: vol,
      });
    }
  } else if (periodicity === 'weekly') {
    // Disaggregate weekly forecasts into 60 daily values using dayOfWeekShares
    for (let i = 0; i < 60; i++) {
      const weekIdx = Math.floor(i / 7);
      const weekVol = Math.max(0, ext[weekIdx] ?? ext[ext.length - 1] ?? 0);
      const d = new Date(baseDateMs + (i + 1) * 86400000);
      const iso = d.toISOString().slice(0, 10);
      const dayKey = JS_DAY_KEYS[d.getUTCDay()];
      const share = dayOfWeekShares?.[dayKey] ?? 100 / 7;
      allFutureDays.push({
        stepIndex: i + 1,
        dateIso: iso,
        label: `${dayKey} ${iso.slice(5)}`,
        dayKey,
        volume: Math.round((weekVol * share) / 100),
      });
    }
  } else {
    // Monthly periodicity: Period 0 = Current/Upcoming Month (30 days), Period 1 = Next Month (30 days)
    const curMonthVol = Math.max(0, Math.round(ext[0] ?? 0));
    const nxtMonthVol = Math.max(0, Math.round(ext[1] ?? ext[0] ?? 0));
    for (let i = 0; i < 60; i++) {
      const monthTotal = i < 30 ? curMonthVol : nxtMonthVol;
      const d = new Date(baseDateMs + (i + 1) * 86400000);
      const iso = d.toISOString().slice(0, 10);
      const dayKey = JS_DAY_KEYS[d.getUTCDay()];
      const share = dayOfWeekShares?.[dayKey] ?? 100 / 7;
      // Weight daily volume by weekday share normalized across 30 days (~4.2857 weeks)
      const dailyVol = Math.round((monthTotal / 30) * (share / (100 / 7)));
      allFutureDays.push({
        stepIndex: i + 1,
        dateIso: iso,
        label: `${dayKey} ${iso.slice(5)}`,
        dayKey: dayKey || ORDERED_DAYS[i % 7],
        volume: dailyVol,
      });
    }
  }

  // Ensure Next Week Forecast (7 Days) ALWAYS starts on Monday (Mon -> Sun)
  const firstMonIdx = allFutureDays.findIndex((d) => d.dayKey === 'Mon');
  const nextWeekDays =
    firstMonIdx >= 0 && firstMonIdx + 7 <= allFutureDays.length
      ? allFutureDays.slice(firstMonIdx, firstMonIdx + 7)
      : [...allFutureDays.slice(0, 7)].sort(
          (a, b) => ORDERED_DAYS.indexOf(a.dayKey) - ORDERED_DAYS.indexOf(b.dayKey)
        );
  const currentMonthDays = allFutureDays.slice(0, 30);
  const nextMonthDays = allFutureDays.slice(30, 60);

  const nextWeekTotal = nextWeekDays.reduce((s, d) => s + d.volume, 0);
  const nextWeekDailyAvg = Math.round(nextWeekTotal / 7);
  const nextWeekPeakDay = nextWeekDays.reduce(
    (best, d) => (d.volume > best.volume ? d : best),
    nextWeekDays[0]
  );

  const currentMonthTotal =
    periodicity === 'monthly'
      ? Math.max(0, Math.round(ext[0] ?? 0))
      : currentMonthDays.reduce((s, d) => s + d.volume, 0);
  const currentMonthDailyAvg = Math.round(currentMonthTotal / 30);

  const nextMonthTotal =
    periodicity === 'monthly'
      ? Math.max(0, Math.round(ext[1] ?? ext[0] ?? 0))
      : nextMonthDays.reduce((s, d) => s + d.volume, 0);
  const nextMonthDailyAvg = Math.round(nextMonthTotal / 30);

  const nextMonthGrowthPct =
    currentMonthTotal > 0 ? ((nextMonthTotal - currentMonthTotal) / currentMonthTotal) * 100 : 0;

  const curStart = currentMonthDays[0]?.dateIso.slice(0, 7) ?? 'Current Month';
  const nxtStart = nextMonthDays[0]?.dateIso.slice(0, 7) ?? 'Next Month';

  return {
    nextWeekTotal,
    nextWeekDailyAvg,
    nextWeekPeakDay,
    nextWeekDays,
    currentMonthTotal,
    currentMonthDailyAvg,
    currentMonthLabel: `Days 1–30 (${curStart})`,
    currentMonthDays,
    nextMonthTotal,
    nextMonthDailyAvg,
    nextMonthLabel: `Days 31–60 (${nxtStart})`,
    nextMonthGrowthPct,
    nextMonthDays,
    allFutureDays,
  };
}

