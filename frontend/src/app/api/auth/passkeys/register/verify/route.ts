import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { buildApiUrl } from '@/lib/api';
import {
    buildBffForwardedHeaders,
    parseBackendJson,
} from '@/lib/bff-headers';

export async function POST(request: Request) {
    try {
        const cookieStore = await cookies();
        const accessToken = cookieStore.get('access_token')?.value;

        if (!accessToken) {
            return NextResponse.json(
                { message: 'Authentication required to complete passkey enrollment.' },
                { status: 401 },
            );
        }

        const body = await request.json();

        const backendResponse = await fetch(
            buildApiUrl('/auth/passkeys/register/verify'),
            {
                method: 'POST',
                headers: buildBffForwardedHeaders(request, {
                    Authorization: `Bearer ${accessToken}`,
                }),
                body: JSON.stringify(body),
                cache: 'no-store',
            },
        );

        const data = await parseBackendJson(
            backendResponse,
            'Failed to verify passkey registration.',
        );

        return NextResponse.json(data, { status: backendResponse.status });
    } catch {
        return NextResponse.json(
            { message: 'Unable to connect to passkey service.' },
            { status: 500 },
        );
    }
}
