'use client';

import { useEffect } from 'react';
import RetryState from '@/components/ui/RetryState';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Keep the raw error in developer telemetry only; never render it to visitors.
    console.error('[GoodSale] route boundary', { digest: error.digest });
  }, [error]);

  return (
    <main className="grid min-h-[70dvh] place-items-center bg-ink-50 px-4 dark:bg-ink-950">
      <RetryState
        title="We hit a temporary problem"
        description="This page could not finish loading. Your account, cart and saved orders remain unchanged."
        retry={reset}
        reference={error.digest}
        backHref="/"
      />
    </main>
  );
}
