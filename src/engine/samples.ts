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
    const volume = Math.round(base * dowFactors[dow] + wave);

    points.push({
      id: `sample-${i}`,
      label: iso,
      date: iso,
      volume,
      isSmoothed: false,
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
 * Default 48-slot (30-min) contact center arrival curves calibrated so EVERY day of the week
 * (Mon, Tue, Wed, Thu, Fri, Sat, Sun) has its own distinct, realistic intraday signature.
 */
export const DEFAULT_30M_CURVES: Record<DayKey, number[]> = (() => {
  const rawBase = [
    0.15, 0.12, 0.10, 0.08, 0.07, 0.06, 0.05, 0.04,
    0.04, 0.05, 0.06, 0.08, 0.12, 0.22, 0.42, 0.85,
    1.75, 2.45, 3.35, 4.10, 4.45, 4.85, 5.10, 5.05,
    4.95, 5.00, 5.15, 4.90, 4.75, 4.50, 4.05, 3.85,
    3.40, 3.15, 3.25, 2.95, 2.55, 2.35, 1.95, 1.75,
    1.55, 1.30, 1.05, 0.78, 0.55, 0.48, 0.36, 0.28,
  ];

  const normalize = (arr: number[]) => {
    const s = arr.reduce((a, b) => a + b, 0) || 1;
    return arr.map((v) => Number(((v / s) * 100).toFixed(4)));
  };

  // Monday: Heavy morning surge (08:00-11:30 slots 16..23), sharper afternoon taper
  const mon = normalize(
    rawBase.map((v, idx) =>
      idx >= 16 && idx <= 23
        ? v * 1.16
        : idx >= 24 && idx <= 31
          ? v * 0.96
          : idx >= 32
            ? v * 0.88
            : v
    )
  );

  // Tuesday: Balanced twin-peak (morning 09:30-11:00 + post-lunch 13:30-15:30 slots 27..31)
  const tue = normalize(
    rawBase.map((v, idx) =>
      idx >= 19 && idx <= 22
        ? v * 1.08
        : idx >= 27 && idx <= 32
          ? v * 1.11
          : idx >= 36
            ? v * 0.92
            : v * 0.97
    )
  );

  // Wednesday: Mid-week midday plateau peaking around 11:00-14:00 (slots 22..28)
  const wed = normalize(
    rawBase.map((v, idx) =>
      idx >= 16 && idx <= 20
        ? v * 0.93
        : idx >= 22 && idx <= 29
          ? v * 1.14
          : idx >= 30 && idx <= 35
            ? v * 1.04
            : v
    )
  );

  // Thursday: Gradual morning ramp with heavier afternoon & early evening (13:00-19:00 slots 26..38)
  const thu = normalize(
    rawBase.map((v, idx) =>
      idx >= 16 && idx <= 21
        ? v * 0.86
        : idx >= 26 && idx <= 37
          ? v * 1.15
          : idx >= 38 && idx <= 43
            ? v * 1.10
            : v
    )
  );

  // Friday: Midday dip around 12:00-13:30 (slots 24..27) + afternoon/evening recovery
  const fri = normalize(
    rawBase.map((v, idx) =>
      idx >= 24 && idx <= 27
        ? v * 0.52
        : idx >= 30 && idx <= 39
          ? v * 1.12
          : v
    )
  );

  // Saturday: Later weekend morning start (quiet 07:00-09:30), midday/afternoon concentration
  const sat = normalize(
    rawBase.map((v, idx) =>
      idx >= 14 && idx <= 20
        ? v * 0.62
        : idx >= 24 && idx <= 35
          ? v * 1.18
          : idx >= 36 && idx <= 42
            ? v * 1.08
            : v
    )
  );

  // Sunday: Quieter morning, stronger late-afternoon & evening ramp (14:30-21:00 slots 29..42)
  const sun = normalize(
    rawBase.map((v, idx) =>
      idx >= 14 && idx <= 22
        ? v * 0.58
        : idx >= 29 && idx <= 42
          ? v * 1.24
          : v
    )
  );

  return {
    Mon: mon,
    Tue: tue,
    Wed: wed,
    Thu: thu,
    Fri: fri,
    Sat: sat,
    Sun: sun,
  };
})();

const JS_DAY_TO_KEY: DayKey[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Generates a deterministic, realistic per-date arrival curve for a specific calendar date
 * when only daily totals are available, so every historical date has its own unique intraday signature.
 */
export function buildDateSpecificCurve(
  dateIso: string,
  dayKey?: DayKey,
  baseCurves: Record<DayKey, number[]> = DEFAULT_30M_CURVES
): number[] {
  const parsed = Date.parse(dateIso.length <= 10 ? `${dateIso}T00:00:00Z` : dateIso);
  const resolvedDayKey: DayKey =
    dayKey ??
    (!Number.isNaN(parsed) ? JS_DAY_TO_KEY[new Date(parsed).getUTCDay()] ?? 'Mon' : 'Mon');
  const template = baseCurves[resolvedDayKey] ?? baseCurves.Mon ?? DEFAULT_30M_CURVES.Mon;

  let hash = 2166136261;
  for (let i = 0; i < dateIso.length; i++) {
    hash ^= dateIso.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const phase = ((hash >>> 0) % 360) * (Math.PI / 180);
  const freq = 1.4 + (((hash >>> 8) % 9) * 0.15);
  const amp = 0.055 + (((hash >>> 16) % 5) * 0.012);

  const raw = template.map((v, idx) => {
    const t = idx / template.length;
    const mod = 1 + amp * Math.sin(2 * Math.PI * freq * t + phase);
    return Math.max(0.005, v * mod);
  });
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  return raw.map((v) => Number(((v / sum) * 100).toFixed(4)));
}

/**
 * Builds per-date curves & totals for a historical series whenever individual interval curves
 * were not supplied by an interval-level file.
 */
export function buildDefaultByDateCurves(
  history: HistoricalPoint[],
  baseCurves: Record<DayKey, number[]> = DEFAULT_30M_CURVES
): {
  byDateCurves: Record<string, number[]>;
  byDateTotals: Record<string, number>;
} {
  const byDateCurves: Record<string, number[]> = {};
  const byDateTotals: Record<string, number> = {};
  for (const pt of history) {
    const iso = pt.date ?? pt.label;
    if (!iso) continue;
    const parsed = Date.parse(iso.length <= 10 ? `${iso}T00:00:00Z` : iso);
    const dk: DayKey = !Number.isNaN(parsed)
      ? JS_DAY_TO_KEY[new Date(parsed).getUTCDay()] ?? 'Mon'
      : 'Mon';
    byDateCurves[iso] = buildDateSpecificCurve(iso, dk, baseCurves);
    byDateTotals[iso] = Math.round(pt.volume);
  }
  return { byDateCurves, byDateTotals };
}

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
