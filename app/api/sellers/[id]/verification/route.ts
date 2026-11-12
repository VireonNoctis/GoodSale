import { callRustRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import { toStage } from '@/lib/verification';

/**
 * GET /api/sellers/:id/verification
 *
 * The buyer-facing badge panel. Returns only the public verification summary
 * from `seller_public_verification()` — never documents, document numbers,
 * addresses or internal notes. Anonymous shoppers can call it.
 */

export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const sellerId = Number(id);
    if (!Number.isFinite(sellerId) || sellerId <= 0) {
      return NextResponse.json({ success: false, error: 'Seller not found' }, { status: 400 });
    }

    const supabase = await createServerSupabaseClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: 'Supabase not configured' }, { status: 503 });
    }

    const { data, error } = await callRustRpc(supabase, 'seller_public_verification', {
      p_seller_id: sellerId,
    });

    if (error) {
      logger.warn('public verification lookup failed', { message: error.message });
      return NextResponse.json({ success: false, error: 'Verification unavailable' }, { status: 500 });
    }

    if (!data) {
      return NextResponse.json({ success: false, error: 'Seller not found' }, { status: 404 });
    }

    const summary = data as {
      status?: string;
      verifiedAt?: string | null;
      expiresAt?: string | null;
      sellerType?: string;
      storeName?: string;
      city?: string;
      state?: string;
      memberSince?: string | null;
    };

    const stage = toStage(summary.status);
    const verified =
      stage === 'VERIFIED' &&
      (!summary.expiresAt || new Date(summary.expiresAt).getTime() > Date.now());

    return NextResponse.json(
      {
        success: true,
        verification: {
          verified,
          stage,
          verifiedAt: verified ? summary.verifiedAt || null : null,
          sellerType: summary.sellerType === 'BUSINESS' ? 'BUSINESS' : 'INDIVIDUAL',
          storeName: summary.storeName || '',
          city: summary.city || '',
          state: summary.state || '',
          memberSince: summary.memberSince || null,
        },
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    logger.error('public verification route error', { error: String(error) });
    return NextResponse.json({ success: false, error: 'Verification unavailable' }, { status: 500 });
  }
}
