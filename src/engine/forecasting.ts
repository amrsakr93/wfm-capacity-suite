import type {
  ForecastConfig,
  ForecastMetrics,
  ForecastModelResult,
  ForecastingStudioOutput,
  HistoricalPoint,
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

  // Standard 2-cycle Holt-Winters initialization
  const firstCycleMean = series.slice(0, seasonLen).reduce((a, b) => a + b, 0) / seasonLen;
  let trend = 0;
  for (let i = 0; i < seasonLen; i++) {
    trend += (series[seasonLen + i] - series[i]) / seasonLen;
  }
  trend /= seasonLen;

  const seasonal = new Array<number>(n + horizon);
  for (let i = 0; i < seasonLen; i++) {
    seasonal[i] =
      mode === 'additive'
        ? series[i] - firstCycleMean
        : firstCycleMean > 1e-6
          ? Math.max(0.05, series[i] / firstCycleMean)
          : 1;
  }

  let level = firstCycleMean;
  const fitted = new Array<number>(n);
  for (let i = 0; i < seasonLen; i++) {
    fitted[i] = Math.max(
      0,
      mode === 'additive' ? firstCycleMean + trend * (i - seasonLen / 2) + seasonal[i] : firstCycleMean * seasonal[i]
    );
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
 * Runs all 6 Conrad Carlberg forecasting models with strict chronological 80/20 Holdout backtest
 * and recalibrates winning parameters across full series for out-of-sample future horizon.
 */
export function runForecastingStudio(
  points: HistoricalPoint[],
  config: ForecastConfig
): ForecastingStudioOutput {
  const cleanedSeries = prepareCleanedSeries(points);
  const { train, holdout } = splitChronological(cleanedSeries, config.holdoutRatio);
  const holdLen = holdout.length;

  const results: ForecastModelResult[] = [];

  // 1. Unweighted Moving Average (SMA)
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
  const smaFull = fitAndForecastSMA(cleanedSeries, bestSmaN, config.horizon);
  results.push({
    modelId: 'sma',
    params: { windowN: bestSmaN },
    fittedTrain: smaEval.fitted,
    holdoutPreds: smaEval.forecast,
    futureForecast: smaFull.forecast,
    holdoutMetrics: computeAccuracyMetrics(holdout, smaEval.forecast),
    trainMetrics: computeAccuracyMetrics(train, smaEval.fitted),
    isBest: false,
  });

  // 2. Weighted Moving Average (WMA)
  const wmaWeights = normalizeWeights(config.wmaWeights.length > 0 ? config.wmaWeights : [0.15, 0.35, 0.5]);
  const wmaEval = fitAndForecastWMA(train, wmaWeights, holdLen);
  const wmaFull = fitAndForecastWMA(cleanedSeries, wmaWeights, config.horizon);
  results.push({
    modelId: 'wma',
    params: { weights: wmaWeights.map((w) => Number(w.toFixed(3))) },
    fittedTrain: wmaEval.fitted,
    holdoutPreds: wmaEval.forecast,
    futureForecast: wmaFull.forecast,
    holdoutMetrics: computeAccuracyMetrics(holdout, wmaEval.forecast),
    trainMetrics: computeAccuracyMetrics(train, wmaEval.fitted),
    isBest: false,
  });

  // 3. Simple Exponential Smoothing (SES)
  const alphaSes = config.autoOptimize ? optimizeAlphaSES(train) : config.manualAlpha;
  const sesEval = runSES(train, alphaSes, holdLen);
  const sesFull = runSES(cleanedSeries, alphaSes, config.horizon);
  results.push({
    modelId: 'ses',
    params: { alpha: alphaSes },
    fittedTrain: sesEval.fitted,
    holdoutPreds: sesEval.forecast,
    futureForecast: sesFull.forecast,
    holdoutMetrics: computeAccuracyMetrics(holdout, sesEval.forecast),
    trainMetrics: computeAccuracyMetrics(train, sesEval.fitted),
    isBest: false,
  });

  // 4. Holt Linear Exponential Smoothing
  const holtParams = config.autoOptimize
    ? optimizeHoltParams(train)
    : { alpha: config.manualAlpha, gamma: config.manualGamma };
  const holtEval = runHolt(train, holtParams.alpha, holtParams.gamma, holdLen);
  const holtFull = runHolt(cleanedSeries, holtParams.alpha, holtParams.gamma, config.horizon);
  results.push({
    modelId: 'holt',
    params: { alpha: holtParams.alpha, gamma: holtParams.gamma },
    fittedTrain: holtEval.fitted,
    holdoutPreds: holtEval.forecast,
    futureForecast: holtFull.forecast,
    holdoutMetrics: computeAccuracyMetrics(holdout, holtEval.forecast),
    trainMetrics: computeAccuracyMetrics(train, holtEval.fitted),
    isBest: false,
  });

  // 5A. Holt-Winters Additive
  const m = Math.max(2, config.seasonLength);
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
    config.horizon
  );
  results.push({
    modelId: 'holt_winters_add',
    params: { ...hwAddParams, seasonLength: m },
    fittedTrain: hwAddEval.fitted,
    holdoutPreds: hwAddEval.forecast,
    futureForecast: hwAddFull.forecast,
    holdoutMetrics: computeAccuracyMetrics(holdout, hwAddEval.forecast),
    trainMetrics: computeAccuracyMetrics(train, hwAddEval.fitted),
    isBest: false,
    note: hwAddEval.fallbackUsed ? 'Seasonal index fallback (< 2 full cycles in train set)' : undefined,
  });

  // 5B. Holt-Winters Multiplicative
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
    config.horizon
  );
  results.push({
    modelId: 'holt_winters_mult',
    params: { ...hwMultParams, seasonLength: m },
    fittedTrain: hwMultEval.fitted,
    holdoutPreds: hwMultEval.forecast,
    futureForecast: hwMultFull.forecast,
    holdoutMetrics: computeAccuracyMetrics(holdout, hwMultEval.forecast),
    trainMetrics: computeAccuracyMetrics(train, hwMultEval.fitted),
    isBest: false,
    note: hwMultEval.fallbackUsed ? 'Seasonal index fallback (< 2 full cycles in train set)' : undefined,
  });

  // 6. Linear Regression OLS (Time-Series)
  const olsTrain = fitOLS(train);
  const olsHoldoutPreds: number[] = [];
  for (let h = 1; h <= holdLen; h++) {
    olsHoldoutPreds.push(Math.max(0, olsTrain.intercept + olsTrain.slope * (train.length + h)));
  }
  const olsFull = fitOLS(cleanedSeries);
  const olsFuture: number[] = [];
  for (let h = 1; h <= config.horizon; h++) {
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
    futureForecast: olsFuture,
    holdoutMetrics: computeAccuracyMetrics(holdout, olsHoldoutPreds),
    trainMetrics: computeAccuracyMetrics(train, olsTrain.fitted),
    r2: olsFull.r2,
    slope: olsFull.slope,
    intercept: olsFull.intercept,
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

