import { resolveAccessToken } from '@/lib/server-auth';
import {NextResponse} from 'next/server';
import {buildApiUrl} from '@/lib/api';

type Context = {params: Promise<{mediaId: string}>};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function forward(request: Request, context: Context, method: 'DELETE' | 'PATCH') {
    const {mediaId} = await context.params;
    if (!UUID.test(mediaId)) {
        return NextResponse.json({message: 'Invalid photo identifier.'}, {status: 400});
    }

    const origin = request.headers.get('origin');
    if (origin) {
        try {
            if (new URL(origin).origin !== new URL(request.url).origin) {
                return NextResponse.json({message: 'Invalid request origin.'}, {status: 403});
            }
        } catch {
            return NextResponse.json({message: 'Invalid request origin.'}, {status: 403});
        }
    }

    const token = await resolveAccessToken();
    if (!token) {
        return NextResponse.json({message: 'Authentication required.'}, {status: 401});
    }

    const endpoint = method === 'PATCH'
        ? `/vehicles/media/${encodeURIComponent(mediaId)}/primary`
        : `/vehicles/media/${encodeURIComponent(mediaId)}`;
    try {
        const response = await fetch(buildApiUrl(endpoint), {
            method,
            headers: {Authorization: `Bearer ${token}`},
            cache: 'no-store',
        });
        const text = await response.text();
        if (!text) {
            return new NextResponse(null, {status: response.status});
        }
        try {
            return NextResponse.json(JSON.parse(text) as unknown, {status: response.status});
        } catch {
            return NextResponse.json({message: 'Invalid response from vehicle service.'}, {status: 502});
        }
    } catch {
        return NextResponse.json({message: 'Unable to update vehicle photograph.'}, {status: 502});
    }
}

export async function DELETE(request: Request, context: Context) {
    return forward(request, context, 'DELETE');
}

export async function PATCH(request: Request, context: Context) {
    return forward(request, context, 'PATCH');
}
