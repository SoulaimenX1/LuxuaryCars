import { describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { LocationsService } from '../locations/locations.service.js';
import { PremiumService as PremiumServiceImpl } from './premium.service.js';

const A = '550e8400-e29b-41d4-a716-446655440001';
const B = '550e8400-e29b-41d4-a716-446655440002';
const VEHICLE = '550e8400-e29b-41d4-a716-446655440000';

function service(agencyId: string | null = A) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('JOIN rental_locations')) {
      return agencyId ? [{ id: agencyId, name: 'Agency A', city: 'Test city' }] : [];
    }
    if (sql.includes('FROM vehicles WHERE')) {
      return [{ id: VEHICLE, daily_price: '300.00', security_deposit: '2000.00' }];
    }
    if (sql.includes('FROM rental_locations')) {
      return [
        {
          id: A,
          name: 'Agency A',
          city: 'Test city',
          category: 'showroom',
          pickup_fee: '50.00',
          dropoff_fee: '25.00',
          one_way_fee: '35.00',
          can_pickup: true,
          can_dropoff: true,
        },
        {
          id: B,
          name: 'City-center point',
          city: 'Test city',
          category: 'city_center',
          pickup_fee: '80.00',
          dropoff_fee: '15.00',
          one_way_fee: '0.00',
          can_pickup: true,
          can_dropoff: true,
        },
      ];
    }
    if (sql.includes('FROM rental_fee_policy')) {
      return [{ lateFeePerDay: '0.00', fuelFeePerPercent: '0.00', mileageAllowancePerDay: 250, excessMileageFee: '0.00' }];
    }
    return [];
  });
  const resolver = {
    assignedAgencyForVehicle: vi.fn(async () => {
      if (!agencyId) throw new Error('Assign this vehicle to one active agency');
      return {
        id: agencyId,
        code: 'TEST',
        name: 'Agency A',
        category: 'showroom',
        city: 'Test city',
        country: 'France',
        address: 'Test address',
        canPickup: true,
        canDropoff: true,
        enabled: true,
        timezone: 'Europe/Paris',
        opensAt: '09:00',
        closesAt: '18:00',
        turnaroundMinutes: 0,
      };
    }),
  };
  return new PremiumServiceImpl(
    { query } as unknown as DataSource,
    resolver as unknown as LocationsService,
  );
}

const base = { vehicleId: VEHICLE, pickupDate: '2035-07-01', returnDate: '2035-07-04' };

describe('PremiumService agency-only rental quotations', () => {
  it('derives the agency and applies no transport fees', async () => {
    const quote = await service().quote(base);
    expect(quote.deliveryAmount).toBe('0.00');
    expect(quote.locationFees).toEqual({ pickup: '0.00', dropoff: '0.00', oneWay: '0.00' });
    expect(quote.totalAmount).toBe('900.00');
    expect(quote.pickupMethod).toBe('branch');
    expect(quote.pickupLocationName).toBe('Agency A — Test city');
    expect(quote.dropoffLocationName).toBe(quote.pickupLocationName);
  });

  it('uses the assigned agency for both rental ends without a customer choice', async () => {
    const quote = await service().quote(base);
    expect(quote.pickupLocationId).toBe(A);
    expect(quote.dropoffLocationId).toBe(A);
    expect(quote.dropoffLocationName).toBe('Agency A — Test city');
  });

  it('rejects a different return agency', async () => {
    await expect(service().quote({
      ...base,
      pickupLocationId: A,
      dropoffLocationId: B,
    })).rejects.toThrow('assigned to the vehicle');
  });

  it('rejects airport/hotel pickup methods and non-agency locations', async () => {
    await expect(service().quote({ ...base, pickupLocationId: A, pickupMethod: 'airport' }))
      .rejects.toThrow('assigned to the vehicle');
    await expect(service().quote({ ...base, pickupLocationId: B, pickupMethod: 'hotel' }))
      .rejects.toThrow('assigned to the vehicle');
    await expect(service().quote({ ...base, pickupLocationId: B }))
      .rejects.toThrow('assigned to the vehicle');
  });

  it('rejects booking when a vehicle has no assigned agency', async () => {
    await expect(service(null).quote(base)).rejects.toThrow('Assign this vehicle to one active agency');
  });
});
