import { callRustRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';

/** POST /api/rider/failed-attempt { deliveryId, reason } */
export async function POST(req: NextRequest) {
  try {
    const limited = rateLimit(`rider:attempt:${clientIpFromRequest(req)}`, 30, 60_000);
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
    const reason = String(body?.reason ?? '').trim().slice(0, 300);
    if (!Number.isFinite(deliveryId) || deliveryId <= 0 || !reason) {
      return NextResponse.json({ success: false, error: 'Delivery and reason are required' }, { status: 400 });
    }

    const { data, error } = await callRustRpc(supabase, 'rider_record_failed_attempt', {
      p_delivery_id: deliveryId,
      p_reason: reason,
    });
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 409 });
    }
    return NextResponse.json({ success: true, data });
  } catch (error) {
    logger.error('Rider failed attempt failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not record the attempt') },
      { status: 500 }
    );
  }
}
