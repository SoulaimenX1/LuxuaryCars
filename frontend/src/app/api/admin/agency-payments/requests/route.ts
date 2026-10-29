import { resolveAccessToken } from '@/lib/server-auth';
import { NextResponse } from 'next/server';
import { buildApiUrl } from '@/lib/api';

export async function GET() {
  const token = await resolveAccessToken();
  if (!token) {
    return NextResponse.json({ message: 'Authentication required' }, { status: 401 });
  }

  try {
    const response = await fetch(
      buildApiUrl('/finance/admin/agency-payments/requests'),
      {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      },
    );

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unable to load manual payment requests';
    return NextResponse.json({ message }, { status: 502 });
  }
}
