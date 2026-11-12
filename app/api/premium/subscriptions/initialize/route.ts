import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger, publicErrorMessage } from '@/lib/logger';
import { profileIdForAuth, getWalletProviderConfig } from '@/lib/wallet/server';
import {
  BUSINESS_PLAN_CODES,
  loadPremiumPrice,
  premiumPaymentReference,
  type BusinessPlanCode,
  type PremiumProduct,
} from '@/lib/premium/server';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';

/**
 * POST /api/premium/subscriptions/initialize
 *
 * Creates a server-owned Paystack intent for Verified+ or Business Premium.
 * The price and duration come from the revenue settings row; no client amount
 * or plan price is trusted. No benefit is activated here.
 */
export async function POST(req: NextRequest) {
  try {
    const ip = clientIpFromRequest(req);
    const limited = rateLimit(`premium:initialize:${ip}`, 8, 60_000);
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

    const body = await req.json().catch(() => ({}));
    const rustBackend = process.env.RUST_BACKEND_URL?.trim().replace(/\\/+$/, '');
    if (rustBackend) {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
      const upstream = await fetch(`${rustBackend}/v1/premium/subscriptions/initialize`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
      });
      const payload = await upstream.json().catch(() => ({ success: false, error: 'Membership service returned an invalid response' }));
      return NextResponse.json(payload, { status: upstream.status });
    }

    const provider = getWalletProviderConfig();
    if (!provider.fundingEnabled) {
      return NextResponse.json(
        {
          success: false,
          code: 'PREMIUM_CHECKOUT_UNAVAILABLE',
          error: 'Membership checkout is unavailable until Paystack is configured for this deployment.',
        },
        { status: 503 }
      );
    }

    const admin = createAdminClient();
    if (!admin) {
      return NextResponse.json({ success: false, error: 'Premium service is not configured' }, { status: 503 });
    }

    const product = String(body.product || '').toUpperCase() as PremiumProduct;
    if (product !== 'VERIFIED_PLUS' && product !== 'BUSINESS') {
      return NextResponse.json({ success: false, error: 'Choose a valid membership' }, { status: 400 });
    }

    const planCode = product === 'BUSINESS' ? String(body.planCode || '').toUpperCase() : 'VERIFIED_PLUS';
    if (product === 'BUSINESS' && !BUSINESS_PLAN_CODES.includes(planCode as BusinessPlanCode)) {
      return NextResponse.json({ success: false, error: 'Choose a valid Business plan' }, { status: 400 });
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
        { success: false, error: 'This account is suspended and cannot buy a membership' },
        { status: 403 }
      );
    }

    const pricing = await loadPremiumPrice(admin, product, planCode);
    if ('error' in pricing) {
      return NextResponse.json({ success: false, error: pricing.error }, { status: 409 });
    }

    // Reuse a very recent unpaid intent for the same exact product. This keeps
    // double-clicks from manufacturing parallel checkout windows.
    const recentCutoff = new Date(Date.now() - 15 * 60_000).toISOString();
    const { data: recent } = await admin
      .from('premium_subscription_payments')
      .select('reference,amount,amount_kobo,duration_days,currency,plan_code')
      .eq('user_id', profileId)
      .eq('product', product)
      .eq('plan_code', planCode)
      .eq('status', 'PENDING')
      .gte('created_at', recentCutoff)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (
      recent &&
      Number(recent.amount_kobo ?? Math.round(Number(recent.amount) * 100)) === pricing.amountKobo &&
      String(recent.currency) === 'NGN'
    ) {
      return NextResponse.json({
        success: true,
        reference: recent.reference,
        amount: pricing.amount,
        amountKobo: pricing.amountKobo,
        currency: 'NGN',
        durationDays: Number(recent.duration_days || pricing.durationDays),
        email: user.email,
        publicKey: process.env.NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY,
        product,
        planCode: String(recent.plan_code),
        provider: 'paystack',
      });
    }

    const reference = premiumPaymentReference(profileId);
    const { data: intent, error } = await admin
      .from('premium_subscription_payments')
      .insert({
        user_id: profileId,
        product,
        plan_code: planCode,
        reference,
        amount: pricing.amount,
        amount_kobo: pricing.amountKobo,
        duration_days: pricing.durationDays,
        currency: 'NGN',
        status: 'PENDING',
        provider: 'paystack',
      })
      .select('id,reference,amount,amount_kobo,duration_days,currency,plan_code')
      .single();

    if (error || !intent) {
      logger.warn('Premium payment intent insert failed', { error: error?.message });
      return NextResponse.json(
        { success: false, error: 'Could not create the membership checkout' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      reference,
      amount: pricing.amount,
      amountKobo: pricing.amountKobo,
      currency: 'NGN',
      durationDays: Number(intent.duration_days || pricing.durationDays),
      email: user.email,
      publicKey: process.env.NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY,
      product,
      planCode,
      paymentId: intent.id,
      provider: 'paystack',
    });
  } catch (error) {
    logger.error('Premium initialize error', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not start membership checkout') },
      { status: 500 }
    );
  }
}
