import React from 'react';
import { BrandWfmEmblem } from './ProMaxIcons.tsx';

interface PrintReportHeaderProps {
  activeTab: 'tab1' | 'tab2' | 'tab3' | 'tab4';
  monthlyVolume: number;
  monthDays: number;
  hoops: number;
  selectedModelLabel: string;
  wmapePct: number;
  prodHoursPerDay: number;
  compoundShrinkagePct: number;
  finalGrossFte: number;
}

const TAB_TITLES: Record<'tab1' | 'tab2' | 'tab3' | 'tab4', string> = {
  tab1: '1. Forecasting Studio & Future Horizons',
  tab2: '2. Intraday Interval & Erlang C/A Staffing Plan',
  tab3: '3. Monthly Capacity Plan & FTE Shrinkage Waterfall',
  tab4: '4. Agent Shift Scheduling, Leave Pool & Break Roster',
};

export const PrintReportHeader: React.FC<PrintReportHeaderProps> = ({
  activeTab,
  monthlyVolume,
  monthDays,
  hoops,
  selectedModelLabel,
  wmapePct,
  prodHoursPerDay,
  compoundShrinkagePct,
  finalGrossFte,
}) => {
  const dailyAvg = Math.round(monthlyVolume / Math.max(1, monthDays));
  const generatedStamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

  return (
    <section className="print-only mb-5">
      {/* Executive Concentrix Masthead */}
      <div className="print-banner rounded-xl overflow-hidden border border-[#cbd5e1] mb-3">
        <div className="bg-[#0B2234] text-white px-5 py-3.5 flex items-center justify-between gap-4 border-b-4 border-[#0088C2]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#003D5B] border border-[#38BDF8]/40 flex items-center justify-center">
              <BrandWfmEmblem size={26} />
            </div>
            <div>
              <h1 className="text-base font-extrabold tracking-tight text-white">
                WFM &amp; Capacity Suite — Executive Dashboard Report
              </h1>
              <p className="text-[11px] text-[#93C5FD] font-medium">
                View: {TAB_TITLES[activeTab]} · Model: {selectedModelLabel}
              </p>
            </div>
          </div>
          <div className="text-right text-[10.5px] font-mono text-[#A5F3FC] leading-tight">
            <div className="font-bold text-white">wfmforall.com</div>
            <div>{generatedStamp}</div>
          </div>
        </div>

        {/* 5-Card Executive KPI Ribbon */}
        <div className="grid grid-cols-5 gap-2.5 p-3 bg-[#F4F7FA]">
          <div className="rounded-lg bg-white border border-[#D5E2EE] overflow-hidden">
            <div className="h-1 bg-[#0088C2]" />
            <div className="p-2.5">
              <div className="text-[9px] font-bold uppercase tracking-wider text-[#475569]">
                Monthly Forecast
              </div>
              <div className="text-base font-extrabold tabular-nums text-[#0B2234] mt-0.5">
                {monthlyVolume.toLocaleString()}
              </div>
              <div className="text-[9.5px] text-[#64748B]">
                {monthDays} days · {hoops}h/d HOOPS
              </div>
            </div>
          </div>

          <div className="rounded-lg bg-white border border-[#D5E2EE] overflow-hidden">
            <div className="h-1 bg-[#003D5B]" />
            <div className="p-2.5">
              <div className="text-[9px] font-bold uppercase tracking-wider text-[#475569]">
                Daily Avg Offered
              </div>
              <div className="text-base font-extrabold tabular-nums text-[#0B2234] mt-0.5">
                {dailyAvg.toLocaleString()}
              </div>
              <div className="text-[9.5px] text-[#64748B]">
                {Math.round(dailyAvg / Math.max(1, hoops)).toLocaleString()} calls/hr
              </div>
            </div>
          </div>

          <div className="rounded-lg bg-white border border-[#D5E2EE] overflow-hidden">
            <div className="h-1 bg-[#0088C2]" />
            <div className="p-2.5">
              <div className="text-[9px] font-bold uppercase tracking-wider text-[#475569]">
                Model WMAPE
              </div>
              <div className="text-base font-extrabold tabular-nums text-[#0073A8] mt-0.5">
                {wmapePct.toFixed(2)}%
              </div>
              <div className="text-[9.5px] text-[#64748B] truncate">
                {selectedModelLabel}
              </div>
            </div>
          </div>

          <div className="rounded-lg bg-white border border-[#D5E2EE] overflow-hidden">
            <div className="h-1 bg-[#003D5B]" />
            <div className="p-2.5">
              <div className="text-[9px] font-bold uppercase tracking-wider text-[#475569]">
                Req Prod Hours/d
              </div>
              <div className="text-base font-extrabold tabular-nums text-[#0B2234] mt-0.5">
                {prodHoursPerDay.toFixed(1)} hrs
              </div>
              <div className="text-[9.5px] text-[#64748B]">
                Shrinkage: {compoundShrinkagePct.toFixed(1)}%
              </div>
            </div>
          </div>

          <div className="rounded-lg bg-[#EFF6FF] border border-[#1d4ed8]/40 overflow-hidden">
            <div className="h-1 bg-[#1d4ed8]" />
            <div className="p-2.5">
              <div className="text-[9px] font-bold uppercase tracking-wider text-[#0e4f8a]">
                Final Gross FTE
              </div>
              <div className="text-base font-extrabold tabular-nums text-[#0e4f8a] mt-0.5">
                {Math.round(finalGrossFte)} Agents
              </div>
              <div className="text-[9.5px] text-[#0e4f8a]">
                Exact FTE: {finalGrossFte.toFixed(2)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
