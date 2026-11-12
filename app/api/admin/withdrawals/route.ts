import { callRustAdminRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';
import {
  createTransferRecipient,
  initiateTransfer,
  resolveAccountName,
  resolveBankCode,
} from '@/lib/payments/transfer';
import { sendTransactionalEmail, payoutApprovedEmailHtml } from '@/lib/email';

/**
 * POST { withdrawalId, approve, notes?, bankCode? } — admin payout review.
 *
 * Funds are already reserved when the seller requests a withdrawal. Approval
 * only CLAIMS the request and starts a Paystack transfer. The payout is not
 * marked successful here; only a signed Paystack transfer webhook can do that.
 * A provider failure reverses the reservation atomically.
 */
export async function POST(req: NextRequest) {
  try {
    const ip = clientIpFromRequest(req);
    const limited = rateLimit(`wallet:withdraw-admin:${ip}`, 30, 60_000);
    if (!limited.allowed) {
      return NextResponse.json({ success: false, error: 'Too many attempts' }, { status: 429 });
    }

    if (!process.env.PAYSTACK_SECRET_KEY) {
      return NextResponse.json(
        {
          success: false,
          code: 'PAYOUTS_UNAVAILABLE',
          error: 'Payouts are unavailable until PAYSTACK_SECRET_KEY is configured. No money has been sent.',
        },
        { status: 503 }
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

    const body = await req.json().catch(() => ({}));
    const withdrawalId = Number(body.withdrawalId);
    const approve = Boolean(body.approve);
    const notes = String(body.notes || '').trim();
    const bankCodeOverride = body.bankCode ? String(body.bankCode) : undefined;

    if (!Number.isInteger(withdrawalId) || withdrawalId <= 0) {
      return NextResponse.json({ success: false, error: 'withdrawalId required' }, { status: 400 });
    }

    const admin = createAdminClient();
    if (!admin) {
      return NextResponse.json({ success: false, error: 'Payout service is not configured' }, { status: 503 });
    }

    const { data: withdrawal, error: loadError } = await admin
      .from('withdrawal_requests')
      .select('*')
      .eq('id', withdrawalId)
      .maybeSingle();

    if (loadError || !withdrawal) {
      return NextResponse.json({ success: false, error: 'Withdrawal not found' }, { status: 404 });
    }

    if (!approve) {
      const { data, error } = await callRustAdminRpc(supabase, 'admin_payout_fail', {
        p_withdrawal_id: withdrawalId,
        p_reason: notes || 'Rejected by admin',
      });
      if (error) {
        logger.warn('admin_payout_fail failed', { error: error.message, withdrawalId });
        return NextResponse.json({ success: false, error: error.message }, { status: 400 });
      }
      return NextResponse.json({ success: true, status: 'FAILED', data });
    }

    if (withdrawal.status !== 'PENDING') {
      return NextResponse.json(
        { success: false, error: `Withdrawal is ${withdrawal.status} and cannot be started again` },
        { status: 409 }
      );
    }

    const bankCode = resolveBankCode(
      String(withdrawal.bank_name || ''),
      bankCodeOverride || withdrawal.bank_code
    );
    if (!bankCode) {
      return NextResponse.json(
        {
          success: false,
          error:
            'Could not resolve Paystack bank code. Pass bankCode (e.g. 058 for GTBank) or set PAYSTACK_DEFAULT_BANK_CODE.',
        },
        { status: 400 }
      );
    }

    const accountName = await resolveAccountName({
      accountNumber: String(withdrawal.account_number || ''),
      bankCode,
    });
    if (!accountName.ok) {
      return NextResponse.json(
        { success: false, error: accountName.error || 'Could not verify the bank account' },
        { status: 400 }
      );
    }

    const expected = String(withdrawal.account_name || '').trim().toLowerCase();
    const resolved = String(accountName.accountName || '').trim();
    if (expected && resolved && expected !== resolved.toLowerCase()) {
      return NextResponse.json(
        {
          success: false,
          error: `Account name mismatch. Paystack resolved "${resolved}". Update the seller bank details before paying out.`,
        },
        { status: 400 }
      );
    }

    const recipient = await createTransferRecipient({
      name: resolved || String(withdrawal.account_name || 'GoodSale Seller'),
      accountNumber: String(withdrawal.account_number || ''),
      bankCode,
    });
    if (!recipient.ok) {
      return NextResponse.json(
        { success: false, error: recipient.error || 'Failed to create transfer recipient' },
        { status: 400 }
      );
    }

    // Claim the request before moving money. A second concurrent approval loses.
    const { error: beginError } = await callRustAdminRpc(supabase, 'admin_payout_begin', {
      p_withdrawal_id: withdrawalId,
    });
    if (beginError) {
      return NextResponse.json({ success: false, error: beginError.message }, { status: 409 });
    }

    const netAmount = Number(withdrawal.net_amount ?? withdrawal.amount);
    const transferReference = `GS_WD_${withdrawalId}_${Date.now()}`;

    // Persist the reference BEFORE calling Paystack so a fast signed webhook
    // can still find the request and settle it. This does not mark it paid.
    const { error: referenceError } = await callRustAdminRpc(supabase, 'admin_payout_processing', {
      p_withdrawal_id: withdrawalId,
      p_transfer_code: null,
      p_provider_reference: transferReference,
      p_notes: notes,
    });
    if (referenceError) {
      await callRustAdminRpc(supabase, 'admin_payout_fail', {
        p_withdrawal_id: withdrawalId,
        p_reason: 'Could not store the payout reference before transfer',
      });
      return NextResponse.json(
        { success: false, error: 'Could not prepare the payout safely. Funds were returned to the seller.' },
        { status: 500 }
      );
    }

    const transfer = await initiateTransfer({
      amountNaira: netAmount,
      recipientCode: recipient.recipientCode!,
      reason: `GoodSale payout #${withdrawalId}`,
      reference: transferReference,
    });

    if (!transfer.ok) {
      const { error: failError } = await callRustAdminRpc(supabase, 'admin_payout_fail', {
        p_withdrawal_id: withdrawalId,
        p_reason: transfer.error || 'Paystack transfer could not be started',
      });
      if (failError) {
        logger.error('Could not reverse failed payout reservation', {
          withdrawalId,
          failError: failError.message,
        });
      }
      return NextResponse.json(
        {
          success: false,
          error: transfer.error || 'Paystack transfer failed. The reservation was returned to the seller.',
        },
        { status: 400 }
      );
    }

    const { error: processingError } = await callRustAdminRpc(supabase, 'admin_payout_processing', {
      p_withdrawal_id: withdrawalId,
      p_transfer_code: transfer.transferCode || null,
      p_provider_reference: transfer.reference || null,
      p_notes: notes,
    });

    if (processingError) {
      // The provider has the transfer; keep the reference on the row with the
      // service client so reconciliation is still possible.
      await admin
        .from('withdrawal_requests')
        .update({
          paystack_transfer_code: transfer.transferCode || null,
          paystack_reference: transfer.reference || null,
          admin_notes: notes || null,
        })
        .eq('id', withdrawalId);
      logger.warn('admin_payout_processing failed after provider transfer', {
        withdrawalId,
        error: processingError.message,
        reference: transfer.reference,
      });
    }

    await admin.from('audit_logs').insert({
      user_id: withdrawal.user_id,
      action: 'WITHDRAWAL_PROVIDER_STARTED',
      entity_type: 'WITHDRAWAL',
      entity_id: withdrawalId,
      details: `Paystack transfer ${transfer.reference || '—'} started after admin review. Provider confirmation still required.`,
    });

    const { data: profile } = await admin
      .from('profiles')
      .select('email')
      .eq('id', withdrawal.user_id)
      .maybeSingle();
    if (profile?.email) {
      await sendTransactionalEmail({
        to: profile.email,
        subject: 'GoodSale payout is processing',
        html: payoutApprovedEmailHtml(Number(withdrawal.amount), String(withdrawal.bank_name)),
        tags: ['payout'],
      });
    }

    return NextResponse.json({
      success: true,
      status: 'PROCESSING',
      providerConfirmed: false,
      message: 'Paystack accepted the transfer. The payout stays processing until the provider webhook confirms settlement.',
      transfer: {
        reference: transfer.reference,
        transferCode: transfer.transferCode,
        netAmount,
        fee: Number(withdrawal.fee || 0),
      },
    });
  } catch (error) {
    logger.error('Admin withdrawal error', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not process withdrawal') },
      { status: 500 }
    );
  }
}
