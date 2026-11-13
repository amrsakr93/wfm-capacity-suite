import React from 'react';

export type ProMaxTone = 'cyan' | 'emerald' | 'amber' | 'violet' | 'rose' | 'blue';

interface IconProps {
  className?: string;
  size?: number;
}

/**
 * UI/UX Pro Max — Concentrix Brand Edition Living Animated SVG Icon Suite
 * Every icon has continuous, smooth SVG keyframe motion (orbital rotation,
 * Equalizer/Waterfall bar oscillation, flowing packet dots, and wave pulse)
 * in official Concentrix Logo colors:
 * - Concentrix Deep Navy: #003D5B / #002136
 * - Concentrix Signature Cyan: #00A3E0
 * - Concentrix Vibrant Turquoise & Mint: #25E2CC / #00C389
 */

export const BrandWfmEmblem: React.FC<IconProps> = ({ className = '', size = 32 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 36 36"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={`promax-svg-icon ${className}`}
    aria-hidden="true"
  >
    <defs>
      <linearGradient id="cnx-ring-outer" x1="2" y1="2" x2="34" y2="34" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="#25E2CC" />
        <stop offset="55%" stopColor="#00A3E0" />
        <stop offset="100%" stopColor="#003D5B" />
      </linearGradient>
      <linearGradient id="cnx-ring-inner" x1="6" y1="30" x2="30" y2="6" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="#00C389" />
        <stop offset="50%" stopColor="#25E2CC" />
        <stop offset="100%" stopColor="#00A3E0" />
      </linearGradient>
    </defs>
    {/* Continuously Rotating Outer Concentrix C-Arc */}
    <g className="cnx-orbit-cw" style={{ transformOrigin: '18px 18px' }}>
      <path
        d="M28.2 10.2C25.8 7.0 22.0 5.0 17.8 5.0C10.7 5.0 5.0 10.7 5.0 17.8C5.0 24.9 10.7 30.6 17.8 30.6C22.3 30.6 26.2 28.3 28.5 24.8"
        stroke="url(#cnx-ring-outer)"
        strokeWidth="3.2"
        strokeLinecap="round"
      />
      <circle cx="28.2" cy="10.2" r="2.4" fill="#25E2CC" />
    </g>
    {/* Counter-Rotating Inner Concentrix C-Arc */}
    <g className="cnx-orbit-ccw" style={{ transformOrigin: '18px 18px' }}>
      <path
        d="M24.2 13.0C22.7 11.0 20.4 9.8 17.8 9.8C13.4 9.8 9.8 13.4 9.8 17.8C9.8 22.2 13.4 25.8 17.8 25.8C20.6 25.8 23.0 24.4 24.5 22.2"
        stroke="url(#cnx-ring-inner)"
        strokeWidth="2.3"
        strokeLinecap="round"
      />
    </g>
    {/* Animated WFM Telemetry Equalizer Bars */}
    <rect x="13.2" y="16.5" width="2.2" height="5.8" rx="1.1" fill="#00A3E0" className="cnx-bar-pulse-1" />
    <rect x="16.8" y="13.5" width="2.2" height="8.8" rx="1.1" fill="#25E2CC" className="cnx-bar-pulse-2" />
    <rect x="20.4" y="15.0" width="2.2" height="7.3" rx="1.1" fill="#00C389" className="cnx-bar-pulse-3" />
  </svg>
);

export const ForecastStudioIcon: React.FC<IconProps> = ({ className = '', size = 22 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 28 28"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={`promax-svg-icon ${className}`}
    aria-hidden="true"
  >
    <defs>
      <linearGradient id="cnx-fc-cone" x1="15" y1="6" x2="26" y2="22" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="#25E2CC" stopOpacity="0.48" />
        <stop offset="100%" stopColor="#00A3E0" stopOpacity="0.06" />
      </linearGradient>
    </defs>
    <path d="M3.5 23.5H24.5" stroke="#00A3E0" strokeOpacity="0.35" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M15.5 5V23.5" stroke="#25E2CC" strokeOpacity="0.65" strokeWidth="1.3" strokeDasharray="2 2" />
    <path d="M15.5 13.5L24.5 6.5V18.5L15.5 13.5Z" fill="url(#cnx-fc-cone)" className="cnx-breathe" />
    <path
      d="M4 19.5L8 15.5L11.5 17.5L15.5 13.5"
      stroke="#00A3E0"
      strokeWidth="2.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M15.5 13.5L19.8 10.2L24.5 7.5"
      stroke="#25E2CC"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="cnx-dash-flow"
    />
    <circle cx="15.5" cy="13.5" r="2.2" fill="#00A3E0" />
    <circle cx="24.5" cy="7.5" r="3.4" fill="#25E2CC" fillOpacity="0.35" className="cnx-radar-ping" />
    <circle cx="24.5" cy="7.5" r="2.4" fill="#25E2CC" />
  </svg>
);

export const ErlangQueueIcon: React.FC<IconProps> = ({ className = '', size = 22 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 28 28"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={`promax-svg-icon ${className}`}
    aria-hidden="true"
  >
    {/* Animated Incoming Call Stream */}
    <path
      d="M3 9.5H10M3 14H10.5M3 18.5H10"
      stroke="#00A3E0"
      strokeWidth="2"
      strokeLinecap="round"
      strokeDasharray="3 2"
      className="cnx-stream-right"
    />
    {/* Erlang Solver Core */}
    <rect
      x="11"
      y="6.5"
      width="7.5"
      height="15"
      rx="2.5"
      fill="#00A3E0"
      fillOpacity="0.22"
      stroke="#25E2CC"
      strokeWidth="1.8"
      className="cnx-breathe"
    />
    {/* Pulsing Active Agent Nodes */}
    <circle cx="23" cy="8.5" r="2.3" fill="#25E2CC" className="cnx-node-blink-1" />
    <circle cx="23" cy="14" r="2.3" fill="#00A3E0" className="cnx-node-blink-2" />
    <circle cx="23" cy="19.5" r="2.3" fill="#00C389" className="cnx-node-blink-3" />
    <path
      d="M18.5 10.5L21 9M18.5 14H20.8M18.5 17.5L21 19"
      stroke="#25E2CC"
      strokeOpacity="0.7"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
);

export const CapacityWaterfallIcon: React.FC<IconProps> = ({ className = '', size = 22 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 28 28"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={`promax-svg-icon ${className}`}
    aria-hidden="true"
  >
    <rect x="3.5" y="16" width="4.2" height="7.5" rx="1.3" fill="#003D5B" stroke="#00A3E0" strokeWidth="1" className="cnx-bar-pulse-1" />
    <rect x="9.5" y="12.5" width="4.2" height="11" rx="1.3" fill="#007399" className="cnx-bar-pulse-2" />
    <rect x="15.5" y="9" width="4.2" height="14.5" rx="1.3" fill="#00A3E0" className="cnx-bar-pulse-3" />
    <rect x="21.5" y="5.5" width="4.2" height="18" rx="1.3" fill="#25E2CC" className="cnx-bar-pulse-2" />
  </svg>
);

export const CalendarHorizonIcon: React.FC<{ tone?: ProMaxTone; size?: number }> = ({
  tone = 'cyan',
  size = 20,
}) => {
  const c =
    tone === 'emerald'
      ? { primary: '#00C389', accent: '#25E2CC' }
      : { primary: '#00A3E0', accent: '#25E2CC' };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect
        x="3"
        y="4.5"
        width="18"
        height="16.5"
        rx="3.5"
        fill={c.primary}
        fillOpacity="0.16"
        stroke={c.primary}
        strokeWidth="1.7"
      />
      <path d="M3 9.5H21" stroke={c.primary} strokeWidth="1.5" strokeOpacity="0.55" />
      <path d="M8 2.8V6M16 2.8V6" stroke={c.accent} strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="7.5" cy="13.2" r="1.8" fill={c.accent} className="cnx-node-blink-1" />
      <circle cx="12" cy="13.2" r="1.5" fill={c.primary} className="cnx-node-blink-2" />
      <circle cx="16.5" cy="13.2" r="1.5" fill={c.primary} className="cnx-node-blink-3" />
      <rect x="6.2" y="16.2" width="11.6" height="2" rx="1" fill={c.accent} opacity="0.9" />
    </svg>
  );
};

export const WinnerTrophyIcon: React.FC<IconProps> = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className="cnx-float-icon">
    <path
      d="M7 4H17V9C17 11.7614 14.7614 14 12 14C9.23858 14 7 11.7614 7 9V4Z"
      fill="#25E2CC"
      fillOpacity="0.24"
      stroke="#00C389"
      strokeWidth="1.8"
    />
    <path
      d="M7 6H4.5C3.94772 6 3.5 6.44772 3.5 7V8C3.5 9.933 5.067 11.5 7 11.5M17 6H19.5C20.0523 6 20.5 6.44772 20.5 7V8C20.5 9.933 18.933 11.5 17 11.5"
      stroke="#00A3E0"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
    <path d="M12 14V18.5M8.5 20H15.5" stroke="#00C389" strokeWidth="1.8" strokeLinecap="round" />
    <circle cx="12" cy="8.5" r="1.8" fill="#25E2CC" className="cnx-node-blink-1" />
  </svg>
);

export const AgentPrecisionIcon: React.FC<{ fractional?: boolean; size?: number }> = ({
  fractional = false,
  size = 18,
}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle
      cx="9.5"
      cy="8"
      r="3.2"
      fill={fractional ? '#25E2CC' : '#00A3E0'}
      fillOpacity="0.28"
      stroke={fractional ? '#25E2CC' : '#00A3E0'}
      strokeWidth="1.8"
    />
    <path
      d="M4 19C4 15.9624 6.46243 13.5 9.5 13.5C12.5376 13.5 15 15.9624 15 19"
      stroke={fractional ? '#25E2CC' : '#00A3E0'}
      strokeWidth="1.8"
      strokeLinecap="round"
    />
    {fractional ? (
      <>
        <rect
          x="15.5"
          y="6.5"
          width="5.5"
          height="11"
          rx="1.8"
          fill="#00C389"
          fillOpacity="0.25"
          stroke="#25E2CC"
          strokeWidth="1.5"
          strokeDasharray="2 1.5"
        />
        <circle cx="18.25" cy="14.5" r="1.2" fill="#25E2CC" className="cnx-node-blink-1" />
      </>
    ) : (
      <>
        <circle cx="17.5" cy="9.5" r="2.4" stroke="#25E2CC" strokeWidth="1.6" />
        <path
          d="M14.5 18.5C14.8 16.3 16.2 15 18 15C19.5 15 20.6 16.1 21 18.5"
          stroke="#25E2CC"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </>
    )}
  </svg>
);

export const ProMaxIconBadge: React.FC<{
  tone?: ProMaxTone;
  size?: 'sm' | 'md' | 'lg';
  pulse?: boolean;
  children: React.ReactNode;
}> = ({ tone = 'cyan', size = 'md', pulse = false, children }) => {
  const toneClasses: Record<ProMaxTone, string> = {
    cyan: 'promax-badge-cyan text-[#00A3E0]',
    emerald: 'promax-badge-emerald text-[#25E2CC]',
    amber: 'promax-badge-amber text-[#00A3E0]',
    violet: 'promax-badge-violet text-[#00A3E0]',
    rose: 'promax-badge-rose text-[#25E2CC]',
    blue: 'promax-badge-blue text-[#00A3E0]',
  };
  const sizeClasses = {
    sm: 'w-8 h-8 rounded-lg',
    md: 'w-10 h-10 rounded-xl',
    lg: 'w-12 h-12 rounded-2xl',
  };
  return (
    <div
      className={`promax-icon-3d cnx-float-badge relative inline-flex items-center justify-center shrink-0 select-none ${sizeClasses[size]} ${toneClasses[tone]}`}
    >
      {pulse && (
        <span
          className="absolute -top-1 -right-1 flex h-3 w-3"
          aria-hidden="true"
        >
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#25E2CC] opacity-75" />
          <span className="relative inline-flex rounded-full h-3 w-3 bg-[#00C389] border border-[#001421]" />
        </span>
      )}
      <div className="cnx-icon-inner flex items-center justify-center">
        {children}
      </div>
    </div>
  );
};

export const ShiftSchedulerIcon: React.FC<IconProps> = ({ className = '', size = 22 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 28 28"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={`promax-svg-icon ${className}`}
    aria-hidden="true"
  >
    <rect
      x="3.5"
      y="5.5"
      width="21"
      height="18"
      rx="3.5"
      fill="#00A3E0"
      fillOpacity="0.14"
      stroke="#00A3E0"
      strokeWidth="1.7"
    />
    <path d="M3.5 10.5H24.5" stroke="#00A3E0" strokeOpacity="0.45" strokeWidth="1.4" />
    <path d="M9 3.5V6.8M19 3.5V6.8" stroke="#25E2CC" strokeWidth="1.8" strokeLinecap="round" />
    {/* Staggered Live Shift Tracks */}
    <rect x="6" y="13" width="9.5" height="2.4" rx="1.2" fill="#00A3E0" className="cnx-bar-pulse-1" />
    <rect x="10" y="16.6" width="11.5" height="2.4" rx="1.2" fill="#25E2CC" className="cnx-bar-pulse-2" />
    <rect x="7" y="20" width="8.5" height="2" rx="1" fill="#00C389" className="cnx-bar-pulse-3" />
    <circle cx="22.5" cy="14.2" r="2.2" fill="#25E2CC" className="cnx-node-blink-1" />
  </svg>
);

export const BreakStaggerIcon: React.FC<IconProps> = ({ className = '', size = 22 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 28 28"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={`promax-svg-icon ${className}`}
    aria-hidden="true"
  >
    <path
      d="M4 18.5H24"
      stroke="#00A3E0"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeDasharray="3 2"
      className="cnx-stream-right"
    />
    {/* B1 15m -> Lunch 30m -> B2 15m Stagger Nodes */}
    <rect x="4.5" y="11" width="4.5" height="5" rx="1.3" fill="#00A3E0" className="cnx-bar-pulse-1" />
    <rect x="11" y="7" width="6" height="9" rx="1.6" fill="#25E2CC" className="cnx-bar-pulse-2" />
    <rect x="19" y="11" width="4.5" height="5" rx="1.3" fill="#00C389" className="cnx-bar-pulse-3" />
    <circle cx="14" cy="22" r="1.8" fill="#25E2CC" className="cnx-node-blink-2" />
  </svg>
);

export const RosterPoolIcon: React.FC<IconProps> = ({ className = '', size = 22 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 28 28"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={`promax-svg-icon ${className}`}
    aria-hidden="true"
  >
    <g className="cnx-orbit-cw" style={{ transformOrigin: '14px 14px' }}>
      <circle cx="14" cy="14" r="11" stroke="#00A3E0" strokeOpacity="0.28" strokeWidth="1.4" strokeDasharray="4 4" />
    </g>
    <circle cx="14" cy="10" r="3" fill="#25E2CC" fillOpacity="0.28" stroke="#25E2CC" strokeWidth="1.6" />
    <circle cx="8" cy="13.5" r="2.2" fill="#00A3E0" fillOpacity="0.24" stroke="#00A3E0" strokeWidth="1.4" />
    <circle cx="20" cy="13.5" r="2.2" fill="#00C389" fillOpacity="0.24" stroke="#00C389" strokeWidth="1.4" />
    <path d="M9 21C9.6 17.8 11.6 16.2 14 16.2C16.4 16.2 18.4 17.8 19 21" stroke="#25E2CC" strokeWidth="1.7" strokeLinecap="round" />
    <circle cx="21" cy="7" r="2" fill="#00C389" className="cnx-node-blink-1" />
  </svg>
);

export const ConstraintShieldIcon: React.FC<{ ok?: boolean; size?: number; className?: string }> = ({
  ok = true,
  size = 20,
  className = '',
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={`promax-svg-icon ${className}`}
    aria-hidden="true"
  >
    <path
      d="M12 3L4.5 6.2V11.6C4.5 16.5 7.7 20.6 12 22C16.3 20.6 19.5 16.5 19.5 11.6V6.2L12 3Z"
      fill={ok ? '#00C389' : '#F59E0B'}
      fillOpacity="0.18"
      stroke={ok ? '#25E2CC' : '#F59E0B'}
      strokeWidth="1.7"
      strokeLinejoin="round"
    />
    {ok ? (
      <path
        d="M8.8 12.2L11 14.4L15.4 9.8"
        stroke="#00C389"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="cnx-float-icon"
      />
    ) : (
      <path
        d="M12 8.2V12.8M12 15.8H12.01"
        stroke="#F59E0B"
        strokeWidth="2"
        strokeLinecap="round"
        className="cnx-node-blink-1"
      />
    )}
  </svg>
);
