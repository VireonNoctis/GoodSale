import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { callRustRpc } from '@/lib/server/rust-rpc';
import { logger } from '@/lib/logger';

type Overview = {
  success: boolean;
  ownerId: number;
  businessName: string;
  location: string;
  role: string | null;
  capabilities: string[];
  plan: string | null;
  expiresAt: string | null;
  stats: { listings: number; lowStock: number; pendingModeration: number; openOrders: number; revenue: number };
  lowStock: Array<Record<string, unknown>>;
  listings: Array<Record<string, unknown>>;
  recentOrders: Array<Record<string, unknown>>;
};

export async function GET(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient();
    if (!supabase) return NextResponse.json({ success: false, error: 'Supabase not configured' }, { status: 503 });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

    const ownerParam = req.nextUrl.searchParams.get('ownerId');
    const ownerId = ownerParam && /^\d+$/.test(ownerParam) ? Number(ownerParam) : null;
    if (ownerParam && (!ownerId || !Number.isSafeInteger(ownerId))) {
      return NextResponse.json({ success: false, error: 'Business owner id is invalid' }, { status: 400 });
    }

    const { data, error } = await callRustRpc<Overview>(
      supabase,
      'get_my_business_staff_overview',
      { p_owner_id: ownerId },
    );
    if (error || !data?.success) {
      const message = error?.message || 'Could not load the business snapshot';
      const status = /not active staff|membership/i.test(message) ? 403 :
        /not found/i.test(message) ? 404 : Number(error?.code) || 400;
      return NextResponse.json({ success: false, error: message }, { status });
    }
    return NextResponse.json(data);
  } catch (error) {
    logger.error('Staff overview failed', { error: String(error) });
    return NextResponse.json({ success: false, error: 'Could not load the business snapshot' }, { status: 500 });
  }
}
