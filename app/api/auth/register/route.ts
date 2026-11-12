import { callRustInternalRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { clientIpFromRequest, rateLimitAsync } from '@/lib/rate-limit';
import { logger, publicErrorMessage } from '@/lib/logger';
import {
  normalizeReferralCode,
  REFERRAL_CODE_PATTERN,
  referralIpHash,
} from '@/lib/referrals/server';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NIGERIAN_PHONE = /^(?:\+?234|0)[789]\d{9}$/;

/**
 * Auto-confirming registration.
 *
 * Email confirmation is disabled for now, so instead of `auth.signUp` (which
 * would require the user to click a confirmation link before a session exists)
 * we create the account with the service role and `email_confirm: true`. The
 * client then signs in with the password and lands straight in onboarding.
 *
 * The DB trigger `handle_new_user` still provisions the profile row from
 * `user_metadata`, so profiles behave exactly as before.
 */
export async function POST(req: NextRequest) {
  try {
    // Account creation is the most abused endpoint on any marketplace.
    const limited = await rateLimitAsync(`register:${clientIpFromRequest(req)}`, 6, 10 * 60_000);
    if (limited.unavailable) {
      return NextResponse.json({ success: false, error: 'Sign-up protection is temporarily unavailable.' }, { status: 503 });
    }
    if (!limited.allowed) {
      return NextResponse.json(
        {
          success: false,
          error: `Too many sign-up attempts. Try again in ${Math.max(
            1,
            Math.ceil(limited.retryAfterMs / 1000)
          )} seconds.`,
        },
        { status: 429 }
      );
    }

    const admin = createAdminClient();
    if (!admin) {
      return NextResponse.json(
        { success: false, error: 'Supabase is not configured on the server.' },
        { status: 503 }
      );
    }

    const body = (await req.json()) as {
      email?: string;
      password?: string;
      fullName?: string;
      username?: string;
      phoneNumber?: string;
      role?: string;
      referralCodeUsed?: string;
    };

    const email = (body.email || '').trim();
    const password = body.password || '';
    if (!email || !password) {
      return NextResponse.json(
        { success: false, error: 'Email and password are required.' },
        { status: 400 }
      );
    }
    if (!EMAIL.test(email)) {
      return NextResponse.json(
        { success: false, error: 'Enter a valid email address.' },
        { status: 400 }
      );
    }
    if (password.length < 8) {
      return NextResponse.json(
        { success: false, error: 'Password must be at least 8 characters.' },
        { status: 400 }
      );
    }
    const phone = (body.phoneNumber || '').replace(/[\s-]/g, '');
    if (phone && !NIGERIAN_PHONE.test(phone)) {
      return NextResponse.json(
        {
          success: false,
          error: 'Enter a Nigerian phone number, for example 08030001111 or +2348030001111.',
        },
        { status: 400 }
      );
    }

    const referralCode = normalizeReferralCode(body.referralCodeUsed);
    const signupIpHash = referralIpHash(req);

    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: body.fullName || '',
        username: body.username || '',
        phone_number: phone,
        role: body.role || 'BUYER',
        ...(signupIpHash ? { signup_ip_hash: signupIpHash } : {}),
      },
    });

    if (error) {
      const message = /already registered|already been registered|already exists/i.test(error.message)
        ? 'An account with that email already exists. Try signing in instead.'
        : error.message;
      return NextResponse.json({ success: false, error: message }, { status: 400 });
    }

    let referralApplied = false;
    if (data.user?.id && REFERRAL_CODE_PATTERN.test(referralCode)) {
      try {
        // The profile is created by the auth trigger. Attribution is server-only
        // and can never be changed by the browser after this point.
        const { data: profile } = await admin
          .from('profiles')
          .select('id')
          .eq('auth_id', data.user.id)
          .maybeSingle();

        if (profile?.id) {
          const { data: attributed, error: referralError } = await callRustInternalRpc(
            'attribute_referral',
            {
              p_referee_id: profile.id,
              p_code: referralCode,
              p_ip_hash: signupIpHash,
            }
          );
          if (referralError) {
            logger.warn('Referral attribution skipped', { error: referralError.message });
          } else {
            referralApplied = Boolean(
              attributed && typeof attributed === 'object' && attributed.success
            );
          }
        }
      } catch (referralError) {
        // An invalid/expired campaign must never block a real registration.
        logger.warn('Referral attribution failed', { error: String(referralError) });
      }
    }

    return NextResponse.json({
      success: true,
      userId: data.user?.id ?? null,
      referralApplied,
    });
  } catch (error) {
    logger.error('Registration route failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Registration failed') },
      { status: 500 }
    );
  }
}
