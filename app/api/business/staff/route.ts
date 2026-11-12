import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { callRustRpc } from '@/lib/server/rust-rpc';
import { logger } from '@/lib/logger';
import { rateLimitAsync, clientIpFromRequest } from '@/lib/rate-limit';
import { isStaffRole, STAFF_ROLES } from '@/lib/business/staff';

type StaffList = {
  success: boolean;
  canManage: boolean;
  businessPlan: string | null;
  expiresAt: string | null;
  staff: Array<Record<string, unknown>>;
  memberships: Array<Record<string, unknown>>;
};

async function authenticatedClient() {
  const supabase = await createServerSupabaseClient();
  if (!supabase) return { error: 'Supabase not configured', status: 503 as const };
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Unauthorized', status: 401 as const };
  return { supabase };
}

export async function GET() {
  try {
    const auth = await authenticatedClient();
    if ('error' in auth) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });
    const { data, error } = await callRustRpc<StaffList>(auth.supabase, 'list_my_business_staff');
    if (error || !data) return NextResponse.json({ success: false, error: error?.message || 'Could not load staff' }, { status: Number(error?.code) || 503 });
    return NextResponse.json(data);
  } catch (error) {
    logger.error('Staff list failed', { error: String(error) });
    return NextResponse.json({ success: false, error: 'Could not load staff access' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const limited = await rateLimitAsync(`business:staff:${clientIpFromRequest(req)}`, 20, 60_000);
    if (!limited.allowed) return NextResponse.json({ success: false, error: 'Too many requests' }, { status: limited.unavailable ? 503 : 429 });
    const auth = await authenticatedClient();
    if ('error' in auth) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });

    const body = await req.json().catch(() => null);
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const role = String(body?.role || 'ANALYST').toUpperCase();
    if (!email || email.length > 254 || !email.includes('@')) {
      return NextResponse.json({ success: false, error: 'Enter the email of an existing GoodSale account' }, { status: 400 });
    }
    if (!isStaffRole(role)) {
      return NextResponse.json({ success: false, error: `Role must be one of ${STAFF_ROLES.join(', ')}` }, { status: 400 });
    }

    const { data, error } = await callRustRpc<{ success: boolean; id: number; memberId: number }>(
      auth.supabase,
      'add_my_business_staff',
      { p_email: email, p_role: role },
    );
    if (error || !data?.success) {
      const message = error?.message || 'Could not add staff';
      const status = /no goodsale account/i.test(message) ? 404 :
        /membership/i.test(message) ? 403 :
        /yourself/i.test(message) ? 400 : Number(error?.code) || 400;
      return NextResponse.json({ success: false, error: message }, { status });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Staff add failed', { error: String(error) });
    return NextResponse.json({ success: false, error: 'Could not add staff' }, { status: 400 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const auth = await authenticatedClient();
    if ('error' in auth) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });
    const body = await req.json().catch(() => null);
    const id = Number(body?.id);
    if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ success: false, error: 'Staff id is required' }, { status: 400 });

    let role: string | null = null;
    let status: string | null = null;
    if (body?.role != null) {
      const nextRole = String(body.role).toUpperCase();
      if (!isStaffRole(nextRole)) return NextResponse.json({ success: false, error: 'Invalid role' }, { status: 400 });
      role = nextRole;
    }
    if (body?.status != null) {
      const nextStatus = String(body.status).toUpperCase();
      if (nextStatus !== 'ACTIVE' && nextStatus !== 'SUSPENDED') return NextResponse.json({ success: false, error: 'Invalid status' }, { status: 400 });
      status = nextStatus;
    }
    if (!role && !status) return NextResponse.json({ success: false, error: 'Nothing to update' }, { status: 400 });

    const { data, error } = await callRustRpc<{ success: boolean; id: number }>(
      auth.supabase,
      'update_my_business_staff',
      { p_staff_id: id, p_role: role, p_status: status },
    );
    if (error || !data?.success) {
      const message = error?.message || 'Could not update staff';
      return NextResponse.json({ success: false, error: message }, { status: /not found/i.test(message) ? 404 : Number(error?.code) || 400 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Staff update failed', { error: String(error) });
    return NextResponse.json({ success: false, error: 'Could not update staff' }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const auth = await authenticatedClient();
    if ('error' in auth) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });
    const id = Number(new URL(req.url).searchParams.get('id'));
    if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ success: false, error: 'Staff id is required' }, { status: 400 });
    const { data, error } = await callRustRpc<{ success: boolean; memberId: number }>(
      auth.supabase,
      'remove_my_business_staff',
      { p_staff_id: id },
    );
    if (error || !data?.success) {
      const message = error?.message || 'Could not remove staff';
      return NextResponse.json({ success: false, error: message }, { status: /not found/i.test(message) ? 404 : Number(error?.code) || 400 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Staff remove failed', { error: String(error) });
    return NextResponse.json({ success: false, error: 'Could not remove staff' }, { status: 400 });
  }
}
