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
import {
  computeErlangAMetrics,
  computeErlangCMetrics,
  generateTimeLabels,
  runErlangPlanner,
} from './erlang.ts';
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
  shiftDayHeadcountOverrides: {},
  breakRules: { ...DEFAULT_BREAK_RULES },
};

/**
 * Sorts shift templates chronologically across the 24-hour operational day (00:00 -> 23:45).
 */
export function sortShiftCatalogChronologically(shifts: ShiftTemplate[]): ShiftTemplate[] {
  return [...shifts].sort((a, b) => a.startMin - b.startMin || a.durationMin - b.durationMin);
}

/**
 * Identifies overnight / graveyard shift windows (wrapping past midnight or starting between 22:00 and 05:59).
 * Used to keep unpinned surplus heads out of overnight shifts when daytime shifts exist.
 */
export function isOvernightShiftWindow(shift: ShiftTemplate): boolean {
  return shift.wrapsMidnight || shift.startMin < 360 || shift.startMin >= 1320;
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

function computeConnectedCatalogComponentIds(
  shiftCatalog: ShiftTemplate[],
  maxDriftHours: number
): Map<string, number> {
  const enabled = shiftCatalog.filter((s) => s.enabled);
  const pool = enabled.length > 0 ? enabled : shiftCatalog;
  const thresholdMin = Math.max(Math.round(maxDriftHours * 60), 180);
  const compMap = new Map<string, number>();
  let compId = 0;
  for (const s of pool) {
    if (compMap.has(s.id)) continue;
    const queue = [s];
    compMap.set(s.id, compId);
    while (queue.length > 0) {
      const curr = queue.shift()!;
      for (const nxt of pool) {
        if (compMap.has(nxt.id)) continue;
        const diffMin = Math.abs(curr.startMin - nxt.startMin);
        const circMin = Math.min(diffMin, 1440 - diffMin);
        if (circMin <= thresholdMin + 1e-6) {
          compMap.set(nxt.id, compId);
          queue.push(nxt);
        }
      }
    }
    compId++;
  }
  return compMap;
}

/**
 * Evaluates weekly start-band drift per connected catalog component when an agent combines
 * an isolated overnight shift (e.g. 00:00–09:00 with no neighbor <= maxDriftHours) with
 * daytime shifts separated by safe extended recovery rest (>= max(18h, minInterShiftRestHours)).
 * All non-overnight daytime jumps remain strictly penalized on full circular span.
 */
export function computeEffectiveBandSpanHours(
  workShifts: ShiftTemplate[],
  minRestHours: number | null,
  shiftCatalog: ShiftTemplate[],
  rules: SchedulingRules,
  precomputedCompMap?: Map<string, number>
): number {
  const rawSpan = computeCircularStartSpanHours(workShifts.map((s) => s.startMin));
  if (workShifts.length <= 1 || rawSpan <= rules.maxWeeklyStartDriftHours + 1e-6) {
    return rawSpan;
  }

  const compMap =
    precomputedCompMap ?? computeConnectedCatalogComponentIds(shiftCatalog, rules.maxWeeklyStartDriftHours);
  const byComp = new Map<number, ShiftTemplate[]>();
  for (const sh of workShifts) {
    const cid = compMap.get(sh.id) ?? -1;
    let list = byComp.get(cid);
    if (!list) {
      list = [];
      byComp.set(cid, list);
    }
    list.push(sh);
  }
  if (byComp.size <= 1) return rawSpan;

  const minReliefRest = rules.minInterShiftRestHours;
  if (minRestHours !== null && minRestHours < minReliefRest - 1e-6) {
    return rawSpan;
  }

  const groups = [...byComp.values()];
  const isolatedOvernightComps = groups.filter((group) => group.every((s) => isOvernightShiftWindow(s)));
  const regularComps = groups.filter((group) => !group.every((s) => isOvernightShiftWindow(s)));
  if (isolatedOvernightComps.length === 0 || regularComps.length > 1) {
    return rawSpan;
  }

  let maxIntraSpan = 0;
  for (const group of groups) {
    maxIntraSpan = Math.max(
      maxIntraSpan,
      computeCircularStartSpanHours(group.map((s) => s.startMin))
    );
  }
  return maxIntraSpan;
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
  const workedShifts: ShiftTemplate[] = [];
  const weekExceptions = new Set<ExceptionCode>();

  for (let i = 0; i < 7; i++) {
    const st = statuses[i];
    const assign = row.assignments[WEEK_DAYS[i]];
    if (st === 'WORK') {
      workIndices.push(i);
      const shift = assign?.shiftId ? shiftMap.get(assign.shiftId) : null;
      if (shift) workedShifts.push(shift);
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
  const minRestHours = getMinimumWeeklyRestHours(row.assignments, shiftMap);
  const spanHours = computeEffectiveBandSpanHours(workedShifts, minRestHours, shiftCatalog, rules);

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
 * honoring continuous login <= 3h30m, inter-break gap >= 1h, and quadratic break-concurrency smoothing.
 */
export function assignOptimalBreaksForShift(
  shift: ShiftTemplate,
  daySurplus15: number[],
  rules: BreakPlacementRules = DEFAULT_BREAK_RULES,
  nextDaySurplus15?: number[],
  breakLoad15?: number[],
  nextDayBreakLoad15?: number[]
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
      const loadArr = wrappedNextDay && nextDayBreakLoad15 ? nextDayBreakLoad15 : breakLoad15;
      const surplus = arr[q] ?? 0;
      const concurrentBreaks = loadArr?.[q] ?? 0;
      if (surplus <= 0) {
        pen += (1 - surplus) * 135; // Heavy penalty to protect peak/understaffed arrival slots
      } else {
        pen -= Math.min(surplus, 12) * 10; // Reward high-surplus quiet slots
      }
      // Quadratic break staggering penalty prevents multiple agents crowding identical 15-min break slots
      if (concurrentBreaks > 0) {
        pen += concurrentBreaks * concurrentBreaks * 18;
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

      // Continuous SLA estimate interpolating fractional break impact cleanly (honors Erlang C or Palm/Erlang A)
      const evalSlPct = (servers: number, vol: number): number =>
        erlangConfig.useErlangA
          ? computeErlangAMetrics(
              servers,
              vol,
              erlangConfig.globalAhtSec,
              intervalSec,
              erlangConfig.slThresholdSec,
              erlangConfig.avgPatienceSec
            ).slPct
          : computeErlangCMetrics(
              servers,
              vol,
              erlangConfig.globalAhtSec,
              intervalSec,
              erlangConfig.slThresholdSec
            ).slPct;

      const floorN = Math.floor(effectiveScheduledFte);
      const frac = effectiveScheduledFte - floorN;
      let projectedSlPct = 100;
      if (forecastVolume > 0) {
        const slFloor = evalSlPct(floorN, forecastVolume);
        if (frac > 0.01) {
          const slCeil = evalSlPct(floorN + 1, forecastVolume);
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
  const dayOverridesAll = rules.shiftDayHeadcountOverrides ?? {};
  const hasAnyGlobalDayOv = Object.values(dayOverridesAll).some(
    (shDayOv) =>
      !!shDayOv &&
      WEEK_DAYS.some((dk) => shDayOv[dk] !== undefined && shDayOv[dk] !== null && Number.isFinite(shDayOv[dk]!))
  );
  const enabledCatalogShifts = sortedCatalog.filter((s) => s.enabled);
  const allEnabledPinned =
    enabledCatalogShifts.length > 0 &&
    enabledCatalogShifts.every((s) => {
      const ov = overrides[s.id];
      return ov !== undefined && ov !== null && Number.isFinite(ov);
    });
  const shiftDailyMix: ShiftDailyMixRow[] = sortedCatalog
    .filter((sh) => {
      const counts = shiftDayCounts.get(sh.id);
      const totalForSh = counts ? WEEK_DAYS.reduce((s, dk) => s + counts[dk], 0) : 0;
      const hasOv = overrides[sh.id] !== undefined && overrides[sh.id] !== null;
      const shDayOv = dayOverridesAll[sh.id];
      const hasDayOv =
        !!shDayOv &&
        WEEK_DAYS.some((dk) => shDayOv[dk] !== undefined && shDayOv[dk] !== null && Number.isFinite(shDayOv[dk]!));
      return sh.enabled || totalForSh > 0 || hasOv || hasDayOv;
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
      const hasFiniteOv = ovVal !== undefined && ovVal !== null && Number.isFinite(ovVal);
      const cleanOvVal = hasFiniteOv ? Math.min(activeSchedulableCount, Math.max(0, Math.round(ovVal!))) : null;
      const shDayOv = dayOverridesAll[sh.id];
      const cleanDayOv: Partial<Record<DayKey, number | null>> = {};
      let hasAnyDayOv = false;
      if (shDayOv) {
        for (const dk of WEEK_DAYS) {
          const val = shDayOv[dk];
          if (val !== undefined && val !== null && Number.isFinite(val)) {
            cleanDayOv[dk] = Math.max(0, Math.round(val));
            hasAnyDayOv = true;
          }
        }
      }
      const assignedPoolCount =
        !hasAnyGlobalDayOv && allEnabledPinned && cleanOvVal !== null
          ? cleanOvVal
          : (primaryPoolCountByShift.get(sh.id) ?? 0);
      return {
        shiftId: sh.id,
        shiftLabel: sh.label,
        wrapsMidnight: sh.wrapsMidnight,
        durationHours: Number((sh.durationMin / 60).toFixed(1)),
        targetOverride: cleanOvVal,
        dayOverrides: hasAnyDayOv ? cleanDayOv : undefined,
        assignedPoolCount,
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
  const dayOverridesRaw = rules.shiftDayHeadcountOverrides ?? {};
  const explicitCellOverridesMap = new Map<string, Map<number, number>>();
  const dayOverridesMap = new Map<string, Map<number, number>>();
  for (const sh of catalogToUse) {
    const shOv = dayOverridesRaw[sh.id];
    if (!shOv) continue;
    const explicitMap = new Map<number, number>();
    const effectiveMap = new Map<number, number>();
    for (let dIdx = 0; dIdx < 7; dIdx++) {
      const val = shOv[WEEK_DAYS[dIdx]];
      if (val !== undefined && val !== null && Number.isFinite(val)) {
        const cleanVal = Math.max(0, Math.round(val));
        explicitMap.set(dIdx, cleanVal);
        effectiveMap.set(dIdx, cleanVal);
      }
    }
    if (explicitMap.size > 0) {
      explicitCellOverridesMap.set(sh.id, explicitMap);
      dayOverridesMap.set(sh.id, effectiveMap);
    }
  }

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

  // Build initial demand profiles
  const profiles = buildWeeklyDemandProfiles({ nextWeekDays, dayCurves, erlangConfig });
  const req15 = WEEK_DAYS.map((dk) => [...profiles[dk].required15]);
  const peakReqByDay = WEEK_DAYS.map((_, d) => Math.max(1, ...req15[d]));
  const gross15: number[][] = Array.from({ length: 7 }, () => new Array(96).fill(0));
  const expectedNet15: number[][] = Array.from({ length: 7 }, () => new Array(96).fill(0));
  const shiftDayCounts = new Map<string, number[]>();
  for (const sh of catalogToUse) shiftDayCounts.set(sh.id, new Array<number>(7).fill(0));

  // Break-Aware Shift Kernel: punch-in/out edge buffers deliver ~1.00 FTE while First/Lunch/Last break windows dip realistically
  const totalBreakMin =
    rules.breakRules.firstBreakMin + rules.breakRules.lunchMin + rules.breakRules.lastBreakMin;
  const kernelCache = new Map<string, { dayIdx: number; qIdx: number; netW: number }[]>();
  const getShiftSlotKernel = (shift: ShiftTemplate, dayIdx: number) => {
    const key = `${shift.id}\0${dayIdx}`;
    const cached = kernelCache.get(key);
    if (cached) return cached;
    const rawSlots = getShiftSlotsForDay(shift, dayIdx);
    const steps = rawSlots.length;
    const D = Math.max(60, shift.durationMin);
    const targetNetRatio = Math.max(0.5, (D - totalBreakMin) / D);
    const edgeB = Math.max(0, rules.breakRules.edgeBufferMin);
    const rawWeights = rawSlots.map((_, idx) => {
      const offMin = idx * 15;
      if (offMin < edgeB || offMin >= D - edgeB) return 1.0;
      const frac = offMin / D;
      // Central Lunch window (~+3.75h..+5.25h on 9h shift) dips deeper than short 15m breaks
      if (frac >= 0.44 && frac < 0.56) return 0.56;
      if (frac >= 0.415 && frac < 0.585) return 0.64;
      // First Break window (~+1.75h..+3.25h) & Last Break window (~+6.25h..+7.75h)
      if ((frac >= 0.19 && frac < 0.365) || (frac >= 0.69 && frac < 0.865)) return 0.82;
      return 0.96;
    });
    const rawSum = rawWeights.reduce((a, b) => a + b, 0) || steps;
    const scale = (steps * targetNetRatio) / rawSum;
    const kernel = rawSlots.map((pos, idx) => ({
      dayIdx: pos.dayIdx,
      qIdx: pos.qIdx,
      netW: rawWeights[idx] * scale,
    }));
    kernelCache.set(key, kernel);
    return kernel;
  };

  const avgNetShiftHrs =
    catalogToUse.reduce((s, sh) => s + Math.max(1, (sh.durationMin - totalBreakMin) / 60), 0) /
    catalogToUse.length;

  // 3. Partition Active Pool vs Explicit Per-Shift Manual Pool Overrides
  const offPatterns = getValidOffPairSet(rules.allowSunMonSplitOff);
  const activeIndices = rawRoster
    .map((r, idx) => (r.lockedException ? -1 : idx))
    .filter((idx) => idx >= 0);

  const pinnedPoolShiftByRosterIdx = new Map<number, ShiftTemplate>();
  let pinCursor = 0;
  const pinnedGroups: { shift: ShiftTemplate; rosterIndices: number[]; basePin: number }[] = [];
  const pinnedGroupByShiftId = new Map<string, { shift: ShiftTemplate; rosterIndices: number[]; basePin: number }>();

  for (const sh of catalogToUse) {
    const rawOv = overrides[sh.id];
    if (rawOv === undefined || rawOv === null || !Number.isFinite(rawOv)) continue;
    const pinTarget = Math.max(0, Math.round(rawOv));
    const groupIndices: number[] = [];
    while (groupIndices.length < pinTarget && pinCursor < activeIndices.length) {
      const rosterIdx = activeIndices[pinCursor++];
      pinnedPoolShiftByRosterIdx.set(rosterIdx, sh);
      groupIndices.push(rosterIdx);
    }
    const entry = { shift: sh, rosterIndices: groupIndices, basePin: groupIndices.length };
    pinnedGroupByShiftId.set(sh.id, entry);
    if (groupIndices.length > 0) pinnedGroups.push(entry);
  }

  let autoActiveIndices = activeIndices.filter((rIdx) => !pinnedPoolShiftByRosterIdx.has(rIdx));

  // Strict Overflow Rule:
  // A) If ANY shift is left on Auto, keep pinned shifts isolated & send remaining agents strictly to Auto shifts.
  // B) If ALL enabled shifts are pinned in top cards, top card pins lock Mon..Thu headcount (unless a Mon..Thu cell is explicitly overridden),
  //    and remaining surplus active shifts are distributed across Fri..Sun by Erlang demand via relief OFF patterns!
  const autoAllowedShifts = catalogToUse.filter((sh) => {
    const ov = overrides[sh.id];
    return ov === undefined || ov === null;
  });
  const allEnabledPinned = autoAllowedShifts.length === 0 && pinnedGroups.length > 0;

  if (allEnabledPinned) {
    for (const sh of catalogToUse) {
      const basePin = pinnedGroupByShiftId.get(sh.id)?.basePin ?? 0;
      let effMap = dayOverridesMap.get(sh.id);
      if (!effMap) {
        effMap = new Map<number, number>();
        dayOverridesMap.set(sh.id, effMap);
      }
      if (basePin === 0) {
        for (let dIdx = 0; dIdx < 7; dIdx++) {
          if (!explicitCellOverridesMap.get(sh.id)?.has(dIdx)) {
            effMap.set(dIdx, 0);
          }
        }
      } else {
        // Mon..Thu (dIdx 0..3) strictly honor the pinned shift counts unless individually cell-overridden
        for (let dIdx = 0; dIdx < 4; dIdx++) {
          if (!explicitCellOverridesMap.get(sh.id)?.has(dIdx)) {
            effMap.set(dIdx, basePin);
          }
        }
      }
    }

    // Absorb surplus active agents (beyond sum(Mon..Thu pins)) directly into non-overnight shift pools
    // using Mon+Tue / Wed+Thu relief OFF patterns so Mon..Thu stays 100% locked at pinned counts
    if (autoActiveIndices.length > 0) {
      const wkndNeedByShift = new Map<string, number>();
      for (const sh of catalogToUse) {
        let need = 0;
        for (const d of [4, 5, 6]) {
          for (const pos of getShiftSlotsForDay(sh, d)) {
            need += req15[pos.dayIdx][pos.qIdx];
          }
        }
        wkndNeedByShift.set(sh.id, need);
      }

      const absorbReliefAgent = (group: { shift: ShiftTemplate; rosterIndices: number[]; basePin: number }) => {
        const rosterIdx = autoActiveIndices.shift();
        if (rosterIdx === undefined) return false;
        pinnedPoolShiftByRosterIdx.set(rosterIdx, group.shift);
        group.rosterIndices.push(rosterIdx);
        if (!pinnedGroups.includes(group)) pinnedGroups.push(group);
        return true;
      };

      // Pass 1: Cover shifts where explicit cell overrides require more weekly shifts than 5 * basePin
      for (const sh of catalogToUse) {
        if (autoActiveIndices.length === 0) break;
        const group = pinnedGroupByShiftId.get(sh.id);
        const expMap = explicitCellOverridesMap.get(sh.id);
        if (!group || !expMap) continue;
        let expSum = 0;
        for (const v of expMap.values()) expSum += v;
        if (expMap.size < 7 && group.basePin > 0) {
          // Estimate minimum weekly demand if Fri..Sun partial explicit cells exceed 5*P - 4*P
          const monThuSum = [0, 1, 2, 3].reduce(
            (s, d) => s + (dayOverridesMap.get(sh.id)?.get(d) ?? group.basePin),
            0
          );
          const wkndExpSum = [4, 5, 6].reduce((s, d) => s + (expMap.get(d) ?? 0), 0);
          expSum = Math.max(expSum, monThuSum + wkndExpSum);
        }
        const neededPool = Math.ceil(expSum / Math.max(1, rules.maxWorkdaysPerWeek));
        while (autoActiveIndices.length > 0 && group.rosterIndices.length < neededPool) {
          absorbReliefAgent(group);
        }
      }

      // Pass 2: Allocate remaining relief agents across non-overnight groups respecting explicit Fri/Sun ceilings
      while (autoActiveIndices.length > 0) {
        let bestGroup: { shift: ShiftTemplate; rosterIndices: number[]; basePin: number } | null = null;
        let bestScore = -Infinity;

        for (const strictCap of [true, false]) {
          for (const nonOvernightOnly of [true, false]) {
            for (const g of pinnedGroups) {
              if (nonOvernightOnly && isOvernightShiftWindow(g.shift)) continue;
              if (g.basePin <= 0) continue;
              const currR = g.rosterIndices.length - g.basePin;
              if (strictCap && currR >= g.basePin) continue;
              if (strictCap) {
                const expSun = explicitCellOverridesMap.get(g.shift.id)?.get(6);
                const expFri = explicitCellOverridesMap.get(g.shift.id)?.get(4);
                const expSat = explicitCellOverridesMap.get(g.shift.id)?.get(5);
                if (expSun !== undefined && 2 * (currR + 1) > expSun) continue;
                if (expFri !== undefined && 2 * (currR + 1) > expFri) continue;
                if (expSat !== undefined && 2 * (currR + 1) > expSat) continue;
              }
              const need = wkndNeedByShift.get(g.shift.id) ?? 1;
              const sc = need / Math.max(1, g.rosterIndices.length) - currR * 0.5;
              if (sc > bestScore) {
                bestScore = sc;
                bestGroup = g;
              }
            }
            if (bestGroup) break;
          }
          if (bestGroup) break;
        }
        if (!bestGroup || !absorbReliefAgent(bestGroup)) break;
      }
    }
  }

  const nonZeroCatalog = catalogToUse.filter((sh) => overrides[sh.id] !== 0);
  const nonZeroDaytime = nonZeroCatalog.filter((sh) => !isOvernightShiftWindow(sh));
  const daytimeFallback = catalogToUse.filter((sh) => !isOvernightShiftWindow(sh));

  const primaryAutoPool =
    autoAllowedShifts.length > 0
      ? autoAllowedShifts
      : nonZeroDaytime.length > 0
        ? nonZeroDaytime
        : nonZeroCatalog.length > 0
          ? nonZeroCatalog
          : daytimeFallback.length > 0
            ? daytimeFallback
            : catalogToUse;

  const catalogCompMap = computeConnectedCatalogComponentIds(catalogToUse, rules.maxWeeklyStartDriftHours);

  // Compute Erlang-weighted interval objective helpers (evaluates expected Net Productive FTE vs Target Required)
  const intervalCost = (targetReq: number, netCov: number, dayIdx = 0, rawReq = targetReq): number => {
    const peakD = Math.max(1, peakReqByDay[dayIdx]);
    if (netCov < targetReq) {
      const diff = targetReq - netCov;
      const peakWeight = rawReq <= 2 ? 1.0 : 1 + 0.45 * (rawReq / peakD);
      return (diff * diff * 6.5 + diff * 3.5) * peakWeight;
    }
    const ex = netCov - targetReq;
    const shoulderExcessMult = rawReq > 2.2 && rawReq < peakD * 0.3 ? 1.85 : 1.0;
    return rawReq <= 2
      ? ex * (6.2 + 4.8 / Math.max(0.8, rawReq)) + ex * ex * 4.0
      : (ex * (1.1 + 1.8 / Math.max(1.0, targetReq)) + ex * ex * 0.22) * shoulderExcessMult;
  };
  const dayOverrideCost = (shiftId: string, dIdx: number, count: number): number => {
    const tgt = dayOverridesMap.get(shiftId)?.get(dIdx);
    if (tgt === undefined) return 0;
    const diff = Math.abs(count - tgt);
    return diff * 6000 + diff * diff * 3000;
  };

  // 4A. Stratified OFF-Pattern Assignment for Each Pinned Shift Group
  // Prevents all weekend OFFs clustering onto one shift AND satisfies Mon..Thu pinned targets with exact relief OFF pairs/triples
  const offPairByRosterIdx = new Map<number, [number, number]>();
  const globalPinnedWorkByDay = new Array<number>(7).fill(0);
  const pinnedSeedNet15: number[][] = Array.from({ length: 7 }, () => new Array(96).fill(0));
  const pinnedSeedCounts = new Map<string, number[]>();
  for (const sh of catalogToUse) pinnedSeedCounts.set(sh.id, new Array<number>(7).fill(0));

  for (const group of pinnedGroups) {
    const { shift: sh, rosterIndices, basePin } = group;
    const M = rosterIndices.length;
    const r = Math.max(0, M - basePin);
    const shDayOv = dayOverridesMap.get(sh.id);
    const expDayOv = explicitCellOverridesMap.get(sh.id);
    const shDayNeed = WEEK_DAYS.map((_, d) =>
      getShiftSlotsForDay(sh, d).reduce((s, pos) => s + req15[pos.dayIdx][pos.qIdx], 0)
    );

    const hasExactMonThuTargets =
      allEnabledPinned &&
      r <= basePin &&
      [0, 1, 2, 3].every((d) => (shDayOv?.get(d) ?? basePin) === basePin);

    if (hasExactMonThuTargets && M > 0) {
      const sunOv = expDayOv?.get(6);
      const friOv = expDayOv?.get(4);
      const satOv = expDayOv?.get(5);

      let maxT = rules.allowSunMonSplitOff ? Math.min(r, Math.max(0, basePin - r)) : 0;
      if (sunOv !== undefined) maxT = Math.min(maxT, Math.max(0, basePin + r - sunOv));
      if (friOv !== undefined) maxT = Math.min(maxT, Math.max(0, basePin + r - friOv));

      let t = 0;
      if (maxT > 0) {
        if (satOv !== undefined) {
          t = Math.max(0, Math.min(maxT, satOv - 2 * r));
        } else {
          const wkndNeedTotal = Math.max(1, shDayNeed[4] + shDayNeed[5] + shDayNeed[6]);
          const satShare = shDayNeed[5] / wkndNeedTotal;
          const totalWkndShifts = basePin + 5 * r;
          t = Math.max(0, Math.min(maxT, Math.round(totalWkndShifts * satShare) - 2 * r));
        }
      }
      const p = r - t;
      const rem = basePin - r - t;

      let a = 0;
      if (rem > 0) {
        if (sunOv !== undefined) {
          a = Math.max(0, Math.min(rem, sunOv - 2 * r));
        } else if (friOv !== undefined) {
          const bDesired = Math.max(0, Math.min(rem, friOv - 2 * r));
          a = rem - bDesired;
        } else {
          const sunFriSum = shDayNeed[4] + shDayNeed[6];
          a = sunFriSum > 0 ? Math.round(rem * (shDayNeed[6] / sunFriSum)) : Math.floor(rem / 2);
          if (rem >= 2 && a === 0 && shDayNeed[6] > 0) a = 1;
          if (rem >= 2 && a === rem && shDayNeed[4] > 0) a = rem - 1;
        }
      }
      const b = Math.max(0, rem - a);

      const basisPairs: [number, number][] = [];
      for (let i = 0; i < t; i++) basisPairs.push([0, 6], [1, 2], [3, 4]);
      for (let i = 0; i < p; i++) basisPairs.push([0, 1], [2, 3]);
      for (let i = 0; i < a; i++) basisPairs.push([4, 5]);
      for (let i = 0; i < b; i++) basisPairs.push([5, 6]);

      rosterIndices.forEach((rosterIdx, idx) => {
        const pair = basisPairs[idx] ?? [5, 6];
        offPairByRosterIdx.set(rosterIdx, pair);
        for (let d = 0; d < 7; d++) {
          if (d !== pair[0] && d !== pair[1]) {
            globalPinnedWorkByDay[d]++;
            pinnedSeedCounts.get(sh.id)![d] += 1;
            for (const pos of getShiftSlotKernel(sh, d)) {
              pinnedSeedNet15[pos.dayIdx][pos.qIdx] += pos.netW;
            }
          }
        }
      });
      continue;
    }

    const maxNeed = Math.max(1, ...shDayNeed);
    // Desired daily working headcount across 5*M total shift-days
    const desire = new Array<number>(7).fill(0);
    let fixedSum = 0;
    const unpinnedDays: number[] = [];
    for (let d = 0; d < 7; d++) {
      const ov = shDayOv?.get(d);
      if (ov !== undefined) {
        const clamped = Math.min(M, ov);
        desire[d] = clamped;
        fixedSum += clamped;
      } else {
        unpinnedDays.push(d);
      }
    }
    const remainingShifts = Math.max(0, 5 * M - fixedSum);
    const weightSum = unpinnedDays.reduce((s, d) => s + (shDayNeed[d] + 0.2 * maxNeed), 0) || 1;
    for (const d of unpinnedDays) {
      desire[d] = Math.min(
        M,
        (remainingShifts * (shDayNeed[d] + 0.2 * maxNeed)) / weightSum
      );
    }

    const groupWorkByDay = new Array<number>(7).fill(0);
    const pairUsage = new Map<string, number>();
    for (const rosterIdx of rosterIndices) {
      let bestPair = offPatterns[0];
      let bestScore = -Infinity;
      for (const pair of offPatterns) {
        const pKey = `${pair[0]}-${pair[1]}`;
        let sc = 0;
        for (let d = 0; d < 7; d++) {
          if (d === pair[0] || d === pair[1]) {
            const ov = shDayOv?.get(d);
            if (ov !== undefined && groupWorkByDay[d] <= ov) sc -= 40;
            const surplusIfRemoved = groupWorkByDay[d] - desire[d];
            if (surplusIfRemoved < -0.5) sc -= 2;
            continue;
          }
          const gap = desire[d] - groupWorkByDay[d];
          sc += gap > 0 ? gap * 3.0 + 1.0 : gap * 0.4;
          if (groupWorkByDay[d] === 0 && desire[d] > 0.2) sc += 12;
        }
        // Anti-collapse diversity bias inside small pinned groups
        const usedTimes = pairUsage.get(pKey) ?? 0;
        sc -= usedTimes * (M <= 8 ? 3.5 : 0.8);
        if (sc > bestScore) {
          bestScore = sc;
          bestPair = pair;
        }
      }
      offPairByRosterIdx.set(rosterIdx, bestPair);
      const pKey = `${bestPair[0]}-${bestPair[1]}`;
      pairUsage.set(pKey, (pairUsage.get(pKey) ?? 0) + 1);
      for (let d = 0; d < 7; d++) {
        if (d !== bestPair[0] && d !== bestPair[1]) {
          groupWorkByDay[d]++;
          globalPinnedWorkByDay[d]++;
          pinnedSeedCounts.get(sh.id)![d] += 1;
          for (const pos of getShiftSlotKernel(sh, d)) {
            pinnedSeedNet15[pos.dayIdx][pos.qIdx] += pos.netW;
          }
        }
      }
    }
  }

  // 4B-pre: Compute Aggregate Auto Daily Work Budget Matching Remaining Demand + Explicit Auto Day Overrides
  const autoDayWorkTarget = new Array<number>(7).fill(0);
  const autoDayAllLocked = new Array<boolean>(7).fill(false);
  const autoExplicitNeedByDay = WEEK_DAYS.map((_, d) => {
    let extra = 0;
    let lockedShiftsCount = 0;
    for (const sh of primaryAutoPool) {
      const ov = dayOverridesMap.get(sh.id)?.get(d);
      if (ov !== undefined) {
        extra += ov;
        lockedShiftsCount++;
      }
    }
    autoDayAllLocked[d] = primaryAutoPool.length > 0 && lockedShiftsCount === primaryAutoPool.length;
    return extra;
  });
  const baseAutoPairUsage = new Map<string, number>();

  for (let i = 0; i < autoActiveIndices.length; i++) {
    let bestPair = offPatterns[0];
    let bestScore = -Infinity;
    for (const pair of offPatterns) {
      const pKey = `${pair[0]}-${pair[1]}`;
      let sc = 0;
      for (let d = 0; d < 7; d++) {
        if (d === pair[0] || d === pair[1]) continue;
        const reqH = profiles[WEEK_DAYS[d]].requiredProdHours;
        const totalWorkD = globalPinnedWorkByDay[d] + autoDayWorkTarget[d];
        if (autoDayAllLocked[d]) {
          if (autoDayWorkTarget[d] < autoExplicitNeedByDay[d]) {
            sc += 90 + (autoExplicitNeedByDay[d] - autoDayWorkTarget[d]) * 4;
          } else {
            sc -= 140;
          }
        } else {
          const deficit = reqH - totalWorkD * avgNetShiftHrs;
          sc += deficit > 0 ? deficit * 2.6 : deficit * 0.25;
          if (autoDayWorkTarget[d] < autoExplicitNeedByDay[d]) sc += 30;
        }
        if (totalWorkD === 0 && reqH > 0) sc += 100;
      }
      sc -= (baseAutoPairUsage.get(pKey) ?? 0) * 0.35;
      if (sc > bestScore) {
        bestScore = sc;
        bestPair = pair;
      }
    }
    const pKey = `${bestPair[0]}-${bestPair[1]}`;
    baseAutoPairUsage.set(pKey, (baseAutoPairUsage.get(pKey) ?? 0) + 1);
    for (let d = 0; d < 7; d++) {
      if (d !== bestPair[0] && d !== bestPair[1]) autoDayWorkTarget[d]++;
    }
  }

  // Supply-Scaled Effective Erlang Target Matrix so core daytime & lunch relief scale proportionally
  // while midnight base (<= 2.2) and quiet shoulder tails resist idle head hoarding
  const optReq15: number[][] = WEEK_DAYS.map((dk, d) => {
    const availHrs = (globalPinnedWorkByDay[d] + autoDayWorkTarget[d]) * avgNetShiftHrs;
    const reqHrs = profiles[dk].requiredProdHours;
    const rawRatio = reqHrs > 0 ? availHrs / reqHrs : 1;
    const coreScale = Math.max(0.55, Math.min(1.45, rawRatio));
    const peakD = peakReqByDay[d];
    return req15[d].map((r) => {
      if (r <= 2.2) return r;
      if (coreScale <= 1.0) return r * coreScale;
      const shoulderFloor = peakD * 0.22;
      const coreCeil = peakD * 0.55;
      const ramp =
        coreCeil > shoulderFloor
          ? Math.max(0, Math.min(1, (r - shoulderFloor) / (coreCeil - shoulderFloor)))
          : 1;
      const scale = 1.04 + (coreScale - 1.04) * ramp;
      return r * scale;
    });
  });

  // Marginal WFM Shift Scoring using Break-Profiled Kernel & Supply-Scaled Erlang Target
  const scoreShiftDeltaWithDayOv = (
    candidate: ShiftTemplate,
    dayIdx: number,
    netMat: number[][],
    shCounts: Map<string, number[]>
  ): number => {
    const slots = getShiftSlotKernel(candidate, dayIdx);
    const peakD = Math.max(1, peakReqByDay[dayIdx]);
    let score = 0;
    for (const pos of slots) {
      const targetReq = optReq15[pos.dayIdx][pos.qIdx];
      const rawReq = req15[pos.dayIdx][pos.qIdx];
      const currNet = netMat[pos.dayIdx][pos.qIdx];
      const netGain = pos.netW;
      if (currNet < targetReq) {
        const fill = Math.min(netGain, targetReq - currNet);
        const shortageUrgency = (targetReq - currNet) / Math.max(1, targetReq);
        const peakUrgency = rawReq <= 2 ? 1.0 : 1 + 0.4 * (rawReq / peakD);
        score += fill * (14 + 6 * Math.min(1, shortageUrgency)) * peakUrgency;
      } else {
        const excessBefore = currNet - targetReq;
        const ratioWaste = (excessBefore + netGain) / Math.max(0.8, targetReq);
        const quietExtra = rawReq <= 2 ? 5.6 + 3.2 * excessBefore : 1.35;
        const shoulderMult = rawReq > 2.2 && rawReq < peakD * 0.3 ? 1.85 : 1.0;
        score -= (quietExtra + ratioWaste * (rawReq <= 2 ? 4.8 : 1.6)) * netGain * shoulderMult;
      }
    }
    const dayOv = dayOverridesMap.get(candidate.id)?.get(dayIdx);
    if (dayOv !== undefined) {
      const currCnt = shCounts.get(candidate.id)?.[dayIdx] ?? 0;
      if (currCnt < dayOv) score += 1200 + (dayOv - currCnt) * 150;
      else score -= 1600;
    }
    return score;
  };

  // 5A. Compute Aggregate Daily Shift-Demand Blueprint for Auto Pool (Break-Aware Convex Allocation + 1-Opt Polish)
  const simNet = pinnedSeedNet15.map((row) => [...row]);
  const simShCounts = new Map<string, number[]>();
  for (const sh of catalogToUse) simShCounts.set(sh.id, [...(pinnedSeedCounts.get(sh.id) ?? new Array(7).fill(0))]);

  const blueprintCount = new Map<string, number[]>();
  for (const sh of catalogToUse) blueprintCount.set(sh.id, new Array<number>(7).fill(0));

  for (let dIdx = 0; dIdx < 7; dIdx++) {
    const available = autoDayWorkTarget[dIdx];
    const allowedDay = catalogToUse.filter((sh) => {
      if (primaryAutoPool.some((p) => p.id === sh.id)) return true;
      const explicitTgt = dayOverridesMap.get(sh.id)?.get(dIdx);
      return explicitTgt !== undefined;
    });
    for (let k = 0; k < available; k++) {
      const pickPool = allowedDay.filter((sh) => {
        if (primaryAutoPool.some((p) => p.id === sh.id)) return true;
        const explicitTgt = dayOverridesMap.get(sh.id)?.get(dIdx);
        return explicitTgt !== undefined && (simShCounts.get(sh.id)?.[dIdx] ?? 0) < explicitTgt;
      });
      const pool = pickPool.length > 0 ? pickPool : primaryAutoPool;
      let bestSh = pool[0];
      let bestSc = -Infinity;
      for (const cand of pool) {
        const sc = scoreShiftDeltaWithDayOv(cand, dIdx, simNet, simShCounts);
        if (sc > bestSc) {
          bestSc = sc;
          bestSh = cand;
        }
      }
      blueprintCount.get(bestSh.id)![dIdx] += 1;
      simShCounts.get(bestSh.id)![dIdx] += 1;
      for (const pos of getShiftSlotKernel(bestSh, dIdx)) {
        simNet[pos.dayIdx][pos.qIdx] += pos.netW;
      }
    }
  }

  // Daily 1-Opt Convex Polish on Blueprint before deriving per-shift pool quotas & stratified OFF patterns
  if (autoActiveIndices.length > 0) {
    for (let bpSweep = 0; bpSweep < 3; bpSweep++) {
      let bpImproved = false;
      for (let dIdx = 0; dIdx < 7; dIdx++) {
        const dayCandidates = catalogToUse.filter(
          (sh) => primaryAutoPool.some((p) => p.id === sh.id) || dayOverridesMap.get(sh.id)?.has(dIdx)
        );
        if (dayCandidates.length < 2) continue;
        for (const oldSh of dayCandidates) {
          while ((blueprintCount.get(oldSh.id)?.[dIdx] ?? 0) > 0) {
            const oldTgt = dayOverridesMap.get(oldSh.id)?.get(dIdx);
            const oldSim = simShCounts.get(oldSh.id)?.[dIdx] ?? 0;
            if (oldTgt !== undefined && oldSim <= oldTgt) break;

            let bestNew: ShiftTemplate | null = null;
            let bestDelta = -0.02;
            const oldSlots = getShiftSlotKernel(oldSh, dIdx);

            for (const newSh of dayCandidates) {
              if (newSh.id === oldSh.id) continue;
              const newTgt = dayOverridesMap.get(newSh.id)?.get(dIdx);
              const newSim = simShCounts.get(newSh.id)?.[dIdx] ?? 0;
              if (!primaryAutoPool.some((p) => p.id === newSh.id) && (newTgt === undefined || newSim >= newTgt)) continue;
              const newSlots = getShiftSlotKernel(newSh, dIdx);

              const slotDelta = new Map<number, number>();
              for (const pos of oldSlots) {
                const sk = pos.dayIdx * 96 + pos.qIdx;
                slotDelta.set(sk, (slotDelta.get(sk) ?? 0) - pos.netW);
              }
              for (const pos of newSlots) {
                const sk = pos.dayIdx * 96 + pos.qIdx;
                slotDelta.set(sk, (slotDelta.get(sk) ?? 0) + pos.netW);
              }
              let dc = 0;
              for (const [sk, dv] of slotDelta.entries()) {
                if (Math.abs(dv) < 1e-9) continue;
                const d = Math.floor(sk / 96);
                const q = sk % 96;
                const cNet = simNet[d][q];
                dc +=
                  intervalCost(optReq15[d][q], cNet + dv, d, req15[d][q]) -
                  intervalCost(optReq15[d][q], cNet, d, req15[d][q]);
              }
              dc += dayOverrideCost(oldSh.id, dIdx, oldSim - 1) - dayOverrideCost(oldSh.id, dIdx, oldSim);
              dc += dayOverrideCost(newSh.id, dIdx, newSim + 1) - dayOverrideCost(newSh.id, dIdx, newSim);
              if (dc < bestDelta) {
                bestDelta = dc;
                bestNew = newSh;
              }
            }
            if (!bestNew) break;
            blueprintCount.get(oldSh.id)![dIdx] -= 1;
            blueprintCount.get(bestNew.id)![dIdx] += 1;
            simShCounts.get(oldSh.id)![dIdx] -= 1;
            simShCounts.get(bestNew.id)![dIdx] += 1;
            for (const pos of oldSlots) {
              simNet[pos.dayIdx][pos.qIdx] = Math.max(0, simNet[pos.dayIdx][pos.qIdx] - pos.netW);
            }
            for (const pos of getShiftSlotKernel(bestNew, dIdx)) {
              simNet[pos.dayIdx][pos.qIdx] += pos.netW;
            }
            bpImproved = true;
          }
        }
      }
      if (!bpImproved) break;
    }
  }

  // Partition Auto Pool into Per-Shift Quotas from Polished Blueprint & Assign Stratified OFF Patterns PER SHIFT GROUP
  const anchorByRosterIdx = new Map<number, ShiftTemplate>();
  const autoDayWorkCount = new Array<number>(7).fill(0);

  if (autoActiveIndices.length > 0) {
    const totalBlueprintShifts = catalogToUse.reduce(
      (s, sh) => s + blueprintCount.get(sh.id)!.reduce((a, b) => a + b, 0),
      0
    );
    const quotas = primaryAutoPool.map((sh) => {
      const bpTotal = blueprintCount.get(sh.id)!.reduce((a, b) => a + b, 0);
      const exact = totalBlueprintShifts > 0 ? (bpTotal / totalBlueprintShifts) * autoActiveIndices.length : 0;
      return { sh, base: Math.floor(exact), frac: exact - Math.floor(exact), count: Math.floor(exact) };
    });
    let assignedAnchors = quotas.reduce((s, q) => s + q.base, 0);
    const byFrac = [...quotas].sort((a, b) => b.frac - a.frac);
    let idxF = 0;
    while (assignedAnchors < autoActiveIndices.length && byFrac.length > 0) {
      byFrac[idxF % byFrac.length].count += 1;
      assignedAnchors++;
      idxF++;
    }

    let autoCursor = 0;
    const anchorPoolGroups: { shift: ShiftTemplate; rosterIndices: number[] }[] = [];
    for (const q of quotas) {
      const grpIndices: number[] = [];
      for (let c = 0; c < q.count && autoCursor < autoActiveIndices.length; c++) {
        const rIdx = autoActiveIndices[autoCursor++];
        anchorByRosterIdx.set(rIdx, q.sh);
        grpIndices.push(rIdx);
      }
      if (grpIndices.length > 0) anchorPoolGroups.push({ shift: q.sh, rosterIndices: grpIndices });
    }

    // Step 4B: Assign OFF patterns per shift group (smallest groups first) so NO shift collapses on Sat/Sun!
    const groupsSmallFirst = [...anchorPoolGroups].sort(
      (a, b) => a.rosterIndices.length - b.rosterIndices.length
    );
    for (const grp of groupsSmallFirst) {
      const sh = grp.shift;
      const M = grp.rosterIndices.length;
      const bp = blueprintCount.get(sh.id) ?? new Array<number>(7).fill(0);
      const desire = new Array<number>(7).fill(0);
      let fixedSum = 0;
      const unpinnedDays: number[] = [];
      for (let d = 0; d < 7; d++) {
        const ov = dayOverridesMap.get(sh.id)?.get(d);
        if (ov !== undefined) {
          const clamped = Math.min(M, ov);
          desire[d] = clamped;
          fixedSum += clamped;
        } else {
          unpinnedDays.push(d);
        }
      }
      const remainingShifts = Math.max(0, rules.maxWorkdaysPerWeek * M - fixedSum);
      const bpSum = unpinnedDays.reduce((s, d) => s + Math.max(0.15, bp[d]), 0) || 1;
      for (const d of unpinnedDays) {
        desire[d] = Math.min(M, (remainingShifts * Math.max(0.15, bp[d])) / bpSum);
      }

      const groupWorkByDay = new Array<number>(7).fill(0);
      const pairUsage = new Map<string, number>();
      for (const rosterIdx of grp.rosterIndices) {
        let bestPair = offPatterns[0];
        let bestScore = -Infinity;
        for (const pair of offPatterns) {
          const pKey = `${pair[0]}-${pair[1]}`;
          let sc = 0;
          for (let d = 0; d < 7; d++) {
            if (d === pair[0] || d === pair[1]) {
              const ov = dayOverridesMap.get(sh.id)?.get(d);
              if (ov !== undefined && groupWorkByDay[d] <= ov) sc -= 40;
              continue;
            }
            const grpGap = desire[d] - groupWorkByDay[d];
            const globalGap = autoDayWorkTarget[d] - autoDayWorkCount[d];
            sc += (grpGap > 0 ? grpGap * 4.0 + 1.0 : grpGap * 0.6) + globalGap * 1.4;
            if (groupWorkByDay[d] === 0 && (bp[d] > 0 || desire[d] > 0.25)) sc += 24;
          }
          const usedTimes = pairUsage.get(pKey) ?? 0;
          sc -= usedTimes * (M <= 6 ? 4.5 : M <= 12 ? 1.8 : 0.7);
          if (sc > bestScore) {
            bestScore = sc;
            bestPair = pair;
          }
        }
        offPairByRosterIdx.set(rosterIdx, bestPair);
        const pKey = `${bestPair[0]}-${bestPair[1]}`;
        pairUsage.set(pKey, (pairUsage.get(pKey) ?? 0) + 1);
        for (let d = 0; d < 7; d++) {
          if (d !== bestPair[0] && d !== bestPair[1]) {
            groupWorkByDay[d]++;
            autoDayWorkCount[d]++;
          }
        }
      }
    }
  }

  // Construct scaffolded rows & seed all Weekly-Pinned agents directly into gross15 + expectedNet15 + shiftDayCounts
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
    const pinnedSh = pinnedPoolShiftByRosterIdx.get(idx) ?? null;
    for (let d = 0; d < 7; d++) {
      const dk = WEEK_DAYS[d];
      const isOff = d === pair[0] || d === pair[1];
      if (!isOff && pinnedSh) {
        assignments[dk] = { dayKey: dk, status: 'WORK', shiftId: pinnedSh.id, breaks: null };
        shiftDayCounts.get(pinnedSh.id)![d] += 1;
        for (const pos of getShiftSlotKernel(pinnedSh, d)) {
          gross15[pos.dayIdx][pos.qIdx] += 1;
          expectedNet15[pos.dayIdx][pos.qIdx] += pos.netW;
        }
      } else {
        assignments[dk] = {
          dayKey: dk,
          status: isOff ? 'OFF' : 'WORK',
          shiftId: null,
          breaks: null,
        };
      }
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

  // Helper: check whether candidateShift on day dIdx keeps component drift & inter-shift rest valid
  const isCandidateShiftFeasible = (
    row: ScheduledAgentRow,
    dayIdx: number,
    candidate: ShiftTemplate,
    overrideAssignments?: Record<DayKey, AgentDayAssignment>
  ): boolean => {
    const baseAssign = overrideAssignments ?? row.assignments;
    const workedShifts: ShiftTemplate[] = [candidate];
    for (let d = 0; d < 7; d++) {
      if (d === dayIdx) continue;
      const a = baseAssign[WEEK_DAYS[d]];
      if (a.status === 'WORK' && a.shiftId) {
        const s = shiftMap.get(a.shiftId);
        if (s) workedShifts.push(s);
      }
    }

    const testAssignments = {
      ...baseAssign,
      [WEEK_DAYS[dayIdx]]: {
        dayKey: WEEK_DAYS[dayIdx],
        status: 'WORK' as LeaveAllocationCode,
        shiftId: candidate.id,
        breaks: null,
      },
    };
    const minRest = getMinimumWeeklyRestHours(testAssignments, shiftMap);
    if (minRest !== null && minRest < rules.minInterShiftRestHours - 1e-6) {
      return false;
    }
    if (
      computeEffectiveBandSpanHours(workedShifts, minRest, catalogToUse, rules, catalogCompMap) >
      rules.maxWeeklyStartDriftHours + 1e-6
    ) {
      return false;
    }
    return true;
  };

  // Helper returning shifts an unpinned Auto agent is allowed to work on dayIdx.
  // Never leaks into pinned shifts unless a manual daily pin exceeds pinned pool on that specific day.
  const getAllowedShiftsOnDay = (dayIdx: number, currentShiftId?: string | null): ShiftTemplate[] => {
    const allowed: ShiftTemplate[] = [];
    const seen = new Set<string>();
    for (const sh of primaryAutoPool) {
      allowed.push(sh);
      seen.add(sh.id);
    }
    for (const sh of catalogToUse) {
      if (seen.has(sh.id)) continue;
      const explicitDayTgt = dayOverridesMap.get(sh.id)?.get(dayIdx);
      if (explicitDayTgt !== undefined) {
        const currCnt = shiftDayCounts.get(sh.id)?.[dayIdx] ?? 0;
        if (sh.id === currentShiftId || currCnt < explicitDayTgt) {
          allowed.push(sh);
          seen.add(sh.id);
        }
      }
    }
    return allowed;
  };

  // 5B. Initialize Unpinned Auto Agents Guided by Stratified Per-Shift Anchor + Blueprint + Marginal Interval Demand
  const blueprintRemaining = new Map<string, number[]>();
  for (const sh of catalogToUse) {
    blueprintRemaining.set(sh.id, [...(blueprintCount.get(sh.id) ?? new Array(7).fill(0))]);
  }
  const sortedDayIndices = [0, 1, 2, 3, 4, 5, 6].sort(
    (a, b) => profiles[WEEK_DAYS[b]].forecastVolume - profiles[WEEK_DAYS[a]].forecastVolume
  );

  for (const rosterIdx of autoActiveIndices) {
    const row = draftRows[rosterIdx];
    const anchor = anchorByRosterIdx.get(rosterIdx) ?? primaryAutoPool[0];
    for (const dIdx of sortedDayIndices) {
      const dk = WEEK_DAYS[dIdx];
      if (row.assignments[dk].status !== 'WORK') continue;
      const dayCandidates = getAllowedShiftsOnDay(dIdx);
      let bestShift = dayCandidates.find((c) => isCandidateShiftFeasible(row, dIdx, c)) ?? primaryAutoPool[0];
      let bestScore = -Infinity;

      for (const cand of dayCandidates) {
        if (!isCandidateShiftFeasible(row, dIdx, cand)) continue;
        let sc = scoreShiftDeltaWithDayOv(cand, dIdx, expectedNet15, shiftDayCounts);
        const bpLeft = blueprintRemaining.get(cand.id)?.[dIdx] ?? 0;
        if (bpLeft > 0) sc += 18 + Math.min(20, bpLeft * 2.5);
        const startDiff = computeCircularStartSpanHours([anchor.startMin, cand.startMin]);
        if (cand.id === anchor.id) sc += 24;
        else if (startDiff <= rules.maxWeeklyStartDriftHours) sc += 6 - startDiff * 1.5;

        if (sc > bestScore) {
          bestScore = sc;
          bestShift = cand;
        }
      }

      row.assignments[dk].shiftId = bestShift.id;
      shiftDayCounts.get(bestShift.id)![dIdx] += 1;
      const bpArr = blueprintRemaining.get(bestShift.id);
      if (bpArr && bpArr[dIdx] > 0) bpArr[dIdx] -= 1;
      for (const pos of getShiftSlotKernel(bestShift, dIdx)) {
        gross15[pos.dayIdx][pos.qIdx] += 1;
        expectedNet15[pos.dayIdx][pos.qIdx] += pos.netW;
      }
    }
  }

  // 5C. Transactional Delta Cost Evaluator & Joint Multi-Move Local Optimizer
  interface DayMutation {
    dayIdx: number;
    oldShift: ShiftTemplate | null;
    newShift: ShiftTemplate | null;
  }

  const computeDeltaCost = (mutations: DayMutation[]): number => {
    const netSlotDelta = new Map<number, number>(); // key = d * 96 + q -> expectedNet delta
    const countDelta = new Map<string, number>(); // key = `${shId}\0${dIdx}`

    for (const m of mutations) {
      if (m.oldShift && m.newShift && m.oldShift.id === m.newShift.id) continue;
      if (m.oldShift) {
        const ck = `${m.oldShift.id}\0${m.dayIdx}`;
        countDelta.set(ck, (countDelta.get(ck) ?? 0) - 1);
        for (const pos of getShiftSlotKernel(m.oldShift, m.dayIdx)) {
          const sk = pos.dayIdx * 96 + pos.qIdx;
          netSlotDelta.set(sk, (netSlotDelta.get(sk) ?? 0) - pos.netW);
        }
      }
      if (m.newShift) {
        const ck = `${m.newShift.id}\0${m.dayIdx}`;
        countDelta.set(ck, (countDelta.get(ck) ?? 0) + 1);
        for (const pos of getShiftSlotKernel(m.newShift, m.dayIdx)) {
          const sk = pos.dayIdx * 96 + pos.qIdx;
          netSlotDelta.set(sk, (netSlotDelta.get(sk) ?? 0) + pos.netW);
        }
      }
    }

    let delta = 0;
    for (const [sk, dv] of netSlotDelta.entries()) {
      if (Math.abs(dv) < 1e-9) continue;
      const d = Math.floor(sk / 96);
      const q = sk % 96;
      const targetReq = optReq15[d][q];
      const rawReq = req15[d][q];
      const currNet = expectedNet15[d][q];
      delta += intervalCost(targetReq, currNet + dv, d, rawReq) - intervalCost(targetReq, currNet, d, rawReq);
    }
    for (const [ck, dc] of countDelta.entries()) {
      if (dc === 0) continue;
      const sep = ck.indexOf('\0');
      const shId = ck.slice(0, sep);
      const dIdx = Number(ck.slice(sep + 1));
      const currCnt = shiftDayCounts.get(shId)?.[dIdx] ?? 0;
      delta += dayOverrideCost(shId, dIdx, currCnt + dc) - dayOverrideCost(shId, dIdx, currCnt);
    }
    return delta;
  };

  const applyMutationsToMatrices = (mutations: DayMutation[]) => {
    for (const m of mutations) {
      if (m.oldShift && m.newShift && m.oldShift.id === m.newShift.id) continue;
      if (m.oldShift) {
        shiftDayCounts.get(m.oldShift.id)![m.dayIdx] -= 1;
        for (const pos of getShiftSlotKernel(m.oldShift, m.dayIdx)) {
          gross15[pos.dayIdx][pos.qIdx] -= 1;
          expectedNet15[pos.dayIdx][pos.qIdx] = Math.max(0, expectedNet15[pos.dayIdx][pos.qIdx] - pos.netW);
        }
      }
      if (m.newShift) {
        shiftDayCounts.get(m.newShift.id)![m.dayIdx] += 1;
        for (const pos of getShiftSlotKernel(m.newShift, m.dayIdx)) {
          gross15[pos.dayIdx][pos.qIdx] += 1;
          expectedNet15[pos.dayIdx][pos.qIdx] += pos.netW;
        }
      }
    }
  };

  const getRowOffPair = (row: ScheduledAgentRow): [number, number] | null => {
    const offs: number[] = [];
    for (let d = 0; d < 7; d++) {
      if (row.assignments[WEEK_DAYS[d]].status === 'OFF') offs.push(d);
    }
    return offs.length === 2 ? [offs[0], offs[1]] : null;
  };

  for (let sweep = 0; sweep < 4; sweep++) {
    let improved = false;

    // Move 1: Single-Day Shift Optimization across Unpinned Auto Agents
    for (const rosterIdx of autoActiveIndices) {
      const row = draftRows[rosterIdx];
      for (let dIdx = 0; dIdx < 7; dIdx++) {
        const dk = WEEK_DAYS[dIdx];
        const currShiftId = row.assignments[dk].shiftId;
        if (row.assignments[dk].status !== 'WORK' || !currShiftId) continue;
        const currShift = shiftMap.get(currShiftId);
        if (!currShift) continue;

        let bestCand = currShift;
        let bestDelta = -0.02;
        const dayCandidates = getAllowedShiftsOnDay(dIdx, currShift.id);

        for (const cand of dayCandidates) {
          if (cand.id === currShift.id) continue;
          if (!isCandidateShiftFeasible(row, dIdx, cand)) continue;
          const dCost = computeDeltaCost([{ dayIdx: dIdx, oldShift: currShift, newShift: cand }]);
          if (dCost < bestDelta) {
            bestDelta = dCost;
            bestCand = cand;
          }
        }

        if (bestCand.id !== currShift.id) {
          applyMutationsToMatrices([{ dayIdx: dIdx, oldShift: currShift, newShift: bestCand }]);
          row.assignments[dk].shiftId = bestCand.id;
          improved = true;
        }
      }
    }

    // Move 2: OFF-Pattern Slide (All Active Agents, Pinned & Auto)
    // Balances Mon..Sun demand & satisfies explicit Saturday/weekday daily overrides cleanly
    for (const rosterIdx of activeIndices) {
      const row = draftRows[rosterIdx];
      const currOff = getRowOffPair(row);
      if (!currOff) continue;
      const pinnedSh = pinnedPoolShiftByRosterIdx.get(rosterIdx) ?? null;

      let bestPair: [number, number] | null = null;
      let bestMutations: DayMutation[] | null = null;
      let bestNextAssignments: Record<DayKey, AgentDayAssignment> | null = null;
      let bestDelta = -0.05;

      for (const nextOff of offPatterns) {
        if (nextOff[0] === currOff[0] && nextOff[1] === currOff[1]) continue;

        const nextAssignments: Record<DayKey, AgentDayAssignment> = { ...row.assignments };
        const mutations: DayMutation[] = [];

        // Turn newly OFF days from WORK -> OFF
        const becomeOff = currOff.length === 2 ? nextOff.filter((d) => !currOff.includes(d)) : [];
        const becomeWork = currOff.filter((d) => !nextOff.includes(d));

        for (const dOff of becomeOff) {
          const dk = WEEK_DAYS[dOff];
          const oldId = row.assignments[dk].shiftId;
          const oldSh = oldId ? shiftMap.get(oldId) ?? null : null;
          if (oldSh) mutations.push({ dayIdx: dOff, oldShift: oldSh, newShift: null });
          nextAssignments[dk] = { dayKey: dk, status: 'OFF', shiftId: null, breaks: null };
        }

        // Fill newly WORK days cleanly respecting fixed pinned shift or Auto feasibility
        let validPattern = true;
        for (const dWork of becomeWork) {
          const dk = WEEK_DAYS[dWork];
          if (pinnedSh) {
            if (!isCandidateShiftFeasible(row, dWork, pinnedSh, nextAssignments)) {
              validPattern = false;
              break;
            }
            nextAssignments[dk] = { dayKey: dk, status: 'WORK', shiftId: pinnedSh.id, breaks: null };
            mutations.push({ dayIdx: dWork, oldShift: null, newShift: pinnedSh });
          } else {
            const cands = getAllowedShiftsOnDay(dWork);
            let chosen: ShiftTemplate | null = null;
            let bestSingleCost = Infinity;
            for (const cand of cands) {
              if (!isCandidateShiftFeasible(row, dWork, cand, nextAssignments)) continue;
              const cDelta = computeDeltaCost([...mutations, { dayIdx: dWork, oldShift: null, newShift: cand }]);
              if (cDelta < bestSingleCost) {
                bestSingleCost = cDelta;
                chosen = cand;
              }
            }
            if (!chosen) {
              validPattern = false;
              break;
            }
            nextAssignments[dk] = { dayKey: dk, status: 'WORK', shiftId: chosen.id, breaks: null };
            mutations.push({ dayIdx: dWork, oldShift: null, newShift: chosen });
          }
        }
        if (!validPattern) continue;

        const minRest = getMinimumWeeklyRestHours(nextAssignments, shiftMap);
        if (minRest !== null && minRest < rules.minInterShiftRestHours - 1e-6) continue;

        const delta = computeDeltaCost(mutations);
        if (delta < bestDelta) {
          bestDelta = delta;
          bestPair = nextOff;
          bestMutations = mutations;
          bestNextAssignments = nextAssignments;
        }
      }

      if (bestPair && bestMutations && bestNextAssignments) {
        applyMutationsToMatrices(bestMutations);
        row.assignments = bestNextAssignments;
        improved = true;
      }
    }

    // Move 3: Whole-Week Band Shift on Unpinned Auto Agents (Escapes Drift Band Traps)
    if (sweep < 3) {
      for (const rosterIdx of autoActiveIndices) {
        const row = draftRows[rosterIdx];
        const workDays: { dayIdx: number; shift: ShiftTemplate }[] = [];
        for (let d = 0; d < 7; d++) {
          const a = row.assignments[WEEK_DAYS[d]];
          if (a.status === 'WORK' && a.shiftId) {
            const sh = shiftMap.get(a.shiftId);
            if (sh) workDays.push({ dayIdx: d, shift: sh });
          }
        }
        if (workDays.length === 0) continue;

        let bestAnchorShift: ShiftTemplate | null = null;
        let bestMutations: DayMutation[] | null = null;
        let bestDelta = -0.5;

        for (const targetSh of primaryAutoPool) {
          if (workDays.every((w) => w.shift.id === targetSh.id)) continue;
          const mutations = workDays.map((w) => ({
            dayIdx: w.dayIdx,
            oldShift: w.shift,
            newShift: targetSh,
          }));
          // Uniform shift across the week has 0h drift; verify rest still holds (e.g. >12h shift durations)
          const testAssignments = { ...row.assignments };
          for (const w of workDays) {
            testAssignments[WEEK_DAYS[w.dayIdx]] = {
              dayKey: WEEK_DAYS[w.dayIdx],
              status: 'WORK',
              shiftId: targetSh.id,
              breaks: null,
            };
          }
          const minRest = getMinimumWeeklyRestHours(testAssignments, shiftMap);
          if (minRest !== null && minRest < rules.minInterShiftRestHours - 1e-6) continue;

          const delta = computeDeltaCost(mutations);
          if (delta < bestDelta) {
            bestDelta = delta;
            bestAnchorShift = targetSh;
            bestMutations = mutations;
          }
        }

        if (bestAnchorShift && bestMutations) {
          applyMutationsToMatrices(bestMutations);
          for (const w of workDays) {
            row.assignments[WEEK_DAYS[w.dayIdx]].shiftId = bestAnchorShift.id;
          }
          improved = true;
        }
      }
    }

    // Move 4: Pairwise 2-Agent Kempe Relay Swap on Same Day (Breaks Drift-Band Locks in O(S^3))
    // Example: Agent A moves 08:00 -> 10:00 while Agent B moves 10:00 -> 12:00 simultaneously
    for (let dIdx = 0; dIdx < 7; dIdx++) {
      const dk = WEEK_DAYS[dIdx];
      const dayCands = getAllowedShiftsOnDay(dIdx);
      if (dayCands.length < 3) continue;

      let keepRelaying = true;
      for (let chain = 0; chain < 12 && keepRelaying; chain++) {
        keepRelaying = false;
        const byShift = new Map<string, number[]>();
        for (const rosterIdx of autoActiveIndices) {
          const a = draftRows[rosterIdx].assignments[dk];
          if (a.status !== 'WORK' || !a.shiftId) continue;
          let list = byShift.get(a.shiftId);
          if (!list) {
            list = [];
            byShift.set(a.shiftId, list);
          }
          list.push(rosterIdx);
        }

        let bestSwap: {
          idxA: number;
          idxB: number;
          shA: ShiftTemplate;
          bridge: ShiftTemplate;
          shBTo: ShiftTemplate;
        } | null = null;
        let bestRelayDelta = -0.15;

        for (const shA of dayCands) {
          const poolA = byShift.get(shA.id);
          if (!poolA || poolA.length === 0) continue;
          for (const bridge of dayCands) {
            if (bridge.id === shA.id) continue;
            const poolBridge = byShift.get(bridge.id);
            if (!poolBridge || poolBridge.length === 0) continue;

            // Find first Auto agent on shA that can legally switch to bridge on dIdx
            let feasibleA = -1;
            for (const rIdx of poolA) {
              if (isCandidateShiftFeasible(draftRows[rIdx], dIdx, bridge)) {
                feasibleA = rIdx;
                break;
              }
            }
            if (feasibleA < 0) continue;

            for (const shBTo of dayCands) {
              if (shBTo.id === bridge.id || shBTo.id === shA.id) continue;
              let feasibleB = -1;
              for (const rIdx of poolBridge) {
                if (isCandidateShiftFeasible(draftRows[rIdx], dIdx, shBTo)) {
                  feasibleB = rIdx;
                  break;
                }
              }
              if (feasibleB < 0) continue;

              const dCost = computeDeltaCost([
                { dayIdx: dIdx, oldShift: shA, newShift: bridge },
                { dayIdx: dIdx, oldShift: bridge, newShift: shBTo },
              ]);
              if (dCost < bestRelayDelta) {
                bestRelayDelta = dCost;
                bestSwap = { idxA: feasibleA, idxB: feasibleB, shA, bridge, shBTo };
              }
            }
          }
        }

        if (bestSwap) {
          applyMutationsToMatrices([
            { dayIdx: dIdx, oldShift: bestSwap.shA, newShift: bestSwap.bridge },
            { dayIdx: dIdx, oldShift: bestSwap.bridge, newShift: bestSwap.shBTo },
          ]);
          draftRows[bestSwap.idxA].assignments[dk].shiftId = bestSwap.bridge.id;
          draftRows[bestSwap.idxB].assignments[dk].shiftId = bestSwap.shBTo.id;
          improved = true;
          keepRelaying = true;
        }
      }
    }

    if (!improved) break;
  }

  // 5D. Hard Exact Reconciliation for Explicit Daily Cell Overrides & Locked Mon..Thu Targets
  if (dayOverridesMap.size > 0 && activeIndices.length > 0) {
    const N = activeIndices.length;
    const allDaysFullyLocked =
      WEEK_DAYS.every((_, dIdx) => catalogToUse.every((sh) => dayOverridesMap.get(sh.id)?.has(dIdx))) &&
      catalogToUse.length > 0;

    const lockedTargets: Map<string, number>[] = WEEK_DAYS.map((_, dIdx) => {
      const m = new Map<string, number>();
      let sum = 0;
      for (const sh of catalogToUse) {
        const tgt = dayOverridesMap.get(sh.id)?.get(dIdx);
        if (tgt !== undefined) {
          const clean = Math.max(0, Math.min(N, tgt));
          m.set(sh.id, clean);
          sum += clean;
        }
      }
      if (!allDaysFullyLocked && sum > N) {
        const scale = N / sum;
        let remCap = N;
        const entries = [...m.entries()].sort((a, b) => {
          const aExp = explicitCellOverridesMap.get(a[0])?.has(dIdx) ? 1 : 0;
          const bExp = explicitCellOverridesMap.get(b[0])?.has(dIdx) ? 1 : 0;
          return bExp - aExp || b[1] - a[1];
        });
        for (let idx = 0; idx < entries.length; idx++) {
          const [shId, val] = entries[idx];
          const alloc = idx === entries.length - 1 ? Math.min(val, remCap) : Math.min(val, remCap, Math.round(val * scale));
          m.set(shId, alloc);
          remCap = Math.max(0, remCap - alloc);
        }
      }
      return m;
    });

    const isIsoOvernightComp = (sh: ShiftTemplate): boolean => {
      const compId = catalogCompMap.get(sh.id);
      const compMembers = catalogToUse.filter((c) => catalogCompMap.get(c.id) === compId);
      const distinctComps = new Set(catalogToUse.map((c) => catalogCompMap.get(c.id)));
      return distinctComps.size > 1 && compMembers.every((c) => isOvernightShiftWindow(c));
    };

    const polishSameDayViolations = (preserveAllDayCounts: boolean) => {
      const rowPenalty = (row: ScheduledAgentRow): { hard: number; score: number } => {
        const val = validateAgentScheduleRow(row, catalogToUse, rules);
        const driftOver = Math.max(0, val.shiftBandSpanHours - rules.maxWeeklyStartDriftHours);
        const restDeficit =
          val.minRestHoursObserved !== null ? Math.max(0, rules.minInterShiftRestHours - val.minRestHoursObserved) : 0;
        const hard = val.violations.length;
        const score = hard * 10000 + driftOver * 100 + restDeficit * 100 + val.shiftBandSpanHours * 0.25;
        return { hard, score };
      };

      const isShiftSwapCountAllowed = (dIdx: number, shFrom: string, shTo: string): boolean => {
        if (preserveAllDayCounts) return true; // 1-to-1 same-day swaps preserve all daily shift counts
        const fLock = lockedTargets[dIdx].get(shFrom);
        const tLock = lockedTargets[dIdx].get(shTo);
        if (fLock === undefined && tLock === undefined) return true;
        return false;
      };

      for (let pass = 0; pass < 12; pass++) {
        let improved = false;
        // 1-hop same-day swaps preserving daily counts per shift
        for (const rA of activeIndices) {
          const rowA = draftRows[rA];
          const penA0 = rowPenalty(rowA);
          if (penA0.hard === 0) continue;

          for (let dIdx = 0; dIdx < 7; dIdx++) {
            const dk = WEEK_DAYS[dIdx];
            const aA = rowA.assignments[dk];
            if (aA.status !== 'WORK' || !aA.shiftId) continue;
            const sA = aA.shiftId;

            let bestSwap: { rB: number; sB: string; gain: number } | null = null;
            for (const rB of activeIndices) {
              if (rB === rA) continue;
              const rowB = draftRows[rB];
              const aB = rowB.assignments[dk];
              if (aB.status !== 'WORK' || !aB.shiftId || aB.shiftId === sA) continue;
              const sB = aB.shiftId;
              if (!isShiftSwapCountAllowed(dIdx, sA, sB)) continue;

              const penB0 = rowPenalty(rowB);
              aA.shiftId = sB;
              aB.shiftId = sA;
              const penA1 = rowPenalty(rowA);
              const penB1 = rowPenalty(rowB);
              aA.shiftId = sA;
              aB.shiftId = sB;

              const hardBefore = penA0.hard + penB0.hard;
              const hardAfter = penA1.hard + penB1.hard;
              const scoreGain = penA0.score + penB0.score - (penA1.score + penB1.score);
              if (hardAfter < hardBefore || (hardAfter === hardBefore && scoreGain > 0.05 && penB1.hard <= penB0.hard)) {
                if (!bestSwap || scoreGain > bestSwap.gain) {
                  bestSwap = { rB, sB, gain: scoreGain };
                }
              }
            }

            if (bestSwap) {
              rowA.assignments[dk].shiftId = bestSwap.sB;
              draftRows[bestSwap.rB].assignments[dk].shiftId = sA;
              improved = true;
              break;
            }
          }
        }

        // 2-hop cyclic same-day relays for any remaining violating agent (rA -> rB -> rC -> rA)
        for (const rA of activeIndices) {
          const rowA = draftRows[rA];
          const penA0 = rowPenalty(rowA);
          if (penA0.hard === 0) continue;

          let cycleFixed = false;
          for (let dIdx = 0; dIdx < 7 && !cycleFixed; dIdx++) {
            const dk = WEEK_DAYS[dIdx];
            const aA = rowA.assignments[dk];
            if (aA.status !== 'WORK' || !aA.shiftId) continue;
            const sA = aA.shiftId;

            for (const rB of activeIndices) {
              if (rB === rA) continue;
              const rowB = draftRows[rB];
              const aB = rowB.assignments[dk];
              if (aB.status !== 'WORK' || !aB.shiftId || aB.shiftId === sA) continue;
              const sB = aB.shiftId;
              const shB = shiftMap.get(sB);
              if (!shB || !isCandidateShiftFeasible(rowA, dIdx, shB)) continue;

              const penB0 = rowPenalty(rowB);
              for (const rC of activeIndices) {
                if (rC === rA || rC === rB) continue;
                const rowC = draftRows[rC];
                const aC = rowC.assignments[dk];
                if (aC.status !== 'WORK' || !aC.shiftId || aC.shiftId === sA || aC.shiftId === sB) continue;
                const sC = aC.shiftId;
                const shC = shiftMap.get(sC);
                const shA = shiftMap.get(sA);
                if (!shC || !shA) continue;
                if (!isCandidateShiftFeasible(rowB, dIdx, shC) || !isCandidateShiftFeasible(rowC, dIdx, shA)) continue;
                const penC0 = rowPenalty(rowC);
                if (penB0.hard > 0 || penC0.hard > 0) continue;

                aA.shiftId = sB;
                aB.shiftId = sC;
                aC.shiftId = sA;
                cycleFixed = true;
                improved = true;
                break;
              }
              if (cycleFixed) break;
            }
          }
        }

        if (!improved) break;
      }
    };

    if (allDaysFullyLocked && rules.maxWorkdaysPerWeek === 5) {
      // Exact C7 Polytope Projection + Zero-Violation Constructive Roster Reconciliation
      const dayTotals = (targets: Map<string, number>[]): number[] =>
        targets.map((m) => {
          let s = 0;
          for (const v of m.values()) s += v;
          return s;
        });

      const offPatternCountsFromW = (W: number[]): number[] =>
        Array.from({ length: 7 }, (_, k) => W[(k + 2) % 7] + W[(k + 4) % 7] + W[(k + 6) % 7] - 2 * N);

      const polytopeViolation = (W: number[]): number => {
        const sumW = W.reduce((a, b) => a + b, 0);
        let viol = Math.abs(sumW - 5 * N) * 100;
        for (let d = 0; d < 7; d++) {
          if (W[d] > N) viol += (W[d] - N) * 100;
          if (W[d] < 0) viol += -W[d] * 100;
        }
        if (sumW === 5 * N) {
          const x = offPatternCountsFromW(W);
          for (let k = 0; k < 7; k++) {
            if (k === 6 && !rules.allowSunMonSplitOff) {
              viol += Math.abs(x[6]) * 10;
            } else if (x[k] < 0) {
              viol += -x[k] * 10;
            }
          }
        }
        return viol;
      };

      const cellEditCost = (sh: ShiftTemplate, dIdx: number, currVal: number, delta: number): number => {
        const isExplicit = explicitCellOverridesMap.get(sh.id)?.has(dIdx) ?? false;
        if (isExplicit) return 10000 + Math.abs(currVal - 5) * 0.01;
        if (isIsoOvernightComp(sh) || isOvernightShiftWindow(sh)) return 50;
        if (delta < 0 && currVal <= 1) return 15;
        return 1 + (currVal > 2 ? 0 : 0.2);
      };

      // Project lockedTargets onto feasible {sum W_d = 5N, x_k >= 0} preferring non-explicit grey cells
      for (let guard = 0; guard < N * 14; guard++) {
        const W = dayTotals(lockedTargets);
        const v0 = polytopeViolation(W);
        if (v0 === 0) break;

        const sumW = W.reduce((a, b) => a + b, 0);
        let bestMove: {
          kind: 'single' | 'pair';
          d1: number;
          s1: string;
          delta1: number;
          d2?: number;
          s2?: string;
          delta2?: number;
          tierCost: number;
          vAfter: number;
        } | null = null;

        const considerMove = (
          cand: {
            kind: 'single' | 'pair';
            d1: number;
            s1: string;
            delta1: number;
            d2?: number;
            s2?: string;
            delta2?: number;
            tierCost: number;
            vAfter: number;
          }
        ) => {
          if (cand.vAfter >= v0) return;
          if (
            !bestMove ||
            Math.floor(cand.tierCost / 100) < Math.floor(bestMove.tierCost / 100) ||
            (Math.floor(cand.tierCost / 100) === Math.floor(bestMove.tierCost / 100) &&
              (cand.vAfter < bestMove.vAfter || (cand.vAfter === bestMove.vAfter && cand.tierCost < bestMove.tierCost)))
          ) {
            bestMove = cand;
          }
        };

        if (sumW !== 5 * N || W.some((w) => w > N)) {
          const needSign = sumW > 5 * N || W.some((w) => w > N) ? -1 : 1;
          for (let d = 0; d < 7; d++) {
            const delta = needSign;
            if (delta < 0 && W[d] <= 0) continue;
            if (delta > 0 && W[d] >= N) continue;
            for (const sh of catalogToUse) {
              const curr = lockedTargets[d].get(sh.id) ?? 0;
              if (curr + delta < 0 || curr + delta > N) continue;
              const W2 = [...W];
              W2[d] += delta;
              const vAfter = polytopeViolation(W2);
              const tierCost = cellEditCost(sh, d, curr, delta);
              considerMove({ kind: 'single', d1: d, s1: sh.id, delta1: delta, tierCost, vAfter });
            }
          }
        } else {
          for (let dFrom = 0; dFrom < 7; dFrom++) {
            if (W[dFrom] <= 0) continue;
            for (let dTo = 0; dTo < 7; dTo++) {
              if (dTo === dFrom || W[dTo] >= N) continue;
              const W2 = [...W];
              W2[dFrom] -= 1;
              W2[dTo] += 1;
              const vAfter = polytopeViolation(W2);
              if (vAfter >= v0) continue;

              // Find minimum-cost cell pair in dFrom (-1) and dTo (+1)
              let bestFrom: { shId: string; cost: number } | null = null;
              let bestTo: { shId: string; cost: number } | null = null;
              for (const sh of catalogToUse) {
                const cFrom = lockedTargets[dFrom].get(sh.id) ?? 0;
                if (cFrom > 0) {
                  const costF = cellEditCost(sh, dFrom, cFrom, -1);
                  if (!bestFrom || costF < bestFrom.cost) bestFrom = { shId: sh.id, cost: costF };
                }
                const cTo = lockedTargets[dTo].get(sh.id) ?? 0;
                if (cTo < N) {
                  const costT = cellEditCost(sh, dTo, cTo, 1);
                  if (!bestTo || costT < bestTo.cost) bestTo = { shId: sh.id, cost: costT };
                }
              }
              if (bestFrom && bestTo) {
                considerMove({
                  kind: 'pair',
                  d1: dFrom,
                  s1: bestFrom.shId,
                  delta1: -1,
                  d2: dTo,
                  s2: bestTo.shId,
                  delta2: 1,
                  tierCost: bestFrom.cost + bestTo.cost,
                  vAfter,
                });
              }
            }
          }
        }

        if (!bestMove) break;
        const chosenMove = bestMove as {
          kind: 'single' | 'pair';
          d1: number;
          s1: string;
          delta1: number;
          d2?: number;
          s2?: string;
          delta2?: number;
        };
        lockedTargets[chosenMove.d1].set(chosenMove.s1, (lockedTargets[chosenMove.d1].get(chosenMove.s1) ?? 0) + chosenMove.delta1);
        if (chosenMove.kind === 'pair' && chosenMove.d2 !== undefined && chosenMove.s2 !== undefined && chosenMove.delta2 !== undefined) {
          lockedTargets[chosenMove.d2].set(
            chosenMove.s2,
            (lockedTargets[chosenMove.d2].get(chosenMove.s2) ?? 0) + chosenMove.delta2
          );
        }
      }

      const finalW = dayTotals(lockedTargets);
      const finalV = polytopeViolation(finalW);
      if (finalV === 0) {
        const x = offPatternCountsFromW(finalW);
        // Build agent slots with exact valid OFF pattern k in 0..6
        const slotOffK: number[] = [];
        const slotWorkMask: boolean[][] = [];
        const slotAssigned: (string | null)[][] = [];
        const slotPartialOvRelief: boolean[] = [];

        for (let k = 0; k < 7; k++) {
          const o1 = k;
          const o2 = (k + 1) % 7;
          for (let c = 0; c < x[k]; c++) {
            slotOffK.push(k);
            slotWorkMask.push(WEEK_DAYS.map((_, d) => d !== o1 && d !== o2));
            slotAssigned.push(new Array<string | null>(7).fill(null));
            slotPartialOvRelief.push(false);
          }
        }

        const remByDay: Map<string, number>[] = lockedTargets.map((m) => new Map(m));

        // 1) Allocate isolated overnight shifts cleanly (full 5d blocks + contiguous post-OFF relief blocks)
        const isolatedOvShifts = catalogToUse.filter((sh) => isIsoOvernightComp(sh));
        for (const ovSh of isolatedOvShifts) {
          const ovRem = remByDay.map((m) => m.get(ovSh.id) ?? 0);
          const countPositive = (arr: number[]) => arr.filter((v) => v > 0).length;

          // 1A: Full 5-day isolated overnight agents
          while (countPositive(ovRem) >= 5) {
            let bestSlot = -1;
            let bestScore = -Infinity;
            for (let sIdx = 0; sIdx < slotOffK.length; sIdx++) {
              if (slotAssigned[sIdx].some((v) => v !== null)) continue;
              const workDays = [0, 1, 2, 3, 4, 5, 6].filter((d) => slotWorkMask[sIdx][d]);
              if (!workDays.every((d) => ovRem[d] > 0)) continue;

              const after = [...ovRem];
              for (const d of workDays) after[d] -= 1;
              // Prefer leaving remaining days aligned right after available (k+2)%7 OFF starts
              let score = 0;
              for (let other = 0; other < slotOffK.length; other++) {
                if (other === sIdx || slotAssigned[other].some((v) => v !== null)) continue;
                const dStart = (slotOffK[other] + 2) % 7;
                if (after[dStart] > 0) score += 20;
              }
              if (score > bestScore) {
                bestScore = score;
                bestSlot = sIdx;
              }
            }
            if (bestSlot === -1) break;
            for (let d = 0; d < 7; d++) {
              if (slotWorkMask[bestSlot][d]) {
                slotAssigned[bestSlot][d] = ovSh.id;
                ovRem[d] -= 1;
              }
            }
          }

          // 1B: Partial isolated overnight relief agents starting immediately after their 2 OFF days ((k+2)%7)
          while (ovRem.some((v) => v > 0)) {
            let bestPlan: { sIdx: number; days: number[]; len: number } | null = null;
            for (let sIdx = 0; sIdx < slotOffK.length; sIdx++) {
              if (slotAssigned[sIdx].some((v) => v !== null)) continue;
              const k = slotOffK[sIdx];
              const dStart = (k + 2) % 7;
              if (ovRem[dStart] <= 0) continue;
              const days: number[] = [];
              for (let off = 0; off < 5; off++) {
                const dd = (dStart + off) % 7;
                if (!slotWorkMask[sIdx][dd] || ovRem[dd] <= 0) break;
                days.push(dd);
              }
              if (days.length > 0 && (!bestPlan || days.length > bestPlan.len)) {
                bestPlan = { sIdx, days, len: days.length };
              }
            }
            if (!bestPlan) {
              // Fallback: place remaining ovRem days on any compatible unassigned agent slot (rest >= 12h)
              const dLeft = ovRem.findIndex((v) => v > 0);
              if (dLeft === -1) break;
              const prevDay = (dLeft + 6) % 7;
              const fallbackIdx = slotOffK.findIndex(
                (_, sIdx) =>
                  slotWorkMask[sIdx][dLeft] &&
                  slotAssigned[sIdx][dLeft] === null &&
                  !slotWorkMask[sIdx][prevDay] // preceded by OFF day guarantees rest >= 12h
              );
              const anyIdx =
                fallbackIdx !== -1
                  ? fallbackIdx
                  : slotOffK.findIndex((_, sIdx) => slotWorkMask[sIdx][dLeft] && slotAssigned[sIdx][dLeft] === null);
              if (anyIdx === -1) break;
              bestPlan = { sIdx: anyIdx, days: [dLeft], len: 1 };
            }

            for (const dd of bestPlan.days) {
              slotAssigned[bestPlan.sIdx][dd] = ovSh.id;
              ovRem[dd] -= 1;
            }
            if (bestPlan.len < 5) {
              slotPartialOvRelief[bestPlan.sIdx] = true;
            }
          }

          for (let d = 0; d < 7; d++) {
            remByDay[d].set(ovSh.id, ovRem[d]);
          }
        }

        // 2) Assign stratified fractional rank across remaining OFF cohorts (relief agents earliest)
        const cohortIndices = Array.from({ length: 7 }, () => [] as number[]);
        const reliefSlots: number[] = [];
        for (let sIdx = 0; sIdx < slotOffK.length; sIdx++) {
          if (slotPartialOvRelief[sIdx]) {
            reliefSlots.push(sIdx);
          } else if (slotWorkMask[sIdx].some((w, d) => w && slotAssigned[sIdx][d] === null)) {
            cohortIndices[slotOffK[sIdx]].push(sIdx);
          }
        }
        const rankedDaytimeSlots: { sIdx: number; frac: number }[] = reliefSlots.map((sIdx, i) => ({
          sIdx,
          frac: -1 + i * 0.001,
        }));
        for (let k = 0; k < 7; k++) {
          const list = cohortIndices[k];
          for (let j = 0; j < list.length; j++) {
            rankedDaytimeSlots.push({
              sIdx: list[j],
              frac: (j + 0.5) / list.length + k * 1e-6,
            });
          }
        }
        rankedDaytimeSlots.sort((a, b) => a.frac - b.frac);

        // 3) Chronological shift matching per day against remaining daytime targets
        const daytimeCatalog = catalogToUse.filter((sh) => !isIsoOvernightComp(sh));
        for (let dIdx = 0; dIdx < 7; dIdx++) {
          const daySlots = rankedDaytimeSlots
            .map((e) => e.sIdx)
            .filter((sIdx) => slotWorkMask[sIdx][dIdx] && slotAssigned[sIdx][dIdx] === null);

          let cursor = 0;
          for (const sh of daytimeCatalog) {
            const cnt = remByDay[dIdx].get(sh.id) ?? 0;
            for (let q = 0; q < cnt && cursor < daySlots.length; q++) {
              slotAssigned[daySlots[cursor++]][dIdx] = sh.id;
            }
          }
          // Defensive safety fill if any residual slot remained
          for (; cursor < daySlots.length; cursor++) {
            const fallbackSh = daytimeCatalog[0] ?? catalogToUse[0];
            slotAssigned[daySlots[cursor]][dIdx] = fallbackSh.id;
          }
        }

        // Write clean constructive slots directly onto draftRows
        for (let pos = 0; pos < N; pos++) {
          const rIdx = activeIndices[pos];
          const row = draftRows[rIdx];
          for (let dIdx = 0; dIdx < 7; dIdx++) {
            const dk = WEEK_DAYS[dIdx];
            const shId = slotAssigned[pos][dIdx];
            if (!slotWorkMask[pos][dIdx] || !shId) {
              row.assignments[dk] = { dayKey: dk, status: 'OFF', shiftId: null, breaks: null };
            } else {
              row.assignments[dk] = { dayKey: dk, status: 'WORK', shiftId: shId, breaks: null };
            }
          }
        }

        // Synchronize shiftDayCounts from constructed draftRows and polish any remaining band/rest mismatch via same-day swaps
        for (const sh of catalogToUse) shiftDayCounts.set(sh.id, new Array<number>(7).fill(0));
        for (const rIdx of activeIndices) {
          for (let dIdx = 0; dIdx < 7; dIdx++) {
            const a = draftRows[rIdx].assignments[WEEK_DAYS[dIdx]];
            if (a.status === 'WORK' && a.shiftId) shiftDayCounts.get(a.shiftId)![dIdx] += 1;
          }
        }
        polishSameDayViolations(true);
      }
    } else {
      // Partial / Unbalanced Daily Locks: Strictly rule-safe multi-hop same-day BFS + valid cross-day swaps (NEVER break 5d/OFF/band/rest)
      const offSetKeys = new Set(offPatterns.map((p) => `${p[0]}-${p[1]}`));
      const isOffPairValidAfterFlip = (row: ScheduledAgentRow, makeWorkDay: number, makeOffDay: number): boolean => {
        const offs: number[] = [];
        for (let d = 0; d < 7; d++) {
          const wasOff = row.assignments[WEEK_DAYS[d]].status === 'OFF';
          const isOffNow = d === makeOffDay || (wasOff && d !== makeWorkDay);
          if (isOffNow) offs.push(d);
        }
        return offs.length === 2 && offSetKeys.has(`${offs[0]}-${offs[1]}`);
      };

      const moveAgentShiftSameDay = (rIdx: number, dIdx: number, oldId: string, newId: string) => {
        draftRows[rIdx].assignments[WEEK_DAYS[dIdx]].shiftId = newId;
        shiftDayCounts.get(oldId)![dIdx] -= 1;
        shiftDayCounts.get(newId)![dIdx] += 1;
      };

      const runSameDayBfsTransfer = (dIdx: number, underShId: string): boolean => {
        const dk = WEEK_DAYS[dIdx];
        const dayLocks = lockedTargets[dIdx];
        // Backward BFS from underShId along valid (donor -> nextShift) edges
        const visitedShift = new Set<string>([underShId]);
        const queue: string[] = [underShId];
        const nextEdge = new Map<string, { rIdx: number; nextShId: string }>();

        while (queue.length > 0) {
          const targetId = queue.shift()!;
          const targetSh = shiftMap.get(targetId);
          if (!targetSh) continue;

          for (const rIdx of activeIndices) {
            const row = draftRows[rIdx];
            const a = row.assignments[dk];
            if (a.status !== 'WORK' || !a.shiftId || visitedShift.has(a.shiftId)) continue;
            if (!isCandidateShiftFeasible(row, dIdx, targetSh)) continue;

            const srcId = a.shiftId;
            nextEdge.set(srcId, { rIdx, nextShId: targetId });
            const srcCnt = shiftDayCounts.get(srcId)?.[dIdx] ?? 0;
            const srcLock = dayLocks.get(srcId);
            if (srcLock === undefined || srcCnt > srcLock) {
              // Found valid surplus/unlocked source shift -> apply chain forward to underShId
              let cur = srcId;
              while (cur !== underShId) {
                const step = nextEdge.get(cur)!;
                moveAgentShiftSameDay(step.rIdx, dIdx, cur, step.nextShId);
                cur = step.nextShId;
              }
              return true;
            }
            visitedShift.add(srcId);
            queue.push(srcId);
          }
        }
        return false;
      };

      const reconcileSameDayDeficits = () => {
        for (let dIdx = 0; dIdx < 7; dIdx++) {
          const dayLocks = lockedTargets[dIdx];
          if (dayLocks.size === 0) continue;
          for (const [shId, tgt] of dayLocks.entries()) {
            while ((shiftDayCounts.get(shId)?.[dIdx] ?? 0) < tgt) {
              if (!runSameDayBfsTransfer(dIdx, shId)) break;
            }
          }
        }
      };

      // Pass 1: Same-day strictly feasible multi-hop transfers
      reconcileSameDayDeficits();

      // Pass 2: Cross-day swap preserving 5 workdays/week + valid OFF pair + rule-feasible target shift
      const unlockedShiftsForDay = (dIdx: number) =>
        catalogToUse.filter(
          (sh) => !lockedTargets[dIdx].has(sh.id) || (shiftDayCounts.get(sh.id)?.[dIdx] ?? 0) < (lockedTargets[dIdx].get(sh.id) ?? 0)
        );

      for (let step = 0; step < N * 4; step++) {
        let swapped = false;

        // 2A: Fix deficit locked cells by swapping an OFF workday on the same agent from a surplus/unlocked day
        for (let dNeed = 0; dNeed < 7 && !swapped; dNeed++) {
          for (const [shId, tgt] of lockedTargets[dNeed].entries()) {
            if ((shiftDayCounts.get(shId)?.[dNeed] ?? 0) >= tgt) continue;
            const shNeed = shiftMap.get(shId);
            if (!shNeed) continue;

            for (const rIdx of activeIndices) {
              const row = draftRows[rIdx];
              if (row.assignments[WEEK_DAYS[dNeed]].status !== 'OFF') continue;

              for (let dGive = 0; dGive < 7; dGive++) {
                if (dGive === dNeed) continue;
                const aGive = row.assignments[WEEK_DAYS[dGive]];
                if (aGive.status !== 'WORK' || !aGive.shiftId) continue;
                const giveTgt = lockedTargets[dGive].get(aGive.shiftId);
                const giveCnt = shiftDayCounts.get(aGive.shiftId)?.[dGive] ?? 0;
                if (giveTgt !== undefined && giveCnt <= giveTgt) continue;
                if (!isOffPairValidAfterFlip(row, dNeed, dGive)) continue;

                const testAssign: Record<DayKey, AgentDayAssignment> = {
                  ...row.assignments,
                  [WEEK_DAYS[dGive]]: { dayKey: WEEK_DAYS[dGive], status: 'OFF', shiftId: null, breaks: null },
                };
                if (!isCandidateShiftFeasible(row, dNeed, shNeed, testAssign)) continue;

                row.assignments[WEEK_DAYS[dGive]] = { dayKey: WEEK_DAYS[dGive], status: 'OFF', shiftId: null, breaks: null };
                row.assignments[WEEK_DAYS[dNeed]] = { dayKey: WEEK_DAYS[dNeed], status: 'WORK', shiftId: shNeed.id, breaks: null };
                shiftDayCounts.get(aGive.shiftId)![dGive] -= 1;
                shiftDayCounts.get(shNeed.id)![dNeed] += 1;
                swapped = true;
                break;
              }
              if (swapped) break;
            }
            if (swapped) break;
          }
        }

        if (swapped) continue;

        // 2B: Fix excess locked cells by shifting that workday onto an under-target or unlocked day
        for (let dOver = 0; dOver < 7 && !swapped; dOver++) {
          for (const [shId, tgt] of lockedTargets[dOver].entries()) {
            if ((shiftDayCounts.get(shId)?.[dOver] ?? 0) <= tgt) continue;

            for (const rIdx of activeIndices) {
              const row = draftRows[rIdx];
              const aOver = row.assignments[WEEK_DAYS[dOver]];
              if (aOver.status !== 'WORK' || aOver.shiftId !== shId) continue;

              for (let dNeed = 0; dNeed < 7; dNeed++) {
                if (dNeed === dOver) continue;
                if (row.assignments[WEEK_DAYS[dNeed]].status !== 'OFF') continue;
                if (!isOffPairValidAfterFlip(row, dNeed, dOver)) continue;

                const testAssign: Record<DayKey, AgentDayAssignment> = {
                  ...row.assignments,
                  [WEEK_DAYS[dOver]]: { dayKey: WEEK_DAYS[dOver], status: 'OFF', shiftId: null, breaks: null },
                };

                const cands = unlockedShiftsForDay(dNeed).sort((a, b) => {
                  const aDef = (lockedTargets[dNeed].get(a.id) ?? -1) - (shiftDayCounts.get(a.id)?.[dNeed] ?? 0);
                  const bDef = (lockedTargets[dNeed].get(b.id) ?? -1) - (shiftDayCounts.get(b.id)?.[dNeed] ?? 0);
                  return (
                    (bDef > 0 ? 1 : 0) - (aDef > 0 ? 1 : 0) ||
                    (isOvernightShiftWindow(a) ? 1 : 0) - (isOvernightShiftWindow(b) ? 1 : 0)
                  );
                });
                const chosen = cands.find((cand) => isCandidateShiftFeasible(row, dNeed, cand, testAssign));
                if (!chosen) continue;

                row.assignments[WEEK_DAYS[dOver]] = { dayKey: WEEK_DAYS[dOver], status: 'OFF', shiftId: null, breaks: null };
                row.assignments[WEEK_DAYS[dNeed]] = { dayKey: WEEK_DAYS[dNeed], status: 'WORK', shiftId: chosen.id, breaks: null };
                shiftDayCounts.get(shId)![dOver] -= 1;
                shiftDayCounts.get(chosen.id)![dNeed] += 1;
                swapped = true;
                break;
              }
              if (swapped) break;
            }
            if (swapped) break;
          }
        }

        if (!swapped) break;
      }

      // Final pass to mop up any remaining same-day cascades opened by cross-day swaps & polish violations
      reconcileSameDayDeficits();
      polishSameDayViolations(false);
    }

    // Synchronize gross15 and shiftDayCounts cleanly from reconciled draftRows before Break Staggering
    for (let d = 0; d < 7; d++) gross15[d].fill(0);
    for (const sh of catalogToUse) shiftDayCounts.set(sh.id, new Array<number>(7).fill(0));
    for (const rIdx of activeIndices) {
      for (let dIdx = 0; dIdx < 7; dIdx++) {
        const a = draftRows[rIdx].assignments[WEEK_DAYS[dIdx]];
        if (a.status === 'WORK' && a.shiftId) {
          const sh = shiftMap.get(a.shiftId);
          if (sh) {
            shiftDayCounts.get(sh.id)![dIdx] += 1;
            for (const pos of getShiftSlotsForDay(sh, dIdx)) {
              gross15[pos.dayIdx][pos.qIdx] += 1;
            }
          }
        }
      }
    }
  }

  // 6. Assign Staggered 15-Min Breaks (First 15 + Lunch 30 + Last 15) with Quadratic Concurrency Smoothing & 1-Opt Polish
  const liveSurplus15: number[][] = Array.from({ length: 7 }, (_, d) =>
    Array.from({ length: 96 }, (__, q) => gross15[d][q] - req15[d][q])
  );
  const breakLoad15: number[][] = Array.from({ length: 7 }, () => new Array(96).fill(0));

  for (let dIdx = 0; dIdx < 7; dIdx++) {
    const dk = WEEK_DAYS[dIdx];
    const nextSurplus = liveSurplus15[(dIdx + 1) % 7];
    const nextBreakLoad = breakLoad15[(dIdx + 1) % 7];
    const workingToday = activeIndices
      .filter((rIdx) => draftRows[rIdx].assignments[dk].status === 'WORK')
      .sort((a, b) => {
        const sA = shiftMap.get(draftRows[a].assignments[dk].shiftId ?? '')?.startMin ?? 0;
        const sB = shiftMap.get(draftRows[b].assignments[dk].shiftId ?? '')?.startMin ?? 0;
        return sA - sB || a - b;
      });
    for (const rosterIdx of workingToday) {
      const assign = draftRows[rosterIdx].assignments[dk];
      const shift = assign.shiftId ? shiftMap.get(assign.shiftId) : null;
      if (!shift) continue;
      const breaks = assignOptimalBreaksForShift(
        shift,
        liveSurplus15[dIdx],
        rules.breakRules,
        nextSurplus,
        breakLoad15[dIdx],
        nextBreakLoad
      );
      assign.breaks = breaks;
      applyBreaksToArray15(liveSurplus15, shift, dIdx, breaks, rules.breakRules, -1);
      applyBreaksToArray15(breakLoad15, shift, dIdx, breaks, rules.breakRules, 1);
    }

    // 1-Opt Break Re-Staggering Polish Pass so early agents react to later agents' concurrency
    for (const rosterIdx of workingToday) {
      const assign = draftRows[rosterIdx].assignments[dk];
      const shift = assign.shiftId ? shiftMap.get(assign.shiftId) : null;
      if (!shift || !assign.breaks) continue;
      applyBreaksToArray15(liveSurplus15, shift, dIdx, assign.breaks, rules.breakRules, 1);
      applyBreaksToArray15(breakLoad15, shift, dIdx, assign.breaks, rules.breakRules, -1);
      const refreshed = assignOptimalBreaksForShift(
        shift,
        liveSurplus15[dIdx],
        rules.breakRules,
        nextSurplus,
        breakLoad15[dIdx],
        nextBreakLoad
      );
      assign.breaks = refreshed;
      applyBreaksToArray15(liveSurplus15, shift, dIdx, refreshed, rules.breakRules, -1);
      applyBreaksToArray15(breakLoad15, shift, dIdx, refreshed, rules.breakRules, 1);
    }
  }

  // 7. Closed-Loop Break-Coupled Net Shift Polish (Uses ACTUAL gross15 - breakLoad15 vs req15)
  const actualNet15: number[][] = Array.from({ length: 7 }, (_, d) =>
    Array.from({ length: 96 }, (__, q) => gross15[d][q] - breakLoad15[d][q])
  );
  for (let dIdx = 0; dIdx < 7; dIdx++) {
    const dk = WEEK_DAYS[dIdx];
    const nextSurplus = liveSurplus15[(dIdx + 1) % 7];
    const nextBreakLoad = breakLoad15[(dIdx + 1) % 7];
    for (const rosterIdx of autoActiveIndices) {
      const row = draftRows[rosterIdx];
      const assign = row.assignments[dk];
      if (assign.status !== 'WORK' || !assign.shiftId || !assign.breaks) continue;
      const oldShift = shiftMap.get(assign.shiftId);
      if (!oldShift) continue;
      const oldDayTgt = dayOverridesMap.get(oldShift.id)?.get(dIdx);
      if (oldDayTgt !== undefined && (shiftDayCounts.get(oldShift.id)?.[dIdx] ?? 0) <= oldDayTgt) continue;

      const dayCands = getAllowedShiftsOnDay(dIdx, oldShift.id);
      if (dayCands.length <= 1) continue;

      // Temporarily lift old shift + old breaks to evaluate true net cost cleanly
      const oldBreaks = assign.breaks;
      const oldGrossSlots = getShiftSlotsForDay(oldShift, dIdx);
      for (const pos of oldGrossSlots) {
        gross15[pos.dayIdx][pos.qIdx] -= 1;
        actualNet15[pos.dayIdx][pos.qIdx] -= 1;
        liveSurplus15[pos.dayIdx][pos.qIdx] -= 1;
      }
      applyBreaksToArray15(breakLoad15, oldShift, dIdx, oldBreaks, rules.breakRules, -1);
      applyBreaksToArray15(liveSurplus15, oldShift, dIdx, oldBreaks, rules.breakRules, 1);
      applyBreaksToArray15(actualNet15, oldShift, dIdx, oldBreaks, rules.breakRules, 1);
      shiftDayCounts.get(oldShift.id)![dIdx] -= 1;

      const evalNetCostAfterPlace = (cand: ShiftTemplate, candBreaks: BreakAssignment): number => {
        const netSlotDelta = new Map<number, number>();
        for (const pos of getShiftSlotsForDay(cand, dIdx)) {
          const sk = pos.dayIdx * 96 + pos.qIdx;
          netSlotDelta.set(sk, (netSlotDelta.get(sk) ?? 0) + 1);
        }
        const blkList = [
          { off: candBreaks.firstBreakOffsetMin, dur: rules.breakRules.firstBreakMin },
          { off: candBreaks.lunchOffsetMin, dur: rules.breakRules.lunchMin },
          { off: candBreaks.lastBreakOffsetMin, dur: rules.breakRules.lastBreakMin },
        ];
        for (const blk of blkList) {
          const steps = Math.max(1, Math.round(blk.dur / 15));
          for (let k = 0; k < steps; k++) {
            const absMin = cand.startMin + blk.off + k * 15;
            const tD = (dIdx + Math.floor(absMin / 1440)) % 7;
            const q = Math.floor((absMin % 1440) / 15);
            const sk = tD * 96 + q;
            netSlotDelta.set(sk, (netSlotDelta.get(sk) ?? 0) - 1);
          }
        }
        let cost = 0;
        for (const [sk, dv] of netSlotDelta.entries()) {
          if (dv === 0) continue;
          const dd = Math.floor(sk / 96);
          const q = sk % 96;
          cost +=
            intervalCost(optReq15[dd][q], actualNet15[dd][q] + dv, dd, req15[dd][q]) -
            intervalCost(optReq15[dd][q], actualNet15[dd][q], dd, req15[dd][q]);
        }
        const currCnt = shiftDayCounts.get(cand.id)?.[dIdx] ?? 0;
        cost += dayOverrideCost(cand.id, dIdx, currCnt + 1) - dayOverrideCost(cand.id, dIdx, currCnt);
        return cost;
      };

      const oldCost = evalNetCostAfterPlace(oldShift, oldBreaks);
      let chosenShift = oldShift;
      let chosenBreaks = oldBreaks;
      let bestCost = oldCost - 0.1;

      for (const cand of dayCands) {
        if (cand.id === oldShift.id) continue;
        const candDayTgt = dayOverridesMap.get(cand.id)?.get(dIdx);
        if (candDayTgt !== undefined && (shiftDayCounts.get(cand.id)?.[dIdx] ?? 0) >= candDayTgt) continue;
        if (!isCandidateShiftFeasible(row, dIdx, cand)) continue;
        // Preview candidate breaks on cand without modifying live matrices permanently
        const candSlots = getShiftSlotsForDay(cand, dIdx);
        for (const pos of candSlots) liveSurplus15[pos.dayIdx][pos.qIdx] += 1;
        const previewBreaks = assignOptimalBreaksForShift(
          cand,
          liveSurplus15[dIdx],
          rules.breakRules,
          nextSurplus,
          breakLoad15[dIdx],
          nextBreakLoad
        );
        for (const pos of candSlots) liveSurplus15[pos.dayIdx][pos.qIdx] -= 1;

        const cCost = evalNetCostAfterPlace(cand, previewBreaks);
        if (cCost < bestCost) {
          bestCost = cCost;
          chosenShift = cand;
          chosenBreaks = previewBreaks;
        }
      }

      // Apply winner (either kept old or improved candidate) back onto all live matrices
      assign.shiftId = chosenShift.id;
      assign.breaks = chosenBreaks;
      shiftDayCounts.get(chosenShift.id)![dIdx] += 1;
      for (const pos of getShiftSlotsForDay(chosenShift, dIdx)) {
        gross15[pos.dayIdx][pos.qIdx] += 1;
        actualNet15[pos.dayIdx][pos.qIdx] += 1;
        liveSurplus15[pos.dayIdx][pos.qIdx] += 1;
      }
      applyBreaksToArray15(breakLoad15, chosenShift, dIdx, chosenBreaks, rules.breakRules, 1);
      applyBreaksToArray15(liveSurplus15, chosenShift, dIdx, chosenBreaks, rules.breakRules, -1);
      applyBreaksToArray15(actualNet15, chosenShift, dIdx, chosenBreaks, rules.breakRules, -1);
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
