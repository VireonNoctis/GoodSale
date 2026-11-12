import { callRustRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { logger, publicErrorMessage } from '@/lib/logger';

/** POST /api/rider/contact { deliveryId } — assigned rider only, seller phone only. */
export async function POST(req: NextRequest) {
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
    const body = await req.json().catch(() => null);
    const deliveryId = Number(body?.deliveryId);
    if (!Number.isFinite(deliveryId) || deliveryId <= 0) {
      return NextResponse.json({ success: false, error: 'A delivery is required' }, { status: 400 });
    }

    const { data, error } = await callRustRpc(supabase, 'rider_contact_seller', {
      p_delivery_id: deliveryId,
    });
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 403 });
    }
    return NextResponse.json({ success: true, data });
  } catch (error) {
    logger.error('Rider contact lookup failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not load contact') },
      { status: 500 }
    );
  }
}
