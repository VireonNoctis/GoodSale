'use client';

import React from 'react';
import type { LucideIcon } from 'lucide-react';

export interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: LucideIcon;
  label: string;
  tone?: 'neutral' | 'primary' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  iconClassName?: string;
}

const tones = {
  neutral: 'border-ink-200 bg-white text-ink-700 hover:border-jade-400 hover:text-jade-700 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-200 dark:hover:text-jade-300',
  primary: 'border-jade-700 bg-jade-700 text-white hover:bg-jade-800 hover:border-jade-800 dark:border-jade-500 dark:bg-jade-500 dark:text-ink-950 dark:hover:bg-jade-400',
  danger: 'border-red-200 bg-red-50 text-red-700 hover:border-red-300 hover:bg-red-100 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300',
};
const dimensions = {
  sm: 'h-9 w-9 rounded-xl',
  md: 'h-11 w-11 rounded-2xl',
  lg: 'h-12 w-12 rounded-2xl',
};

/** Accessible square action control. Always provide a concise visible label for assistive tech. */
export default function IconButton({
  icon: Icon,
  label,
  tone = 'neutral',
  size = 'md',
  loading = false,
  iconClassName = '',
  disabled,
  className = '',
  ...props
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-busy={loading}
      disabled={disabled || loading}
      className={`gs-tactile inline-flex shrink-0 items-center justify-center border shadow-sm transition-all duration-200 focus-ring active:scale-[.94] disabled:pointer-events-none disabled:opacity-45 ${tones[tone]} ${dimensions[size]} ${className}`}
      {...props}
    >
      {loading ? (
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden="true" />
      ) : (
        <Icon className={`${size === 'sm' ? 'h-4 w-4' : size === 'lg' ? 'h-5 w-5' : 'h-[18px] w-[18px]'} ${iconClassName}`} aria-hidden="true" />
      )}
    </button>
  );
}
