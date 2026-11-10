import { resolveAccessToken } from '@/lib/server-auth';
import { NextResponse } from 'next/server';
import { buildApiUrl } from '@/lib/api';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_LOGO_TYPES = ['image/png', 'image/webp', 'image/svg+xml', 'image/svg'];
const MAX_LOGO_SIZE = 5 * 1024 * 1024; // 5 Mo

function hasInvalidOrigin(request: Request): boolean {
    const origin = request.headers.get('origin');
    if (!origin) return false;
    try {
        return new URL(origin).origin !== new URL(request.url).origin;
    } catch {
        return true;
    }
}

/**
 * POST /api/admin/vehicles/brand-logo
 * Upload ou remplacement du logo officiel d'une marque automobile
 */
export async function POST(request: Request): Promise<NextResponse> {
    if (hasInvalidOrigin(request)) {
        return NextResponse.json({ message: 'Invalid request origin.' }, { status: 403 });
    }

    const token = await resolveAccessToken();
    if (!token) {
        return NextResponse.json({ message: 'Authentication required.' }, { status: 401 });
    }

    let form: FormData;
    try {
        form = await request.formData();
    } catch {
        return NextResponse.json({ message: 'Invalid form data.' }, { status: 400 });
    }

    const brandId = form.get('brandId');
    const file = form.get('logo');

    if (typeof brandId !== 'string' || !UUID_REGEX.test(brandId.trim())) {
        return NextResponse.json({ message: 'Valid brand UUID required.' }, { status: 400 });
    }

    if (!(file instanceof File) || file.size === 0) {
        return NextResponse.json({ message: 'Logo file required.' }, { status: 400 });
    }

    if (file.size > MAX_LOGO_SIZE) {
        return NextResponse.json({ message: 'Logo file is too large (5 MB maximum).' }, { status: 413 });
    }

    const mime = file.type.toLowerCase();
    const isSvg = file.name.toLowerCase().endsWith('.svg') || mime.includes('svg');
    const isPng = file.name.toLowerCase().endsWith('.png') || mime.includes('png');
    const isWebp = file.name.toLowerCase().endsWith('.webp') || mime.includes('webp');

    if (!isSvg && !isPng && !isWebp && !ALLOWED_LOGO_TYPES.includes(mime)) {
        return NextResponse.json(
            { message: 'Only PNG, WebP, and safe SVG files are supported.' },
            { status: 400 },
        );
    }

    const outgoing = new FormData();
    outgoing.append('logo', file, file.name || 'brand-logo');

    try {
        const response = await fetch(
            buildApiUrl(`/vehicles/brands/${encodeURIComponent(brandId.trim())}/logo`),
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                },
                body: outgoing,
                cache: 'no-store',
            },
        );

        const text = await response.text();
        if (!text) {
            return new NextResponse(null, { status: response.status });
        }

        try {
            return NextResponse.json(JSON.parse(text) as unknown, { status: response.status });
        } catch {
            return NextResponse.json(
                { message: 'Invalid response from vehicle service.' },
                { status: 502 },
            );
        }
    } catch {
        return NextResponse.json(
            { message: 'Unable to upload brand logo.' },
            { status: 502 },
        );
    }
}

/**
 * DELETE /api/admin/vehicles/brand-logo?brandId=<uuid>
 * Suppression du logo officiel d'une marque automobile
 */
export async function DELETE(request: Request): Promise<NextResponse> {
    if (hasInvalidOrigin(request)) {
        return NextResponse.json({ message: 'Invalid request origin.' }, { status: 403 });
    }

    const token = await resolveAccessToken();
    if (!token) {
        return NextResponse.json({ message: 'Authentication required.' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const brandId = searchParams.get('brandId')?.trim();

    if (!brandId || !UUID_REGEX.test(brandId)) {
        return NextResponse.json({ message: 'Valid brand UUID required.' }, { status: 400 });
    }

    try {
        const response = await fetch(
            buildApiUrl(`/vehicles/brands/${encodeURIComponent(brandId)}/logo`),
            {
                method: 'DELETE',
                headers: {
                    Authorization: `Bearer ${token}`,
                },
                cache: 'no-store',
            },
        );

        const text = await response.text();
        if (!text) {
            return new NextResponse(null, { status: response.status });
        }

        try {
            return NextResponse.json(JSON.parse(text) as unknown, { status: response.status });
        } catch {
            return NextResponse.json(
                { message: 'Invalid response from vehicle service.' },
                { status: 502 },
            );
        }
    } catch {
        return NextResponse.json(
            { message: 'Unable to remove brand logo.' },
            { status: 502 },
        );
    }
}
