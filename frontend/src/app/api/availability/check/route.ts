import { buildApiUrl } from '@/lib/api';
import { recordVehicleInterval } from '@/lib/recent-booking-dates';
import { NextResponse } from 'next/server';

// ==========================================================
// POST /api/availability/check
// ==========================================================
//
// Revalide l'intervalle complet (véhicule + agence + horaires +
// durée + conflits) avant toute écriture. Le backend NestJS est
// la seule source de vérité : le calendrier n'est qu'indicatif.

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function hasInvalidOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host !== new URL(request.url).host;
  } catch {
    return true;
  }
}

export async function POST(request: Request) {
  if (hasInvalidOrigin(request)) {
    return NextResponse.json(
      { message: 'Invalid request origin.' },
      { status: 403 },
    );
  }

  if (!request.headers.get('content-type')?.includes('application/json')) {
    return NextResponse.json({ message: 'JSON required.' }, { status: 415 });
  }

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ message: 'Invalid JSON.' }, { status: 400 });
  }

  const body = (input ?? {}) as Record<string, unknown>;
  const { vehicleId, pickupAt, returnAt } = body;
  const pickupDoor = body.pickupDoor;
  const dropoffDoor = body.dropoffDoor;

  if (
    typeof vehicleId !== 'string' ||
    !UUID.test(vehicleId) ||
    typeof pickupAt !== 'string' ||
    typeof returnAt !== 'string' ||
    body.pickupLocationId !== undefined ||
    body.dropoffLocationId !== undefined ||
    body.pickupServiceMode !== undefined ||
    body.dropoffServiceMode !== undefined ||
    pickupDoor !== undefined ||
    dropoffDoor !== undefined
  ) {
    return NextResponse.json(
      { message: 'The rental agency is determined by the assigned vehicle.' },
      { status: 400 },
    );
  }

  recordVehicleInterval(vehicleId, pickupAt, returnAt);

  try {
    const response = await fetch(buildApiUrl('/availability/check'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vehicleId,
        pickupAt,
        returnAt,
      }),
      cache: 'no-store',
    });
    const payload: unknown = await response.json();

    return NextResponse.json(payload, {
      status: response.status,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json(
      { message: 'Availability service unavailable.' },
      { status: 502 },
    );
  }
}
