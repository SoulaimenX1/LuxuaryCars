import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { buildApiUrl } from '@/lib/api';
import {
    buildBffForwardedHeaders,
    extractRetryAfterHeaders,
    parseBackendJson,
} from '@/lib/bff-headers';

// ==========================================================
// POST /api/auth/verify-email/request
// ==========================================================
//
// Demande l'envoi d'un nouvel e-mail de vérification auprès
// du backend NestJS (POST /auth/verify-email/request).
// ==========================================================

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const cookieStore = await cookies();
        const accessToken = cookieStore.get('access_token')?.value;

        const backendResponse = await fetch(
            buildApiUrl('/auth/verify-email/request'),
            {
                method: 'POST',
                headers: buildBffForwardedHeaders(
                    request,
                    accessToken
                        ? { Authorization: `Bearer ${accessToken}` }
                        : undefined,
                ),
                body: JSON.stringify(body),
                cache: 'no-store',
            },
        );

        const data = await parseBackendJson(
            backendResponse,
            'Unable to request verification email. Please try again.',
        );
        return NextResponse.json(data, {
            status: backendResponse.status,
            headers: extractRetryAfterHeaders(backendResponse),
        });
    } catch {
        return NextResponse.json(
            {
                message:
                    'Unable to request verification email. Please try again.',
            },
            { status: 500 },
        );
    }
}
