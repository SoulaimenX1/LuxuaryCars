import {
    NextResponse,
} from 'next/server';

import {
    buildApiUrl,
} from '@/lib/api';

import {
    fetchBackendWithAutoRefresh,
} from '@/lib/server-auth';

// ==========================================================
// GET /api/auth/session
// ==========================================================
//
// Variante silencieuse de /api/auth/me.
//
// Elle répond toujours 200 :
//
//   { user: { ... } }  -> utilisateur connecté (avec rotation
//                         automatique si l'access_token a expiré
//                         mais que le refresh_token est valide)
//   { user: null }     -> visiteur anonyme
//
// Cela évite les erreurs 401 dans la console du navigateur
// lorsque le header commun vérifie la session sur les pages
// publiques.
// ==========================================================

export async function GET() {
    try {
        const backendResponse =
            await fetchBackendWithAutoRefresh(
                buildApiUrl('/auth/me'),
                {
                    method: 'GET',
                },
            );

        // Aucun cookie ou refresh invalide : visiteur anonyme.
        if (!backendResponse || !backendResponse.ok) {
            return NextResponse.json(
                {
                    user: null,
                },
                {
                    status: 200,
                },
            );
        }

        const data =
            await backendResponse.json();

        return NextResponse.json(
            {
                user: data,
            },
            {
                status: 200,
            },
        );
    } catch {
        // En cas d'erreur inattendue, rester silencieux :
        // le header considère simplement l'utilisateur
        // comme anonyme.
        return NextResponse.json(
            {
                user: null,
            },
            {
                status: 200,
            },
        );
    }
}
