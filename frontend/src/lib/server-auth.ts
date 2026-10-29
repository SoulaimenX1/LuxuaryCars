import { cookies } from 'next/headers';
import type { NextResponse } from 'next/server';
import { buildApiUrl } from './api';

export const ACCESS_TOKEN_MAX_AGE = 60 * 15;
export const REFRESH_TOKEN_MAX_AGE = 60 * 60 * 24 * 30;

export interface RotatedTokens {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    refreshExpiresIn: number;
    user?: Record<string, unknown>;
}

interface RefreshCacheEntry {
    promise: Promise<RotatedTokens | null>;
    expiresAt: number;
}

// Déduplication en mémoire des rafraîchissements concurrents (TTL 5s)
// afin d'éviter que plusieurs requêtes parallèles du navigateur ne
// déclenchent une révocation pour réutilisation de refresh_token.
const refreshCache = new Map<string, RefreshCacheEntry>();

function pruneRefreshCache(now: number): void {
    for (const [key, entry] of refreshCache.entries()) {
        if (entry.expiresAt <= now) {
            refreshCache.delete(key);
        }
    }
}

export function isJwtExpiredOrExpiring(
    token?: string | null,
    bufferSeconds = 30,
): boolean {
    if (!token) {
        return true;
    }

    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) {
        return true;
    }

    try {
        const json = Buffer.from(parts[1], 'base64url').toString('utf8');
        const payload = JSON.parse(json) as { exp?: unknown };
        if (typeof payload.exp !== 'number') {
            return false;
        }
        return payload.exp * 1000 <= Date.now() + bufferSeconds * 1000;
    } catch {
        return true;
    }
}

async function performBackendRefresh(
    refreshToken: string,
): Promise<RotatedTokens | null> {
    try {
        const response = await fetch(buildApiUrl('/auth/refresh'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ refreshToken }),
            cache: 'no-store',
        });

        if (!response.ok) {
            return null;
        }

        const data = (await response.json()) as {
            accessToken?: unknown;
            refreshToken?: unknown;
            access_token?: unknown;
            refresh_token?: unknown;
            expiresIn?: unknown;
            refreshExpiresIn?: unknown;
            user?: Record<string, unknown>;
        };

        const nextAccessToken =
            typeof data.accessToken === 'string'
                ? data.accessToken
                : typeof data.access_token === 'string'
                  ? data.access_token
                  : null;
        const nextRefreshToken =
            typeof data.refreshToken === 'string'
                ? data.refreshToken
                : typeof data.refresh_token === 'string'
                  ? data.refresh_token
                  : null;

        if (
            nextAccessToken &&
            nextAccessToken.length > 0 &&
            nextRefreshToken &&
            nextRefreshToken.length > 0
        ) {
            return {
                accessToken: nextAccessToken,
                refreshToken: nextRefreshToken,
                expiresIn:
                    typeof data.expiresIn === 'number'
                        ? data.expiresIn
                        : ACCESS_TOKEN_MAX_AGE,
                refreshExpiresIn:
                    typeof data.refreshExpiresIn === 'number'
                        ? data.refreshExpiresIn
                        : REFRESH_TOKEN_MAX_AGE,
                user: data.user,
            };
        }

        return null;
    } catch {
        return null;
    }
}

export function refreshTokensDeduplicated(
    refreshToken: string,
): Promise<RotatedTokens | null> {
    const now = Date.now();
    pruneRefreshCache(now);

    const existing = refreshCache.get(refreshToken);
    if (existing && existing.expiresAt > now) {
        return existing.promise;
    }

    const promise = performBackendRefresh(refreshToken).then((result) => {
        if (!result) {
            refreshCache.delete(refreshToken);
        }
        return result;
    });

    refreshCache.set(refreshToken, {
        promise,
        expiresAt: now + 5000,
    });

    return promise;
}

export function setAuthCookiesOnResponse(
    response: NextResponse,
    tokens: {
        accessToken: string;
        refreshToken?: string;
        expiresIn?: number;
        refreshExpiresIn?: number;
    },
): void {
    const secure = process.env.NODE_ENV === 'production';

    response.cookies.set('access_token', tokens.accessToken, {
        httpOnly: true,
        secure,
        sameSite: 'lax',
        path: '/',
        maxAge: tokens.expiresIn ?? ACCESS_TOKEN_MAX_AGE,
    });

    if (tokens.refreshToken) {
        response.cookies.set('refresh_token', tokens.refreshToken, {
            httpOnly: true,
            secure,
            sameSite: 'lax',
            path: '/',
            maxAge: tokens.refreshExpiresIn ?? REFRESH_TOKEN_MAX_AGE,
        });
    }
}

export function clearAuthCookiesOnResponse(response: NextResponse): void {
    const secure = process.env.NODE_ENV === 'production';

    response.cookies.set('access_token', '', {
        httpOnly: true,
        secure,
        sameSite: 'lax',
        path: '/',
        maxAge: 0,
    });

    response.cookies.set('refresh_token', '', {
        httpOnly: true,
        secure,
        sameSite: 'lax',
        path: '/',
        maxAge: 0,
    });
}

async function persistRotatedCookiesInStore(
    tokens: RotatedTokens,
): Promise<void> {
    try {
        const cookieStore = await cookies();
        const secure = process.env.NODE_ENV === 'production';

        cookieStore.set('access_token', tokens.accessToken, {
            httpOnly: true,
            secure,
            sameSite: 'lax',
            path: '/',
            maxAge: tokens.expiresIn ?? ACCESS_TOKEN_MAX_AGE,
        });

        cookieStore.set('refresh_token', tokens.refreshToken, {
            httpOnly: true,
            secure,
            sameSite: 'lax',
            path: '/',
            maxAge: tokens.refreshExpiresIn ?? REFRESH_TOKEN_MAX_AGE,
        });
    } catch {
        // Server Components ne peuvent pas écrire directement dans cookies();
        // proxy.ts s'en charge au niveau de la requête entrante.
    }
}

/**
 * Récupère un access_token valide depuis les cookies HttpOnly, ou le
 * rafraîchit automatiquement via refresh_token s'il est absent ou expiré.
 */
export async function resolveAccessToken(): Promise<string | undefined> {
    const cookieStore = await cookies();
    const accessToken = cookieStore.get('access_token')?.value;
    const refreshToken = cookieStore.get('refresh_token')?.value;

    if (accessToken && !isJwtExpiredOrExpiring(accessToken, 30)) {
        return accessToken;
    }

    if (!refreshToken) {
        return accessToken;
    }

    const rotated = await refreshTokensDeduplicated(refreshToken);
    if (!rotated) {
        return accessToken;
    }

    await persistRotatedCookiesInStore(rotated);
    return rotated.accessToken;
}

/**
 * Exécute un appel vers le backend avec Bearer token et tente une rotation
 * automatique via refresh_token si le backend répond 401.
 */
export async function fetchBackendWithAutoRefresh(
    url: string,
    init: RequestInit = {},
): Promise<Response | null> {
    const cookieStore = await cookies();
    let accessToken = await resolveAccessToken();
    const refreshToken = cookieStore.get('refresh_token')?.value;

    if (!accessToken) {
        return null;
    }

    const buildHeaders = (token: string): Headers => {
        const headers = new Headers(init.headers);
        headers.set('Authorization', `Bearer ${token}`);
        return headers;
    };

    const firstResponse = await fetch(url, {
        ...init,
        headers: buildHeaders(accessToken),
        cache: init.cache ?? 'no-store',
    });

    if (firstResponse.status !== 401 || !refreshToken) {
        return firstResponse;
    }

    const rotated = await refreshTokensDeduplicated(refreshToken);
    if (!rotated) {
        return firstResponse;
    }

    await persistRotatedCookiesInStore(rotated);
    accessToken = rotated.accessToken;

    return fetch(url, {
        ...init,
        headers: buildHeaders(accessToken),
        cache: init.cache ?? 'no-store',
    });
}

export interface SessionUser {
    id: string;
    email: string;
    firstName?: string;
    lastName?: string;
    role: 'admin' | 'customer' | 'staff';
    status?: string;
}

export function decodeJwtPayload(
    token?: string | null,
): { sub?: string; email?: string; role?: string; exp?: number } | null {
    if (!token) {
        return null;
    }

    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) {
        return null;
    }

    try {
        const json = Buffer.from(parts[1], 'base64url').toString('utf8');
        const payload = JSON.parse(json) as {
            sub?: unknown;
            email?: unknown;
            role?: unknown;
            exp?: unknown;
        };

        return {
            sub: typeof payload.sub === 'string' ? payload.sub : undefined,
            email: typeof payload.email === 'string' ? payload.email : undefined,
            role: typeof payload.role === 'string' ? payload.role : undefined,
            exp: typeof payload.exp === 'number' ? payload.exp : undefined,
        };
    } catch {
        return null;
    }
}

/**
 * Résout l'utilisateur authentifié côté serveur (Server Components & Layouts).
 * Vérifie d'abord la session auprès du backend (/auth/me) avec rotation automatique,
 * afin d'éliminer tout clignotement d'état d'authentification à l'hydratation.
 */
export async function getServerSessionUser(): Promise<SessionUser | null> {
    try {
        const response = await fetchBackendWithAutoRefresh(
            buildApiUrl('/auth/me'),
            {
                method: 'GET',
                cache: 'no-store',
            },
        );

        if (!response || !response.ok) {
            return null;
        }

        const raw = (await response.json()) as {
            user?: Record<string, unknown>;
            id?: unknown;
            email?: unknown;
            firstName?: unknown;
            lastName?: unknown;
            role?: unknown;
            status?: unknown;
        };

        const data = (raw.user ?? raw) as Record<string, unknown>;
        const role = data.role;

        if (
            typeof data.id === 'string' &&
            typeof data.email === 'string' &&
            (role === 'admin' || role === 'customer' || role === 'staff')
        ) {
            return {
                id: data.id,
                email: data.email,
                firstName:
                    typeof data.firstName === 'string'
                        ? data.firstName
                        : undefined,
                lastName:
                    typeof data.lastName === 'string'
                        ? data.lastName
                        : undefined,
                role,
                status:
                    typeof data.status === 'string' ? data.status : undefined,
            };
        }

        return null;
    } catch {
        return null;
    }
}

