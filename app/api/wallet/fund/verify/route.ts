import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';
import { creditVerifiedWalletFunding, profileIdForAuth } from '@/lib/wallet/server';

/** POST { reference } — verify with Paystack server-to-server, then credit once. */
export async function POST(req: NextRequest) {
  try {
    const ip = clientIpFromRequest(req);
    const limited = rateLimit(`wallet:fund-verify:${ip}`, 20, 60_000);
    if (!limited.allowed) {
      return NextResponse.json({ success: false, error: 'Too many verification attempts' }, { status: 429 });
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
    const reference = String(body?.reference || '').trim();
    if (!/^GSW_[0-9]+_[0-9]+_[A-Z0-9]{4,16}$/.test(reference)) {
      return NextResponse.json({ success: false, error: 'Valid payment reference required' }, { status: 400 });
    }

    const rustBackend = process.env.RUST_BACKEND_URL?.trim().replace(/\/+$/, '');
    if (rustBackend) {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
      }
      const upstream = await fetch(`${rustBackend}/v1/wallet/fund/verify`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference }),
        cache: 'no-store',
      });
      const payload = await upstream.json().catch(() => ({ success: false, error: 'Wallet service returned an invalid response' }));
      return NextResponse.json(payload, { status: upstream.status });
    }

    const admin = createAdminClient();
    if (!admin) {
      return NextResponse.json({ success: false, error: 'Wallet service is not configured' }, { status: 503 });
    }

    const { data: intent } = await admin
      .from('wallet_funding_intents')
      .select('id,user_id,reference')
      .eq('reference', reference)
      .maybeSingle();

    const profileId = await profileIdForAuth(admin, user.id);
    if (!intent || !profileId || Number(intent.user_id) !== profileId) {
      return NextResponse.json({ success: false, error: 'Funding request not found for this account' }, { status: 404 });
    }

    const result = await creditVerifiedWalletFunding(reference, null);
    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error }, { status: result.status });
    }

    const { data: wallet } = await admin
      .from('wallets')
      .select('balance')
      .eq('user_id', profileId)
      .maybeSingle();

    return NextResponse.json({
      success: true,
      alreadyCredited: result.alreadyCredited,
      reference,
      balance: Number(wallet?.balance || 0),
    });
  } catch (error) {
    logger.error('Wallet funding verify error', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not verify wallet funding') },
      { status: 500 }
    );
  }
}
