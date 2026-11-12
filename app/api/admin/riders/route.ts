import { callRustAdminRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';

/**
 * POST /api/admin/riders
 * { action: 'REVIEW' | 'COMMISSION' | 'EARNING_STATUS' | 'ADJUST_EARNING', ... }
 * Admin rights are enforced inside each SECURITY DEFINER RPC.
 */
export async function POST(req: NextRequest) {
  try {
    const limited = rateLimit(`admin:riders:${clientIpFromRequest(req)}`, 80, 60_000);
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
    const action = String(body?.action ?? '').toUpperCase();

    if (action === 'EXPIRE') {
      const { data, error } = await callRustAdminRpc(supabase, 'expire_rider_assignments');
      if (error) return NextResponse.json({ success: false, error: error.message }, { status: 403 });
      return NextResponse.json({ success: true, data });
    }

    if (action === 'REVIEW') {
      const riderId = Number(body?.riderId);
      const status = String(body?.status ?? '').toUpperCase();
      if (!Number.isFinite(riderId) || !['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'].includes(status)) {
        return NextResponse.json({ success: false, error: 'Rider and status are required' }, { status: 400 });
      }
      const { data, error } = await callRustAdminRpc(supabase, 'admin_review_rider', {
        p_rider_id: riderId,
        p_status: status,
        p_reason: body?.reason ? String(body.reason).trim().slice(0, 400) : null,
      });
      if (error) return NextResponse.json({ success: false, error: error.message }, { status: 403 });
      return NextResponse.json({ success: true, data });
    }

    if (action === 'SERVICE_AREAS') {
      const riderId = Number(body?.riderId);
      if (!Number.isFinite(riderId)) {
        return NextResponse.json({ success: false, error: 'Rider is required' }, { status: 400 });
      }
      const states = Array.isArray(body?.states)
        ? body.states.map((s: unknown) => String(s).trim()).filter(Boolean).slice(0, 40)
        : [];
      const { data, error } = await callRustAdminRpc(supabase, 'admin_set_rider_service_areas', {
        p_rider_id: riderId,
        p_states: states,
        p_state: body?.state ? String(body.state).slice(0, 80) : null,
        p_city: body?.city ? String(body.city).slice(0, 80) : null,
      });
      if (error) return NextResponse.json({ success: false, error: error.message }, { status: 403 });
      return NextResponse.json({ success: true, data });
    }

    if (action === 'COMMISSION') {
      const riderId = Number(body?.riderId);
      const raw = body?.percentage;
      const percentage = raw === null || raw === undefined || raw === '' ? null : Number(raw);
      if (!Number.isFinite(riderId) || (percentage != null && (!Number.isFinite(percentage) || percentage < 0 || percentage > 100))) {
        return NextResponse.json({ success: false, error: 'Valid rider and percentage are required' }, { status: 400 });
      }
      const { data, error } = await callRustAdminRpc(supabase, 'admin_set_rider_commission', {
        p_rider_id: riderId,
        p_percentage: percentage,
      });
      if (error) return NextResponse.json({ success: false, error: error.message }, { status: 403 });
      return NextResponse.json({ success: true, data });
    }

    if (action === 'EARNING_STATUS') {
      const earningId = Number(body?.earningId);
      const status = String(body?.status ?? '').toUpperCase();
      if (!Number.isFinite(earningId) || !['PENDING', 'APPROVED', 'PAID', 'VOID'].includes(status)) {
        return NextResponse.json({ success: false, error: 'Earning and status are required' }, { status: 400 });
      }
      const { data, error } = await callRustAdminRpc(supabase, 'admin_set_rider_earning_status', {
        p_earning_id: earningId,
        p_status: status,
        p_payout_reference: body?.payoutReference ? String(body.payoutReference).trim().slice(0, 120) : '',
        p_notes: body?.notes ? String(body.notes).trim().slice(0, 400) : '',
      });
      if (error) return NextResponse.json({ success: false, error: error.message }, { status: 403 });
      return NextResponse.json({ success: true, data });
    }

    if (action === 'ADJUST_EARNING') {
      const earningId = Number(body?.earningId);
      const delta = Number(body?.delta);
      if (!Number.isFinite(earningId) || !Number.isFinite(delta) || delta === 0) {
        return NextResponse.json({ success: false, error: 'Earning and non-zero adjustment are required' }, { status: 400 });
      }
      const { data, error } = await callRustAdminRpc(supabase, 'admin_adjust_rider_earning', {
        p_earning_id: earningId,
        p_delta: delta,
        p_reason: body?.reason ? String(body.reason).trim().slice(0, 400) : '',
      });
      if (error) return NextResponse.json({ success: false, error: error.message }, { status: 403 });
      return NextResponse.json({ success: true, data });
    }

    return NextResponse.json({ success: false, error: 'Unknown rider action' }, { status: 400 });
  } catch (error) {
    logger.error('Admin rider action failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not update rider') },
      { status: 500 }
    );
  }
}
