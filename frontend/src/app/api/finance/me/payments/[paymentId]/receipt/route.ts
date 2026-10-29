import { resolveAccessToken } from '@/lib/server-auth';
import { NextResponse } from 'next/server';
import { buildApiUrl } from '@/lib/api';

type Context = {
  params: Promise<{ paymentId: string }>;
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, context: Context) {
  const { paymentId } = await context.params;
  if (!UUID.test(paymentId)) {
    return NextResponse.json({ message: 'Not found' }, { status: 404 });
  }
  const token = await resolveAccessToken();
  if (!token) {
    return NextResponse.json(
      { message: 'Authentication required' },
      { status: 401 },
    );
  }

  try {
    const response = await fetch(
      buildApiUrl(`/finance/me/payments/${paymentId}/receipt`),
      {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      },
    );
    if (!response.ok) {
      const text = await response.text();
      try {
        return NextResponse.json(JSON.parse(text), {
          status: response.status,
        });
      } catch {
        return NextResponse.json(
          { message: 'Receipt unavailable' },
          { status: response.status },
        );
      }
    }
    return new NextResponse(await response.arrayBuffer(), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition':
          `attachment; filename="luxury-payment-receipt-${paymentId}.pdf"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return NextResponse.json(
      { message: 'Unable to download receipt' },
      { status: 502 },
    );
  }
}
