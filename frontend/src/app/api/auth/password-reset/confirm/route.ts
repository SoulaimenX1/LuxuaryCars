import { NextResponse } from 'next/server';
import { buildApiUrl } from '@/lib/api';

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
                    'Unable to reset password. Please try again.',
            },
            { status: 500 },
        );
    }
}
