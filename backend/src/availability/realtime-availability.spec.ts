import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import { AvailabilityService } from './availability.service.js';
import { LocationsService } from '../locations/locations.service.js';
import { ReservationsService } from '../reservations/reservations.service.js';

describe('P6 Real-Time Vehicle Availability & Concurrency Guard', () => {
  let availabilityService: AvailabilityService;
  let mockDataSource: any;
  let mockLocationsService: any;

  const mockAgency = {
    id: '11111111-1111-4111-8111-111111111111',
    code: 'PAR-01',
    name: 'Paris Élysées',
    category: 'flagship',
    city: 'Paris',
    country: 'France',
    address: '24 Avenue des Champs-Élysées',
    timezone: 'Europe/Paris',
    opensAt: '08:00',
    closesAt: '20:00',
    turnaroundMinutes: 60,
  };

  const vehicleId = '844f84bf-60a6-4762-a9ea-ba99f8198a6d';

  beforeEach(() => {
    mockDataSource = {
      query: vi.fn(),
      transaction: vi.fn(),
    };

    mockLocationsService = {
      assignedAgencyForVehicle: vi.fn().mockResolvedValue(mockAgency),
    };

    availabilityService = new AvailabilityService(
      mockDataSource as unknown as DataSource,
      mockLocationsService as unknown as LocationsService,
    );
  });

  describe('1. Authoritative Real-Time Block Resolution', () => {
    it('blocks overlapping dates for pending, awaiting_payment, confirmed, active_rental, converted', async () => {
      mockDataSource.query.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, status FROM vehicles')) {
          return Promise.resolve([{ id: vehicleId, status: 'active' }]);
        }
        if (sql.includes('FROM reservations')) {
          // Return an awaiting_payment reservation that overlaps in future 2027
          return Promise.resolve([
            {
              from: new Date('2027-07-01T09:00:00.000Z'),
              to: new Date('2027-07-04T18:00:00.000Z'),
            },
          ]);
        }
        if (sql.includes('FROM vehicle_unavailability') || sql.includes('FROM rentals')) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      const result = await availabilityService.check({
        vehicleId,
        pickupAt: '2027-07-02T10:00:00.000Z',
        returnAt: '2027-07-03T16:00:00.000Z',
      });

      expect(result.available).toBe(false);
      expect(result.reason).toBe('conflict');
      expect(result.message).toContain('no longer available');
    });

    it('considers vehicle available when existing reservations are cancelled or cancelled_unpaid', async () => {
      mockDataSource.query.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, status FROM vehicles')) {
          return Promise.resolve([{ id: vehicleId, status: 'active' }]);
        }
        // Reservations query returns empty because cancelled/cancelled_unpaid are excluded by loadBlocks SQL
        if (sql.includes('FROM reservations') || sql.includes('FROM vehicle_unavailability') || sql.includes('FROM rentals')) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      const result = await availabilityService.check({
        vehicleId,
        pickupAt: '2027-07-02T10:00:00.000Z',
        returnAt: '2027-07-03T16:00:00.000Z',
      });

      expect(result.available).toBe(true);
      expect(result.reason).toBeNull();
      expect(result.details?.rentalDays).toBe(2);
    });

    it('respects agency turnaround buffer time between consecutive bookings', async () => {
      // Existing booking ends at 2027-07-02T12:00:00Z
      // Turnaround is 60 min (ends at 13:00:00Z)
      // New booking requesting 12:30:00Z should conflict
      mockDataSource.query.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, status FROM vehicles')) {
          return Promise.resolve([{ id: vehicleId, status: 'active' }]);
        }
        if (sql.includes('FROM reservations')) {
          return Promise.resolve([
            {
              from: new Date('2027-07-01T08:00:00.000Z'),
              to: new Date('2027-07-02T12:00:00.000Z'),
            },
          ]);
        }
        return Promise.resolve([]);
      });

      const conflictResult = await availabilityService.check({
        vehicleId,
        pickupAt: '2027-07-02T12:30:00.000Z',
        returnAt: '2027-07-03T14:00:00.000Z',
      });
      expect(conflictResult.available).toBe(false);
      expect(conflictResult.reason).toBe('conflict');

      // Booking starting at 13:30:00Z (after 60 min turnaround buffer) should succeed
      const allowedResult = await availabilityService.check({
        vehicleId,
        pickupAt: '2027-07-02T13:30:00.000Z',
        returnAt: '2027-07-03T14:00:00.000Z',
      });
      expect(allowedResult.available).toBe(true);
    });

    it('rejects booking times outside showroom operating hours (08:00 - 20:00 Europe/Paris)', async () => {
      mockDataSource.query.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, status FROM vehicles')) {
          return Promise.resolve([{ id: vehicleId, status: 'active' }]);
        }
        return Promise.resolve([]);
      });

      // 03:00 UTC = 05:00 Paris (outside 08:00-20:00)
      const outsideResult = await availabilityService.check({
        vehicleId,
        pickupAt: '2027-07-02T03:00:00.000Z',
        returnAt: '2027-07-03T14:00:00.000Z',
      });

      expect(outsideResult.available).toBe(false);
      expect(outsideResult.reason).toBe('outside_pickup_hours');
    });
  });

  describe('2. Transaction-Safe Concurrency & PostgreSQL GiST Protection', () => {
    it('catches PostgreSQL 23P01 exclusion violation and converts to 409 ConflictException', async () => {
      const mockProfilesRepo = {
        findOne: vi.fn().mockResolvedValue({
          userId: 'customer-1',
          licenseNumber: 'FR-12345',
          licenseCountry: 'France',
          licenseIssuedOn: '2020-01-01',
          licenseExpiresOn: '2030-01-01',
        }),
      };

      const gistViolationError = new QueryFailedError(
        'INSERT INTO reservations...',
        [],
        { code: '23P01', message: 'conflicting key value violates exclusion constraint "ex_res_no_double_booking"' } as any,
      );

      const mockManager = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('find_available_vehicles')) {
            return Promise.resolve([{ id: vehicleId, daily_price: '2400.00', security_deposit: '5000.00' }]);
          }
          return Promise.resolve([]);
        }),
        getRepository: vi.fn().mockReturnValue({
          create: vi.fn().mockReturnValue({ id: 'res-new' }),
          save: vi.fn().mockRejectedValue(gistViolationError),
          findOne: vi.fn(),
        }),
      };

      const resDataSource = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM users')) {
            return Promise.resolve([{ id: 'customer-1', email: 'cust@test.com', email_verified_at: new Date(), status: 'active' }]);
          }
          return Promise.resolve([]);
        }),
        transaction: vi.fn().mockImplementation(async (cb: any) => cb(mockManager)),
      };

      const mockPremium = {
        quote: vi.fn().mockResolvedValue({
          totalAmount: '7200.00',
          dailyPrice: '2400.00',
          rentalDays: 3,
          extrasAmount: '0.00',
          deliveryAmount: '0.00',
          discountAmount: '0.00',
          extras: [],
        }),
      };

      const resService = new ReservationsService(
        mockProfilesRepo as any,
        {} as any,
        resDataSource as any,
        mockPremium as any,
        availabilityService,
      );

      // Pre-check passes
      mockDataSource.query.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, status FROM vehicles')) {
          return Promise.resolve([{ id: vehicleId, status: 'active' }]);
        }
        return Promise.resolve([]);
      });

      await expect(
        resService.createReservation('customer-1', {
          vehicleId,
          pickupAt: '2027-07-01T10:00:00.000Z',
          returnAt: '2027-07-04T10:00:00.000Z',
        }),
      ).rejects.toThrow(ConflictException);

      await expect(
        resService.createReservation('customer-1', {
          vehicleId,
          pickupAt: '2027-07-01T10:00:00.000Z',
          returnAt: '2027-07-04T10:00:00.000Z',
        }),
      ).rejects.toThrow('Vehicle is no longer available for these dates');
    });

    it('rejects second concurrent requester when vehicle is locked via FOR UPDATE SKIP LOCKED', async () => {
      const mockProfilesRepo = {
        findOne: vi.fn().mockResolvedValue({
          userId: 'customer-2',
          licenseNumber: 'FR-54321',
          licenseCountry: 'France',
          licenseIssuedOn: '2020-01-01',
          licenseExpiresOn: '2030-01-01',
        }),
      };

      const mockManager = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FOR UPDATE OF v SKIP LOCKED')) {
            return Promise.resolve([]); // Skipped because row is locked by concurrent transaction
          }
          return Promise.resolve([]);
        }),
        getRepository: vi.fn(),
      };

      const resDataSource = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM users')) {
            return Promise.resolve([{ id: 'customer-2', email: 'cust2@test.com', email_verified_at: new Date(), status: 'active' }]);
          }
          return Promise.resolve([]);
        }),
        transaction: vi.fn().mockImplementation(async (cb: any) => cb(mockManager)),
      };

      const resService = new ReservationsService(
        mockProfilesRepo as any,
        {} as any,
        resDataSource as any,
        {} as any,
        availabilityService,
      );

      mockDataSource.query.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, status FROM vehicles')) {
          return Promise.resolve([{ id: vehicleId, status: 'active' }]);
        }
        return Promise.resolve([]);
      });

      await expect(
        resService.createReservation('customer-2', {
          vehicleId,
          pickupAt: '2027-07-01T10:00:00.000Z',
          returnAt: '2027-07-04T10:00:00.000Z',
        }),
      ).rejects.toThrow('Selected vehicle is unavailable for this period');
    });
  });

  describe('3. Monthly Calendar Generation with Real-Time Accuracy', () => {
    it('accurately marks past dates, available dates, and blocked dates in the calendar', async () => {
      // Future month: 2027-08
      const month = '2027-08';
      mockDataSource.query.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, status FROM vehicles')) {
          return Promise.resolve([{ id: vehicleId, status: 'active' }]);
        }
        if (sql.includes('FROM reservations')) {
          // Reserve Aug 10 to Aug 15, 2027
          return Promise.resolve([
            {
              from: new Date('2027-08-10T08:00:00.000Z'),
              to: new Date('2027-08-15T18:00:00.000Z'),
            },
          ]);
        }
        return Promise.resolve([]);
      });

      const cal = await availabilityService.calendar(vehicleId, month);
      expect(cal.vehicleId).toBe(vehicleId);
      expect(cal.month).toBe('2027-08');
      expect(cal.days.length).toBe(31);

      // Check Aug 12, 2027 (in middle of reservation): must be unavailable
      const day12 = cal.days.find((d) => d.date === '2027-08-12');
      expect(day12).toBeDefined();
      expect(day12?.status).toBe('unavailable');
      expect(day12?.slots.length).toBe(0);

      // Check Aug 20, 2027 (well clear of reservation): must be available
      const day20 = cal.days.find((d) => d.date === '2027-08-20');
      expect(day20).toBeDefined();
      expect(day20?.status).toBe('available');
      expect(day20?.slots.length).toBeGreaterThan(0);
    });
  });
});
