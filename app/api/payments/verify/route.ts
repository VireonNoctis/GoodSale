import { NextRequest, NextResponse } from 'next/server';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';
import { reconcilePaystackPayment } from '@/lib/data/payments';
import { createServerSupabaseClient } from '@/lib/supabase/server';

/**
 * Verify a Paystack transaction server-side, then mark the related order paid.
 * POST { reference: string, orderId?: number }
 */
export async function POST(req: NextRequest) {
  try {
    const sessionClient = await createServerSupabaseClient();
    if (!sessionClient) {
      return NextResponse.json({ success: false, error: 'Authentication is not configured' }, { status: 503 });
    }
    const { data: { user }, error: userError } = await sessionClient.auth.getUser();
    const { data: { session } } = await sessionClient.auth.getSession();
    if (userError || !user || !session?.access_token) {
      return NextResponse.json({ success: false, error: 'Sign in to verify this payment' }, { status: 401 });
    }
    const rustBackend = process.env.RUST_BACKEND_URL?.trim().replace(/\/+$/, '');
    if (rustBackend) {
      const contentType = req.headers.get('content-type') || '';
      if (!contentType.toLowerCase().includes('application/json')) {
        return NextResponse.json({ success: false, error: 'A JSON payment reference is required' }, { status: 415 });
      }
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return NextResponse.json({ success: false, error: 'Invalid payment verification request' }, { status: 400 });
      }
      const upstream = await fetch(`${rustBackend}/v1/payments/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
          'x-real-ip': clientIpFromRequest(req),
        },
        body: JSON.stringify(body),
        cache: 'no-store',
      });
      const payload = await upstream.json().catch(() => ({
        success: false,
        error: 'Payment service returned an invalid response',
      }));
      const headers = new Headers();
      const retryAfter = upstream.headers.get('retry-after');
      const requestId = upstream.headers.get('x-request-id');
      if (retryAfter) headers.set('Retry-After', retryAfter);
      if (requestId) headers.set('X-Request-Id', requestId);
      return NextResponse.json(payload, { status: upstream.status, headers });
    }
    const ip = clientIpFromRequest(req);
    const limited = rateLimit(`paystack:verify:${ip}`, 20, 60_000);
    if (!limited.allowed) {
      return NextResponse.json(
        { success: false, error: 'Too many verification attempts' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(limited.retryAfterMs / 1000)) } }
      );
    }

    const body = await req.json();
    const reference = typeof body.reference === 'string' ? body.reference.trim() : '';
    const orderId = body.orderId != null ? Number(body.orderId) : null;
    const orderIds = Array.isArray(body.orderIds)
      ? body.orderIds.map((n: unknown) => Number(n)).filter((n: number) => Number.isFinite(n) && n > 0)
      : null;
    if (!reference || reference.length > 128) {
      return NextResponse.json({ success: false, error: 'Valid reference is required' }, { status: 400 });
    }

    const secret = process.env.PAYSTACK_SECRET_KEY;

    if (!secret) {
      return NextResponse.json(
        { success: false, error: 'Paystack is not configured. Add PAYSTACK_SECRET_KEY to enable payments.' },
        { status: 503 }
      );
    }

    const verifyRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
      }
    );

    const payload = await verifyRes.json();
    if (!verifyRes.ok || !payload?.status || payload?.data?.status !== 'success') {
      logger.warn('Paystack verification failed', {
        reference,
        status: payload?.data?.status,
      });
      return NextResponse.json(
        { success: false, error: 'Payment could not be verified' },
        { status: 402 }
      );
    }

    if (payload.data.reference !== reference || String(payload.data.currency || '').toUpperCase() !== 'NGN' ||
      !Number.isSafeInteger(Number(payload.data.amount)) || Number(payload.data.amount) <= 0) {
      return NextResponse.json({ success: false, error: 'Payment details do not match the verification request' }, { status: 400 });
    }

    const referenceOrderId = /^GS_(\d+)_/i.exec(reference)?.[1];
    const metadataPrimaryOrderId =
      Number(payload.data?.metadata?.order_id || payload.data?.metadata?.orderId || 0) || null;
    const metaOrderIdsRaw = String(payload.data?.metadata?.order_ids || '');
    const metadataOrderIds = new Set<number>();
    if (metaOrderIdsRaw) {
      metaOrderIdsRaw.split(',').map((value: string) => Number(value.trim()))
        .filter((id: number) => Number.isSafeInteger(id) && id > 0)
        .forEach((id: number) => metadataOrderIds.add(id));
    }
    if (
      referenceOrderId &&
      ((metadataPrimaryOrderId && metadataPrimaryOrderId !== Number(referenceOrderId)) ||
        (metaOrderIdsRaw && !metadataOrderIds.has(Number(referenceOrderId))))
    ) {
      return NextResponse.json({ success: false, error: 'Payment reference and order metadata do not match' }, { status: 400 });
    }
    const metaOrderId = metadataPrimaryOrderId || Number(referenceOrderId) || null;
    const trustedOrderIds = new Set<number>(metadataOrderIds);
    if (metaOrderId) trustedOrderIds.add(metaOrderId);
    if (referenceOrderId) trustedOrderIds.add(Number(referenceOrderId));

    if (
      (orderId && !trustedOrderIds.has(orderId)) ||
      (orderIds && orderIds.some((id: number) => !trustedOrderIds.has(id))) ||
      (referenceOrderId && !trustedOrderIds.has(Number(referenceOrderId)))
    ) {
      return NextResponse.json({ success: false, error: 'The supplied order does not match this payment reference' }, { status: 400 });
    }

    if (trustedOrderIds.size > 0) {
      const { data: profile, error: profileError } = await sessionClient
        .from('profiles')
        .select('id')
        .eq('auth_id', user.id)
        .maybeSingle();
      if (profileError || !profile?.id) {
        return NextResponse.json({ success: false, error: 'Could not verify the buyer account' }, { status: 403 });
      }
      const ids = [...trustedOrderIds];
      const { data: orders, error: orderError } = await sessionClient
        .from('orders')
        .select('id,buyer_id')
        .in('id', ids);
      if (
        orderError ||
        !orders ||
        orders.length !== ids.length ||
        orders.some((order) => Number(order.buyer_id) !== Number(profile.id))
      ) {
        return NextResponse.json({ success: false, error: 'This payment does not belong to the signed-in buyer' }, { status: 403 });
      }
    }

    const reconciliation = await reconcilePaystackPayment({
      orderId: metaOrderId,
      orderIds: trustedOrderIds.size > 0 ? [...trustedOrderIds] : null,
      reference: payload.data.reference,
      amountKobo: payload.data.amount,
      channel: payload.data.channel,
      customerEmail: payload.data.customer?.email,
    });

    return NextResponse.json({
      success: Boolean(reconciliation.reconciled),
      reconciliation,
      data: {
        status: payload.data.status,
        reference: payload.data.reference,
        amount: payload.data.amount,
        currency: payload.data.currency,
        paid_at: payload.data.paid_at,
        channel: payload.data.channel,
        customer: payload.data.customer?.email,
      },
    });
  } catch (error) {
    logger.error('Paystack verify error', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Verification failed') },
      { status: 500 }
    );
  }
}
