import { callRustRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';

/**
 * POST /api/deliveries/failure
 * REPORT { deliveryId, reasonCode, note }
 * RESOLVE { failureId, resolution, note, rescheduleDate? }
 * RETURN_UPDATE { returnId, status, note }
 *
 * RLS/RPC checks decide who may report; only admins may resolve.
 */
export async function POST(req: NextRequest) {
  try {
    const limited = rateLimit(`delivery:failure:${clientIpFromRequest(req)}`, 60, 60_000);
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
    const action = String(body?.action || '').toUpperCase();

    if (action === 'REPORT') {
      const deliveryId = Number(body?.deliveryId);
      if (!Number.isFinite(deliveryId) || deliveryId <= 0) {
        return NextResponse.json({ success: false, error: 'A delivery is required' }, { status: 400 });
      }
      const { data, error } = await callRustRpc(supabase, 'delivery_report_failure', {
        p_delivery_id: deliveryId,
        p_reason_code: String(body?.reasonCode || 'OTHER').toUpperCase().slice(0, 40),
        p_note: body?.note ? String(body.note).trim().slice(0, 1000) : '',
      });
      if (error) {
        return NextResponse.json({ success: false, error: error.message }, { status: 403 });
      }
      return NextResponse.json({ success: true, data });
    }

    if (action === 'RESOLVE') {
      const failureId = Number(body?.failureId);
      const resolution = String(body?.resolution || '').toUpperCase();
      if (!Number.isFinite(failureId) || failureId <= 0) {
        return NextResponse.json({ success: false, error: 'A failure record is required' }, { status: 400 });
      }
      if (!['REASSIGN', 'RESCHEDULE', 'RETURN', 'CANCEL', 'REFUND_REQUESTED', 'RESOLVE'].includes(resolution)) {
        return NextResponse.json({ success: false, error: 'Invalid resolution' }, { status: 400 });
      }
      const rescheduleDate = body?.rescheduleDate ? String(body.rescheduleDate) : null;
      if (rescheduleDate && !/^\d{4}-\d{2}-\d{2}$/.test(rescheduleDate)) {
        return NextResponse.json({ success: false, error: 'Reschedule date must use YYYY-MM-DD' }, { status: 400 });
      }
      const { data, error } = await callRustRpc(supabase, 'admin_resolve_delivery_failure', {
        p_failure_id: failureId,
        p_resolution: resolution,
        p_note: body?.note ? String(body.note).trim().slice(0, 1000) : '',
        p_reschedule_date: rescheduleDate,
      });
      if (error) {
        return NextResponse.json({ success: false, error: error.message }, { status: 403 });
      }
      return NextResponse.json({ success: true, data });
    }

    if (action === 'RETURN_UPDATE') {
      const returnId = Number(body?.returnId);
      const status = String(body?.status || '').toUpperCase();
      if (!Number.isFinite(returnId) || !['INITIATED', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED'].includes(status)) {
        return NextResponse.json({ success: false, error: 'A valid return and status are required' }, { status: 400 });
      }
      const { data, error } = await callRustRpc(supabase, 'admin_update_delivery_return', {
        p_return_id: returnId,
        p_status: status,
        p_note: body?.note ? String(body.note).trim().slice(0, 1000) : '',
      });
      if (error) {
        return NextResponse.json({ success: false, error: error.message }, { status: 403 });
      }
      return NextResponse.json({ success: true, data });
    }

    return NextResponse.json({ success: false, error: 'Unknown failure action' }, { status: 400 });
  } catch (error) {
    logger.error('Delivery failure action failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not process delivery issue') },
      { status: 500 }
    );
  }
}
