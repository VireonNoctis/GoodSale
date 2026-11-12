import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { callRustRpc } from '@/lib/server/rust-rpc';
import { logger } from '@/lib/logger';

/** Changes the signed-in profile's suspension flag through the atomic Rust/RPC boundary. */
export async function POST(request: Request) {
  try {
    const supabase = await createServerSupabaseClient();
    if (!supabase) return NextResponse.json({ success: false, error: 'Supabase not configured' }, { status: 503 });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

    let suspended = true;
    try {
      const body = await request.json();
      if (typeof body?.suspended === 'boolean') suspended = body.suspended;
    } catch {
      // Preserve the existing default: an empty request suspends the account.
    }

    const { data, error } = await callRustRpc<{ success: boolean; suspended: boolean }>(
      supabase,
      'set_my_account_suspended',
      { p_suspended: suspended },
    );
    if (error || !data?.success) {
      return NextResponse.json({ success: false, error: error?.message || 'Could not update account status' }, { status: Number(error?.code) || 400 });
    }
    return NextResponse.json({ success: true, suspended: data.suspended });
  } catch (error) {
    logger.error('Account deactivation failed', { error: String(error) });
    return NextResponse.json({ success: false, error: 'Could not update account status' }, { status: 500 });
  }
}
