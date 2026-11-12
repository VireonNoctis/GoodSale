import Skeleton from './Skeleton';

function ProductSkeleton() {
  return (
    <div className="overflow-hidden rounded-[1.35rem] border border-ink-200/80 bg-white p-2.5 dark:border-ink-800 dark:bg-ink-900">
      <Skeleton className="aspect-square w-full" rounded="lg" />
      <div className="space-y-2.5 px-1 pb-1 pt-3">
        <Skeleton className="h-3.5 w-[82%]" />
        <Skeleton className="h-3.5 w-[56%]" />
        <div className="flex items-center justify-between pt-1">
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-8 w-8" rounded="full" />
        </div>
      </div>
    </div>
  );
}

export default function MarketplaceLoading() {
  return (
    <main
      aria-label="Loading marketplace"
      aria-busy="true"
      className="min-h-[70dvh] bg-ink-50 px-4 pb-16 pt-5 dark:bg-ink-950 sm:px-6 lg:px-8"
    >
      <div className="mx-auto max-w-[1440px]">
        <div className="mb-6 flex items-center justify-between">
          <div className="space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-48 sm:w-64" />
          </div>
          <Skeleton className="h-10 w-10" rounded="full" />
        </div>

        <section className="relative overflow-hidden rounded-[1.75rem] border border-ink-200/70 bg-white p-5 dark:border-ink-800 dark:bg-ink-900 sm:p-8">
          <div className="grid gap-7 md:grid-cols-[1.1fr_.9fr] md:items-center">
            <div className="space-y-4">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-8 w-[85%] max-w-lg sm:h-10" />
              <Skeleton className="h-8 w-[65%] max-w-md" />
              <Skeleton className="h-4 w-[75%] max-w-sm" />
              <Skeleton className="mt-2 h-11 w-36" rounded="lg" />
            </div>
            <Skeleton className="aspect-[16/10] w-full" rounded="lg" />
          </div>
        </section>

        <div className="mt-8 flex items-center justify-between">
          <Skeleton className="h-6 w-36" />
          <Skeleton className="h-4 w-16" />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="flex flex-col items-center gap-2">
              <Skeleton className="h-14 w-14 sm:h-16 sm:w-16" rounded="full" />
              <Skeleton className="h-3 w-16" />
            </div>
          ))}
        </div>

        <div className="mt-9 flex items-center justify-between">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-20" />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 10 }).map((_, index) => (
            <ProductSkeleton key={index} />
          ))}
        </div>

        <p className="sr-only">GoodSale is loading products and marketplace details.</p>
      </div>
    </main>
  );
}
