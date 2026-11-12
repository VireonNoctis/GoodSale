import { callRustRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';

/**
 * POST /api/deliveries/cancel { deliveryId, reason, action: 'CANCEL' | 'RETURN' }
 * Admin-only cancellation and return-to-seller handling.
 */
export async function POST(req: NextRequest) {
  try {
    const limited = rateLimit(`delivery:cancel:${clientIpFromRequest(req)}`, 20, 60_000);
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
    const reason = String(body?.reason || '').trim();
    const action = String(body?.action || 'CANCEL').toUpperCase();
    if (!deliveryId || !reason || !['CANCEL', 'RETURN'].includes(action)) {
      return NextResponse.json(
        { success: false, error: 'A delivery, reason and valid action are required' },
        { status: 400 }
      );
    }

    const { data, error } = await callRustRpc(supabase, 
      action === 'RETURN' ? 'delivery_initiate_return' : 'delivery_cancel',
      { p_delivery_id: deliveryId, p_reason: reason.slice(0, 500) }
    );

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 403 });
    }
    return NextResponse.json({ success: true, data });
  } catch (error) {
    logger.error('Delivery cancel/return failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not update delivery') },
      { status: 500 }
    );
  }
}
