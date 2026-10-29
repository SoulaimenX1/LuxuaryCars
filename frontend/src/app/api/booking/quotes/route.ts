import { resolveAccessToken } from '@/lib/server-auth';
import { NextResponse } from 'next/server';
import { buildApiUrl } from '@/lib/api';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ==========================================================
// POST /api/booking/quotes
// ==========================================================
//
// Devis de réservation persisté côté NestJS (validité limitée,
// prix entièrement serveur, révalidé à la réservation).
// Authentification requise : le JWT est lu dans le cookie
// HttpOnly côté serveur, jamais exposé au navigateur.

function hasInvalidOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host !== new URL(request.url).host;
  } catch {
    return true;
  }
}

async function getToken(): Promise<string | undefined> {
  return await resolveAccessToken();
}

async function forwardResponse(response: Response): Promise<NextResponse> {
  const text = await response.text();
  if (!text) {
    return new NextResponse(null, { status: response.status });
  }
  try {
    const json: unknown = JSON.parse(text);
    return NextResponse.json(json, { status: response.status });
  } catch {
    return NextResponse.json(
      { message: 'Unexpected response from the quote service.' },
      { status: 502 },
    );
  }
}

export async function POST(request: Request) {
  if (hasInvalidOrigin(request)) {
    return NextResponse.json(
      { message: 'Invalid request origin.' },
      { status: 403 },
    );
  }

  const token = await getToken();
  if (!token) {
    return NextResponse.json(
      { message: 'Authentication required.' },
      { status: 401 },
    );
  }

  if (!request.headers.get('content-type')?.includes('application/json')) {
    return NextResponse.json({ message: 'JSON body required.' }, { status: 415 });
  }

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ message: 'Invalid JSON.' }, { status: 400 });
  }

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return NextResponse.json({ message: 'Invalid quote request.' }, { status: 400 });
  }

  const body = input as Record<string, unknown>;
  const forbiddenFields = [
    'pickupLocationId',
    'dropoffLocationId',
    'pickupMethod',
    'deliveryAddress',
    'pickupAddress',
    'dropoffAddress',
    'pickupServiceMode',
    'dropoffServiceMode',
    'pickupDoor',
    'dropoffDoor',
  ];
  const hasForbiddenFields = forbiddenFields.some((field) => body[field] !== undefined);
  if (
    typeof body.vehicleId !== 'string' ||
    !UUID.test(body.vehicleId) ||
    typeof body.pickupAt !== 'string' ||
    typeof body.returnAt !== 'string' ||
    hasForbiddenFields
  ) {
    return NextResponse.json(
      { message: 'Quote requires a vehicle and rental dates; the agency is assigned to the vehicle.' },
      { status: 400 },
    );
  }

  try {
    const quoteInput = {
      vehicleId: body.vehicleId,
      pickupAt: body.pickupAt,
      returnAt: body.returnAt,
      ...(Array.isArray(body.extraIds) ? { extraIds: body.extraIds } : {}),
      ...(typeof body.promotionCode === 'string' ? { promotionCode: body.promotionCode } : {}),
    };
    const backendResponse = await fetch(buildApiUrl('/booking/quotes'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(quoteInput),
      cache: 'no-store',
    });
    return forwardResponse(backendResponse);
  } catch {
    return NextResponse.json(
      { message: 'Quote service is currently unavailable.' },
      { status: 502 },
    );
  }
}
