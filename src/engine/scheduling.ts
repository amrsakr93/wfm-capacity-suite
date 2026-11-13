import * as XLSX from 'xlsx';
import type {
  AgentDayAssignment,
  BreakAssignment,
  BreakPlacementRules,
  DailyCoverageSummary,
  DayKey,
  ErlangConfig,
  ExceptionCode,
  ForecastDayItem,
  IntervalCoverageCell,
  LeaveAllocationCode,
  LeaveCounts,
  RosterAgentInput,
  RosterInputMode,
  ScheduleGenerationResult,
  ScheduledAgentRow,
  SchedulingRules,
  ShiftDailyMixRow,
  ShiftTemplate,
} from './types.ts';
import { computeErlangCMetrics, generateTimeLabels, runErlangPlanner } from './erlang.ts';
import { parseTimeToMinutes } from './parsers.ts';
import { buildIntervalInputsForGranularity, DEFAULT_30M_CURVES } from './samples.ts';

export const WEEK_DAYS: DayKey[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const EXCEPTION_META: Record<
  ExceptionCode,
  { code: ExceptionCode; label: string; short: string }
> = {
  AL: { code: 'AL', label: 'Annual Leave', short: 'Annual' },
  MAT: { code: 'MAT', label: 'Maternity Leave', short: 'Maternity' },
  RES: { code: 'RES', label: 'Resignation', short: 'Resign' },
  TERM: { code: 'TERM', label: 'Termination', short: 'Terminated' },
  UPL: { code: 'UPL', label: 'Unpaid Leave (UPL)', short: 'UPL' },
  PAT: { code: 'PAT', label: 'Paternity Leave', short: 'Paternity' },
};

export const DEFAULT_BREAK_RULES: BreakPlacementRules = {
  firstBreakMin: 15,
  lunchMin: 30,
  lastBreakMin: 15,
  maxContinuousLoginMin: 210, // 3h 30m
  minGapBetweenBreaksMin: 60, // 1h 00m
  edgeBufferMin: 60, // avoid placing breaks immediately on punch-in/out when possible
};

export const DEFAULT_SCHEDULING_RULES: SchedulingRules = {
  maxWorkdaysPerWeek: 5,
  allowSunMonSplitOff: true, // Mon & Sun split OFF permitted
  maxWeeklyStartDriftHours: 2, // Allows 08+09 or 10+12; blocks 15->08 clopening jumps
  minInterShiftRestHours: 12, // Enforces >= 12h sleep/rest between shifts
  annualVisibilityInOutput: 'show_muted', // AL shown full-week inside roster table like other leaves (0% cov)
  shiftHeadcountOverrides: {},
  breakRules: { ...DEFAULT_BREAK_RULES },
};

/**
 * Sorts shift templates chronologically across the 24-hour operational day (00:00 -> 23:45).
 */
export function sortShiftCatalogChronologically(shifts: ShiftTemplate[]): ShiftTemplate[] {
  return [...shifts].sort((a, b) => a.startMin - b.startMin || a.durationMin - b.durationMin);
}

export function formatMinutesHHMM(totalMin: number): string {
  const m = ((Math.round(totalMin) % 1440) + 1440) % 1440;
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function parseFlexibleTimeMinutes(token: string): number | null {
  const clean = token.trim();
  if (!clean) return null;
  if (clean === '24:00') return 0;
  const standard = parseTimeToMinutes(clean);
  if (standard !== null) return standard;
  const shortAmPm = clean.match(/^(\d{1,2})\s*(AM|PM)$/i);
  if (shortAmPm) {
    let hh = Number(shortAmPm[1]);
    const ampm = shortAmPm[2].toUpperCase();
    if (hh < 1 || hh > 12) return null;
    if (ampm === 'AM') hh = hh === 12 ? 0 : hh;
    if (ampm === 'PM') hh = hh === 12 ? 12 : hh + 12;
    return hh * 60;
  }
  return null;
}

export function createShiftTemplate(
  startMin: number,
  durationMin = 540,
  enabled = true
): ShiftTemplate {
  const cleanStart = ((Math.round(startMin) % 1440) + 1440) % 1440;
  const cleanDur = Math.max(240, Math.min(840, Math.round(durationMin)));
  const endMinOfDay = (cleanStart + cleanDur) % 1440;
  const startLabel = formatMinutesHHMM(cleanStart);
  const endLabel = formatMinutesHHMM(endMinOfDay);
  const id = `${startLabel}-${endLabel}`;
  return {
    id,
    label: `${startLabel}–${endLabel}`,
    startMin: cleanStart,
    durationMin: cleanDur,
    endMinOfDay,
    wrapsMidnight: cleanStart + cleanDur > 1440,
    enabled,
  };
}

/**
 * Parses external shift definitions from pasted text, CSV/TSV lines, or Excel rows.
 * Supports "08:00-17:00", "9:00 AM - 6:00 PM", "15:00 to 00:00", "22:00 - 07:00", or "Start, End".
 */
export function parseShiftCatalogText(
  raw: string,
  fallbackDurationMin = 540
): ShiftTemplate[] {
  const lines = raw
    .split(/\r?\n|;/)
    .map((l) => l.trim())
    .filter(Boolean);

  const parsed: ShiftTemplate[] = [];
  const seen = new Set<string>();
  const timeRegex = /(\d{1,2}(?::\d{2}(?::\d{2})?)?\s*(?:AM|PM)?)/gi;

  for (const line of lines) {
    // Skip header lines containing words without numbers
    if (/^(shift|start|begin|schedule|time|code)\b/i.test(line) && !/\d{1,2}:\d{2}/.test(line)) {
      continue;
    }
    const entries = line.includes(',') && !/\t/.test(line)
      ? line.split(',').map((s) => s.trim()).filter(Boolean)
      : [line];

    // If comma-separated pair looks like "09:00, 18:00" treat as a single line
    const candidates =
      entries.length === 2 &&
      parseFlexibleTimeMinutes(entries[0]) !== null &&
      parseFlexibleTimeMinutes(entries[1]) !== null
        ? [line]
        : entries;

    for (const candidate of candidates) {
      const tokens = [...candidate.matchAll(timeRegex)]
        .map((m) => parseFlexibleTimeMinutes(m[1]))
        .filter((v): v is number => v !== null);
      if (tokens.length === 0) continue;

      const startMin = tokens[0];
      let durationMin = fallbackDurationMin;
      if (tokens.length >= 2) {
        const endMin = tokens[1];
        const diff = (endMin - startMin + 1440) % 1440;
        durationMin = diff > 0 ? diff : fallbackDurationMin;
      }
      const tmpl = createShiftTemplate(startMin, durationMin, true);
      if (!seen.has(tmpl.id)) {
        seen.add(tmpl.id);
        parsed.push(tmpl);
      }
    }
  }
  return sortShiftCatalogChronologically(parsed);
}

export async function parseShiftCatalogFile(
  file: File,
  fallbackDurationMin = 540
): Promise<ShiftTemplate[]> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', raw: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false });
    const lines = rows
      .map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '').trim()).filter(Boolean).join(' - ') : ''))
      .filter(Boolean)
      .join('\n');
    return parseShiftCatalogText(lines, fallbackDurationMin);
  }
  return parseShiftCatalogText(await file.text(), fallbackDurationMin);
}

export const DEFAULT_SHIFT_CATALOG: ShiftTemplate[] = parseShiftCatalogText(
  ['08:00-17:00', '09:00-18:00', '10:00-19:00', '12:00-21:00', '15:00-00:00'].join('\n')
);

function parseExceptionAlias(raw?: string): ExceptionCode | null {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return null;
  if (/^(al|annual|annual\s*leave|vacation|pto)\b/.test(s)) return 'AL';
  if (/^(mat|maternity)\b/.test(s)) return 'MAT';
  if (/^(res|resign|resignation|resigned)\b/.test(s)) return 'RES';
  if (/^(term|terminated|termination)\b/.test(s)) return 'TERM';
  if (/^(upl|unpaid|unpaid\s*leave)\b/.test(s)) return 'UPL';
  if (/^(pat|paternity)\b/.test(s)) return 'PAT';
  return null;
}

/**
 * Parses uploaded or pasted agent roster names and optional pre-tagged exceptions.
 */
export function parseAgentRosterText(raw: string): RosterAgentInput[] {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const out: RosterAgentInput[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const parts = line.split(/\t|,|;/).map((p) => p.trim());
    const first = parts[0] ?? '';
    if (
      i === 0 &&
      /^(name|agent|agent\s*name|employee|emp|staff|id)$/i.test(first.replace(/[:#]/g, '').trim())
    ) {
      continue;
    }
    if (!first) continue;

    // Support both "Name, Status" and "ID, Name, Status" when column 0 is purely numeric ID
    let name = first;
    let statusRaw = parts[1];
    if (/^\d{3,}$/.test(first) && parts[1] && parseExceptionAlias(parts[1]) === null) {
      name = `${parts[1]} (${first})`;
      statusRaw = parts[2];
    }

    const lockedException = parseExceptionAlias(statusRaw) ?? parseExceptionAlias(parts[2]);
    out.push({
      id: `agent-${out.length + 1}`,
      name,
      lockedException,
    });
  }
  return out;
}

export async function parseAgentRosterFile(file: File): Promise<RosterAgentInput[]> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', raw: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false });
    const text = rows
      .map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '').trim()).join('\t') : ''))
      .filter(Boolean)
      .join('\n');
    return parseAgentRosterText(text);
  }
  return parseAgentRosterText(await file.text());
}

/**
 * Minimum circular arc span (hours) covering a set of shift start minutes on a 24h clock.
 * Example: [22:00, 00:00] => 2.0h; [08:00, 15:00] => 7.0h.
 */
export function computeCircularStartSpanHours(startMins: number[]): number {
  const uniq = Array.from(
    new Set(startMins.map((m) => ((Math.round(m) % 1440) + 1440) % 1440))
  ).sort((a, b) => a - b);
  if (uniq.length <= 1) return 0;

  let maxGap = 0;
  for (let i = 0; i < uniq.length - 1; i++) {
    maxGap = Math.max(maxGap, uniq[i + 1] - uniq[i]);
  }
  maxGap = Math.max(maxGap, uniq[0] + 1440 - uniq[uniq.length - 1]);
  return Number(((1440 - maxGap) / 60).toFixed(2));
}

function getMinimumWeeklyRestHours(
  assignments: Record<DayKey, AgentDayAssignment>,
  shiftMap: Map<string, ShiftTemplate>
): number | null {
  const instances: { startAbs: number; endAbs: number }[] = [];
  for (let dIdx = 0; dIdx < 7; dIdx++) {
    const a = assignments[WEEK_DAYS[dIdx]];
    if (a.status !== 'WORK' || !a.shiftId) continue;
    const shift = shiftMap.get(a.shiftId);
    if (!shift) continue;
    const startAbs = dIdx * 1440 + shift.startMin;
    instances.push({ startAbs, endAbs: startAbs + shift.durationMin });
  }
  if (instances.length < 2) return null;

  let minRest = Infinity;
  for (let i = 0; i < instances.length; i++) {
    const curr = instances[i];
    const next =
      i + 1 < instances.length
        ? instances[i + 1]
        : { startAbs: instances[0].startAbs + 7 * 1440, endAbs: instances[0].endAbs + 7 * 1440 };
    const restH = (next.startAbs - curr.endAbs) / 60;
    if (restH < minRest) minRest = restH;
  }
  return Number.isFinite(minRest) ? Number(minRest.toFixed(2)) : null;
}

function getValidOffPairSet(allowSunMonSplitOff: boolean): [number, number][] {
  const pairs: [number, number][] = [
    [0, 1], // Mon+Tue
    [1, 2], // Tue+Wed
    [2, 3], // Wed+Thu
    [3, 4], // Thu+Fri
    [4, 5], // Fri+Sat
    [5, 6], // Sat+Sun
  ];
  if (allowSunMonSplitOff) {
    pairs.push([0, 6]); // Sun+Mon split edge wrap
  }
  return pairs;
}

export function isValidOffDaysPattern(
  offDayIndices: number[],
  allowSunMonSplitOff: boolean
): boolean {
  if (offDayIndices.length !== 2) return false;
  const sorted = [...offDayIndices].sort((a, b) => a - b);
  if (sorted[1] - sorted[0] === 1) return true;
  return allowSunMonSplitOff && sorted[0] === 0 && sorted[1] === 6;
}

/**
 * Evaluates all hard WFM rules on an agent's weekly row without mutating assignments.
 */
export function validateAgentScheduleRow(
  row: ScheduledAgentRow,
  shiftCatalog: ShiftTemplate[],
  rules: SchedulingRules
): ScheduledAgentRow {
  const shiftMap = new Map(shiftCatalog.map((s) => [s.id, s]));
  const violations: string[] = [];

  const statuses = WEEK_DAYS.map((dk) => row.assignments[dk]?.status ?? 'OFF');
  const workIndices: number[] = [];
  const offIndices: number[] = [];
  const startMins: number[] = [];
  const weekExceptions = new Set<ExceptionCode>();

  for (let i = 0; i < 7; i++) {
    const st = statuses[i];
    const assign = row.assignments[WEEK_DAYS[i]];
    if (st === 'WORK') {
      workIndices.push(i);
      const shift = assign?.shiftId ? shiftMap.get(assign.shiftId) : null;
      if (shift) startMins.push(shift.startMin);
      if (assign?.breaks && !assign.breaks.isValid) {
        violations.push(`${WEEK_DAYS[i]}: Break rule exceeded (>3.5h streak or <1h gap)`);
      }
    } else if (st === 'OFF') {
      offIndices.push(i);
    } else {
      weekExceptions.add(st);
    }
  }

  const allSameException = workIndices.length === 0 && offIndices.length === 0 && weekExceptions.size === 1;
  const spanHours = computeCircularStartSpanHours(startMins);
  const minRestHours = getMinimumWeeklyRestHours(row.assignments, shiftMap);

  if (!allSameException) {
    if (workIndices.length > rules.maxWorkdaysPerWeek) {
      violations.push(`Works ${workIndices.length}d (max ${rules.maxWorkdaysPerWeek}d)`);
    }
    if (offIndices.length < 2) {
      violations.push(`Only ${offIndices.length} OFF day(s)`);
    } else if (offIndices.length === 2 && !isValidOffDaysPattern(offIndices, rules.allowSunMonSplitOff)) {
      violations.push('2 OFF days are not consecutive (or Mon+Sun split)');
    }
    if (spanHours > rules.maxWeeklyStartDriftHours + 1e-6) {
      violations.push(`Shift drift ${spanHours}h > ${rules.maxWeeklyStartDriftHours}h band`);
    }
    if (minRestHours !== null && minRestHours < rules.minInterShiftRestHours - 1e-6) {
      violations.push(`Min rest ${minRestHours}h < ${rules.minInterShiftRestHours}h (clopening risk)`);
    }
  }

  let offLabel = row.offPatternLabel;
  if (allSameException) {
    const code = [...weekExceptions][0];
    offLabel = `${code} (Full Week)`;
  } else if (offIndices.length === 2) {
    offLabel =
      offIndices[0] === 0 && offIndices[1] === 6
        ? 'Sun+Mon (Split)'
        : `${WEEK_DAYS[offIndices[0]]}+${WEEK_DAYS[offIndices[1]]}`;
  } else if (offIndices.length > 0) {
    offLabel = offIndices.map((idx) => WEEK_DAYS[idx]).join('+');
  }

  return {
    ...row,
    offPatternLabel: offLabel,
    workDaysCount: workIndices.length,
    offDaysCount: offIndices.length,
    shiftBandSpanHours: spanHours,
    minRestHoursObserved: minRestHours,
    violations,
  };
}

/**
 * Generates all valid (o1, oL, o2) 15-min offsets for a shift template under current break constraints.
 */
export function buildValidBreakCandidates(
  shiftDurationMin: number,
  rules: BreakPlacementRules
): { o1: number; oL: number; o2: number; maxWork: number; minGap: number }[] {
  const b1 = rules.firstBreakMin;
  const l = rules.lunchMin;
  const b2 = rules.lastBreakMin;
  const maxW = rules.maxContinuousLoginMin;
  const minGap = rules.minGapBetweenBreaksMin;

  const tryWithEdge = (edge: number) => {
    const out: { o1: number; oL: number; o2: number; maxWork: number; minGap: number }[] = [];
    for (let o1 = edge; o1 <= Math.min(maxW, shiftDurationMin - b1 - l - b2); o1 += 15) {
      const lMinStart = o1 + b1 + minGap;
      const lMaxStart = Math.min(o1 + b1 + maxW, shiftDurationMin - l - b2 - minGap - edge);
      for (let oL = lMinStart; oL <= lMaxStart; oL += 15) {
        const o2Min = oL + l + minGap;
        const o2Max = Math.min(oL + l + maxW, shiftDurationMin - b2 - edge);
        for (let o2 = o2Min; o2 <= o2Max; o2 += 15) {
          const w1 = o1;
          const w2 = oL - (o1 + b1);
          const w3 = o2 - (oL + l);
          const w4 = shiftDurationMin - (o2 + b2);
          const segMax = Math.max(w1, w2, w3, w4);
          if (segMax <= maxW && w2 >= minGap && w3 >= minGap) {
            out.push({ o1, oL, o2, maxWork: segMax, minGap: Math.min(w2, w3) });
          }
        }
      }
    }
    return out;
  };

  for (const edge of [rules.edgeBufferMin, 45, 30, 15, 0]) {
    const candidates = tryWithEdge(edge);
    if (candidates.length > 0) return candidates;
  }
  return [];
}

/**
 * Formats a concrete BreakAssignment from 15-min offsets and validates stretch/gap limits.
 */
export function buildBreakAssignment(
  shift: ShiftTemplate,
  o1: number,
  oL: number,
  o2: number,
  rules: BreakPlacementRules
): BreakAssignment {
  const b1 = rules.firstBreakMin;
  const l = rules.lunchMin;
  const b2 = rules.lastBreakMin;
  const w1 = o1;
  const w2 = oL - (o1 + b1);
  const w3 = o2 - (oL + l);
  const w4 = shift.durationMin - (o2 + b2);
  const maxContinuousWorkMin = Math.max(w1, w2, w3, w4);
  const minInterBreakGapMin = Math.min(w2, w3);
  const isValid =
    o1 >= 0 &&
    w2 >= rules.minGapBetweenBreaksMin &&
    w3 >= rules.minGapBetweenBreaksMin &&
    w4 >= 0 &&
    maxContinuousWorkMin <= rules.maxContinuousLoginMin;

  return {
    firstBreakOffsetMin: o1,
    lunchOffsetMin: oL,
    lastBreakOffsetMin: o2,
    firstBreakLabel: `${formatMinutesHHMM(shift.startMin + o1)}–${formatMinutesHHMM(
      shift.startMin + o1 + b1
    )}`,
    lunchLabel: `${formatMinutesHHMM(shift.startMin + oL)}–${formatMinutesHHMM(
      shift.startMin + oL + l
    )}`,
    lastBreakLabel: `${formatMinutesHHMM(shift.startMin + o2)}–${formatMinutesHHMM(
      shift.startMin + o2 + b2
    )}`,
    maxContinuousWorkMin,
    minInterBreakGapMin,
    isValid,
  };
}

/**
 * Places First 15m + Lunch 30m + Last 15m breaks onto lowest-pressure 15-min slots
 * honoring continuous login <= 3h30m and inter-break gap >= 1h.
 */
export function assignOptimalBreaksForShift(
  shift: ShiftTemplate,
  daySurplus15: number[],
  rules: BreakPlacementRules = DEFAULT_BREAK_RULES,
  nextDaySurplus15?: number[]
): BreakAssignment {
  const candidates = buildValidBreakCandidates(shift.durationMin, rules);
  if (candidates.length === 0) {
    // Graceful fallback split at quartiles if shift > 14h custom
    const o1 = Math.round((shift.durationMin * 0.22) / 15) * 15;
    const oL = Math.round((shift.durationMin * 0.48) / 15) * 15;
    const o2 = Math.round((shift.durationMin * 0.76) / 15) * 15;
    return buildBreakAssignment(shift, o1, oL, o2, rules);
  }

  const slotPenalty = (offsetMin: number, durMin: number): number => {
    const blocks = Math.max(1, Math.round(durMin / 15));
    let pen = 0;
    for (let k = 0; k < blocks; k++) {
      const absMin = shift.startMin + offsetMin + k * 15;
      const wrappedNextDay = absMin >= 1440;
      const q = Math.floor((absMin % 1440) / 15);
      const arr = wrappedNextDay && nextDaySurplus15 ? nextDaySurplus15 : daySurplus15;
      const surplus = arr[q] ?? 0;
      if (surplus <= 0) {
        pen += (1 - surplus) * 120; // Heavy penalty to protect peak/understaffed arrival slots
      } else {
        pen -= Math.min(surplus, 12) * 10; // Reward high-surplus quiet slots
      }
    }
    return pen;
  };

  let best = candidates[0];
  let bestScore = Infinity;

  const ideal1 = shift.durationMin * 0.25;
  const idealL = shift.durationMin * 0.5;
  const ideal2 = shift.durationMin * 0.78;

  for (const c of candidates) {
    const p1 = slotPenalty(c.o1, rules.firstBreakMin);
    const pL = slotPenalty(c.oL, rules.lunchMin);
    const p2 = slotPenalty(c.o2, rules.lastBreakMin);
    const balanceTieBreaker =
      (Math.abs(c.o1 - ideal1) + Math.abs(c.oL - idealL) + Math.abs(c.o2 - ideal2)) * 0.02;
    const score = p1 + pL + p2 + balanceTieBreaker;
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }

  return buildBreakAssignment(shift, best.o1, best.oL, best.o2, rules);
}

interface DayDemandProfile {
  dayKey: DayKey;
  dateIso: string;
  forecastVolume: number;
  requiredBySlot: number[];
  volumeBySlot: number[];
  required15: number[];
  requiredProdHours: number;
}

function buildWeeklyDemandProfiles(params: {
  nextWeekDays: ForecastDayItem[];
  dayCurves: Record<DayKey, number[]>;
  erlangConfig: ErlangConfig;
}): Record<DayKey, DayDemandProfile> {
  const { nextWeekDays, dayCurves, erlangConfig } = params;
  const g = erlangConfig.granularityMin;
  const slotsPerDay = Math.round(1440 / g);
  const qPerSlot = Math.max(1, Math.round(g / 15));

  const fallbackDayVol = nextWeekDays[0]?.volume ?? erlangConfig.dailyVolume;
  const mapByDay = new Map(nextWeekDays.map((d) => [d.dayKey, d]));

  const profiles = {} as Record<DayKey, DayDemandProfile>;
  for (const dk of WEEK_DAYS) {
    const forecastItem = mapByDay.get(dk);
    const volume = Math.max(0, Math.round(forecastItem?.volume ?? fallbackDayVol));
    const dateIso = forecastItem?.dateIso ?? dk;
    const curve30 = dayCurves[dk] ?? DEFAULT_30M_CURVES[dk] ?? DEFAULT_30M_CURVES.Mon;
    const intervalInputs = buildIntervalInputsForGranularity(curve30, g);

    const daySummary = runErlangPlanner(intervalInputs, {
      ...erlangConfig,
      dailyVolume: volume,
      selectedDay: dk,
      selectedDateIso: dateIso,
    });

    const requiredBySlot = daySummary.rows.map((r) => r.requiredSeats);
    const volumeBySlot = daySummary.rows.map((r) => r.volume);
    const required15 = new Array<number>(96).fill(0);
    for (let s = 0; s < slotsPerDay; s++) {
      const reqVal = requiredBySlot[s] ?? 0;
      for (let q = 0; q < qPerSlot; q++) {
        const qIdx = s * qPerSlot + q;
        if (qIdx < 96) required15[qIdx] = reqVal;
      }
    }

    profiles[dk] = {
      dayKey: dk,
      dateIso,
      forecastVolume: volume,
      requiredBySlot,
      volumeBySlot,
      required15,
      requiredProdHours: daySummary.totalProductiveHours,
    };
  }
  return profiles;
}

function getShiftSlotsForDay(
  shift: ShiftTemplate,
  dayIdx: number
): { dayIdx: number; qIdx: number }[] {
  const steps = Math.max(1, Math.round(shift.durationMin / 15));
  const startQ = Math.floor(shift.startMin / 15);
  const out: { dayIdx: number; qIdx: number }[] = [];
  for (let k = 0; k < steps; k++) {
    const totalQ = startQ + k;
    const dOff = Math.floor(totalQ / 96);
    const qIdx = totalQ % 96;
    out.push({ dayIdx: (dayIdx + dOff) % 7, qIdx });
  }
  return out;
}

function applyBreaksToArray15(
  target15ByDay: number[][],
  shift: ShiftTemplate,
  dayIdx: number,
  breaks: BreakAssignment,
  rules: BreakPlacementRules,
  sign: 1 | -1
): void {
  const blocks = [
    { off: breaks.firstBreakOffsetMin, dur: rules.firstBreakMin },
    { off: breaks.lunchOffsetMin, dur: rules.lunchMin },
    { off: breaks.lastBreakOffsetMin, dur: rules.lastBreakMin },
  ];
  for (const blk of blocks) {
    const steps = Math.max(1, Math.round(blk.dur / 15));
    for (let k = 0; k < steps; k++) {
      const absMin = shift.startMin + blk.off + k * 15;
      const targetDay = (dayIdx + Math.floor(absMin / 1440)) % 7;
      const qIdx = Math.floor((absMin % 1440) / 15);
      target15ByDay[targetDay][qIdx] += sign;
    }
  }
}

/**
 * Recomputes per-agent constraint audits, 15m/30m/60m coverage matrices, break deductions,
 * SLA projections, and KPI summary totals from the current editable roster state.
 */
export function recalculateScheduleCoverage(params: {
  agents: ScheduledAgentRow[];
  shiftCatalog: ShiftTemplate[];
  rules: SchedulingRules;
  nextWeekDays: ForecastDayItem[];
  dayCurves: Record<DayKey, number[]>;
  erlangConfig: ErlangConfig;
}): ScheduleGenerationResult {
  const { agents, shiftCatalog, rules, nextWeekDays, dayCurves, erlangConfig } = params;
  const shiftMap = new Map(shiftCatalog.map((s) => [s.id, s]));
  const profiles = buildWeeklyDemandProfiles({ nextWeekDays, dayCurves, erlangConfig });

  const g = erlangConfig.granularityMin;
  const slotsPerDay = Math.round(1440 / g);
  const qPerSlot = Math.max(1, Math.round(g / 15));
  const timeLabels = generateTimeLabels(g);
  const intervalSec = g * 60;

  // Initialize 7 x 96 quarter-hour matrices for exact break subtraction
  const gross15: number[][] = Array.from({ length: 7 }, () => new Array(96).fill(0));
  const break15: number[][] = Array.from({ length: 7 }, () => new Array(96).fill(0));

  const auditedAgents = agents.map((a) => validateAgentScheduleRow(a, shiftCatalog, rules));
  const sortedCatalog = sortShiftCatalogChronologically(shiftCatalog);

  let totalWorkShifts = 0;
  let validBreaksCount = 0;

  // Track Per-Shift x Per-Day scheduled counts and distinct agent primary-shift pools
  const shiftDayCounts = new Map<string, Record<DayKey, number>>();
  const primaryPoolCountByShift = new Map<string, number>();
  const ensureShiftTrack = (shId: string) => {
    if (!shiftDayCounts.has(shId)) {
      shiftDayCounts.set(shId, { Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0, Sun: 0 });
    }
  };
  for (const sh of sortedCatalog) ensureShiftTrack(sh.id);

  for (const agent of auditedAgents) {
    const freqThisAgent = new Map<string, number>();
    for (let dIdx = 0; dIdx < 7; dIdx++) {
      const dk = WEEK_DAYS[dIdx];
      const assign = agent.assignments[dk];
      if (!assign || assign.status !== 'WORK' || !assign.shiftId) continue;
      const shift = shiftMap.get(assign.shiftId);
      if (!shift) continue;
      totalWorkShifts++;
      ensureShiftTrack(shift.id);
      shiftDayCounts.get(shift.id)![dk] += 1;
      freqThisAgent.set(shift.id, (freqThisAgent.get(shift.id) ?? 0) + 1);

      const covered = getShiftSlotsForDay(shift, dIdx);
      for (const pos of covered) {
        gross15[pos.dayIdx][pos.qIdx] += 1;
      }
      if (assign.breaks) {
        if (assign.breaks.isValid) validBreaksCount++;
        applyBreaksToArray15(break15, shift, dIdx, assign.breaks, rules.breakRules, 1);
      }
    }
    if (freqThisAgent.size > 0) {
      let bestPrimary = [...freqThisAgent.entries()][0][0];
      let bestFreq = -1;
      for (const [shId, cnt] of freqThisAgent.entries()) {
        if (cnt > bestFreq) {
          bestFreq = cnt;
          bestPrimary = shId;
        }
      }
      primaryPoolCountByShift.set(bestPrimary, (primaryPoolCountByShift.get(bestPrimary) ?? 0) + 1);
    }
  }

  const coverageByDay = {} as Record<DayKey, IntervalCoverageCell[]>;
  const dailyTotals: DailyCoverageSummary[] = [];
  let understaffedIntervalsTotal = 0;
  let overstaffedIntervalsTotal = 0;
  let totalReqProdHours = 0;
  let totalSchedGrossHours = 0;
  let totalSchedNetHours = 0;
  let totalCallVolWeek = 0;
  let totalSlWeightedWeek = 0;

  for (let dIdx = 0; dIdx < 7; dIdx++) {
    const dk = WEEK_DAYS[dIdx];
    const prof = profiles[dk];
    const cells: IntervalCoverageCell[] = [];

    let dayGrossHrs = 0;
    let dayNetHrs = 0;
    let peakReq = 0;
    let peakNet = 0;
    let dayUnder = 0;
    let daySlWeighted = 0;

    for (let s = 0; s < slotsPerDay; s++) {
      let sumGross = 0;
      let sumBreak = 0;
      for (let q = 0; q < qPerSlot; q++) {
        const qIdx = s * qPerSlot + q;
        sumGross += gross15[dIdx][qIdx];
        sumBreak += break15[dIdx][qIdx];
      }
      const scheduledGrossHeads = Number((sumGross / qPerSlot).toFixed(2));
      const onBreakFte = Number((sumBreak / qPerSlot).toFixed(2));
      const effectiveScheduledFte = Number(Math.max(0, scheduledGrossHeads - onBreakFte).toFixed(2));
      const requiredSeats = prof.requiredBySlot[s] ?? 0;
      const forecastVolume = prof.volumeBySlot[s] ?? 0;
      const varianceFte = Number((effectiveScheduledFte - requiredSeats).toFixed(2));

      // Continuous SLA estimate interpolating fractional break impact cleanly
      const floorN = Math.floor(effectiveScheduledFte);
      const frac = effectiveScheduledFte - floorN;
      let projectedSlPct = 100;
      if (forecastVolume > 0) {
        const slFloor = computeErlangCMetrics(
          floorN,
          forecastVolume,
          erlangConfig.globalAhtSec,
          intervalSec,
          erlangConfig.slThresholdSec
        ).slPct;
        if (frac > 0.01) {
          const slCeil = computeErlangCMetrics(
            floorN + 1,
            forecastVolume,
            erlangConfig.globalAhtSec,
            intervalSec,
            erlangConfig.slThresholdSec
          ).slPct;
          projectedSlPct = Number((slFloor + frac * (slCeil - slFloor)).toFixed(1));
        } else {
          projectedSlPct = Number(slFloor.toFixed(1));
        }
      }

      if (requiredSeats > 0 && effectiveScheduledFte + 0.25 < requiredSeats) {
        dayUnder++;
        understaffedIntervalsTotal++;
      } else if (effectiveScheduledFte > requiredSeats + 1.5) {
        overstaffedIntervalsTotal++;
      }

      peakReq = Math.max(peakReq, requiredSeats);
      peakNet = Math.max(peakNet, effectiveScheduledFte);
      dayGrossHrs += scheduledGrossHeads * (g / 60);
      dayNetHrs += effectiveScheduledFte * (g / 60);
      daySlWeighted += projectedSlPct * forecastVolume;

      cells.push({
        dayKey: dk,
        dateIso: prof.dateIso,
        slotIndex: s,
        timeLabel: timeLabels[s],
        forecastVolume,
        requiredSeats,
        scheduledGrossHeads,
        onBreakFte,
        effectiveScheduledFte,
        varianceFte,
        projectedSlPct,
      });
    }

    coverageByDay[dk] = cells;
    totalReqProdHours += prof.requiredProdHours;
    totalSchedGrossHours += dayGrossHrs;
    totalSchedNetHours += dayNetHrs;
    totalCallVolWeek += prof.forecastVolume;
    totalSlWeightedWeek += daySlWeighted;

    const covPct =
      prof.requiredProdHours > 0 ? Math.min(250, (dayNetHrs / prof.requiredProdHours) * 100) : 100;

    dailyTotals.push({
      dayKey: dk,
      dateIso: prof.dateIso,
      forecastVolume: prof.forecastVolume,
      requiredProdHours: Number(prof.requiredProdHours.toFixed(2)),
      scheduledGrossHours: Number(dayGrossHrs.toFixed(2)),
      scheduledNetHours: Number(dayNetHrs.toFixed(2)),
      coveragePct: Number(covPct.toFixed(1)),
      peakRequired: Number(peakReq.toFixed(1)),
      peakScheduledNet: Number(peakNet.toFixed(1)),
      understaffedIntervals: dayUnder,
      avgProjectedSlPct:
        prof.forecastVolume > 0 ? Number((daySlWeighted / prof.forecastVolume).toFixed(1)) : 100,
    });
  }

  const annualExcluded = auditedAgents.filter((a) => a.preAllocatedException === 'AL').length;
  const fullWeekExceptionsCount = auditedAgents.filter(
    (a) => a.preAllocatedException !== null && a.preAllocatedException !== 'AL'
  ).length;
  const activeSchedulableCount = auditedAgents.filter((a) => !a.preAllocatedException).length;

  const visibleOutputAgents =
    rules.annualVisibilityInOutput === 'exclude'
      ? auditedAgents.filter((a) => a.preAllocatedException !== 'AL')
      : auditedAgents;

  const avgCoveragePct =
    totalReqProdHours > 0 ? Number(((totalSchedNetHours / totalReqProdHours) * 100).toFixed(1)) : 100;

  const overrides = rules.shiftHeadcountOverrides ?? {};
  const shiftDailyMix: ShiftDailyMixRow[] = sortedCatalog
    .filter((sh) => {
      const counts = shiftDayCounts.get(sh.id);
      const totalForSh = counts ? WEEK_DAYS.reduce((s, dk) => s + counts[dk], 0) : 0;
      const hasOv = overrides[sh.id] !== undefined && overrides[sh.id] !== null;
      return sh.enabled || totalForSh > 0 || hasOv;
    })
    .map((sh) => {
      const byDay = shiftDayCounts.get(sh.id) ?? {
        Mon: 0,
        Tue: 0,
        Wed: 0,
        Thu: 0,
        Fri: 0,
        Sat: 0,
        Sun: 0,
      };
      const totalWeeklyShifts = WEEK_DAYS.reduce((s, dk) => s + byDay[dk], 0);
      const ovVal = overrides[sh.id];
      return {
        shiftId: sh.id,
        shiftLabel: sh.label,
        wrapsMidnight: sh.wrapsMidnight,
        durationHours: Number((sh.durationMin / 60).toFixed(1)),
        targetOverride:
          ovVal !== undefined && ovVal !== null && Number.isFinite(ovVal)
            ? Math.max(0, Math.round(ovVal))
            : null,
        assignedPoolCount: primaryPoolCountByShift.get(sh.id) ?? 0,
        avgPerDay: Number((totalWeeklyShifts / 7).toFixed(1)),
        byDay,
        totalWeeklyShifts,
        shareOfShiftsPct:
          totalWorkShifts > 0 ? Number(((totalWeeklyShifts / totalWorkShifts) * 100).toFixed(1)) : 0,
      };
    });

  return {
    agents: auditedAgents,
    visibleOutputAgents,
    coverageByDay,
    dailyTotals,
    shiftDailyMix,
    summary: {
      totalRosterInput: auditedAgents.length,
      annualExcluded,
      fullWeekExceptionsCount,
      activeSchedulableCount,
      totalWorkShifts,
      totalRequiredProdHours: Number(totalReqProdHours.toFixed(1)),
      totalScheduledNetHours: Number(totalSchedNetHours.toFixed(1)),
      avgCoveragePct,
      understaffedIntervalsTotal,
      overstaffedIntervalsTotal,
      projectedWeeklySlPct:
        totalCallVolWeek > 0 ? Number((totalSlWeightedWeek / totalCallVolWeek).toFixed(1)) : 100,
      violationAgentsCount: visibleOutputAgents.filter((a) => a.violations.length > 0).length,
      validBreakRatePct:
        totalWorkShifts > 0 ? Number(((validBreaksCount / totalWorkShifts) * 100).toFixed(1)) : 100,
    },
  };
}

/**
 * Generates an optimal weekly WFM shift & staggered 15m break schedule honoring:
 * - Max 5 workdays/week + 2 OFF days (consecutive or Sun+Mon split edge wrap)
 * - Input-only leave exclusions (AL, MAT, RES, TERM, UPL, PAT) locked full week
 * - Max weekly start-time band drift (e.g. <= 2h) & min inter-shift rest (>= 12h)
 * - Forecast + Arrival Pattern deficit-driven shift selection & 1-opt swap optimization
 * - 15m + 30m Lunch + 15m staggered break placement with <=3h30m stretch & >=1h gap
 */
export function generateWeeklySchedule(params: {
  inputMode: RosterInputMode;
  headcountInput: number;
  namedAgents: RosterAgentInput[];
  leaveCounts: LeaveCounts;
  shiftCatalog: ShiftTemplate[];
  rules: SchedulingRules;
  nextWeekDays: ForecastDayItem[];
  dayCurves: Record<DayKey, number[]>;
  erlangConfig: ErlangConfig;
}): ScheduleGenerationResult {
  const {
    inputMode,
    headcountInput,
    namedAgents,
    leaveCounts,
    shiftCatalog,
    rules,
    nextWeekDays,
    dayCurves,
    erlangConfig,
  } = params;

  const activeCatalog = shiftCatalog.filter((s) => s.enabled);
  const catalogToUse = sortShiftCatalogChronologically(
    activeCatalog.length > 0 ? activeCatalog : DEFAULT_SHIFT_CATALOG
  );
  const shiftMap = new Map(catalogToUse.map((s) => [s.id, s]));
  const overrides = rules.shiftHeadcountOverrides ?? {};

  // 1. Build base agent list from mode
  const rawRoster: { id: string; name: string; source: 'manual_count' | 'uploaded_name'; lockedException: ExceptionCode | null }[] = [];
  if (inputMode === 'named' && namedAgents.length > 0) {
    for (let i = 0; i < namedAgents.length; i++) {
      rawRoster.push({
        id: namedAgents[i].id || `agent-${i + 1}`,
        name: namedAgents[i].name.trim() || `Agent ${i + 1}`,
        source: 'uploaded_name',
        lockedException: namedAgents[i].lockedException ?? null,
      });
    }
  } else {
    const count = Math.max(0, Math.min(500, Math.round(headcountInput)));
    for (let i = 0; i < count; i++) {
      rawRoster.push({
        id: `agent-${i + 1}`,
        name: `Agent ${i + 1}`,
        source: 'manual_count',
        lockedException: null,
      });
    }
  }

  // 2. Apply input exception quotas (preserving pre-tagged exceptions first)
  const desiredCounts: Record<ExceptionCode, number> = {
    AL: Math.max(0, Math.round(leaveCounts.annual)),
    MAT: Math.max(0, Math.round(leaveCounts.maternity)),
    RES: Math.max(0, Math.round(leaveCounts.resignations)),
    TERM: Math.max(0, Math.round(leaveCounts.termination)),
    UPL: Math.max(0, Math.round(leaveCounts.upl)),
    PAT: Math.max(0, Math.round(leaveCounts.paternity)),
  };

  const preTaggedCounts: Record<ExceptionCode, number> = {
    AL: 0,
    MAT: 0,
    RES: 0,
    TERM: 0,
    UPL: 0,
    PAT: 0,
  };
  for (const a of rawRoster) {
    if (a.lockedException) preTaggedCounts[a.lockedException]++;
  }

  const extraNeededQueue: ExceptionCode[] = [];
  const order: ExceptionCode[] = ['MAT', 'RES', 'TERM', 'UPL', 'PAT', 'AL'];
  for (const code of order) {
    const extra = Math.max(0, desiredCounts[code] - preTaggedCounts[code]);
    for (let k = 0; k < extra; k++) extraNeededQueue.push(code);
  }

  // Assign remaining exception codes cleanly from the end of untagged roster slots
  let queueCursor = 0;
  for (let i = rawRoster.length - 1; i >= 0 && queueCursor < extraNeededQueue.length; i--) {
    if (!rawRoster[i].lockedException) {
      rawRoster[i].lockedException = extraNeededQueue[queueCursor++];
    }
  }

  // Build initial rows & compute demand profiles
  const profiles = buildWeeklyDemandProfiles({ nextWeekDays, dayCurves, erlangConfig });
  const req15 = WEEK_DAYS.map((dk) => [...profiles[dk].required15]);
  const gross15: number[][] = Array.from({ length: 7 }, () => new Array(96).fill(0));

  const avgNetShiftHrs =
    catalogToUse.reduce((s, sh) => s + Math.max(1, (sh.durationMin - 60) / 60), 0) /
    catalogToUse.length;

  // 3. Distribute active schedulable agents across OFF pairs matching daily demand shape
  const offPatterns = getValidOffPairSet(rules.allowSunMonSplitOff);
  const activeIndices = rawRoster
    .map((r, idx) => (r.lockedException ? -1 : idx))
    .filter((idx) => idx >= 0);

  const dayWorkCount = new Array<number>(7).fill(0);
  const offPairByRosterIdx = new Map<number, [number, number]>();

  // Assign OFF patterns iteratively to reduce the largest remaining daily hour deficit
  for (let step = 0; step < activeIndices.length; step++) {
    const rosterIdx = activeIndices[step];
    let bestPair = offPatterns[0];
    let bestPatternScore = -Infinity;

    for (const pair of offPatterns) {
      let gainScore = 0;
      for (let d = 0; d < 7; d++) {
        if (d === pair[0] || d === pair[1]) continue;
        const reqH = profiles[WEEK_DAYS[d]].requiredProdHours;
        const coveredH = dayWorkCount[d] * avgNetShiftHrs;
        const deficit = reqH - coveredH;
        // Strongly reward covering under-covered days, with gentle floor so light days aren't starved
        gainScore += deficit > 0 ? deficit * 2.5 : deficit * 0.25;
        if (dayWorkCount[d] === 0 && reqH > 0) gainScore += 100;
      }
      if (gainScore > bestPatternScore) {
        bestPatternScore = gainScore;
        bestPair = pair;
      }
    }

    offPairByRosterIdx.set(rosterIdx, bestPair);
    for (let d = 0; d < 7; d++) {
      if (d !== bestPair[0] && d !== bestPair[1]) dayWorkCount[d]++;
    }
  }

  // Construct scaffolded rows (non-workdays already locked)
  const draftRows: ScheduledAgentRow[] = rawRoster.map((r, idx) => {
    const assignments = {} as Record<DayKey, AgentDayAssignment>;
    if (r.lockedException) {
      for (const dk of WEEK_DAYS) {
        assignments[dk] = { dayKey: dk, status: r.lockedException, shiftId: null, breaks: null };
      }
      return {
        agentId: r.id,
        agentName: r.name,
        source: r.source,
        preAllocatedException: r.lockedException,
        offPatternLabel: `${r.lockedException} (Full Week)`,
        assignments,
        workDaysCount: 0,
        offDaysCount: 0,
        shiftBandSpanHours: 0,
        minRestHoursObserved: null,
        violations: [],
      };
    }

    const pair = offPairByRosterIdx.get(idx) ?? [5, 6];
    for (let d = 0; d < 7; d++) {
      const dk = WEEK_DAYS[d];
      const isOff = d === pair[0] || d === pair[1];
      assignments[dk] = {
        dayKey: dk,
        status: isOff ? 'OFF' : 'WORK',
        shiftId: null,
        breaks: null,
      };
    }
    return {
      agentId: r.id,
      agentName: r.name,
      source: r.source,
      preAllocatedException: null,
      offPatternLabel: '',
      assignments,
      workDaysCount: 0,
      offDaysCount: 2,
      shiftBandSpanHours: 0,
      minRestHoursObserved: null,
      violations: [],
    };
  });

  // Helper: check whether candidateShift on day dIdx keeps circular drift & inter-shift rest valid
  const isCandidateShiftFeasible = (
    row: ScheduledAgentRow,
    dayIdx: number,
    candidate: ShiftTemplate
  ): boolean => {
    const starts: number[] = [candidate.startMin];
    for (let d = 0; d < 7; d++) {
      if (d === dayIdx) continue;
      const a = row.assignments[WEEK_DAYS[d]];
      if (a.status === 'WORK' && a.shiftId) {
        const s = shiftMap.get(a.shiftId);
        if (s) starts.push(s.startMin);
      }
    }
    if (computeCircularStartSpanHours(starts) > rules.maxWeeklyStartDriftHours + 1e-6) {
      return false;
    }

    // Temporarily evaluate rest check around adjacent work days (including Sun->Mon wrap)
    const testAssignments = {
      ...row.assignments,
      [WEEK_DAYS[dayIdx]]: { dayKey: WEEK_DAYS[dayIdx], status: 'WORK' as LeaveAllocationCode, shiftId: candidate.id, breaks: null },
    };
    const minRest = getMinimumWeeklyRestHours(testAssignments, shiftMap);
    if (minRest !== null && minRest < rules.minInterShiftRestHours - 1e-6) {
      return false;
    }
    return true;
  };

  // Marginal WFM Shift Scoring: rewards unfilled Erlang demand & heavily penalizes quiet/overnight idle excess
  const scoreShiftDelta = (candidate: ShiftTemplate, dayIdx: number): number => {
    const slots = getShiftSlotsForDay(candidate, dayIdx);
    const netWeight = Math.max(0.75, (candidate.durationMin - 60) / candidate.durationMin);
    let score = 0;
    for (const pos of slots) {
      const req = req15[pos.dayIdx][pos.qIdx];
      const currGross = gross15[pos.dayIdx][pos.qIdx];
      // For ultra-low-volume overnight intervals (req <= 2), 1 agent absorbs minor call volume without doubling staff for break fractions
      const targetGross = req <= 2 ? req : req / netWeight;
      if (currGross < targetGross) {
        const fill = Math.min(1, targetGross - currGross);
        const shortageUrgency = (targetGross - currGross) / Math.max(1, targetGross);
        score += fill * (14 + 6 * Math.min(1, shortageUrgency));
      } else {
        const excessBefore = currGross - targetGross;
        // Scale waste penalty inversely by slot demand so overnight 1-seat intervals never hoard idle heads
        const ratioWaste = (excessBefore + 1) / Math.max(0.8, targetGross);
        const quietExtra = req <= 2 ? 5.2 + 3.0 * excessBefore : 1.35;
        score -= quietExtra + ratioWaste * (req <= 2 ? 4.5 : 1.6);
      }
    }
    return score;
  };

  // 4A. Honor Explicit Per-Shift Manual Pool Overrides First (e.g. pin "22:00-07:00": 2 Agents)
  const pinnedRosterIndices = new Set<number>();
  const autoAllowedShifts = catalogToUse.filter((sh) => {
    const ov = overrides[sh.id];
    return ov === undefined || ov === null;
  });

  // Order remaining agents for pinning cleanly across distributed OFF pairs so pinned shifts span Mon..Sun evenly
  let pinCursor = 0;
  for (const sh of catalogToUse) {
    const rawOv = overrides[sh.id];
    if (rawOv === undefined || rawOv === null) continue;
    const pinTarget = Math.max(0, Math.round(rawOv));
    let assignedHere = 0;
    while (assignedHere < pinTarget && pinCursor < activeIndices.length) {
      const rosterIdx = activeIndices[pinCursor++];
      pinnedRosterIndices.add(rosterIdx);
      const row = draftRows[rosterIdx];
      for (let dIdx = 0; dIdx < 7; dIdx++) {
        const dk = WEEK_DAYS[dIdx];
        if (row.assignments[dk].status !== 'WORK') continue;
        row.assignments[dk].shiftId = sh.id;
        for (const pos of getShiftSlotsForDay(sh, dIdx)) {
          gross15[pos.dayIdx][pos.qIdx] += 1;
        }
      }
      assignedHere++;
    }
  }

  // Fallback shift pool for auto agents: prefer unpinned active shifts; if user pinned every shift below headcount, spread overflow across non-zero shifts
  const nonZeroCatalog = catalogToUse.filter((sh) => overrides[sh.id] !== 0);
  const autoCandidates =
    autoAllowedShifts.length > 0
      ? autoAllowedShifts
      : nonZeroCatalog.length > 0
        ? nonZeroCatalog
        : catalogToUse;

  // 4B. Demand-Proportional Greedy Water-Filling across Unpinned Active Agents
  const sortedDayIndices = [0, 1, 2, 3, 4, 5, 6].sort(
    (a, b) => profiles[WEEK_DAYS[b]].forecastVolume - profiles[WEEK_DAYS[a]].forecastVolume
  );

  for (const rosterIdx of activeIndices) {
    if (pinnedRosterIndices.has(rosterIdx)) continue;
    const row = draftRows[rosterIdx];
    for (const dIdx of sortedDayIndices) {
      const dk = WEEK_DAYS[dIdx];
      if (row.assignments[dk].status !== 'WORK') continue;

      let bestShift = autoCandidates[0];
      let bestScore = -Infinity;
      for (const candidate of autoCandidates) {
        if (!isCandidateShiftFeasible(row, dIdx, candidate)) continue;
        const sc = scoreShiftDelta(candidate, dIdx);
        if (sc > bestScore) {
          bestScore = sc;
          bestShift = candidate;
        }
      }

      row.assignments[dk].shiftId = bestShift.id;
      for (const pos of getShiftSlotsForDay(bestShift, dIdx)) {
        gross15[pos.dayIdx][pos.qIdx] += 1;
      }
    }
  }

  // 5. Local Optimization Swap Pass (2 sweeps: proportional deficit/waste balance, preserving manual shift pins)
  const objectiveError = () => {
    let err = 0;
    for (let d = 0; d < 7; d++) {
      for (let q = 0; q < 96; q++) {
        const req = req15[d][q];
        const targetG = req <= 2 ? req : req / 0.889;
        const diff = targetG - gross15[d][q];
        if (diff > 0) {
          err += diff * diff * 5.0;
        } else {
          const ex = -diff;
          err += ex * (1.2 + 5.2 / Math.max(0.8, req)) + ex * ex * (req <= 2 ? 3.5 : 0.18);
        }
      }
    }
    return err;
  };

  for (let pass = 0; pass < 2; pass++) {
    let improved = false;
    for (const rosterIdx of activeIndices) {
      if (pinnedRosterIndices.has(rosterIdx)) continue;
      const row = draftRows[rosterIdx];
      for (let dIdx = 0; dIdx < 7; dIdx++) {
        const dk = WEEK_DAYS[dIdx];
        const currShiftId = row.assignments[dk].shiftId;
        if (row.assignments[dk].status !== 'WORK' || !currShiftId) continue;
        const currShift = shiftMap.get(currShiftId);
        if (!currShift) continue;

        let bestShift = currShift;
        let bestErr = objectiveError();

        for (const pos of getShiftSlotsForDay(currShift, dIdx)) gross15[pos.dayIdx][pos.qIdx] -= 1;

        for (const cand of autoCandidates) {
          if (cand.id === currShift.id) continue;
          if (!isCandidateShiftFeasible(row, dIdx, cand)) continue;
          for (const pos of getShiftSlotsForDay(cand, dIdx)) gross15[pos.dayIdx][pos.qIdx] += 1;
          const e = objectiveError();
          for (const pos of getShiftSlotsForDay(cand, dIdx)) gross15[pos.dayIdx][pos.qIdx] -= 1;
          if (e < bestErr - 0.01) {
            bestErr = e;
            bestShift = cand;
            improved = true;
          }
        }

        row.assignments[dk].shiftId = bestShift.id;
        for (const pos of getShiftSlotsForDay(bestShift, dIdx)) gross15[pos.dayIdx][pos.qIdx] += 1;
      }
    }
    if (!improved) break;
  }

  // 6. Assign Staggered 15-Min Breaks (First 15 + Lunch 30 + Last 15) Updating Surplus Live
  const liveSurplus15: number[][] = Array.from({ length: 7 }, (_, d) =>
    Array.from({ length: 96 }, (__, q) => gross15[d][q] - req15[d][q])
  );

  for (let dIdx = 0; dIdx < 7; dIdx++) {
    const dk = WEEK_DAYS[dIdx];
    const nextSurplus = liveSurplus15[(dIdx + 1) % 7];
    // Sort agents so same-shift agents stagger cleanly one after another
    const workingToday = activeIndices.filter((rIdx) => draftRows[rIdx].assignments[dk].status === 'WORK');
    for (const rosterIdx of workingToday) {
      const assign = draftRows[rosterIdx].assignments[dk];
      const shift = assign.shiftId ? shiftMap.get(assign.shiftId) : null;
      if (!shift) continue;
      const breaks = assignOptimalBreaksForShift(
        shift,
        liveSurplus15[dIdx],
        rules.breakRules,
        nextSurplus
      );
      assign.breaks = breaks;
      applyBreaksToArray15(liveSurplus15, shift, dIdx, breaks, rules.breakRules, -1);
    }
  }

  return recalculateScheduleCoverage({
    agents: draftRows,
    shiftCatalog: catalogToUse,
    rules,
    nextWeekDays,
    dayCurves,
    erlangConfig,
  });
}
