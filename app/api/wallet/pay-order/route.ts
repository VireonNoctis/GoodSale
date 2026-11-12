import { callRustRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';

/** POST { orderId } — atomically debit available wallet balance into escrow. */
export async function POST(req: NextRequest) {
  try {
    const ip = clientIpFromRequest(req);
    const limited = rateLimit(`wallet:pay-order:${ip}`, 15, 60_000);
    if (!limited.allowed) {
      return NextResponse.json({ success: false, error: 'Too many attempts' }, { status: 429 });
    }

    const supabase = await createServerSupabaseClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: 'Supabase not configured' }, { status: 503 });
    }
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const orderId = Number(body.orderId);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return NextResponse.json({ success: false, error: 'Valid order is required' }, { status: 400 });
    }

    const { data, error } = await callRustRpc(supabase, 'pay_order_with_wallet', {
      p_order_id: orderId,
    });

    if (error) {
      logger.warn('pay_order_with_wallet failed', { orderId, error: error.message });
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }

    return NextResponse.json({ success: true, data });
  } catch (error) {
    logger.error('Wallet order payment error', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not pay with wallet') },
      { status: 500 }
    );
  }
}
