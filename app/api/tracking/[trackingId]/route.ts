import { callRustRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';
import { mapTrackingResult } from '@/lib/tracking';

export const dynamic = 'force-dynamic';

/** GET /api/tracking/:trackingId — tracking id, order number or courier number. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ trackingId: string }> }
) {
  try {
    const limited = rateLimit(`tracking:lookup:${clientIpFromRequest(req)}`, 45, 60_000);
    if (!limited.allowed) {
      return NextResponse.json(
        { success: false, error: 'Too many tracking requests. Please wait a moment.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(limited.retryAfterMs / 1000)) } }
      );
    }

    const { trackingId } = await params;
    let decoded = '';
    try {
      decoded = decodeURIComponent(String(trackingId || ''));
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid tracking ID.' }, { status: 400 });
    }
    const query = decoded.replace(/^#/, '').trim().slice(0, 64);
    if (query.length < 5) {
      return NextResponse.json(
        { success: false, error: 'Enter a valid GoodSale tracking ID.' },
        { status: 400 }
      );
    }

    const supabase = await createServerSupabaseClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: 'Supabase not configured' }, { status: 503 });
    }

    // The RPC is security-definer and decides redaction based on the caller's
    // session. Anonymous callers receive progress only — never addresses,
    // phone numbers, participant names or rider coordinates.
    const { data, error } = await callRustRpc(supabase, 'shipment_tracking_lookup', { p_query: query });
    if (error) {
      logger.warn('shipment_tracking_lookup failed', { error: error.message });
      return NextResponse.json({ success: false, error: 'Tracking lookup failed.' }, { status: 400 });
    }

    const payload = data as { found?: boolean } | null;
    if (!payload?.found) {
      return NextResponse.json(
        { success: false, error: 'No shipment matches that tracking ID.' },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { success: true, data: mapTrackingResult(payload as Record<string, unknown>) },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } }
    );
  } catch (error) {
    logger.error('Tracking lookup failed', { error: String(error) });
    return NextResponse.json({ success: false, error: 'Could not check this shipment.' }, { status: 500 });
  }
}
