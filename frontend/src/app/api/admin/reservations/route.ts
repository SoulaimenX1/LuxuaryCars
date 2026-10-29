
import { buildApiUrl } from '@/lib/api';
import { resolveAccessToken } from '@/lib/server-auth';
import { NextResponse } from 'next/server';

// ==========================================================
// TYPES
// ==========================================================

type AdminAction =
    | 'confirm'
    | 'approve'
    | 'reject'
    | 'archive'
    | 'restore'
    | 'cancel_unpaid'
    | 'handover'
    | 'return_refund';

// Format officiel de l'application : RES-AAAA-NNNNNN.
// La validation reste volontairement tolérante (3 à 20 caractères
// alphanumériques/tirets) afin de ne jamais bloquer une réservation
// valide stockée en base, tout en interdisant toute valeur abusive.
const RESERVATION_NUMBER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{2,19}$/;

interface DecisionBody {
    reservationNumber: string;
    action: AdminAction;
    reason?: string;
    mileageKm?: number;
    fuelLevelPct?: number;
    conditionNotes?: string;
    refundAmount?: number;
    retainedAmount?: number;
    inspectionDetails?: Record<string, unknown>;
}

// ==========================================================
// RÉCUPÉRER LE JWT HTTPONLY
// ==========================================================

async function getToken(): Promise<string | undefined> {
    return await resolveAccessToken();
}

// ==========================================================
// TRANSMETTRE LA RÉPONSE DU BACKEND
// ==========================================================

async function forwardResponse(response: Response) {
    const text = await response.text();

    if (!text) {
        return new NextResponse(null, {
            status: response.status,
        });
    }

    try {
        const data: unknown = JSON.parse(text);

        return NextResponse.json(data, {
            status: response.status,
            headers: {
                'Cache-Control': 'no-store',
            },
        });
    } catch {
        return NextResponse.json(
            { message: 'Invalid response from backend.' },
            { status: 502 },
        );
    }
}

// ==========================================================
// GET /api/admin/reservations
// ==========================================================
//
// Appelle NestJS :
//
// GET /reservations/admin/pending
//
// NestJS vérifie automatiquement le rôle ADMIN.
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
        const response = await fetch(
            buildApiUrl('/reservations/admin/all'),
            {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${token}`,
                },
                cache: 'no-store',
            },
        );

        return forwardResponse(response);
    } catch {
        return NextResponse.json(
            { message: 'Unable to load pending reservations.' },
            { status: 502 },
        );
    }
}

// ==========================================================
// PATCH /api/admin/reservations
// ==========================================================
//
// Body envoyé par le frontend :
//
// {
//   "reservationNumber": "RES-2026-000008",
//   "action": "confirm"
// }
//
// OU :
//
// {
//   "reservationNumber": "RES-2026-000008",
//   "action": "reject",
//   "reason": "Driving licence expires before the return date."
// }
//
// Le backend NestJS réalise les contrôles métier.
// ==========================================================

export async function PATCH(request: Request) {
    // --------------------------------------------------------
    // VÉRIFIER L'ORIGINE DE LA REQUÊTE
    // --------------------------------------------------------

    const origin = request.headers.get('origin');
    const fetchSite = request.headers.get('sec-fetch-site');

    if (fetchSite === 'cross-site') {
        return NextResponse.json(
            { message: 'Cross-site request rejected.' },
            { status: 403 },
        );
    }

    if (origin) {
        try {
            if (
                new URL(origin).origin !==
                new URL(request.url).origin
            ) {
                return NextResponse.json(
                    { message: 'Invalid request origin.' },
                    { status: 403 },
                );
            }
        } catch {
            return NextResponse.json(
                { message: 'Invalid request origin.' },
                { status: 403 },
            );
        }
    }

    // --------------------------------------------------------
    // AUTHENTIFICATION
    // --------------------------------------------------------

    const token = await getToken();

    if (!token) {
        return NextResponse.json(
            { message: 'Authentication required.' },
            { status: 401 },
        );
    }

    // --------------------------------------------------------
    // LIRE LE BODY JSON
    // --------------------------------------------------------

    if (
        !request.headers
            .get('content-type')
            ?.includes('application/json')
    ) {
        return NextResponse.json(
            { message: 'JSON body required.' },
            { status: 415 },
        );
    }

    let input: unknown;

    try {
        input = await request.json();
    } catch {
        return NextResponse.json(
            { message: 'Invalid JSON request.' },
            { status: 400 },
        );
    }

    if (
        typeof input !== 'object' ||
        input === null ||
        Array.isArray(input)
    ) {
        return NextResponse.json(
            { message: 'Invalid decision data.' },
            { status: 400 },
        );
    }

    const body = input as Record<string, unknown>;

    const reservationNumber = body.reservationNumber;
    const action = body.action;
    const reason = body.reason;

    // --------------------------------------------------------
    // VALIDER LE NUMÉRO DE RÉSERVATION
    // --------------------------------------------------------

    if (
        typeof reservationNumber !== 'string' ||
        !RESERVATION_NUMBER_PATTERN.test(reservationNumber)
    ) {
        return NextResponse.json(
            { message: 'Invalid reservation number.' },
            { status: 400 },
        );
    }

    // --------------------------------------------------------
    // VALIDER L'ACTION
    // --------------------------------------------------------

    if (
        action !== 'confirm' &&
        action !== 'approve' &&
        action !== 'reject' &&
        action !== 'archive' &&
        action !== 'restore' &&
        action !== 'cancel_unpaid' &&
        action !== 'handover' &&
        action !== 'return_refund'
    ) {
        return NextResponse.json(
            { message: 'Invalid administrator action.' },
            { status: 400 },
        );
    }

    // --------------------------------------------------------
    // VALIDER LE MOTIF DE REFUS
    // --------------------------------------------------------

    if (action === 'reject') {
        if (
            typeof reason !== 'string' ||
            reason.trim().length < 5 ||
            reason.trim().length > 500
        ) {
            return NextResponse.json(
                {
                    message:
                        'Rejection reason must contain 5 to 500 characters.',
                },
                { status: 400 },
            );
        }
    }

    const decision: DecisionBody = {
        reservationNumber,
        action,
    };

    if (action === 'reject' && typeof reason === 'string') {
        decision.reason = reason.trim();
    }

    // --------------------------------------------------------
    // CONTACTER LE BACKEND NESTJS
    // --------------------------------------------------------

    try {
        let endpoint: string;
        let method = 'PATCH';
        let payload: Record<string, unknown> | undefined = undefined;

        if (action === 'handover') {
            endpoint = buildApiUrl(`/finance/stripe/admin/handover/${encodeURIComponent(reservationNumber)}`);
            method = 'POST';
            payload = {
                notes: body.notes || body.conditionNotes,
                mileageKm: body.mileageKm,
                fuelLevelPct: body.fuelLevelPct,
            };
        } else if (action === 'return_refund') {
            endpoint = buildApiUrl(`/finance/stripe/admin/return-refund/${encodeURIComponent(reservationNumber)}`);
            method = 'POST';
            payload = {
                refundAmount: body.refundAmount,
                retainedAmount: body.retainedAmount,
                reason: body.reason,
                evidenceNotes: body.evidenceNotes,
                excessDamageAmount: body.excessDamageAmount,
                inspectionDetails: body.inspectionDetails,
            };
        } else if (action === 'approve' || action === 'confirm') {
            endpoint = buildApiUrl(`/reservations/admin/by-number/${encodeURIComponent(reservationNumber)}/approve`);
            method = 'PATCH';
        } else if (action === 'cancel_unpaid') {
            endpoint = buildApiUrl(`/reservations/admin/by-number/${encodeURIComponent(reservationNumber)}/cancel-unpaid`);
            method = 'PATCH';
        } else if (action === 'reject') {
            endpoint = buildApiUrl(`/reservations/admin/by-number/${encodeURIComponent(reservationNumber)}/reject`);
            method = 'PATCH';
            payload = { reason: decision.reason };
        } else {
            endpoint = buildApiUrl(`/reservations/admin/by-number/${encodeURIComponent(reservationNumber)}/${action}`);
            method = 'PATCH';
        }

        const response = await fetch(endpoint, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                ...(payload ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(payload ? { body: JSON.stringify(payload) } : {}),
            cache: 'no-store',
        });

        return forwardResponse(response);
    } catch (error) {
        // Le backend n'a pas pu être joint (par exemple pendant un
        // redémarrage du serveur en développement). On renvoie un
        // message clair plutôt qu'une erreur opaque.
        console.error(
            '[admin/reservations] decision proxy failed:',
            error,
        );

        return NextResponse.json(
            {
                message:
                    'The reservation service is temporarily unavailable. Please try again in a moment.',
            },
            { status: 502 },
        );
    }
}

// ==========================================================
// DELETE /api/admin/reservations?reservationNumber=RES-...
// ==========================================================
//
// Supprime définitivement une réservation annulée.
//
// Le numéro est passé en paramètre de requête afin de garder un
// DELETE sans corps. Le backend NestJS vérifie le statut de la
// réservation et refuse toute réservation non annulée.
// ==========================================================

export async function DELETE(request: Request) {
    // --------------------------------------------------------
    // VÉRIFIER L'ORIGINE DE LA REQUÊTE
    // --------------------------------------------------------

    const origin = request.headers.get('origin');
    const fetchSite = request.headers.get('sec-fetch-site');

    if (fetchSite === 'cross-site') {
        return NextResponse.json(
            { message: 'Cross-site request rejected.' },
            { status: 403 },
        );
    }

    if (origin) {
        try {
            if (
                new URL(origin).origin !==
                new URL(request.url).origin
            ) {
                return NextResponse.json(
                    { message: 'Invalid request origin.' },
                    { status: 403 },
                );
            }
        } catch {
            return NextResponse.json(
                { message: 'Invalid request origin.' },
                { status: 403 },
            );
        }
    }

    // --------------------------------------------------------
    // AUTHENTIFICATION
    // --------------------------------------------------------

    const token = await getToken();

    if (!token) {
        return NextResponse.json(
            { message: 'Authentication required.' },
            { status: 401 },
        );
    }

    // --------------------------------------------------------
    // VALIDER LE NUMÉRO DE RÉSERVATION
    // --------------------------------------------------------

    const reservationNumber = new URL(request.url).searchParams.get(
        'reservationNumber',
    );

    if (
        typeof reservationNumber !== 'string' ||
        !RESERVATION_NUMBER_PATTERN.test(reservationNumber)
    ) {
        return NextResponse.json(
            { message: 'Invalid reservation number.' },
            { status: 400 },
        );
    }

    // --------------------------------------------------------
    // CONTACTER LE BACKEND NESTJS
    // --------------------------------------------------------

    try {
        const endpoint = buildApiUrl(
            `/reservations/admin/by-number/${encodeURIComponent(
                reservationNumber,
            )}`,
        );

        const response = await fetch(endpoint, {
            method: 'DELETE',
            headers: {
                Authorization: `Bearer ${token}`,
            },
            cache: 'no-store',
        });

        return forwardResponse(response);
    } catch (error) {
        console.error(
            '[admin/reservations] delete proxy failed:',
            error,
        );

        return NextResponse.json(
            {
                message:
                    'The reservation service is temporarily unavailable. Please try again in a moment.',
            },
            { status: 502 },
        );
    }
}

