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
    return NextResponse.json(
      { message: 'Authentication required' },
      { status: 401 },
    );
  }

  try {
    const response = await fetch(
      buildApiUrl(`/finance/me/reservations/by-number/${encodeURIComponent(reservationNumber)}`),
      {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      },
    );
    const text = await response.text();
    try {
      return NextResponse.json(JSON.parse(text), {
        status: response.status,
        headers: { 'Cache-Control': 'no-store' },
      });
    } catch {
      return NextResponse.json(
        { message: 'Invalid response from backend' },
        { status: 502 },
      );
    }
  } catch {
    return NextResponse.json(
      { message: 'Unable to load payment details' },
      { status: 502 },
    );
  }
}
