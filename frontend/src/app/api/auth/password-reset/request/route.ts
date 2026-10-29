import { NextResponse } from 'next/server';
import { buildApiUrl } from '@/lib/api';

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
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
                cache: 'no-store',
            },
        );

        const data = await backendResponse.json();
        return NextResponse.json(data, {
            status: backendResponse.status,
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
