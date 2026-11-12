import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { callRustRpc } from '@/lib/server/rust-rpc';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimitAsync, clientIpFromRequest } from '@/lib/rate-limit';

const CATEGORIES = ['PAYMENT', 'DELIVERY', 'ACCOUNT', 'REFUND', 'SELLER_DISPUTE', 'OTHER'] as const;
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH'] as const;

export async function GET() {
  try {
    const supabase = await createServerSupabaseClient();
    if (!supabase) return NextResponse.json({ success: false, error: 'Supabase not configured' }, { status: 503 });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

    const { data, error } = await callRustRpc<Record<string, unknown>[]>(
      supabase,
      'list_my_support_tickets',
    );
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: Number(error.code) || 503 });
    return NextResponse.json({ success: true, tickets: data || [] });
  } catch (error) {
    logger.error('Support ticket list error', { error: String(error) });
    return NextResponse.json({ success: false, error: publicErrorMessage(error, 'Could not load tickets') }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const ip = clientIpFromRequest(req);
    const limited = await rateLimitAsync(`support:ticket:${ip}`, 8, 60_000);
    if (!limited.allowed) return NextResponse.json({ success: false, error: 'Too many requests' }, { status: limited.unavailable ? 503 : 429 });

    const supabase = await createServerSupabaseClient();
    if (!supabase) return NextResponse.json({ success: false, error: 'Supabase not configured' }, { status: 503 });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => null);
    const category = String(body?.category || '');
    const subject = typeof body?.subject === 'string' ? body.subject.trim().slice(0, 160) : '';
    const description = typeof body?.description === 'string' ? body.description.trim().slice(0, 10_000) : '';
    const orderId = body?.orderId == null || body.orderId === '' ? null : Number(body.orderId);
    const priority = PRIORITIES.includes(String(body?.priority) as typeof PRIORITIES[number])
      ? String(body.priority)
      : 'NORMAL';

    if (!CATEGORIES.includes(category as typeof CATEGORIES[number])) {
      return NextResponse.json({ success: false, error: 'Choose a valid category' }, { status: 400 });
    }
    if (subject.length < 4 || description.length < 10) {
      return NextResponse.json({ success: false, error: 'Subject and a 10+ character description are required' }, { status: 400 });
    }
    if (orderId !== null && (!Number.isSafeInteger(orderId) || orderId <= 0)) {
      return NextResponse.json({ success: false, error: 'Order id is invalid' }, { status: 400 });
    }

    const { data, error } = await callRustRpc<{ id: number; reference: string }>(
      supabase,
      'create_my_support_ticket',
      {
        p_category: category,
        p_subject: subject,
        p_description: description,
        p_order_id: orderId,
        p_priority: priority,
      },
    );
    if (error || !data) {
      const message = error?.message || 'Could not create ticket';
      return NextResponse.json({ success: false, error: message }, { status: Number(error?.code) || 400 });
    }
    return NextResponse.json({ success: true, ticket: data });
  } catch (error) {
    logger.error('Support ticket create error', { error: String(error) });
    return NextResponse.json({ success: false, error: publicErrorMessage(error, 'Could not create ticket') }, { status: 500 });
  }
}
