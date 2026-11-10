import { NextResponse } from 'next/server';
import { buildApiUrl } from '@/lib/api';
import {
    buildBffForwardedHeaders,
    parseBackendJson,
} from '@/lib/bff-headers';

export async function POST(request: Request) {
    try {
        let body = {};
        try {
            body = await request.json();
        } catch {
            body = {};
        }

        const backendResponse = await fetch(
            buildApiUrl('/auth/passkeys/authenticate/options'),
            {
                method: 'POST',
                headers: buildBffForwardedHeaders(request),
                body: JSON.stringify(body),
                cache: 'no-store',
            },
        );

        const data = await parseBackendJson(
            backendResponse,
            'Failed to generate passkey authentication options.',
        );

        return NextResponse.json(data, { status: backendResponse.status });
    } catch {
        return NextResponse.json(
            { message: 'Unable to connect to passkey service.' },
            { status: 500 },
        );
    }
}
