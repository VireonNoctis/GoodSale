import { callRustRpc } from '@/lib/server/rust-rpc';
import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

/** Re-check the signed-in user's own referral against current activity. */
export async function POST() {
  try {
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

    const { data, error } = await callRustRpc(supabase, 'evaluate_my_referral');
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: true, result: data });
  } catch (error) {
    logger.error('Referral evaluation failed', { error: String(error) });
    return NextResponse.json({ success: false, error: 'Could not evaluate referral' }, { status: 500 });
  }
}
