import { resolveAccessToken } from '@/lib/server-auth';
import { NextResponse } from 'next/server';
import { buildApiUrl } from '@/lib/api';

// Proxy for the existing admin-only backend operation
// POST /finance/stripe/admin/auto-activate (JwtAuthGuard + RolesGuard, ADMIN).
// It activates confirmed reservations whose pickup time has arrived and that
// satisfy the verified-payment and deposit rules enforced by the backend.

function isTrustedRequest(request: Request): boolean {
  if (request.headers.get('sec-fetch-site') === 'cross-site') return false;
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  if (!isTrustedRequest(request)) {
    return NextResponse.json({ message: 'Invalid request origin.' }, { status: 403 });
  }
  const accessToken = await resolveAccessToken();
  if (!accessToken) {
    return NextResponse.json({ message: 'Authentication required.' }, { status: 401 });
  }

  let response: Response;
  try {
    response = await fetch(buildApiUrl('/finance/stripe/admin/auto-activate'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json(
      { message: 'Rental service is unreachable. No rentals were activated.' },
      { status: 502 },
    );
  }

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      return NextResponse.json({ message: 'Invalid backend response.' }, { status: 502 });
    }
  }

  if (!response.ok) {
    return NextResponse.json(data ?? { message: 'Auto-activation failed.' }, {
      status: response.status,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const activatedCount =
    data && typeof data === 'object' && 'activatedCount' in data
      ? Number((data as { activatedCount: unknown }).activatedCount)
      : Number.NaN;
  if (!Number.isInteger(activatedCount) || activatedCount < 0) {
    return NextResponse.json({ message: 'Invalid backend response.' }, { status: 502 });
  }

  return NextResponse.json(
    { activatedCount },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
