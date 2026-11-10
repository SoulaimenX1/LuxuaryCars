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
                { message: 'Authentication required to enroll a passkey.' },
                { status: 401 },
            );
        }

        const backendResponse = await fetch(
            buildApiUrl('/auth/passkeys/register/options'),
            {
                method: 'POST',
                headers: buildBffForwardedHeaders(request, {
                    Authorization: `Bearer ${accessToken}`,
                }),
                cache: 'no-store',
            },
        );

        const data = await parseBackendJson(
            backendResponse,
            'Failed to generate passkey registration options.',
        );

        return NextResponse.json(data, { status: backendResponse.status });
    } catch {
        return NextResponse.json(
            { message: 'Unable to connect to passkey service.' },
            { status: 500 },
        );
    }
}
