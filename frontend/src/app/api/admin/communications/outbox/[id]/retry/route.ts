import { resolveAccessToken } from '@/lib/server-auth';
import { NextRequest, NextResponse } from 'next/server';
import { buildApiUrl } from '@/lib/api';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const token = await resolveAccessToken();
  if (!token) {
    return NextResponse.json({ message: 'Authentication required.' }, { status: 401 });
  }

  const { id } = await context.params;
  if (!id || !UUID_REGEX.test(id)) {
    return NextResponse.json({ message: 'Invalid outbox record identifier.' }, { status: 400 });
  }

  try {
    const response = await fetch(buildApiUrl(`/admin/communications/outbox/${encodeURIComponent(id)}/retry`), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    const text = await response.text();
    if (!text) {
      return new NextResponse(null, { status: response.status });
    }

    const data: unknown = JSON.parse(text);
    return NextResponse.json(data, {
      status: response.status,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ message: 'Unable to retry email delivery.' }, { status: 502 });
  }
}
