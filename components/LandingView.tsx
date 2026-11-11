// components/LandingView.tsx
'use client';

/**
 * Marketplace home — a curated storefront over the live catalogue.
 *
 * Layout: compact promo band → category nav → Flash deals → Featured →
 * Shop by category → Recommended → Trending → Recently added → Best deals →
 * seller band → the full catalogue with filters.
 *
 * Every section hides itself when the catalogue cannot fill it, and every
 * "See all" link goes to a real listing route (/featured, /flash-deals, …) that
 * shows the same selection with filters, sorting and pagination.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Heart, ShoppingCart, Zap, ShieldCheck, Truck, Headphones,
  BadgeCheck, ArrowRight, ChevronRight, Sparkles, Store, Flame, Gavel,
  Shirt, Cpu, Smartphone, Laptop, Armchair, Apple, Car, BookOpen, LayoutGrid,
  Package, SlidersHorizontal, TrendingUp, Tag, Clock, Plus,
} from 'lucide-react';
import { Product, useDBState } from '../lib/store';
import type { Profile, User } from '@/lib/types';
import { isVerifiedSeller } from '@/lib/verification';
import VerifiedBadge from './verification/VerifiedBadge';
import { activeFlashSale } from '@/lib/productPricing';
import { discoveryScore } from '@/lib/ranking';
import { useWishlist } from '@/lib/hooks/useWishlist';
import { SmartImage } from './ui/SmartImage';
import EmptyState from './ui/EmptyState';
import AdSlot from './AdSlot';
import ProductTile from './marketplace/ProductTile';
import ProductRail, { type RailProduct } from './marketplace/ProductRail';
import { COLLECTIONS } from '@/lib/marketplace/collections';

interface LandingViewProps {
  onSelectProduct: (productId: number) => void;
  searchQuery: string;
  onNavigate: (view: string, payload?: any) => void;
  onAddToCart: (productId: number) => void;
  onOpenAuth?: (mode?: 'login' | 'register') => void;
  /** Delivery-location filter, driven by the marketplace header. */
  selectedState: string;
  onSelectState: (state: string) => void;
  wishlistOnly: boolean;
  onWishlistOnlyChange: (value: boolean) => void;
}

type SortMode = 'smart' | 'rating' | 'price_asc' | 'price_desc' | 'newest';

const PAGE_SIZE = 24;

const CATEGORY_META: Record<string, { label: string; Icon: React.ComponentType<{ className?: string }> }> = {
  phones: { label: 'Phones & Tablets', Icon: Smartphone },
  laptops: { label: 'Laptops', Icon: Laptop },
  electronics: { label: 'Electronics', Icon: Cpu },
  fashion: { label: 'Fashion', Icon: Shirt },
  furniture: { label: 'Home & Living', Icon: Armchair },
  groceries: { label: 'Groceries', Icon: Apple },
  beauty: { label: 'Beauty', Icon: Sparkles },
  vehicles: { label: 'Vehicles', Icon: Car },
  books: { label: 'Books', Icon: BookOpen },
};

function categoryMeta(category: string) {
  return CATEGORY_META[category.trim().toLowerCase()] || { label: category, Icon: Package };
}

function naira(value: number): string {
  return `₦${Math.round(Number(value) || 0).toLocaleString('en-NG')}`;
}

/** Real discount percentage — null unless the compare-at price is genuinely higher. */
function discountPercent(product: Product): number | null {
  const compareAt = Number(product.compareAtPrice) || 0;
  if (!compareAt || compareAt <= product.price) return null;
  return Math.round(((compareAt - product.price) / compareAt) * 100);
}

function inStock(product: Product): boolean {
  return product.quantity > 0 && ['IN_STOCK', 'LOW_STOCK'].includes(product.stockStatus);
}

function useCountdownTo(endsAt?: string | null) {
  const read = useCallback(() => {
    const end = endsAt ? new Date(endsAt).getTime() : 0;
    const diff = Math.max(0, end - Date.now());
    return {
      hours: Math.floor(diff / 3.6e6),
      minutes: Math.floor((diff % 3.6e6) / 60000),
      seconds: Math.floor((diff % 60000) / 1000),
      ended: Boolean(endsAt) && diff <= 0,
    };
  }, [endsAt]);
  const [left, setLeft] = useState(read);
  useEffect(() => {
    setLeft(read());
    const id = setInterval(() => setLeft(read()), 1000);
    return () => clearInterval(id);
  }, [read]);
  return left;
}

function Countdown({ hours, minutes, seconds, tone = 'light' }: { hours: number; minutes: number; seconds: number; tone?: 'light' | 'dark' }) {
  const box = tone === 'dark'
    ? 'bg-white text-ink-950'
    : 'bg-jade-950 text-white dark:bg-white dark:text-ink-950';
  return (
    <span className="inline-flex items-center gap-1" aria-label="Time left">
      {[
        { value: hours, label: 'h' },
        { value: minutes, label: 'm' },
        { value: seconds, label: 's' },
      ].map((part, index) => (
        <React.Fragment key={part.label}>
          {index > 0 && <span className={`text-[10px] font-black ${tone === 'dark' ? 'text-white/60' : 'text-ink-300'}`}>:</span>}
          <span className={`min-w-[22px] rounded px-1 py-0.5 text-center text-[11px] font-black tabular-nums leading-4 ${box}`}>
            {String(part.value).padStart(2, '0')}
          </span>
        </React.Fragment>
      ))}
    </span>
  );
}

function scrollToId(id: string) {
  if (typeof document === 'undefined') return;
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export default function LandingView({
  onSelectProduct,
  searchQuery,
  onNavigate,
  onAddToCart,
  onOpenAuth,
  selectedState,
  onSelectState,
  wishlistOnly,
  onWishlistOnlyChange,
}: LandingViewProps) {
  const db = useDBState();
  const { favorites, toggle: toggleFavorite } = useWishlist();

  const [activeSlide, setActiveSlide] = useState(0);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [onlyVerified, setOnlyVerified] = useState(false);
  const [dealsOnly, setDealsOnly] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>('smart');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  /* ---- indexes ---- */
  const profilesByUserId = useMemo(() => {
    const map = new Map<number, Profile>();
    for (const profile of db.profiles) map.set(profile.userId, profile);
    return map;
  }, [db.profiles]);

  const usersById = useMemo(() => {
    const map = new Map<number, User>();
    for (const user of db.users) map.set(user.id, user);
    return map;
  }, [db.users]);

  const reviewStats = useMemo(() => {
    const map = new Map<number, { total: number; count: number }>();
    for (const review of db.reviews) {
      if (!review.productId || !review.rating) continue;
      const entry = map.get(review.productId) || { total: 0, count: 0 };
      entry.total += review.rating;
      entry.count += 1;
      map.set(review.productId, entry);
    }
    const avg = new Map<number, { average: number; count: number }>();
    map.forEach((value, key) => avg.set(key, { average: value.total / value.count, count: value.count }));
    return avg;
  }, [db.reviews]);

  const stateOf = useCallback(
    (sellerId: number) => profilesByUserId.get(sellerId)?.state || '',
    [profilesByUserId]
  );

  const ratingOf = useCallback(
    (productId: number) => reviewStats.get(productId)?.average ?? null,
    [reviewStats]
  );
  const reviewCountOf = useCallback(
    (productId: number) => reviewStats.get(productId)?.count ?? 0,
    [reviewStats]
  );

  /* ---- categories (only real ones, with a representative photo) ---- */
  const categories = useMemo(() => {
    const byCategory = new Map<string, { name: string; count: number; image?: string }>();
    for (const product of db.products) {
      const key = product.category || 'Other';
      const entry = byCategory.get(key) || { name: key, count: 0 };
      entry.count += 1;
      if (!entry.image && product.images?.[0]) entry.image = product.images[0];
      byCategory.set(key, entry);
    }
    return Array.from(byCategory.values()).sort((a, b) => b.count - a.count);
  }, [db.products]);

  /* ---- states with listings ---- */
  const states = useMemo(() => {
    const set = new Set<string>();
    for (const product of db.products) {
      const state = stateOf(product.sellerId);
      if (state) set.add(state);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [db.products, stateOf]);

  const activeFeaturedIds = useMemo(
    () =>
      new Set(
        db.featuredListings
          .filter(
            (entry) =>
              (entry.featureType || 'FEATURED') === 'FEATURED' &&
              entry.status === 'ACTIVE' &&
              (entry.moderationStatus || 'APPROVED') === 'APPROVED' &&
              (!entry.startsAt || new Date(entry.startsAt).getTime() <= Date.now()) &&
              new Date(entry.expiresAt).getTime() > Date.now()
          )
          .map((entry) => entry.productId)
      ),
    [db.featuredListings]
  );

  const activeVerifiedPlusSellers = useMemo(
    () =>
      new Set(
        db.verifiedPlusSubscriptions
          .filter((entry) => new Date(entry.expiresAt).getTime() > Date.now())
          .map((entry) => entry.userId)
      ),
    [db.verifiedPlusSubscriptions]
  );

  /* ---- filtering ---- */
  const filteredProducts = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    let list = db.products.filter((product) => {
      if (query) {
        const haystack = `${product.title} ${product.description} ${product.category} ${product.brand}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      if (selectedCategory && product.category.toLowerCase() !== selectedCategory.toLowerCase()) return false;
      if (selectedState && stateOf(product.sellerId) !== selectedState) return false;
      if (onlyVerified) {
        const sellerProfile = profilesByUserId.get(product.sellerId);
        const verified = isVerifiedSeller({
          verificationStatus: sellerProfile?.verificationStatus,
          verificationExpiresAt: sellerProfile?.verificationExpiresAt,
        });
        if (!verified) return false;
      }
      if (wishlistOnly && !favorites.includes(product.id)) return false;
      if (dealsOnly && discountPercent(product) === null && !activeFlashSale(product)) return false;
      return true;
    });

    list = [...list].sort((a, b) => {
      switch (sortMode) {
        case 'price_asc':
          return a.price - b.price;
        case 'price_desc':
          return b.price - a.price;
        case 'newest':
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        case 'rating':
          return (ratingOf(b.id) || 0) - (ratingOf(a.id) || 0);
        default: {
          const ratings = new Map<number, number>();
          reviewStats.forEach((value, key) => ratings.set(key, value.average));
          const context = {
            ratings,
            featuredProductIds: activeFeaturedIds,
            verifiedPlusSellerIds: activeVerifiedPlusSellers,
            featuredBoost: db.revenueSettings.featuredRankingBoost,
            verifiedPlusBoost: db.revenueSettings.verifiedPlusRankingBoost,
          };
          return discoveryScore(b, context) - discoveryScore(a, context);
        }
      }
    });
    return list;
  }, [
    db.products, db.revenueSettings, searchQuery, selectedCategory, selectedState, onlyVerified,
    wishlistOnly, dealsOnly, favorites, profilesByUserId, stateOf, sortMode, ratingOf, reviewStats,
    activeFeaturedIds, activeVerifiedPlusSellers,
  ]);

  // A new filter or search always restarts the catalogue at page one.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [searchQuery, selectedCategory, selectedState, onlyVerified, dealsOnly, wishlistOnly, sortMode]);

  /* ---- Flash Deals come only from approved, currently running sales. ---- */
  const flashDeals = useMemo(
    () =>
      db.products
        .filter((product) => activeFlashSale(product) && inStock(product))
        .sort((a, b) => (activeFlashSale(b)?.discountPercent || 0) - (activeFlashSale(a)?.discountPercent || 0))
        .slice(0, 12),
    [db.products]
  );
  const flashEndsAt = useMemo(
    () =>
      flashDeals
        .map((product) => activeFlashSale(product)?.endsAt)
        .filter((value): value is string => Boolean(value))
        .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0] || null,
    [flashDeals]
  );
  const countdown = useCountdownTo(flashEndsAt);

  /* ---- curated rails ---- */
  /** Paid placements win; otherwise the highest-rated live listings stand in. */
  const featuredProducts = useMemo(() => {
    const promoted = db.products.filter((product) => activeFeaturedIds.has(product.id) && inStock(product));
    if (promoted.length > 0) return promoted.slice(0, 12);
    return db.products
      .filter(inStock)
      .sort((a, b) => (ratingOf(b.id) || 0) - (ratingOf(a.id) || 0) || b.viewCount - a.viewCount)
      .slice(0, 12);
  }, [db.products, activeFeaturedIds, ratingOf]);

  const recommended = useMemo(() => {
    const favoriteCategories = new Set(
      db.products.filter((p) => favorites.includes(p.id)).map((p) => p.category.toLowerCase())
    );
    const buyerState = db.profiles.find((p) => p.userId === db.currentUser?.id)?.state || '';
    const scored = db.products
      .filter((p) => !flashDeals.some((d) => d.id === p.id))
      .map((product) => {
        let score = (ratingOf(product.id) || 3) * 20 + product.viewCount / 20;
        if (buyerState && stateOf(product.sellerId) === buyerState) score += 35;
        if (favoriteCategories.has(product.category.toLowerCase())) score += 45;
        if (product.stockStatus === 'LOW_STOCK') score += 5;
        return { product, score };
      })
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, 12).map((s) => s.product);
  }, [db.products, db.profiles, db.currentUser, favorites, flashDeals, ratingOf, stateOf]);

  const trendingProducts = useMemo(() => {
    const score = (product: Product) =>
      product.viewCount * 2 + (product.likes || 0) * 3 + (product.cartAdds || 0) * 2 + (ratingOf(product.id) || 0) * 30;
    return db.products
      .filter(inStock)
      .sort((a, b) => score(b) - score(a))
      .slice(0, 12);
  }, [db.products, ratingOf]);

  const newArrivals = useMemo(
    () =>
      db.products
        .filter(inStock)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 12),
    [db.products]
  );

  const bestDeals = useMemo(() => {
    const score = (product: Product) => activeFlashSale(product)?.discountPercent ?? discountPercent(product) ?? 0;
    return db.products
      .filter((product) => score(product) > 0 && inStock(product))
      .sort((a, b) => score(b) - score(a))
      .slice(0, 12);
  }, [db.products]);

  const auctions = useMemo(() => db.products.filter((p) => p.isAuction).slice(0, 4), [db.products]);

  const verifiedSellers = useMemo(() => {
    return db.users
      .filter((user) => {
        const profile = profilesByUserId.get(user.id);
        return isVerifiedSeller({
          verificationStatus: profile?.verificationStatus,
          verificationExpiresAt: profile?.verificationExpiresAt,
        });
      })
      .slice(0, 6);
  }, [db.users, profilesByUserId]);

  const sellerProps = useCallback(
    (sellerId: number) => {
      const seller = usersById.get(sellerId);
      const profile = profilesByUserId.get(sellerId);
      return {
        sellerName: seller?.fullName || 'GoodSale seller',
        sellerVerified: isVerifiedSeller({
          verificationStatus: profile?.verificationStatus,
          verificationExpiresAt: profile?.verificationExpiresAt,
        }),
      };
    },
    [profilesByUserId, usersById]
  );

  /**
   * Rails render top to bottom and never repeat a product. A section that
   * cannot fill itself from unseen listings is hidden instead of echoing the
   * section above it — a small catalogue should feel sparse, not padded.
   */
  const railSections = useMemo(() => {
    const used = new Set<number>(flashDeals.map((product) => product.id));
    const take = (list: Product[]) => {
      const fresh = list.filter((product) => !used.has(product.id));
      if (fresh.length < 3) return [] as Product[];
      const picked = fresh.slice(0, 12);
      picked.forEach((product) => used.add(product.id));
      return picked;
    };
    return {
      featured: take(featuredProducts),
      recommended: take(recommended),
      trending: take(trendingProducts),
      newArrivals: take(newArrivals),
      bestDeals: take(bestDeals),
    };
  }, [flashDeals, featuredProducts, recommended, trendingProducts, newArrivals, bestDeals]);

  const asRail = useCallback(
    (product: Product, badge: RailProduct['badge'] = null): RailProduct => ({
      product,
      rating: ratingOf(product.id),
      reviewCount: reviewCountOf(product.id),
      sellerState: stateOf(product.sellerId),
      badge,
      ...sellerProps(product.sellerId),
    }),
    [ratingOf, reviewCountOf, stateOf, sellerProps]
  );

  const railCommon = {
    favorites,
    onToggleFavorite: toggleFavorite,
    onSelectProduct: onSelectProduct,
    onAddToCart,
  };

  /* ---- hero ---- */
  const heroSlides = useMemo(
    () => [
      {
        eyebrow: 'Escrow marketplace',
        title: 'Shop smarter.',
        highlight: 'Pay when it arrives.',
        body: 'Great prices from verified Nigerian sellers, with your money held safely until delivery is confirmed.',
        cta: 'Shop the marketplace',
        href: null,
        action: () => {
          setSelectedCategory(null);
          onWishlistOnlyChange(false);
          scrollToId('catalog-section');
        },
      },
      {
        eyebrow: 'Flash deals',
        title: 'Price drops,',
        highlight: 'clock running.',
        body: flashDeals.length
          ? `${flashDeals.length} scheduled deals are live right now. The price you see is the price you pay.`
          : 'Scheduled deals appear here the moment a seller starts one.',
        cta: 'See live deals',
        href: COLLECTIONS['flash-deals'].href,
        action: () => {
          setSelectedCategory(null);
          setDealsOnly(true);
          scrollToId('catalog-section');
        },
      },
      {
        eyebrow: 'Verified sellers',
        title: 'Real stores.',
        highlight: 'Real reviews.',
        body: `${verifiedSellers.length} verified Nigerian merchants, with reviews tied to completed orders.`,
        cta: 'Meet the sellers',
        href: '/sellers',
        action: () => {
          if (verifiedSellers[0]) onNavigate('seller-profile', { sellerId: verifiedSellers[0].id });
          else scrollToId('catalog-section');
        },
      },
    ],
    [flashDeals.length, verifiedSellers, onNavigate, onWishlistOnlyChange]
  );

  useEffect(() => {
    // A rotating banner is decoration: leave it on the first slide for anyone
    // who asked the system to reduce motion.
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const id = setInterval(() => setActiveSlide((s) => (s + 1) % heroSlides.length), 7000);
    return () => clearInterval(id);
  }, [heroSlides.length]);

  const heroImages = useMemo(() => {
    const picks = [...db.products]
      .sort((a, b) => (ratingOf(b.id) || 0) - (ratingOf(a.id) || 0))
      .filter((p) => p.images?.length)
      .slice(0, 6);
    if (!picks.length) return [] as Product[];
    const out: Product[] = [];
    for (let i = 0; i < 2; i += 1) {
      const value = picks[(activeSlide * 2 + i) % picks.length];
      if (value) out.push(value);
    }
    return out;
  }, [db.products, activeSlide, ratingOf]);

  const slide = heroSlides[activeSlide] ?? heroSlides[0];
  const buyerState = db.profiles.find((profile) => profile.userId === db.currentUser?.id)?.state || '';
  const visibleProducts = filteredProducts.slice(0, visibleCount);
  const hasMore = filteredProducts.length > visibleProducts.length;

  const catalogHeading = wishlistOnly
    ? 'Your wishlist'
    : dealsOnly
      ? 'Discounted deals'
      : selectedCategory
        ? categoryMeta(selectedCategory).label
        : searchQuery.trim()
          ? `Results for “${searchQuery.trim()}”`
          : 'All listings';

  return (
    <div className="min-h-screen bg-ink-50 pb-20 transition-colors duration-300 dark:bg-ink-950">
      {/* ───────────────────────── Promo band ───────────────────────── */}
      <section className="border-b border-ink-150 bg-ink-50/60 dark:border-ink-800 dark:bg-ink-950">
        <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6 lg:px-8">
          <div className="grid gap-2.5 lg:grid-cols-[1.7fr_1fr]">
            {/* rotating banner */}
            <div className="relative flex min-h-[218px] items-center overflow-hidden rounded-[1.75rem] px-5 py-6 text-white shadow-[0_24px_56px_-36px_rgba(6,37,31,0.72)] gs-hero-panel sm:min-h-[250px] sm:px-7 sm:py-7">
              <div aria-hidden className="pointer-events-none absolute -left-10 -top-16 h-48 w-48 rounded-full bg-jade-500/25 blur-3xl" />
              <div aria-hidden className="pointer-events-none absolute -bottom-24 right-0 h-56 w-56 rounded-full bg-gold-400/10 blur-3xl" />
              <div className="relative z-10 max-w-md">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-gold-300 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-ink-950">
                  <Flame className="h-3 w-3" aria-hidden="true" />
                  {slide.eyebrow}
                </span>
                <h1 className="mt-3 font-display text-3xl font-extrabold leading-[1.04] tracking-[-0.04em] sm:text-4xl lg:text-[2.8rem]">
                  {slide.title}
                  <br />
                  <span className="text-gold-300">{slide.highlight}</span>
                </h1>
                <p className="mt-1.5 max-w-sm text-[11px] leading-relaxed text-jade-100/80 sm:text-xs">
                  {slide.body}
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={slide.action}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-white px-3.5 py-2.5 text-[11px] font-bold text-jade-950 transition-colors hover:bg-jade-50 active:scale-95 gs-tactile dark:bg-gold-300 dark:hover:bg-gold-200"
                  >
                    {slide.cta}
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  {slide.href && (
                    <Link
                      href={slide.href}
                      className="text-[11px] font-semibold text-jade-100/80 underline-offset-4 hover:text-white hover:underline"
                    >
                      Browse all
                    </Link>
                  )}
                </div>
                <div className="mt-3 flex items-center gap-1.5">
                  {heroSlides.map((item, index) => (
                    <button
                      key={item.eyebrow}
                      type="button"
                      aria-label={`Show ${item.eyebrow}`}
                      aria-current={index === activeSlide}
                      onClick={() => setActiveSlide(index)}
                      className={`h-1 rounded-full transition-all ${
                        index === activeSlide ? 'w-5 bg-gold-300' : 'w-1.5 bg-white/30 hover:bg-white/60'
                      }`}
                    />
                  ))}
                </div>
              </div>

              {heroImages.length > 0 && (
                <div className="relative ml-auto hidden items-center gap-2 sm:flex">
                  {heroImages.map((product) => (
                    <button
                      key={product.id}
                      type="button"
                      onClick={() => onSelectProduct(product.id)}
                      className="relative h-32 w-28 overflow-hidden rounded-2xl shadow-xl sm:h-36 sm:w-32 border border-white/15 bg-white/5 shadow-lg transition-transform hover:-translate-y-0.5 focus-ring lg:h-32 lg:w-28"
                      aria-label={`View ${product.title}`}
                    >
                      <SmartImage
                        src={product.images?.[0]}
                        alt={product.title}
                        seed={`hero-${product.id}`}
                        className="h-full w-full"
                        loading="eager"
                      />
                    </button>
                  ))}
                  <span className="absolute -bottom-1 right-0 inline-flex items-center gap-1 rounded-md bg-gold-300 px-1.5 py-1 text-[9px] font-black uppercase tracking-wide text-ink-950">
                    <BadgeCheck className="h-3 w-3" aria-hidden="true" />
                    Protected
                  </span>
                </div>
              )}
            </div>

            {/* side tiles */}
            <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-1">
              <Link
                href={COLLECTIONS['flash-deals'].href}
                className="group flex flex-col justify-between rounded-2xl border border-ink-200 bg-white p-3 transition-colors hover:border-jade-400 dark:border-ink-800 dark:bg-ink-900"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider text-jade-700 dark:text-jade-300">
                    <Zap className="h-3.5 w-3.5 fill-gold-400 text-gold-500" aria-hidden="true" />
                    Flash deals
                  </span>
                  {flashDeals.length > 0 && !countdown.ended && (
                    <Countdown hours={countdown.hours} minutes={countdown.minutes} seconds={countdown.seconds} />
                  )}
                </span>
                <span className="mt-2 block text-lg font-black leading-tight tracking-tight text-ink-900 dark:text-white">
                  {flashDeals.length > 0
                    ? `Up to ${Math.max(...flashDeals.map((p) => activeFlashSale(p)?.discountPercent || 0))}% off`
                    : 'No live deals yet'}
                </span>
                <span className="mt-0.5 flex items-center justify-between gap-2 text-[11px] leading-relaxed text-ink-500 dark:text-ink-400">
                  <span className="min-w-0">{flashDeals.length > 0 ? `${flashDeals.length} deals ending soon` : 'Check back later today'}</span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                </span>
              </Link>

              <div className="flex flex-col justify-between rounded-2xl border border-ink-150 bg-white p-3 dark:border-ink-800 dark:bg-ink-900">
                <span className="inline-flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider text-jade-700 dark:text-jade-300">
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                  GoodSale escrow
                </span>
                <span className="mt-2 block text-lg font-black leading-tight tracking-tight text-ink-900 dark:text-white">
                  Your money waits
                </span>
                <span className="mt-0.5 flex items-center justify-between gap-2 text-[11px] leading-relaxed text-ink-500 dark:text-ink-400">
                  <span className="min-w-0">Released only after you confirm delivery</span>
                  <Link href="/trust-safety" className="shrink-0 font-bold text-jade-700 hover:underline dark:text-jade-300">
                    How it works
                  </Link>
                </span>
              </div>
            </div>
          </div>

          {/* live status line */}
          <div className="mt-2 flex items-center justify-between gap-3 overflow-x-auto whitespace-nowrap text-[10px] font-semibold text-ink-500 scrollbar-hide dark:text-ink-400">
            <span className="inline-flex shrink-0 items-center gap-1.5">
              <Sparkles className="h-3 w-3 text-jade-600 dark:text-jade-300" aria-hidden="true" />
              {db.products.length} live listings across {states.length} states
            </span>
            <span className="inline-flex shrink-0 items-center gap-1.5">
              <Truck className="h-3 w-3 text-jade-600 dark:text-jade-300" aria-hidden="true" />
              Tracked delivery nationwide
            </span>
            <span className="inline-flex shrink-0 items-center gap-1.5">
              <Headphones className="h-3 w-3 text-jade-600 dark:text-jade-300" aria-hidden="true" />
              Human support, every day
            </span>
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <AdSlot
          placement="HOME"
          onNavigate={onNavigate}
          state={selectedState || buyerState}
          city={db.profiles.find((profile) => profile.userId === db.currentUser?.id)?.city || ''}
          category={selectedCategory || ''}
          className="mt-3"
        />

        {/* ───────────────────── Category nav ───────────────────── */}
        {categories.length > 0 && (
          <nav aria-label="Browse categories" className="mt-3 flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-hide">
            <button
              type="button"
              onClick={() => {
                setSelectedCategory(null);
                scrollToId('catalog-section');
              }}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-bold transition-colors ${
                selectedCategory === null
                  ? 'border-jade-600 bg-jade-600 text-white'
                  : 'border-ink-200 bg-white text-ink-600 hover:border-jade-300 dark:border-ink-800 dark:bg-ink-900 dark:text-ink-300'
              }`}
            >
              <LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" />
              All
            </button>
            {categories.slice(0, 14).map((category) => {
              const { Icon, label } = categoryMeta(category.name);
              const selected = selectedCategory?.toLowerCase() === category.name.toLowerCase();
              return (
                <button
                  key={category.name}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    setSelectedCategory(selected ? null : category.name);
                    scrollToId('catalog-section');
                  }}
                  className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-bold transition-colors ${
                    selected
                      ? 'border-jade-600 bg-jade-600 text-white'
                      : 'border-ink-200 bg-white text-ink-600 hover:border-jade-300 hover:text-jade-700 dark:border-ink-800 dark:bg-ink-900 dark:text-ink-300'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                  <span className={selected ? 'text-white/70' : 'text-ink-400'}>{category.count}</span>
                </button>
              );
            })}
            <Link
              href="/categories"
              className="inline-flex shrink-0 items-center gap-1 rounded-full px-3 py-1.5 text-[11px] font-bold text-jade-700 hover:bg-jade-500/10 dark:text-jade-300"
            >
              All categories
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </nav>
        )}

        {/* ───────────────────── Flash deals ───────────────────── */}
        {flashDeals.length >= 3 && !countdown.ended && (
          <div className="mt-4">
            <ProductRail
              label="Flash deals"
              title={COLLECTIONS['flash-deals'].title}
              subtitle={`${COLLECTIONS['flash-deals'].ordering} · prices return to normal when the timer ends`}
              href={COLLECTIONS['flash-deals'].href}
              icon={<Zap className="h-4 w-4 fill-gold-400" />}
              variant="jade"
              headerExtra={
                flashEndsAt ? (
                  <span className="hidden items-center gap-1.5 text-[10px] font-semibold text-jade-100/70 sm:inline-flex">
                    <Clock className="h-3 w-3" aria-hidden="true" />
                    Ends {new Date(flashEndsAt).toLocaleString('en-NG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </span>
                ) : null
              }
              products={flashDeals.map((product) => asRail(product, 'flash'))}
              {...railCommon}
            />
          </div>
        )}

        {/* ───────────────────── Featured ───────────────────── */}
        {railSections.featured.length > 0 && (
          <div className="mt-6">
            <ProductRail
              label="Featured products"
              title={COLLECTIONS.featured.title}
              subtitle={COLLECTIONS.featured.subtitle}
              href={COLLECTIONS.featured.href}
              icon={<Sparkles className="h-4 w-4" />}
              headerExtra={
                activeFeaturedIds.size > 0 ? (
                  <span className="hidden items-center gap-1 rounded-full bg-gold-100 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-gold-700 sm:inline-flex dark:bg-gold-300/15 dark:text-gold-200">
                    Promoted
                  </span>
                ) : (
                  <span className="hidden items-center gap-1 rounded-full bg-jade-500/10 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-jade-700 sm:inline-flex dark:text-jade-300">
                    Top rated
                  </span>
                )
              }
              products={railSections.featured.map((product) =>
                asRail(product, activeFeaturedIds.has(product.id) ? 'featured' : null)
              )}
              {...railCommon}
            />
          </div>
        )}

        {/* ───────────────────── Shop by category ───────────────────── */}
        {categories.length > 0 && (
          <section className="mt-6" aria-labelledby="shop-by-category">
            <div className="mb-2.5 flex items-end justify-between gap-2">
              <div>
                <h2 id="shop-by-category" className="font-display text-base font-extrabold tracking-tight text-ink-900 dark:text-white sm:text-lg">
                  Shop by category
                </h2>
                <p className="text-[11px] text-ink-500 dark:text-ink-400">Every category below has live listings.</p>
              </div>
              <Link href="/categories" className="inline-flex shrink-0 items-center gap-1 text-[11px] font-bold text-jade-700 hover:underline dark:text-jade-300">
                All categories
                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
              {categories.slice(0, 8).map((category) => {
                const { label, Icon } = categoryMeta(category.name);
                return (
                  <button
                    key={category.name}
                    type="button"
                    onClick={() => {
                      setSelectedCategory(category.name);
                      scrollToId('catalog-section');
                    }}
                    className="group relative flex h-20 flex-col justify-end overflow-hidden rounded-xl border border-ink-150 bg-ink-50 p-2 text-left transition-colors hover:border-jade-500/40 sm:h-24 dark:border-ink-800 dark:bg-ink-900 focus-ring"
                  >
                    {category.image ? (
                      <span className="absolute inset-0 block overflow-hidden">
                        <SmartImage
                          src={category.image}
                          alt=""
                          seed={`cat-${category.name}`}
                          className="h-full w-full opacity-90 transition-transform duration-300 group-hover:scale-105 motion-reduce:transition-none"
                        />
                      </span>
                    ) : (
                      <span className="absolute inset-0 grid place-items-center text-jade-600 dark:text-jade-300">
                        <Icon className="h-7 w-7" />
                      </span>
                    )}
                    <span aria-hidden className="absolute inset-0 bg-gradient-to-t from-ink-950/80 via-ink-950/10 to-transparent" />
                    <span className="relative flex items-center gap-1 text-[11px] font-bold leading-tight text-white">
                      <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
                      <span className="line-clamp-2">{label}</span>
                    </span>
                    <span className="relative text-[10px] text-white/70">{category.count} listings</span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* ───────────────────── Recommended ───────────────────── */}
        {railSections.recommended.length > 0 && (
          <div className="mt-6">
            <ProductRail
              label="Recommended for you"
              title={COLLECTIONS.recommended.title}
              subtitle={COLLECTIONS.recommended.subtitle}
              href={COLLECTIONS.recommended.href}
              icon={<Heart className="h-4 w-4" />}
              products={railSections.recommended.map((product) => asRail(product))}
              {...railCommon}
            />
          </div>
        )}

        {/* ───────────────────── Trending ───────────────────── */}
        {railSections.trending.length > 0 && (
          <div className="mt-6">
            <ProductRail
              label="Trending now"
              title={COLLECTIONS.trending.title}
              subtitle={COLLECTIONS.trending.subtitle}
              href={COLLECTIONS.trending.href}
              icon={<TrendingUp className="h-4 w-4" />}
              headerExtra={
                <span className="hidden items-center gap-1 rounded-full bg-jade-500/10 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-jade-700 sm:inline-flex dark:text-jade-300">
                  Live activity
                </span>
              }
              products={railSections.trending.map((product) => asRail(product, 'trending'))}
              {...railCommon}
            />
          </div>
        )}

        {/* ───────────────────── Recently added ───────────────────── */}
        {railSections.newArrivals.length > 0 && (
          <div className="mt-6">
            <ProductRail
              label="Recently added"
              title={COLLECTIONS['new-arrivals'].title}
              subtitle={COLLECTIONS['new-arrivals'].subtitle}
              href={COLLECTIONS['new-arrivals'].href}
              icon={<Clock className="h-4 w-4" />}
              products={railSections.newArrivals.map((product) => asRail(product, 'new'))}
              {...railCommon}
            />
          </div>
        )}

        {/* ───────────────────── Best deals ───────────────────── */}
        {railSections.bestDeals.length > 0 && (
          <div className="mt-6">
            <ProductRail
              label="Best deals"
              title={COLLECTIONS['best-deals'].title}
              subtitle={COLLECTIONS['best-deals'].subtitle}
              href={COLLECTIONS['best-deals'].href}
              icon={<Tag className="h-4 w-4" />}
              products={railSections.bestDeals.map((product) => asRail(product))}
              {...railCommon}
            />
          </div>
        )}

        {/* ───────────────────── Seller band ───────────────────── */}
        <section className="mt-7 overflow-hidden rounded-[1.75rem] text-white gs-seller-panel" aria-labelledby="sell-on-goodsale">
          <div className="grid gap-4 p-4 sm:p-6 lg:grid-cols-[1.3fr_1fr]">
            <div>
              <p className="inline-flex items-center gap-1.5 rounded-full bg-gold-300 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-ink-950">
                <Store className="h-3 w-3" aria-hidden="true" />
                Sell on GoodSale
              </p>
              <h2 id="sell-on-goodsale" className="mt-2 font-display text-xl font-black tracking-tight sm:text-2xl">
                Turn your stock into a verified storefront.
              </h2>
              <p className="mt-1.5 max-w-lg text-[11px] leading-relaxed text-jade-100/80 sm:text-xs">
                Publish listings in minutes, get paid from escrow after delivery, and track every rider in one place.
                Verification is reviewed by real people, not an algorithm.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => onNavigate('dashboard')}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-gold-300 px-3 py-2 text-[11px] font-bold text-ink-950 transition-colors hover:bg-gold-200 active:scale-95"
                >
                  Start selling
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <Link
                  href="/sellers"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/25 px-3 py-2 text-[11px] font-semibold text-white hover:bg-white/10"
                >
                  Browse verified sellers
                </Link>
              </div>
            </div>

            {verifiedSellers.length > 0 && (
              <div className="flex flex-col justify-center gap-2">
                <p className="text-[10px] font-bold uppercase tracking-wider text-jade-100/60">Verified merchants</p>
                <div className="flex flex-wrap gap-1.5">
                  {verifiedSellers.slice(0, 5).map((seller) => {
                    const profile = profilesByUserId.get(seller.id);
                    const listings = db.products.filter((p) => p.sellerId === seller.id).length;
                    return (
                      <button
                        key={seller.id}
                        type="button"
                        onClick={() => onNavigate('seller-profile', { sellerId: seller.id })}
                        className="flex items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-2 py-1.5 text-left transition-colors hover:bg-white/10 focus-ring"
                      >
                        <span className="grid h-7 w-7 place-items-center overflow-hidden rounded-full bg-white/10">
                          <SmartImage src={profile?.photoUrl} alt={seller.fullName} seed={`seller-${seller.id}`} className="h-full w-full" />
                        </span>
                        <span className="min-w-0">
                          <span className="flex items-center gap-1 text-[11px] font-bold">
                            <span className="truncate max-w-[110px]">{seller.fullName}</span>
                            <VerifiedBadge
                              sellerId={seller.id}
                              status={profile?.verificationStatus}
                              expiresAt={profile?.verificationExpiresAt}
                              variant="icon"
                              fallbackName={seller.fullName}
                              className="shrink-0"
                            />
                          </span>
                          <span className="block text-[10px] text-jade-100/60">
                            {listings} listings{profile?.state ? ` · ${profile.state}` : ''}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </section>

        {/* ───────────────────── Trust strip ───────────────────── */}
        <section className="mt-5 grid grid-cols-2 gap-3 rounded-[1.5rem] border border-ink-200/80 bg-white/90 p-4 shadow-[0_16px_44px_-38px_rgba(20,32,25,0.45)] backdrop-blur sm:grid-cols-4 dark:border-ink-800 dark:bg-ink-900/90">
          {[
            { Icon: ShieldCheck, title: 'Secure payments', body: 'Escrow on every order' },
            { Icon: Truck, title: 'Tracked delivery', body: 'Nationwide riders' },
            { Icon: BadgeCheck, title: 'Verified sellers', body: 'ID checked' },
            { Icon: Headphones, title: 'Human support', body: 'Every day' },
          ].map((item) => (
            <div key={item.title} className="flex items-center gap-2">
              <item.Icon className="h-5 w-5 shrink-0 text-jade-600 dark:text-gold-300" aria-hidden="true" />
              <div className="min-w-0">
                <p className="truncate text-[11px] font-bold leading-tight text-ink-900 dark:text-white">{item.title}</p>
                <p className="truncate text-[10px] text-ink-500 dark:text-ink-400">{item.body}</p>
              </div>
            </div>
          ))}
        </section>

        {/* ───────────────────── Catalogue ───────────────────── */}
        <section id="catalog-section" className="mt-6 scroll-mt-28">
          <div className="mb-2.5 flex flex-wrap items-end justify-between gap-2">
            <div className="min-w-0">
              <h2 className="font-display text-base font-extrabold tracking-tight text-ink-900 dark:text-white sm:text-lg">
                {catalogHeading}
              </h2>
              <p className="text-[11px] text-ink-500 dark:text-ink-400">
                {filteredProducts.length} item{filteredProducts.length === 1 ? '' : 's'}
                {selectedState ? ` · ${selectedState}` : ' · across Nigeria'}
                {onlyVerified ? ' · verified sellers only' : ''}
                {dealsOnly ? ' · discounted only' : ''}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => onWishlistOnlyChange(!wishlistOnly)}
                aria-pressed={wishlistOnly}
                className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11px] font-bold transition-colors ${
                  wishlistOnly
                    ? 'border-jade-600 bg-jade-600 text-white'
                    : 'border-ink-200 bg-white text-ink-600 hover:border-jade-300 dark:border-ink-800 dark:bg-ink-900 dark:text-ink-300'
                }`}
              >
                <Heart className={`h-3.5 w-3.5 ${wishlistOnly ? 'fill-white' : ''}`} aria-hidden="true" />
                Wishlist
                {favorites.length > 0 && (
                  <span className={`rounded-full px-1 text-[10px] ${wishlistOnly ? 'bg-white/20' : 'bg-jade-500/10 text-jade-700 dark:text-jade-300'}`}>
                    {favorites.length}
                  </span>
                )}
              </button>

              <button
                type="button"
                onClick={() => setDealsOnly((v) => !v)}
                aria-pressed={dealsOnly}
                className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11px] font-bold transition-colors ${
                  dealsOnly
                    ? 'border-jade-600 bg-jade-600 text-white'
                    : 'border-ink-200 bg-white text-ink-600 hover:border-jade-300 dark:border-ink-800 dark:bg-ink-900 dark:text-ink-300'
                }`}
              >
                <Flame className={`h-3.5 w-3.5 ${dealsOnly ? 'fill-white' : 'text-gold-500'}`} aria-hidden="true" />
                Deals
              </button>

              <button
                type="button"
                onClick={() => setOnlyVerified((v) => !v)}
                aria-pressed={onlyVerified}
                className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11px] font-bold transition-colors ${
                  onlyVerified
                    ? 'border-jade-600 bg-jade-600 text-white'
                    : 'border-ink-200 bg-white text-ink-600 hover:border-jade-300 dark:border-ink-800 dark:bg-ink-900 dark:text-ink-300'
                }`}
              >
                <BadgeCheck className="h-3.5 w-3.5" aria-hidden="true" />
                Verified
              </button>

              <label className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-white px-2 py-1.5 text-[11px] font-bold text-ink-600 dark:border-ink-800 dark:bg-ink-900 dark:text-ink-300">
                <SlidersHorizontal className="h-3.5 w-3.5 text-ink-400" aria-hidden="true" />
                <select
                  aria-label="Sort listings"
                  value={sortMode}
                  onChange={(e) => setSortMode(e.target.value as SortMode)}
                  className="cursor-pointer bg-transparent pr-1 outline-none"
                >
                  <option value="smart">Recommended</option>
                  <option value="rating">Top rated</option>
                  <option value="price_asc">Price: low to high</option>
                  <option value="price_desc">Price: high to low</option>
                  <option value="newest">Newest</option>
                </select>
              </label>
            </div>
          </div>

          {filteredProducts.length === 0 ? (
            db.products.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-ink-300 bg-white dark:border-ink-700 dark:bg-ink-900">
                <EmptyState
                  state="empty-cart"
                  icon={<Store />}
                  title="The marketplace is just getting started"
                  description="No listings yet. Create an account to sell the first item — every order is protected by GoodSale escrow."
                  action={
                    <button
                      type="button"
                      onClick={() => onOpenAuth?.('register')}
                      className="inline-flex items-center gap-2 rounded-lg bg-jade-600 px-4 py-2 text-xs font-bold text-white transition-colors hover:bg-jade-700"
                    >
                      <ShoppingCart className="h-4 w-4" aria-hidden="true" />
                      List the first item
                    </button>
                  }
                />
              </div>
            ) : (
              <div className="rounded-2xl border border-ink-200 bg-white dark:border-ink-800 dark:bg-ink-900">
                <EmptyState
                  state="empty-search"
                  icon={<Heart />}
                  title={wishlistOnly ? 'Your wishlist is empty' : 'No products found'}
                  description={
                    wishlistOnly
                      ? 'Tap the heart on any listing to save it here.'
                      : 'Try loosening your search, location or category filters.'
                  }
                />
              </div>
            )
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-4 xl:grid-cols-5">
                {visibleProducts.map((product) => (
                  <ProductTile
                    key={product.id}
                    product={product}
                    rating={ratingOf(product.id)}
                    reviewCount={reviewCountOf(product.id)}
                    {...sellerProps(product.sellerId)}
                    sellerState={stateOf(product.sellerId)}
                    badge={activeFeaturedIds.has(product.id) ? 'featured' : null}
                    isFavorite={favorites.includes(product.id)}
                    onToggleFavorite={() => toggleFavorite(product.id)}
                    onSelect={() => onSelectProduct(product.id)}
                    onAdd={() => onAddToCart(product.id)}
                  />
                ))}
              </div>

              <div className="mt-4 flex flex-col items-center gap-2">
                {hasMore ? (
                  <button
                    type="button"
                    onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-4 py-2 text-[11px] font-bold text-ink-700 transition-colors hover:border-jade-400 hover:text-jade-700 dark:border-ink-800 dark:bg-ink-900 dark:text-ink-200"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    Show {Math.min(PAGE_SIZE, filteredProducts.length - visibleProducts.length)} more
                  </button>
                ) : null}
                <p className="text-[10px] text-ink-400">
                  Showing {visibleProducts.length} of {filteredProducts.length} listings
                  {sortMode === 'smart' ? ' · ranked by relevance' : ''}
                </p>
              </div>
            </>
          )}

          <AdSlot
            placement="SEARCH"
            onNavigate={onNavigate}
            state={selectedState}
            category={selectedCategory || searchQuery}
            className="mt-6"
          />
        </section>

        {/* ───────────────────── Auctions (only when live) ───────────────────── */}
        {auctions.length > 0 && (
          <section className="mt-6" aria-labelledby="live-auctions">
            <div className="mb-2.5 flex items-center gap-2">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-jade-500/10 text-jade-600 dark:text-jade-300">
                <Gavel className="h-4 w-4" aria-hidden="true" />
              </span>
              <h2 id="live-auctions" className="font-display text-base font-extrabold tracking-tight text-ink-900 dark:text-white sm:text-lg">
                Live auctions
              </h2>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-4 xl:grid-cols-5">
              {auctions.map((product) => {
                const auction = db.auctions.find((a) => a.productId === product.id);
                const bids = db.bids.filter((b) => b.auctionId === auction?.id);
                const highest = bids.length ? Math.max(...bids.map((b) => b.amount)) : auction?.startingBid || 0;
                return (
                  <button
                    key={product.id}
                    type="button"
                    onClick={() => onSelectProduct(product.id)}
                    className="group overflow-hidden rounded-xl border border-ink-150 bg-white text-left transition-colors hover:border-jade-500/40 dark:border-ink-800 dark:bg-ink-900 focus-ring"
                  >
                    <div className="relative aspect-square bg-ink-50 dark:bg-ink-950">
                      <SmartImage
                        src={product.images?.[0]}
                        alt={product.title}
                        seed={`auction-${product.id}`}
                        className="h-full w-full"
                        imgClassName="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04] motion-reduce:transition-none"
                      />
                      <span className="absolute left-1.5 top-1.5 rounded bg-jade-600 px-1.5 py-0.5 text-[10px] font-black text-white">
                        Live bid
                      </span>
                    </div>
                    <div className="space-y-1 p-2">
                      <h3 className="line-clamp-2 min-h-[2rem] text-[12px] font-semibold leading-4 text-ink-900 dark:text-ink-100">
                        {product.title}
                      </h3>
                      <p className="text-[13px] font-extrabold text-jade-700 dark:text-jade-300">
                        Highest {naira(highest)}
                      </p>
                      <p className="text-[10px] text-ink-400">{bids.length} bid{bids.length === 1 ? '' : 's'}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
