// components/ui/Toast.tsx
'use client';

import React from 'react';
import { Info, AlertTriangle, CheckCircle2 } from 'lucide-react';
import LottieAnimation from './LottieAnimation';
import { lottieStates } from '../../lib/lottie/states';

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastProps {
  kind?: ToastKind;
  title?: string;
  children?: React.ReactNode;
  className?: string;
}

/**
 * Non-blocking feedback toast. Success carries the success-check Lottie,
 * error carries the monochrome error-state Lottie, info uses an icon.
 * Dark inverted surface reads in both themes (green and black, always).
 */
export default function Toast({
  kind = 'success',
  title,
  children,
  className = '',
}: ToastProps) {
  return (
    <div
      role={kind === 'error' ? 'alert' : 'status'}
      aria-live={kind === 'error' ? 'assertive' : 'polite'}
      className={`pointer-events-auto inline-flex max-w-xs items-start gap-3 rounded-2xl border px-4 py-3 shadow-2xl animate-slide-in bg-ink-900 text-ink-50 border-ink-800 dark:bg-white dark:text-ink-950 dark:border-ink-200 ${className}`}
    >
      <span className="lottie-host h-7 w-7 shrink-0">
        {kind === 'success' && (
          <>
            <span className="lottie-fallback text-jade-400 dark:text-jade-600">
              <CheckCircle2 className="h-5 w-5" />
            </span>
            <span className="lottie-layer h-7 w-7">
              <LottieAnimation
                animationData={lottieStates.success}
                loop={false}
                className="h-7 w-7"
              />
            </span>
          </>
        )}
        {kind === 'error' && (
          <>
            <span className="lottie-fallback text-ink-400">
              <AlertTriangle className="h-5 w-5" />
            </span>
            <span className="lottie-layer h-7 w-7">
              <LottieAnimation
                animationData={lottieStates.error}
                loop={false}
                className="h-7 w-7"
              />
            </span>
          </>
        )}
        {kind === 'info' && (
          <span className="grid h-7 w-7 place-items-center rounded-full bg-jade-500/15">
            <Info className="h-4 w-4 text-jade-600 dark:text-jade-500" />
          </span>
        )}
      </span>
      <div className="min-w-0 pt-1">
        {title && <p className="text-sm font-bold tracking-tight">{title}</p>}
        <div className="text-xs font-medium leading-relaxed opacity-90">{children}</div>
      </div>
    </div>
  );
}
