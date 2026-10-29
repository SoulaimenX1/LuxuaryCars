import { describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { LocationsService } from '../locations/locations.service.js';
import { PremiumService as PremiumServiceImpl } from './premium.service.js';

const VEHICLE = '550e8400-e29b-41d4-a716-446655440000';
const AGENCY = '7bf18b4c-4e28-439a-8b03-ccb2aa133614';

const service = () =>
  new PremiumServiceImpl({
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM vehicles')) {
        return [{ id: VEHICLE, daily_price: '300.00', security_deposit: '2000.00' }];
      }
      if (sql.includes('FROM rental_locations')) return [{
        id: AGENCY,
        name: 'Budapest Agency',
        city: 'Budapest',
        country: 'Hungary',
        category: 'showroom',
        pickup_fee: '0.00',
        dropoff_fee: '0.00',
        one_way_fee: '0.00',
        can_pickup: true,
        can_dropoff: true,
      }];
      if (sql.includes('FROM premium_extras')) return [];
      if (sql.includes('FROM premium_promotions')) return [];
      if (sql.includes('FROM rental_fee_policy')) {
        return [{ lateFeePerDay: '0.00', fuelFeePerPercent: '0.00', mileageAllowancePerDay: 200, excessMileageFee: '0.00' }];
      }
      return [];
    }),
  } as unknown as DataSource, {
    assignedAgencyForVehicle: vi.fn(async () => ({
      id: AGENCY,
      code: 'TEST',
      name: 'Budapest Agency',
      category: 'showroom',
      city: 'Budapest',
      country: 'Hungary',
      address: 'Test address',
      canPickup: true,
      canDropoff: true,
      enabled: true,
      timezone: 'Europe/Budapest',
      opensAt: '09:00',
      closesAt: '18:00',
      turnaroundMinutes: 0,
    })),
  } as unknown as LocationsService);

const base = {
  vehicleId: VEHICLE,
  pickupAt: '2035-07-01T09:00:00.000+02:00',
  returnAt: '2035-07-04T09:00:00.000+02:00',
  pickupLocationId: AGENCY,
};

describe('PremiumService agency-only pickup and return', () => {
  it('rejects door-to-door pickup and return', async () => {
    await expect(service().quote({
      ...base,
      pickupServiceMode: 'DOOR_TO_DOOR',
      pickupDoor: {
        address: { line1: 'Fő utca 1', city: 'Budapest', countryCode: 'HU' },
      },
    })).rejects.toThrow('agency');
    await expect(service().quote({
      ...base,
      dropoffServiceMode: 'DOOR_TO_DOOR',
      dropoffDoor: {
        address: { line1: 'Andrássy út 5', city: 'Budapest', countryCode: 'HU' },
      },
    })).rejects.toThrow('agency');
  });

  it('rejects custom pickup or return addresses', async () => {
    await expect(service().quote({ ...base, pickupAddress: 'Private address' }))
      .rejects.toThrow('agency');
    await expect(service().quote({ ...base, dropoffAddress: 'Private address' }))
      .rejects.toThrow('agency');
  });
});
