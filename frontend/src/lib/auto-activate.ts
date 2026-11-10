// Client-side contract for the admin "Auto-activate" rentals action.
//
// The action calls POST /api/admin/rentals/auto-activate, which proxies the
// admin-only backend operation POST /finance/stripe/admin/auto-activate.
// A success outcome is ONLY reported when the backend confirms it with a valid
// `activatedCount`. Network failures, non-2xx responses and malformed payloads
// are surfaced as genuine errors (never silently converted into success).

export const AUTO_ACTIVATE_ENDPOINT = '/api/admin/rentals/auto-activate';

export type AutoActivateOutcome =
  | { ok: true; activatedCount: number }
  | { ok: false; status: number | null; message: string };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function extractMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const message = (payload as { message?: unknown }).message;
  if (typeof message === 'string' && message.trim()) return message.trim();
  if (Array.isArray(message)) {
    const parts = message.filter((m): m is string => typeof m === 'string' && m.trim() !== '');
    if (parts.length > 0) return parts.join(' ');
  }
  return null;
}

export async function requestAutoActivation(fetchImpl: FetchLike): Promise<AutoActivateOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(AUTO_ACTIVATE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
    });
  } catch {
    return {
      ok: false,
      status: null,
      message: 'Unable to reach the server. No rentals were activated.',
    };
  }

  let payload: unknown = null;
  try {
    const text = await response.text();
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const fallback =
      response.status === 401
        ? 'Your session has expired. Please sign in again.'
        : response.status === 403
          ? 'Administrator privileges are required for this action.'
          : `Auto-activation failed (HTTP ${response.status}).`;
    return { ok: false, status: response.status, message: extractMessage(payload) ?? fallback };
  }

  const count =
    payload && typeof payload === 'object' && 'activatedCount' in payload
      ? (payload as { activatedCount: unknown }).activatedCount
      : undefined;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
    return {
      ok: false,
      status: response.status,
      message: 'The server returned an unexpected response. Activation could not be confirmed.',
    };
  }

  return { ok: true, activatedCount: count };
}

export function describeActivation(activatedCount: number): string {
  if (activatedCount === 0) {
    return 'No eligible reservations to activate. Confirmed bookings activate only once their pickup time has arrived and payment and deposit are verified.';
  }
  return activatedCount === 1
    ? '1 confirmed reservation was activated as a rental.'
    : `${activatedCount} confirmed reservations were activated as rentals.`;
}
