'use client';

import { AlertCircle, ArrowLeft, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import Button from './Button';

interface RetryStateProps {
  title?: string;
  description?: string;
  retry?: () => void;
  retryLabel?: string;
  backHref?: string;
  backLabel?: string;
  reference?: string;
  compact?: boolean;
}

/** Shared recovery pattern for failed requests and sections. Avoids exposing raw server errors. */
export default function RetryState({
  title = 'That did not load',
  description = 'Something interrupted this request. Your saved information has not been changed.',
  retry,
  retryLabel = 'Try again',
  backHref,
  backLabel = 'Back to marketplace',
  reference,
  compact = false,
}: RetryStateProps) {
  return (
    <section
      role="alert"
      className={`mx-auto flex w-full max-w-xl flex-col items-center text-center ${compact ? 'px-4 py-7' : 'px-6 py-16'}`}
    >
      <span className="grid h-12 w-12 place-items-center rounded-2xl border border-red-200 bg-red-50 text-red-700 dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-300">
        <AlertCircle className="h-5 w-5" aria-hidden="true" />
      </span>
      <h2 className="mt-4 text-xl font-extrabold tracking-tight text-ink-950 dark:text-white">{title}</h2>
      <p className="mt-2 max-w-md text-sm leading-6 text-ink-500 dark:text-ink-400">{description}</p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        {retry && (
          <Button onClick={retry}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {retryLabel}
          </Button>
        )}
        {backHref && (
          <Link
            href={backHref}
            className="inline-flex h-11 items-center gap-2 rounded-2xl border border-ink-200 bg-white px-4 text-sm font-bold text-ink-700 transition hover:bg-ink-100 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-100 dark:hover:bg-ink-800"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {backLabel}
          </Link>
        )}
      </div>
      {reference && <p className="mt-4 text-[11px] text-ink-400 dark:text-ink-500">Reference: {reference}</p>}
    </section>
  );
}
