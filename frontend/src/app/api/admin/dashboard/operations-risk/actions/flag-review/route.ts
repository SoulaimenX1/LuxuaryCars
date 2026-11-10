import { buildApiUrl } from '@/lib/api';
import { resolveAccessToken } from '@/lib/server-auth';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const token = await resolveAccessToken();
  if (!token) {
    return NextResponse.json(
      { message: 'Authentication required.' },
      { status: 401 },
    );
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const targetUrl = buildApiUrl(
    '/dashboard/admin/operations-risk/actions/flag-review',
  );

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });

    const payload: unknown = await response.json().catch(() => null);
    return NextResponse.json(
      payload ?? { message: 'Invalid server response.' },
      { status: response.status },
    );
  } catch {
    return NextResponse.json(
      { message: 'Failed to flag alert for review.' },
      { status: 502 },
    );
  }
}
