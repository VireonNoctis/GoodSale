import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger, publicErrorMessage } from '@/lib/logger';
import { profileIdForAuth } from '@/lib/wallet/server';
import { activateVerifiedPremiumPayment } from '@/lib/premium/server';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';

/**
 * POST /api/premium/subscriptions/verify { reference }
 *
 * Paystack is checked server-to-server, then the idempotent activation RPC runs.
 * A browser callback alone can never grant membership.
 */
export async function POST(req: NextRequest) {
  try {
    const ip = clientIpFromRequest(req);
    const limited = rateLimit(`premium:verify:${ip}`, 20, 60_000);
    if (!limited.allowed) {
      return NextResponse.json({ success: false, error: 'Too many verification attempts' }, { status: 429 });
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
    const reference = String(body?.reference || '').trim();
    if (!/^GSP_[0-9]+_[0-9]+_[A-Z0-9]{4,16}$/.test(reference)) {
      return NextResponse.json({ success: false, error: 'Valid payment reference required' }, { status: 400 });
    }

    const rustBackend = process.env.RUST_BACKEND_URL?.trim().replace(/\/+$/, '');
    if (rustBackend) {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
      }
      const upstream = await fetch(`${rustBackend}/v1/premium/subscriptions/verify`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference }),
        cache: 'no-store',
      });
      const payload = await upstream.json().catch(() => ({ success: false, error: 'Membership service returned an invalid response' }));
      return NextResponse.json(payload, { status: upstream.status });
    }

    const admin = createAdminClient();
    if (!admin) {
      return NextResponse.json({ success: false, error: 'Premium service is not configured' }, { status: 503 });
    }

    const profileId = await profileIdForAuth(admin, user.id);
    if (!profileId) {
      return NextResponse.json({ success: false, error: 'Profile not found' }, { status: 404 });
    }

    const { data: payment } = await admin
      .from('premium_subscription_payments')
      .select('id,user_id,status')
      .eq('reference', reference)
      .maybeSingle();
    if (!payment || Number(payment.user_id) !== profileId) {
      return NextResponse.json(
        { success: false, error: 'Membership payment not found for this account' },
        { status: 404 }
      );
    }

    const result = await activateVerifiedPremiumPayment(reference);
    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error }, { status: result.status });
    }

    return NextResponse.json({
      success: true,
      alreadyActive: result.alreadyActive,
      reference: result.reference,
      product: result.product,
      planCode: result.planCode,
      startsAt: result.startsAt,
      expiresAt: result.expiresAt,
    });
  } catch (error) {
    logger.error('Premium verify error', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not verify the membership payment') },
      { status: 500 }
    );
  }
}
