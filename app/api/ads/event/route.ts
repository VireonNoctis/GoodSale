import { callRustRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { logger, publicErrorMessage } from '@/lib/logger';
import { profileIdForAuth } from '@/lib/wallet/server';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';

/**
 * POST /api/ads/event
 * { adId, type: 'IMPRESSION' | 'CLICK', state?, city?, category? }
 * { adId, type: 'CONVERSION', orderId }
 *
 * Delivery counters are server-authoritative. Clicks are deduplicated per
 * IP/campaign, targeting is rechecked, and conversions require the signed-in
 * buyer to own the order. The order amount is read from the database.
 */
export async function POST(req: NextRequest) {
  try {
    const ip = clientIpFromRequest(req);
    const limited = rateLimit(`ads:event:${ip}`, 120, 60_000);
    if (!limited.allowed) {
      return NextResponse.json({ success: false, error: 'Too many ad events' }, { status: 429 });
    }

    const body = await req.json().catch(() => ({}));
    const adId = Number(body.adId);
    const type = String(body.type || '').toUpperCase();
    if (!Number.isInteger(adId) || adId <= 0) {
      return NextResponse.json({ success: false, error: 'Valid campaign required' }, { status: 400 });
    }
    if (!['IMPRESSION', 'CLICK', 'CONVERSION'].includes(type)) {
      return NextResponse.json({ success: false, error: 'Valid ad event required' }, { status: 400 });
    }

    const admin = createAdminClient();
    if (!admin) {
      return NextResponse.json({ success: false, error: 'Advertising service is not configured' }, { status: 503 });
    }

    let orderId: number | null = null;
    let orderValue = 0;
    let state = String(body.state || '').trim().slice(0, 80);
    let city = String(body.city || '').trim().slice(0, 80);
    let category = String(body.category || '').trim().slice(0, 80);

    if (type === 'CONVERSION') {
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
      const profileId = await profileIdForAuth(admin, user.id);
      if (!profileId) {
        return NextResponse.json({ success: false, error: 'Profile not found' }, { status: 404 });
      }
      orderId = Number(body.orderId);
      if (!Number.isInteger(orderId) || orderId <= 0) {
        return NextResponse.json({ success: false, error: 'Valid order required' }, { status: 400 });
      }
      const { data: order } = await admin
        .from('orders')
        .select('id,buyer_id,total_amount,status,delivery_city,delivery_state,product_id')
        .eq('id', orderId)
        .maybeSingle();
      if (!order || Number(order.buyer_id) !== profileId) {
        return NextResponse.json({ success: false, error: 'Order not found' }, { status: 404 });
      }
      if (!['PENDING', 'PENDING_BANK_TRANSFER', 'PAID_ESCROW', 'PARTIAL_DEPOSIT_PAID', 'SHIPPED', 'DELIVERED_SUCCESS'].includes(String(order.status))) {
        return NextResponse.json({ success: false, error: 'Order is not eligible for attribution' }, { status: 400 });
      }
      orderValue = Math.max(0, Number(order.total_amount) || 0);
      city = String(order.delivery_city || city);
      state = String(order.delivery_state || state);
      if (order.product_id) {
        const { data: product } = await admin
          .from('products')
          .select('category')
          .eq('id', order.product_id)
          .maybeSingle();
        category = String(product?.category || category);
      }
    }

    const bucket = Math.floor(
      Date.now() / (type === 'CLICK' ? 10 * 60_000 : type === 'CONVERSION' ? 86_400_000 : 60_000)
    );
    const dedupKey = createHash('sha256')
      .update(`${type}:${type === 'CONVERSION' ? orderId : ip}:${adId}:${bucket}`)
      .digest('hex');

    const { data, error } = await admin.rpc('record_sponsored_ad_event_v2', {
      p_ad_id: adId,
      p_event_type: type,
      p_dedup_key: dedupKey,
      p_state: state,
      p_city: city,
      p_category: category,
      p_order_id: orderId,
      p_order_value: orderValue,
    });

    if (error) {
      logger.warn('Ad event recording failed', { adId, type, error: error.message });
      return NextResponse.json({ success: false, error: 'Ad event could not be recorded' }, { status: 400 });
    }

    return NextResponse.json({
      success: Boolean(data?.success),
      deduplicated: Boolean(data?.deduplicated),
      reason: data?.reason || null,
    });
  } catch (error) {
    logger.error('Ad event error', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Ad event failed') },
      { status: 500 }
    );
  }
}
