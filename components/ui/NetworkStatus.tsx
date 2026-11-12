'use client';

import { useEffect, useState } from 'react';
import { Check, WifiOff } from 'lucide-react';

/** Small, non-blocking network banner. It never replaces local form or checkout state. */
export default function NetworkStatus() {
  const [offline, setOffline] = useState(false);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    const onOffline = () => {
      setOffline(true);
      setRestored(false);
    };
    const onOnline = () => {
      setOffline(false);
      setRestored(true);
      window.setTimeout(() => setRestored(false), 2600);
    };

    setOffline(!navigator.onLine);
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, []);

  if (!offline && !restored) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed inset-x-0 top-0 z-[160] flex justify-center px-3 pt-3 pointer-events-none motion-safe:animate-slide-in`}
    >
      <div className={`pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-2xl border px-4 py-3 text-sm font-semibold shadow-xl backdrop-blur-xl ${
        offline
          ? 'border-amber-300 bg-amber-50/95 text-amber-950 dark:border-amber-800 dark:bg-amber-950/95 dark:text-amber-100'
          : 'border-jade-200 bg-white/95 text-jade-800 dark:border-jade-800 dark:bg-ink-900/95 dark:text-jade-200'
      }`}>
        {offline ? <WifiOff className="h-4 w-4 shrink-0" /> : <Check className="h-4 w-4 shrink-0" />}
        <span>{offline ? 'You are offline. Changes will need a connection to sync.' : 'Connection restored.'}</span>
      </div>
    </div>
  );
}
