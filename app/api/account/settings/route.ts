import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { logger, publicErrorMessage } from '@/lib/logger';

/** Namespace inside `auth.users.raw_user_meta_data` where user settings live. */
const SETTINGS_KEY = 'goodsale_settings';

/** Keys the client is allowed to persist. Anything else is ignored. */
const ALLOWED_KEYS = new Set([
  'twoFactorEnabled',
  'biometricsEnabled',
  'profileVisibility',
  'hidePhone',
  'hideEmail',
  'onlineStatus',
  'readReceipts',
  'whoCanMessage',
  'blockedUsers',
  'mutedUsers',
  'savedAddresses',
  'defaultPayment',
  'savedSearches',
  'vacationMode',
  'vacationAutoReply',
  'inventoryAlertThreshold',
  'defaultCategory',
  'defaultDeliveryMethod',
  'businessHours',
  'staffList',
  'preferredCourier',
  'safeMeetPreSel',
  'pickupAddress',
  'supportTickets',
  'redeemedVouchers',
]);

function pickAllowed(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (ALLOWED_KEYS.has(key)) out[key] = value;
  }
  return out;
}

async function loadUser() {
  const supabase = await createServerSupabaseClient();
  if (!supabase) return { supabase: null, user: null };
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

/** Returns the signed-in user's persisted settings. */
export async function GET() {
  try {
    const { supabase, user } = await loadUser();
    if (!supabase) {
      return NextResponse.json({ success: false, error: 'Supabase not configured' }, { status: 503 });
    }
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }
    const rustBackend = process.env.RUST_BACKEND_URL?.trim().replace(/\/+$/, '');
    if (rustBackend) {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
      const upstream = await fetch(`${rustBackend}/v1/account/settings`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: 'no-store',
      });
      const payload = await upstream.json().catch(() => ({ success: false, error: 'Account settings service returned an invalid response' }));
      return NextResponse.json(payload, { status: upstream.status });
    }
    const settings = (user.user_metadata?.[SETTINGS_KEY] ?? {}) as Record<string, unknown>;
    return NextResponse.json({ success: true, settings });
  } catch (error) {
    logger.error('Settings load failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not load settings') },
      { status: 500 }
    );
  }
}

/** Merges a partial settings patch into the user's metadata. */
export async function PATCH(request: Request) {
  try {
    const { supabase, user } = await loadUser();
    if (!supabase) {
      return NextResponse.json({ success: false, error: 'Supabase not configured' }, { status: 503 });
    }
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
    }

    const rustBackend = process.env.RUST_BACKEND_URL?.trim().replace(/\/+$/, '');
    if (rustBackend) {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
      const upstream = await fetch(`${rustBackend}/v1/account/settings`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
      });
      const payload = await upstream.json().catch(() => ({ success: false, error: 'Account settings service returned an invalid response' }));
      return NextResponse.json(payload, { status: upstream.status });
    }
    const patch = pickAllowed(body);
    const current = (user.user_metadata?.[SETTINGS_KEY] ?? {}) as Record<string, unknown>;
    const merged = { ...current, ...patch };

    // `updateUser` merges user_metadata server-side over the user's own session.
    const { error } = await supabase.auth.updateUser({ data: { [SETTINGS_KEY]: merged } });
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }

    return NextResponse.json({ success: true, settings: merged });
  } catch (error) {
    logger.error('Settings save failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not save settings') },
      { status: 500 }
    );
  }
}
