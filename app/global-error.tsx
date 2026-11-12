'use client';

import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[GoodSale] fatal rendering boundary', { digest: error.digest });
  }, [error]);

  return (
    <html lang="en">
      <body className="min-h-screen bg-[#f8f7f2] text-[#171d1a] antialiased">
        <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center px-6 text-center">
          <div className="grid h-14 w-14 place-items-center rounded-2xl border border-[#e1ded5] bg-white text-[#0d7a61]">GS</div>
          <h1 className="mt-6 text-2xl font-extrabold tracking-tight">GoodSale needs a fresh start</h1>
          <p className="mt-2 text-sm leading-6 text-[#756f65]">The page could not be rendered. Reload this view to continue.</p>
          <button
            type="button"
            onClick={() => reset()}
            className="mt-6 rounded-2xl bg-[#0d7a61] px-5 py-3 text-sm font-bold text-white transition hover:bg-[#0b654f] active:scale-95"
          >
            Reload page
          </button>
          {error.digest && <p className="mt-4 text-xs text-[#928b7f]">Reference: {error.digest}</p>}
        </main>
      </body>
    </html>
  );
}
