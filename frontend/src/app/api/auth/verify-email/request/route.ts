import { NextResponse } from 'next/server';
import { buildApiUrl } from '@/lib/api';

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

        const backendResponse = await fetch(
            buildApiUrl('/auth/verify-email/request'),
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
                    'Unable to request verification email. Please try again.',
            },
            { status: 500 },
        );
    }
}
