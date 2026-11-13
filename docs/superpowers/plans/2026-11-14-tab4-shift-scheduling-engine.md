# Tab 4: WFM Agent Shift Scheduling & Break Optimizer Implementation Plan

> **For agentic workers:** Follow strict TDD (`test-driven-development`), verified engineering (`aeo`), Ponytail 7-rung simplicity ladder, and Concentrix UI/UX Pro Max design rules across Light/Day and Dark/Night themes.

**Goal:** Build **Tab 4: Agent Shift Scheduling & Roster Studio** integrated seamlessly with Tab 1 (Next Week Mon–Sun Forecast), Tab 2 (7-day Arrival Curves + Erlang Required Seats), and Tab 3 (Shift/Break & Capacity Rules), with animated Concentrix UI/UX Pro Max interactivity, real-time break optimization (`First 15m + Lunch 30m + Last 15m`), full manual cell override + live audit validation, and Concentrix styled Excel export.

**Architecture:**
1. **Pure Scheduling & Break Engine (`src/engine/scheduling.ts` + `src/engine/types.ts`):**
   - Dual roster input (`Headcount` generating `Agent 1..N` or uploaded/pasted `Named Roster` with optional pre-tagged exceptions).
   - Input exclusions (`AL` excluded from output by default or toggled muted; `MAT`, `RES`, `TERM`, `UPL`, `PAT` assigned full-week 0-coverage codes).
   - External Shift Catalog parser (`09:00-18:00`, `9 AM - 6 PM`, overnight `22:00-07:00`, two-column Excel/CSV/paste).
   - Hard constraints: `<= 5` workdays, `2 OFF` (6 consecutive Mon–Sun pairs + allowed `Sun+Mon` split/wrap OFF), `Max Weekly Start Drift <= 2h` (circular 24h arc), `Min Inter-Shift Rest >= 12h` (circular Sun->Mon check).
   - Multi-stage Demand Optimizer: Forecast-weighted OFF distribution -> Greedy Deficit Shift Placement + Local 1-Opt Swap Pass -> 15-min Sub-Interval Break Optimizer (`B1 15m + Lunch 30m + B2 15m`, `<= 3.5h` continuous login, `>= 1h` between breaks, water-filling stagger away from arrival peaks).
2. **UI/UX Pro Max Surface (`src/components/Tab4Scheduling.tsx`, `ProMaxIcons.tsx`, `InteractiveCharts.tsx`, `exporter.ts`, `App.tsx`):**
   - Kinetic Concentrix animated SVG icons (`ShiftSchedulerIcon`, `BreakStaggerIcon`, `RosterPoolIcon`, `ConstraintShieldIcon`).
   - `InteractiveRosterCoverageChart` (magnetic proximity hover ripple, dashed Required Erlang curve, Scheduled Gross vs Net after Break staggered gradient bars, floating telemetry tooltip).
   - Interactive Editable Roster Grid with floating inline Cell/Break Popover (`Shift Picker` with live rest/drift compatibility preview, custom `B1/Lunch/B2` timing sliders/pills with live `<= 3.5h` & `>= 1h` verification, agent search/filter, manual violation alerts).
   - Styled Excel Dashboard Exporter (`buildSchedulingWorkbook` + Master Workbook integration).

**Tech Stack:** React 19, TypeScript (strict), Tailwind CSS, ExcelJS, SheetJS (`xlsx`), Node built-in test runner (`node --test`).

## Global Constraints
- Re-use existing `xlsx` library, `exportStyles.ts` Concentrix components, `ProMaxIcons` animation classes, and `getBarWaveStyle` chart ripples (no extra npm packages).
- Both Day Mode (`html.light`) and Night Mode (`html.dark`) must keep >= 4.5:1 contrast and support clean `@media print`.
- Zero unrequested mutations to existing Tab 1/2/3 math tests (all 20 existing tests must continue passing 100%).

## Review Focus
- Circular overnight shifts (`22:00-07:00`) must count coverage across midnight into the next day and compute weekly start drift around 24h without fake 22h gaps.
- `Sun -> Mon` rest boundary (`Sun` evening shift vs `Mon` morning shift) must trigger clopening rejection when `< Min Rest Hours`.
- 15-min breaks averaged inside 30-min / 60-min Erlang intervals must conserve exact productive hours (`Gross - 1h = Net`).
- Input `AL` exclusion must default `annualVisibilityInOutput: 'exclude'` so Annual count reduces schedulable headcount without polluting shift rows unless toggled.
- Manual overrides must immediately recompute interval coverage, SL projection, and live per-agent constraint warnings in <20ms.

---

### Tasks
- [ ] **T11:** Types (`src/engine/types.ts`) & TDD Test Suite (`tests/scheduling.test.ts`) written RED first
- [ ] **T12:** Core Scheduling, Break Staggering & External Parsers Engine (`src/engine/scheduling.ts`) — GREEN on all scheduling unit tests
- [ ] **T13:** Kinetic Icons (`ProMaxIcons.tsx`) + `InteractiveRosterCoverageChart` (`InteractiveCharts.tsx`) + Tab 4 Styled Excel Export (`exporter.ts`)
- [ ] **T14:** Pro Max UI `Tab4Scheduling.tsx` + `App.tsx` / `PrintReportHeader.tsx` wiring (4-Tab Navigation, Toast, PDF Print Header, Global Export)
- [ ] **T15:** Full Quality Gate (`typecheck`, full `test` suite, `build`, Night & Day Mode Playwright interactive verification, Deploy, GitHub Push & Backup ZIP sync)
