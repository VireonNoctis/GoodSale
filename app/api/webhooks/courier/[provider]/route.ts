import { callRustInternalRpc, callRustJob } from '@/lib/server/rust-rpc';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getCourierApiConfig } from '@/lib/shipping/couriers';
import { logger } from '@/lib/logger';

/**
 * POST /api/webhooks/courier/:provider
 *
 * Generic courier webhook contract:
 * {
 *   eventId, trackingNumber, status, occurredAt?, note?, location?, reasonCode?
 * }
 *
 * Signature: x-goodsale-signature = hex HMAC-SHA256 of
 *   `${x-goodsale-timestamp}.${rawBody}` when a timestamp header is present,
 *   otherwise of the raw body. COURIER_WEBHOOK_SECRET is required.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ provider: string }> }
) {
  try {
    const config = getCourierApiConfig();
    if (!config || !config.webhookSecret) {
      return NextResponse.json(
        { success: false, error: 'Courier webhook is not configured' },
        { status: 503 }
      );
    }
    const { provider } = await context.params;
    if (String(provider || '').toLowerCase() !== config.provider) {
      return NextResponse.json({ success: false, error: 'Unknown courier provider' }, { status: 404 });
    }

    const raw = await req.text();
    if (!raw || raw.length > 256_000) {
      return NextResponse.json({ success: false, error: 'Invalid webhook payload' }, { status: 400 });
    }
    const signature = req.headers.get('x-goodsale-signature') || '';
    const timestamp = req.headers.get('x-goodsale-timestamp') || '';
    if (!signature) {
      return NextResponse.json({ success: false, error: 'Missing signature' }, { status: 401 });
    }
    if (timestamp) {
      const age = Math.abs(Date.now() - Number(timestamp));
      if (!Number.isFinite(age) || age > 5 * 60_000) {
        return NextResponse.json({ success: false, error: 'Stale webhook timestamp' }, { status: 401 });
      }
    }
    const signed = timestamp ? `${timestamp}.${raw}` : raw;
    const expected = createHmac('sha256', config.webhookSecret).update(signed).digest('hex');
    const provided = signature.replace(/^sha256=/, '').trim().toLowerCase();
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(provided, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      logger.warn('Courier webhook signature rejected', { provider });
      return NextResponse.json({ success: false, error: 'Invalid signature' }, { status: 401 });
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
    }

    const trackingNumber = String(payload.trackingNumber || payload.tracking_number || '').trim();
    const status = String(payload.status || '').trim();
    const eventId =
      String(payload.eventId || payload.event_id || '').trim() ||
      createHash('sha256').update(raw).digest('hex');
    if (!trackingNumber || !status) {
      return NextResponse.json(
        { success: false, error: 'trackingNumber and status are required' },
        { status: 400 }
      );
    }

    const service = createAdminClient();
    if (!service) {
      return NextResponse.json({ success: false, error: 'Server database is not configured' }, { status: 503 });
    }

    const { data, error } = await callRustInternalRpc('courier_apply_tracking_event', {
      p_provider: config.provider,
      p_event_id: eventId,
      p_tracking_number: trackingNumber,
      p_status: status,
      p_note: payload.note ? String(payload.note).slice(0, 500) : '',
      p_occurred_at: payload.occurredAt ? String(payload.occurredAt) : new Date().toISOString(),
      p_payload_hash: createHash('sha256').update(raw).digest('hex'),
      p_reason_code: payload.reasonCode ? String(payload.reasonCode).toUpperCase().slice(0, 40) : 'OTHER',
      p_location: payload.location ? String(payload.location).slice(0, 200) : '',
      p_payload: payload,
    });
    if (error) {
      logger.error('Courier webhook processing failed', { error: error.message, provider });
      return NextResponse.json({ success: false, error: 'Webhook could not be processed' }, { status: 500 });
    }
    return NextResponse.json({ success: true, data });
  } catch (error) {
    logger.error('Courier webhook failed', { error: String(error) });
    return NextResponse.json({ success: false, error: 'Webhook failed' }, { status: 500 });
  }
}
