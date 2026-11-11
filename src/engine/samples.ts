import type { DayKey, HistoricalPoint, IntervalRowInput } from './types.ts';
import { generateTimeLabels } from './erlang.ts';

/**
 * Generates realistic 56-day (8-week) Contact Center daily history with:
 * - clear weekly seasonality (Mon highest, Fri midday prayer dip, Sat/Sun lowest)
 * - mild upward growth trend (~+0.6%/week)
 * - 1 flagged technical outage / holiday dip for testing cleaning/smoothing
 */
export function buildSampleDailyHistory(): HistoricalPoint[] {
  const dowFactors = [1.28, 1.22, 1.16, 1.11, 0.80, 0.44, 0.46]; // Mon..Sun matching heatmap pattern
  const start = new Date('2026-06-01T00:00:00Z'); // Monday
  const points: HistoricalPoint[] = [];

  for (let i = 0; i < 56; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    const iso = d.toISOString().slice(0, 10);
    const dow = i % 7;
    const week = Math.floor(i / 7);
    const base = 2050 + week * 28;
    // Deterministic realistic micro-variation (no random drift across runs)
    const wave = Math.sin(i * 0.9) * 38 + Math.cos(i * 1.7) * 24;
    let volume = Math.round(base * dowFactors[dow] + wave);

    // Inject one flagged holiday / outage anomaly on Day 24 (Thu) so outlier cleaner shows immediate impact
    const isAnomaly = i === 24;
    if (isAnomaly) {
      volume = 640;
    }

    points.push({
      id: `sample-${i}`,
      label: iso,
      date: iso,
      volume,
      isSmoothed: isAnomaly,
      smoothedVolume: isAnomaly ? 2360 : undefined,
    });
  }
  return points;
}

/**
 * Generates 24 months of realistic Monthly Call Volume history (seasonal payroll/billing cycles + growth trend).
 */
export function buildSampleMonthlyHistory(): HistoricalPoint[] {
  const seasonal = [1.05, 0.94, 1.02, 0.98, 1.04, 1.08, 1.12, 1.09, 0.96, 1.01, 1.06, 1.15];
  const points: HistoricalPoint[] = [];
  for (let i = 0; i < 24; i++) {
    const year = 2025 + Math.floor(i / 12);
    const month = (i % 12) + 1;
    const label = `${year}-${String(month).padStart(2, '0')}-01`;
    const trend = 54000 + i * 520;
    const volume = Math.round(trend * seasonal[i % 12] + Math.sin(i * 1.3) * 450);
    points.push({
      id: `m-${i}`,
      label,
      date: label,
      volume,
    });
  }
  return points;
}

/**
 * Default 48-slot (30-min) contact center arrival curves calibrated to realistic weekday/weekend profile.
 */
export const DEFAULT_30M_CURVES: Record<DayKey, number[]> = (() => {
  // Base bimodal office + evening tail shape for 48 half-hour slots (00:00 .. 23:30)
  const rawWeekday = [
    0.15, 0.12, 0.10, 0.08, 0.07, 0.06, 0.05, 0.04,
    0.04, 0.05, 0.06, 0.08, 0.12, 0.22, 0.42, 0.85,
    1.75, 2.45, 3.35, 4.10, 4.45, 4.85, 5.10, 5.05,
    4.95, 5.00, 5.15, 4.90, 4.75, 4.50, 4.05, 3.85,
    3.40, 3.15, 3.25, 2.95, 2.55, 2.35, 1.95, 1.75,
    1.55, 1.30, 1.05, 0.78, 0.55, 0.48, 0.36, 0.28,
  ];
  const sumW = rawWeekday.reduce((a, b) => a + b, 0);
  const normWeekday = rawWeekday.map((v) => (v / sumW) * 100);

  // Friday curve reflects midday dip around 12:00-13:30
  const rawFriday = rawWeekday.map((v, idx) => (idx >= 24 && idx <= 27 ? v * 0.52 : v));
  const sumF = rawFriday.reduce((a, b) => a + b, 0);
  const normFriday = rawFriday.map((v) => (v / sumF) * 100);

  // Weekend starts later and carries slightly higher evening mix
  const rawWeekend = rawWeekday.map((v, idx) =>
    idx >= 16 && idx <= 21 ? v * 0.65 : idx >= 30 && idx <= 39 ? v * 1.18 : v
  );
  const sumWk = rawWeekend.reduce((a, b) => a + b, 0);
  const normWeekend = rawWeekend.map((v) => (v / sumWk) * 100);

  return {
    Mon: [...normWeekday],
    Tue: [...normWeekday],
    Wed: [...normWeekday],
    Thu: [...normWeekday],
    Fri: [...normFriday],
    Sat: [...normWeekend],
    Sun: [...normWeekend],
  };
})();

export const DEFAULT_DOW_SHARES: Record<DayKey, number> = {
  Mon: 20.2,
  Tue: 19.0,
  Wed: 18.1,
  Thu: 17.2,
  Fri: 12.0,
  Sat: 6.7,
  Sun: 6.8,
};

/**
 * Resamples a 30-min arrival percentage array (length 48) cleanly to 60-min (24) or 15-min (96) slots.
 */
export function buildIntervalInputsForGranularity(
  curvePercent: number[],
  granularityMin: 60 | 30 | 15
): IntervalRowInput[] {
  const labels = generateTimeLabels(granularityMin);
  const targetLen = labels.length;

  let resampled: number[] = [];
  if (curvePercent.length === targetLen) {
    resampled = [...curvePercent];
  } else if (curvePercent.length === 48 && targetLen === 24) {
    for (let i = 0; i < 24; i++) {
      resampled.push(curvePercent[i * 2] + curvePercent[i * 2 + 1]);
    }
  } else if (curvePercent.length === 48 && targetLen === 96) {
    for (let i = 0; i < 48; i++) {
      resampled.push(curvePercent[i] / 2, curvePercent[i] / 2);
    }
  } else if (curvePercent.length === 24 && targetLen === 48) {
    for (let i = 0; i < 24; i++) {
      resampled.push(curvePercent[i] / 2, curvePercent[i] / 2);
    }
  } else if (curvePercent.length === 96 && targetLen === 48) {
    for (let i = 0; i < 48; i++) {
      resampled.push(curvePercent[i * 2] + curvePercent[i * 2 + 1]);
    }
  } else {
    const ratio = curvePercent.length / targetLen;
    for (let i = 0; i < targetLen; i++) {
      const srcIdx = Math.min(curvePercent.length - 1, Math.floor(i * ratio));
      resampled.push(curvePercent[srcIdx] ?? 0);
    }
  }

  const total = resampled.reduce((a, b) => a + b, 0) || 1;
  return labels.map((timeLabel, index) => ({
    index,
    timeLabel,
    arrivalPct: Number(((resampled[index] / total) * 100).toFixed(3)),
    ahtOverrideSec: null,
  }));
}

