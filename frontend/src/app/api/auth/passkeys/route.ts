import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { buildApiUrl } from '@/lib/api';
import {
    buildBffForwardedHeaders,
    parseBackendJson,
} from '@/lib/bff-headers';

export async function GET(request: Request) {
    try {
        const cookieStore = await cookies();
        const accessToken = cookieStore.get('access_token')?.value;

        if (!accessToken) {
            return NextResponse.json(
                { message: 'Authentication required.' },
                { status: 401 },
            );
        }

        const backendResponse = await fetch(buildApiUrl('/auth/passkeys'), {
            method: 'GET',
            headers: buildBffForwardedHeaders(request, {
                Authorization: `Bearer ${accessToken}`,
            }),
            cache: 'no-store',
        });

        const data = await parseBackendJson(
            backendResponse,
            'Failed to fetch passkeys.',
        );

        return NextResponse.json(data, { status: backendResponse.status });
    } catch {
        return NextResponse.json(
            { message: 'Unable to connect to passkey service.' },
            { status: 500 },
        );
    }
}

export async function DELETE(request: Request) {
    try {
        const cookieStore = await cookies();
        const accessToken = cookieStore.get('access_token')?.value;

        if (!accessToken) {
            return NextResponse.json(
                { message: 'Authentication required.' },
                { status: 401 },
            );
        }

        const url = new URL(request.url);
        let id = url.searchParams.get('id');

        if (!id) {
            try {
                const body = await request.json();
                id = body.id;
            } catch {
                id = null;
            }
        }

        if (!id) {
            return NextResponse.json(
                { message: 'Passkey ID is required.' },
                { status: 400 },
            );
        }

        const backendResponse = await fetch(
            buildApiUrl(`/auth/passkeys/${encodeURIComponent(id)}`),
            {
                method: 'DELETE',
                headers: buildBffForwardedHeaders(request, {
                    Authorization: `Bearer ${accessToken}`,
                }),
                cache: 'no-store',
            },
        );

        const data = await parseBackendJson(
            backendResponse,
            'Failed to delete passkey.',
        );

        return NextResponse.json(data, { status: backendResponse.status });
    } catch {
        return NextResponse.json(
            { message: 'Unable to connect to passkey service.' },
            { status: 500 },
        );
    }
}
