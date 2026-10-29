import { resolveAccessToken } from '@/lib/server-auth';
import {NextResponse} from 'next/server';
import {buildApiUrl} from '@/lib/api';

const PLATE = /^[A-Za-z0-9 _-]{2,25}$/;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_SIZE = 8 * 1024 * 1024;

export async function handleVehicleImageUpload(request: Request): Promise<NextResponse> {
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

    let form: FormData;
    try {
        form = await request.formData();
    } catch {
        return NextResponse.json({message: 'Invalid form data.'}, {status: 400});
    }

    const plate = form.get('licensePlate');
    const file = form.get('image');
    if (typeof plate !== 'string' || !PLATE.test(plate)) {
        return NextResponse.json({message: 'License plate required.'}, {status: 400});
    }
    if (!(file instanceof File) || file.size === 0) {
        return NextResponse.json({message: 'Image file required.'}, {status: 400});
    }
    if (file.size > MAX_IMAGE_SIZE) {
        return NextResponse.json({message: 'Image is too large (8 MB maximum).'}, {status: 413});
    }
    if (!IMAGE_TYPES.includes(file.type)) {
        return NextResponse.json({message: 'Only JPEG, PNG, and WebP images are supported.'}, {status: 400});
    }

    const outgoing = new FormData();
    outgoing.append('image', file, file.name || 'vehicle-image');
    try {
        const response = await fetch(
            buildApiUrl(`/vehicles/by-plate/${encodeURIComponent(plate.trim())}/image`),
            {
                method: 'POST',
                headers: {Authorization: `Bearer ${token}`},
                body: outgoing,
                cache: 'no-store',
            },
        );
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
        return NextResponse.json({message: 'Unable to upload vehicle photograph.'}, {status: 502});
    }
}

export async function handleVehicleImageDelete(request: Request): Promise<NextResponse> {
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

    const plate = new URL(request.url).searchParams.get('licensePlate')?.trim();
    if (!plate || !PLATE.test(plate)) {
        return NextResponse.json({message: 'License plate required.'}, {status: 400});
    }

    try {
        const response = await fetch(
            buildApiUrl(`/vehicles/by-plate/${encodeURIComponent(plate)}/image`),
            {
                method: 'DELETE',
                headers: {Authorization: `Bearer ${token}`},
                cache: 'no-store',
            },
        );
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
        return NextResponse.json({message: 'Unable to delete vehicle photographs.'}, {status: 502});
    }
}
