import { resolveAccessToken } from '@/lib/server-auth';
import { NextRequest, NextResponse } from 'next/server';
import { buildApiUrl } from '@/lib/api';

export async function PATCH(request: NextRequest) {
  const token = await resolveAccessToken();
  if (!token) {
    return NextResponse.json({ message: 'Authentication required.' }, { status: 401 });
  }

  try {
    const body: unknown = await request.json();

    const response = await fetch(buildApiUrl('/admin/pricing/toggle'), {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    if (!text) {
      return new NextResponse(null, { status: response.status });
    }

    const data: unknown = JSON.parse(text);
    return NextResponse.json(data, {
      status: response.status,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ message: 'Unable to update dynamic pricing setting.' }, { status: 502 });
  }
}
