import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger, publicErrorMessage } from '@/lib/logger';

type ProfilePatch = {
  fullName?: string;
  email?: string;
  phoneNumber?: string;
  bio?: string;
  address?: string;
  city?: string;
  state?: string;
  photoUrl?: string;
  coverUrl?: string;
};

type BusinessPatch = {
  name?: string;
  description?: string;
  logoUrl?: string;
  bannerUrl?: string;
  openingHours?: string;
};

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Persists the signed-in user's profile (and, when supplied, their business
 * record) to Supabase using the service role so RLS policies can never
 * silently drop a save.
 */
export async function PATCH(request: Request) {
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

    let body: { profile?: ProfilePatch; business?: BusinessPatch } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
    }

    const rustBackend = process.env.RUST_BACKEND_URL?.trim().replace(/\/+$/, '');
    if (rustBackend) {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
      }
      const upstream = await fetch(`${rustBackend}/v1/account/profile`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
      });
      const payload = await upstream.json().catch(() => ({ success: false, error: 'Account service returned an invalid response' }));
      return NextResponse.json(payload, { status: upstream.status });
    }

    const p = body.profile ?? {};
    const profileUpdate: Record<string, string | null> = {};
    if (str(p.fullName) !== undefined) profileUpdate.full_name = p.fullName!.trim();
    if (str(p.phoneNumber) !== undefined) profileUpdate.phone_number = p.phoneNumber!.trim();
    if (str(p.bio) !== undefined) profileUpdate.bio = p.bio!.trim();
    if (str(p.address) !== undefined) profileUpdate.address = p.address!.trim();
    if (str(p.city) !== undefined) profileUpdate.city = p.city!.trim();
    if (str(p.state) !== undefined) profileUpdate.state = p.state!.trim();
    if (str(p.photoUrl) !== undefined) profileUpdate.photo_url = p.photoUrl!;
    if (str(p.coverUrl) !== undefined) profileUpdate.cover_url = p.coverUrl!;

    if (Object.keys(profileUpdate).length > 0) {
      const { error } = await admin
        .from('profiles')
        .update(profileUpdate)
        .eq('auth_id', user.id);
      if (error) {
        return NextResponse.json({ success: false, error: error.message }, { status: 400 });
      }
    }

    // Email changes go through the admin API so the account stays usable
    // without an email-confirmation round trip.
    const nextEmail = str(p.email)?.trim();
    if (nextEmail && nextEmail.toLowerCase() !== (user.email ?? '').toLowerCase()) {
      const { error } = await admin.auth.admin.updateUserById(user.id, {
        email: nextEmail,
        email_confirm: true,
      });
      if (error) {
        return NextResponse.json({ success: false, error: error.message }, { status: 400 });
      }
    }

    const b = body.business ?? {};
    const hasBusiness = Object.values(b).some((value) => str(value) !== undefined);
    if (hasBusiness) {
      const { data: profileRow } = await admin
        .from('profiles')
        .select('id')
        .eq('auth_id', user.id)
        .maybeSingle();
      const ownerId = (profileRow as { id?: number } | null)?.id;
      if (ownerId) {
        const businessUpdate: Record<string, string | null> = {};
        if (str(b.name) !== undefined) businessUpdate.name = b.name!.trim();
        if (str(b.description) !== undefined) businessUpdate.description = b.description!.trim();
        if (str(b.logoUrl) !== undefined) businessUpdate.logo_url = b.logoUrl!;
        if (str(b.bannerUrl) !== undefined) businessUpdate.banner_url = b.bannerUrl!;
        if (str(b.openingHours) !== undefined) businessUpdate.opening_hours = b.openingHours!;
        if (Object.keys(businessUpdate).length > 0) {
          const { error } = await admin.from('businesses').update(businessUpdate).eq('owner_id', ownerId);
          if (error) {
            return NextResponse.json({ success: false, error: error.message }, { status: 400 });
          }
        }
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Profile save failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not save profile') },
      { status: 500 }
    );
  }
}
