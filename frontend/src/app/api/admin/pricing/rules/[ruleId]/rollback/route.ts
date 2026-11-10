import { resolveAccessToken } from '@/lib/server-auth';
import { NextRequest, NextResponse } from 'next/server';
import { buildApiUrl } from '@/lib/api';

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ ruleId: string }> },
) {
  const token = await resolveAccessToken();
  if (!token) {
    return NextResponse.json({ message: 'Authentication required.' }, { status: 401 });
  }

  const { ruleId } = await props.params;

  try {
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const response = await fetch(buildApiUrl(`/admin/pricing/rules/${encodeURIComponent(ruleId)}/rollback`), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
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
    return NextResponse.json({ message: 'Unable to rollback pricing rule.' }, { status: 502 });
  }
}
