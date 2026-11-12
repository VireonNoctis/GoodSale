import { callRustRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';

/** POST { amount, bankName, accountName, accountNumber } */
export async function POST(req: NextRequest) {
  try {
    const ip = clientIpFromRequest(req);
    const limited = rateLimit(`wallet:withdraw:${ip}`, 8, 60_000);
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
    const amount = Number(body.amount);
    const bankName = String(body.bankName || body.bank || '').trim();
    const accountName = String(body.accountName || body.name || '').trim();
    const accountNumber = String(body.accountNumber || body.number || '').trim();

    if (!Number.isFinite(amount) || amount < 1000 || !bankName || !accountName || !/^\d{10}$/.test(accountNumber)) {
      return NextResponse.json(
        {
          success: false,
          error: 'Valid amount (≥₦1000), bank name, account name, and 10-digit account number required',
        },
        { status: 400 }
      );
    }

    const { data, error } = await callRustRpc(supabase, 'request_withdrawal', {
      p_amount: amount,
      p_bank_name: bankName,
      p_account_name: accountName,
      p_account_number: accountNumber,
    });

    if (error) {
      logger.warn('request_withdrawal failed', { error: error.message });
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }

    return NextResponse.json({ success: true, data });
  } catch (error) {
    logger.error('Withdraw error', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Withdrawal failed') },
      { status: 500 }
    );
  }
}
