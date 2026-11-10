import { buildApiUrl } from '@/lib/api';
import { resolveAccessToken } from '@/lib/server-auth';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const token = await resolveAccessToken();
  if (!token) {
    return NextResponse.json(
      { message: 'Authentication required.' },
      { status: 401 },
    );
  }

  const url = new URL(request.url);
  const params = new URLSearchParams();
  const severity = url.searchParams.get('severity');
  const category = url.searchParams.get('category');
  const includeResolved = url.searchParams.get('includeResolved');

  if (severity) params.set('severity', severity);
  if (category) params.set('category', category);
  if (includeResolved) params.set('includeResolved', includeResolved);

  const queryString = params.toString();
  const targetUrl = buildApiUrl(
    `/dashboard/admin/operations-risk/overview${queryString ? `?${queryString}` : ''}`,
  );

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      cache: 'no-store',
    });

    const payload: unknown = await response.json().catch(() => null);
    return NextResponse.json(
      payload ?? { message: 'Invalid operations risk response.' },
      {
        status: response.status,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  } catch {
    return NextResponse.json(
      { message: 'Unable to load operations risk monitor.' },
      {
        status: 502,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  }
}
