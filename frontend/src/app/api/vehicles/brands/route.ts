import { buildApiUrl } from '@/lib/api';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/vehicles/brands
 *
 * Route publique exposant les marques de la flotte et leurs logos officiels.
 * Paramètre facultatif : ?inFleet=true pour filtrer uniquement les marques avec véhicules actifs.
 */
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const inFleet = searchParams.get('inFleet');
        const query = inFleet ? `?inFleet=${encodeURIComponent(inFleet)}` : '';

        const response = await fetch(buildApiUrl(`/vehicles/brands${query}`), {
            method: 'GET',
            cache: 'no-store',
        });

        const text = await response.text();
        if (!text) {
            return new NextResponse(null, { status: response.status });
        }

        try {
            const data: unknown = JSON.parse(text);
            return NextResponse.json(data, {
                status: response.status,
                headers: {
                    'Cache-Control': 'no-store, must-revalidate',
                },
            });
        } catch {
            return NextResponse.json(
                { message: 'Invalid response from vehicles service.' },
                { status: 502 },
            );
        }
    } catch {
        return NextResponse.json(
            { message: 'Unable to retrieve vehicle brands.' },
            { status: 502 },
        );
    }
}
