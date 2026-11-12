import { callRustAdminRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';
import { initiatePaystackRefund } from '@/lib/data/payments';

/** POST { disputeId, resolution: REFUND_BUYER|RELEASE_SELLER, notes? } — admin only */
export async function POST(req: NextRequest) {
  try {
    const ip = clientIpFromRequest(req);
    const limited = rateLimit(`dispute:resolve:${ip}`, 20, 60_000);
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
    const disputeId = Number(body.disputeId);
    const resolution = String(body.resolution || '');
    const notes = String(body.notes || body.adminNotes || '');
    if (!disputeId || !['REFUND_BUYER', 'RELEASE_SELLER'].includes(resolution)) {
      return NextResponse.json({ success: false, error: 'Valid disputeId and resolution required' }, { status: 400 });
    }

    const { data, error } = await callRustAdminRpc(supabase, 'resolve_dispute', {
      p_dispute_id: disputeId,
      p_resolution: resolution,
      p_admin_notes: notes,
    });

    if (error) {
      logger.warn('resolve_dispute failed', { error: error.message, disputeId });
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }

    // Attempt Paystack refund when ruling for buyer
    let paystackRefund: unknown = null;
    if (resolution === 'REFUND_BUYER') {
      const admin = createAdminClient();
      const refundId = (data as { refund_id?: number } | null)?.refund_id;
      if (admin && refundId) {
        const { data: dispute } = await admin
          .from('disputes')
          .select('order_id')
          .eq('id', disputeId)
          .maybeSingle();
        if (dispute?.order_id) {
          const { data: tx } = await admin
            .from('payment_transactions')
            .select('transaction_id, amount')
            .eq('order_id', dispute.order_id)
            .eq('status', 'SUCCESS')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          if (tx?.transaction_id && !String(tx.transaction_id).startsWith('DEMO_')) {
            paystackRefund = await initiatePaystackRefund({
              transactionReference: String(tx.transaction_id).split('#')[0],
              amountKobo: Math.round(Number(tx.amount) * 100),
              reason: notes || 'Dispute refund',
            });
            if ((paystackRefund as { success?: boolean })?.success) {
              await admin.rpc('mark_refund_completed', {
                p_refund_id: refundId,
                p_provider_reference:
                  (paystackRefund as { data?: { transaction_reference?: string } })?.data
                    ?.transaction_reference || tx.transaction_id,
              });
            }
          } else {
            // No verifiable Paystack transaction on record — leave the refund PENDING
            // for manual follow-up instead of marking it completed without a real provider reference.
            logger.warn('Refund left pending: no Paystack transaction on record', {
              refundId,
              orderId: dispute.order_id,
            });
          }
        }
      }
    }

    return NextResponse.json({ success: true, data, paystackRefund });
  } catch (error) {
    logger.error('Resolve dispute error', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not resolve dispute') },
      { status: 500 }
    );
  }
}
