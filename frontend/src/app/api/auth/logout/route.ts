import {
    NextResponse,
} from 'next/server';
import {
    cookies,
} from 'next/headers';
import {
    buildApiUrl,
} from '@/lib/api';

// ==========================================================
// POST /api/auth/logout
// ==========================================================
//
// Révoque le refresh_token côté backend (s'il est présent)
// et supprime les cookies HttpOnly access_token et refresh_token.
// ==========================================================

export async function POST() {
    try {
        const cookieStore = await cookies();
        const refreshToken = cookieStore.get('refresh_token')?.value;
        if (refreshToken) {
            await fetch(buildApiUrl('/auth/logout'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refreshToken }),
                cache: 'no-store',
            }).catch(() => undefined);
        }
    } catch {
        // Non-bloquant
    }

    const response =
        NextResponse.json(
            {
                message:
                    'Logged out successfully.',
            },
            {
                status: 200,
            },
        );

    // Supprimer les cookies d'authentification.
    response.cookies.set(
        'access_token',
        '',
        {
            httpOnly: true,

            secure:
                process.env.NODE_ENV ===
                'production',

            sameSite:
                'lax',

            path:
                '/',

            maxAge:
                0,
        },
    );

    response.cookies.set(
        'refresh_token',
        '',
        {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            path: '/',
            maxAge: 0,
        },
    );

    return response;
}
