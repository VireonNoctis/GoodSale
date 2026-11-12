import { callRustInternalRpc, callRustJob } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { processDeliveryOutbox } from '@/lib/notifications/delivery-outbox';
import { logger } from '@/lib/logger';

/**
 * POST /api/internal/delivery-jobs
 * Protect with DELIVERY_CRON_SECRET. Call from a scheduler/cron every few
 * minutes. This route deliberately does not accept browser authentication.
 */
export async function POST(req: NextRequest) {
  try {
    const secret = process.env.DELIVERY_CRON_SECRET;
    if (!secret) {
      return NextResponse.json(
        { success: false, error: 'DELIVERY_CRON_SECRET is not configured' },
        { status: 503 }
      );
    }
    const header = req.headers.get('x-cron-secret') || '';
    const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (header !== secret && bearer !== secret) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const client = createAdminClient();
    if (!client) {
      return NextResponse.json({ success: false, error: 'Server service role is not configured' }, { status: 503 });
    }

    const deliveryRun = await callRustJob('run_delivery_jobs', secret);
    const data = deliveryRun.data;
    const error = deliveryRun.error;
    if (error) {
      logger.error('Delivery jobs failed', { error: error.message });
      return NextResponse.json({ success: false, error: 'Delivery jobs failed' }, { status: 500 });
    }

    // The delivery scheduler is the existing always-on heartbeat. Run the
    // premium lifecycle in the same protected tick so membership reminders,
    // credit expiry, Flash Sales and campaign completion do not need a second
    // scheduler to be configured.
    let premiumJobs: unknown = null;
    try {
      const premium = await callRustJob('run_premium_jobs', process.env.PREMIUM_CRON_SECRET || secret);
      if (premium.error) logger.warn('Premium lifecycle jobs failed', { error: premium.error.message });
      else premiumJobs = premium.data;
    } catch (premiumError) {
      logger.warn('Premium lifecycle jobs failed', { error: String(premiumError) });
    }

    let outbox;
    try {
      outbox = await processDeliveryOutbox(25);
    } catch (error) {
      logger.warn('Delivery notification outbox failed', { error: String(error) });
      outbox = { error: 'Notification outbox could not be processed' };
    }

    return NextResponse.json({ success: true, data: { jobs: data, premiumJobs, notifications: outbox } });
  } catch (error) {
    logger.error('Delivery jobs route failed', { error: String(error) });
    return NextResponse.json({ success: false, error: 'Delivery jobs failed' }, { status: 500 });
  }
}
