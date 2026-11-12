import { callRustRpc } from '@/lib/server/rust-rpc';
import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger, publicErrorMessage } from '@/lib/logger';
import { profileIdForAuth } from '@/lib/wallet/server';

/** GET /api/premium/credits — the signed-in member's credit balance and ledger. */
export async function GET() {
  try {
    const supabase = await createServerSupabaseClient();
    if (!supabase) return NextResponse.json({ success: false, error: 'Supabase not configured' }, { status: 503 });
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

    const admin = createAdminClient();
    if (!admin) return NextResponse.json({ success: false, error: 'Server not configured' }, { status: 503 });
    const profileId = await profileIdForAuth(admin, user.id);
    if (!profileId) return NextResponse.json({ success: false, error: 'Profile not found' }, { status: 404 });

    const [balanceResult, lotsResult, ledgerResult] = await Promise.all([
      admin.rpc('premium_credit_balance', { p_user_id: profileId }),
      admin
        .from('premium_credit_lots')
        .select('id,amount,remaining,source,reference,expires_at,created_at')
        .eq('user_id', profileId)
        .gt('remaining', 0)
        .gt('expires_at', new Date().toISOString())
        .order('expires_at', { ascending: true })
        .limit(50),
      admin
        .from('premium_credit_ledger')
        .select('id,type,amount,reference,description,created_at')
        .eq('user_id', profileId)
        .order('created_at', { ascending: false })
        .limit(60),
    ]);

    if (balanceResult.error) {
      logger.warn('Credit balance lookup failed', { error: balanceResult.error.message });
    }

    return NextResponse.json({
      success: true,
      balance: Number(balanceResult.data || 0),
      lots: (lotsResult.data || []).map((row) => ({
        id: Number(row.id),
        amount: Number(row.amount),
        remaining: Number(row.remaining),
        source: row.source,
        reference: row.reference,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
      })),
      ledger: (ledgerResult.data || []).map((row) => ({
        id: Number(row.id),
        type: row.type,
        amount: Number(row.amount),
        reference: row.reference,
        description: row.description,
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    logger.error('Premium credits lookup failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not load promotional credits') },
      { status: 500 }
    );
  }
}
