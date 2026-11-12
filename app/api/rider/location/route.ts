import { callRustRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';

/**
 * POST /api/rider/location
 * { action: 'SHARING', sharing, permission } or
 * { action: 'UPDATE', deliveryId, lat, lng, accuracyM?, speedKmh?, headingDegrees? }
 *
 * The database validates that the rider is approved, online, actively sharing,
 * assigned to this delivery and that the delivery is still active.
 */
export async function POST(req: NextRequest) {
  try {
    const limited = rateLimit(`rider:location:${clientIpFromRequest(req)}`, 240, 60_000);
    if (!limited.allowed) {
      return NextResponse.json({ success: false, error: 'Too many location updates' }, { status: 429 });
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
    const action = String(body?.action || '').toUpperCase();

    if (action === 'SHARING') {
      const permission = String(body?.permission || 'UNKNOWN').toUpperCase();
      if (!['GRANTED', 'DENIED', 'UNKNOWN'].includes(permission)) {
        return NextResponse.json({ success: false, error: 'Invalid location permission' }, { status: 400 });
      }
      const { data, error } = await callRustRpc(supabase, 'rider_set_location_sharing', {
        p_share: body?.sharing === true,
        p_permission: permission,
      });
      if (error) {
        return NextResponse.json({ success: false, error: error.message }, { status: 400 });
      }
      return NextResponse.json({ success: true, data });
    }

    if (action === 'UPDATE') {
      const deliveryId = Number(body?.deliveryId);
      const lat = Number(body?.lat);
      const lng = Number(body?.lng);
      if (!Number.isFinite(deliveryId) || deliveryId <= 0) {
        return NextResponse.json({ success: false, error: 'A delivery is required' }, { status: 400 });
      }
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return NextResponse.json({ success: false, error: 'A valid location is required' }, { status: 400 });
      }
      const optionalNumber = (value: unknown) => {
        if (value === null || value === undefined || value === '') return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
      };
      const { data, error } = await callRustRpc(supabase, 'rider_update_location', {
        p_delivery_id: deliveryId,
        p_lat: lat,
        p_lng: lng,
        p_accuracy_m: optionalNumber(body?.accuracyM),
        p_speed_kmh: optionalNumber(body?.speedKmh),
        p_heading_degrees: optionalNumber(body?.headingDegrees),
      });
      if (error) {
        return NextResponse.json({ success: false, error: error.message }, { status: 409 });
      }
      return NextResponse.json({ success: true, data });
    }

    return NextResponse.json({ success: false, error: 'Unknown location action' }, { status: 400 });
  } catch (error) {
    logger.error('Rider location update failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not update location') },
      { status: 500 }
    );
  }
}
