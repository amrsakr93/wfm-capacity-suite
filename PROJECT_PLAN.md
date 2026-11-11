# PROJECT_PLAN — Strategic Call Center WFM & Capacity Suite (`wfm-capacity-suite`)

> Status: **LOCKED** (Approved by User: Online GitHub + Cloudflare Pages Functions [youssefselim.com-style 24/7 Cloud] + Portable Vercel Serverless, with SharePoint List + Power Automate Dual-Channel Teams/Outlook OTP Gate)
> Mode: Full-Stack Cloud Web App (`Vite + React + TypeScript + Tailwind` + `Cloudflare Pages Functions / Vercel API Routes`)

---

## 1. Architecture & Cloud Hosting Plan (Zero Local PC Dependency)
- **Repository:** GitHub-ready Git repo (`main` branch), automatic CI/CD deployment via **Vercel**.
- **Frontend:** React 19 + TypeScript (strict) + Tailwind CSS + SheetJS (`xlsx`) + Lucide Icons + Custom SVG Precision Charts.
  - Supports instant **AR / EN** bilingual UI (`dir="rtl"` / `dir="ltr"`) with `tabular-nums`.
  - Runs 100% of Forecasting, Erlang C/A, FTE Waterfall, What-If Matrix, and Excel export inside the browser (zero backend bottleneck).
- **Auth Backend (`api/auth/*` + shared `lib/auth-core.ts`):**
  - Works identically in **Vercel Serverless Functions** AND locally inside **Vite Dev Server middleware** (single shared handler module — zero duplication).
  - Endpoints:
    - `POST /api/auth/request-otp` — validates `{ email, channel: "outlook" | "teams" | "both" }`, calls `PA_SEND_OTP_URL` (stored secretly in Vercel Env Vars, never shipped to client).
    - `POST /api/auth/verify-otp` — validates `{ email, code }`, calls `PA_VERIFY_OTP_URL`, issues an HMAC-SHA256 signed `HttpOnly` session cookie (`wfm_session`).
    - `GET /api/auth/session` — validates `wfm_session` cookie (returns `{ authenticated, email, mode, expiresAt }`).
    - `POST /api/auth/logout` — clears `wfm_session`.
  - **Security Carve-Out:** Fail-closed when Power Automate URLs are missing unless `AUTH_MODE=demo` is explicitly set (in Demo Preview Mode, signed demo OTP challenge works out-of-the-box with simulated Outlook/Teams toast preview so the platform can be evaluated immediately before connecting Microsoft 365).
  - Complete **Power Automate + SharePoint Setup Blueprint** (`docs/POWER_AUTOMATE_SETUP.md` + in-app Setup Drawer).

---

## 2. Task Breakdown & Skill Routing

| ID | Task | Routed Skill | Status |
|---|---|---|---|
| T1 | Project scaffold: `package.json`, TypeScript strict, Tailwind, Vite dev/Vercel API bridge, `.env.example`, `vercel.json` | `frontend-app-engineering` | Pending |
| T2 | Historical Data Parser (`src/engine/parsers.ts`): Simple Date/Vol, 48x7 Heatmap, Cross-Tab Pivot (`Interval x Dates`), Long format + Sample datasets | `pro-data-analysis-suite` | Pending |
| T3 | Tab 1 Forecasting Engine (`src/engine/forecasting.ts`): Carlberg Unweighted MA, Weighted MA, SES (`alpha`), Holt Linear (`alpha, gamma`), Holt-Winters Add/Mult (`m`), Linear Regression (`R2`), 80/20 Holdout, Outlier/Holiday cleaning, Auto-Optimizer, Granularity Bridge | `pro-data-analysis-suite` | Pending |
| T4 | Tab 2 Erlang C/A Engine (`src/engine/erlang.ts`): Overflow-safe recursive Erlang B/C (`A = Vol*AHT/I_sec`), Multi-constraint Solver (`SL >= Target`, `ASA <= Max`, `Occ <= Cap`, `MinAgents`), True Palm/Erlang-A (`AvgPatience` -> `Abandon %`) | `pro-qa-testing-architect` | Pending |
| T5 | Tab 3 Capacity & What-If Engine (`src/engine/capacity.ts`): Erlang C vs Flat Top-Down route, Break subtraction (`Working - Break = Login`), Compound Shrinkage, Weekly `Operating/Agent` days coverage, Schedule Inflex, Attrition Buffer, 2D What-If Sensitivity Matrix | `pro-data-analysis-suite` | Pending |
| T6 | Auth Gate Core (`lib/auth-core.ts` + `api/auth/*.ts`): Power Automate HTTP webhook proxy (Teams + Outlook channel), HMAC-SHA256 `HttpOnly` cookie session, explicit Demo Preview challenge mode | `pro-backend-architect` | Pending |
| T7 | Comprehensive Unit Test Suite (`tests/*.test.ts`): Parser cross-tab validation, Carlberg & ErlangXL97 golden verification, Capacity no-double-counting check, Auth HMAC/fail-closed checks | `pro-qa-testing-architect` | Pending |
| T8 | UI Design System & Bilingual App Shell + Auth Login Gate (`src/components/AuthGate.tsx`, Header, Stepper, Setup Guide Drawer) | `impeccable` + `bilingual-business-writing` | Pending |
| T9 | Interactive 3-Tab UI + Charts (`Tab1Forecasting.tsx`, `Tab2Erlang.tsx`, `Tab3Capacity.tsx`, SVG Charts, Excel `.xlsx` & Print PDF Export) | `interactive-bi-dashboard-builder` + `impeccable` | Pending |
| T10 | Docs (`docs/POWER_AUTOMATE_SETUP.md`, `README.md`), Build Check, Headless Browser E2E Verification, Memory Save | `pro-qa-testing-architect` + `deploy-to-vercel` | Pending |

---

## 3. Quality Gates (Non-Negotiable)
1. **Math Fidelity:** Erlang B/C values match `ErlangXL97 1.xls` (`Example` inputs); Carlberg SES & Holt equations match textbook (`y_hat_2 = y_1`, `L_1 = y_1, b_1 = 0`, SSE/RMSE minimization); Capacity never double-counts Occupancy in Erlang C mode or unpaid lunch break.
2. **Auth Security:** Client never receives SharePoint codes or `PA_SEND_OTP_URL`/`PA_VERIFY_OTP_URL`; `AUTH_MODE=power_automate` fails closed without URLs.
3. **Verification:** All unit tests pass, `tsc --noEmit` & `npm run build` pass with 0 errors, and rendered browser UI verified at desktop/mobile + AR/EN.

