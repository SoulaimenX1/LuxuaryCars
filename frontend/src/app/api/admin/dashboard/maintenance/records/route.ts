import { buildApiUrl } from '@/lib/api';
import { resolveAccessToken } from '@/lib/server-auth';
import { NextResponse } from 'next/server';

function hasInvalidOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host !== new URL(request.url).host;
  } catch {
    return true;
  }
}

export async function POST(request: Request) {
  if (hasInvalidOrigin(request)) {
    return NextResponse.json(
      { message: 'Invalid request origin.' },
      { status: 403 },
    );
  }

  const token = await resolveAccessToken();
  if (!token) {
    return NextResponse.json(
      { message: 'Authentication required.' },
      { status: 401 },
    );
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return NextResponse.json(
      { message: 'Content-Type must be application/json.' },
      { status: 415 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { message: 'Invalid JSON payload.' },
      { status: 400 },
    );
  }

  try {
    const response = await fetch(
      buildApiUrl('/dashboard/admin/maintenance/records'),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        cache: 'no-store',
      },
    );

    const payload: unknown = await response.json().catch(() => null);
    return NextResponse.json(
      payload ?? { message: 'Invalid maintenance record response.' },
      {
        status: response.status,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  } catch {
    return NextResponse.json(
      { message: 'Unable to record maintenance activity.' },
      {
        status: 502,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  }
}
