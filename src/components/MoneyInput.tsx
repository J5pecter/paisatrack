/**
 * Rupee input.
 *
 * Accepts the shapes people actually type — "1,234.56", "₹1200", "1.2L",
 * "45k" — and stores integer paise. The parsed value is echoed back under the
 * field so there is never any doubt about what was understood.
 */
import * as React from 'react';
import { Input } from '@/components/ui';
import { formatINR, parseINR, toRupeeString } from '@/lib/finance/money';
import { cn } from '@/lib/utils';
import type { Paise } from '@/types';

export interface MoneyInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  value: Paise;
  onChange: (paise: Paise) => void;
  /** Show the parsed value under the field. */
  showPreview?: boolean;
}

export const MoneyInput = React.forwardRef<HTMLInputElement, MoneyInputProps>(
  ({ value, onChange, showPreview = true, className, ...props }, ref) => {
    const [text, setText] = React.useState(() => (value ? toRupeeString(value) : ''));
    const [focused, setFocused] = React.useState(false);

    // Keep in step when the value changes from outside (edit dialogs, resets).
    React.useEffect(() => {
      if (!focused) setText(value ? toRupeeString(value) : '');
    }, [value, focused]);

    const parsed = parseINR(text);
    const invalid = text.trim() !== '' && parsed === null;

    return (
      <div className="space-y-1">
        <div className="relative">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-[var(--color-muted-foreground)]">
            ₹
          </span>
          <Input
            ref={ref}
            inputMode="decimal"
            autoComplete="off"
            value={text}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              if (parsed !== null) setText(toRupeeString(parsed));
            }}
            onChange={(e) => {
              setText(e.target.value);
              const next = parseINR(e.target.value);
              if (next !== null) onChange(next);
              else if (e.target.value.trim() === '') onChange(0);
            }}
            className={cn('pl-7 tnum', invalid && 'border-[var(--color-danger)]', className)}
            aria-invalid={invalid}
            {...props}
          />
        </div>
        {showPreview && parsed !== null && parsed !== 0 && (
          <p className="text-xs text-[var(--color-muted-foreground)]">
            {formatINR(parsed, { paise: true })}
          </p>
        )}
        {invalid && (
          <p role="alert" className="text-xs text-[var(--color-danger)]">
            Not a number. Try 1200, 1,200.50 or 1.2L.
          </p>
        )}
      </div>
    );
  },
);
MoneyInput.displayName = 'MoneyInput';

/** Percentage input constrained to a sane range. */
export const PercentInput = React.forwardRef<
  HTMLInputElement,
  Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
    value: number;
    onChange: (value: number) => void;
    max?: number;
  }
>(({ value, onChange, max = 100, className, ...props }, ref) => (
  <div className="relative">
    <Input
      ref={ref}
      type="number"
      inputMode="decimal"
      step="0.01"
      min={0}
      max={max}
      value={Number.isFinite(value) ? value : ''}
      onChange={(e) => {
        const n = Number.parseFloat(e.target.value);
        onChange(Number.isFinite(n) ? Math.min(Math.max(n, 0), max) : 0);
      }}
      className={cn('pr-7 tnum', className)}
      {...props}
    />
    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-[var(--color-muted-foreground)]">
      %
    </span>
  </div>
));
PercentInput.displayName = 'PercentInput';

/** Day-of-month input, clamped to 1-31. */
export const DayInput = React.forwardRef<
  HTMLInputElement,
  Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
    value: number;
    onChange: (value: number) => void;
  }
>(({ value, onChange, className, ...props }, ref) => (
  <Input
    ref={ref}
    type="number"
    inputMode="numeric"
    min={1}
    max={31}
    value={Number.isFinite(value) ? value : ''}
    onChange={(e) => {
      const n = Number.parseInt(e.target.value, 10);
      onChange(Number.isFinite(n) ? Math.min(Math.max(n, 1), 31) : 1);
    }}
    className={cn('tnum', className)}
    {...props}
  />
));
DayInput.displayName = 'DayInput';
