import { callRustInternalRpc, callRustJob } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';

function authorized(req: NextRequest) {
  const secret = process.env.PREMIUM_CRON_SECRET || process.env.DELIVERY_CRON_SECRET;
  if (!secret) return { ok: false, status: 503 as const, error: 'PREMIUM_CRON_SECRET is not configured' };
  const header = req.headers.get('x-cron-secret') || '';
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (header !== secret && bearer !== secret) {
    return { ok: false, status: 401 as const, error: 'Unauthorized' };
  }
  return { ok: true as const };
}

async function run(req: NextRequest) {
  const auth = authorized(req);
  if (!auth.ok) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json({ success: false, error: 'Server service role is not configured' }, { status: 503 });
  }

  const premiumRun = await callRustJob<Record<string, unknown>>('run_premium_jobs', process.env.PREMIUM_CRON_SECRET || process.env.DELIVERY_CRON_SECRET || '');
  const data = premiumRun.data;
  const error = premiumRun.error;
  if (error) {
    logger.error('Premium lifecycle jobs failed', { error: error.message });
    return NextResponse.json({ success: false, error: 'Premium lifecycle jobs failed' }, { status: 500 });
  }
  const expiredRun = await callRustJob<Record<string, unknown>>('expire_unpaid_order_reservations', process.env.PREMIUM_CRON_SECRET || process.env.DELIVERY_CRON_SECRET || '');
  const expiredReservations = expiredRun.data;
  const reservationError = expiredRun.error;
  if (reservationError) {
    logger.error('Unpaid order reservation expiry failed', { error: reservationError.message });
    return NextResponse.json({ success: false, error: 'Order inventory reservations could not be expired' }, { status: 500 });
  }

  return NextResponse.json({ success: true, jobs: { ...(data || {}), unpaidInventoryReservationsReleased: expiredReservations } });
}

/** POST /api/internal/premium-jobs — scheduler entry point (secret protected). */
export async function POST(req: NextRequest) {
  try {
    return await run(req);
  } catch (error) {
    logger.error('Premium lifecycle route failed', { error: String(error) });
    return NextResponse.json({ success: false, error: 'Premium lifecycle jobs failed' }, { status: 500 });
  }
}

/** GET is supported for schedulers that only issue GET requests. */
export async function GET(req: NextRequest) {
  return POST(req);
}
