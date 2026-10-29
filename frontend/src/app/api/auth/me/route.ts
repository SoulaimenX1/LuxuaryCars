import {
    NextResponse,
} from 'next/server';

import {
    cookies,
} from 'next/headers';

import {
    buildApiUrl,
} from '@/lib/api';

import {
    clearAuthCookiesOnResponse,
    fetchBackendWithAutoRefresh,
} from '@/lib/server-auth';

// ==========================================================
// GET /api/auth/me
// ==========================================================
//
// Cette route récupère le JWT depuis le cookie HttpOnly.
// Si le JWT court terme a expiré mais qu'un refresh_token valide
// est présent, elle effectue une rotation transparente (dédupliquée)
// via POST /auth/refresh avant d'interroger GET /auth/me.
// ==========================================================

export async function GET() {
    try {
        const cookieStore = await cookies();
        const hasAnyToken =
            Boolean(cookieStore.get('access_token')?.value) ||
            Boolean(cookieStore.get('refresh_token')?.value);

        if (!hasAnyToken) {
            return NextResponse.json(
                {
                    message: 'Authentication required.',
                },
                {
                    status: 401,
                },
            );
        }

        const backendResponse = await fetchBackendWithAutoRefresh(
            buildApiUrl('/auth/me'),
            {
                method: 'GET',
            },
        );

        if (!backendResponse) {
            const response = NextResponse.json(
                {
                    message: 'Authentication required.',
                },
                {
                    status: 401,
                },
            );
            clearAuthCookiesOnResponse(response);
            return response;
        }

        const data = await backendResponse.json();
        const response = NextResponse.json(data, {
            status: backendResponse.status,
        });

        if (backendResponse.status === 401) {
            clearAuthCookiesOnResponse(response);
        }

        return response;
    } catch {
        return NextResponse.json(
            {
                message:
                    'Unable to retrieve the authenticated user.',
            },
            {
                status: 500,
            },
        );
    }
}
