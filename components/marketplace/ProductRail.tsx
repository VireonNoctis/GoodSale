// components/marketplace/ProductRail.tsx
'use client';

/**
 * Horizontally scrollable product section.
 *
 * Swipes natively on touch, scrolls with the arrows on desktop, and every rail
 * links to the dedicated listing route that shows the same selection with
 * filters, sorting and pagination.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Product } from '@/lib/types';
import ProductTile, { type ProductTileBadge } from './ProductTile';

export interface RailProduct {
  product: Product;
  rating: number | null;
  reviewCount: number;
  sellerName?: string;
  sellerVerified?: boolean;
  sellerState?: string;
  badge?: ProductTileBadge;
}

interface ProductRailProps {
  title: string;
  subtitle?: string;
  href: string;
  icon?: React.ReactNode;
  headerExtra?: React.ReactNode;
  products: RailProduct[];
  favorites: number[];
  onToggleFavorite: (productId: number) => void;
  onSelectProduct: (productId: number) => void;
  onAddToCart: (productId: number) => void;
  variant?: 'plain' | 'jade';
  label: string;
}

function scrollAmount(el: HTMLElement) {
  return Math.max(260, Math.round(el.clientWidth * 0.85));
}

export default function ProductRail({
  title,
  subtitle,
  href,
  icon,
  headerExtra,
  products,
  favorites,
  onToggleFavorite,
  onSelectProduct,
  onAddToCart,
  variant = 'plain',
  label,
}: ProductRailProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ start: true, end: false });

  const measure = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdges({ start: el.scrollLeft <= 4, end: el.scrollLeft >= max - 4 });
  }, []);

  useEffect(() => {
    measure();
    const el = trackRef.current;
    if (!el) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, products.length]);

  const nudge = (direction: -1 | 1) => {
    const el = trackRef.current;
    if (!el) return;
    const reduced = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({ left: direction * scrollAmount(el), behavior: reduced ? 'auto' : 'smooth' });
  };

  const jade = variant === 'jade';
  const arrowClass = jade
    ? 'border-white/25 text-white hover:bg-white/10 disabled:opacity-30'
    : 'border-ink-200 text-ink-600 hover:bg-ink-50 disabled:opacity-30 dark:border-ink-800 dark:text-ink-300 dark:hover:bg-ink-800/60';

  if (products.length === 0) return null;

  return (
    <section
      className={
        jade
          ? 'relative overflow-hidden rounded-[1.5rem] bg-jade-950 p-4 text-white sm:p-5 dark:bg-ink-900'
          : ''
      }
      aria-label={label}
    >
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {icon && (
            <span
              className={
                jade
                  ? 'grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-white/10 text-gold-300'
                  : 'grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-jade-500/10 text-jade-600 dark:text-jade-300'
              }
            >
              {icon}
            </span>
          )}
          <div className="min-w-0">
            <h2
              className={`font-display text-base font-extrabold tracking-tight sm:text-lg ${
                jade ? 'text-white' : 'text-ink-900 dark:text-white'
              }`}
            >
              {title}
            </h2>
            {subtitle && (
              <p className={`line-clamp-1 text-[11px] ${jade ? 'text-jade-100/70' : 'text-ink-500 dark:text-ink-400'}`}>
                {subtitle}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {headerExtra}
          <div className="hidden items-center gap-1 md:flex">
            <button
              type="button"
              onClick={() => nudge(-1)}
              disabled={edges.start}
              aria-label={`Scroll ${title} left`}
              className={`grid h-7 w-7 place-items-center rounded-full border transition-colors focus-ring ${arrowClass}`}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => nudge(1)}
              disabled={edges.end}
              aria-label={`Scroll ${title} right`}
              className={`grid h-7 w-7 place-items-center rounded-full border transition-colors focus-ring ${arrowClass}`}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <Link
            href={href}
            className={`inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-bold transition-colors ${
              jade
                ? 'text-gold-300 hover:bg-white/10 hover:text-gold-200'
                : 'text-jade-700 hover:bg-jade-500/10 dark:text-jade-300'
            }`}
          >
            See all
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </div>
      </div>

      <div
        ref={trackRef}
        onScroll={measure}
        tabIndex={0}
        role="region"
        aria-label={`${label} — scroll horizontally`}
        className="-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-2 scrollbar-hide gs-scroll-fade focus-ring"
        style={{ scrollbarWidth: 'none' }}
      >
        {products.map((item, index) => (
          <div
            key={item.product.id}
            className="w-[148px] shrink-0 snap-start sm:w-[166px] xl:w-[182px]"
          >
            <ProductTile
              product={item.product}
              rating={item.rating}
              reviewCount={item.reviewCount}
              sellerName={item.sellerName}
              sellerVerified={item.sellerVerified}
              sellerState={item.sellerState}
              badge={item.badge ?? null}
              isFavorite={favorites.includes(item.product.id)}
              onToggleFavorite={() => onToggleFavorite(item.product.id)}
              onSelect={() => onSelectProduct(item.product.id)}
              onAdd={() => onAddToCart(item.product.id)}
              eager={index < 4}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
