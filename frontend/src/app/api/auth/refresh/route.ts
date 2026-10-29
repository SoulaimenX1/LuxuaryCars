import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import {
    clearAuthCookiesOnResponse,
    refreshTokensDeduplicated,
    setAuthCookiesOnResponse,
} from '@/lib/server-auth';

// ==========================================================
// POST /api/auth/refresh
// ==========================================================
//
// Effectue une rotation explicite du couple (access_token,
// refresh_token) à partir du cookie HttpOnly refresh_token.
// ==========================================================

export async function POST() {
    try {
        const cookieStore = await cookies();
        const refreshToken = cookieStore.get('refresh_token')?.value;

        if (!refreshToken) {
            return NextResponse.json(
                { message: 'Refresh token required.' },
                { status: 401 },
            );
        }

        const rotated = await refreshTokensDeduplicated(refreshToken);
        if (!rotated) {
            const response = NextResponse.json(
                { message: 'Invalid or expired refresh token.' },
                { status: 401 },
            );
            clearAuthCookiesOnResponse(response);
            return response;
        }

        const response = NextResponse.json(
            {
                message: 'Token refreshed successfully.',
                expiresIn: rotated.expiresIn,
                user: rotated.user ?? null,
            },
            { status: 200 },
        );

        setAuthCookiesOnResponse(response, rotated);
        return response;
    } catch {
        return NextResponse.json(
            { message: 'Unable to refresh session.' },
            { status: 500 },
        );
    }
}
