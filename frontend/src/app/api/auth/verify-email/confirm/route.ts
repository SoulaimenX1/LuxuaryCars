import { NextResponse } from 'next/server';
import { buildApiUrl } from '@/lib/api';

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

        const backendResponse = await fetch(
            buildApiUrl('/auth/verify-email/confirm'),
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
                    'Unable to verify email address. Please try again.',
            },
            { status: 500 },
        );
    }
}
