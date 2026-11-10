'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

// Les prix du catalogue et des réservations sont toujours stockés en EUR.
// La conversion ci-dessous est purement informative et côté navigateur.
export type DisplayCurrency = 'EUR' | 'USD' | 'GBP' | 'HUF';
export const DISPLAY_CURRENCIES: DisplayCurrency[] = ['EUR', 'USD', 'GBP', 'HUF'];
const STORAGE_KEY = 'luxury-display-currency';

interface CurrencyContextValue {
  currency: DisplayCurrency;
  available: DisplayCurrency[];
  asOf: string | null;
  loading: boolean;
  warning: string | null;
  setCurrency: (currency: DisplayCurrency) => void;
  formatPrice: (amount: string | number, options?: { forceDecimals?: boolean }) => string;
}

const CurrencyContext = createContext<CurrencyContextValue | null>(null);

let memoryCachedRates: { rates: Record<string, number>; asOf: string } | null = null;
let inFlightRatesPromise: Promise<{ rates: Record<string, number>; asOf: string } | null> | null = null;

async function fetchRatesOnce(): Promise<{ rates: Record<string, number>; asOf: string } | null> {
  if (memoryCachedRates) return memoryCachedRates;
  if (inFlightRatesPromise) return inFlightRatesPromise;

  inFlightRatesPromise = (async () => {
    try {
      const response = await fetch('/api/currency-rates');
      if (!response.ok) return null;
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || !('rates' in data) ||
          !('asOf' in data) || typeof (data as { asOf: unknown }).asOf !== 'string') {
        return null;
      }
      const candidate = (data as { rates: Record<string, unknown> }).rates;
      const usable: Record<string, number> = { EUR: 1 };
      for (const code of DISPLAY_CURRENCIES) {
        const rate = candidate[code];
        if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) usable[code] = rate;
      }
      memoryCachedRates = { rates: usable, asOf: (data as { asOf: string }).asOf };
      return memoryCachedRates;
    } catch {
      return null;
    } finally {
      inFlightRatesPromise = null;
    }
  })();

  return inFlightRatesPromise;
}

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [currency, setSelectedCurrency] = useState<DisplayCurrency>('EUR');
  const [rates, setRates] = useState<Record<string, number>>(memoryCachedRates?.rates ?? { EUR: 1 });
  const [asOf, setAsOf] = useState<string | null>(memoryCachedRates?.asOf ?? null);
  const [loading, setLoading] = useState(!memoryCachedRates);
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadRates() {
      const result = await fetchRatesOnce();
      if (cancelled) return;
      if (result) {
        setRates(result.rates);
        setAsOf(result.asOf);
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved && DISPLAY_CURRENCIES.includes(saved as DisplayCurrency) && result.rates[saved]) {
          setSelectedCurrency(saved as DisplayCurrency);
        }
      } else {
        setWarning('Live exchange rates are unavailable. Showing EUR prices.');
        setSelectedCurrency('EUR');
      }
      setLoading(false);
    }
    void loadRates();
    return () => {
      cancelled = true;
    };
  }, []);

  const setCurrency = useCallback((next: DisplayCurrency) => {
    if (!rates[next]) return;
    setSelectedCurrency(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* Stockage facultatif. */ }
  }, [rates]);

  const formatPrice = useCallback((amount: string | number, options?: { forceDecimals?: boolean }): string => {
    const value = typeof amount === 'number' ? amount : Number(amount);
    if (!Number.isFinite(value)) return String(amount);
    const factor = rates[currency];
    // Ne jamais inventer un cours de conversion si l'API échoue.
    const actualCurrency = factor ? currency : 'EUR';
    let safeValue = value * (factor ?? 1);

    // Pour les devises converties indicatives, arrondir les montants >= 100 à l'entier pour un affichage luxe net
    if (actualCurrency !== 'EUR' && safeValue >= 100 && !options?.forceDecimals) {
      safeValue = Math.round(safeValue);
    }

    const isWhole = safeValue % 1 === 0;
    const showDecimals = options?.forceDecimals || (!isWhole && actualCurrency !== 'HUF');

    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: actualCurrency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: showDecimals ? 2 : 0,
      maximumFractionDigits: showDecimals ? 2 : 0,
    }).format(safeValue);
  }, [currency, rates]);

  const value = useMemo<CurrencyContextValue>(() => ({
    currency, available: DISPLAY_CURRENCIES.filter((code) => Boolean(rates[code])),
    asOf, loading, warning, setCurrency, formatPrice,
  }), [currency, rates, asOf, loading, warning, setCurrency, formatPrice]);

  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
}

export function useCurrency(): CurrencyContextValue {
  const value = useContext(CurrencyContext);
  if (!value) throw new Error('useCurrency must be used within CurrencyProvider');
  return value;
}

export function Price({ value }: { value: string | number }) {
  const { formatPrice } = useCurrency();
  return <>{formatPrice(value)}</>;
}
