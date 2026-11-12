import { callRustRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger, publicErrorMessage } from '@/lib/logger';
import { profileIdForAuth } from '@/lib/wallet/server';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';

/**
 * POST /api/promotions/purchase
 * {
 *   featureType: 'FEATURED' | 'FLASH_SALE',
 *   productId, durationDays?, useCredits?,
 *   salePrice?, startsAt?, quantityLimit?
 * }
 *
 * The database re-checks ownership, eligibility, admin pricing, wallet balance
 * and available promotional credits. Flash Sales are submitted for moderation
 * and only change the product price after approval and at the scheduled start.
 */
export async function POST(req: NextRequest) {
  try {
    const ip = clientIpFromRequest(req);
    const limited = rateLimit(`promotions:purchase:${ip}`, 12, 60_000);
    if (!limited.allowed) {
      return NextResponse.json({ success: false, error: 'Too many promotion attempts' }, { status: 429 });
    }

    const supabase = await createServerSupabaseClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: 'Supabase not configured' }, { status: 503 });
    }
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const admin = createAdminClient();
    if (!admin) {
      return NextResponse.json({ success: false, error: 'Promotion service is not configured' }, { status: 503 });
    }

    const profileId = await profileIdForAuth(admin, user.id);
    if (!profileId) {
      return NextResponse.json({ success: false, error: 'Profile not found' }, { status: 404 });
    }

    const body = await req.json().catch(() => ({}));
    const productId = Number(body.productId);
    const featureType = String(body.featureType || '').toUpperCase();
    const durationDays = Number(body.durationDays ?? 7);
    const useCredits = body.useCredits !== false;

    if (!Number.isInteger(productId) || productId <= 0) {
      return NextResponse.json({ success: false, error: 'Choose a valid listing' }, { status: 400 });
    }
    if (featureType !== 'FEATURED' && featureType !== 'FLASH_SALE') {
      return NextResponse.json({ success: false, error: 'Choose a valid promotion type' }, { status: 400 });
    }

    let result;
    if (featureType === 'FEATURED') {
      result = await admin.rpc('purchase_featured_promotion', {
        p_user_id: profileId,
        p_product_id: productId,
        p_duration_days: Number.isInteger(durationDays) ? durationDays : 7,
        p_use_credits: useCredits,
      });
    } else {
      const salePrice = Number(body.salePrice);
      const startsAt = body.startsAt ? new Date(String(body.startsAt)) : null;
      const quantityLimit = body.quantityLimit == null ? null : Number(body.quantityLimit);
      if (!Number.isFinite(salePrice) || salePrice <= 0) {
        return NextResponse.json({ success: false, error: 'Enter the Flash Sale price' }, { status: 400 });
      }
      if (startsAt && Number.isNaN(startsAt.getTime())) {
        return NextResponse.json({ success: false, error: 'Choose a valid Flash Sale start time' }, { status: 400 });
      }
      if (quantityLimit != null && (!Number.isInteger(quantityLimit) || quantityLimit <= 0)) {
        return NextResponse.json({ success: false, error: 'Flash Sale quantity must be a positive whole number' }, { status: 400 });
      }

      result = await admin.rpc('purchase_flash_sale', {
        p_user_id: profileId,
        p_product_id: productId,
        p_sale_price: Math.round(salePrice),
        p_starts_at: startsAt ? startsAt.toISOString() : null,
        p_quantity_limit: quantityLimit,
        p_use_credits: useCredits,
      });
    }

    if (result.error) {
      logger.warn('Promotion purchase failed', {
        productId,
        featureType,
        error: result.error.message,
      });
      return NextResponse.json(
        { success: false, error: result.error.message || 'Promotion purchase failed' },
        { status: 400 }
      );
    }

    return NextResponse.json({ success: true, promotion: result.data });
  } catch (error) {
    logger.error('Promotion purchase error', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not buy this promotion') },
      { status: 500 }
    );
  }
}
