import { resolveAccessToken } from '@/lib/server-auth';
import { NextResponse } from 'next/server';
import { buildApiUrl } from '@/lib/api';

export async function POST() {
  const token = await resolveAccessToken();
  if (!token) {
    return NextResponse.json({ message: 'Authentication required.' }, { status: 401 });
  }

  try {
    const response = await fetch(buildApiUrl('/admin/communications/outbox/process'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
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
    return NextResponse.json({ message: 'Unable to trigger worker batch.' }, { status: 502 });
  }
}
