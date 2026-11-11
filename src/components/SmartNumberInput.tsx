import React, { useEffect, useState } from 'react';

interface SmartNumberInputProps {
  value: number;
  onChange: (newValue: number) => void;
  min?: number;
  max?: number;
  step?: number;
  decimals?: number;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
}

/**
 * Flexible number input that allows clearing the input box completely,
 * typing decimals freely, and pasting Excel-formatted numbers (e.g. "81,563", "22%", " 2,719 ")
 * while immediately triggering live recalculation on every valid change.
 */
export const SmartNumberInput: React.FC<SmartNumberInputProps> = ({
  value,
  onChange,
  min,
  max,
  step = 1,
  decimals,
  placeholder,
  className = '',
  ariaLabel,
}) => {
  const formatVal = (v: number) => {
    if (!Number.isFinite(v)) return '0';
    return decimals !== undefined ? Number(v.toFixed(decimals)).toString() : String(v);
  };

  const [rawText, setRawText] = useState<string>(() => formatVal(value));
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    if (!isFocused) {
      setRawText(formatVal(value));
    }
  }, [value, isFocused, decimals]);

  const parseAndCommit = (text: string, clampStrict: boolean) => {
    // Strip commas, spaces, percent signs, currency symbols pasted from Excel
    const cleaned = text.replace(/[,%\s$]/g, '');
    if (cleaned === '' || cleaned === '-' || cleaned === '.') {
      if (clampStrict) {
        const fallback = min !== undefined ? Math.max(0, min) : 0;
        onChange(fallback);
        setRawText(formatVal(fallback));
      }
      return;
    }
    const parsed = Number(cleaned);
    if (!Number.isFinite(parsed)) return;

    let next = parsed;
    if (clampStrict) {
      if (min !== undefined) next = Math.max(min, next);
      if (max !== undefined) next = Math.min(max, next);
    } else {
      // Soft clamp during live typing so partial numbers don't jump unexpectedly
      if (min !== undefined && min >= 0 && next < 0) next = 0;
      if (max !== undefined && next > max) next = max;
    }
    onChange(next);
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      step={step}
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={rawText}
      onFocus={(e) => {
        setIsFocused(true);
        e.currentTarget.select();
      }}
      onChange={(e) => {
        const txt = e.target.value;
        setRawText(txt);
        parseAndCommit(txt, false);
      }}
      onPaste={(e) => {
        const pasted = e.clipboardData.getData('text');
        if (pasted) {
          e.preventDefault();
          const cleaned = pasted.replace(/[,%\s$]/g, '').trim();
          setRawText(cleaned);
          parseAndCommit(cleaned, true);
        }
      }}
      onBlur={() => {
        setIsFocused(false);
        parseAndCommit(rawText, true);
      }}
      className={className}
    />
  );
};
