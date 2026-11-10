import { buildApiUrl } from '@/lib/api';
import { resolveAccessToken } from '@/lib/server-auth';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
    const token = await resolveAccessToken();
    if (!token) {
        return NextResponse.json(
            { message: 'Authentication required.' },
            { status: 401 },
        );
    }

    const url = new URL(request.url);
    const params = new URLSearchParams();
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const granularity = url.searchParams.get('granularity');

    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (granularity) params.set('granularity', granularity);

    const queryString = params.toString();
    const targetUrl = buildApiUrl(
        `/dashboard/admin/intelligence${queryString ? `?${queryString}` : ''}`,
    );

    try {
        const response = await fetch(targetUrl, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/json',
            },
            cache: 'no-store',
        });

        const payload: unknown = await response.json().catch(() => null);
        return NextResponse.json(
            payload ?? { message: 'Invalid intelligence response.' },
            {
                status: response.status,
                headers: { 'Cache-Control': 'no-store' },
            },
        );
    } catch {
        return NextResponse.json(
            { message: 'Unable to load executive business intelligence.' },
            {
                status: 502,
                headers: { 'Cache-Control': 'no-store' },
            },
        );
    }
}
