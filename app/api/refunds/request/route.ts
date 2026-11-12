import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { callRustRpc } from '@/lib/server/rust-rpc';
import { logger } from '@/lib/logger';

/** Buyer refund requests are verified and persisted atomically by Postgres. */
export async function POST(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient();
    if (!supabase) return NextResponse.json({ success: false, error: 'Supabase not configured' }, { status: 503 });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => null);
    const orderId = Number(body?.orderId);
    const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 1000) : '';
    if (!Number.isInteger(orderId) || orderId <= 0 || reason.length < 10) {
      return NextResponse.json({ success: false, error: 'Order and a 10+ character reason are required' }, { status: 400 });
    }

    const { data, error } = await callRustRpc<{ success: boolean; refundId: number; reference: string }>(
      supabase,
      'request_order_refund',
      { p_order_id: orderId, p_reason: reason },
    );
    if (error || !data?.success) {
      const message = error?.message || 'Could not request refund';
      const status = /already under review/i.test(message) ? 409 :
        /only the buyer/i.test(message) ? 403 :
        /not found/i.test(message) ? 404 :
        /not eligible/i.test(message) ? 400 : Number(error?.code) || 400;
      return NextResponse.json({ success: false, error: message }, { status });
    }
    return NextResponse.json({ success: true, refundId: data.refundId });
  } catch (error) {
    logger.error('Refund request error', { error: String(error) });
    return NextResponse.json({ success: false, error: 'Could not request refund' }, { status: 500 });
  }
}
