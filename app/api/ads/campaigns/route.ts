import { callRustRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger, publicErrorMessage } from '@/lib/logger';
import { profileIdForAuth } from '@/lib/wallet/server';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';

/**
 * POST /api/ads/campaigns — submit a sponsored campaign.
 *
 * The database validates listing ownership/eligibility, reserves the budget
 * from the wallet and creates a PENDING_REVIEW campaign. Nothing starts
 * serving until an admin approves it.
 */
export async function POST(req: NextRequest) {
  try {
    const ip = clientIpFromRequest(req);
    const limited = rateLimit(`ads:campaigns:${ip}`, 10, 60_000);
    if (!limited.allowed) {
      return NextResponse.json({ success: false, error: 'Too many campaign attempts' }, { status: 429 });
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

    const admin = createAdminClient();
    if (!admin) {
      return NextResponse.json({ success: false, error: 'Advertising service is not configured' }, { status: 503 });
    }
    const profileId = await profileIdForAuth(admin, user.id);
    if (!profileId) {
      return NextResponse.json({ success: false, error: 'Profile not found' }, { status: 404 });
    }

    const body = await req.json().catch(() => ({}));
    const type = String(body.type || '').toUpperCase();
    const targetId = Number(body.targetId ?? 0);
    const title = String(body.title || '').trim();
    const budget = Number(body.budget);
    const bannerUrl = String(body.bannerUrl || '').trim();
    const placements = Array.isArray(body.placements) ? body.placements.map(String) : ['HOME'];
    const targetState = String(body.targetState || '').trim().slice(0, 80);
    const targetCity = String(body.targetCity || '').trim().slice(0, 80);
    const targetCategory = String(body.targetCategory || '').trim().slice(0, 80);
    const dailyBudget = body.dailyBudget == null ? null : Number(body.dailyBudget);
    const cpcBid = body.cpcBid == null ? null : Number(body.cpcBid);
    const startsAt = body.startsAt ? new Date(String(body.startsAt)) : null;
    const endsAt = body.endsAt ? new Date(String(body.endsAt)) : null;

    if (!['PRODUCT', 'BUSINESS', 'BANNER_HOME', 'BANNER_CATEGORY'].includes(type)) {
      return NextResponse.json({ success: false, error: 'Choose a valid campaign type' }, { status: 400 });
    }
    if (title.length < 3 || title.length > 100) {
      return NextResponse.json({ success: false, error: 'Campaign title must be 3–100 characters' }, { status: 400 });
    }
    if (!Number.isFinite(budget) || budget <= 0) {
      return NextResponse.json({ success: false, error: 'Enter a valid campaign budget' }, { status: 400 });
    }
    if (type === 'PRODUCT' && (!Number.isInteger(targetId) || targetId <= 0)) {
      return NextResponse.json({ success: false, error: 'Choose the listing to advertise' }, { status: 400 });
    }
    if (!placements.length || placements.some((p: string) => !['HOME', 'CATEGORY', 'DETAIL', 'CHAT', 'DASHBOARD', 'SEARCH'].includes(p))) {
      return NextResponse.json({ success: false, error: 'Choose valid campaign placements' }, { status: 400 });
    }
    if (dailyBudget != null && (!Number.isFinite(dailyBudget) || dailyBudget <= 0)) {
      return NextResponse.json({ success: false, error: 'Daily budget must be positive' }, { status: 400 });
    }
    if (cpcBid != null && (!Number.isFinite(cpcBid) || cpcBid < 50 || cpcBid > 10000)) {
      return NextResponse.json({ success: false, error: 'CPC bid must be between ₦50 and ₦10,000' }, { status: 400 });
    }
    if ((startsAt && Number.isNaN(startsAt.getTime())) || (endsAt && Number.isNaN(endsAt.getTime()))) {
      return NextResponse.json({ success: false, error: 'Choose valid campaign dates' }, { status: 400 });
    }

    const { data, error } = await admin.rpc('purchase_sponsored_campaign_v2', {
      p_user_id: profileId,
      p_ad_type: type,
      p_target_id: Number.isInteger(targetId) && targetId > 0 ? targetId : 0,
      p_title: title,
      p_budget: Math.round(budget),
      p_banner_url: bannerUrl,
      p_placements: placements,
      p_target_state: targetState,
      p_target_city: targetCity,
      p_target_category: targetCategory,
      p_starts_at: startsAt ? startsAt.toISOString() : null,
      p_ends_at: endsAt ? endsAt.toISOString() : null,
      p_daily_budget: dailyBudget == null ? null : Math.round(dailyBudget),
      p_cpc_bid: cpcBid == null ? null : Math.round(cpcBid),
    });

    if (error) {
      logger.warn('Sponsored campaign creation failed', { type, error: error.message });
      return NextResponse.json(
        { success: false, error: error.message || 'Could not create the campaign' },
        { status: 400 }
      );
    }

    return NextResponse.json({ success: true, campaign: data });
  } catch (error) {
    logger.error('Sponsored campaign creation error', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not create the campaign') },
      { status: 500 }
    );
  }
}
