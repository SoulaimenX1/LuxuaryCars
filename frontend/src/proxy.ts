import { NextResponse, type NextRequest } from 'next/server';
import {
    decodeJwtPayload,
    isJwtExpiredOrExpiring,
    refreshTokensDeduplicated,
    setAuthCookiesOnResponse,
     type RotatedTokens,
} from '@/lib/server-auth';

const BYPASS_REFRESH_PATHS = new Set([
    '/api/auth/login',
    '/api/auth/logout',
    '/api/auth/register',
    '/api/auth/refresh',
    '/api/auth/password-reset/request',
    '/api/auth/password-reset/confirm',
    '/api/auth/verify-email/request',
    '/api/auth/verify-email/confirm',
]);

function enforcePageRbac(
    request: NextRequest,
    effectiveToken: string | undefined,
): NextResponse | null {
    const { pathname } = request.nextUrl;

    if (pathname.startsWith('/api/')) {
        return null;
    }

    const validToken =
        effectiveToken && !isJwtExpiredOrExpiring(effectiveToken, 0)
            ? effectiveToken
            : undefined;
    const payload = decodeJwtPayload(validToken);
    const role = payload?.role;

    if (pathname === '/admin' || pathname.startsWith('/admin/')) {
        if (!validToken || !role) {
            return NextResponse.redirect(new URL('/login', request.url));
        }
        if (role === 'customer') {
            return NextResponse.redirect(new URL('/account', request.url));
        }
        if (role !== 'admin' && role !== 'staff') {
            return NextResponse.redirect(new URL('/login', request.url));
        }
        return null;
    }

    if (pathname === '/account' || pathname.startsWith('/account/')) {
        if (!validToken || !role) {
            return NextResponse.redirect(new URL('/login', request.url));
        }
        if (role === 'admin') {
            return NextResponse.redirect(new URL('/admin', request.url));
        }
        if (role === 'staff') {
            return NextResponse.redirect(
                new URL('/admin/rentals', request.url),
            );
        }
        if (role !== 'customer') {
            return NextResponse.redirect(new URL('/login', request.url));
        }
        return null;
    }

    const isCustomerBookingRoute =
        pathname === '/reservations' ||
        pathname.startsWith('/reservations/') ||
        /^\/vehicles\/[^/]+\/reserve\/?$/.test(pathname);

    if (isCustomerBookingRoute && role === 'admin') {
        return NextResponse.redirect(
            new URL('/admin/reservations', request.url),
        );
    }

    if (isCustomerBookingRoute && role === 'staff') {
        return NextResponse.redirect(new URL('/admin/rentals', request.url));
    }

    return null;
}

export async function proxy(request: NextRequest) {
    const { pathname } = request.nextUrl;

    if (BYPASS_REFRESH_PATHS.has(pathname)) {
        return NextResponse.next();
    }

    const accessToken = request.cookies.get('access_token')?.value;
    const refreshToken = request.cookies.get('refresh_token')?.value;

    let rotated: RotatedTokens | null = null;

    if (
        refreshToken &&
        (!accessToken || isJwtExpiredOrExpiring(accessToken, 30))
    ) {
        rotated = await refreshTokensDeduplicated(refreshToken);
    }

    const effectiveToken = rotated?.accessToken ?? accessToken;
    const rbacRedirect = enforcePageRbac(request, effectiveToken);

    if (rbacRedirect) {
        if (rotated) {
            setAuthCookiesOnResponse(rbacRedirect, rotated);
        }
        return rbacRedirect;
    }

    if (!rotated) {
        return NextResponse.next();
    }

    request.cookies.set('access_token', rotated.accessToken);
    request.cookies.set('refresh_token', rotated.refreshToken);

    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('cookie', request.cookies.toString());

    const response = NextResponse.next({
        request: {
            headers: requestHeaders,
        },
    });

    setAuthCookiesOnResponse(response, rotated);
    return response;
}

export const config = {
    matcher: [
        '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|woff|woff2)$).*)',
    ],
};

