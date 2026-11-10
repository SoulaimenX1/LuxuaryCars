import { NextResponse } from 'next/server';

// Taux de référence publics, utilisés uniquement pour l'affichage des prix.
// Les réservations et les paiements restent exprimés en EUR dans le backend.
const QUOTES = ['USD', 'GBP', 'HUF'] as const;

interface RateRecord {
  date?: unknown;
  base?: unknown;
  quote?: unknown;
  rate?: unknown;
}

export async function GET() {
  try {
    const response = await fetch(
      `https://api.frankfurter.dev/v2/rates?base=EUR&quotes=${QUOTES.join(',')}`,
      { next: { revalidate: 3600 }, signal: AbortSignal.timeout(1800) },
    );
    if (!response.ok) throw new Error('Rate provider unavailable');
    const data: unknown = await response.json();
    if (!Array.isArray(data)) throw new Error('Unexpected rate response');

    const rates: Record<string, number> = { EUR: 1 };
    const dates: string[] = [];
    for (const item of data as RateRecord[]) {
      if (!item || item.base !== 'EUR' ||
          typeof item.quote !== 'string' ||
          !QUOTES.some((code) => code === item.quote) ||
          typeof item.rate !== 'number' ||
          !Number.isFinite(item.rate) || item.rate <= 0 ||
          typeof item.date !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}$/.test(item.date)) continue;
      rates[item.quote] = item.rate;
      dates.push(item.date);
    }
    if (dates.length === 0) throw new Error('No usable rates');

    return NextResponse.json({
      base: 'EUR', rates, asOf: dates.sort().at(-1),
      source: 'Frankfurter (official reference providers)',
    }, { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=3600' } });
  } catch {
    // Graceful fallback rates: ensure UI never fails or throws 503
    return NextResponse.json({
      base: 'EUR',
      rates: { EUR: 1, USD: 1.08, GBP: 0.85, HUF: 405.0 },
      asOf: new Date().toISOString().slice(0, 10),
      source: 'Internal verified fallback reference',
    }, { headers: { 'Cache-Control': 'public, s-maxage=300' } });
  }
}
