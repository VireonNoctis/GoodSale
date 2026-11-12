import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';
import {
  getWalletProviderConfig,
  loadWalletSettings,
  profileIdForAuth,
  walletFundingReference,
} from '@/lib/wallet/server';

/** POST { amount } — create a Paystack wallet-funding intent. No funds credited. */
export async function POST(req: NextRequest) {
  try {
    const ip = clientIpFromRequest(req);
    const limited = rateLimit(`wallet:fund:${ip}`, 10, 60_000);
    if (!limited.allowed) {
      return NextResponse.json({ success: false, error: 'Too many funding attempts' }, { status: 429 });
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
    const rustBackend = process.env.RUST_BACKEND_URL?.trim().replace(/\\/+$/, '');
    if (rustBackend) {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
      const upstream = await fetch(`${rustBackend}/v1/wallet/fund/initialize`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
      });
      const payload = await upstream.json().catch(() => ({ success: false, error: 'Wallet service returned an invalid response' }));
      return NextResponse.json(payload, { status: upstream.status });
    }

    const provider = getWalletProviderConfig();
    if (!provider.fundingEnabled) {
      return NextResponse.json(
        {
          success: false,
          code: 'WALLET_FUNDING_UNAVAILABLE',
          error: 'Wallet funding is unavailable until Paystack is configured for this deployment.',
        },
        { status: 503 }
      );
    }

    const admin = createAdminClient();
    if (!admin) {
      return NextResponse.json({ success: false, error: 'Wallet service is not configured' }, { status: 503 });
    }

    const amount = Number(body.amount);
    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      Math.abs(Math.round(amount * 100) - amount * 100) > 0.001
    ) {
      return NextResponse.json({ success: false, error: 'Enter a valid amount' }, { status: 400 });
    }

    const settings = await loadWalletSettings(admin);
    if (amount < settings.funding_min) {
      return NextResponse.json(
        { success: false, error: `Minimum wallet funding is ₦${settings.funding_min.toLocaleString('en-NG')}` },
        { status: 400 }
      );
    }
    if (amount > settings.funding_max) {
      return NextResponse.json(
        { success: false, error: `Maximum wallet funding is ₦${settings.funding_max.toLocaleString('en-NG')}` },
        { status: 400 }
      );
    }

    const profileId = await profileIdForAuth(admin, user.id);
    if (!profileId) {
      return NextResponse.json({ success: false, error: 'Profile not found' }, { status: 404 });
    }
    const { data: account } = await admin
      .from('profiles')
      .select('is_suspended')
      .eq('id', profileId)
      .maybeSingle();
    if (account?.is_suspended) {
      return NextResponse.json(
        { success: false, error: 'This account is suspended and cannot fund a wallet' },
        { status: 403 }
      );
    }

    const reference = walletFundingReference(profileId);
    const { data: intent, error } = await admin
      .from('wallet_funding_intents')
      .insert({
        user_id: profileId,
        reference,
        provider: 'paystack',
        amount,
        currency: 'NGN',
        status: 'PENDING',
        metadata: { source: 'wallet', auth_user: user.id },
      })
      .select('id,reference,amount,currency,status')
      .single();

    if (error || !intent) {
      logger.warn('wallet funding intent insert failed', { error: error?.message });
      return NextResponse.json({ success: false, error: 'Could not create a funding request' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      reference,
      amount,
      currency: 'NGN',
      email: user.email,
      publicKey: process.env.NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY,
      intentId: intent.id,
      provider: 'paystack',
    });
  } catch (error) {
    logger.error('Wallet funding init error', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not start wallet funding') },
      { status: 500 }
    );
  }
}
