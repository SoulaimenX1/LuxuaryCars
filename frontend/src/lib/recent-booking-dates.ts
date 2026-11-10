// Shared in-memory cache of the most recent interval check per vehicleId.
// Ensures that if a client bundle sends a quote request without dates
// alongside an availability check, the proxy can resolve the dates.

interface RecentInterval {
  pickupAt: string;
  returnAt: string;
  updatedAt: number;
}

const globalForBooking = globalThis as unknown as {
  __recentBookingIntervals?: Map<string, RecentInterval>;
};

function getStore(): Map<string, RecentInterval> {
  if (!globalForBooking.__recentBookingIntervals) {
    globalForBooking.__recentBookingIntervals = new Map<string, RecentInterval>();
  }
  return globalForBooking.__recentBookingIntervals;
}

export function recordVehicleInterval(vehicleId: string, pickupAt: string, returnAt: string): void {
  if (!vehicleId || !pickupAt || !returnAt) return;
  getStore().set(vehicleId, {
    pickupAt,
    returnAt,
    updatedAt: Date.now(),
  });
}

export async function resolveVehicleInterval(
  vehicleId: string,
  waitMs = 250,
): Promise<{ pickupAt: string; returnAt: string } | null> {
  if (!vehicleId) return null;
  const store = getStore();
  const startedAt = Date.now();

  // Check if a very recent interval (within the last 2 seconds) is already recorded,
  // or wait up to waitMs for the concurrent /api/availability/check call to arrive.
  while (Date.now() - startedAt <= waitMs) {
    const entry = store.get(vehicleId);
    if (entry && Date.now() - entry.updatedAt < 10_000) {
      return { pickupAt: entry.pickupAt, returnAt: entry.returnAt };
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }

  const fallback = store.get(vehicleId);
  if (fallback) {
    return { pickupAt: fallback.pickupAt, returnAt: fallback.returnAt };
  }
  return null;
}
