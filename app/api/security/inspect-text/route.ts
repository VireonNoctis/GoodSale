import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  const backend = process.env.RUST_BACKEND_URL?.trim().replace(/\/+$/, '');
  if (!backend) {
    return NextResponse.json(
      { success: false, error: 'Input inspection service is not configured.' },
      { status: 503 }
    );
  }

  const length = Number(request.headers.get('content-length') || 0);
  if (length > 16 * 1024) {
    return NextResponse.json({ success: false, error: 'Text is too large to inspect.' }, { status: 413 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body.text !== 'string' || body.text.length > 10_000) {
    return NextResponse.json({ success: false, error: 'A text value under 10,000 characters is required.' }, { status: 400 });
  }

  try {
    const response = await fetch(`${backend}/v1/security/inspect-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: body.text }),
      cache: 'no-store',
    });
    const result = await response.json().catch(() => ({ success: false, error: 'Inspection service returned an invalid response.' }));
    return NextResponse.json(result, { status: response.status });
  } catch {
    return NextResponse.json({ success: false, error: 'Inspection service is temporarily unavailable.' }, { status: 503 });
  }
}
