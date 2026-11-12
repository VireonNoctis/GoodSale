import { callRustInternalRpc, callRustJob } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { logger, publicErrorMessage } from '@/lib/logger';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Paystack webhook receiver.
 * Configure: https://your-domain/api/payments/webhook
 */
export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get('x-paystack-signature') || '';
    const secret = process.env.PAYSTACK_WEBHOOK_SECRET || process.env.PAYSTACK_SECRET_KEY;

    if (!secret) {
      logger.error('Paystack webhook received but no secret configured');
      return NextResponse.json({ success: false, error: 'Webhook not configured' }, { status: 503 });
    }

    const hash = createHmac('sha512', secret).update(rawBody).digest('hex');
    const hashBuf = Buffer.from(hash);
    const sigBuf = Buffer.from(signature);

    if (hashBuf.length !== sigBuf.length || !timingSafeEqual(hashBuf, sigBuf)) {
      logger.warn('Invalid Paystack webhook signature');
      return NextResponse.json({ success: false, error: 'Invalid signature' }, { status: 401 });
    }

    const event = JSON.parse(rawBody);
    logger.info('Paystack webhook event', {
      event: event?.event,
      reference: event?.data?.reference,
    });

    if (event?.event === 'charge.success' && event?.data?.status === 'success') {
      const reference = String(event.data?.reference || '').trim();
      const walletFundingId = Number(event.data?.metadata?.wallet_funding_id || 0) || null;

      // Premium memberships are activated only from this signed event or a
      // server-to-server verify call — never from the browser callback.
      if (reference.startsWith('GSP_')) {
        const premium = await callRustInternalRpc('premium_activation_event', { reference });
        return NextResponse.json({ success: premium.success, received: true, premium });
      }

      // Wallet funding is credited only after the signed event, amount and
      // intent identity are checked against the funding record.
      if (walletFundingId || reference.startsWith('GSW_')) {
        const funding = await callRustInternalRpc('wallet_funding_event', { reference });
        return NextResponse.json({ success: funding.success, received: true, funding });
      }

      const reconciliation = await callRustInternalRpc('order_payment_event', { reference });
      return NextResponse.json({
        success: !reconciliation.error,
        received: true,
        reconciliation: reconciliation.data,
        ...(reconciliation.error ? { error: reconciliation.error.message } : {}),
      });
    }

    // Payout settlement: only the provider can mark a transfer successful.
    if (event?.event === 'transfer.success' || event?.event === 'transfer.failed' || event?.event === 'transfer.reversed') {
      const admin = createAdminClient();
      if (!admin) {
        return NextResponse.json({ success: false, error: 'Wallet service is not configured' }, { status: 503 });
      }
      const providerReference = String(event.data?.reference || '').trim();
      const transferCode = String(event.data?.transfer_code || '').trim();

      let withdrawal: { id: number; status: string } | null = null;
      if (providerReference) {
        const { data } = await admin
          .from('withdrawal_requests')
          .select('id,status')
          .eq('paystack_reference', providerReference)
          .maybeSingle();
        withdrawal = data;
      }
      if (!withdrawal && transferCode) {
        const { data } = await admin
          .from('withdrawal_requests')
          .select('id,status')
          .eq('paystack_transfer_code', transferCode)
          .maybeSingle();
        withdrawal = data;
      }

      if (!withdrawal) {
        logger.warn('Paystack transfer webhook has no matching withdrawal', { providerReference, transferCode });
        return NextResponse.json({ success: true, received: true, ignored: true });
      }

      if (event.event === 'transfer.success') {
        const { error } = await callRustInternalRpc('admin_payout_complete', {
          p_withdrawal_id: withdrawal.id,
          p_provider_reference: providerReference || transferCode,
        });
        if (error) logger.warn('Payout completion failed', { error: error.message, id: withdrawal.id });
        return NextResponse.json({ success: !error, received: true });
      }

      const reason =
        event.event === 'transfer.reversed'
          ? 'Paystack reversed the transfer'
          : String(event.data?.reason || event.data?.gateway_response || 'Paystack transfer failed');
      const { error } = await callRustInternalRpc('admin_payout_fail', {
        p_withdrawal_id: withdrawal.id,
        p_reason: reason,
      });
      if (error) logger.warn('Payout failure reversal failed', { error: error.message, id: withdrawal.id });
      return NextResponse.json({ success: !error, received: true });
    }

    // Refund-to-original-method status. Wallet refunds are credited by the
    // admin-only RPC and never by a webhook.
    if (event?.event === 'refund.processed' || event?.event === 'refund.failed') {
      const admin = createAdminClient();
      if (!admin) {
        return NextResponse.json({ success: false, error: 'Wallet service is not configured' }, { status: 503 });
      }
      const refundReference = String(event.data?.transaction_reference || event.data?.reference || '').trim();
      const providerRef = String(event.data?.refund_reference || event.data?.reference || '').trim();
      if (refundReference || providerRef) {
        const { data: refund } = await admin
          .from('refunds')
          .select('id,order_id,status,provider_reference')
          .or(`transaction_id.eq.${refundReference},provider_reference.eq.${providerRef}`)
          .maybeSingle();
        if (refund) {
          const status = event.event === 'refund.processed' ? 'COMPLETED' : 'FAILED';
          await admin.from('refunds').update({ status }).eq('id', refund.id);
          const { data: order } = await admin
            .from('orders')
            .select('buyer_id')
            .eq('id', refund.order_id)
            .maybeSingle();
          if (order?.buyer_id) {
            await admin.from('notifications').insert({
              user_id: order.buyer_id,
              title: event.event === 'refund.processed' ? 'Refund completed' : 'Refund failed',
              message:
                event.event === 'refund.processed'
                  ? 'Paystack completed your refund to the original payment method.'
                  : 'Paystack could not complete your refund. Support will review it.',
              type: 'WALLET',
              is_read: false,
            });
          }
        }
      }
      return NextResponse.json({ success: true, received: true });
    }

    return NextResponse.json({ success: true, received: true });
  } catch (error) {
    logger.error('Paystack webhook error', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Webhook failed') },
      { status: 500 }
    );
  }
}
