import { callRustRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';
import { sendTransactionalEmail, disputeOpenedEmailHtml } from '@/lib/email';

/** POST { orderId, reason } — open escrow dispute */
export async function POST(req: NextRequest) {
  try {
    const ip = clientIpFromRequest(req);
    const limited = rateLimit(`dispute:open:${ip}`, 10, 60_000);
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
    const reason = String(body.reason || '').trim();
    if (!orderId || reason.length < 10) {
      return NextResponse.json(
        { success: false, error: 'Valid orderId and reason (10+ chars) required' },
        { status: 400 }
      );
    }

    const { data, error } = await callRustRpc(supabase, 'open_dispute', {
      p_order_id: orderId,
      p_reason: reason,
    });

    if (error) {
      logger.warn('open_dispute failed', { error: error.message, orderId });
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }

    const admin = createAdminClient();
    if (admin) {
      const { data: order } = await admin
        .from('orders')
        .select('order_number, buyer_id, seller_id')
        .eq('id', orderId)
        .maybeSingle();
      if (order) {
        const { data: profiles } = await admin
          .from('profiles')
          .select('id, email')
          .in('id', [order.buyer_id, order.seller_id].filter(Boolean));
        const html = disputeOpenedEmailHtml(String(order.order_number || orderId));
        for (const p of profiles || []) {
          if (p.email) {
            await sendTransactionalEmail({
              to: p.email,
              subject: `Dispute opened — order ${order.order_number}`,
              html,
              tags: ['dispute'],
            });
          }
        }
      }
    }

    return NextResponse.json({ success: true, data });
  } catch (error) {
    logger.error('Open dispute error', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not open dispute') },
      { status: 500 }
    );
  }
}
