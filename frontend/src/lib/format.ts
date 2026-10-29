// ==========================================================
// FORMATAGE PARTAGÉ — prix, libellés, devises
// ==========================================================
//
// Centralise le formatage professionnel des montants et libellés.
// Affiche des nombres propres (sans .00 inutile sur les nombres
// ronds de luxe) tout en préservant les centimes lorsqu'ils existent.
// ==========================================================

export function formatAmount(
  value: string | number | null | undefined,
  options?: { forceDecimals?: boolean }
): string {
  if (value === null || value === undefined || value === '') {
    return '0';
  }

  const amount = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(amount)) {
    return String(value);
  }

  const isWhole = amount % 1 === 0;
  const showDecimals = options?.forceDecimals ?? !isWhole;

  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: showDecimals ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatCurrency(
  value: string | number | null | undefined,
  currency: string = 'EUR',
  options?: { forceDecimals?: boolean }
): string {
  if (value === null || value === undefined || value === '') {
    return '0';
  }

  const amount = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(amount)) {
    return String(value);
  }

  const isWhole = amount % 1 === 0;
  const showDecimals = options?.forceDecimals ?? (!isWhole && currency !== 'HUF');

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: currency === 'HUF' || !showDecimals ? 0 : 2,
    maximumFractionDigits: currency === 'HUF' ? 0 : 2,
  }).format(amount);
}

export function formatLabel(value: string): string {
  if (!value) {
    return 'Not specified';
  }

  return value.charAt(0).toUpperCase() + value.slice(1);
}
