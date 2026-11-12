import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  const backend = process.env.RUST_BACKEND_URL?.trim().replace(/\/+$/, '');
  if (!backend) {
    return NextResponse.json(
      { success: false, error: 'Link validation service is not configured.' },
      { status: 503 }
    );
  }

  const length = Number(request.headers.get('content-length') || 0);
  if (length > 8 * 1024) {
    return NextResponse.json({ success: false, error: 'The link is too large to validate.' }, { status: 413 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body.url !== 'string' || body.url.length > 2_048) {
    return NextResponse.json({ success: false, error: 'A valid URL is required.' }, { status: 400 });
  }

  try {
    const response = await fetch(`${backend}/v1/security/validate-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: body.url }),
      cache: 'no-store',
    });
    const result = await response.json().catch(() => ({ success: false, error: 'Link validation returned an invalid response.' }));
    return NextResponse.json(result, { status: response.status });
  } catch {
    return NextResponse.json({ success: false, error: 'Link validation is temporarily unavailable.' }, { status: 503 });
  }
}
