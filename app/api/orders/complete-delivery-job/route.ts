import { callRustRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';

/** POST { jobId, pin } — courier completes delivery with buyer PIN */
export async function POST(req: NextRequest) {
  try {
    const ip = clientIpFromRequest(req);
    const limited = rateLimit(`delivery:complete:${ip}`, 15, 60_000);
    if (!limited.allowed) {
      return NextResponse.json({ success: false, error: 'Too many attempts' }, { status: 429 });
    }

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

    const body = await req.json();
    const jobId = Number(body.jobId);
    const pin = String(body.pin || '').trim();
    if (!jobId || !/^\d{4,8}$/.test(pin)) {
      return NextResponse.json({ success: false, error: 'Valid jobId and PIN required' }, { status: 400 });
    }

    const { data, error } = await callRustRpc(supabase, 'complete_delivery_job_with_pin', {
      p_job_id: jobId,
      p_pin: pin,
    });

    if (error) {
      logger.warn('complete_delivery_job_with_pin failed', { error: error.message, jobId });
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }

    return NextResponse.json({ success: true, data });
  } catch (error) {
    logger.error('Complete delivery job error', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not complete delivery') },
      { status: 500 }
    );
  }
}
