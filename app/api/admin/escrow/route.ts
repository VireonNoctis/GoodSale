import { callRustAdminRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { initiatePaystackRefund } from '@/lib/data/payments';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';

/** POST { orderId, action: RELEASE_SELLER|REFUND_BUYER, notes? } — admin */
export async function POST(req: NextRequest) {
  try {
    const ip = clientIpFromRequest(req);
    const limited = rateLimit(`admin:escrow:${ip}`, 30, 60_000);
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
    const action = String(body.action || '');
    const notes = String(body.notes || '');

    if (!orderId || !['RELEASE_SELLER', 'REFUND_BUYER'].includes(action)) {
      return NextResponse.json({ success: false, error: 'Valid orderId and action required' }, { status: 400 });
    }

    const { data, error } = await callRustAdminRpc(supabase, 'admin_force_escrow', {
      p_order_id: orderId,
      p_action: action,
      p_notes: notes,
    });

    if (error) {
      logger.warn('admin_force_escrow failed', { error: error.message });
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }

    // When Paystack holds the original charge, return the money through the
    // provider and close the ledger row. Demo / bank transfers stay pending
    // for manual finance processing.
    let providerRefund: { success?: boolean } | null = null;
    if (action === 'REFUND_BUYER') {
      const admin = createAdminClient();
      const refundId = (data as { refund_id?: number } | null)?.refund_id;
      if (admin) {
        const { data: tx } = await admin
          .from('payment_transactions')
          .select('transaction_id, amount')
          .eq('order_id', orderId)
          .eq('status', 'SUCCESS')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (tx?.transaction_id && !String(tx.transaction_id).startsWith('DEMO_')) {
          providerRefund = await initiatePaystackRefund({
            transactionReference: String(tx.transaction_id).split('#')[0],
            amountKobo: Math.round(Number(tx.amount) * 100),
            reason: notes || 'Admin refund',
          });
          if (providerRefund?.success && refundId) {
            await callRustAdminRpc(supabase, 'mark_refund_completed', {
              p_refund_id: refundId,
              p_provider_reference:
                (providerRefund as { data?: { transaction_reference?: string } }).data?.transaction_reference ||
                tx.transaction_id,
            });
          }
        }
      }
    }

    return NextResponse.json({ success: true, data, providerRefund });
  } catch (error) {
    logger.error('Admin escrow error', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Admin escrow action failed') },
      { status: 500 }
    );
  }
}
