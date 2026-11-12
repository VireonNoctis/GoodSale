// components/marketplace/ProductTile.tsx
'use client';

/**
 * The one product card used across the marketplace.
 *
 * Compact by design: a square image, two title lines, price, rating, seller and
 * a quick-add control. Every badge is derived from real rows — a discount only
 * appears when the seller set a higher reference price or a flash sale is live.
 */
import React, { useEffect } from 'react';
import { Heart, ShoppingCart, Star, Truck, Zap, BadgeCheck } from 'lucide-react';
import type { Product } from '@/lib/types';
import { activeFlashSale } from '@/lib/productPricing';
import { trackProductMetric } from '@/lib/productMetrics';
import { SmartImage } from '../ui/SmartImage';
import IconButton from '@/components/ui/IconButton';

export type ProductTileBadge = 'featured' | 'trending' | 'flash' | 'new' | null;

export interface ProductTileProps {
  product: Product;
  rating: number | null;
  reviewCount: number;
  sellerName?: string;
  sellerVerified?: boolean;
  sellerState?: string;
  badge?: ProductTileBadge;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  onSelect: () => void;
  onAdd: () => void;
  /** Load the image immediately — use for above-the-fold cards only. */
  eager?: boolean;
  className?: string;
}

function naira(value: number): string {
  return `₦${Math.round(Number(value) || 0).toLocaleString('en-NG')}`;
}

const BADGE_STYLES: Record<Exclude<ProductTileBadge, null>, string> = {
  featured: 'bg-gold-300 text-ink-950',
  trending: 'bg-ink-900/90 text-white dark:bg-white/90 dark:text-ink-950',
  flash: 'bg-jade-600 text-white',
  new: 'bg-white/95 text-jade-700 ring-1 ring-jade-600/20 dark:bg-ink-950/90 dark:text-jade-200',
};

const BADGE_LABELS: Record<Exclude<ProductTileBadge, null>, string> = {
  featured: 'Featured',
  trending: 'Trending',
  flash: 'Flash',
  new: 'New',
};

export default function ProductTile({
  product,
  rating,
  reviewCount,
  sellerName,
  sellerVerified = false,
  sellerState,
  badge = null,
  isFavorite,
  onToggleFavorite,
  onSelect,
  onAdd,
  eager = false,
  className = '',
}: ProductTileProps) {
  const flashSale = activeFlashSale(product);
  const price = flashSale?.price ?? product.price;
  const compareAt = flashSale ? product.price : Number(product.compareAtPrice || 0);
  const discount = flashSale?.discountPercent
    ?? (compareAt > product.price ? Math.round(((compareAt - product.price) / compareAt) * 100) : 0);
  const soldOut =
    product.quantity <= 0 ||
    ['SOLD', 'UNAVAILABLE', 'OUT_OF_STOCK'].includes(product.stockStatus);
  const lowStock = !soldOut && product.quantity <= 8;
  const statusBadge: ProductTileBadge = flashSale ? 'flash' : badge;

  useEffect(() => {
    trackProductMetric(product.id, 'impression', true);
  }, [product.id]);

  return (
    <article
      onClick={onSelect}
      className={`group relative flex h-full cursor-pointer flex-col overflow-hidden rounded-[1.35rem] border border-ink-200/80 bg-white transition-[border-color,box-shadow,transform] duration-200 ease-glide hover:-translate-y-1 hover:border-jade-500/45 motion-reduce:transform-none motion-reduce:transition-none dark:border-ink-800 dark:bg-ink-900 dark:hover:border-jade-400/40 gs-product-card ${badge === 'featured' ? 'gs-iridescent' : ''} ${className}`}
    >
      {/* ── media ── */}
      <div className="relative aspect-square w-full overflow-hidden bg-ink-50 dark:bg-ink-950">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onSelect();
          }}
          aria-label={`View ${product.title}`}
          className="block h-full w-full focus-ring"
        >
          <SmartImage
            src={product.images?.[0]}
            alt={product.title}
            seed={`tile-${product.id}`}
            className="h-full w-full"
            imgClassName="h-full w-full object-cover transition-transform duration-300 ease-glide group-hover:scale-[1.04] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
            loading={eager ? 'eager' : 'lazy'}
          />
        </button>

        <div className="pointer-events-none absolute left-1.5 top-1.5 flex flex-col items-start gap-1">
          {discount > 0 && (
            <span className="rounded bg-jade-600 px-1.5 py-0.5 text-[10px] font-black leading-4 text-white shadow-sm">
              -{discount}%
            </span>
          )}
          {statusBadge && (
            <span className={`rounded-lg px-2 py-1 text-[9px] font-black uppercase leading-4 tracking-wide shadow-sm ${BADGE_STYLES[statusBadge]}`}>
              {BADGE_LABELS[statusBadge]}
            </span>
          )}
        </div>

        <IconButton
          icon={Heart}
          size="sm"
          label={isFavorite ? `Remove ${product.title} from wishlist` : `Save ${product.title} to wishlist`}
          aria-pressed={isFavorite}
          onClick={(event) => {
            event.stopPropagation();
            onToggleFavorite();
          }}
          iconClassName={isFavorite ? 'fill-jade-500 text-jade-500 dark:fill-jade-400 dark:text-jade-400' : ''}
          className="absolute right-1.5 top-1.5 !rounded-full !border-transparent !bg-white/90 !text-ink-500 shadow-sm backdrop-blur hover:!text-jade-600 dark:!bg-ink-950/80 dark:!text-ink-300 dark:hover:!text-jade-300"
        />

        {lowStock && !discount && (
          <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded bg-ink-900/85 px-1.5 py-0.5 text-[9px] font-bold text-white">
            {product.quantity} left
          </span>
        )}

        {soldOut && (
          <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-ink-900/80 py-1 text-center text-[10px] font-bold uppercase tracking-wide text-white">
            Out of stock
          </span>
        )}
      </div>

      {/* ── body ── */}
      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <h3 className="line-clamp-2 min-h-[2rem] text-[13px] font-semibold leading-[1.35] text-ink-900 dark:text-ink-100">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onSelect();
            }}
            className="text-left hover:text-jade-700 focus-ring dark:hover:text-jade-300"
          >
            {product.title}
          </button>
        </h3>

        <div className="flex min-h-[14px] items-center gap-1 text-[10px] leading-none">
          {rating ? (
            <>
              <Star className="h-3 w-3 fill-gold-400 text-gold-400" aria-hidden="true" />
              <span className="font-bold text-ink-700 dark:text-ink-200">{rating.toFixed(1)}</span>
              <span className="text-ink-500 dark:text-ink-400">
                ({reviewCount >= 1000 ? `${(reviewCount / 1000).toFixed(1)}k` : reviewCount})
              </span>
            </>
          ) : (
            <span className="text-ink-400">No reviews yet</span>
          )}
        </div>

        <div className="flex flex-wrap items-baseline gap-1.5">
          <span className="text-[16px] font-extrabold leading-5 tracking-tight text-ink-900 dark:text-white">
            {naira(price)}
          </span>
          {discount > 0 && compareAt > price && (
            <span className="text-[10px] font-medium text-ink-400 line-through">{naira(compareAt)}</span>
          )}
        </div>

        <p className="flex items-center gap-1 text-[10px] leading-3 text-ink-600 dark:text-ink-300">
          {soldOut ? (
            <span className="truncate">Currently unavailable</span>
          ) : (
            <>
              <Truck className="h-3 w-3 shrink-0 text-ink-400" aria-hidden="true" />
              <span className="truncate">{sellerState ? `Ships from ${sellerState}` : 'Escrow protected'}</span>
            </>
          )}
        </p>

        <div className="mt-auto flex items-center justify-between gap-1 pt-1">
          <span className="flex min-w-0 items-center gap-1 text-[10px] text-ink-600 dark:text-ink-300">
            <span className="truncate">{sellerName || 'GoodSale seller'}</span>
            {sellerVerified && (
              <span
                className="inline-grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full bg-jade-500/15 text-jade-700 dark:text-jade-300"
                aria-label="Verified seller"
                title="Verified seller"
              >
                <BadgeCheck className="h-3 w-3" aria-hidden="true" />
              </span>
            )}
          </span>
          <IconButton
            icon={flashSale ? Zap : ShoppingCart}
            size="sm"
            tone="primary"
            label={`Add ${product.title} to cart`}
            disabled={soldOut}
            onClick={(event) => {
              event.stopPropagation();
              onAdd();
            }}
            className="shrink-0 !rounded-xl"
          />
        </div>
      </div>
    </article>
  );
}
