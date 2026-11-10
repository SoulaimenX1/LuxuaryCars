import { NextResponse } from 'next/server';
import { buildApiUrl } from '@/lib/api';
import {
    buildBffForwardedHeaders,
    parseBackendJson,
} from '@/lib/bff-headers';

interface BackendPasskeyLoginResponse {
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
        const body = await request.json();

        const backendResponse = await fetch(
            buildApiUrl('/auth/passkeys/authenticate/verify'),
            {
                method: 'POST',
                headers: buildBffForwardedHeaders(request),
                body: JSON.stringify(body),
                cache: 'no-store',
            },
        );

        const data = await parseBackendJson<BackendPasskeyLoginResponse>(
            backendResponse,
            'Passkey verification failed.',
        );

        if (!backendResponse.ok) {
            return NextResponse.json(data, {
                status: backendResponse.status,
            });
        }

        if (!data.accessToken) {
            return NextResponse.json(
                { message: 'Authentication token not returned by backend.' },
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
            { message: 'Unable to connect to passkey authentication service.' },
            { status: 500 },
        );
    }
}
