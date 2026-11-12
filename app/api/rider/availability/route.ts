import { callRustRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';

/**
 * POST /api/rider/availability
 * { online, lat?, lng?, state?, city?, serviceStates? }
 */
export async function POST(req: NextRequest) {
  try {
    const limited = rateLimit(`rider:availability:${clientIpFromRequest(req)}`, 60, 60_000);
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
    if (!body || typeof body.online !== 'boolean') {
      return NextResponse.json({ success: false, error: 'Online state is required' }, { status: 400 });
    }
    const lat = body.lat != null ? Number(body.lat) : null;
    const lng = body.lng != null ? Number(body.lng) : null;
    if ((lat != null && !Number.isFinite(lat)) || (lng != null && !Number.isFinite(lng))) {
      return NextResponse.json({ success: false, error: 'Invalid coordinates' }, { status: 400 });
    }

    const { data, error } = await callRustRpc(supabase, 'rider_update_availability', {
      p_online: body.online,
      p_lat: lat,
      p_lng: lng,
      p_state: body.state ? String(body.state).slice(0, 80) : null,
      p_city: body.city ? String(body.city).slice(0, 80) : null,
      p_service_states: Array.isArray(body.serviceStates)
        ? body.serviceStates.map((s: unknown) => String(s).trim()).filter(Boolean).slice(0, 40)
        : null,
    });
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 403 });
    }
    return NextResponse.json({ success: true, data });
  } catch (error) {
    logger.error('Rider availability update failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not update availability') },
      { status: 500 }
    );
  }
}
