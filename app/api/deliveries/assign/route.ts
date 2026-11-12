import { callRustRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';

/**
 * POST /api/deliveries/assign
 * Admin assigns a GoodDispatch rider and/or an external courier + tracking number.
 * { deliveryId, riderId? , courierName?, trackingNumber?, estimatedDeliveryDate? }
 */
export async function POST(req: NextRequest) {
  try {
    const limited = rateLimit(`delivery:assign:${clientIpFromRequest(req)}`, 40, 60_000);
    if (!limited.allowed) {
      return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 });
    }

    const supabase = await createServerSupabaseClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: 'Supabase not configured' }, { status: 503 });
    }
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    const deliveryId = Number(body?.deliveryId);
    const riderId = body?.riderId != null ? Number(body.riderId) : null;
    const auto = body?.auto === true;
    const courierName = body?.courierName ? String(body.courierName).trim().slice(0, 120) : '';
    if (!deliveryId || (!riderId && !courierName && !auto)) {
      return NextResponse.json(
        { success: false, error: 'A delivery and either a rider, auto-match or courier name are required' },
        { status: 400 }
      );
    }

    if (auto) {
      const { data, error } = await callRustRpc(supabase, 'admin_auto_assign_delivery', {
        p_delivery_id: deliveryId,
      });
      if (error) {
        return NextResponse.json({ success: false, error: error.message }, { status: 403 });
      }
      return NextResponse.json({ success: true, data });
    }

    // Admin rights are enforced inside the RPCs.
    if (riderId) {
      const { data, error } = await callRustRpc(supabase, 'delivery_assign_rider', {
        p_delivery_id: deliveryId,
        p_rider_id: riderId,
      });
      if (error) {
        return NextResponse.json({ success: false, error: error.message }, { status: 403 });
      }
      return NextResponse.json({ success: true, data });
    }

    const estimated = body?.estimatedDeliveryDate ? String(body.estimatedDeliveryDate) : null;
    if (estimated && !/^\d{4}-\d{2}-\d{2}$/.test(estimated)) {
      return NextResponse.json(
        { success: false, error: 'Estimated date must use YYYY-MM-DD' },
        { status: 400 }
      );
    }

    const { data, error } = await callRustRpc(supabase, 'delivery_set_courier', {
      p_delivery_id: deliveryId,
      p_courier_name: courierName,
      p_tracking_number: body?.trackingNumber ? String(body.trackingNumber).trim().slice(0, 80) : '',
      p_estimated_delivery_date: estimated,
    });
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 403 });
    }
    return NextResponse.json({ success: true, data });
  } catch (error) {
    logger.error('Delivery assignment failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not assign delivery') },
      { status: 500 }
    );
  }
}
