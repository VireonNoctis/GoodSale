import { callRustRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';

/** POST /api/deliveries/confirmation-code { deliveryId } — buyer-only reveal. */
export async function POST(req: NextRequest) {
  try {
    const limited = rateLimit(`delivery:code:${clientIpFromRequest(req)}`, 12, 60_000);
    if (!limited.allowed) {
      return NextResponse.json(
        { success: false, error: 'Too many code requests. Please wait a moment.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(limited.retryAfterMs / 1000)) } }
      );
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
    if (!deliveryId) {
      return NextResponse.json({ success: false, error: 'deliveryId is required' }, { status: 400 });
    }

    const { data, error } = await callRustRpc(supabase, 'delivery_generate_confirmation_code', {
      p_delivery_id: deliveryId,
    });

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 403 });
    }
    return NextResponse.json({ success: true, data });
  } catch (error) {
    logger.error('Delivery code generation failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not generate a confirmation code') },
      { status: 500 }
    );
  }
}
