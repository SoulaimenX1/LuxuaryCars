import { resolveAccessToken } from '@/lib/server-auth';
import { NextRequest, NextResponse } from 'next/server';
import { buildApiUrl } from '@/lib/api';

export async function GET(request: NextRequest) {
  const token = await resolveAccessToken();
  if (!token) {
    return NextResponse.json({ message: 'Authentication required.' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const queryString = searchParams.toString();
  const targetUrl = buildApiUrl(
    `/admin/communications/outbox${queryString ? `?${queryString}` : ''}`
  );

  try {
    const response = await fetch(targetUrl, {
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
    return NextResponse.json({ message: 'Unable to load email outbox records.' }, { status: 502 });
  }
}
