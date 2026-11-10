import { buildApiUrl } from '@/lib/api';
import { resolveAccessToken } from '@/lib/server-auth';
import { NextResponse } from 'next/server';

export async function POST(
  request: Request,
  props: { params: Promise<{ id: string }> },
) {
  const token = await resolveAccessToken();
  if (!token) {
    return NextResponse.json(
      { message: 'Authentication required.' },
      { status: 401 },
    );
  }

  const { id } = await props.params;
  const url = new URL(request.url);

  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const licensePlate =
    url.searchParams.get('licensePlate') ||
    (typeof body.licensePlate === 'string' ? body.licensePlate : '');

  const targetUrl = buildApiUrl(
    `/dashboard/admin/pricing-demand/recommendations/${encodeURIComponent(
      id,
    )}/apply?licensePlate=${encodeURIComponent(licensePlate)}`,
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
      payload ?? { message: 'Invalid response from server.' },
      {
        status: response.status,
      },
    );
  } catch {
    return NextResponse.json(
      { message: 'Unable to apply smart pricing recommendation.' },
      { status: 502 },
    );
  }
}
