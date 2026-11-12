import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { callRustRpc } from '@/lib/server/rust-rpc';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimitAsync, clientIpFromRequest } from '@/lib/rate-limit';

export async function GET() {
  try {
    const supabase = await createServerSupabaseClient();
    if (!supabase) return NextResponse.json({ success: false, error: 'Supabase not configured' }, { status: 503 });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

    const { data, error } = await callRustRpc<Record<string, unknown>[]>(
      supabase,
      'list_my_buyer_protection_claims',
    );
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: Number(error.code) || 503 });
    return NextResponse.json({ success: true, claims: data || [] });
  } catch (error) {
    logger.error('Protection claims lookup failed', { error: String(error) });
    return NextResponse.json({ success: false, error: publicErrorMessage(error, 'Could not load claims') }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const ip = clientIpFromRequest(req);
    const limited = await rateLimitAsync(`buyer:protect:${ip}`, 6, 60_000);
    if (!limited.allowed) return NextResponse.json({ success: false, error: 'Too many claim attempts' }, { status: limited.unavailable ? 503 : 429 });

    const supabase = await createServerSupabaseClient();
    if (!supabase) return NextResponse.json({ success: false, error: 'Supabase not configured' }, { status: 503 });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => null);
    const orderId = Number(body?.orderId);
    const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 1000) : '';
    if (!Number.isSafeInteger(orderId) || orderId <= 0 || reason.length < 15) {
      return NextResponse.json({ success: false, error: 'Order and a 15+ character claim reason are required' }, { status: 400 });
    }

    const { data, error } = await callRustRpc<{ id: number; reference: string; status: string; created_at: string }>(
      supabase,
      'open_my_buyer_protection_claim',
      { p_order_id: orderId, p_reason: reason },
    );
    if (error || !data) {
      const message = error?.message || 'Could not file claim';
      const status = /already under review/i.test(message) ? 409 :
        /not found|does not belong/i.test(message) ? 404 :
        /not purchased|not eligible/i.test(message) ? 400 : Number(error?.code) || 400;
      return NextResponse.json({ success: false, error: message }, { status });
    }
    return NextResponse.json({ success: true, claim: data });
  } catch (error) {
    logger.error('Protection claim failed', { error: String(error) });
    return NextResponse.json({ success: false, error: publicErrorMessage(error, 'Could not file claim') }, { status: 500 });
  }
}
