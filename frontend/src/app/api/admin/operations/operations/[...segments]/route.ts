import { buildApiUrl } from '@/lib/api';
import { resolveAccessToken } from '@/lib/server-auth';
import { NextResponse, type NextRequest } from 'next/server';

async function forward(request: NextRequest, { params }: { params: Promise<{ segments: string[] }> }) {
  const { segments } = await params;
  const accessToken = await resolveAccessToken();
  if (!accessToken) {
    return NextResponse.json({ message: 'Authentication required.' }, { status: 401 });
  }

  const rawPath = segments.join('/');
  let targetPath = rawPath;
  if (rawPath.startsWith('finance/')) {
    targetPath = 'finance/admin/' + rawPath.replace(/^finance\//, '');
  }

  const backendUrl = buildApiUrl(`/${targetPath}`);
  const headers = new Headers();
  headers.set('Authorization', `Bearer ${accessToken}`);
  const contentType = request.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);

  const init: RequestInit = {
    method: request.method,
    headers,
    cache: 'no-store',
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const body = await request.text();
    if (body) init.body = body;
  }

  try {
    const res = await fetch(backendUrl, init);
    const contentTypeRes = res.headers.get('content-type') || '';
    if (contentTypeRes.includes('application/pdf')) {
      const blob = await res.arrayBuffer();
      return new NextResponse(blob, {
        status: res.status,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': res.headers.get('content-disposition') || 'attachment',
        },
      });
    }

    const text = await res.text();
    if (!text) return new NextResponse(null, { status: res.status });
    try {
      const data = JSON.parse(text);
      return NextResponse.json(data, { status: res.status });
    } catch {
      return new NextResponse(text, { status: res.status });
    }
  } catch {
    return NextResponse.json({ message: 'Error communicating with backend.' }, { status: 502 });
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ segments: string[] }> }) {
  return forward(req, ctx);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ segments: string[] }> }) {
  return forward(req, ctx);
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ segments: string[] }> }) {
  return forward(req, ctx);
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ segments: string[] }> }) {
  return forward(req, ctx);
}
