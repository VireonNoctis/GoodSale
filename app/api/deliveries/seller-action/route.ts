import { callRustRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';

const ACTIONS = new Set(['CONFIRM_AVAILABILITY', 'PREPARING', 'READY_FOR_PICKUP']);

/** POST /api/deliveries/seller-action { deliveryId, action } — seller only. */
export async function POST(req: NextRequest) {
  try {
    const limited = rateLimit(`delivery:seller:${clientIpFromRequest(req)}`, 40, 60_000);
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
    const action = String(body?.action || '').toUpperCase();
    if (!deliveryId || !ACTIONS.has(action)) {
      return NextResponse.json({ success: false, error: 'Invalid delivery or action' }, { status: 400 });
    }

    const { data, error } = await callRustRpc(supabase, 'delivery_seller_action', {
      p_delivery_id: deliveryId,
      p_action: action,
    });

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: true, data });
  } catch (error) {
    logger.error('Seller delivery action failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not update preparation') },
      { status: 500 }
    );
  }
}
