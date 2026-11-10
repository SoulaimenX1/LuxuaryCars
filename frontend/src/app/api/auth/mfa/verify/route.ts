import { NextResponse } from 'next/server';
import { buildApiUrl } from '@/lib/api';
import { buildBffForwardedHeaders, parseBackendJson } from '@/lib/bff-headers';

interface MfaVerifyRequestBody {
    preAuthToken?: string;
    method: 'recovery' | 'passkey';
    code?: string;
    response?: unknown;
}

interface BackendMfaResponse {
    accessToken?: string;
    refreshToken?: string;
    expiresIn?: number;
    refreshExpiresIn?: number;
    tokenType?: string;
    user?: {
        id?: string;
        email?: string;
        firstName?: string;
        lastName?: string;
        role?: string;
    };
    message?: string | string[];
}

export async function POST(request: Request) {
    try {
        const body = (await request.json()) as MfaVerifyRequestBody;

        if (!body.preAuthToken) {
            return NextResponse.json(
                { message: 'Pre-authentication token is required.' },
                { status: 400 },
            );
        }

        const endpoint =
            body.method === 'recovery'
                ? '/auth/mfa/verify-recovery'
                : '/auth/mfa/verify-passkey';

        const backendPayload =
            body.method === 'recovery'
                ? { preAuthToken: body.preAuthToken, code: body.code }
                : { preAuthToken: body.preAuthToken, response: body.response };

        const backendResponse = await fetch(buildApiUrl(endpoint), {
            method: 'POST',
            headers: {
                ...buildBffForwardedHeaders(request),
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(backendPayload),
            cache: 'no-store',
        });

        const data = await parseBackendJson<BackendMfaResponse>(
            backendResponse,
            'Unable to complete MFA verification.',
        );

        if (!backendResponse.ok) {
            return NextResponse.json(data, {
                status: backendResponse.status,
            });
        }

        if (!data.accessToken) {
            return NextResponse.json(
                { message: 'Authentication token not returned by server.' },
                { status: 500 },
            );
        }

        const response = NextResponse.json(
            {
                user: data.user,
                tokenType: data.tokenType ?? 'Bearer',
            },
            { status: 200 },
        );

        // Secure HttpOnly session cookies
        response.cookies.set('access_token', data.accessToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            path: '/',
            maxAge: data.expiresIn ?? 30 * 24 * 60 * 60,
        });

        if (data.refreshToken) {
            response.cookies.set('refresh_token', data.refreshToken, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'lax',
                path: '/',
                maxAge: data.refreshExpiresIn ?? 30 * 24 * 60 * 60,
            });
        }

        return response;
    } catch {
        return NextResponse.json(
            { message: 'Unable to connect to MFA verification service.' },
            { status: 500 },
        );
    }
}
