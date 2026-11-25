/**
 * Fox Schema (foxschema)
 * Copyright 2024-2026 Huy Phan <huyplb@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Small form primitives for the Workflow designer, in FoxSchema's palette.
 */
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

const cx = (...classes: Array<string | false | null | undefined>): string =>
  classes.filter(Boolean).join(' ');

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[13px] font-medium transition-colors cursor-pointer disabled:pointer-events-none disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-cyan-500 [&_svg]:size-3.5 [&_svg]:shrink-0';

const BUTTON_VARIANT = {
  default: 'border border-slate-700 bg-slate-900 text-slate-200 hover:border-slate-600 hover:bg-slate-800',
  primary: 'accent-grad on-accent-fg border border-transparent font-semibold',
  ghost: 'border border-transparent bg-transparent text-slate-400 hover:bg-slate-800 hover:text-slate-200',
  danger: 'border border-transparent bg-transparent text-rose-400 hover:border-rose-500/50',
  link: 'h-auto border-none bg-transparent p-0 text-xs accent-text',
} as const;

const BUTTON_SIZE = {
  default: 'px-3 py-1.5',
  sm: 'px-2 py-1 text-xs',
  icon: 'size-8 p-0',
} as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof BUTTON_VARIANT;
  size?: keyof typeof BUTTON_SIZE;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'default', type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cx(BUTTON_BASE, BUTTON_VARIANT[variant], BUTTON_SIZE[size], className)}
      {...props}
    />
  ),
);
Button.displayName = 'Button';

const FIELD_BASE =
  'rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-[13px] text-slate-100 placeholder:text-slate-500 outline-none accent-focus';

const fieldClass = (className?: string, extra?: string): string =>
  cx(className && /(?:^|\s)w-\S+/.test(className) ? '' : 'w-full', FIELD_BASE, extra, className);

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => <input ref={ref} className={fieldClass(className)} {...props} />,
);
Input.displayName = 'Input';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => (
    <select ref={ref} className={fieldClass(className, 'cursor-pointer')} {...props} />
  ),
);
Select.displayName = 'Select';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={fieldClass(className, 'min-h-[90px] resize-y font-mono text-xs')}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cx('mb-1 mt-2.5 block text-[11px] uppercase tracking-wide text-slate-500', className)}
      {...props}
    />
  );
}

const BADGE_VARIANT = {
  default: 'border-slate-700 text-slate-400',
  source: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
  transform: 'border-violet-500/40 bg-violet-500/10 text-violet-300',
  sink: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  accent: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300',
  ok: 'border-emerald-500/60 text-emerald-400',
  danger: 'border-rose-500/60 text-rose-400',
} as const;

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: keyof typeof BADGE_VARIANT | null;
}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full border px-2 py-px text-[11px] leading-4',
        BADGE_VARIANT[variant ?? 'default'],
        className,
      )}
      {...props}
    />
  );
}

/** Every IANA zone the browser knows, with UTC first — Chromium leaves it out. */
const TIMEZONES: readonly string[] = (() => {
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return ['UTC', ...zones.filter((zone) => zone !== 'UTC')];
})();

export function TimezoneSelect({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (timezone: string) => void;
  className?: string;
}) {
  // A saved zone this browser does not list stays selectable rather than vanishing.
  const zones = !value || TIMEZONES.includes(value) ? TIMEZONES : [value, ...TIMEZONES];
  return (
    <Select
      aria-label="Timezone"
      className={className}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {zones.map((zone) => (
        <option key={zone} value={zone}>
          {zone.replaceAll('_', ' ')}
        </option>
      ))}
    </Select>
  );
}
