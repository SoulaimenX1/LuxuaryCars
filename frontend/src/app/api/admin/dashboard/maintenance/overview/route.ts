import { buildApiUrl } from '@/lib/api';
import { resolveAccessToken } from '@/lib/server-auth';
import { NextResponse } from 'next/server';

export async function GET() {
  const token = await resolveAccessToken();
  if (!token) {
    return NextResponse.json(
      { message: 'Authentication required.' },
      { status: 401 },
    );
  }

  try {
    const response = await fetch(
      buildApiUrl('/dashboard/admin/maintenance/overview'),
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        cache: 'no-store',
      },
    );

    const payload: unknown = await response.json().catch(() => null);
    return NextResponse.json(
      payload ?? { message: 'Invalid fleet maintenance overview response.' },
      {
        status: response.status,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  } catch {
    return NextResponse.json(
      { message: 'Unable to load fleet health & maintenance intelligence.' },
      {
        status: 502,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  }
}
