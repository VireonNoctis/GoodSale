import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { callRustRpc } from '@/lib/server/rust-rpc';
import { logger } from '@/lib/logger';

/** Redeems points in one locked Postgres transaction. */
export async function POST(request: Request) {
  try {
    const supabase = await createServerSupabaseClient();
    if (!supabase) return NextResponse.json({ success: false, error: 'Supabase not configured' }, { status: 503 });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

    const body = await request.json().catch(() => null);
    const cost = Number(body?.cost);
    const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 240) : 'Redeemed voucher reward';
    if (!Number.isInteger(cost) || cost <= 0 || cost > 100000) {
      return NextResponse.json({ success: false, error: 'Invalid redemption cost' }, { status: 400 });
    }

    const { data, error } = await callRustRpc<{ success: boolean; balance: number }>(
      supabase,
      'redeem_good_points',
      { p_cost: cost, p_reason: reason },
    );
    if (error || !data?.success) {
      const message = error?.message || 'Could not redeem reward';
      const status = /insufficient/i.test(message) ? 400 : Number(error?.code) || 400;
      return NextResponse.json({ success: false, error: message }, { status });
    }
    return NextResponse.json({ success: true, balance: Number(data.balance) });
  } catch (error) {
    logger.error('GoodPoints redemption failed', { error: String(error) });
    return NextResponse.json({ success: false, error: 'Could not redeem reward' }, { status: 500 });
  }
}
