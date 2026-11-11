import * as XLSX from 'xlsx';
import type { DayKey, HistoricalPoint, IntervalGranularityMin, ParsedDataset } from './types.ts';
import { generateTimeLabels } from './erlang.ts';

const DAY_KEYS: DayKey[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const JS_DAY_TO_KEY: DayKey[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const DAY_ALIASES: Record<string, DayKey> = {
  mon: 'Mon', monday: 'Mon', الإثنين: 'Mon', الاثنين: 'Mon',
  tue: 'Tue', tues: 'Tue', tuesday: 'Tue', الثلاثاء: 'Tue',
  wed: 'Wed', wednesday: 'Wed', الأربعاء: 'Wed', الاربعاء: 'Wed',
  thu: 'Thu', thur: 'Thu', thurs: 'Thu', thursday: 'Thu', الخميس: 'Thu',
  fri: 'Fri', friday: 'Fri', الجمعة: 'Fri',
  sat: 'Sat', saturday: 'Sat', السبت: 'Sat',
  sun: 'Sun', sunday: 'Sun', الأحد: 'Sun', الاحد: 'Sun',
};

function parseDayKey(raw: unknown): DayKey | null {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  if (DAY_ALIASES[s]) return DAY_ALIASES[s];
  for (const [k, v] of Object.entries(DAY_ALIASES)) {
    if (s.startsWith(k)) return v;
  }
  return null;
}

export function parseTimeToMinutes(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw >= 0 && raw < 1) {
      return Math.round(raw * 1440) % 1440;
    }
    return null;
  }
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/total|grand|sum|إجمالي|المجموع/i.test(s)) return null;

  // Match 12h or 24h strings: "12:00:00 AM", "1:30 PM", "08:30", "23:30:00"
  const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
  if (!m) return null;
  let hh = Number(m[1]);
  const mm = Number(m[2]);
  if (mm < 0 || mm > 59) return null;
  const ampm = m[3]?.toUpperCase();
  if (ampm) {
    if (hh < 1 || hh > 12) return null;
    if (ampm === 'AM') hh = hh === 12 ? 0 : hh;
    if (ampm === 'PM') hh = hh === 12 ? 12 : hh + 12;
  } else if (hh < 0 || hh > 23) {
    return null;
  }
  return hh * 60 + mm;
}

export function parseDateToIso(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 20000 && raw < 90000) {
    // Excel serial date -> UTC date
    const utcMs = Math.round((raw - 25569) * 86400 * 1000);
    const d = new Date(utcMs);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString().slice(0, 10);
    }
  }
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return raw.toISOString().slice(0, 10);
  }
  const s = String(raw ?? '').trim();
  if (!s || /total|grand|interval|time|فترة|إجمالي/i.test(s)) return null;

  // ISO YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // M/D/YYYY or D/M/YYYY -> detect cleanly (Month first if col headers look US M/D/YYYY, else fallback)
  const slashMatch = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (slashMatch) {
    const a = Number(slashMatch[1]);
    const b = Number(slashMatch[2]);
    let y = Number(slashMatch[3]);
    if (y < 100) y += 2000;
    // Prefer M/D/YYYY when a <= 12 and b > 12 or standard US pivot export, fallback D/M if a > 12
    const month = a > 12 ? b : a;
    const day = a > 12 ? a : b;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  const parsed = Date.parse(s);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString().slice(0, 10);
  }
  return null;
}

function toNumberOrZero(raw: unknown): number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  const s = String(raw ?? '').replace(/,/g, '').trim();
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function isTotalRowLabel(raw: unknown): boolean {
  const s = String(raw ?? '').trim().toLowerCase();
  return s === 'total' || s === 'grand total' || s === 'sum' || s === 'الإجمالي' || s === 'المجموع';
}

function inferGranularityFromMinutes(minutesList: number[]): IntervalGranularityMin {
  const unique = [...new Set(minutesList)].sort((a, b) => a - b);
  if (unique.length >= 70) return 15;
  if (unique.length >= 30) return 30;
  if (unique.length >= 2) {
    const diffs = unique.slice(1).map((v, i) => v - unique[i]).filter((d) => d > 0);
    const minDiff = Math.min(...diffs);
    if (minDiff <= 15) return 15;
    if (minDiff <= 30) return 30;
  }
  return 60;
}

function normalizeCurves(
  accum: Record<DayKey, number[]>,
  granularityMin: IntervalGranularityMin
): Record<DayKey, number[]> {
  const slots = Math.round(1440 / granularityMin);
  // Compute overall fallback average curve across populated days
  const globalCurve = new Array(slots).fill(0);
  for (const d of DAY_KEYS) {
    const arr = accum[d];
    for (let i = 0; i < slots; i++) {
      globalCurve[i] += arr[i] ?? 0;
    }
  }
  const globalSum = globalCurve.reduce((a, b) => a + b, 0);
  const normalizedGlobal =
    globalSum > 0
      ? globalCurve.map((v) => (v / globalSum) * 100)
      : new Array(slots).fill(100 / slots);

  const result = {} as Record<DayKey, number[]>;
  for (const d of DAY_KEYS) {
    const arr = accum[d];
    const sum = arr.reduce((a, b) => a + b, 0);
    result[d] = sum > 0 ? arr.map((v) => (v / sum) * 100) : [...normalizedGlobal];
  }
  return result;
}

function parseDelimitedText(text: string): string[][] {
  const lines = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const sample = lines[0];
  const sep = sample.includes('\t') ? '\t' : sample.includes(';') ? ';' : ',';
  return lines.map((line) => {
    if (sep === '\t') return line.split('\t').map((c) => c.trim());
    // Basic CSV quote-aware split
    const cells: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === sep && !inQuotes) {
        cells.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    cells.push(cur.trim());
    return cells;
  });
}

export function parseMatrixToDataset(matrix: unknown[][]): ParsedDataset {
  const cleanRows = matrix.filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
  if (cleanRows.length < 2) {
    throw new Error('Dataset needs at least a header/label and 2 data rows.');
  }

  const header = cleanRows[0].map((c) => c);
  const firstColHasTimes =
    cleanRows.slice(1, Math.min(10, cleanRows.length)).filter((r) => parseTimeToMinutes(r[0]) !== null)
      .length >= 2;

  // Detect Format B: 48x7 / Interval x Mon..Sun Heatmap
  const dayColMap = new Map<number, DayKey>();
  header.forEach((h, colIdx) => {
    if (colIdx === 0) return;
    const dk = parseDayKey(h);
    if (dk) dayColMap.set(colIdx, dk);
  });

  if (firstColHasTimes && dayColMap.size >= 5) {
    const timeMinutes: number[] = [];
    const dataRows = cleanRows.slice(1).filter((r) => !isTotalRowLabel(r[0]));
    dataRows.forEach((r) => {
      const mins = parseTimeToMinutes(r[0]);
      if (mins !== null) timeMinutes.push(mins);
    });
    const granularity = inferGranularityFromMinutes(timeMinutes);
    const slots = Math.round(1440 / granularity);
    const accum = Object.fromEntries(DAY_KEYS.map((d) => [d, new Array(slots).fill(0)])) as Record<
      DayKey,
      number[]
    >;
    const dayTotals = Object.fromEntries(DAY_KEYS.map((d) => [d, 0])) as Record<DayKey, number>;

    for (const r of dataRows) {
      const mins = parseTimeToMinutes(r[0]);
      if (mins === null) continue;
      const slot = Math.min(slots - 1, Math.floor(mins / granularity));
      for (const [colIdx, dk] of dayColMap.entries()) {
        const val = Math.max(0, toNumberOrZero(r[colIdx]));
        accum[dk][slot] += val;
        dayTotals[dk] += val;
      }
    }

    const totalWeek = Object.values(dayTotals).reduce((a, b) => a + b, 0) || 1;
    const dayOfWeekShares = Object.fromEntries(
      DAY_KEYS.map((d) => [d, (dayTotals[d] / totalWeek) * 100])
    ) as Record<DayKey, number>;

    // Build 4-week synthetic daily series preserving exact weekday pattern
    const dailySeries: HistoricalPoint[] = [];
    const baseDate = new Date('2026-08-03T00:00:00Z'); // Monday
    for (let w = 0; w < 4; w++) {
      for (let di = 0; di < 7; di++) {
        const d = new Date(baseDate.getTime() + (w * 7 + di) * 86400000);
        const iso = d.toISOString().slice(0, 10);
        const dk = DAY_KEYS[di];
        dailySeries.push({
          id: `row-${w * 7 + di}`,
          label: iso,
          date: iso,
          volume: Math.round(dayTotals[dk]),
        });
      }
    }

    const normCurves = normalizeCurves(accum, granularity);
    const byDateCurves: Record<string, number[]> = {};
    const byDateVolumes: Record<string, number[]> = {};
    const byDateTotals: Record<string, number> = {};
    for (const pt of dailySeries) {
      if (!pt.date) continue;
      const jsDay = new Date(`${pt.date}T00:00:00Z`).getUTCDay();
      const dk = JS_DAY_TO_KEY[jsDay];
      byDateCurves[pt.date] = [...normCurves[dk]];
      byDateVolumes[pt.date] = normCurves[dk].map((pct) => Number(((pt.volume * pct) / 100).toFixed(2)));
      byDateTotals[pt.date] = pt.volume;
    }

    return {
      format: 'heatmap_48x7',
      periodicityGuess: 'daily',
      dailySeries,
      granularityMinGuess: granularity,
      dayCurves: normCurves,
      dayOfWeekShares,
      byDateCurves,
      byDateVolumes,
      byDateTotals,
      timeLabels: generateTimeLabels(granularity),
      summaryNote: `Detected ${slots}x${dayColMap.size} Intraday Heatmap (${granularity}m). Extracted 7 day curves & synthesized 28-day weekly pattern.`,
    };
  }

  // Detect Format A: Cross-Tab Pivot (Interval rows x Date columns)
  const dateColMap = new Map<number, string>();
  header.forEach((h, colIdx) => {
    if (colIdx === 0) return;
    const iso = parseDateToIso(h);
    if (iso) dateColMap.set(colIdx, iso);
  });

  if (firstColHasTimes && dateColMap.size >= 2) {
    const dataRows = cleanRows.slice(1).filter((r) => !isTotalRowLabel(r[0]));
    const timeMinutes: number[] = [];
    for (const r of dataRows) {
      const m = parseTimeToMinutes(r[0]);
      if (m !== null) timeMinutes.push(m);
    }
    const granularity = inferGranularityFromMinutes(timeMinutes);
    const slots = Math.round(1440 / granularity);

    const accum = Object.fromEntries(DAY_KEYS.map((d) => [d, new Array(slots).fill(0)])) as Record<
      DayKey,
      number[]
    >;
    const dateTotals = new Map<string, number>();
    const dateSlotVolumes = new Map<string, number[]>();
    for (const iso of dateColMap.values()) {
      if (!dateTotals.has(iso)) dateTotals.set(iso, 0);
      if (!dateSlotVolumes.has(iso)) dateSlotVolumes.set(iso, new Array(slots).fill(0));
    }

    for (const r of dataRows) {
      const mins = parseTimeToMinutes(r[0]);
      if (mins === null) continue;
      const slot = Math.min(slots - 1, Math.floor(mins / granularity));
      for (const [colIdx, iso] of dateColMap.entries()) {
        const val = Math.max(0, toNumberOrZero(r[colIdx]));
        dateTotals.set(iso, (dateTotals.get(iso) ?? 0) + val);
        const slotArr = dateSlotVolumes.get(iso);
        if (slotArr) slotArr[slot] += val;
        const jsDay = new Date(`${iso}T00:00:00Z`).getUTCDay();
        const dk = JS_DAY_TO_KEY[jsDay];
        accum[dk][slot] += val;
      }
    }

    const sortedDates = [...dateTotals.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const dailySeries: HistoricalPoint[] = sortedDates.map(([iso, vol], i) => ({
      id: `pt-${i}`,
      label: iso,
      date: iso,
      volume: Math.round(vol),
    }));

    const normCurves = normalizeCurves(accum, granularity);
    const byDateCurves: Record<string, number[]> = {};
    const byDateVolumes: Record<string, number[]> = {};
    const byDateTotals: Record<string, number> = {};
    for (const [iso, totalVol] of sortedDates) {
      const vols = dateSlotVolumes.get(iso) ?? new Array(slots).fill(0);
      const jsDay = new Date(`${iso}T00:00:00Z`).getUTCDay();
      const dk = JS_DAY_TO_KEY[jsDay];
      byDateVolumes[iso] = vols.map((v) => Number(v.toFixed(2)));
      byDateTotals[iso] = Math.round(totalVol);
      byDateCurves[iso] =
        totalVol > 0 ? vols.map((v) => (v / totalVol) * 100) : [...normCurves[dk]];
    }

    const daySumByKey = Object.fromEntries(DAY_KEYS.map((d) => [d, 0])) as Record<DayKey, number>;
    const dayCountByKey = Object.fromEntries(DAY_KEYS.map((d) => [d, 0])) as Record<DayKey, number>;
    for (const pt of dailySeries) {
      const jsDay = new Date(`${pt.date}T00:00:00Z`).getUTCDay();
      const dk = JS_DAY_TO_KEY[jsDay];
      daySumByKey[dk] += pt.volume;
      dayCountByKey[dk] += 1;
    }
    const avgPerDay = DAY_KEYS.map((d) => (dayCountByKey[d] > 0 ? daySumByKey[d] / dayCountByKey[d] : 0));
    const avgSum = avgPerDay.reduce((a, b) => a + b, 0) || 1;
    const dayOfWeekShares = Object.fromEntries(
      DAY_KEYS.map((d, i) => [d, (avgPerDay[i] / avgSum) * 100])
    ) as Record<DayKey, number>;

    return {
      format: 'crosstab_pivot',
      periodicityGuess: 'daily',
      dailySeries,
      granularityMinGuess: granularity,
      dayCurves: normCurves,
      dayOfWeekShares,
      byDateCurves,
      byDateVolumes,
      byDateTotals,
      timeLabels: generateTimeLabels(granularity),
      summaryNote: `Detected Cross-Tab Pivot (${sortedDates.length} dates × ${granularity}m intervals). Populated Forecasting series & exact per-date arrival curves.`,
    };
  }

  // Detect Format C: Long format (Date, Interval, Volume)
  const lowerHeader = header.map((h) => String(h ?? '').toLowerCase());
  const dateCol = lowerHeader.findIndex((h) => /date|day|تاريخ|يوم/.test(h));
  const intervalCol = lowerHeader.findIndex((h) => /interval|time|slot|فترة|وقت/.test(h));
  const volCol = lowerHeader.findIndex((h) => /vol|calls|offered|مكالم|حجم/.test(h));

  if (dateCol >= 0 && intervalCol >= 0 && volCol >= 0) {
    const minsSeen: number[] = [];
    const grouped = new Map<string, { mins: number; vol: number }[]>();
    for (const r of cleanRows.slice(1)) {
      const iso = parseDateToIso(r[dateCol]);
      const mins = parseTimeToMinutes(r[intervalCol]);
      if (!iso || mins === null) continue;
      minsSeen.push(mins);
      const vol = Math.max(0, toNumberOrZero(r[volCol]));
      const arr = grouped.get(iso) ?? [];
      arr.push({ mins, vol });
      grouped.set(iso, arr);
    }
    if (grouped.size > 0) {
      const granularity = inferGranularityFromMinutes(minsSeen);
      const slots = Math.round(1440 / granularity);
      const accum = Object.fromEntries(DAY_KEYS.map((d) => [d, new Array(slots).fill(0)])) as Record<
        DayKey,
        number[]
      >;
      const byDateVolumes: Record<string, number[]> = {};
      const byDateTotals: Record<string, number> = {};
      const dailySeries: HistoricalPoint[] = [...grouped.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([iso, entries], i) => {
          const dk = JS_DAY_TO_KEY[new Date(`${iso}T00:00:00Z`).getUTCDay()];
          const slotArr = new Array(slots).fill(0);
          let sum = 0;
          for (const e of entries) {
            sum += e.vol;
            const slotIdx = Math.min(slots - 1, Math.floor(e.mins / granularity));
            accum[dk][slotIdx] += e.vol;
            slotArr[slotIdx] += e.vol;
          }
          byDateVolumes[iso] = slotArr.map((v) => Number(v.toFixed(2)));
          byDateTotals[iso] = Math.round(sum);
          return { id: `pt-${i}`, label: iso, date: iso, volume: Math.round(sum) };
        });

      const normCurves = normalizeCurves(accum, granularity);
      const byDateCurves: Record<string, number[]> = {};
      for (const pt of dailySeries) {
        if (!pt.date) continue;
        const vols = byDateVolumes[pt.date] ?? [];
        const tot = byDateTotals[pt.date] ?? 0;
        const dk = JS_DAY_TO_KEY[new Date(`${pt.date}T00:00:00Z`).getUTCDay()];
        byDateCurves[pt.date] = tot > 0 ? vols.map((v) => (v / tot) * 100) : [...normCurves[dk]];
      }

      return {
        format: 'long_interval',
        periodicityGuess: 'daily',
        dailySeries,
        granularityMinGuess: granularity,
        dayCurves: normCurves,
        byDateCurves,
        byDateVolumes,
        byDateTotals,
        timeLabels: generateTimeLabels(granularity),
        summaryNote: `Detected Long Interval table (${dailySeries.length} days, ${granularity}m).`,
      };
    }
  }

  // Fallback Format D: Simple Date/Period + Volume two-column table (or headerless single column)
  const hasHeader = toNumberOrZero(cleanRows[0][cleanRows[0].length - 1]) === 0 &&
    String(cleanRows[0][cleanRows[0].length - 1]).trim() !== '0';
  const startIdx = hasHeader ? 1 : 0;
  const labelIdx = 0;
  const valueIdx = cleanRows[startIdx]?.length > 1 ? (volCol >= 0 ? volCol : 1) : 0;

  const dailySeries: HistoricalPoint[] = [];
  const byDateTotals: Record<string, number> = {};
  for (let i = startIdx; i < cleanRows.length; i++) {
    const r = cleanRows[i];
    if (isTotalRowLabel(r[0])) continue;
    const rawLabel = valueIdx === 0 ? `Period ${dailySeries.length + 1}` : String(r[labelIdx] ?? '').trim();
    const iso = valueIdx === 0 ? null : parseDateToIso(r[labelIdx]);
    const vol = Math.max(0, toNumberOrZero(r[valueIdx]));
    if (iso) byDateTotals[iso] = vol;
    dailySeries.push({
      id: `pt-${dailySeries.length}`,
      label: iso ?? (rawLabel || `P${dailySeries.length + 1}`),
      date: iso ?? undefined,
      volume: vol,
    });
  }

  // Chronological sort only if all rows parsed cleanly as ISO dates
  if (dailySeries.length > 0 && dailySeries.every((d) => Boolean(d.date))) {
    dailySeries.sort((a, b) => a.date!.localeCompare(b.date!));
  }

  // Heuristic periodicity guess
  let periodicityGuess: 'daily' | 'weekly' | 'monthly' = 'daily';
  if (dailySeries.length >= 3 && dailySeries[0].date && dailySeries[1].date) {
    const diffDays = Math.round(
      (Date.parse(dailySeries[1].date) - Date.parse(dailySeries[0].date)) / 86400000
    );
    if (diffDays >= 25) periodicityGuess = 'monthly';
    else if (diffDays >= 6) periodicityGuess = 'weekly';
  }

  return {
    format: 'simple_daily',
    periodicityGuess,
    dailySeries,
    granularityMinGuess: 30,
    byDateTotals: Object.keys(byDateTotals).length > 0 ? byDateTotals : undefined,
    summaryNote: `Parsed ${dailySeries.length} ${periodicityGuess} periods.`,
  };
}

export function parseTextDataset(text: string): ParsedDataset {
  const matrix = parseDelimitedText(text);
  return parseMatrixToDataset(matrix);
}

export async function parseFileDataset(file: File): Promise<ParsedDataset> {
  const ext = file.name.toLowerCase().split('.').pop();
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
    const text = await file.text();
    return parseTextDataset(text);
  }
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: false });
  const firstSheet = wb.Sheets[wb.SheetNames[0]];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(firstSheet, { header: 1, defval: '' });
  return parseMatrixToDataset(matrix);
}

