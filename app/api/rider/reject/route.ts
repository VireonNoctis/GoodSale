import { callRustRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';

/** POST /api/rider/reject { deliveryId, reason? } */
export async function POST(req: NextRequest) {
  try {
    const limited = rateLimit(`rider:reject:${clientIpFromRequest(req)}`, 40, 60_000);
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
    const body = await req.json().catch(() => null);
    const deliveryId = Number(body?.deliveryId);
    if (!Number.isFinite(deliveryId) || deliveryId <= 0) {
      return NextResponse.json({ success: false, error: 'A delivery is required' }, { status: 400 });
    }

    const { data, error } = await callRustRpc(supabase, 'rider_reject_delivery', {
      p_delivery_id: deliveryId,
      p_reason: body?.reason ? String(body.reason).trim().slice(0, 300) : null,
    });
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 409 });
    }
    return NextResponse.json({ success: true, data });
  } catch (error) {
    logger.error('Rider reject failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not decline delivery') },
      { status: 500 }
    );
  }
}
