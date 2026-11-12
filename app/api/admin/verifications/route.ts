import { callRustAdminRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';
import { toStage } from '@/lib/verification';

/**
 * GET  /api/admin/verifications            — review queue (filter + search)
 * GET  /api/admin/verifications?id=123      — full application file
 * POST /api/admin/verifications             — { applicationId, action, reason, internalNote }
 *
 * Reads use the service role only after the caller's role is verified with
 * their own session. Decisions go through `admin_verification_action()`, whose
 * SECURITY DEFINER body re-checks public.is_admin() — a forged request from the
 * browser can never grant a badge.
 */

type Row = Record<string, unknown>;
const REVIEWER_ROLES = new Set(['ADMIN', 'SUPER_ADMIN', 'MODERATOR']);
const DECISION_ROLES = new Set(['ADMIN', 'SUPER_ADMIN']);
const ACTIONS = new Set(['START_REVIEW', 'APPROVE', 'REJECT', 'REQUEST_INFO', 'SUSPEND', 'REVOKE', 'EXPIRE', 'NOTE']);

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

async function reviewer() {
  const supabase = await createServerSupabaseClient();
  if (!supabase) return { error: NextResponse.json({ success: false, error: 'Supabase not configured' }, { status: 503 }) };
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) };

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, role, full_name')
    .eq('auth_id', user.id)
    .maybeSingle();

  if (!profile || !REVIEWER_ROLES.has(String(profile.role))) {
    return { error: NextResponse.json({ success: false, error: 'Admin access required' }, { status: 403 }) };
  }
  return { supabase, profile };
}

function applicationSummary(row: Row) {
  return {
    id: Number(row.id),
    stage: toStage(String(row.status || 'DRAFT')),
    rawStatus: String(row.status || 'DRAFT'),
    sellerType: row.seller_type === 'BUSINESS' || row.application_kind === 'BUSINESS' ? 'BUSINESS' : 'INDIVIDUAL',
    legalName: str(row.full_name),
    sellerId: Number(row.user_id),
    storeName: str(row.store_name),
    state: str(row.residence_state),
    city: str(row.residence_city),
    submittedAt: row.submitted_at ? String(row.submitted_at) : '',
    reviewStartedAt: row.review_started_at ? String(row.review_started_at) : '',
    decidedAt: row.decided_at ? String(row.decided_at) : '',
    expiresAt: row.expires_at ? String(row.expires_at) : '',
    createdAt: row.created_at ? String(row.created_at) : '',
    reviewedBy: row.reviewed_by ? Number(row.reviewed_by) : null,
    rejectionReason: str(row.rejection_reason || row.status_reason),
    infoRequestNote: str(row.info_request_note),
  };
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await reviewer();
    if ('error' in ctx) return ctx.error;

    const admin = createAdminClient();
    if (!admin) {
      return NextResponse.json({ success: false, error: 'Server storage not configured' }, { status: 503 });
    }

    const id = Number(req.nextUrl.searchParams.get('id'));

    if (Number.isFinite(id) && id > 0) {
      const { data: application, error } = await admin
        .from('identity_verifications')
        .select('*')
        .eq('id', id)
        .maybeSingle();

      if (error || !application) {
        return NextResponse.json({ success: false, error: 'Application not found' }, { status: 404 });
      }

      const [{ data: seller }, { data: store }, { data: documents }, { data: events }, { data: history }] =
        await Promise.all([
          admin
            .from('profiles')
            .select('id, full_name, username, email, phone_number, role, state, city, created_at, is_suspended, verification_status, verified_at')
            .eq('id', application.user_id)
            .maybeSingle(),
          admin
            .from('businesses')
            .select('id, name, description, city, state, address, contact_phone, contact_email, logo_url, policies, is_verified, seller_type')
            .eq('owner_id', application.user_id)
            .order('id')
            .limit(1)
            .maybeSingle(),
          admin
            .from('verification_documents')
            .select('id, slot, label, mime_type, size_bytes, uploaded_at')
            .eq('application_id', id)
            .order('uploaded_at'),
          admin
            .from('verification_events')
            .select('id, action, from_status, to_status, reason, internal_note, admin_id, created_at, is_internal')
            .eq('application_id', id)
            .order('created_at', { ascending: false })
            .limit(80),
          admin
            .from('identity_verifications')
            .select('id, status, seller_type, submitted_at, decided_at, created_at, rejection_reason')
            .eq('user_id', application.user_id)
            .in('application_kind', ['SELLER', 'BUSINESS'])
            .order('id', { ascending: false })
            .limit(10),
        ]);

      return NextResponse.json({
        success: true,
        application: {
          ...applicationSummary(application as Row),
          // Masked reference only — the full number lives on the document image.
          documentType: str(application.document_type),
          documentNumberMasked: str(application.document_number),
          dateOfBirth: application.date_of_birth ? String(application.date_of_birth) : '',
          phone: str(application.contact_phone),
          email: str(application.contact_email),
          address: str(application.residence_address),
          businessName: str(application.business_name),
          businessRegistrationNumber: str(application.business_registration_number),
          businessContactName: str(application.business_contact_name),
          businessAddress: str(application.business_address),
          storeDescription: str(application.store_description),
          storeCity: str(application.store_city),
          storeState: str(application.store_state),
          storePhone: str(application.store_phone),
          declarationAcceptedAt: application.declaration_accepted_at
            ? String(application.declaration_accepted_at)
            : '',
        },
        seller: seller || null,
        store: store || null,
        documents: (documents || []).map((doc) => ({
          id: Number(doc.id),
          slot: String(doc.slot),
          label: str(doc.label),
          mimeType: str(doc.mime_type),
          sizeBytes: Number(doc.size_bytes || 0),
          uploadedAt: doc.uploaded_at ? String(doc.uploaded_at) : '',
        })),
        events: (events || []).map((event) => ({
          id: Number(event.id),
          action: String(event.action),
          fromStatus: String(event.from_status || ''),
          toStatus: String(event.to_status || ''),
          reason: str(event.reason),
          internalNote: str(event.internal_note),
          adminId: event.admin_id ? Number(event.admin_id) : null,
          createdAt: event.created_at ? String(event.created_at) : '',
          isInternal: Boolean(event.is_internal),
        })),
        history: (history || []).map((entry) => ({
          ...applicationSummary(entry as Row),
          documentType: '',
          documentNumberMasked: '',
          phone: '',
          email: '',
          address: '',
          businessName: '',
          businessRegistrationNumber: '',
          businessContactName: '',
          businessAddress: '',
          storeDescription: '',
          storeCity: '',
          storeState: '',
          storePhone: '',
          declarationAcceptedAt: '',
        })),
        canDecide: DECISION_ROLES.has(String(ctx.profile.role)),
      });
    }

    const status = String(req.nextUrl.searchParams.get('status') || 'ALL').toUpperCase();
    const search = String(req.nextUrl.searchParams.get('q') || '').trim().toLowerCase();

    let query = admin
      .from('identity_verifications')
      .select('*')
      .in('application_kind', ['SELLER', 'BUSINESS'])
      .order('created_at', { ascending: false })
      .limit(300);

    if (status !== 'ALL') {
      query = status === 'VERIFIED' ? query.eq('status', 'APPROVED') : query.eq('status', status);
    }

    const { data: rows, error } = await query;
    if (error) {
      logger.error('admin verification list failed', { message: error.message });
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    const sellerIds = Array.from(new Set((rows || []).map((row) => Number(row.user_id))));
    const { data: sellers } = sellerIds.length
      ? await admin
          .from('profiles')
          .select('id, full_name, username, email, phone_number, role, state, city, verification_status, verified_at, is_suspended')
          .in('id', sellerIds)
      : { data: [] as Row[] };
    const sellerMap = new Map((sellers || []).map((seller) => [Number(seller.id), seller]));

    const applications = (rows || []).map((row) => {
      const summary = applicationSummary(row as Row);
      const seller = sellerMap.get(summary.sellerId);
      return {
        ...summary,
        sellerName: seller ? str(seller.full_name) : summary.legalName,
        sellerUsername: seller ? str(seller.username) : '',
        sellerEmail: seller ? str(seller.email) : '',
        sellerPhone: seller ? str(seller.phone_number) : '',
        sellerRole: seller ? str(seller.role) : '',
        accountVerificationStatus: seller ? str(seller.verification_status) : '',
        accountSuspended: Boolean(seller?.is_suspended),
      };
    });

    const filtered = search
      ? applications.filter((application) =>
          [
            application.legalName,
            application.sellerName,
            application.sellerUsername,
            application.sellerEmail,
            application.storeName,
            application.city,
            application.state,
          ]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(search))
        )
      : applications;

    const counts = applications.reduce<Record<string, number>>((acc, application) => {
      acc[application.rawStatus] = (acc[application.rawStatus] || 0) + 1;
      return acc;
    }, {});

    return NextResponse.json({
      success: true,
      applications: filtered,
      counts,
      total: filtered.length,
      canDecide: DECISION_ROLES.has(String(ctx.profile.role)),
    });
  } catch (error) {
    logger.error('admin verification GET failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not load verifications.') },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await reviewer();
    if ('error' in ctx) return ctx.error;

    const limited = rateLimit(`admin-verification:${ctx.profile.id}:${clientIpFromRequest(req)}`, 40, 60_000);
    if (!limited.allowed) {
      return NextResponse.json({ success: false, error: 'Too many decisions. Slow down.' }, { status: 429 });
    }

    const body = await req.json().catch(() => null);
    const applicationId = Number(body?.applicationId);
    const action = String(body?.action || '').toUpperCase();

    // Moderators may keep internal notes, but never change a decision.
    if (!DECISION_ROLES.has(String(ctx.profile.role)) && action !== 'NOTE') {
      return NextResponse.json(
        { success: false, error: 'Only ADMIN or SUPER_ADMIN can change a verification decision.' },
        { status: 403 }
      );
    }
    const reason = str(body?.reason).slice(0, 500);
    const internalNote = str(body?.internalNote).slice(0, 500);

    if (!Number.isFinite(applicationId) || !ACTIONS.has(action)) {
      return NextResponse.json({ success: false, error: 'Invalid review action.' }, { status: 400 });
    }
    if (['REJECT', 'SUSPEND', 'REVOKE', 'REQUEST_INFO'].includes(action) && !reason) {
      return NextResponse.json({ success: false, error: 'A reason is required for this action.' }, { status: 400 });
    }

    const { data, error } = await callRustAdminRpc(ctx.supabase, 'admin_verification_action', {
      p_application_id: applicationId,
      p_action: action,
      p_reason: reason,
      p_internal_note: internalNote,
    });

    if (error) {
      logger.warn('admin verification action refused', { message: error.message, action });
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }

    return NextResponse.json({ success: true, result: data || null });
  } catch (error) {
    logger.error('admin verification POST failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not record the review.') },
      { status: 500 }
    );
  }
}
