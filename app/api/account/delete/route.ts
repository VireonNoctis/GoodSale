import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger, publicErrorMessage } from '@/lib/logger';

/** Permanently deletes the signed-in user's profile and auth account. */
export async function POST() {
  try {
    const supabase = await createServerSupabaseClient();
    const admin = createAdminClient();
    if (!supabase || !admin) {
      return NextResponse.json({ success: false, error: 'Supabase not configured' }, { status: 503 });
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const rustBackend = process.env.RUST_BACKEND_URL?.trim().replace(/\/+$/, '');
    if (rustBackend) {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
      }
      const upstream = await fetch(`${rustBackend}/v1/account/delete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: 'no-store',
      });
      const payload = await upstream.json().catch(() => ({ success: false, error: 'Account service returned an invalid response' }));
      if (!upstream.ok) return NextResponse.json(payload, { status: upstream.status });
      await supabase.auth.signOut();
      return NextResponse.json({ success: true });
    }

    await admin.from('profiles').delete().eq('auth_id', user.id);
    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }

    await supabase.auth.signOut();
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Account deletion failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Account deletion failed') },
      { status: 500 }
    );
  }
}
