import { resolveAccessToken } from '@/lib/server-auth';
import { NextResponse } from 'next/server';
import { buildApiUrl } from '@/lib/api';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ reservationNumber: string }> },
) {
  const { reservationNumber } = await params;
  const token = await resolveAccessToken();
  if (!token) {
    return NextResponse.json({ message: 'Authentication required' }, { status: 401 });
  }

  try {
    const response = await fetch(
      buildApiUrl(`/reservations/by-number/${encodeURIComponent(reservationNumber)}`),
      {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      },
    );

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unable to load reservation';
    return NextResponse.json(
      { message },
      { status: 502 },
    );
  }
}
