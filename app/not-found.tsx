import Link from 'next/link';
import { SearchX } from 'lucide-react';

export default function NotFound() {
  return (
    <main className="grid min-h-[70dvh] place-items-center bg-ink-50 px-6 py-16 text-center dark:bg-ink-950">
      <div className="max-w-md">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-ink-200 bg-white text-ink-500 shadow-sm dark:border-ink-700 dark:bg-ink-900 dark:text-ink-300">
          <SearchX className="h-6 w-6" aria-hidden="true" />
        </span>
        <p className="mt-6 text-[11px] font-black uppercase tracking-[.2em] text-jade-700 dark:text-jade-300">404 · Page not found</p>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-ink-950 dark:text-white">This page has moved on.</h1>
        <p className="mt-3 text-sm leading-6 text-ink-500 dark:text-ink-400">The link may be old, or the page is no longer available.</p>
        <Link href="/" className="gs-tactile mt-6 inline-flex h-11 items-center justify-center rounded-2xl bg-jade-700 px-5 text-sm font-bold text-white shadow-lg shadow-jade-900/10 transition hover:bg-jade-800">
          Return to marketplace
        </Link>
      </div>
    </main>
  );
}
