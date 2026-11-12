import { callRustAdminRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';

async function requireAdmin() {
  const supabase = await createServerSupabaseClient();
  if (!supabase) return { error: 'Supabase not configured', status: 503 as const };
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'Unauthorized', status: 401 as const };

  const admin = createAdminClient();
  if (!admin) return { error: 'Advertising service is not configured', status: 503 as const };

  const { data: profile } = await admin
    .from('profiles')
    .select('id,role')
    .eq('auth_id', user.id)
    .maybeSingle();
  if (!profile || !['ADMIN', 'SUPER_ADMIN'].includes(String(profile.role))) {
    return { error: 'Admin only', status: 403 as const };
  }
  return { admin, profile, supabase };
}

/** POST /api/admin/ads — approve or reject a pending sponsored campaign. */
export async function POST(req: NextRequest) {
  try {
    const ip = clientIpFromRequest(req);
    const limited = rateLimit(`admin:ads:${ip}`, 30, 60_000);
    if (!limited.allowed) {
      return NextResponse.json({ success: false, error: 'Too many attempts' }, { status: 429 });
    }

    const ctx = await requireAdmin();
    if ('error' in ctx) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    }

    const body = await req.json().catch(() => ({}));
    const campaignId = Number(body.campaignId);
    const action = String(body.action || '').toUpperCase();
    const reason = String(body.reason || '').trim().slice(0, 500);

    if (!Number.isInteger(campaignId) || campaignId <= 0) {
      return NextResponse.json({ success: false, error: 'Valid campaign required' }, { status: 400 });
    }
    if (action !== 'APPROVE' && action !== 'REJECT') {
      return NextResponse.json({ success: false, error: 'Choose approve or reject' }, { status: 400 });
    }

    const { data, error } = await callRustAdminRpc(ctx.supabase, 'admin_review_sponsored_campaign', {
      p_ad_id: campaignId,
      p_admin_id: ctx.profile.id,
      p_action: action,
      p_reason: reason,
    });

    if (error) {
      logger.warn('Sponsored campaign moderation failed', { campaignId, error: error.message });
      return NextResponse.json(
        { success: false, error: error.message || 'Campaign moderation failed' },
        { status: 400 }
      );
    }

    return NextResponse.json({ success: true, review: data });
  } catch (error) {
    logger.error('Sponsored campaign moderation error', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Campaign moderation failed') },
      { status: 500 }
    );
  }
}
