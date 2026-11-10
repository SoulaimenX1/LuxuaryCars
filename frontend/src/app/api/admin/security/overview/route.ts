import { resolveAccessToken } from '@/lib/server-auth';
import { NextResponse } from 'next/server';
import { buildApiUrl } from '@/lib/api';

export async function GET() {
  const token = await resolveAccessToken();
  if (!token) {
    return NextResponse.json({ message: 'Authentication required.' }, { status: 401 });
  }

  try {
    const response = await fetch(buildApiUrl('/admin/security/overview'), {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
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
    return NextResponse.json({ message: 'Unable to load security overview.' }, { status: 502 });
  }
}
