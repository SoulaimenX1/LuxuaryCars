import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { PricingDemandIntelligenceService } from './pricing-demand-intelligence.service.js';
import type { VehiclesService } from '../vehicles/vehicles.service.js';

describe('PricingDemandIntelligenceService', () => {
  let pricingDemandService: PricingDemandIntelligenceService;
  let mockDataSource: { query: ReturnType<typeof vi.fn> };
  let mockVehiclesService: { updateVehicle: ReturnType<typeof vi.fn> };

  const mockVehicles = [
    {
      id: 'v-hyper-1',
      license_plate: 'LUX-CHIRON-01',
      daily_price: '21000.00',
      status: 'active',
      manufacture_year: 2024,
      model_name: 'Chiron Sport',
      brand_name: 'Bugatti',
      category_id: 'cat-hyper',
      category_name: 'Hypercar',
    },
    {
      id: 'v-gt-1',
      license_plate: 'LUX-DB12-01',
      daily_price: '2400.00',
      status: 'active',
      manufacture_year: 2024,
      model_name: 'DB12',
      brand_name: 'Aston Martin',
      category_id: 'cat-gt',
      category_name: 'Grand Tourer',
    },
    {
      id: 'v-suv-1',
      license_plate: 'LUX-BENTAYGA-01',
      daily_price: '1900.00',
      status: 'active',
      manufacture_year: 2024,
      model_name: 'Bentayga',
      brand_name: 'Bentley',
      category_id: 'cat-suv',
      category_name: 'Luxury SUV',
    },
  ];

  const mockReservations = [
    {
      id: 'res-1',
      reservation_number: 'RES-2026-000001',
      vehicle_id: 'v-gt-1',
      pickup_at: new Date('2026-10-30T10:00:00Z'),
      return_at: new Date('2026-11-02T10:00:00Z'),
      rental_days: 3,
      daily_price: '2400.00',
      total_amount: '7200.00',
      status: 'completed',
      created_at: new Date('2026-10-20T10:00:00Z'),
    },
    {
      id: 'res-2',
      reservation_number: 'RES-2026-000073',
      vehicle_id: 'v-hyper-1',
      pickup_at: new Date('2026-11-02T10:00:00Z'),
      return_at: new Date('2026-11-05T10:00:00Z'),
      rental_days: 3,
      daily_price: '21000.00',
      total_amount: '63000.00',
      status: 'pending',
      created_at: new Date('2026-10-25T10:00:00Z'),
    },
  ];

  beforeEach(() => {
    mockDataSource = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('FROM vehicles')) {
          return Promise.resolve(mockVehicles);
        }
        if (sql.includes('FROM reservations')) {
          return Promise.resolve(mockReservations);
        }
        if (sql.includes('FROM rentals')) {
          return Promise.resolve([{ id: 'r-1', status: 'completed' }]);
        }
        if (sql.includes('FROM rental_locations')) {
          return Promise.resolve([{ cnt: 1 }]);
        }
        if (sql.includes('INSERT INTO audit_logs')) {
          return Promise.resolve([{ id: 'audit-999' }]);
        }
        return Promise.resolve([]);
      }),
    };

    mockVehiclesService = {
      updateVehicle: vi.fn().mockResolvedValue({ id: 'v-hyper-1', dailyPrice: '22000.00' }),
    };

    pricingDemandService = new PricingDemandIntelligenceService(
      mockDataSource as unknown as DataSource,
      mockVehiclesService as unknown as VehiclesService,
    );
  });

  // 1. Data readiness & sufficiency
  it('1. correctly identifies sparse dataset and calculates honest data readiness score', async () => {
    const overview = await pricingDemandService.getPricingDemandOverview();

    expect(overview.dataReadiness).toBeDefined();
    expect(overview.dataReadiness.status).toBe('sparse');
    expect(overview.dataReadiness.dataCompletenessPercentage).toBeLessThan(40);
    expect(overview.dataReadiness.hasSearchLogs).toBe(false);
    expect(overview.dataReadiness.hasMultiYearHistory).toBe(false);
    expect(overview.dataReadiness.missingDataFactors.length).toBeGreaterThanOrEqual(3);
    expect(overview.dataReadiness.readinessNotes).toContain('sparse');
  });

  // 2. Empty data resilience
  it('2. safely handles empty reservations without crashing or dividing by zero', async () => {
    mockDataSource.query.mockImplementation((sql: string) => {
      if (sql.includes('FROM vehicles')) return Promise.resolve(mockVehicles);
      if (sql.includes('FROM reservations')) return Promise.resolve([]);
      if (sql.includes('FROM rentals')) return Promise.resolve([]);
      if (sql.includes('FROM rental_locations')) return Promise.resolve([{ cnt: 1 }]);
      return Promise.resolve([]);
    });

    const overview = await pricingDemandService.getPricingDemandOverview();
    expect(overview.dataReadiness.historicalBookingsCount).toBe(0);
    expect(overview.timeline).toEqual([]);
    expect(overview.forecasts.length).toBe(3);
    expect(overview.forecasts[0].predictedBookingVolume).toBe(0);
  });

  // 3. Category demand breakdown
  it('3. calculates category demand share and confirmed revenue accurately', async () => {
    const overview = await pricingDemandService.getPricingDemandOverview();
    const hypercar = overview.categories.find((c) => c.categoryName === 'Hypercar');
    const gt = overview.categories.find((c) => c.categoryName === 'Grand Tourer');

    expect(hypercar).toBeDefined();
    expect(hypercar?.bookingsCount).toBe(1);
    expect(hypercar?.demandSharePercent).toBe(50.0);
    expect(gt).toBeDefined();
    expect(gt?.confirmedRevenue).toBe(7200);
  });

  // 4. Forecast confidence levels
  it('4. assigns moderate confidence to 7-day and low confidence to 30-day forecast', async () => {
    const overview = await pricingDemandService.getPricingDemandOverview();
    const fc7 = overview.forecasts.find((f) => f.horizonDays === 7);
    const fc30 = overview.forecasts.find((f) => f.horizonDays === 30);

    expect(fc7?.confidenceLevel).toBe('moderate');
    expect(fc30?.confidenceLevel).toBe('low');
    expect(fc7?.historicalEvidence).toContain('velocity');
  });

  // 5. Pricing recommendation constraints & human approval
  it('5. generates explainable pricing recommendations requiring human approval', async () => {
    const overview = await pricingDemandService.getPricingDemandOverview();
    expect(overview.recommendations.length).toBeGreaterThan(0);

    for (const rec of overview.recommendations) {
      expect(rec.humanApprovalRequired).toBe(true);
      expect(rec.status).toBe('pending_review');
      expect(rec.currentDailyPrice).toBeGreaterThan(0);
      expect(rec.suggestedPriceMin).toBeGreaterThan(0);
      expect(rec.suggestedPriceMax).toBeGreaterThanOrEqual(rec.suggestedPriceMin);
      expect(rec.evidence.length).toBeGreaterThan(15);
      expect(rec.expectedBusinessImpact).toContain('estimate');
    }
  });

  // 6. Application of approved price
  it('6. applies approved price via VehiclesService and logs to audit_logs', async () => {
    mockDataSource.query.mockImplementation((sql: string, _params?: unknown[]) => {
      if (sql.includes('SELECT id, license_plate, daily_price')) {
        return Promise.resolve([
          { id: 'v-hyper-1', license_plate: 'LUX-CHIRON-01', daily_price: '21000.00', status: 'active' },
        ]);
      }
      if (sql.includes('INSERT INTO audit_logs')) {
        return Promise.resolve([{ id: 'audit-101' }]);
      }
      return Promise.resolve([]);
    });

    const res = await pricingDemandService.applyRecommendation(
      'REC-1',
      'LUX-CHIRON-01',
      { approvedPrice: 22000, adminReason: 'Authorized executive demand adjustment' },
      'admin-uuid-1',
    );

    expect(res.success).toBe(true);
    expect(res.oldDailyPrice).toBe(21000);
    expect(res.newDailyPrice).toBe(22000);
    expect(res.auditLogId).toBe('audit-101');
    expect(mockVehiclesService.updateVehicle).toHaveBeenCalledWith('LUX-CHIRON-01', {
      dailyPrice: 22000,
    });
  });

  // 7. Safety guardrail: reject excessive shift > 50%
  it('7. rejects price change exceeding safety guardrail threshold (>50%)', async () => {
    mockDataSource.query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, license_plate, daily_price')) {
        return Promise.resolve([
          { id: 'v-hyper-1', license_plate: 'LUX-CHIRON-01', daily_price: '21000.00', status: 'active' },
        ]);
      }
      return Promise.resolve([]);
    });

    await expect(
      pricingDemandService.applyRecommendation(
        'REC-1',
        'LUX-CHIRON-01',
        { approvedPrice: 40000 }, // +90% shift
        'admin-uuid-1',
      ),
    ).rejects.toThrow('safety guardrail');
  });
});
