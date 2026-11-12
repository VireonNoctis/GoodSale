import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';
import { clientIpFromRequest, rateLimitAsync } from '@/lib/rate-limit';

const MAX_JSON_BODY_BYTES = 1024 * 1024;
const MAX_UPLOAD_BODY_BYTES = 27 * 1024 * 1024;

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isApi = pathname.startsWith('/api/');
  const method = request.method.toUpperCase();

  if (isApi && !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(method)) {
    return NextResponse.json(
      { success: false, error: 'Method not allowed' },
      { status: 405 }
    );
  }

  // Browser-origin protection for cookie-authenticated writes. External provider
  // webhooks authenticate with their own signatures and do not use browser cookies.
  const origin = request.headers.get('origin');
  if (
    isApi &&
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) &&
    origin &&
    !(pathname.endsWith('/webhook') || pathname.startsWith('/api/webhooks/'))
  ) {
    const allowedOrigins = new Set<string>();
    for (const candidate of [
      process.env.NEXT_PUBLIC_APP_URL,
      ...(process.env.APP_ALLOWED_ORIGINS || '').split(','),
    ]) {
      if (!candidate?.trim()) continue;
      try {
        allowedOrigins.add(new URL(candidate.trim()).origin);
      } catch {
        // Ignore malformed deployment configuration; an empty set blocks writes.
      }
    }

    let requestOrigin = '';
    try {
      requestOrigin = new URL(origin).origin;
    } catch {
      requestOrigin = '';
    }

    if (!requestOrigin || !allowedOrigins.has(requestOrigin)) {
      return NextResponse.json(
        { success: false, error: 'This request origin is not allowed.' },
        { status: 403 }
      );
    }
  }

  if (isApi && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const declaredLength = Number(request.headers.get('content-length') || 0);
    const maxBytes = pathname === '/api/upload' ? MAX_UPLOAD_BODY_BYTES : MAX_JSON_BODY_BYTES;
    if (declaredLength > maxBytes) {
      return NextResponse.json(
        { success: false, error: 'Request body is larger than the allowed limit.' },
        { status: 413 }
      );
    }
  }

  // The health endpoint remains reachable when Redis is being recovered.
  if (isApi && pathname !== '/api/health' && method !== 'OPTIONS') {
    const ip = clientIpFromRequest(request);
    const route = pathname.startsWith('/api/auth/') ? 'auth' :
      pathname.startsWith('/api/payments/') ? 'payments' :
      pathname === '/api/upload' ? 'uploads' : 'api';
    const limit = route === 'auth' ? 20 : route === 'payments' ? 40 : route === 'uploads' ? 30 : 120;
    const result = await rateLimitAsync(`middleware:${route}:${ip}`, limit, 60_000);

    if (result.unavailable) {
      return NextResponse.json(
        { success: false, error: 'Request protection is temporarily unavailable. Please retry shortly.' },
        { status: 503, headers: { 'Retry-After': '2' } }
      );
    }

    if (!result.allowed) {
      return NextResponse.json(
        { success: false, error: 'Too many requests. Please retry shortly.' },
        {
          status: 429,
          headers: { 'Retry-After': String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))) },
        }
      );
    }
  }

  const response = await updateSession(request);
  // Always mint the request ID at the trusted edge; do not reflect a user-supplied ID.
  response.headers.set('x-request-id', crypto.randomUUID());
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  response.headers.set('x-frame-options', 'SAMEORIGIN');
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|uploads/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
