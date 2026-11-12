import { callRustAdminRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';
import { buildFlashSaleQueue, isPriorityCampaign, sellerPlanRank } from '@/lib/premium/moderation';

async function requireAdmin() {
  const supabase = await createServerSupabaseClient();
  if (!supabase) return { error: 'Supabase not configured', status: 503 as const };
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'Unauthorized', status: 401 as const };
  const admin = createAdminClient();
  if (!admin) return { error: 'Premium service is not configured', status: 503 as const };
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

/** GET /api/admin/premium — plan copy, pending Flash Sales, payments, credits and audit. */
export async function GET() {
  try {
    const ctx = await requireAdmin();
    if ('error' in ctx) return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });

    const [benefits, flashSales, payments, lots, audit] = await Promise.all([
      ctx.admin.from('membership_plan_benefits').select('*').order('plan_code').order('sort_order'),
      ctx.admin
        .from('featured_listings')
        .select('id,product_id,seller_id,sale_price,quantity_limit,quantity_sold,starts_at,ends_at,status,moderation_status,moderation_reason,amount_paid,credits_applied,wallet_charge,created_at')
        .eq('feature_type', 'FLASH_SALE')
        .in('status', ['PENDING_REVIEW', 'SCHEDULED', 'ACTIVE'])
        .order('created_at', { ascending: false })
        .limit(50),
      ctx.admin
        .from('premium_subscription_payments')
        .select('id,user_id,product,plan_code,reference,amount,status,starts_at,expires_at,paid_at,created_at')
        .order('created_at', { ascending: false })
        .limit(50),
      ctx.admin
        .from('premium_credit_lots')
        .select('id,user_id,amount,remaining,source,reference,expires_at,created_at')
        .order('created_at', { ascending: false })
        .limit(50),
      ctx.admin
        .from('audit_logs')
        .select('id,user_id,action,entity_type,entity_id,details,created_at')
        .in('entity_type', ['PREMIUM_SUBSCRIPTION', 'FEATURED_LISTING', 'SPONSORED_AD', 'PREMIUM_CREDITS'])
        .order('created_at', { ascending: false })
        .limit(80),
    ]);

    for (const [label, result] of Object.entries({ benefits, flashSales, payments, lots, audit })) {
      if (result.error) logger.warn(`Admin premium ${label} lookup failed`, { error: result.error.message });
    }

    // Business Premium and Enterprise sellers are surfaced first in the review
    // queue, which is the advertised priority-review benefit. Pending campaigns
    // always come before already-scheduled ones.
    const saleRows = flashSales.data || [];
    const planBySeller = new Map<number, string>();
    const saleSellerIds = [...new Set(saleRows.map((row) => Number(row.seller_id)).filter((id) => id > 0))];
    if (saleSellerIds.length) {
      const nowIso = new Date().toISOString();
      const { data: subs, error: subError } = await ctx.admin
        .from('business_subscriptions')
        .select('user_id,plan,status,expires_at')
        .in('user_id', saleSellerIds)
        .eq('status', 'ACTIVE')
        .gt('expires_at', nowIso);
      if (subError) logger.warn('Admin premium seller plan lookup failed', { error: subError.message });
      for (const sub of subs || []) {
        const plan = String(sub.plan || '').toUpperCase();
        const sellerId = Number(sub.user_id);
        if (sellerPlanRank(plan) > sellerPlanRank(planBySeller.get(sellerId))) {
          planBySeller.set(sellerId, plan);
        }
      }
    }
    const flashSaleQueue = buildFlashSaleQueue(saleRows, planBySeller);

    return NextResponse.json({
      success: true,
      benefits: (benefits.data || []).map((row) => ({
        id: Number(row.id),
        planCode: row.plan_code,
        label: row.label,
        description: row.description,
        included: Boolean(row.included),
        sortOrder: Number(row.sort_order),
        active: Boolean(row.active),
      })),
      flashSales: flashSaleQueue.map(({ row, plan }) => ({
        id: Number(row.id),
        productId: Number(row.product_id),
        sellerId: Number(row.seller_id),
        sellerPlan: plan,
        priority: isPriorityCampaign(row.status, plan),
        salePrice: Number(row.sale_price || 0),
        quantityLimit: Number(row.quantity_limit || 0),
        quantitySold: Number(row.quantity_sold || 0),
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        status: row.status,
        moderationStatus: row.moderation_status,
        moderationReason: row.moderation_reason,
        amountPaid: Number(row.amount_paid || 0),
        creditsApplied: Number(row.credits_applied || 0),
        walletCharge: Number(row.wallet_charge || 0),
        createdAt: row.created_at,
      })),
      payments: (payments.data || []).map((row) => ({
        id: Number(row.id),
        userId: Number(row.user_id),
        product: row.product,
        planCode: row.plan_code,
        reference: row.reference,
        amount: Number(row.amount),
        status: row.status,
        startsAt: row.starts_at,
        expiresAt: row.expires_at,
        paidAt: row.paid_at,
        createdAt: row.created_at,
      })),
      credits: (lots.data || []).map((row) => ({
        id: Number(row.id),
        userId: Number(row.user_id),
        amount: Number(row.amount),
        remaining: Number(row.remaining),
        source: row.source,
        reference: row.reference,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
      })),
      audit: (audit.data || []).map((row) => ({
        id: Number(row.id),
        userId: row.user_id == null ? null : Number(row.user_id),
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id == null ? null : Number(row.entity_id),
        details: row.details,
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    logger.error('Admin premium lookup failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not load premium operations') },
      { status: 500 }
    );
  }
}

/** POST /api/admin/premium — plan copy, Flash Sale moderation, credit grants and jobs. */
export async function POST(req: NextRequest) {
  try {
    const ip = clientIpFromRequest(req);
    const limited = rateLimit(`admin:premium:${ip}`, 40, 60_000);
    if (!limited.allowed) return NextResponse.json({ success: false, error: 'Too many attempts' }, { status: 429 });

    const ctx = await requireAdmin();
    if ('error' in ctx) return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '').toUpperCase();

    if (action === 'REVIEW_FLASH') {
      const promotionId = Number(body.promotionId);
      const decision = String(body.decision || '').toUpperCase();
      const reason = String(body.reason || '').trim().slice(0, 500);
      if (!Number.isInteger(promotionId) || promotionId <= 0 || !['APPROVE', 'REJECT'].includes(decision)) {
        return NextResponse.json({ success: false, error: 'Valid Flash Sale decision required' }, { status: 400 });
      }
      const { data, error } = await callRustAdminRpc(ctx.supabase, 'admin_review_flash_sale', {
        p_promotion_id: promotionId,
        p_admin_id: ctx.profile.id,
        p_action: decision,
        p_reason: reason,
      });
      if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 });
      return NextResponse.json({ success: true, review: data });
    }

    if (action === 'UPSERT_BENEFIT') {
      const benefit = body.benefit || {};
      const planCode = String(benefit.planCode || '').toUpperCase();
      const label = String(benefit.label || '').trim().slice(0, 120);
      const description = String(benefit.description || '').trim().slice(0, 500);
      const sortOrder = Number(benefit.sortOrder);
      if (!['VERIFIED_PLUS', 'BUSINESS_PRO', 'BUSINESS_PREMIUM', 'BUSINESS_ENTERPRISE'].includes(planCode)) {
        return NextResponse.json({ success: false, error: 'Valid plan required' }, { status: 400 });
      }
      if (label.length < 3 || !Number.isInteger(sortOrder) || sortOrder < 0) {
        return NextResponse.json({ success: false, error: 'Benefit label and order are required' }, { status: 400 });
      }
      const patch = {
        plan_code: planCode,
        label,
        description,
        included: benefit.included !== false,
        sort_order: sortOrder,
        active: benefit.active !== false,
        updated_by: ctx.profile.id,
      };
      const id = Number(benefit.id || 0);
      const query = id
        ? ctx.admin.from('membership_plan_benefits').update(patch).eq('id', id).select('id').single()
        : ctx.admin.from('membership_plan_benefits').insert(patch).select('id').single();
      const { data, error } = await query;
      if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 });
      await ctx.admin.from('audit_logs').insert({
        user_id: ctx.profile.id,
        action: id ? 'UPDATE_MEMBERSHIP_BENEFIT' : 'CREATE_MEMBERSHIP_BENEFIT',
        entity_type: 'PREMIUM_SUBSCRIPTION',
        entity_id: data.id,
        details: `${planCode}: ${label}`,
      });
      return NextResponse.json({ success: true, benefitId: data.id });
    }

    if (action === 'GRANT_CREDITS') {
      const userId = Number(body.userId);
      const amount = Number(body.amount);
      const reason = String(body.reason || '').trim().slice(0, 200);
      if (!Number.isInteger(userId) || userId <= 0 || !Number.isFinite(amount) || amount <= 0) {
        return NextResponse.json({ success: false, error: 'Valid member and positive amount required' }, { status: 400 });
      }
      if (reason.length < 3) {
        return NextResponse.json({ success: false, error: 'Add a reason for the credit grant' }, { status: 400 });
      }
      const reference = `ADMIN_CREDIT:${userId}:${Date.now()}`;
      const { data, error } = await callRustAdminRpc(ctx.supabase, 'issue_premium_credits', {
        p_user_id: userId,
        p_amount: Math.round(amount),
        p_source: 'ADMIN',
        p_reference: reference,
        p_expiry_days: null,
      });
      if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 });
      await ctx.admin.from('audit_logs').insert({
        user_id: ctx.profile.id,
        action: 'GRANT_PREMIUM_CREDITS',
        entity_type: 'PREMIUM_CREDITS',
        entity_id: userId,
        details: `₦${Math.round(amount)} to member #${userId}: ${reason}`,
      });
      return NextResponse.json({ success: true, grant: data });
    }

    if (action === 'RUN_JOBS') {
      const { data, error } = await callRustAdminRpc(ctx.supabase, 'run_premium_jobs');
      if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 });
      return NextResponse.json({ success: true, jobs: data });
    }

    return NextResponse.json({ success: false, error: 'Unknown premium admin action' }, { status: 400 });
  } catch (error) {
    logger.error('Admin premium action failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Premium action failed') },
      { status: 500 }
    );
  }
}
