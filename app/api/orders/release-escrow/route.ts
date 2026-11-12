import { callRustRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';

/**
 * Buyer confirms delivery PIN and releases escrow to seller wallet.
 * POST { orderId: number, pin: string }
 */
export async function POST(req: NextRequest) {
  try {
    const ip = clientIpFromRequest(req);
    const limited = rateLimit(`escrow:release:${ip}`, 15, 60_000);
    if (!limited.allowed) {
      return NextResponse.json({ success: false, error: 'Too many attempts' }, { status: 429 });
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
    const pin = String(body.pin || '').trim();
    if (!orderId || !/^\d{4,8}$/.test(pin)) {
      return NextResponse.json({ success: false, error: 'Valid orderId and PIN required' }, { status: 400 });
    }

    const { data, error } = await callRustRpc(supabase, 'release_escrow_with_pin', {
      p_order_id: orderId,
      p_pin: pin,
    });

    if (error) {
      logger.warn('Escrow release failed', { error: error.message, orderId });
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }

    return NextResponse.json({ success: true, data });
  } catch (error) {
    logger.error('Escrow release error', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Escrow release failed') },
      { status: 500 }
    );
  }
}
