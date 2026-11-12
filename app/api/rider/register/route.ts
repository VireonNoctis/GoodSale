import { callRustRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';

/**
 * POST /api/rider/register
 * Creates or updates the signed-in buyer's rider application. The RPC sets the
 * RIDER account role and enforces that staff/seller accounts use a separate
 * account.
 */
export async function POST(req: NextRequest) {
  try {
    const limited = rateLimit(`rider:register:${clientIpFromRequest(req)}`, 10, 60_000);
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
      return NextResponse.json({ success: false, error: 'Invalid rider application' }, { status: 400 });
    }

    const payload = {
      full_name: String(body.fullName ?? '').trim().slice(0, 120),
      phone: String(body.phone ?? '').trim().slice(0, 40),
      email: String(body.email ?? '').trim().slice(0, 160),
      vehicle_type: String(body.vehicleType ?? 'MOTORCYCLE').toUpperCase(),
      brand: String(body.brand ?? '').trim().slice(0, 80),
      model: String(body.model ?? '').trim().slice(0, 80),
      plate_number: String(body.plateNumber ?? '').trim().toUpperCase().slice(0, 30),
      color: String(body.color ?? '').trim().slice(0, 40),
      year: body.year ? String(body.year).slice(0, 4) : '',
      capacity: String(body.capacity ?? '').trim().slice(0, 60),
      photo_url: String(body.photoUrl ?? '').slice(0, 500),
      address: String(body.address ?? '').trim().slice(0, 300),
      state: String(body.state ?? '').trim().slice(0, 80),
      city: String(body.city ?? '').trim().slice(0, 80),
      nin: String(body.nin ?? '').trim().slice(0, 40),
      selfie_url: String(body.selfieUrl ?? '').slice(0, 500),
      license_url: body.licenseUrl ? String(body.licenseUrl).slice(0, 500) : null,
      documents: Array.isArray(body.documents) ? body.documents.slice(0, 8) : [],
      emergency_contact_name: String(body.emergencyContactName ?? '').trim().slice(0, 120),
      emergency_contact_phone: String(body.emergencyContactPhone ?? '').trim().slice(0, 40),
      emergency_contact_relation: String(body.emergencyContactRelation ?? '').trim().slice(0, 60),
      service_states: Array.isArray(body.serviceStates)
        ? body.serviceStates.map((s: unknown) => String(s).trim()).filter(Boolean).slice(0, 40)
        : [],
    };

    const { data, error } = await callRustRpc(supabase, 'rider_apply', { p_payload: payload });
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: true, data });
  } catch (error) {
    logger.error('Rider application failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not submit rider application') },
      { status: 500 }
    );
  }
}
