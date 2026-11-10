import { resolveAccessToken } from '@/lib/server-auth';
import { NextResponse } from 'next/server';
import { buildApiUrl } from '@/lib/api';

// ==========================================================
// POST /api/reservations/by-number/:reservationNumber/check-in-code
// => POST /reservations/me/:reservationNumber/check-in-code
// ==========================================================

type RouteContext = {
  params: Promise<{ reservationNumber: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const { reservationNumber } = await context.params;
  const normalized = (reservationNumber || '').trim().toUpperCase();

  if (!/^RES-\d{4}-\d{6}$/.test(normalized)) {
    return NextResponse.json(
      { message: 'Invalid reservation number format.' },
      { status: 400 },
    );
  }

  const token = await resolveAccessToken();
  if (!token) {
    return NextResponse.json(
      { message: 'Authentication required.' },
      { status: 401 },
    );
  }

  try {
    const backendResponse = await fetch(
      buildApiUrl(
        `/reservations/me/${encodeURIComponent(normalized)}/check-in-code`,
      ),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
      },
    );

    const payload: unknown = await backendResponse.json().catch(() => ({}));

    if (!backendResponse.ok) {
      const msg =
        payload && typeof payload === 'object' && 'message' in payload
          ? (payload as { message: unknown }).message
          : 'Failed to issue check-in code.';
      return NextResponse.json(
        { message: Array.isArray(msg) ? msg.join(', ') : String(msg) },
        { status: backendResponse.status },
      );
    }

    return NextResponse.json(payload, { status: 200 });
  } catch {
    return NextResponse.json(
      { message: 'Showroom check-in service temporarily unavailable.' },
      { status: 502 },
    );
  }
}
