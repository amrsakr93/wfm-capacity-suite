import React, { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ClipboardPaste,
  Download,
  Eye,
  EyeOff,
  FileSpreadsheet,
  Layers,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Upload,
  Users,
  X,
} from 'lucide-react';
import type {
  AgentDayAssignment,
  DayKey,
  ErlangConfig,
  ExceptionCode,
  ForecastDayItem,
  LeaveAllocationCode,
  LeaveCounts,
  RosterAgentInput,
  RosterInputMode,
  ScheduleGenerationResult,
  ScheduledAgentRow,
  SchedulingRules,
  ShiftTemplate,
} from '../engine/types.ts';
import {
  EXCEPTION_META,
  WEEK_DAYS,
  assignOptimalBreaksForShift,
  buildBreakAssignment,
  formatMinutesHHMM,
  isOvernightShiftWindow,
  parseAgentRosterFile,
  parseAgentRosterText,
  parseShiftCatalogFile,
  parseShiftCatalogText,
  sortShiftCatalogChronologically,
  validateAgentScheduleRow,
} from '../engine/scheduling.ts';
import {
  BreakStaggerIcon,
  ConstraintShieldIcon,
  ProMaxIconBadge,
  RosterPoolIcon,
  ShiftSchedulerIcon,
} from './ProMaxIcons.tsx';
import { InteractiveRosterCoverageChart } from './InteractiveCharts.tsx';
import { SmartNumberInput } from './SmartNumberInput.tsx';

interface Tab4SchedulingProps {
  inputMode: RosterInputMode;
  setInputMode: React.Dispatch<React.SetStateAction<RosterInputMode>>;
  headcountInput: number;
  setHeadcountInput: React.Dispatch<React.SetStateAction<number>>;
  namedAgents: RosterAgentInput[];
  setNamedAgents: React.Dispatch<React.SetStateAction<RosterAgentInput[]>>;
  leaveCounts: LeaveCounts;
  setLeaveCounts: React.Dispatch<React.SetStateAction<LeaveCounts>>;
  shiftCatalog: ShiftTemplate[];
  setShiftCatalog: React.Dispatch<React.SetStateAction<ShiftTemplate[]>>;
  rules: SchedulingRules;
  setRules: React.Dispatch<React.SetStateAction<SchedulingRules>>;
  scheduleResult: ScheduleGenerationResult;
  onAutoGenerate: () => void;
  onUpdateRosterAgents: (nextAgents: ScheduledAgentRow[]) => void;
  onExportScheduleExcel: () => void;
  nextWeekDays: ForecastDayItem[];
  capPlanFteTarget: number;
  erlangConfig: ErlangConfig;
  grossShiftHoursCapPlan: number;
  onShowNotice: (msg: string) => void;
}

const EXCEPTION_KEYS: { key: keyof LeaveCounts; code: ExceptionCode; label: string; hint: string }[] = [
  { key: 'annual', code: 'AL', label: 'Annual Leave (AL)', hint: 'Full-week AL lock' },
  { key: 'maternity', code: 'MAT', label: 'Maternity', hint: 'Full-week MAT lock' },
  { key: 'resignations', code: 'RES', label: 'Resignations', hint: 'Full-week RES lock' },
  { key: 'termination', code: 'TERM', label: 'Termination', hint: 'Full-week TERM lock' },
  { key: 'upl', code: 'UPL', label: 'Unpaid (UPL)', hint: 'Full-week UPL lock' },
  { key: 'paternity', code: 'PAT', label: 'Paternity', hint: 'Full-week PAT lock' },
];

const EXCEPTION_BADGE_STYLES: Record<ExceptionCode, string> = {
  AL: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/35',
  MAT: 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border-indigo-500/35',
  RES: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/35',
  TERM: 'bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/35',
  UPL: 'bg-slate-500/15 text-slate-700 dark:text-slate-300 border-slate-500/35',
  PAT: 'bg-teal-500/15 text-teal-700 dark:text-teal-300 border-teal-500/35',
};

type MatrixFilter = 'all' | 'active' | 'leaves' | 'alerts' | 'manual';

function normalizeRosterText(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\u064b-\u065f\u0670\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .trim();
}

/** Bounded Damerau-Levenshtein distance <= 1 check for forgiving typo tolerance on words >= 4 chars. */
function isWithinEditDistanceOne(a: string, b: string): boolean {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (a === b) return true;
  if (la === lb) {
    let diffs = 0;
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i]) {
        // Check adjacent transposition (e.g. "ahmde" vs "ahmed")
        if (i + 1 < la && a[i] === b[i + 1] && a[i + 1] === b[i]) {
          return a.slice(i + 2) === b.slice(i + 2) && diffs === 0;
        }
        diffs++;
        if (diffs > 1) return false;
      }
    }
    return diffs === 1;
  }
  const shorter = la < lb ? a : b;
  const longer = la < lb ? b : a;
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i++;
      j++;
    } else if (!skipped) {
      skipped = true;
      j++;
    } else {
      return false;
    }
  }
  return true;
}

function matchesSmartRosterSearch(
  agent: ScheduledAgentRow,
  rowNum: number,
  rawQuery: string,
  shiftMap: Map<string, ShiftTemplate>
): boolean {
  const qNorm = normalizeRosterText(rawQuery);
  if (!qNorm) return true;

  // Direct row-query fast path ("Agent 10", "agent10", "ag10", "#10") avoids shift-time collisions ("10:00")
  const directRowMatch = qNorm.match(/^(?:agent\s*#?|ag\s*#?|#)(\d+)$/);
  if (directRowMatch) {
    const targetNum = Number(directRowMatch[1]);
    return (
      rowNum === targetNum ||
      normalizeRosterText(agent.agentName) === `agent ${targetNum}` ||
      normalizeRosterText(agent.agentId) === `agent-${targetNum}`
    );
  }

  // Keep bound "agent 10" / "agent10" / "ag10" references intact as #10 inside compound queries
  const qPrepared = qNorm.replace(/\b(?:agent|ag)\s*#?(\d+)\b/g, '#$1');

  // Preserve explicit #N row-number syntax while splitting other tokens cleanly
  const qTokens = qPrepared
    .split(/\s+/)
    .flatMap((t) => {
      if (t.startsWith('#') && /^#\d+$/.test(t)) return [t];
      return t
        .replace(/([a-z\u0600-\u06ff])(\d)/g, '$1 $2')
        .replace(/(\d)([a-z\u0600-\u06ff])/g, '$1 $2')
        .replace(/[-+/_.,()]/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
    })
    .filter(Boolean);

  if (qTokens.length === 0) return true;

  const shiftLabels = new Set<string>();
  for (const dk of WEEK_DAYS) {
    const a = agent.assignments[dk];
    if (a?.status === 'WORK' && a.shiftId) {
      const sh = shiftMap.get(a.shiftId);
      if (sh) shiftLabels.add(sh.label);
    }
  }

  const exMeta = agent.preAllocatedException ? EXCEPTION_META[agent.preAllocatedException] : null;
  const rawFields = [
    agent.agentName,
    agent.agentId,
    `agent#${rowNum}`,
    `#${rowNum}`,
    agent.offPatternLabel,
    exMeta ? `${exMeta.code} ${exMeta.label} ${exMeta.short}` : '',
    agent.violations.length > 0 ? 'alert violation' : 'valid',
    ...[...shiftLabels],
  ]
    .map(normalizeRosterText)
    .filter(Boolean);

  const flatBlob = rawFields.join(' ');
  if (flatBlob.includes(qNorm)) return true;

  const candidateWords = Array.from(
    new Set(
      rawFields.flatMap((f) => [
        f,
        ...f.split(/[\s\-+/_.,()–]+/).filter(Boolean),
      ])
    )
  );

  return qTokens.every((qt) => {
    if (qt.startsWith('#') && /^#\d+$/.test(qt)) {
      return Number(qt.slice(1)) === rowNum;
    }
    if (/^\d+$/.test(qt)) {
      const numVal = Number(qt);
      return (
        numVal === rowNum ||
        candidateWords.some(
          (cw) =>
            cw === qt ||
            cw.startsWith(`${qt.padStart(2, '0')}:`) ||
            cw.startsWith(`${qt}:`)
        )
      );
    }
    return candidateWords.some(
      (cw) =>
        cw.includes(qt) ||
        (!/\d/.test(qt) &&
          !/\d/.test(cw) &&
          qt.length >= 4 &&
          cw.length >= 4 &&
          isWithinEditDistanceOne(qt, cw))
    );
  });
}

export const Tab4Scheduling: React.FC<Tab4SchedulingProps> = ({
  inputMode,
  setInputMode,
  headcountInput,
  setHeadcountInput,
  namedAgents,
  setNamedAgents,
  leaveCounts,
  setLeaveCounts,
  shiftCatalog,
  setShiftCatalog,
  rules,
  setRules,
  scheduleResult,
  onAutoGenerate,
  onUpdateRosterAgents,
  onExportScheduleExcel,
  nextWeekDays,
  capPlanFteTarget,
  erlangConfig,
  grossShiftHoursCapPlan,
  onShowNotice,
}) => {
  const rosterFileRef = useRef<HTMLInputElement | null>(null);
  const shiftFileRef = useRef<HTMLInputElement | null>(null);

  const [showPasteRoster, setShowPasteRoster] = useState(false);
  const [pasteRosterText, setPasteRosterText] = useState('');
  const [showPasteShifts, setShowPasteShifts] = useState(false);
  const [pasteShiftsText, setPasteShiftsText] = useState('');
  const [quickShiftText, setQuickShiftText] = useState('');
  const [showBreakTuning, setShowBreakTuning] = useState(false);

  const [selectedDay, setSelectedDay] = useState<DayKey>('Mon');
  const [chartViewMode, setChartViewMode] = useState<'intraday' | 'weekly'>('intraday');

  const [searchQuery, setSearchQuery] = useState('');
  const [matrixFilter, setMatrixFilter] = useState<MatrixFilter>('all');
  const [showBreakDetails, setShowBreakDetails] = useState(true);
  const [editingNameAgentId, setEditingNameAgentId] = useState<string | null>(null);
  const [editingNameValue, setEditingNameValue] = useState('');

  // Active inline popover editor for any Agent × Day cell + multi-day bulk selection scope
  const [editingCell, setEditingCell] = useState<{ agentId: string; dayKey: DayKey } | null>(null);
  const [selectedPopoverDays, setSelectedPopoverDays] = useState<DayKey[]>(['Mon']);

  // Staged local drafts so multi-cell typing never triggers solver auto-adjust mid-edit
  const [draftShiftPins, setDraftShiftPins] = useState<Record<string, string> | null>(null);
  const [draftCellEdits, setDraftCellEdits] = useState<Record<string, Partial<Record<DayKey, string>>>>({});

  const hasPendingCellEdits = Object.values(draftCellEdits).some(
    (m) => !!m && Object.keys(m).length > 0
  );

  const commitDraftShiftPins = () => {
    if (!draftShiftPins) return;
    setRules((r) => {
      const next: Record<string, number | null> = {};
      for (const [shId, raw] of Object.entries(draftShiftPins)) {
        const trimmed = raw.trim();
        if (trimmed === '') continue;
        const parsed = Number(trimmed);
        if (Number.isFinite(parsed)) {
          next[shId] = Math.max(0, Math.min(500, Math.round(parsed)));
        }
      }
      return { ...r, shiftHeadcountOverrides: next };
    });
    setDraftShiftPins(null);
  };

  const commitDraftCellEdits = () => {
    if (!hasPendingCellEdits) return;
    setRules((r) => {
      const nextAll = { ...(r.shiftDayHeadcountOverrides ?? {}) };
      for (const [shId, dayMap] of Object.entries(draftCellEdits)) {
        if (!dayMap) continue;
        const nextSh = { ...(nextAll[shId] ?? {}) };
        for (const [dkKey, rawVal] of Object.entries(dayMap)) {
          const dk = dkKey as DayKey;
          const trimmed = (rawVal ?? '').trim();
          if (trimmed === '') {
            delete nextSh[dk];
          } else {
            const parsed = Number(trimmed);
            if (Number.isFinite(parsed)) {
              nextSh[dk] = Math.max(0, Math.min(500, Math.round(parsed)));
            }
          }
        }
        if (Object.keys(nextSh).length === 0) {
          delete nextAll[shId];
        } else {
          nextAll[shId] = nextSh;
        }
      }
      return { ...r, shiftDayHeadcountOverrides: nextAll };
    });
    setDraftCellEdits({});
  };

  const openCellEditor = (agentId: string, dayKey: DayKey) => {
    setEditingCell({ agentId, dayKey });
    setSelectedPopoverDays([dayKey]);
  };

  const togglePopoverDay = (dayKey: DayKey) => {
    setSelectedPopoverDays((prev) => {
      if (prev.includes(dayKey)) {
        return prev.length > 1 ? prev.filter((d) => d !== dayKey) : prev;
      }
      return WEEK_DAYS.filter((d) => d === dayKey || prev.includes(d));
    });
  };

  const sortedCatalog = useMemo(() => sortShiftCatalogChronologically(shiftCatalog), [shiftCatalog]);
  const shiftMap = useMemo(() => new Map(sortedCatalog.map((s) => [s.id, s])), [sortedCatalog]);
  const enabledShifts = useMemo(() => sortedCatalog.filter((s) => s.enabled), [sortedCatalog]);

  const totalRosterPool = inputMode === 'named' && namedAgents.length > 0 ? namedAgents.length : headcountInput;
  const totalExclusionsRequested =
    leaveCounts.annual +
    leaveCounts.maternity +
    leaveCounts.resignations +
    leaveCounts.termination +
    leaveCounts.upl +
    leaveCounts.paternity;
  const schedulableTarget = Math.max(0, totalRosterPool - totalExclusionsRequested);

  const handleUploadRosterFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = await parseAgentRosterFile(file);
      if (parsed.length === 0) {
        onShowNotice('Could not detect agent names in uploaded file.');
        return;
      }
      setNamedAgents(parsed);
      setInputMode('named');
      onShowNotice(`Imported ${parsed.length} agent names from ${file.name}. Click Auto-Optimize to refresh schedule.`);
    } catch (err) {
      onShowNotice(`Roster parse error: ${(err as Error).message}`);
    } finally {
      e.target.value = '';
    }
  };

  const handleApplyPastedRoster = () => {
    const parsed = parseAgentRosterText(pasteRosterText);
    if (parsed.length === 0) {
      onShowNotice('No agent names detected. Paste one name per line (optional ", MAT/AL/UPL").');
      return;
    }
    setNamedAgents(parsed);
    setInputMode('named');
    setShowPasteRoster(false);
    setPasteRosterText('');
    onShowNotice(`Loaded ${parsed.length} agents into Named Roster mode.`);
  };

  const handleUploadShiftsFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = await parseShiftCatalogFile(file, Math.round(grossShiftHoursCapPlan * 60));
      if (parsed.length === 0) {
        onShowNotice('No valid shift times found in file (expected e.g. 09:00-18:00).');
        return;
      }
      setShiftCatalog(sortShiftCatalogChronologically(parsed));
      onShowNotice(`Imported ${parsed.length} external shift definitions from ${file.name}.`);
    } catch (err) {
      onShowNotice(`Shift import error: ${(err as Error).message}`);
    } finally {
      e.target.value = '';
    }
  };

  const handleApplyPastedShifts = (replaceExisting: boolean) => {
    const parsed = parseShiftCatalogText(pasteShiftsText, Math.round(grossShiftHoursCapPlan * 60));
    if (parsed.length === 0) {
      onShowNotice('No shifts parsed. Example: 08:00-17:00 or 9:00 AM - 6:00 PM.');
      return;
    }
    if (replaceExisting) {
      setShiftCatalog(sortShiftCatalogChronologically(parsed));
    } else {
      setShiftCatalog((prev) => {
        const seen = new Set(prev.map((s) => s.id));
        return sortShiftCatalogChronologically([...prev, ...parsed.filter((s) => !seen.has(s.id))]);
      });
    }
    setShowPasteShifts(false);
    setPasteShiftsText('');
    onShowNotice(`${replaceExisting ? 'Loaded' : 'Added'} ${parsed.length} external shifts cleanly.`);
  };

  const handleAddQuickShift = () => {
    const parsed = parseShiftCatalogText(quickShiftText, Math.round(grossShiftHoursCapPlan * 60));
    if (parsed.length === 0) {
      onShowNotice('Enter format like 07:00-16:00 or 22:00-07:00.');
      return;
    }
    setShiftCatalog((prev) => {
      const seen = new Set(prev.map((s) => s.id));
      const added = parsed.filter((s) => !seen.has(s.id));
      return added.length > 0 ? sortShiftCatalogChronologically([...prev, ...added]) : prev;
    });
    setQuickShiftText('');
  };

  // Filtered roster table rows preserving original 1-based roster index (#1..#N) + smart fuzzy matching
  const filteredRows = useMemo(() => {
    return scheduleResult.visibleOutputAgents
      .map((agent, idx) => ({ agent, rowNum: idx + 1 }))
      .filter(({ agent, rowNum }) => {
        if (searchQuery.trim() && !matchesSmartRosterSearch(agent, rowNum, searchQuery, shiftMap)) {
          return false;
        }
        if (matrixFilter === 'active') return agent.preAllocatedException === null;
        if (matrixFilter === 'leaves') return agent.preAllocatedException !== null;
        if (matrixFilter === 'alerts') return agent.violations.length > 0;
        if (matrixFilter === 'manual') {
          return WEEK_DAYS.some((dk) => agent.assignments[dk]?.isManualOverride);
        }
        return true;
      });
  }, [scheduleResult.visibleOutputAgents, searchQuery, matrixFilter, shiftMap]);

  const maxAgentNameLen = useMemo(
    () =>
      scheduleResult.visibleOutputAgents.reduce(
        (mx, a) => Math.max(mx, a.agentName.trim().length),
        0
      ),
    [scheduleResult.visibleOutputAgents]
  );
  const hasLongNames = maxAgentNameLen > 14;

  const { summary, dailyTotals, coverageByDay } = scheduleResult;

  // Helpers for inline Cell Popover
  const editingTarget = useMemo(() => {
    if (!editingCell) return null;
    const agent = scheduleResult.agents.find((a) => a.agentId === editingCell.agentId);
    if (!agent) return null;
    const assign = agent.assignments[editingCell.dayKey];
    return { agent, assign, dayKey: editingCell.dayKey };
  }, [editingCell, scheduleResult.agents]);

  const applyCellAssignment = (
    agentId: string,
    targetDays: DayKey | DayKey[],
    nextAssign: Partial<AgentDayAssignment>,
    applyFullWeek = false
  ) => {
    const daysList = applyFullWeek
      ? WEEK_DAYS
      : Array.isArray(targetDays)
        ? targetDays.length > 0
          ? targetDays
          : editingCell
            ? [editingCell.dayKey]
            : ['Mon' as DayKey]
        : [targetDays];

    const updated = scheduleResult.agents.map((a) => {
      if (a.agentId !== agentId) return a;
      const nextAssignments = { ...a.assignments };
      if (applyFullWeek && nextAssign.status && nextAssign.status !== 'WORK') {
        for (const dk of WEEK_DAYS) {
          nextAssignments[dk] = {
            dayKey: dk,
            status: nextAssign.status,
            shiftId: null,
            breaks: null,
            isManualOverride: true,
          };
        }
        return {
          ...a,
          preAllocatedException: nextAssign.status === 'OFF' ? null : nextAssign.status,
          assignments: nextAssignments,
        };
      }

      for (const dk of daysList) {
        const prevCell = a.assignments[dk];
        const merged: AgentDayAssignment = {
          ...prevCell,
          ...nextAssign,
          dayKey: dk,
          isManualOverride: true,
        };
        if (merged.status !== 'WORK') {
          merged.shiftId = null;
          merged.breaks = null;
        } else if (merged.shiftId && !merged.breaks) {
          const sh = shiftMap.get(merged.shiftId);
          if (sh) {
            const surplus15 = new Array<number>(96).fill(2);
            merged.breaks = assignOptimalBreaksForShift(sh, surplus15, rules.breakRules);
          }
        }
        nextAssignments[dk] = merged;
      }

      const firstStatus = nextAssignments[daysList[0]].status;
      const allEx = WEEK_DAYS.every(
        (dk) => nextAssignments[dk].status !== 'WORK' && nextAssignments[dk].status !== 'OFF'
      );
      const uniformEx =
        allEx && WEEK_DAYS.every((dk) => nextAssignments[dk].status === firstStatus)
          ? (firstStatus as ExceptionCode)
          : null;
      return {
        ...a,
        preAllocatedException: uniformEx,
        assignments: nextAssignments,
      };
    });
    onUpdateRosterAgents(updated);
  };

  // Pre-flight rule check across all currently selected popover days
  const previewShiftCompatibility = (
    agent: ScheduledAgentRow,
    targetDays: DayKey | DayKey[],
    cand: ShiftTemplate
  ) => {
    const daysList = Array.isArray(targetDays) ? targetDays : [targetDays];
    const nextAssignments = { ...agent.assignments };
    for (const dk of daysList) {
      nextAssignments[dk] = {
        dayKey: dk,
        status: 'WORK',
        shiftId: cand.id,
        breaks: null,
      };
    }
    const tempRow: ScheduledAgentRow = {
      ...agent,
      assignments: nextAssignments,
    };
    const audited = validateAgentScheduleRow(tempRow, shiftCatalog, rules);
    const span = audited.shiftBandSpanHours;
    const hasRestAlert = audited.violations.some((v) => v.includes('rest') || v.includes('clopening'));
    const hasDriftAlert = audited.violations.some((v) => v.includes('drift'));
    return {
      ok: !hasRestAlert && !hasDriftAlert,
      span,
      reason: hasRestAlert ? '<Min Rest' : hasDriftAlert ? `Drift ${span}h` : 'Compatible',
    };
  };

  const commitInlineName = (agentId: string) => {
    const clean = editingNameValue.trim();
    if (clean) {
      onUpdateRosterAgents(
        scheduleResult.agents.map((a) => (a.agentId === agentId ? { ...a, agentName: clean } : a))
      );
    }
    setEditingNameAgentId(null);
  };

  // Percentage bar calculations for roster pool visual
  const safeDenominator = Math.max(1, summary.totalRosterInput);
  const pctActive = (summary.activeSchedulableCount / safeDenominator) * 100;
  const pctLeave = (summary.fullWeekExceptionsCount / safeDenominator) * 100;
  const pctAnnual = (summary.annualExcluded / safeDenominator) * 100;

  return (
    <div className="space-y-6 animate-slide-up">
      {/* =====================================================================
          1. COMMAND CONTROL DECK: ROSTER/LEAVES INPUT + EXTERNAL SHIFTS/RULES
         ===================================================================== */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
        {/* LEFT PANEL: AGENT POOL & LEAVE INPUT DEDUCTIONS */}
        <section className="no-print bento-card-promax xl:col-span-6 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs flex flex-col justify-between gap-4">
          <div className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <ProMaxIconBadge tone="cyan" size="md" pulse>
                <RosterPoolIcon size={22} />
              </ProMaxIconBadge>
              <div>
                <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                  Roster Pool &amp; Leave Exclusions (Input)
                  <span className="inline-flex items-center rounded-full bg-sky-500/15 text-sky-600 dark:text-sky-300 px-2 py-0.5 text-[10px] font-semibold">
                    {schedulableTarget} Schedulable
                  </span>
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Upload names or enter total headcount (Agent 1..N). Annual &amp; leave pools deduct cleanly before shift generation.
                </p>
              </div>
            </div>

            {/* Dual Input Mode Switcher */}
            <div className="flex items-center gap-1 rounded-xl bg-slate-100 dark:bg-slate-950/70 p-1 border border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setInputMode('headcount')}
                className={`px-2.5 py-1 rounded-lg text-xs font-bold transition cursor-pointer ${
                  inputMode === 'headcount'
                    ? 'bg-[#0088c2] text-white shadow-xs'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                Headcount Input
              </button>
              <button
                type="button"
                onClick={() => setInputMode('named')}
                className={`px-2.5 py-1 rounded-lg text-xs font-bold transition cursor-pointer ${
                  inputMode === 'named'
                    ? 'bg-[#0088c2] text-white shadow-xs'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                Upload Names ({namedAgents.length})
              </button>
            </div>
          </div>

          {/* Mode Controls: Headcount vs Uploaded Roster */}
          {inputMode === 'headcount' ? (
            <div className="cnx-input-tile rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 p-3.5 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div>
                  <label className="block text-[10px] uppercase font-bold tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                    Total Team Headcount
                  </label>
                  <div className="flex items-center gap-2">
                    <SmartNumberInput
                      value={headcountInput}
                      min={1}
                      max={500}
                      onChange={(v) => setHeadcountInput(Math.max(1, Math.min(500, Math.round(v))))}
                      className="w-24 rounded-lg border border-sky-500/40 bg-white dark:bg-slate-900 px-3 py-1.5 text-sm font-extrabold font-mono text-sky-700 dark:text-sky-300"
                    />
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      auto-named Agent 1 … Agent {headcountInput}
                    </span>
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setHeadcountInput(Math.max(1, Math.round(capPlanFteTarget)))}
                className="cnx-pill-interactive inline-flex items-center gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 px-3 py-1.5 text-xs font-bold text-emerald-700 dark:text-emerald-300 cursor-pointer"
              >
                <Users className="w-3.5 h-3.5" />
                Sync Tab 3 Cap Plan ({Math.round(capPlanFteTarget)} FTE)
              </button>
            </div>
          ) : (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 p-3.5 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs text-slate-600 dark:text-slate-300">
                  {namedAgents.length > 0 ? (
                    <span>
                      <strong className="text-sky-600 dark:text-sky-400">{namedAgents.length} agents</strong> loaded (count extracted automatically)
                    </span>
                  ) : (
                    <span>No names uploaded yet — upload Excel/CSV or paste list below.</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    ref={rosterFileRef}
                    type="file"
                    accept=".csv,.txt,.xlsx,.xls"
                    onChange={handleUploadRosterFile}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => rosterFileRef.current?.click()}
                    className="cnx-pill-interactive inline-flex items-center gap-1.5 rounded-lg bg-[#0088c2] hover:bg-[#0073a8] text-white px-2.5 py-1.5 text-xs font-bold cursor-pointer"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    Upload Names (.xlsx/.csv)
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowPasteRoster((s) => !s)}
                    className="cnx-pill-interactive inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-semibold cursor-pointer"
                  >
                    <ClipboardPaste className="w-3.5 h-3.5" />
                    Paste List
                  </button>
                </div>
              </div>

              {showPasteRoster && (
                <div className="space-y-2 pt-1">
                  <textarea
                    rows={4}
                    value={pasteRosterText}
                    onChange={(e) => setPasteRosterText(e.target.value)}
                    placeholder={`Agent Name, Status (Optional)\nAhmed Hassan\nSara Adel, MAT\nOmar Tarek, AL\nHeba Youssef, UPL`}
                    className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-2.5 text-xs font-mono focus:outline-none focus:border-sky-500"
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setShowPasteRoster(false)}
                      className="rounded-lg border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-xs cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleApplyPastedRoster}
                      className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1 text-xs font-bold cursor-pointer"
                    >
                      Load Agent Names
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 6-Tile Full-Week Exception & AL Input Deductions */}
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Leave &amp; Attrition Inputs (0% Shift Coverage · Locked Full Week)
              </span>
              <button
                type="button"
                onClick={() =>
                  setRules((r) => ({
                    ...r,
                    annualVisibilityInOutput:
                      r.annualVisibilityInOutput === 'exclude' ? 'show_muted' : 'exclude',
                  }))
                }
                className={`cnx-pill-interactive inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold cursor-pointer ${
                  rules.annualVisibilityInOutput !== 'exclude'
                    ? 'border-sky-500/45 bg-sky-500/15 text-sky-700 dark:text-sky-300'
                    : 'border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                }`}
              >
                {rules.annualVisibilityInOutput === 'exclude' ? (
                  <>
                    <EyeOff className="w-3 h-3" />
                    AL: Hidden from Output
                  </>
                ) : (
                  <>
                    <Eye className="w-3 h-3" />
                    AL: Visible Full-Week
                  </>
                )}
              </button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
              {EXCEPTION_KEYS.map((item) => (
                <div
                  key={item.code}
                  className="cnx-input-tile card-elevated rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-950/60 p-2.5"
                >
                  <div className="flex items-center justify-between gap-1 mb-1">
                    <span className="text-[11px] font-bold text-slate-700 dark:text-slate-200">
                      {item.label}
                    </span>
                    <span
                      className={`rounded-md border px-1.5 py-0.5 text-[9px] font-mono font-bold ${EXCEPTION_BADGE_STYLES[item.code]}`}
                    >
                      {item.code}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <SmartNumberInput
                      value={leaveCounts[item.key]}
                      min={0}
                      max={totalRosterPool}
                      onChange={(v) =>
                        setLeaveCounts((prev) => ({
                          ...prev,
                          [item.key]: Math.max(0, Math.min(totalRosterPool, Math.round(v))),
                        }))
                      }
                      className="w-16 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-xs font-mono font-bold"
                    />
                    <span className="text-[10px] text-slate-400 truncate">{item.hint}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Live Proportional Pool Allocation Bar */}
          <div className="space-y-1.5 pt-1">
            <div className="h-2.5 w-full rounded-full overflow-hidden bg-slate-200 dark:bg-slate-800 flex">
              <div
                style={{ width: `${pctActive}%` }}
                className="bg-gradient-to-r from-[#0088c2] to-[#14b8a6] transition-all duration-300"
                title={`Active Schedulable: ${summary.activeSchedulableCount}`}
              />
              <div
                style={{ width: `${pctLeave}%` }}
                className="bg-amber-500/85 transition-all duration-300"
                title={`Full-Week Exceptions (MAT/RES/TERM/UPL/PAT): ${summary.fullWeekExceptionsCount}`}
              />
              <div
                style={{ width: `${pctAnnual}%` }}
                className="bg-slate-400/70 transition-all duration-300"
                title={`Annual Leave Input Excluded: ${summary.annualExcluded}`}
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
              <span>
                <strong className="text-emerald-600 dark:text-emerald-400">{summary.activeSchedulableCount}</strong> Active Shifts Pool ·{' '}
                <strong className="text-amber-600 dark:text-amber-400">{summary.fullWeekExceptionsCount}</strong> Week Leaves ·{' '}
                <strong className="text-sky-600 dark:text-sky-400">{summary.annualExcluded}</strong> AL Input
              </span>
              {totalExclusionsRequested > totalRosterPool && (
                <span className="text-rose-500 font-bold">
                  ⚠ Exclusions exceed total headcount!
                </span>
              )}
            </div>
          </div>
          </div>

          {/* Pool Readiness & Leave Impact Bento Panel (balances card height cleanly) */}
          {(() => {
            const totalLockedHeads = Math.min(totalRosterPool, totalExclusionsRequested);
            const activeSharePct =
              totalRosterPool > 0 ? (summary.activeSchedulableCount / totalRosterPool) * 100 : 0;
            const leaveShrinkPct =
              totalRosterPool > 0 ? (totalLockedHeads / totalRosterPool) * 100 : 0;

            return (
              <div className="cnx-input-tile rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/75 dark:bg-slate-950/60 p-3.5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300">
                    Pool Readiness &amp; Leave Impact Summary
                  </div>
                  {totalExclusionsRequested > 0 ? (
                    <button
                      type="button"
                      onClick={() =>
                        setLeaveCounts({
                          annual: 0,
                          maternity: 0,
                          resignations: 0,
                          termination: 0,
                          upl: 0,
                          paternity: 0,
                        })
                      }
                      className="cnx-pill-interactive rounded-lg border border-rose-500/35 bg-rose-500/10 hover:bg-rose-500/20 px-2.5 py-0.5 text-[10px] font-bold text-rose-600 dark:text-rose-300 cursor-pointer"
                    >
                      Reset All Leaves to 0
                    </button>
                  ) : (
                    <span className="rounded-full border border-emerald-500/35 bg-emerald-500/10 px-2.5 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300">
                      100% Roster Active
                    </span>
                  )}
                </div>

                {/* Color Legend matching Allocation Bar above */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10.5px] text-slate-500 dark:text-slate-400">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-gradient-to-r from-[#0088c2] to-[#14b8a6]" />
                    Working Pool ({summary.activeSchedulableCount})
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-amber-500" />
                    Other Locks ({summary.fullWeekExceptionsCount})
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-slate-400" />
                    Annual AL ({summary.annualExcluded})
                  </span>
                </div>

                {/* 4 Clean WFM Summary Micro-Tiles */}
                <div className="grid grid-cols-2 gap-2.5">
                  <div className="rounded-lg border border-slate-200/80 dark:border-slate-800 bg-white/80 dark:bg-slate-900/75 px-3 py-2">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      Active Schedulable Share
                    </div>
                    <div className="mt-0.5 flex items-baseline justify-between gap-2">
                      <span className="text-sm font-mono font-extrabold text-slate-900 dark:text-white">
                        {summary.activeSchedulableCount} / {totalRosterPool} Heads
                      </span>
                      <span className="text-[11px] font-mono font-bold text-sky-600 dark:text-sky-400">
                        {activeSharePct.toFixed(1)}% Ready
                      </span>
                    </div>
                  </div>

                  <div className="rounded-lg border border-slate-200/80 dark:border-slate-800 bg-white/80 dark:bg-slate-900/75 px-3 py-2">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      Locked Leave Shrinkage
                    </div>
                    <div className="mt-0.5 flex items-baseline justify-between gap-2">
                      <span className="text-sm font-mono font-extrabold text-sky-600 dark:text-sky-400">
                        {leaveShrinkPct.toFixed(1)}%
                      </span>
                      <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                        {totalLockedHeads} / {totalRosterPool} locked
                      </span>
                    </div>
                  </div>

                  <div className="rounded-lg border border-slate-200/80 dark:border-slate-800 bg-white/80 dark:bg-slate-900/75 px-3 py-2">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      Weekly Net Paid vs Req
                    </div>
                    <div className="mt-0.5 flex items-baseline justify-between gap-2">
                      <span className="text-sm font-mono font-extrabold text-slate-900 dark:text-white">
                        {summary.totalScheduledNetHours.toFixed(0)}h /{' '}
                        {summary.totalRequiredProdHours.toFixed(0)}h
                      </span>
                      <span className="text-[11px] font-mono font-bold text-teal-600 dark:text-teal-400">
                        {summary.avgCoveragePct.toFixed(1)}%
                      </span>
                    </div>
                  </div>

                  <div className="rounded-lg border border-slate-200/80 dark:border-slate-800 bg-white/80 dark:bg-slate-900/75 px-3 py-2">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      Weekly Shift Supply
                    </div>
                    <div className="mt-0.5 flex items-baseline justify-between gap-2">
                      <span className="text-sm font-mono font-extrabold text-slate-900 dark:text-white">
                        {summary.totalWorkShifts} shifts
                      </span>
                      <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                        ~{(summary.totalWorkShifts / 7).toFixed(1)}/day avg
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}
        </section>

        {/* RIGHT PANEL: EXTERNAL SHIFT CATALOG & HARD CONSTRAINTS */}
        <section className="no-print bento-card-promax xl:col-span-6 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <ProMaxIconBadge tone="emerald" size="md">
                <BreakStaggerIcon size={22} />
              </ProMaxIconBadge>
              <div>
                <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                  External Shift Catalog &amp; WFM Constraints
                  <span className="inline-flex items-center rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 px-2 py-0.5 text-[10px] font-semibold">
                    {enabledShifts.length} Active Shifts
                  </span>
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Import shifts from outside; optimizer fits shifts to Next Week Arrival Curves &amp; Erlang Required seats.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <input
                ref={shiftFileRef}
                type="file"
                accept=".csv,.txt,.xlsx,.xls"
                onChange={handleUploadShiftsFile}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => shiftFileRef.current?.click()}
                className="cnx-pill-interactive inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2.5 py-1.5 text-xs font-semibold cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5 text-sky-500" />
                Upload Shifts
              </button>
              <button
                type="button"
                onClick={() => setShowPasteShifts((s) => !s)}
                className="cnx-pill-interactive inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2.5 py-1.5 text-xs font-semibold cursor-pointer"
              >
                <ClipboardPaste className="w-3.5 h-3.5 text-teal-500" />
                Paste Shifts
              </button>
            </div>
          </div>

          {showPasteShifts && (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 p-3 space-y-2">
              <textarea
                rows={3}
                value={pasteShiftsText}
                onChange={(e) => setPasteShiftsText(e.target.value)}
                placeholder={`08:00-17:00\n09:00-18:00\n10:00-19:00\n12:00-21:00\n15:00-00:00\n22:00-07:00`}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-2 text-xs font-mono"
              />
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowPasteShifts(false)}
                  className="rounded-lg border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-xs cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => handleApplyPastedShifts(false)}
                  className="rounded-lg bg-sky-600 hover:bg-sky-500 text-white px-2.5 py-1 text-xs font-bold cursor-pointer"
                >
                  Append
                </button>
                <button
                  type="button"
                  onClick={() => handleApplyPastedShifts(true)}
                  className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-1 text-xs font-bold cursor-pointer"
                >
                  Replace Catalog
                </button>
              </div>
            </div>
          )}

          {/* Elevated Chronological Shift Catalog Grid + Manual Per-Shift Headcount Control */}
          {(() => {
            const ovMap = rules.shiftHeadcountOverrides ?? {};
            const readDraftPinNumber = (shId: string): number | null => {
              if (draftShiftPins) {
                const raw = (draftShiftPins[shId] ?? '').trim();
                if (raw === '') return null;
                const parsed = Number(raw);
                return Number.isFinite(parsed) ? Math.max(0, Math.min(500, Math.round(parsed))) : null;
              }
              const v = ovMap[shId];
              return v != null && Number.isFinite(v) ? Math.max(0, Math.round(v)) : null;
            };
            const pinnedPoolSum = enabledShifts.reduce((acc, sh) => {
              const v = readDraftPinNumber(sh.id);
              return v !== null ? acc + v : acc;
            }, 0);
            const hasAnyPin = enabledShifts.some((sh) => readDraftPinNumber(sh.id) !== null);
            const hasAnyAutoShift = enabledShifts.some((sh) => readDraftPinNumber(sh.id) === null);
            const remainingAuto = Math.max(0, summary.activeSchedulableCount - pinnedPoolSum);
            const hasDaytimeFallback = enabledShifts.some(
              (sh) => readDraftPinNumber(sh.id) !== 0 && !isOvernightShiftWindow(sh)
            );
            const openPinDraftIfNeeded = (): Record<string, string> => {
              if (draftShiftPins) return { ...draftShiftPins };
              const init: Record<string, string> = {};
              for (const sh of sortedCatalog) {
                const v = ovMap[sh.id];
                if (v != null && Number.isFinite(v)) init[sh.id] = String(Math.round(v));
              }
              return init;
            };

            return (
              <div className="space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    <span>Shift Catalog &amp; Scheduled Headcount Control</span>
                    <span className="rounded-full border border-sky-500/35 bg-sky-500/10 px-2 py-0.5 text-[10px] font-mono font-bold text-sky-600 dark:text-sky-300 normal-case">
                      Auto-Sorted 00:00 → 23:59
                    </span>
                    <span
                      className={`rounded-full border px-2.5 py-0.5 text-[10.5px] font-mono font-bold normal-case ${
                        pinnedPoolSum > summary.activeSchedulableCount
                          ? 'border-rose-500/45 bg-rose-500/12 text-rose-600 dark:text-rose-300'
                          : hasAnyPin
                            ? 'border-amber-500/45 bg-amber-500/12 text-amber-700 dark:text-amber-300'
                            : 'border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300'
                      }`}
                    >
                      Pinned: {pinnedPoolSum} / {summary.activeSchedulableCount} Active Pool · {remainingAuto} Remaining Auto
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {draftShiftPins !== null && (
                      <>
                        <button
                          type="button"
                          onClick={commitDraftShiftPins}
                          className="cnx-pill-interactive rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-1 text-[11px] font-bold shadow-xs cursor-pointer"
                        >
                          ✓ Apply Shift Pins (Mon–Thu)
                        </button>
                        <button
                          type="button"
                          onClick={() => setDraftShiftPins(null)}
                          className="rounded-lg border border-slate-300 dark:border-slate-700 px-2 py-1 text-[11px] font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                        >
                          Cancel
                        </button>
                      </>
                    )}
                    {(hasAnyPin || draftShiftPins !== null) && (
                      <button
                        type="button"
                        onClick={() => {
                          setDraftShiftPins(null);
                          setRules((r) => ({ ...r, shiftHeadcountOverrides: {} }));
                        }}
                        className="cnx-pill-interactive rounded-lg border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 px-2.5 py-1 text-[11px] font-bold text-amber-700 dark:text-amber-300 cursor-pointer"
                      >
                        Reset All Pins to Auto
                      </button>
                    )}
                  </div>
                </div>

                {pinnedPoolSum > summary.activeSchedulableCount ? (
                  <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] font-semibold text-rose-700 dark:text-rose-300">
                    Manual pins total ({pinnedPoolSum}) exceeds Active Pool ({summary.activeSchedulableCount}). Extra pins are capped at active availability.
                  </div>
                ) : hasAnyPin && !hasAnyAutoShift ? (
                  <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] font-semibold text-amber-800 dark:text-amber-200 flex items-center gap-2">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-600 dark:text-amber-300" />
                    <span>
                      Pinned shift headcounts lock <strong>Mon–Thu ({pinnedPoolSum}/day)</strong> — remaining{' '}
                      <strong>
                        {Math.max(0, summary.activeSchedulableCount * rules.maxWorkdaysPerWeek - pinnedPoolSum * 4)} weekly shifts
                      </strong>{' '}
                      distribute across <strong>Fri–Sun</strong> by volume{hasDaytimeFallback ? ' (overnight shifts protected).' : '.'}
                    </span>
                  </div>
                ) : hasAnyPin && hasAnyAutoShift && remainingAuto > 0 ? (
                  <div className="rounded-xl border border-sky-500/30 bg-sky-500/8 px-3 py-1.5 text-[11px] text-sky-700 dark:text-sky-300 font-medium">
                    Pinned shifts are locked — all <strong>{remainingAuto} remaining heads</strong> route exclusively into your unpinned Auto shift(s).
                  </div>
                ) : null}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {sortedCatalog.map((shift) => {
                const mix = scheduleResult.shiftDailyMix.find((m) => m.shiftId === shift.id);
                const draftRaw = draftShiftPins ? draftShiftPins[shift.id] : undefined;
                const rawOverride = rules.shiftHeadcountOverrides?.[shift.id];
                const isPendingPin = draftShiftPins !== null && draftRaw !== undefined;
                const displayedPinStr =
                  draftShiftPins !== null
                    ? (draftRaw ?? '')
                    : rawOverride != null && Number.isFinite(rawOverride)
                      ? String(rawOverride)
                      : '';
                const isPinned = displayedPinStr.trim() !== '';
                const poolCount = mix?.assignedPoolCount ?? 0;
                const avgDaily = mix?.avgPerDay ?? 0;

                return (
                  <div
                    key={shift.id}
                    className={`cnx-input-tile rounded-xl border p-3 transition ${
                      !shift.enabled
                        ? 'opacity-55 border-slate-300 dark:border-slate-700 bg-slate-100/70 dark:bg-slate-950/40'
                        : isPendingPin
                          ? 'border-emerald-500/60 bg-emerald-500/[0.07] dark:bg-emerald-500/[0.08]'
                          : isPinned
                            ? 'border-amber-500/50 bg-amber-500/[0.06] dark:bg-amber-500/[0.08]'
                            : 'border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-950/70'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 mb-2.5">
                      <button
                        type="button"
                        onClick={() =>
                          setShiftCatalog((prev) =>
                            prev.map((s) => (s.id === shift.id ? { ...s, enabled: !s.enabled } : s))
                          )
                        }
                        className={`cursor-pointer flex items-center gap-1.5 text-xs font-mono font-extrabold whitespace-nowrap ${
                          shift.enabled
                            ? 'text-sky-700 dark:text-sky-300'
                            : 'text-slate-400 line-through'
                        }`}
                        title="Click to enable/disable this shift in optimization"
                      >
                        <CalendarClock className="w-3.5 h-3.5 shrink-0" />
                        <span>{shift.label}</span>
                        <span className="text-[10px] font-semibold opacity-75">
                          ({(shift.durationMin / 60).toFixed(0)}h)
                        </span>
                      </button>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <span
                          className={`whitespace-nowrap rounded-md px-2 py-0.5 text-[10px] font-mono font-bold ${
                            isPinned
                              ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/35'
                              : 'bg-sky-500/12 text-sky-700 dark:text-sky-300 border border-sky-500/30'
                          }`}
                        >
                          {poolCount} ag
                        </span>
                        {sortedCatalog.length > 1 && (
                          <button
                            type="button"
                            onClick={() => {
                              setShiftCatalog((prev) => prev.filter((s) => s.id !== shift.id));
                              if (draftShiftPins && shift.id in draftShiftPins) {
                                const nextDraft = { ...draftShiftPins };
                                delete nextDraft[shift.id];
                                setDraftShiftPins(nextDraft);
                              }
                              setRules((r) => {
                                if (!r.shiftHeadcountOverrides || !(shift.id in r.shiftHeadcountOverrides)) {
                                  return r;
                                }
                                const next = { ...r.shiftHeadcountOverrides };
                                delete next[shift.id];
                                return { ...r, shiftHeadcountOverrides: next };
                              });
                            }}
                            aria-label={`Remove shift ${shift.label}`}
                            className="p-0.5 text-slate-400 hover:text-rose-500 cursor-pointer transition"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[10px] font-medium leading-tight">
                        {!shift.enabled ? (
                          <span className="text-slate-400">Disabled in pool</span>
                        ) : isPendingPin ? (
                          <span className="text-emerald-600 dark:text-emerald-300 font-bold">
                            Staged · Click Apply
                          </span>
                        ) : isPinned ? (
                          <span className="text-amber-600 dark:text-amber-300 font-bold">
                            Pinned · ~{avgDaily.toFixed(1)}/d
                          </span>
                        ) : (
                          <span className="text-slate-500 dark:text-slate-400">
                            Auto · ~{avgDaily.toFixed(1)}/d
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          min={0}
                          max={500}
                          step={1}
                          disabled={!shift.enabled}
                          value={displayedPinStr}
                          placeholder={`Auto (${poolCount})`}
                          aria-label={`Scheduled headcount override for shift ${shift.label}`}
                          onChange={(e) => {
                            const val = e.target.value;
                            const nextDraft = openPinDraftIfNeeded();
                            if (val.trim() === '') {
                              delete nextDraft[shift.id];
                            } else {
                              nextDraft[shift.id] = val;
                            }
                            setDraftShiftPins(nextDraft);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.currentTarget.blur();
                              commitDraftShiftPins();
                            } else if (e.key === 'Escape') {
                              setDraftShiftPins(null);
                            }
                          }}
                          className="w-24 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-right text-xs font-mono font-bold text-slate-800 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:border-sky-500 disabled:opacity-50"
                        />
                        {isPinned && (
                          <button
                            type="button"
                            onClick={() => {
                              if (draftShiftPins !== null) {
                                const nextDraft = { ...draftShiftPins };
                                delete nextDraft[shift.id];
                                setDraftShiftPins(nextDraft);
                              } else {
                                setRules((r) => {
                                  const next = { ...(r.shiftHeadcountOverrides ?? {}) };
                                  delete next[shift.id];
                                  return { ...r, shiftHeadcountOverrides: next };
                                });
                              }
                            }}
                            title="Clear manual pin and let Auto-Optimizer assign headcount"
                            className="rounded-md border border-amber-500/40 bg-amber-500/12 px-1.5 py-1 text-[10px] font-bold text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 cursor-pointer"
                          >
                            Auto
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex items-center gap-2">
              <input
                type="text"
                value={quickShiftText}
                onChange={(e) => setQuickShiftText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddQuickShift()}
                placeholder="Add shift e.g. 07:00-16:00 or 22:00-07:00"
                className="flex-1 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/60 px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-sky-500"
              />
              <button
                type="button"
                onClick={handleAddQuickShift}
                className="cnx-pill-interactive inline-flex items-center gap-1 rounded-xl bg-slate-800 dark:bg-slate-800 hover:bg-slate-700 text-white px-3 py-1.5 text-xs font-bold cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                Add
              </button>
            </div>
          </div>
            );
          })()}

          {/* Hard WFM Constraints Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <div className="cnx-input-tile rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 p-2.5 space-y-1.5">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Workdays &amp; 2 OFF Rule
              </div>
              <div className="flex items-center justify-between text-xs font-bold">
                <span>Max Work: ≤{rules.maxWorkdaysPerWeek}d</span>
                <span className="text-emerald-600 dark:text-emerald-400">2 OFFs</span>
              </div>
              <button
                type="button"
                onClick={() =>
                  setRules((r) => ({ ...r, allowSunMonSplitOff: !r.allowSunMonSplitOff }))
                }
                className={`w-full rounded-lg border px-2 py-1 text-[11px] font-bold transition cursor-pointer ${
                  rules.allowSunMonSplitOff
                    ? 'border-emerald-500/45 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                    : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-500'
                }`}
              >
                {rules.allowSunMonSplitOff
                  ? '✓ Sun+Mon Split OFF Allowed'
                  : 'Adjacent OFFs Only (Mon–Sun)'}
              </button>
            </div>

            <div className="cnx-input-tile rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 p-2.5 space-y-1.5">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Fair Weekly Shift Band
              </div>
              <div className="grid grid-cols-4 gap-1">
                {[0, 1, 2, 3].map((h) => (
                  <button
                    key={h}
                    type="button"
                    onClick={() => setRules((r) => ({ ...r, maxWeeklyStartDriftHours: h }))}
                    className={`rounded-lg py-1 text-[11px] font-mono font-bold border transition cursor-pointer ${
                      rules.maxWeeklyStartDriftHours === h
                        ? 'bg-[#0088c2] border-[#0088c2] text-white'
                        : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {h === 0 ? 'Fix' : `±${h}h`}
                  </button>
                ))}
              </div>
              <div className="text-[10px] text-slate-500 dark:text-slate-400">
                Blocks morning↔afternoon jumps
              </div>
            </div>

            <div className="cnx-input-tile rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 p-2.5 space-y-1.5">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Min Inter-Shift Rest
              </div>
              <div className="grid grid-cols-4 gap-1">
                {[10, 11, 12, 14].map((h) => (
                  <button
                    key={h}
                    type="button"
                    onClick={() => setRules((r) => ({ ...r, minInterShiftRestHours: h }))}
                    className={`rounded-lg py-1 text-[11px] font-mono font-bold border transition cursor-pointer ${
                      rules.minInterShiftRestHours === h
                        ? 'bg-emerald-600 border-emerald-600 text-white'
                        : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {h}h
                  </button>
                ))}
              </div>
              <div className="text-[10px] text-slate-500 dark:text-slate-400">
                No Clopening / Night→AM flips
              </div>
            </div>
          </div>

          {/* Break Constraints Pill + Expandable Config + Main Generate CTA */}
          <div className="rounded-xl border border-sky-500/30 bg-sky-500/5 dark:bg-sky-950/25 p-3 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-bold text-sky-700 dark:text-sky-300">
                  Auto Breaks: {rules.breakRules.firstBreakMin}m + {rules.breakRules.lunchMin}m Lunch + {rules.breakRules.lastBreakMin}m
                </span>
                <span className="rounded-md bg-white/80 dark:bg-slate-900 px-2 py-0.5 text-[11px] font-mono border border-slate-200 dark:border-slate-700">
                  Streak ≤ {(rules.breakRules.maxContinuousLoginMin / 60).toFixed(1)}h · Gap ≥ {rules.breakRules.minGapBetweenBreaksMin}m
                </span>
              </div>
              <button
                type="button"
                onClick={() => setShowBreakTuning((s) => !s)}
                className="text-[11px] font-semibold text-sky-600 dark:text-sky-400 hover:underline cursor-pointer"
              >
                {showBreakTuning ? 'Hide Break Tuning' : 'Tune Break Rules'}
              </button>
            </div>

            {showBreakTuning && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 text-[11px]">
                <div>
                  <label className="block text-slate-500 mb-0.5">First Break (m)</label>
                  <SmartNumberInput
                    value={rules.breakRules.firstBreakMin}
                    min={15}
                    max={30}
                    step={15}
                    onChange={(v) =>
                      setRules((r) => ({ ...r, breakRules: { ...r.breakRules, firstBreakMin: v } }))
                    }
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-500 mb-0.5">Lunch (m)</label>
                  <SmartNumberInput
                    value={rules.breakRules.lunchMin}
                    min={30}
                    max={60}
                    step={15}
                    onChange={(v) =>
                      setRules((r) => ({ ...r, breakRules: { ...r.breakRules, lunchMin: v } }))
                    }
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-500 mb-0.5">Max Streak (m)</label>
                  <SmartNumberInput
                    value={rules.breakRules.maxContinuousLoginMin}
                    min={120}
                    max={300}
                    step={15}
                    onChange={(v) =>
                      setRules((r) => ({
                        ...r,
                        breakRules: { ...r.breakRules, maxContinuousLoginMin: v },
                      }))
                    }
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-500 mb-0.5">Min Gap (m)</label>
                  <SmartNumberInput
                    value={rules.breakRules.minGapBetweenBreaksMin}
                    min={30}
                    max={120}
                    step={15}
                    onChange={(v) =>
                      setRules((r) => ({
                        ...r,
                        breakRules: { ...r.breakRules, minGapBetweenBreaksMin: v },
                      }))
                    }
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="button"
              onClick={() => {
                commitDraftShiftPins();
                commitDraftCellEdits();
                onAutoGenerate();
              }}
              className="cnx-pill-interactive flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#0088c2] to-[#14b8a6] hover:brightness-110 text-white px-4 py-2.5 text-xs font-extrabold shadow-md cursor-pointer"
            >
              <Sparkles className="w-4 h-4" />
              Auto-Optimize Weekly Roster &amp; 15m Breaks
            </button>
            <button
              type="button"
              onClick={onExportScheduleExcel}
              className="cnx-pill-interactive inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2.5 text-xs font-bold shadow-sm cursor-pointer"
            >
              <Download className="w-4 h-4" />
              Export Schedule .xlsx
            </button>
          </div>
        </section>
      </div>

      {/* =====================================================================
          2. 5 EXECUTIVE SCHEDULE KPI CARDS
         ===================================================================== */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3.5">
        <div className="card-elevated rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-xs">
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Total Roster Input
          </div>
          <div className="text-2xl font-black font-mono tabular-nums text-slate-900 dark:text-white mt-1">
            {summary.totalRosterInput}
            <span className="text-xs font-semibold text-slate-400 ml-1.5">Agents</span>
          </div>
          <div className="text-[11px] text-sky-600 dark:text-sky-400 font-medium mt-1">
            {rules.annualVisibilityInOutput === 'exclude'
              ? `AL Hidden: ${summary.annualExcluded}`
              : `AL in Roster: ${summary.annualExcluded}`}{' '}
            · Other Leaves: {summary.fullWeekExceptionsCount}
          </div>
        </div>

        <div className="card-elevated rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-xs">
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Active Working Pool
          </div>
          <div className="text-2xl font-black font-mono tabular-nums text-sky-600 dark:text-sky-400 mt-1">
            {summary.activeSchedulableCount}
            <span className="text-xs font-semibold text-slate-400 ml-1.5">
              ({summary.totalWorkShifts} shifts/wk)
            </span>
          </div>
          <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
            Net Paid Hrs: {summary.totalScheduledNetHours.toFixed(0)}h vs {summary.totalRequiredProdHours.toFixed(0)}h req
          </div>
        </div>

        <div className="card-elevated kpi-hero-accent rounded-xl border-2 border-sky-500/40 bg-sky-500/5 dark:bg-sky-950/30 p-4 shadow-xs">
          <div className="text-[11px] font-bold uppercase tracking-wider text-sky-700 dark:text-sky-300">
            Net Interval Coverage %
          </div>
          <div className="text-2xl font-black font-mono tabular-nums text-sky-700 dark:text-sky-300 mt-1">
            {summary.avgCoveragePct.toFixed(1)}%
          </div>
          <div className="text-[11px] text-slate-600 dark:text-slate-300 mt-1">
            True coverage after 15/30/15 breaks
          </div>
        </div>

        <div className="card-elevated rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-xs">
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Projected Weekly SL %
          </div>
          <div
            className={`text-2xl font-black font-mono tabular-nums mt-1 ${
              summary.projectedWeeklySlPct >= erlangConfig.slTargetPct
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-amber-600 dark:text-amber-400'
            }`}
          >
            {summary.projectedWeeklySlPct.toFixed(1)}%
            <span className="text-xs font-semibold text-slate-400 ml-1.5">
              / {erlangConfig.slTargetPct}%
            </span>
          </div>
          <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
            {summary.understaffedIntervalsTotal} tight/deficit intervals across 7d
          </div>
        </div>

        <button
          type="button"
          onClick={() => setMatrixFilter((f) => (f === 'alerts' ? 'all' : 'alerts'))}
          className={`text-left card-elevated kpi-hero-accent rounded-xl border-2 p-4 shadow-xs cursor-pointer ${
            summary.violationAgentsCount === 0
              ? 'border-emerald-500/40 bg-emerald-500/10 dark:bg-emerald-950/30'
              : 'border-amber-500/45 bg-amber-500/10 dark:bg-amber-950/30'
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300">
              Policy &amp; Break Audit
            </span>
            <ConstraintShieldIcon ok={summary.violationAgentsCount === 0} size={20} />
          </div>
          <div
            className={`text-xl font-black font-mono mt-1 ${
              summary.violationAgentsCount === 0
                ? 'text-emerald-700 dark:text-emerald-300'
                : 'text-amber-600 dark:text-amber-300'
            }`}
          >
            {summary.violationAgentsCount === 0
              ? '100% Compliant'
              : `${summary.violationAgentsCount} Rule Alerts`}
          </div>
          <div className="text-[11px] text-slate-600 dark:text-slate-300 mt-1">
            Valid Breaks: {summary.validBreakRatePct.toFixed(1)}% · Click to filter
          </div>
        </button>
      </div>

      {/* =====================================================================
          3. INTERACTIVE MON->SUN FORECAST COVERAGE & BREAK STAGGER CHART
         ===================================================================== */}
      <section className="bento-card-promax rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <ProMaxIconBadge tone="blue" size="md">
              <ShiftSchedulerIcon size={22} />
            </ProMaxIconBadge>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                  Scheduled Coverage vs Next Week Forecast &amp; Arrival Pattern (Mon → Sun)
                </h3>
                <span className="rounded-md border border-sky-500/35 bg-sky-500/10 px-2 py-0.5 text-[10px] font-mono font-bold text-sky-700 dark:text-sky-300">
                  {erlangConfig.useErlangA ? 'Palm Erlang-A' : 'Erlang C'}
                </span>
                {dailyTotals.length > 0 && (() => {
                  const covMean =
                    dailyTotals.reduce((s, d) => s + d.coveragePct, 0) / dailyTotals.length;
                  const covVar =
                    dailyTotals.reduce((s, d) => s + (d.coveragePct - covMean) ** 2, 0) /
                    dailyTotals.length;
                  const covCv = covMean > 0 ? (Math.sqrt(covVar) / covMean) * 100 : 0;
                  return (
                    <span className="rounded-md border border-indigo-500/35 bg-indigo-500/10 px-2 py-0.5 text-[10px] font-mono font-bold text-indigo-700 dark:text-indigo-300">
                      7d Balance CV: {covCv.toFixed(1)}%
                    </span>
                  );
                })()}
                <span className="rounded-md border border-emerald-500/35 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-mono font-bold text-emerald-700 dark:text-emerald-300">
                  {summary.validBreakRatePct.toFixed(1)}% Staggered Breaks
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Click any weekday card below to inspect 15/30/60-min interval coverage and live break staggering.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1 rounded-xl bg-slate-100 dark:bg-slate-950/70 p-1 border border-slate-200 dark:border-slate-800">
            <button
              type="button"
              onClick={() => setChartViewMode('intraday')}
              className={`px-3 py-1 rounded-lg text-xs font-bold transition cursor-pointer ${
                chartViewMode === 'intraday'
                  ? 'bg-[#0088c2] text-white'
                  : 'text-slate-500 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              Intraday Curve ({selectedDay})
            </button>
            <button
              type="button"
              onClick={() => setChartViewMode('weekly')}
              className={`px-3 py-1 rounded-lg text-xs font-bold transition cursor-pointer ${
                chartViewMode === 'weekly'
                  ? 'bg-[#0088c2] text-white'
                  : 'text-slate-500 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              7-Day Weekly Rollup
            </button>
          </div>
        </div>

        {/* 7 Clickable Mon-Sun Cards Synced with Next Week Forecast */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2.5">
          {dailyTotals.map((d) => {
            const isSelected = selectedDay === d.dayKey;
            const fcstDay = nextWeekDays.find((f) => f.dayKey === d.dayKey);
            return (
              <button
                key={d.dayKey}
                type="button"
                onClick={() => {
                  setSelectedDay(d.dayKey);
                  setChartViewMode('intraday');
                }}
                className={`cnx-pill-interactive text-left rounded-xl border p-2.5 cursor-pointer ${
                  isSelected
                    ? 'border-[#00A3E0] bg-sky-500/12 dark:bg-sky-950/45 ring-1 ring-[#00A3E0]/50'
                    : 'border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50'
                }`}
              >
                <div className="flex items-center justify-between text-xs font-bold">
                  <span className="text-slate-900 dark:text-white">{d.dayKey}</span>
                  <span
                    className={`rounded-md px-1.5 py-0.5 text-[10px] font-mono font-bold ${
                      d.coveragePct >= 95
                        ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                        : d.coveragePct >= 85
                          ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300'
                          : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                    }`}
                  >
                    {d.coveragePct.toFixed(0)}%
                  </span>
                </div>
                <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 mt-0.5">
                  {(fcstDay?.dateIso ?? d.dateIso).slice(5)} · {d.forecastVolume.toLocaleString()} calls
                </div>
                <div className="flex items-center justify-between text-[10px] font-mono mt-1">
                  <span className="text-sky-600 dark:text-sky-400">
                    {d.scheduledNetHours.toFixed(0)}h / {d.requiredProdHours.toFixed(0)}h
                  </span>
                  <span
                    className={
                      d.understaffedIntervals > 0
                        ? 'text-amber-600 dark:text-amber-400 font-bold'
                        : 'text-emerald-600 dark:text-emerald-400'
                    }
                  >
                    {d.understaffedIntervals > 0 ? `${d.understaffedIntervals} low` : '✓ Covered'}
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        <InteractiveRosterCoverageChart
          selectedDay={selectedDay}
          cells={coverageByDay[selectedDay] ?? []}
          dailyTotals={dailyTotals}
          viewMode={chartViewMode}
        />
      </section>

      {/* =====================================================================
          4. INTERACTIVE EDITABLE WEEKLY ROSTER & BREAK MATRIX
         ===================================================================== */}
      <section className="bento-card-promax rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-xs">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <Layers className="w-4 h-4 text-sky-500" />
              Interactive Editable Agent Schedule &amp; Break Matrix ({filteredRows.length} shown)
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Click any agent name to rename, or click any day cell (Mon–Sun) to manually swap shifts, toggle OFF/Leaves, or customize 15m + 30m + 15m breaks.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search name, #ID, shift, or OFF..."
                aria-label="Search agent roster"
                className="pl-8 pr-7 py-1.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/60 text-xs w-56 focus:outline-none focus:border-sky-500"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  aria-label="Clear roster search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="flex items-center gap-1 rounded-xl bg-slate-100 dark:bg-slate-950/70 p-1 border border-slate-200 dark:border-slate-800">
              {(
                [
                  { id: 'all', label: 'All' },
                  { id: 'active', label: 'Active' },
                  { id: 'leaves', label: 'Leaves' },
                  { id: 'alerts', label: `Alerts (${summary.violationAgentsCount})` },
                  { id: 'manual', label: 'Edited' },
                ] as const
              ).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setMatrixFilter(f.id)}
                  className={`px-2 py-1 rounded-lg text-[11px] font-bold transition cursor-pointer ${
                    matrixFilter === f.id
                      ? 'bg-[#0088c2] text-white'
                      : 'text-slate-500 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setShowBreakDetails((v) => !v)}
              className={`cnx-pill-interactive rounded-xl border px-2.5 py-1.5 text-[11px] font-bold cursor-pointer ${
                showBreakDetails
                  ? 'border-teal-500/40 bg-teal-500/10 text-teal-700 dark:text-teal-300'
                  : 'border-slate-300 dark:border-slate-700 text-slate-500'
              }`}
            >
              {showBreakDetails ? 'Breaks Visible (15/30/15)' : 'Compact Shifts Only'}
            </button>

            <button
              type="button"
              onClick={() => {
                commitDraftShiftPins();
                commitDraftCellEdits();
                onAutoGenerate();
              }}
              title="Reset manual edits and re-optimize schedule"
              className="cnx-pill-interactive inline-flex items-center gap-1 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2.5 py-1.5 text-[11px] font-semibold cursor-pointer"
            >
              <RefreshCw className="w-3 h-3" />
              Re-Solve
            </button>
          </div>
        </div>

        <div className="overflow-x-auto overflow-y-auto max-h-[620px]">
          <table className="w-full min-w-[760px] md:min-w-0 table-fixed text-xs border-collapse">
            <thead className="sticky top-0 z-20 bg-slate-100 dark:bg-slate-950 text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th
                  className={`sticky left-0 z-30 bg-slate-100 dark:bg-slate-950 text-left px-2 py-2 font-bold ${
                    hasLongNames ? 'w-[16%]' : 'w-[10.5%]'
                  }`}
                >
                  Agent / ID
                </th>
                <th
                  className={`text-center px-1 py-2 font-bold ${
                    hasLongNames ? 'w-[8.2%]' : 'w-[8.8%]'
                  }`}
                >
                  OFF / Profile
                </th>
                {WEEK_DAYS.map((dk) => {
                  const dt = dailyTotals.find((d) => d.dayKey === dk);
                  return (
                    <th
                      key={dk}
                      className={`text-center px-0.5 xl:px-1 py-2 font-bold ${
                        hasLongNames ? 'w-[9.9%]' : 'w-[10.5%]'
                      }`}
                    >
                      <div>{dk}</div>
                      <div className="text-[10px] font-mono font-normal text-slate-400 truncate">
                        {dt?.dateIso.slice(5)} · {dt?.coveragePct.toFixed(0)}%
                      </div>
                    </th>
                  );
                })}
                <th
                  className={`text-center px-1 py-2 font-bold ${
                    hasLongNames ? 'w-[6.5%]' : 'w-[7.2%]'
                  }`}
                >
                  Compliance
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-10 text-center text-slate-400">
                    No agents match this filter. Try clearing the search query or switching filter to &quot;All&quot;.
                  </td>
                </tr>
              ) : (
                filteredRows.map(({ agent, rowNum }) => {
                  const hasAlerts = agent.violations.length > 0;
                  return (
                    <tr
                      key={agent.agentId}
                      className="hover:bg-sky-500/5 transition"
                    >
                      {/* Sticky Adaptive Agent Name Column (Inline editable, auto-wraps long names cleanly) */}
                      <td className="sticky left-0 z-10 bg-white dark:bg-slate-900 px-2 py-1.5 border-r border-slate-100 dark:border-slate-800/80 align-middle">
                        {editingNameAgentId === agent.agentId ? (
                          <input
                            type="text"
                            autoFocus
                            value={editingNameValue}
                            onChange={(e) => setEditingNameValue(e.target.value)}
                            onBlur={() => commitInlineName(agent.agentId)}
                            onKeyDown={(e) => e.key === 'Enter' && commitInlineName(agent.agentId)}
                            className="w-full rounded-md border border-sky-500 bg-white dark:bg-slate-950 px-1.5 py-1 text-xs font-bold"
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setEditingNameAgentId(agent.agentId);
                              setEditingNameValue(agent.agentName);
                            }}
                            className="w-full group flex items-center gap-1.5 text-left font-bold text-slate-900 dark:text-slate-100 hover:text-sky-600 dark:hover:text-sky-400 cursor-pointer"
                            title={`${agent.agentName} (#${rowNum}) — Click to rename`}
                          >
                            <span className="shrink-0 rounded bg-slate-100 dark:bg-slate-800 px-1 py-0.5 text-[9.5px] font-mono font-bold text-slate-500 dark:text-slate-400">
                              #{rowNum}
                            </span>
                            <span
                              className={`min-w-0 flex-1 whitespace-normal break-words leading-[1.2] text-left ${
                                agent.agentName.length > 18
                                  ? 'text-[10.5px] xl:text-[11px]'
                                  : 'text-[11.5px] xl:text-xs'
                              }`}
                            >
                              {agent.agentName}
                            </span>
                            <Pencil className="w-3 h-3 opacity-0 group-hover:opacity-75 transition shrink-0" />
                          </button>
                        )}
                      </td>

                      {/* OFF Pattern & Drift Summary */}
                      <td className="px-1 py-1.5 text-center">
                        <span
                          className={`inline-block max-w-full rounded-lg border px-1.5 py-0.5 text-[10px] font-bold leading-tight ${
                            agent.preAllocatedException
                              ? EXCEPTION_BADGE_STYLES[agent.preAllocatedException]
                              : agent.offPatternLabel.includes('Split')
                                ? 'border-teal-500/35 bg-teal-500/10 text-teal-700 dark:text-teal-300'
                                : 'border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/60 text-slate-600 dark:text-slate-300'
                          }`}
                        >
                          {agent.offPatternLabel || 'Custom'}
                        </span>
                        {agent.workDaysCount > 0 && (
                          <div className="text-[9px] font-mono text-slate-400 mt-0.5 truncate">
                            {agent.workDaysCount}d · Δ{agent.shiftBandSpanHours.toFixed(1)}h · R
                            {agent.minRestHoursObserved !== null
                              ? `${agent.minRestHoursObserved.toFixed(0)}h`
                              : '—'}
                          </div>
                        )}
                      </td>

                      {/* Interactive Day Cells (Mon .. Sun) */}
                      {WEEK_DAYS.map((dk) => {
                        const cell = agent.assignments[dk];
                        const shift = cell?.shiftId ? shiftMap.get(cell.shiftId) : null;
                        const isException = cell && cell.status !== 'WORK' && cell.status !== 'OFF';

                        return (
                          <td key={dk} className="px-0.5 xl:px-1 py-1 text-center align-middle">
                            <button
                              type="button"
                              onClick={() => openCellEditor(agent.agentId, dk)}
                              className={`cnx-pill-interactive w-full ${
                                showBreakDetails ? 'min-h-[46px]' : 'min-h-[34px]'
                              } flex flex-col items-center justify-center rounded-xl border px-1.5 py-1.5 text-center transition cursor-pointer overflow-hidden ${
                                cell.status === 'WORK' && shift
                                  ? 'border-sky-500/30 bg-sky-500/10 hover:border-sky-400 dark:bg-sky-950/40'
                                  : isException
                                    ? EXCEPTION_BADGE_STYLES[cell.status as ExceptionCode]
                                    : 'border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-400 hover:border-slate-400'
                              } ${cell.isManualOverride ? 'ring-1 ring-amber-400/70' : ''}`}
                            >
                              {cell.status === 'WORK' && shift ? (
                                <div className="w-full min-w-0 flex flex-col items-center justify-center text-center">
                                  <div className="flex items-center justify-center gap-1 font-mono font-extrabold text-[10.5px] xl:text-[11px] text-slate-900 dark:text-sky-200 whitespace-nowrap">
                                    <span>{shift.label}</span>
                                    {cell.breaks && !cell.breaks.isValid && (
                                      <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0" />
                                    )}
                                  </div>
                                  {showBreakDetails && cell.breaks && (
                                    <div className="flex flex-wrap items-center justify-center gap-x-1 text-[8.5px] xl:text-[9px] font-mono text-slate-600 dark:text-slate-300/90 mt-0.5 leading-tight text-center">
                                      <span>B1 {cell.breaks.firstBreakLabel.split('–')[0]}</span>
                                      <span>L {cell.breaks.lunchLabel.split('–')[0]}</span>
                                      <span>B2 {cell.breaks.lastBreakLabel.split('–')[0]}</span>
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <div className="text-center font-mono font-bold text-[11px] truncate">
                                  {cell.status}
                                </div>
                              )}
                            </button>
                          </td>
                        );
                      })}

                      {/* Compliance Status */}
                      <td className="px-1 py-1.5 text-center">
                        {hasAlerts ? (
                          <span
                            title={agent.violations.join(' | ')}
                            className="inline-flex max-w-full items-center gap-1 rounded-lg border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold text-amber-700 dark:text-amber-300 truncate"
                          >
                            <AlertTriangle className="w-3 h-3 shrink-0" />
                            <span className="truncate">{agent.violations[0]}</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300">
                            <CheckCircle2 className="w-3 h-3 shrink-0" />
                            Valid
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* =====================================================================
          5. INLINE INTERACTIVE CELL & BREAK POPOVER EDITOR
         ===================================================================== */}
      {editingTarget && (() => {
        const agentWorkDays = WEEK_DAYS.filter(
          (d) => editingTarget.agent.assignments[d]?.status === 'WORK'
        );
        const setPresetDays = (days: DayKey[]) => {
          setSelectedPopoverDays(days.length > 0 ? days : [editingTarget.dayKey]);
        };
        const isWorkdaysSelected =
          agentWorkDays.length > 0 &&
          selectedPopoverDays.length === agentWorkDays.length &&
          agentWorkDays.every((d) => selectedPopoverDays.includes(d));
        const isMonFriSelected =
          selectedPopoverDays.length === 5 &&
          ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].every((d) => selectedPopoverDays.includes(d as DayKey));
        const isWeekendSelected =
          selectedPopoverDays.length === 2 &&
          selectedPopoverDays.includes('Sat') &&
          selectedPopoverDays.includes('Sun');
        const isAll7Selected = selectedPopoverDays.length === 7;
        const isSingleDaySelected =
          selectedPopoverDays.length === 1 && selectedPopoverDays[0] === editingTarget.dayKey;

        return createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-xs p-4 no-print"
          style={{ backgroundColor: 'rgba(11, 21, 32, 0.58)' }}
          onClick={() => setEditingCell(null)}
        >
          <div
            className="w-full max-w-lg rounded-2xl border border-sky-500/40 bg-white dark:bg-slate-900 p-5 shadow-2xl space-y-4 animate-slide-up max-h-[92vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h4 className="text-sm font-extrabold text-slate-900 dark:text-white flex items-center gap-2">
                  <span>{editingTarget.agent.agentName}</span>
                  <span className="rounded-md bg-sky-500/15 text-sky-600 dark:text-sky-300 px-2 py-0.5 text-xs font-mono">
                    {selectedPopoverDays.length === 1
                      ? selectedPopoverDays[0]
                      : `${selectedPopoverDays.length} Days`}
                  </span>
                </h4>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Choose which day(s) to edit below, then apply a shift, OFF/leave status, or break schedule in one click.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditingCell(null)}
                aria-label="Close cell editor"
                className="rounded-lg p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Multi-Day Scope Selector (Single Day, Workdays, Mon–Fri, Weekend, All 7 Days, or Custom Pick) */}
            <div className="rounded-xl border border-sky-500/25 bg-sky-500/[0.05] p-2.5 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Apply Scope ({selectedPopoverDays.join(', ')})
                </span>
                <div className="flex flex-wrap gap-1">
                  <button
                    type="button"
                    onClick={() => setPresetDays([editingTarget.dayKey])}
                    className={`rounded-md px-2 py-0.5 text-[10px] font-bold border transition cursor-pointer ${
                      isSingleDaySelected
                        ? 'border-[#0088c2] bg-[#0088c2] text-white'
                        : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    Only {editingTarget.dayKey}
                  </button>
                  {agentWorkDays.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setPresetDays(agentWorkDays)}
                      className={`rounded-md px-2 py-0.5 text-[10px] font-bold border transition cursor-pointer ${
                        isWorkdaysSelected
                          ? 'border-[#0088c2] bg-[#0088c2] text-white'
                          : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      Workdays ({agentWorkDays.length}d)
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setPresetDays(['Mon', 'Tue', 'Wed', 'Thu', 'Fri'])}
                    className={`rounded-md px-2 py-0.5 text-[10px] font-bold border transition cursor-pointer ${
                      isMonFriSelected
                        ? 'border-[#0088c2] bg-[#0088c2] text-white'
                        : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    Mon–Fri
                  </button>
                  <button
                    type="button"
                    onClick={() => setPresetDays(['Sat', 'Sun'])}
                    className={`rounded-md px-2 py-0.5 text-[10px] font-bold border transition cursor-pointer ${
                      isWeekendSelected
                        ? 'border-[#0088c2] bg-[#0088c2] text-white'
                        : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    Sat+Sun
                  </button>
                  <button
                    type="button"
                    onClick={() => setPresetDays([...WEEK_DAYS])}
                    className={`rounded-md px-2 py-0.5 text-[10px] font-bold border transition cursor-pointer ${
                      isAll7Selected
                        ? 'border-[#0088c2] bg-[#0088c2] text-white'
                        : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    All 7d
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-7 gap-1">
                {WEEK_DAYS.map((d) => {
                  const active = selectedPopoverDays.includes(d);
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => togglePopoverDay(d)}
                      aria-pressed={active}
                      className={`rounded-lg border py-1 text-[10.5px] font-mono font-bold transition cursor-pointer ${
                        active
                          ? 'border-[#0088c2] bg-[#0088c2] text-white shadow-xs'
                          : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400 hover:border-sky-400'
                      }`}
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Day Status Pills (OFF + Exception Codes) */}
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">
                Day Off / Leave Code
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(['OFF', 'AL', 'MAT', 'RES', 'TERM', 'UPL', 'PAT'] as LeaveAllocationCode[]).map(
                  (code) => {
                    const active = editingTarget.assign.status === code;
                    return (
                      <button
                        key={code}
                        type="button"
                        onClick={() =>
                          applyCellAssignment(editingTarget.agent.agentId, selectedPopoverDays, {
                            status: code,
                          })
                        }
                        className={`rounded-lg border px-2.5 py-1 text-xs font-bold transition cursor-pointer ${
                          active
                            ? 'border-[#0088c2] bg-[#0088c2] text-white'
                            : 'border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/60 hover:border-sky-400'
                        }`}
                      >
                        {code === 'OFF' ? 'OFF' : `${code} (${EXCEPTION_META[code as ExceptionCode].short})`}
                      </button>
                    );
                  }
                )}
              </div>

              {editingTarget.assign.status !== 'WORK' && editingTarget.assign.status !== 'OFF' && (
                <button
                  type="button"
                  onClick={() =>
                    applyCellAssignment(
                      editingTarget.agent.agentId,
                      selectedPopoverDays,
                      { status: editingTarget.assign.status },
                      true
                    )
                  }
                  className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-[11px] font-bold text-amber-700 dark:text-amber-300 cursor-pointer"
                >
                  Apply {editingTarget.assign.status} across entire week (Mon → Sun)
                </button>
              )}
            </div>

            {/* External Shift Catalog Picker with Live Rule Guard */}
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">
                Assign Shift Across {selectedPopoverDays.length} Day(s) (≤{rules.maxWeeklyStartDriftHours}h Drift &amp; ≥{rules.minInterShiftRestHours}h Rest)
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-48 overflow-y-auto pr-1">
                {sortedCatalog.map((sh) => {
                  const isCurrent =
                    editingTarget.assign.status === 'WORK' &&
                    editingTarget.assign.shiftId === sh.id;
                  const compat = previewShiftCompatibility(
                    editingTarget.agent,
                    selectedPopoverDays,
                    sh
                  );
                  return (
                    <button
                      key={sh.id}
                      type="button"
                      onClick={() =>
                        applyCellAssignment(editingTarget.agent.agentId, selectedPopoverDays, {
                          status: 'WORK',
                          shiftId: sh.id,
                          breaks: assignOptimalBreaksForShift(
                            sh,
                            new Array<number>(96).fill(2),
                            rules.breakRules
                          ),
                        })
                      }
                      className={`rounded-xl border px-3 py-2 text-left transition cursor-pointer ${
                        isCurrent
                          ? 'border-[#00A3E0] bg-sky-500/15 ring-1 ring-[#00A3E0]'
                          : compat.ok
                            ? 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/60 hover:border-sky-400'
                            : 'border-amber-500/35 bg-amber-500/5 hover:border-amber-400'
                      }`}
                    >
                      <div className="flex items-center justify-between font-mono text-xs font-bold">
                        <span>{sh.label}</span>
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded ${
                            compat.ok
                              ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                              : 'bg-amber-500/20 text-amber-600 dark:text-amber-300'
                          }`}
                        >
                          {compat.reason}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Interactive Break Timeline Editor (when status === WORK & shift exists) */}
            {editingTarget.assign.status === 'WORK' &&
              editingTarget.assign.shiftId &&
              shiftMap.get(editingTarget.assign.shiftId) &&
              editingTarget.assign.breaks && (() => {
                const activeShift = shiftMap.get(editingTarget.assign.shiftId!)!;
                const br = editingTarget.assign.breaks!;
                const bOffsets = Array.from(
                  { length: Math.max(1, Math.floor((activeShift.durationMin - 30) / 15)) },
                  (_, idx) => (idx + 1) * 15
                );
                const updateBreaks = (o1: number, oL: number, o2: number) => {
                  const nextBr = buildBreakAssignment(activeShift, o1, oL, o2, rules.breakRules);
                  applyCellAssignment(editingTarget.agent.agentId, selectedPopoverDays, {
                    breaks: nextBr,
                  });
                };

                return (
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 p-3 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-bold text-slate-700 dark:text-slate-200">
                        Sub-Interval Breaks (15m + 30m Lunch + 15m)
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                          br.isValid
                            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                            : 'bg-amber-500/20 text-amber-700 dark:text-amber-300'
                        }`}
                      >
                        Max Streak {(br.maxContinuousWorkMin / 60).toFixed(2)}h · Min Gap {br.minInterBreakGapMin}m
                      </span>
                    </div>

                    {/* Visual Break Bar along the shift timeline */}
                    <div className="relative h-4 w-full rounded-lg overflow-hidden bg-sky-500/20 border border-sky-500/30">
                      <div
                        style={{
                          left: `${(br.firstBreakOffsetMin / activeShift.durationMin) * 100}%`,
                          width: `${(rules.breakRules.firstBreakMin / activeShift.durationMin) * 100}%`,
                        }}
                        className="absolute top-0 bottom-0 bg-[#00A3E0]"
                        title={`First Break: ${br.firstBreakLabel}`}
                      />
                      <div
                        style={{
                          left: `${(br.lunchOffsetMin / activeShift.durationMin) * 100}%`,
                          width: `${(rules.breakRules.lunchMin / activeShift.durationMin) * 100}%`,
                        }}
                        className="absolute top-0 bottom-0 bg-[#14b8a6]"
                        title={`Lunch: ${br.lunchLabel}`}
                      />
                      <div
                        style={{
                          left: `${(br.lastBreakOffsetMin / activeShift.durationMin) * 100}%`,
                          width: `${(rules.breakRules.lastBreakMin / activeShift.durationMin) * 100}%`,
                        }}
                        className="absolute top-0 bottom-0 bg-[#00C389]"
                        title={`Last Break: ${br.lastBreakLabel}`}
                      />
                    </div>

                    <div className="grid grid-cols-3 gap-2 text-[11px]">
                      <div>
                        <label className="block text-slate-500 mb-0.5">First 15m</label>
                        <select
                          value={br.firstBreakOffsetMin}
                          onChange={(e) =>
                            updateBreaks(Number(e.target.value), br.lunchOffsetMin, br.lastBreakOffsetMin)
                          }
                          className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono"
                        >
                          {bOffsets.map((off) => (
                            <option key={off} value={off}>
                              {formatMinutesHHMM(activeShift.startMin + off)}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-slate-500 mb-0.5">Lunch 30m</label>
                        <select
                          value={br.lunchOffsetMin}
                          onChange={(e) =>
                            updateBreaks(br.firstBreakOffsetMin, Number(e.target.value), br.lastBreakOffsetMin)
                          }
                          className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono"
                        >
                          {bOffsets.map((off) => (
                            <option key={off} value={off}>
                              {formatMinutesHHMM(activeShift.startMin + off)}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-slate-500 mb-0.5">Last 15m</label>
                        <select
                          value={br.lastBreakOffsetMin}
                          onChange={(e) =>
                            updateBreaks(br.firstBreakOffsetMin, br.lunchOffsetMin, Number(e.target.value))
                          }
                          className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono"
                        >
                          {bOffsets.map((off) => (
                            <option key={off} value={off}>
                              {formatMinutesHHMM(activeShift.startMin + off)}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                );
              })()}

            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setEditingCell(null)}
                className="rounded-xl bg-[#0088c2] hover:bg-[#0073a8] text-white px-4 py-1.5 text-xs font-bold cursor-pointer"
              >
                Done
              </button>
            </div>
          </div>
        </div>,
        document.body
        );
      })()}

      {/* =====================================================================
          6. SCHEDULED HEADCOUNT PER SHIFT × PER DAY (MON → SUN) — EDITABLE DAILY PINS
         ===================================================================== */}
      {(() => {
        const dayPinsAll = rules.shiftDayHeadcountOverrides ?? {};
        const hasAnyDailyPins = Object.values(dayPinsAll).some(
          (shMap) =>
            shMap &&
            Object.values(shMap).some((v) => v != null && Number.isFinite(v))
        );

        const getEffectiveCellCount = (row: typeof scheduleResult.shiftDailyMix[number], d: DayKey): number => {
          const staged = draftCellEdits[row.shiftId]?.[d];
          if (staged !== undefined) {
            const trimmed = staged.trim();
            if (trimmed === '') return row.byDay[d];
            const parsed = Number(trimmed);
            if (Number.isFinite(parsed)) return Math.max(0, Math.min(500, Math.round(parsed)));
          }
          return row.byDay[d];
        };

        const liveRowTotals = scheduleResult.shiftDailyMix.map((row) => {
          const byDayLive = {} as Record<DayKey, number>;
          let rowSum = 0;
          for (const d of WEEK_DAYS) {
            const val = getEffectiveCellCount(row, d);
            byDayLive[d] = val;
            rowSum += val;
          }
          return { row, byDayLive, rowSum };
        });

        const dailyActive = WEEK_DAYS.map((d) =>
          liveRowTotals.reduce((acc, item) => acc + item.byDayLive[d], 0)
        );
        const dailyOff = hasPendingCellEdits
          ? dailyActive.map((act) => Math.max(0, summary.activeSchedulableCount - act))
          : WEEK_DAYS.map((d) => scheduleResult.agents.filter((a) => a.assignments[d].status === 'OFF').length);
        const dailyLeave = WEEK_DAYS.map(
          (d) =>
            scheduleResult.agents.filter(
              (a) => a.assignments[d].status !== 'WORK' && a.assignments[d].status !== 'OFF'
            ).length
        );
        const totalWeeklyActive = dailyActive.reduce((s, v) => s + v, 0);
        const totalWeeklyOff = dailyOff.reduce((s, v) => s + v, 0);
        const totalWeeklyLeave = dailyLeave.reduce((s, v) => s + v, 0);

        return (
      <section className="bento-card-promax rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-xs">
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs font-bold text-slate-800 dark:text-slate-100">
            <CalendarClock className="w-4 h-4 text-sky-500" />
            <span>Scheduled Headcount Per Shift × Per Day (Mon → Sun Coverage Mix)</span>
            <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium text-sky-700 dark:text-sky-300">
              Edit cells without auto-adjust — untouched cells stay Auto
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {hasPendingCellEdits && (
              <>
                <button
                  type="button"
                  onClick={commitDraftCellEdits}
                  className="cnx-pill-interactive rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1 text-[11px] font-bold shadow-xs cursor-pointer"
                >
                  ✓ Apply Manual Edits
                </button>
                <button
                  type="button"
                  onClick={() => setDraftCellEdits({})}
                  className="rounded-lg border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-[11px] font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                >
                  Discard
                </button>
              </>
            )}
            {(hasAnyDailyPins || hasPendingCellEdits) && (
              <button
                type="button"
                onClick={() => {
                  setDraftCellEdits({});
                  setRules((r) => ({ ...r, shiftDayHeadcountOverrides: {} }));
                }}
                className="cnx-pill-interactive rounded-lg border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 px-2.5 py-1 text-[11px] font-bold text-amber-700 dark:text-amber-300 cursor-pointer"
              >
                Reset Daily Pins
              </button>
            )}
            <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
              Chronologically Sorted · {scheduleResult.shiftDailyMix.length} Shifts · {summary.activeSchedulableCount} Active Pool
            </span>
          </div>
        </div>
        {hasPendingCellEdits && (
          <div className="px-5 py-2 bg-emerald-500/[0.08] border-b border-emerald-500/25 flex flex-wrap items-center justify-between gap-2 text-[11px] font-semibold text-emerald-800 dark:text-emerald-200">
            <span>
              Pending edits staged (live totals updated) — other cells will NOT auto-adjust until you click{' '}
              <strong>✓ Apply Manual Edits</strong>. Only your edited cells lock; untouched cells remain Auto.
            </span>
            <button
              type="button"
              onClick={commitDraftCellEdits}
              className="rounded-md bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-0.5 text-[10.5px] font-bold cursor-pointer"
            >
              ✓ Apply Manual Edits Now
            </button>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-100 dark:bg-slate-950 text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-4 py-2 text-left">Shift Window</th>
                <th className="px-3 py-2 text-right">Weekly Pool</th>
                <th className="px-3 py-2 text-right">Avg / Day</th>
                {WEEK_DAYS.map((d) => (
                  <th key={d} className="px-2 py-2 text-center">
                    {d}
                  </th>
                ))}
                <th className="px-3 py-2 text-right">Weekly Shifts</th>
                <th className="px-4 py-2 text-right">Mix %</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70 font-mono">
              {liveRowTotals.map(({ row, rowSum }) => {
                const liveAvg = rowSum / 7;
                const liveMixPct = totalWeeklyActive > 0 ? (rowSum / totalWeeklyActive) * 100 : 0;
                return (
                <tr key={row.shiftId} className="hover:bg-sky-500/5 transition">
                  <td className="px-4 py-2 text-left font-sans">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono font-bold text-slate-900 dark:text-white">
                        {row.shiftLabel}
                      </span>
                      <span className="text-[10px] font-mono text-slate-400">
                        ({row.durationHours.toFixed(0)}h)
                      </span>
                      {row.wrapsMidnight && (
                        <span className="rounded-md border border-indigo-500/35 bg-indigo-500/12 px-1.5 py-0.5 text-[10px] font-bold text-indigo-700 dark:text-indigo-300">
                          Overnight
                        </span>
                      )}
                      {row.targetOverride != null && (
                        <span className="rounded-md border border-amber-500/40 bg-amber-500/12 px-1.5 py-0.5 text-[10px] font-bold text-amber-700 dark:text-amber-300">
                          Pinned: {row.targetOverride}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right font-bold">
                    <span
                      className={
                        row.targetOverride != null
                          ? 'text-amber-600 dark:text-amber-300'
                          : 'text-sky-600 dark:text-sky-400'
                      }
                    >
                      {row.assignedPoolCount}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right text-slate-500 dark:text-slate-400">
                    {liveAvg.toFixed(1)}
                  </td>
                  {WEEK_DAYS.map((d) => {
                    const stagedRaw = draftCellEdits[row.shiftId]?.[d];
                    const isStaged = stagedRaw !== undefined;
                    const rawDayPin = rules.shiftDayHeadcountOverrides?.[row.shiftId]?.[d];
                    const hasCommittedPin =
                      rawDayPin !== undefined && rawDayPin !== null && Number.isFinite(rawDayPin);
                    const actualVal = row.byDay[d];
                    const displayedVal = isStaged
                      ? stagedRaw
                      : hasCommittedPin
                        ? String(rawDayPin)
                        : '';

                    return (
                      <td key={d} className="px-1.5 py-1.5 text-center">
                        <div className="flex flex-col items-center">
                          <input
                            type="number"
                            min={0}
                            max={500}
                            step={1}
                            value={displayedVal}
                            placeholder={String(actualVal)}
                            aria-label={`${row.shiftLabel} ${d} daily scheduled headcount`}
                            onChange={(e) => {
                              const raw = e.target.value;
                              setDraftCellEdits((prev) => ({
                                ...prev,
                                [row.shiftId]: { ...(prev[row.shiftId] ?? {}), [d]: raw },
                              }));
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.currentTarget.blur();
                                commitDraftCellEdits();
                              } else if (e.key === 'Escape') {
                                setDraftCellEdits((prev) => {
                                  const nextSh = { ...(prev[row.shiftId] ?? {}) };
                                  delete nextSh[d];
                                  const next = { ...prev };
                                  if (Object.keys(nextSh).length === 0) delete next[row.shiftId];
                                  else next[row.shiftId] = nextSh;
                                  return next;
                                });
                              }
                            }}
                            className={`w-14 rounded-lg border px-1.5 py-1 text-center text-xs font-mono font-bold transition focus:outline-none focus:border-sky-500 ${
                              isStaged
                                ? 'border-emerald-500 bg-emerald-500/15 text-emerald-700 dark:text-emerald-200 ring-2 ring-emerald-500/35'
                                : hasCommittedPin
                                  ? 'border-amber-500/60 bg-amber-500/12 text-amber-700 dark:text-amber-300 ring-1 ring-amber-500/25'
                                  : actualVal > 0
                                    ? 'border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 text-slate-900 dark:text-slate-100 placeholder:text-slate-800 dark:placeholder:text-slate-100 hover:border-sky-400'
                                    : 'border-slate-200/70 dark:border-slate-800/70 bg-transparent text-slate-400 placeholder:text-slate-300 dark:placeholder:text-slate-700 hover:border-sky-400'
                            }`}
                          />
                          {!isStaged && hasCommittedPin && actualVal !== rawDayPin && (
                            <span
                              className="mt-0.5 text-[9px] font-bold text-slate-500 dark:text-slate-400"
                              title="Actual scheduled count after roster constraints"
                            >
                              act:{actualVal}
                            </span>
                          )}
                        </div>
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-right font-bold text-slate-900 dark:text-white">
                    {rowSum}
                  </td>
                  <td className="px-4 py-2 text-right font-semibold text-sky-600 dark:text-sky-400">
                    {liveMixPct.toFixed(1)}%
                  </td>
                </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-slate-50 dark:bg-slate-950/80 border-t-2 border-slate-200 dark:border-slate-800 font-mono text-xs">
              <tr className="font-bold text-slate-900 dark:text-white bg-sky-500/[0.06]">
                <td className="px-4 py-2 text-left font-sans">TOTAL ACTIVE WORKING SHIFTS</td>
                <td className="px-3 py-2 text-right text-sky-600 dark:text-sky-400">
                  {summary.activeSchedulableCount}
                </td>
                <td className="px-3 py-2 text-right">{(totalWeeklyActive / 7).toFixed(1)}</td>
                {dailyActive.map((cnt, idx) => (
                  <td key={WEEK_DAYS[idx]} className="px-3 py-2 text-right text-sky-700 dark:text-sky-300">
                    {cnt}
                  </td>
                ))}
                <td className="px-3 py-2 text-right">{totalWeeklyActive}</td>
                <td className="px-4 py-2 text-right">100.0%</td>
              </tr>
              <tr className="text-emerald-700 dark:text-emerald-300">
                <td className="px-4 py-1.5 text-left font-sans font-semibold">Scheduled Day OFFs</td>
                <td className="px-3 py-1.5 text-right">—</td>
                <td className="px-3 py-1.5 text-right">{(totalWeeklyOff / 7).toFixed(1)}</td>
                {dailyOff.map((cnt, idx) => (
                  <td key={WEEK_DAYS[idx]} className="px-3 py-1.5 text-right">
                    {cnt}
                  </td>
                ))}
                <td className="px-3 py-1.5 text-right font-semibold">{totalWeeklyOff}</td>
                <td className="px-4 py-1.5 text-right">—</td>
              </tr>
              <tr className="text-amber-700 dark:text-amber-300">
                <td className="px-4 py-1.5 text-left font-sans font-semibold">
                  Full-Week Leaves (AL / MAT / RES / TERM / UPL / PAT)
                </td>
                <td className="px-3 py-1.5 text-right">{dailyLeave[0] ?? 0}</td>
                <td className="px-3 py-1.5 text-right">{(totalWeeklyLeave / 7).toFixed(1)}</td>
                {dailyLeave.map((cnt, idx) => (
                  <td key={WEEK_DAYS[idx]} className="px-3 py-1.5 text-right">
                    {cnt}
                  </td>
                ))}
                <td className="px-3 py-1.5 text-right font-semibold">{totalWeeklyLeave}</td>
                <td className="px-4 py-1.5 text-right">—</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>
        );
      })()}

      {/* =====================================================================
          7. DAILY SUMMARY ROLLUP TABLE
         ===================================================================== */}
      <section className="bento-card-promax rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-xs">
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-bold text-slate-800 dark:text-slate-100">
            <FileSpreadsheet className="w-4 h-4 text-emerald-500" />
            Weekly Mon → Sun Coverage Audit Summary (Forecast × Erlang Required × Net Scheduled)
          </div>
          <span className="text-[11px] font-mono text-slate-400">
            Granularity: {erlangConfig.granularityMin} min
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-100 dark:bg-slate-950 text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-4 py-2 text-left">Day</th>
                <th className="px-4 py-2 text-left">Forecast Date</th>
                <th className="px-4 py-2 text-right">Forecast Calls</th>
                <th className="px-4 py-2 text-right">Req Prod Hrs</th>
                <th className="px-4 py-2 text-right">Gross Shift Hrs</th>
                <th className="px-4 py-2 text-right">Net Paid Hrs (-Breaks)</th>
                <th className="px-4 py-2 text-right">Coverage %</th>
                <th className="px-4 py-2 text-right">Peak Req / Net</th>
                <th className="px-4 py-2 text-right">Low Slots</th>
                <th className="px-4 py-2 text-right">Proj SL %</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70 font-mono">
              {dailyTotals.map((d) => (
                <tr key={d.dayKey} className="hover:bg-sky-500/5">
                  <td className="px-4 py-2 font-bold text-slate-900 dark:text-white">{d.dayKey}</td>
                  <td className="px-4 py-2 text-slate-500 dark:text-slate-400">{d.dateIso}</td>
                  <td className="px-4 py-2 text-right">{d.forecastVolume.toLocaleString()}</td>
                  <td className="px-4 py-2 text-right">{d.requiredProdHours.toFixed(1)}h</td>
                  <td className="px-4 py-2 text-right text-slate-500">{d.scheduledGrossHours.toFixed(1)}h</td>
                  <td className="px-4 py-2 text-right font-bold text-sky-600 dark:text-sky-400">
                    {d.scheduledNetHours.toFixed(1)}h
                  </td>
                  <td className="px-4 py-2 text-right">
                    <span
                      className={`font-bold ${
                        d.coveragePct >= 95
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : d.coveragePct >= 85
                            ? 'text-sky-600 dark:text-sky-400'
                            : 'text-amber-600 dark:text-amber-400'
                      }`}
                    >
                      {d.coveragePct.toFixed(1)}%
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    {d.peakRequired.toFixed(1)} / {d.peakScheduledNet.toFixed(1)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {d.understaffedIntervals > 0 ? (
                      <span className="text-amber-600 dark:text-amber-400 font-bold">
                        {d.understaffedIntervals}
                      </span>
                    ) : (
                      <span className="text-emerald-600 dark:text-emerald-400">0</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right font-bold">
                    {d.avgProjectedSlPct.toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
