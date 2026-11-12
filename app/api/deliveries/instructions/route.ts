import { callRustRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';

/** POST /api/deliveries/instructions { deliveryId, instructions } — buyer. */
export async function POST(req: NextRequest) {
  try {
    const limited = rateLimit(`delivery:instructions:${clientIpFromRequest(req)}`, 20, 60_000);
    if (!limited.allowed) {
      return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 });
    }

    const supabase = await createServerSupabaseClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: 'Supabase not configured' }, { status: 503 });
    }
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    const deliveryId = Number(body?.deliveryId);
    const instructions = typeof body?.instructions === 'string' ? body.instructions : null;
    if (!deliveryId || instructions === null) {
      return NextResponse.json({ success: false, error: 'Invalid instructions payload' }, { status: 400 });
    }

    const { data, error } = await callRustRpc(supabase, 'delivery_set_instructions', {
      p_delivery_id: deliveryId,
      p_instructions: instructions.slice(0, 1000),
    });
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: true, data });
  } catch (error) {
    logger.error('Delivery instructions update failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not save instructions') },
      { status: 500 }
    );
  }
}
