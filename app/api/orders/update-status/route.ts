import { callRustRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';

const ALLOWED = new Set(['SHIPPED', 'OUT_FOR_DELIVERY', 'CANCELLED']);

/**
 * Seller/admin updates order fulfillment status.
 * POST { orderId: number, status: 'SHIPPED' | 'OUT_FOR_DELIVERY' | 'CANCELLED' }
 */
export async function POST(req: NextRequest) {
  try {
    const ip = clientIpFromRequest(req);
    const limited = rateLimit(`order:status:${ip}`, 40, 60_000);
    if (!limited.allowed) {
      return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 });
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

    const body = await req.json();
    const orderId = Number(body.orderId);
    const status = String(body.status || '').toUpperCase();
    if (!orderId || !ALLOWED.has(status)) {
      return NextResponse.json({ success: false, error: 'Invalid orderId or status' }, { status: 400 });
    }

    const { data, error } = await callRustRpc(supabase, 'update_order_status', {
      p_order_id: orderId,
      p_status: status,
    });

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }

    return NextResponse.json({ success: true, data });
  } catch (error) {
    logger.error('Order status update failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Status update failed') },
      { status: 500 }
    );
  }
}
