import { NextResponse } from 'next/server';
import { buildApiUrl } from '@/lib/api';
import { fetchBackendWithAutoRefresh } from '@/lib/server-auth';

export async function POST() {
    try {
        const backendResponse = await fetchBackendWithAutoRefresh(
            buildApiUrl('/auth/mfa/recovery-codes/generate'),
            {
                method: 'POST',
            },
        );

        if (!backendResponse || !backendResponse.ok) {
            const errData = backendResponse ? await backendResponse.json().catch(() => null) : null;
            return NextResponse.json(
                { message: errData?.message || 'Unable to generate recovery codes. Privileged role required.' },
                { status: backendResponse?.status || 401 },
            );
        }

        const data = await backendResponse.json();
        return NextResponse.json(data, { status: 200 });
    } catch {
        return NextResponse.json(
            { message: 'Failed to connect to recovery service.' },
            { status: 500 },
        );
    }
}
