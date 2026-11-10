import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { buildApiUrl } from '@/lib/api';
import {
    buildBffForwardedHeaders,
    extractRetryAfterHeaders,
    parseBackendJson,
} from '@/lib/bff-headers';

// ==========================================================
// POST /api/auth/verify-email/confirm
// ==========================================================
//
// Confirme l'adresse e-mail à l'aide du jeton à usage unique
// auprès du backend NestJS (POST /auth/verify-email/confirm).
// ==========================================================

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const cookieStore = await cookies();
        const accessToken = cookieStore.get('access_token')?.value;

        const backendResponse = await fetch(
            buildApiUrl('/auth/verify-email/confirm'),
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
            'Unable to verify email address. Please try again.',
        );
        return NextResponse.json(data, {
            status: backendResponse.status,
            headers: extractRetryAfterHeaders(backendResponse),
        });
    } catch {
        return NextResponse.json(
            {
                message:
                    'Unable to verify email address. Please try again.',
            },
            { status: 500 },
        );
    }
}
