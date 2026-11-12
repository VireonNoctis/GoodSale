import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { callRustAdminRpc } from '@/lib/server/rust-rpc';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimitAsync, clientIpFromRequest } from '@/lib/rate-limit';

async function adminContext() {
  const supabase = await createServerSupabaseClient();
  if (!supabase) return { error: 'Supabase not configured', status: 503 as const };
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Unauthorized', status: 401 as const };
  const { data: profile } = await supabase.from('profiles').select('id,role').eq('auth_id', user.id).maybeSingle();
  if (!profile || !['ADMIN', 'SUPER_ADMIN'].includes(String(profile.role))) {
    return { error: 'Admin only', status: 403 as const };
  }
  return { supabase, profile };
}

export async function GET() {
  try {
    const ctx = await adminContext();
    if ('error' in ctx) return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    const { data, error } = await callRustAdminRpc<Record<string, unknown>[]>(
      ctx.supabase,
      'admin_list_buyer_protection_claims',
    );
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: Number(error.code) || 503 });
    return NextResponse.json({ success: true, claims: data || [] });
  } catch (error) {
    logger.error('Admin protection claims failed', { error: String(error) });
    return NextResponse.json({ success: false, error: publicErrorMessage(error, 'Could not load claims') }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const limited = await rateLimitAsync(`admin:claims:${clientIpFromRequest(req)}`, 30, 60_000);
    if (!limited.allowed) return NextResponse.json({ success: false, error: 'Too many attempts' }, { status: limited.unavailable ? 503 : 429 });

    const ctx = await adminContext();
    if ('error' in ctx) return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });

    const body = await req.json().catch(() => null);
    const claimId = Number(body?.claimId);
    const status = String(body?.status || '').toUpperCase();
    const resolution = typeof body?.resolution === 'string' ? body.resolution.trim().slice(0, 1000) : '';
    if (!Number.isSafeInteger(claimId) || claimId <= 0 || !['REVIEWING', 'APPROVED', 'REJECTED', 'CLOSED'].includes(status)) {
      return NextResponse.json({ success: false, error: 'Valid claim decision required' }, { status: 400 });
    }
    if (['APPROVED', 'REJECTED'].includes(status) && resolution.length < 5) {
      return NextResponse.json({ success: false, error: 'Add a decision note' }, { status: 400 });
    }

    const { data, error } = await callRustAdminRpc<{ success: boolean; claimId: number }>(
      ctx.supabase,
      'admin_review_buyer_protection_claim',
      { p_claim_id: claimId, p_status: status, p_resolution: resolution },
    );
    if (error || !data?.success) {
      const message = error?.message || 'Could not update claim';
      return NextResponse.json({ success: false, error: message }, { status: /not found/i.test(message) ? 404 : Number(error?.code) || 400 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Admin claim decision failed', { error: String(error) });
    return NextResponse.json({ success: false, error: publicErrorMessage(error, 'Could not update claim') }, { status: 500 });
  }
}
