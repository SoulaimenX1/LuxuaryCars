import { NextResponse } from 'next/server';
import { buildApiUrl } from '@/lib/api';
import {
    buildBffForwardedHeaders,
    extractRetryAfterHeaders,
    parseBackendJson,
} from '@/lib/bff-headers';

// ==========================================================
// POST /api/auth/password-reset/confirm
// ==========================================================
//
// Confirme la réinitialisation du mot de passe à l'aide du
// jeton à usage unique auprès du backend NestJS
// (POST /auth/password-reset/confirm).
// ==========================================================

export async function POST(request: Request) {
    try {
        const body = await request.json();

        const backendResponse = await fetch(
            buildApiUrl('/auth/password-reset/confirm'),
            {
                method: 'POST',
                headers: buildBffForwardedHeaders(request),
                body: JSON.stringify(body),
                cache: 'no-store',
            },
        );

        const data = await parseBackendJson(
            backendResponse,
            'Unable to reset password. Please try again.',
        );
        return NextResponse.json(data, {
            status: backendResponse.status,
            headers: extractRetryAfterHeaders(backendResponse),
        });
    } catch {
        return NextResponse.json(
            {
                message:
                    'Unable to reset password. Please try again.',
            },
            { status: 500 },
        );
    }
}
