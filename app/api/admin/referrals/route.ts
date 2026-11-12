import { callRustAdminRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger, publicErrorMessage } from '@/lib/logger';
import { adminCampaign } from '@/lib/referrals/server';
import type { AdminReferralData, AdminReferralRow, ReferralAction } from '@/lib/referrals/types';

async function requireAdmin() {
  const supabase = await createServerSupabaseClient();
  if (!supabase) return { error: 'Supabase not configured', status: 503 as const };
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'Unauthorized', status: 401 as const };
  const admin = createAdminClient();
  if (!admin) return { error: 'Referral service is not configured', status: 503 as const };
  const { data: profile } = await admin
    .from('profiles')
    .select('id,role')
    .eq('auth_id', user.id)
    .maybeSingle();
  if (!profile || !['ADMIN', 'SUPER_ADMIN'].includes(String(profile.role))) {
    return { error: 'Admin only', status: 403 as const };
  }
  return { supabase, admin, profile };
}

const ACTIONS: ReferralAction[] = ['PURCHASE', 'LISTING', 'SELLER_SALE'];
const STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'ENDED'] as const;
const AUDIENCES = ['ANY', 'BUYER', 'SELLER'] as const;

function integer(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function dateValue(value: unknown, fallback?: string): string | null {
  if (!value) return fallback || null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? fallback || null : date.toISOString();
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireAdmin();
    if ('error' in ctx) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    }
    const { supabase, admin } = ctx;
    const q = String(req.nextUrl.searchParams.get('q') || '')
      .trim()
      .replace(/[^a-zA-Z0-9 @._-]/g, '')
      .slice(0, 80);
    const campaignFilter = Number(req.nextUrl.searchParams.get('campaign_id'));
    const statusFilter = String(req.nextUrl.searchParams.get('status') || '');
    const allowedStatuses = [
      'REGISTERED',
      'VERIFICATION_PENDING',
      'QUALIFIED',
      'REWARD_PENDING',
      'REWARDED',
      'DISQUALIFIED',
    ];

    const [campaignRows, analyticsResult, clicks, audit] = await Promise.all([
      admin.from('referral_campaigns').select('*').order('created_at', { ascending: false }),
      callRustAdminRpc(supabase, 'admin_referral_analytics'),
      admin
        .from('referral_clicks')
        .select('id,code,campaign_id,created_at')
        .order('created_at', { ascending: false })
        .limit(100),
      admin
        .from('audit_logs')
        .select('id,action,entity_id,details,created_at')
        .eq('entity_type', 'REFERRAL')
        .order('created_at', { ascending: false })
        .limit(100),
    ]);

    let matchingProfileIds: number[] = [];
    if (q) {
      const { data: matchingProfiles } = await admin
        .from('profiles')
        .select('id')
        .or(
          `full_name.ilike.%${q}%,email.ilike.%${q}%,username.ilike.%${q}%,referral_code.ilike.%${q}%`
        )
        .limit(50);
      matchingProfileIds = (matchingProfiles || []).map((row) => Number(row.id));
    }

    let referralQuery = admin
      .from('referrals')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);
    if (Number.isFinite(campaignFilter) && campaignFilter > 0) {
      referralQuery = referralQuery.eq('campaign_id', campaignFilter);
    }
    if (allowedStatuses.includes(statusFilter)) {
      referralQuery = referralQuery.eq('status', statusFilter);
    }
    if (q) {
      const filters = [`code.ilike.%${q}%`];
      if (matchingProfileIds.length) {
        filters.push(`referrer_id.in.(${matchingProfileIds.join(',')})`);
        filters.push(`referee_id.in.(${matchingProfileIds.join(',')})`);
      }
      referralQuery = referralQuery.or(filters.join(','));
    }

    const { data: referrals, error: referralError } = await referralQuery;
    if (referralError) throw referralError;

    const referralRows = (referrals || []) as Record<string, unknown>[];
    const referralIds = referralRows.map((row) => Number(row.id));
    const profileIds = new Set<number>();
    for (const row of referralRows) {
      profileIds.add(Number(row.referrer_id));
      profileIds.add(Number(row.referee_id));
    }

    const [{ data: profiles }, { data: rewards }] = await Promise.all([
      profileIds.size
        ? admin
            .from('profiles')
            .select('id,full_name,email,username,role,referral_code')
            .in('id', Array.from(profileIds))
        : Promise.resolve({ data: [] as Record<string, unknown>[] }),
      referralIds.length
        ? admin
            .from('referral_rewards')
            .select('*')
            .in('referral_id', referralIds)
            .order('created_at', { ascending: false })
        : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    ]);

    const profileById = new Map(
      ((profiles || []) as Record<string, unknown>[]).map((row) => [Number(row.id), row])
    );
    const campaignById = new Map(
      ((campaignRows.data || []) as Record<string, unknown>[]).map((row) => [Number(row.id), row])
    );

    const mappedReferrals: AdminReferralRow[] = referralRows.map((row) => {
      const referrer = profileById.get(Number(row.referrer_id));
      const referee = profileById.get(Number(row.referee_id));
      const campaign = campaignById.get(Number(row.campaign_id));
      return {
        id: Number(row.id),
        code: String(row.code || ''),
        status: String(row.status || 'REGISTERED') as AdminReferralRow['status'],
        refereeName: String(row.referee_name || ''),
        referrer: referrer
          ? {
              id: Number(referrer.id),
              name: String(referrer.full_name || referrer.username || ''),
              email: String(referrer.email || ''),
              code: String(referrer.referral_code || ''),
            }
          : null,
        referee: referee
          ? {
              id: Number(referee.id),
              name: String(referee.full_name || referee.username || ''),
              email: String(referee.email || ''),
              role: String(referee.role || 'BUYER'),
            }
          : null,
        campaignId: row.campaign_id ? Number(row.campaign_id) : undefined,
        campaignName: campaign ? String(campaign.name || '') : undefined,
        referrerReward: Number(row.referrer_reward ?? 0),
        refereeReward: Number(row.referee_reward ?? 0),
        riskScore: Number(row.risk_score ?? 0),
        fraudFlags: Array.isArray(row.fraud_flags) ? (row.fraud_flags as string[]) : [],
        fraudReviewedAt: row.fraud_reviewed_at ? String(row.fraud_reviewed_at) : undefined,
        disqualifiedReason: row.disqualification_reason
          ? String(row.disqualification_reason)
          : undefined,
        createdAt: String(row.created_at || ''),
        qualifiedAt: row.qualified_at ? String(row.qualified_at) : undefined,
        rewardedAt: row.rewarded_at ? String(row.rewarded_at) : undefined,
        rewardStatus: String(row.status || ''),
      };
    });

    const mappedRewards = ((rewards || []) as Record<string, unknown>[]).map((row) => ({
      id: Number(row.id),
      referralId: Number(row.referral_id),
      beneficiaryId: Number(row.beneficiary_id),
      beneficiaryName: String(
        profileById.get(Number(row.beneficiary_id))?.full_name ||
          profileById.get(Number(row.beneficiary_id))?.username ||
          'Member'
      ),
      beneficiaryRole: row.beneficiary_role as 'REFERRER' | 'REFEREE',
      amount: Number(row.amount ?? 0),
      status: row.status as 'PENDING' | 'ISSUED' | 'REVERSED',
      reference: String(row.reference || ''),
      createdAt: String(row.created_at || ''),
      issuedAt: row.issued_at ? String(row.issued_at) : undefined,
    }));

    const analytics = (analyticsResult.data || {}) as AdminReferralData['analytics'];
    const payload: AdminReferralData = {
      campaigns: ((campaignRows.data || []) as Record<string, unknown>[]).map(adminCampaign),
      referrals: mappedReferrals,
      rewards: mappedRewards,
      clicks: (clicks.data || []).map((row) => ({
        id: Number(row.id),
        code: String(row.code || ''),
        campaignId: row.campaign_id ? Number(row.campaign_id) : undefined,
        createdAt: String(row.created_at || ''),
      })),
      analytics: {
        registered: Number(analytics.registered || 0),
        verification_pending: Number(analytics.verification_pending || 0),
        qualified: Number(analytics.qualified || 0),
        rewarded: Number(analytics.rewarded || 0),
        disqualified: Number(analytics.disqualified || 0),
        total: Number(analytics.total || 0),
        flagged: Number(analytics.flagged || 0),
        unreviewed_flagged: Number(analytics.unreviewed_flagged || 0),
        coins_issued: Number(analytics.coins_issued || 0),
        clicks: Number(analytics.clicks || 0),
        clicks_30d: Number(analytics.clicks_30d || 0),
        registered_30d: Number(analytics.registered_30d || 0),
      },
      audit: (audit.data || []).map((row) => ({
        id: Number(row.id),
        action: String(row.action || ''),
        entityId: row.entity_id ? Number(row.entity_id) : undefined,
        details: String(row.details || ''),
        createdAt: String(row.created_at || ''),
      })),
    };

    return NextResponse.json({
      success: true,
      source: 'server',
      ...payload,
      analyticsError: analyticsResult.error?.message || null,
    });
  } catch (error) {
    logger.error('Admin referral dashboard failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not load referrals') },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireAdmin();
    if ('error' in ctx) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    }
    const { supabase, admin, profile } = ctx;
    const adminId = Number(profile.id);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action || '');

    if (action === 'CAMPAIGN_SAVE') {
      const name = String(body.name || '').trim().slice(0, 100);
      if (name.length < 2) {
        return NextResponse.json({ success: false, error: 'Campaign name is required' }, { status: 400 });
      }
      const id = Number(body.id) || 0;
      const status = STATUSES.includes(body.status as (typeof STATUSES)[number])
        ? String(body.status)
        : 'DRAFT';
      const audience = AUDIENCES.includes(body.audience as (typeof AUDIENCES)[number])
        ? String(body.audience)
        : 'ANY';
      const qualifyingActions = Array.isArray(body.qualifyingActions)
        ? Array.from(
            new Set(
              body.qualifyingActions
                .map((value) => String(value).toUpperCase() as ReferralAction)
                .filter((value) => ACTIONS.includes(value))
            )
          )
        : [];
      if (!qualifyingActions.length) {
        return NextResponse.json(
          { success: false, error: 'Select at least one qualifying action' },
          { status: 400 }
        );
      }
      const startsAt = dateValue(body.startsAt, new Date().toISOString()) as string;
      const endsAt = dateValue(body.endsAt);
      if (endsAt && endsAt <= startsAt) {
        return NextResponse.json(
          { success: false, error: 'Campaign end must be after the start' },
          { status: 400 }
        );
      }

      const slug = id
        ? undefined
        : `${slugify(name) || 'referral'}-${Date.now().toString(36)}`;
      const row = {
        name,
        ...(slug ? { slug } : {}),
        description: String(body.description || '').trim().slice(0, 1000),
        status,
        audience,
        reward_type: 'GOODSALE_COINS',
        referrer_reward: integer(body.referrerReward, 0, 100000, 500),
        referee_reward: integer(body.refereeReward, 0, 100000, 250),
        require_email_verified: body.requireEmailVerified !== false,
        require_onboarding: body.requireOnboarding !== false,
        require_verified_referrer: Boolean(body.requireVerifiedReferrer),
        min_referrer_age_hours: integer(body.minReferrerAgeHours, 0, 8760, 0),
        qualifying_actions: qualifyingActions,
        disqualify_refunded: body.disqualifyRefunded !== false,
        max_rewards_per_user: integer(body.maxRewardsPerUser, 0, 100000, 20),
        max_rewards_per_campaign: integer(body.maxRewardsPerCampaign, 0, 1000000, 1000),
        starts_at: startsAt,
        ends_at: endsAt,
        terms: String(body.terms || '').trim().slice(0, 2000),
      };

      const result = id
        ? await admin.from('referral_campaigns').update(row).eq('id', id).select('*').single()
        : await admin
            .from('referral_campaigns')
            .insert({ ...row, created_by: adminId })
            .select('*')
            .single();
      if (result.error) throw result.error;

      await admin.from('audit_logs').insert({
        user_id: adminId,
        action: id ? 'REFERRAL_CAMPAIGN_UPDATED' : 'REFERRAL_CAMPAIGN_CREATED',
        entity_type: 'REFERRAL',
        entity_id: Number(result.data.id),
        details: `${name} · ${status} · ${row.referrer_reward}/${row.referee_reward} coins · ${qualifyingActions.join(', ')}`,
      });

      return NextResponse.json({
        success: true,
        campaign: adminCampaign(result.data as Record<string, unknown>),
      });
    }

    if (action === 'SET_CAMPAIGN_STATUS') {
      const id = Number(body.id);
      const status = String(body.status || '');
      if (!id || !STATUSES.includes(status as (typeof STATUSES)[number])) {
        return NextResponse.json({ success: false, error: 'Invalid campaign status' }, { status: 400 });
      }
      const { data, error } = await admin
        .from('referral_campaigns')
        .update({ status })
        .eq('id', id)
        .select('name')
        .maybeSingle();
      if (error) throw error;
      await admin.from('audit_logs').insert({
        user_id: adminId,
        action: 'REFERRAL_CAMPAIGN_STATUS',
        entity_type: 'REFERRAL',
        entity_id: id,
        details: `${data?.name || `Campaign #${id}`} set to ${status}`,
      });
      return NextResponse.json({ success: true, status });
    }

    if (action === 'DISQUALIFY') {
      const referralId = Number(body.referralId);
      const reason = String(body.reason || '').trim();
      if (!referralId || reason.length < 3) {
        return NextResponse.json(
          { success: false, error: 'A referral and reason are required' },
          { status: 400 }
        );
      }
      const { data, error } = await callRustAdminRpc(supabase, 'admin_disqualify_referral', {
        p_referral_id: referralId,
        p_reason: reason,
      });
      if (error) throw error;
      return NextResponse.json({ success: true, result: data });
    }

    if (action === 'MARK_REVIEWED') {
      const referralId = Number(body.referralId);
      if (!referralId) {
        return NextResponse.json({ success: false, error: 'Referral is required' }, { status: 400 });
      }
      const { data, error } = await callRustAdminRpc(supabase, 'admin_mark_referral_reviewed', {
        p_referral_id: referralId,
        p_notes: String(body.notes || '').slice(0, 500),
      });
      if (error) throw error;
      return NextResponse.json({ success: true, result: data });
    }

    if (action === 'REEVALUATE') {
      const referralId = Number(body.referralId);
      if (!referralId) {
        return NextResponse.json({ success: false, error: 'Referral is required' }, { status: 400 });
      }
      const { data, error } = await callRustAdminRpc(supabase, 'referral_evaluate', {
        p_referral_id: referralId,
      });
      if (error) throw error;
      await admin.from('audit_logs').insert({
        user_id: adminId,
        action: 'REFERRAL_REEVALUATED',
        entity_type: 'REFERRAL',
        entity_id: referralId,
        details: JSON.stringify(data || {}).slice(0, 500),
      });
      return NextResponse.json({ success: true, result: data });
    }

    return NextResponse.json({ success: false, error: 'Unknown referral action' }, { status: 400 });
  } catch (error) {
    logger.error('Admin referral action failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Referral action failed') },
      { status: 400 }
    );
  }
}
