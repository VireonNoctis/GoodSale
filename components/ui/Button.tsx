// components/ui/Button.tsx
'use client';

import React from 'react';
import { Loader2 } from 'lucide-react';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

const variants: Record<ButtonVariant, string> = {
  primary:
    'bg-jade-500 text-white hover:bg-jade-600 shadow-lg shadow-jade-500/25 dark:shadow-jade-500/20',
  secondary:
    'bg-ink-100 text-ink-800 hover:bg-ink-150 dark:bg-ink-800 dark:text-ink-100 dark:hover:bg-ink-750',
  outline:
    'border border-ink-300 dark:border-ink-700 text-ink-700 dark:text-ink-200 bg-white/60 dark:bg-ink-950/40 hover:border-jade-500 hover:text-jade-600 dark:hover:text-jade-400',
  ghost:
    'text-ink-600 dark:text-ink-300 hover:bg-ink-100 dark:hover:bg-ink-800 hover:text-ink-900 dark:hover:text-white',
  danger:
    'bg-ink-900 text-white hover:bg-ink-800 dark:bg-white dark:text-ink-950 dark:hover:bg-ink-100',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'h-9 px-3.5 text-xs rounded-xl gap-1.5',
  md: 'h-11 px-5 text-sm rounded-2xl gap-2',
  lg: 'h-13 px-7 text-base rounded-[1.125rem] gap-2.5',
};

export default function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  className = '',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      disabled={disabled || loading}
      className={`inline-flex select-none items-center justify-center font-bold tracking-tight transition-all duration-200 ease-glide press-scale focus-ring disabled:pointer-events-auto disabled:opacity-50 cursor-pointer ${variants[variant]} ${variant === 'primary' ? 'gs-tactile' : ''} ${sizes[size]} ${className}`}
      {...rest}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        children
      )}
    </button>
  );
}
