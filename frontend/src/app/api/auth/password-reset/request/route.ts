import { NextResponse } from 'next/server';
import { buildApiUrl } from '@/lib/api';
import {
    buildBffForwardedHeaders,
    extractRetryAfterHeaders,
    parseBackendJson,
} from '@/lib/bff-headers';

// ==========================================================
// POST /api/auth/password-reset/request
// ==========================================================
//
// Transmet la demande de réinitialisation de mot de passe au
// backend NestJS (POST /auth/password-reset/request).
// ==========================================================

export async function POST(request: Request) {
    try {
        const body = await request.json();

        const backendResponse = await fetch(
            buildApiUrl('/auth/password-reset/request'),
            {
                method: 'POST',
                headers: buildBffForwardedHeaders(request),
                body: JSON.stringify(body),
                cache: 'no-store',
            },
        );

        const data = await parseBackendJson(
            backendResponse,
            'Unable to process password reset request. Please try again.',
        );
        return NextResponse.json(data, {
            status: backendResponse.status,
            headers: extractRetryAfterHeaders(backendResponse),
        });
    } catch {
        return NextResponse.json(
            {
                message:
                    'Unable to process password reset request. Please try again.',
            },
            { status: 500 },
        );
    }
}
