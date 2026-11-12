import { callRustAdminRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';

/**
 * POST /api/admin/delivery-settings
 * Admin-owned logistics settings. The RPC re-checks admin rights.
 */
export async function POST(req: NextRequest) {
  try {
    const limited = rateLimit(`admin:delivery-settings:${clientIpFromRequest(req)}`, 30, 60_000);
    if (!limited.allowed) {
      return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 });
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

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ success: false, error: 'Settings are required' }, { status: 400 });
    }

    const payload: Record<string, unknown> = {};
    const booleans = ['auto_assign_enabled'];
    const numbers = [
      'offer_timeout_minutes',
      'max_active_deliveries',
      'max_pickup_distance_km',
      'max_offers_per_delivery',
      'location_update_interval_seconds',
      'tracking_stale_minutes',
    ];
    for (const key of booleans) {
      if (typeof body[key] === 'boolean') payload[key] = body[key];
    }
    for (const key of numbers) {
      if (body[key] !== undefined && body[key] !== '') {
        const value = Number(body[key]);
        if (!Number.isFinite(value)) {
          return NextResponse.json({ success: false, error: `${key} must be a number` }, { status: 400 });
        }
        payload[key] = value;
      }
    }
    if (Object.keys(payload).length === 0) {
      return NextResponse.json({ success: false, error: 'No valid settings supplied' }, { status: 400 });
    }

    const { data, error } = await callRustAdminRpc(supabase, 'admin_set_delivery_settings', {
      p_payload: payload,
    });
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 403 });
    }
    return NextResponse.json({ success: true, data });
  } catch (error) {
    logger.error('Delivery settings update failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not save delivery settings') },
      { status: 500 }
    );
  }
}
