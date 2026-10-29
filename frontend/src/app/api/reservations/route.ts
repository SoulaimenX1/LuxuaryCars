import { resolveAccessToken } from '@/lib/server-auth';
import { NextResponse } from 'next/server';
import { buildApiUrl } from '@/lib/api';

// ==========================================================
// API NEXT.JS POUR LES RÉSERVATIONS
// GET  /api/reservations => GET  /reservations/me (NestJS)
// POST /api/reservations => POST /reservations    (NestJS, agency-only)
// ==========================================================

interface CreateReservationBody {
  vehicleId: string;
  pickupDate?: string;
  returnDate?: string;
  pickupAt?: string;
  returnAt?: string;
  customerNotes?: string;
  extraIds?: string[];
  promotionCode?: string;
  quoteId?: string;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Un instant ISO valide (date + heure), rejeté s'il n'est pas
// réversible (ex. 2026-02-31).
function isValidInstant(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return false;
  return !Number.isNaN(new Date(value).getTime());
}

// Récupérer le JWT exclusivement côté serveur.
async function getToken(): Promise<string | undefined> {
  return await resolveAccessToken();
}

// Refuser un POST venant d'une autre origine (protection CSRF simple).
function hasInvalidOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host !== new URL(request.url).host;
  } catch {
    return true;
  }
}

// Lire les réponses du backend et conserver leur statut HTTP.
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
      { message: 'Unexpected response from reservation service.' },
      { status: 502 },
    );
  }
}

// ==========================================================
// CONSULTER LES RÉSERVATIONS DU CLIENT CONNECTÉ
// ==========================================================
export async function GET() {
  const token = await getToken();
  if (!token) {
    return NextResponse.json(
      { message: 'Authentication required.' },
      { status: 401 },
    );
  }

  try {
    const backendResponse = await fetch(buildApiUrl('/reservations/me'), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    return forwardResponse(backendResponse);
  } catch {
    return NextResponse.json(
      { message: 'Unable to load reservations.' },
      { status: 502 },
    );
  }
}

// ==========================================================
// CRÉER UNE RÉSERVATION
// ==========================================================
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
    return NextResponse.json(
      { message: 'JSON body required.' },
      { status: 415 },
    );
  }

  // Ne jamais envoyer un body non validé directement à NestJS.
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ message: 'Invalid JSON.' }, { status: 400 });
  }

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return NextResponse.json({ message: 'Invalid reservation.' }, { status: 400 });
  }

  const body = input as Record<string, unknown>;
  const vehicleId = body.vehicleId;
  const pickupAt = body.pickupAt;
  const returnAt = body.returnAt;
  const customerNotes = body.customerNotes;
  const extraIds = body.extraIds;
  const promotionCode = body.promotionCode;
  const quoteId = body.quoteId;

  const invalidCommon =
    (customerNotes !== undefined && typeof customerNotes !== 'string') ||
    (typeof customerNotes === 'string' && customerNotes.length > 1000) ||
    (extraIds !== undefined && (!Array.isArray(extraIds) || extraIds.length > 10 || !extraIds.every(v => typeof v === 'string' && UUID.test(v)))) ||
    (promotionCode !== undefined && (typeof promotionCode !== 'string' || !/^[A-Z0-9_-]{3,30}$/.test(promotionCode))) ||
    body.pickupLocationId !== undefined ||
    body.dropoffLocationId !== undefined ||
    body.pickupMethod !== undefined ||
    body.pickupServiceMode !== undefined ||
    body.dropoffServiceMode !== undefined ||
    body.pickupDoor !== undefined ||
    body.dropoffDoor !== undefined ||
    body.deliveryAddress !== undefined ||
    body.pickupAddress !== undefined ||
    body.dropoffAddress !== undefined ||
    (quoteId !== undefined && (typeof quoteId !== 'string' || !UUID.test(quoteId)));

  // Le contrat autoritaire exige des instants precis (date + heure).
  const invalidPeriod =
    typeof pickupAt !== 'string' || typeof returnAt !== 'string' ||
    !isValidInstant(pickupAt) || !isValidInstant(returnAt) ||
    new Date(returnAt).getTime() <= new Date(pickupAt).getTime();

  if (
    typeof vehicleId !== 'string' ||
    !UUID.test(vehicleId) ||
    invalidCommon ||
    invalidPeriod
  ) {
    return NextResponse.json(
      { message: 'Invalid reservation details or rental period.' },
      { status: 400 },
    );
  }

  // Ne transmettre que les champs compatibles avec une réservation en agence.
  const payload: CreateReservationBody = {
    vehicleId,
    pickupAt: pickupAt as string,
    returnAt: returnAt as string,
  };
  if (Array.isArray(extraIds)) payload.extraIds = extraIds as string[];
  if (typeof promotionCode === 'string') payload.promotionCode = promotionCode;
  if (typeof quoteId === 'string') payload.quoteId = quoteId;
  if (typeof customerNotes === 'string' && customerNotes.trim()) {
    payload.customerNotes = customerNotes.trim();
  }

  try {
    const backendResponse = await fetch(buildApiUrl('/reservations'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      cache: 'no-store',
    });

    // Le backend décide de la disponibilité et du prix final.
    return forwardResponse(backendResponse);
  } catch {
    return NextResponse.json(
      { message: 'Reservation service is currently unavailable.' },
      { status: 502 },
    );
  }
}
