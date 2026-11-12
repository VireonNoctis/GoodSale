import { callRustRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { rateLimitAsync } from '@/lib/rate-limit';
import { logger, publicErrorMessage } from '@/lib/logger';

/**
 * Guided onboarding persistence.
 *
 * Both handlers trust nothing from the browser: the account is always resolved
 * from the Supabase session cookie, and only whitelisted columns are written.
 * Buyer onboarding (purpose / location / profile / notifications) goes to
 * `profiles`; the seller store goes to `businesses`. Role upgrades still run
 * through the `set_own_role` RPC so a seller can never self-verify.
 */

type PurposePatch = {
  buying?: boolean;
  selling?: boolean;
};

type LocationPatch = {
  state?: string;
  city?: string;
  area?: string;
};

type ProfilePatch = {
  displayName?: string;
  phoneNumber?: string;
  photoUrl?: string;
};

type NotificationPatch = {
  marketplace?: boolean;
  marketing?: boolean;
  push?: boolean;
  email?: boolean;
  sms?: boolean;
};

type OnboardingPatch = {
  step?: number;
  purpose?: PurposePatch;
  location?: LocationPatch;
  profile?: ProfilePatch;
  notifications?: NotificationPatch;
  complete?: boolean;
};

type SellerStoreBody = {
  sellerType?: string;
  storeName?: string;
  description?: string;
  logoUrl?: string;
  state?: string;
  city?: string;
  area?: string;
  address?: string;
  contactPhone?: string;
  contactEmail?: string;
  policies?: string;
  step?: number;
  complete?: boolean;
};

const MAX = {
  name: 80,
  description: 2000,
  policies: 4000,
  address: 240,
  place: 80,
  phone: 24,
  email: 160,
};

function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim().slice(0, limit);
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function step(value: unknown, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  if (rounded < 0 || rounded > max) return undefined;
  return rounded;
}

const NIGERIAN_PHONE = /^(?:\+?234|0)[789]\d{9}$/;

/** Turn a missing-migration failure into something a human can act on. */
function migrationHint(message: string): string {
  if (/column .* does not exist|schema cache/i.test(message)) {
    return 'Onboarding storage is not provisioned yet. Apply supabase/migrations/023_onboarding.sql, then try again.';
  }
  return message;
}

async function resolveAccount() {
  const supabase = await createServerSupabaseClient();
  const admin = createAdminClient();
  if (!supabase || !admin) {
    return { error: 'Supabase is not configured on the server.', status: 503 } as const;
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'Sign in to continue.', status: 401 } as const;

  const { data: profile, error } = await admin
    .from('profiles')
    .select('id, role, state, city')
    .eq('auth_id', user.id)
    .maybeSingle();

  if (error) {
    return { error: migrationHint(error.message), status: 400 } as const;
  }
  if (!profile) {
    return { error: 'Your profile is still being created. Try again in a moment.', status: 409 } as const;
  }

  return {
    supabase,
    admin,
    authUserId: user.id,
    profileId: Number((profile as { id: number }).id),
    role: String((profile as { role?: string }).role || 'BUYER'),
  } as const;
}

/** Save buyer onboarding progress. Called on every step change so it resumes. */
export async function PATCH(request: NextRequest) {
  try {
    const account = await resolveAccount();
    if ('error' in account) {
      return NextResponse.json({ success: false, error: account.error }, { status: account.status });
    }

    const limited = await rateLimitAsync(`onboarding:${account.profileId}`, 90, 60_000);
    if (!limited.allowed) {
      return NextResponse.json(
        { success: false, error: 'Too many profile updates. Wait a moment and try again.' },
        { status: 429 }
      );
    }

    let body: OnboardingPatch = {};
    try {
      body = (await request.json()) as OnboardingPatch;
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid request body.' }, { status: 400 });
    }

    const update: Record<string, string | number | boolean | null> = {};

    const nextStep = step(body.step, 6);
    if (nextStep !== undefined) update.onboarding_step = nextStep;

    const purpose = body.purpose ?? {};
    const buying = bool(purpose.buying);
    const selling = bool(purpose.selling);
    if (buying !== undefined) update.wants_buying = buying;
    if (selling !== undefined) update.wants_selling = selling;
    if (buying === false && selling === false) {
      return NextResponse.json(
        { success: false, error: 'Choose at least one: buying, selling, or both.' },
        { status: 400 }
      );
    }

    const location = body.location ?? {};
    const stateName = text(location.state, MAX.place);
    const city = text(location.city, MAX.place);
    const area = text(location.area, MAX.place);
    if (stateName !== undefined) update.state = stateName;
    if (city !== undefined) update.city = city;
    if (area !== undefined) update.area = area;

    const profile = body.profile ?? {};
    const displayName = text(profile.displayName, MAX.name);
    const phoneNumber = text(profile.phoneNumber, MAX.phone);
    const photoUrl = text(profile.photoUrl, 500);
    if (displayName !== undefined) {
      if (displayName.length < 2) {
        return NextResponse.json(
          { success: false, error: 'Display name must be at least 2 characters.' },
          { status: 400 }
        );
      }
      update.full_name = displayName;
    }
    if (phoneNumber !== undefined) {
      if (phoneNumber && !NIGERIAN_PHONE.test(phoneNumber.replace(/[\s-]/g, ''))) {
        return NextResponse.json(
          {
            success: false,
            error: 'Enter a Nigerian phone number, for example 0803 000 1111 or +2348030001111.',
          },
          { status: 400 }
        );
      }
      update.phone_number = phoneNumber;
    }
    if (photoUrl !== undefined) update.photo_url = photoUrl;

    const notifications = body.notifications ?? {};
    const marketplace = bool(notifications.marketplace);
    const marketing = bool(notifications.marketing);
    const push = bool(notifications.push);
    const email = bool(notifications.email);
    const sms = bool(notifications.sms);
    if (marketplace !== undefined) update.marketplace_notifications = marketplace;
    if (marketing !== undefined) update.marketing_opt_in = marketing;
    if (push !== undefined) update.push_enabled = push;
    if (email !== undefined) update.email_enabled = email;
    if (sms !== undefined) update.sms_enabled = sms;

    if (body.complete) {
      update.onboarding_completed_at = new Date().toISOString();
      update.onboarding_step = 6;
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ success: true, updated: 0 });
    }

    const { error } = await account.admin
      .from('profiles')
      .update(update)
      .eq('id', account.profileId);

    if (error) {
      return NextResponse.json({ success: false, error: migrationHint(error.message) }, { status: 400 });
    }

    return NextResponse.json({ success: true, updated: Object.keys(update).length });
  } catch (error) {
    logger.error('Onboarding save failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not save your progress') },
      { status: 500 }
    );
  }
}

/** Create / update the signed-in seller's store. */
export async function POST(request: NextRequest) {
  try {
    const account = await resolveAccount();
    if ('error' in account) {
      return NextResponse.json({ success: false, error: account.error }, { status: account.status });
    }

    const limited = await rateLimitAsync(`seller-onboarding:${account.profileId}`, 60, 60_000);
    if (!limited.allowed) {
      return NextResponse.json(
        { success: false, error: 'Too many store updates. Wait a moment and try again.' },
        { status: 429 }
      );
    }

    let body: SellerStoreBody = {};
    try {
      body = (await request.json()) as SellerStoreBody;
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid request body.' }, { status: 400 });
    }

    const sellerType = body.sellerType === 'BUSINESS' ? 'BUSINESS' : 'INDIVIDUAL';
    const storeName = text(body.storeName, MAX.name) ?? '';
    const description = text(body.description, MAX.description);
    const logoUrl = text(body.logoUrl, 500);
    const stateName = text(body.state, MAX.place);
    const city = text(body.city, MAX.place);
    const area = text(body.area, MAX.place);
    const address = text(body.address, MAX.address);
    const contactPhone = text(body.contactPhone, MAX.phone);
    const contactEmail = text(body.contactEmail, MAX.email);
    const policies = text(body.policies, MAX.policies);
    const nextStep = step(body.step, 5);

    if (contactPhone && !NIGERIAN_PHONE.test(contactPhone.replace(/[\s-]/g, ''))) {
      return NextResponse.json(
        { success: false, error: 'Enter a Nigerian store phone number, for example 0803 000 1111.' },
        { status: 400 }
      );
    }
    if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(contactEmail)) {
      return NextResponse.json({ success: false, error: 'Enter a valid store email address.' }, { status: 400 });
    }
    if (body.complete && storeName.length < 2) {
      return NextResponse.json({ success: false, error: 'Give your store a name to finish.' }, { status: 400 });
    }
    if (body.complete && (!stateName || !city)) {
      return NextResponse.json(
        { success: false, error: 'Add your store state and city to finish.' },
        { status: 400 }
      );
    }

    const storeRow: Record<string, string | number | boolean> = {
      owner_id: account.profileId,
      seller_type: sellerType,
    };
    // A draft save before the seller names the store must not overwrite a name
    // with a placeholder later on.
    if (storeName.length >= 2) storeRow.name = storeName;
    if (description !== undefined) storeRow.description = description;
    if (logoUrl !== undefined) storeRow.logo_url = logoUrl;
    if (stateName !== undefined) storeRow.state = stateName;
    if (city !== undefined) storeRow.city = city;
    if (area !== undefined) storeRow.area = area;
    if (address !== undefined) storeRow.address = address;
    if (contactPhone !== undefined) storeRow.contact_phone = contactPhone;
    if (contactEmail !== undefined) storeRow.contact_email = contactEmail;
    if (policies !== undefined) storeRow.policies = policies;

    const { data: existing, error: findError } = await account.admin
      .from('businesses')
      .select('id')
      .eq('owner_id', account.profileId)
      .order('id', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (findError) {
      return NextResponse.json({ success: false, error: migrationHint(findError.message) }, { status: 400 });
    }

    let businessId = Number((existing as { id?: number } | null)?.id ?? 0) || null;

    if (businessId) {
      const { error: updateError } = await account.admin
        .from('businesses')
        .update(storeRow)
        .eq('id', businessId);
      if (updateError) {
        return NextResponse.json({ success: false, error: migrationHint(updateError.message) }, { status: 400 });
      }
    } else {
      const { data: created, error: insertError } = await account.admin
        .from('businesses')
        .insert({ ...storeRow, name: storeName || 'My GoodSale store' })
        .select('id')
        .single();
      if (insertError) {
        return NextResponse.json({ success: false, error: migrationHint(insertError.message) }, { status: 400 });
      }
      businessId = Number((created as { id?: number } | null)?.id ?? 0) || null;
    }

    const profileUpdate: Record<string, string | number | boolean> = {};
    if (nextStep !== undefined) profileUpdate.seller_onboarding_step = nextStep;
    if (body.complete) {
      profileUpdate.seller_onboarding_step = 5;
      profileUpdate.store_onboarding_completed_at = new Date().toISOString();
      profileUpdate.wants_selling = true;
    }

    if (Object.keys(profileUpdate).length > 0) {
      const { error: profileError } = await account.admin
        .from('profiles')
        .update(profileUpdate)
        .eq('id', account.profileId);
      if (profileError) {
        return NextResponse.json(
          { success: false, error: migrationHint(profileError.message) },
          { status: 400 }
        );
      }
    }

    // Public-tier role switch only (BUYER → SELLER/BUSINESS). Runs as the user,
    // so the database — not the browser — decides what is allowed. Verified and
    // staff roles are untouched by the RPC's WHERE clause.
    if (body.complete) {
      const { error: roleError } = await account.callRustRpc(supabase, 'set_own_role', {
        p_role: sellerType === 'BUSINESS' ? 'BUSINESS' : 'SELLER',
      });
      if (roleError) {
        logger.warn('Seller role switch skipped', { error: roleError.message });
      }
    }

    return NextResponse.json({
      success: true,
      businessId,
      completed: Boolean(body.complete),
    });
  } catch (error) {
    logger.error('Seller onboarding save failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not save your store') },
      { status: 500 }
    );
  }
}
