import { callRustRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';
import { DELIVERY_STATUSES, isDeliveryStatus } from '@/lib/delivery';

/**
 * POST /api/deliveries/status
 * { deliveryId, status, note?, failureReason? }
 *
 * The database function re-checks the caller's role and the allowed transition,
 * so a forged status or fee from the browser cannot take effect.
 */
export async function POST(req: NextRequest) {
  try {
    const limited = rateLimit(`delivery:status:${clientIpFromRequest(req)}`, 60, 60_000);
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
    const status = String(body?.status || '').toUpperCase();
    if (!deliveryId || !isDeliveryStatus(status)) {
      return NextResponse.json(
        { success: false, error: `status must be one of: ${DELIVERY_STATUSES.join(', ')}` },
        { status: 400 }
      );
    }
    if (status === 'DELIVERED') {
      return NextResponse.json(
        { success: false, error: 'Delivery is confirmed only with the buyer confirmation code.' },
        { status: 400 }
      );
    }

    const { data, error } = await callRustRpc(supabase, 'delivery_transition', {
      p_delivery_id: deliveryId,
      p_status: status,
      p_note: body?.note ? String(body.note).slice(0, 500) : null,
      p_failure_reason: body?.failureReason ? String(body.failureReason).slice(0, 500) : null,
    });

    if (error) {
      logger.warn('delivery_transition rejected', { error: error.message, deliveryId, status });
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: true, data });
  } catch (error) {
    logger.error('Delivery status update failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Delivery update failed') },
      { status: 500 }
    );
  }
}
