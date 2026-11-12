import { callRustRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';

/**
 * POST /api/deliveries/confirm { deliveryId, code }
 * The assigned rider (or an authorized admin operator) submits the buyer's
 * one-time code. This never releases escrow.
 */
export async function POST(req: NextRequest) {
  try {
    const limited = rateLimit(`delivery:confirm:${clientIpFromRequest(req)}`, 10, 60_000);
    if (!limited.allowed) {
      return NextResponse.json(
        { success: false, error: 'Too many confirmation attempts. Wait and try again.' },
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
    const code = String(body?.code || '').trim();
    if (!deliveryId || !/^\d{4,8}$/.test(code)) {
      return NextResponse.json(
        { success: false, error: 'A valid delivery and confirmation code are required' },
        { status: 400 }
      );
    }

    const { data, error } = await callRustRpc(supabase, 'delivery_confirm_with_code', {
      p_delivery_id: deliveryId,
      p_code: code,
    });

    if (error) {
      logger.warn('delivery_confirm_with_code rejected', { error: error.message, deliveryId });
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    // Wrong codes return a payload (not an exception) so the attempt counter and
    // audit row are persisted for rate limiting.
    if (data && typeof data === 'object' && (data as { success?: boolean }).success === false) {
      return NextResponse.json(
        { success: false, error: (data as { error?: string }).error || 'Incorrect confirmation code' },
        { status: 400 }
      );
    }
    return NextResponse.json({ success: true, data });
  } catch (error) {
    logger.error('Delivery confirmation failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not confirm delivery') },
      { status: 500 }
    );
  }
}
