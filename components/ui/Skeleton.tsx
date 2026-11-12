// components/ui/Skeleton.tsx
'use client';

import React from 'react';

export interface SkeletonProps {
  className?: string;
  rounded?: 'sm' | 'md' | 'lg' | 'full';
}

const radii = {
  sm: 'rounded-md',
  md: 'rounded-2xl',
  lg: 'rounded-3xl',
  full: 'rounded-full',
};

/**
 * Shimmer skeleton — mirrors the final layout so nothing jumps on load.
 * Use route/segment-sized skeletons; the goodsale-loader Lottie is reserved
 * for full-screen transitions only.
 */
export function Skeleton({ className = '', rounded = 'md' }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      data-loading-skeleton=""
      className={`animate-shimmer motion-reduce:animate-none bg-ink-200 dark:bg-ink-800 ${radii[rounded]} ${className}`}
    />
  );
}

/** Card-shaped skeleton: media block + title + meta lines. */
export function SkeletonCard({ className = '' }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={`rounded-3xl border border-ink-200 bg-white p-4 dark:border-ink-800 dark:bg-ink-900 ${className}`}
    >
      <Skeleton className="h-36 w-full rounded-2xl" />
      <Skeleton className="mt-4 h-4 w-3/4" rounded="md" />
      <Skeleton className="mt-2 h-3 w-1/2" rounded="md" />
      <Skeleton className="mt-4 h-8 w-full" rounded="md" />
    </div>
  );
}

/** Row-shaped list skeleton: avatar + two text lines. */
export function SkeletonList({ rows = 4, className = '' }: { rows?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={`space-y-3 ${className}`}>
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="flex items-center gap-4 rounded-2xl border border-ink-200 bg-white p-4 dark:border-ink-800 dark:bg-ink-900"
        >
          <Skeleton className="h-11 w-11 shrink-0" rounded="full" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-2/5" rounded="md" />
            <Skeleton className="h-3 w-3/5" rounded="md" />
          </div>
          <Skeleton className="h-7 w-16" rounded="full" />
        </div>
      ))}
    </div>
  );
}

export default Skeleton;
