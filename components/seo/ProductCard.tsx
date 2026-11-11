import Link from 'next/link';
import { BadgeCheck, Star, Truck } from 'lucide-react';
import { naira } from '@/lib/seo/site';
import type { SeoProduct } from '@/lib/seo/data';

export function RatingStars({ rating, count }: { rating: number | null; count: number }) {
  if (rating === null || count === 0) return null;
  const rounded = Math.round(rating);
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-ink-600 dark:text-ink-300" aria-label={`Rated ${rating} out of 5 from ${count} reviews`}>
      <span aria-hidden="true" className="text-gold-500 dark:text-gold-300">
        {'★'.repeat(rounded)}
        <span className="text-ink-300 dark:text-ink-700">{'★'.repeat(5 - rounded)}</span>
      </span>
      <span>{rating.toFixed(1)}</span>
      <span>({count})</span>
    </span>
  );
}

/** Effective price: an in-window flash sale beats the listed price. */
function priceFor(product: SeoProduct) {
  const flashPrice = Number(product.flashSalePrice) || 0;
  const now = Date.now();
  const start = product.flashSaleStartsAt ? new Date(product.flashSaleStartsAt).getTime() : 0;
  const end = product.flashSaleEndsAt ? new Date(product.flashSaleEndsAt).getTime() : NaN;
  const flashLive = flashPrice > 0 && flashPrice < product.price && Number.isFinite(end) && now >= start && now < end;
  const compareAt = flashLive
    ? product.price
    : product.compareAtPrice && product.compareAtPrice > product.price
      ? product.compareAtPrice
      : 0;
  const price = flashLive ? flashPrice : product.price;
  return {
    price,
    compareAt,
    discount: compareAt > price ? Math.round(((compareAt - price) / compareAt) * 100) : 0,
    flashSale: flashLive,
  };
}

/**
 * Compact public product card — the same density as the in-app card so a shopper
 * moving between the marketplace and a listing page sees one product language.
 */
export function ProductCard({ product, eager = false }: { product: SeoProduct; eager?: boolean }) {
  const image = product.images[0];
  const { price, compareAt, discount, flashSale } = priceFor(product);

  return (
    <article className="group flex h-full flex-col overflow-hidden rounded-[1.35rem] border border-ink-200/80 bg-white transition-[border-color,box-shadow,transform] dark:border-ink-800 dark:bg-ink-900 gs-product-card hover:border-jade-600/40 hover:shadow-[0_12px_28px_-16px_rgba(3,34,20,0.35)]">
      <div className="relative aspect-square w-full overflow-hidden bg-ink-100 dark:bg-ink-850">
        <Link href={`/products/${product.id}`} className="block h-full w-full">
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={image}
              alt={`${product.title}${product.brand ? ` by ${product.brand}` : ''} — ${product.condition.toLowerCase().replace(/_/g, ' ')} condition`}
              width={480}
              height={480}
              loading={eager ? 'eager' : 'lazy'}
              decoding="async"
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
            />
          ) : (
            <span className="flex h-full items-center justify-center text-3xl font-black text-ink-300 dark:text-ink-700" aria-hidden="true">
              GS
            </span>
          )}
        </Link>

        <span className="pointer-events-none absolute left-1.5 top-1.5 flex flex-col items-start gap-1">
          {discount > 0 && (
            <span className="rounded bg-jade-950 dark:bg-jade-700 px-1.5 py-0.5 text-[10px] font-black leading-4 text-gold-300">
              -{discount}%
            </span>
          )}
          {flashSale && (
            <span className="rounded bg-jade-600 px-1.5 py-0.5 text-[9px] font-black uppercase leading-4 tracking-wide text-white">
              Flash
            </span>
          )}
        </span>

        {!product.inStock && (
          <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-ink-950/80 py-1 text-center text-[10px] font-bold uppercase tracking-wide text-white">
            Out of stock
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <h3 className="line-clamp-2 min-h-[2rem] text-[13px] font-semibold leading-[1.35] text-ink-900 dark:text-ink-100">
          <Link href={`/products/${product.id}`} className="hover:text-jade-700 dark:hover:text-jade-300">
            {product.title}
          </Link>
        </h3>

        <span className="flex min-h-[14px] items-center gap-1 text-[10px] leading-none text-ink-500 dark:text-ink-400">
          {product.rating && product.reviewCount > 0 ? (
            <>
              <Star className="h-3 w-3 fill-gold-400 text-gold-400" aria-hidden="true" />
              <span className="font-bold text-ink-900 dark:text-ink-100">{product.rating.toFixed(1)}</span>
              <span>({product.reviewCount})</span>
            </>
          ) : (
            <span className="text-ink-400 dark:text-ink-500">No reviews yet</span>
          )}
        </span>

        <p className="flex flex-wrap items-baseline gap-1.5">
          <span className="text-[16px] font-extrabold leading-5 tracking-tight text-ink-900 dark:text-white">{naira(price)}</span>
          {compareAt > price && (
            <span className="text-[10px] font-medium text-ink-400 dark:text-ink-500 line-through">{naira(compareAt)}</span>
          )}
        </p>

        <p className="flex items-center gap-1 text-[10px] leading-3 text-ink-500 dark:text-ink-400">
          <Truck className="h-3 w-3 shrink-0 text-ink-400 dark:text-ink-500" aria-hidden="true" />
          <span className="truncate">{product.sellerState ? `Ships from ${product.sellerState}` : 'Escrow protected'}</span>
        </p>

        <p className="flex min-w-0 items-center gap-1 text-[10px] text-ink-500 dark:text-ink-400">
          <Link href={`/sellers/${product.sellerId}`} className="truncate hover:text-ink-900 dark:hover:text-ink-100 hover:underline">
            {product.sellerName}
          </Link>
          {product.sellerVerified && (
            <span
              className="inline-grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full bg-jade-500/15 text-jade-700 dark:text-jade-300"
              aria-label="Verified seller"
              title="Verified seller"
            >
              <BadgeCheck className="h-3 w-3" aria-hidden="true" />
            </span>
          )}
        </p>
      </div>
    </article>
  );
}
