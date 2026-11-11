// components/ui/Card.tsx
'use client';

import React from 'react';

export type CardVariant = 'tonal' | 'glass' | 'outline' | 'muted';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  /** Adds the spring hover lift — for clickable cards only. */
  interactive?: boolean;
}

const variants: Record<CardVariant, string> = {
  tonal: 'bg-white dark:bg-ink-900 border border-ink-200/80 dark:border-ink-800',
  glass: 'glass',
  outline: 'border border-ink-200 dark:border-ink-800 bg-transparent',
  muted: 'bg-ink-100 dark:bg-ink-950 border border-ink-150 dark:border-ink-900',
};

export default function Card({
  variant = 'tonal',
  interactive = false,
  className = '',
  children,
  ...rest
}: CardProps) {
  return (
    <div
      className={`gs-card rounded-[1.5rem] ${variants[variant]} ${
        interactive ? 'card-hover press-scale cursor-pointer' : ''
      } ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}
