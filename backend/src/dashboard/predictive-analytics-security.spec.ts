import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DataSource } from 'typeorm';
import { PricingDemandIntelligenceService } from './pricing-demand-intelligence.service.js';
import { VehiclesService } from '../vehicles/vehicles.service.js';
import { BadRequestException } from '@nestjs/common';

describe('P7 Predictive Analytics & Security Guardrails', () => {
  let pricingDemandService: PricingDemandIntelligenceService;
  let mockDataSource: any;
  let mockVehiclesService: any;

  const mockVehicles = [
    {
      id: 'v-1',
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
      id: 'v-2',
      license_plate: 'LUX-DB12-01',
      daily_price: '2400.00',
      status: 'active',
      manufacture_year: 2024,
      model_name: 'DB12',
      brand_name: 'Aston Martin',
      category_id: 'cat-gt',
      category_name: 'Grand Tourer',
    },
  ];

  const mockHistoricalReservations = [
    {
      id: 'res-1',
      reservation_number: 'RES-2026-000001',
      vehicle_id: 'v-2',
      pickup_at: new Date('2026-10-30T10:00:00Z'),
      return_at: new Date('2026-11-02T10:00:00Z'),
      rental_days: 3,
      daily_price: '2400.00',
      total_amount: '7200.00',
      status: 'completed',
      created_at: new Date('2026-10-20T10:00:00Z'),
    },
  ];

  beforeEach(() => {
    mockDataSource = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('FROM platform_settings WHERE key = \'predictive_analytics_enabled\'')) {
          return Promise.resolve([{ value: 'false' }]);
        }
        if (sql.includes('FROM vehicles')) {
          return Promise.resolve(mockVehicles);
        }
        if (sql.includes('FROM reservations')) {
          return Promise.resolve(mockHistoricalReservations);
        }
        if (sql.includes('FROM rentals')) {
          return Promise.resolve([]);
        }
        if (sql.includes('FROM rental_locations')) {
          return Promise.resolve([{ cnt: 1 }]);
        }
        if (sql.includes('INSERT INTO audit_logs')) {
          return Promise.resolve([{ id: 'audit-log-uuid' }]);
        }
        return Promise.resolve([]);
      }),
    };

    mockVehiclesService = {
      updateVehicle: vi.fn().mockResolvedValue({ id: 'v-1', dailyPrice: '22000.00' }),
    };

    pricingDemandService = new PricingDemandIntelligenceService(
      mockDataSource as unknown as DataSource,
      mockVehiclesService as unknown as VehiclesService,
    );
  });

  describe('1. Feature Flag & Standby State (OFF by Default)', () => {
    it('defaults to disabled/standby state when platform_settings is false', async () => {
      const overview = await pricingDemandService.getPricingDemandOverview();
      expect(overview.enabled).toBe(false);
      expect(overview.generatedAt).toBeDefined();
    });

    it('reflects enabled state when platform_settings is true', async () => {
      mockDataSource.query.mockImplementation((sql: string) => {
        if (sql.includes('FROM platform_settings WHERE key = \'predictive_analytics_enabled\'')) {
          return Promise.resolve([{ value: 'true' }]);
        }
        if (sql.includes('FROM vehicles')) return Promise.resolve(mockVehicles);
        if (sql.includes('FROM reservations')) return Promise.resolve(mockHistoricalReservations);
        if (sql.includes('FROM rentals')) return Promise.resolve([]);
        if (sql.includes('FROM rental_locations')) return Promise.resolve([{ cnt: 1 }]);
        return Promise.resolve([]);
      });

      const overview = await pricingDemandService.getPricingDemandOverview();
      expect(overview.enabled).toBe(true);
    });
  });

  describe('2. Honest Data Readiness Scoring & Warning System', () => {
    it('accurately identifies sparse dataset and highlights missing data factors', async () => {
      const overview = await pricingDemandService.getPricingDemandOverview();
      expect(overview.dataReadiness.status).toBe('sparse');
      expect(overview.dataReadiness.dataCompletenessPercentage).toBeLessThan(50);
      expect(overview.dataReadiness.missingDataFactors.length).toBeGreaterThanOrEqual(3);
      expect(overview.dataReadiness.readinessNotes).toContain('sparse');
    });

    it('assigns honest low or moderate confidence to forecast horizons', async () => {
      const overview = await pricingDemandService.getPricingDemandOverview();
      expect(overview.forecasts.length).toBe(3); // 7, 14, 30 days
      const fc30 = overview.forecasts.find((f) => f.horizonDays === 30);
      expect(fc30?.confidenceLevel).toBe('low');
      expect(fc30?.recommendedHumanAction).toContain('pricing stability');
    });
  });

  describe('3. Advisory-Only Guardrail (No Automatic Price Changes)', () => {
    it('all recommendations require explicit human approval and are not auto-applied', async () => {
      const overview = await pricingDemandService.getPricingDemandOverview();
      for (const rec of overview.recommendations) {
        expect(rec.humanApprovalRequired).toBe(true);
        expect(rec.status).toBe('pending_review');
        expect(rec.currentDailyPrice).toBeGreaterThan(0);
        expect(rec.evidence).toBeDefined();
      }
      // VehiclesService was NOT called automatically
      expect(mockVehiclesService.updateVehicle).not.toHaveBeenCalled();
    });

    it('enforces maximum 50% shift safety guardrail on manual approval', async () => {
      mockDataSource.query.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, license_plate, daily_price')) {
          return Promise.resolve([
            { id: 'v-1', license_plate: 'LUX-CHIRON-01', daily_price: '20000.00', status: 'active' },
          ]);
        }
        return Promise.resolve([]);
      });

      // Attempt +60% increase (32000 vs 20000)
      await expect(
        pricingDemandService.applyRecommendation(
          'REC-1',
          'LUX-CHIRON-01',
          { approvedPrice: 32000, adminReason: 'Unbounded price hike attempt' },
          'admin-actor-1',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(mockVehiclesService.updateVehicle).not.toHaveBeenCalled();
    });

    it('permits valid within-guardrail price shift and writes to audit_logs', async () => {
      mockDataSource.query.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, license_plate, daily_price')) {
          return Promise.resolve([
            { id: 'v-1', license_plate: 'LUX-CHIRON-01', daily_price: '20000.00', status: 'active' },
          ]);
        }
        if (sql.includes('INSERT INTO audit_logs')) {
          return Promise.resolve([{ id: 'audit-log-777' }]);
        }
        return Promise.resolve([]);
      });

      const res = await pricingDemandService.applyRecommendation(
        'REC-1',
        'LUX-CHIRON-01',
        { approvedPrice: 21500, adminReason: 'Approved executive seasonal adjustment' },
        'admin-actor-1',
      );

      expect(res.success).toBe(true);
      expect(res.oldDailyPrice).toBe(20000);
      expect(res.newDailyPrice).toBe(21500);
      expect(res.auditLogId).toBe('audit-log-777');
      expect(mockVehiclesService.updateVehicle).toHaveBeenCalledWith('LUX-CHIRON-01', {
        dailyPrice: 21500,
      });
    });
  });

  describe('4. Historical Integrity Guarantee', () => {
    it('never alters past reservation amounts or payment records during forecast generation', async () => {
      const overview = await pricingDemandService.getPricingDemandOverview();
      expect(overview.timeline.length).toBe(1);
      expect(overview.timeline[0].dailyRevenue).toBe(7200);

      // Verify no UPDATE or DELETE queries were issued against reservations
      const allQueries = mockDataSource.query.mock.calls.map((call: any[]) => call[0]);
      for (const q of allQueries) {
        expect(q).not.toMatch(/UPDATE reservations/i);
        expect(q).not.toMatch(/DELETE FROM reservations/i);
      }
    });
  });

  describe('5. P7.1 Actionable Recommendations (Simulate, Dismiss, Rollback)', () => {
    it('simulates recommendation with duration scenarios without modifying vehicle rates', async () => {
      const sim = await pricingDemandService.simulateRecommendation('REC-LUXCHIRON01-1', {
        licensePlate: 'LUX-CHIRON-01',
        simulatedDailyPrice: 22000,
        rentalDays: 3,
      });

      expect(sim.simulatedDailyPrice).toBe(22000);
      expect(sim.scenarios.length).toBe(5);
      expect(sim.scenarios[0].days).toBe(1);
      expect(sim.scenarios[4].days).toBe(30);
      // Ensure no updateVehicle was called in simulation
      expect(mockVehiclesService.updateVehicle).not.toHaveBeenCalled();
    });

    it('rejects simulation exceeding 50% shift guardrail', async () => {
      await expect(
        pricingDemandService.simulateRecommendation('REC-LUXCHIRON01-1', {
          licensePlate: 'LUX-CHIRON-01',
          simulatedDailyPrice: 40000, // > 50% shift from 21000
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('dismisses recommendation and records audit trail', async () => {
      const dismissRes = await pricingDemandService.dismissRecommendation(
        'REC-LUXCHIRON01-1',
        { reason: 'Fleet manager decided to defer adjustment' },
        'admin-actor-2',
      );

      expect(dismissRes.success).toBe(true);
      expect(dismissRes.recommendationId).toBe('REC-LUXCHIRON01-1');
      expect(dismissRes.dismissedAt).toBeDefined();
    });

    it('rolls back an active pricing rule and restores original vehicle daily price', async () => {
      const mockRule = {
        ruleId: 'RULE-CHIRON-TEST',
        recommendationId: 'REC-LUXCHIRON01-1',
        vehicleId: 'v-1',
        licensePlate: 'LUX-CHIRON-01',
        brand: 'Bugatti',
        model: 'Chiron Sport',
        category: 'Hypercar',
        originalDailyPrice: 21000,
        approvedDailyPrice: 23000,
        variancePercent: 9.5,
        adminReason: 'Seasonal peak',
        appliedAt: new Date().toISOString(),
        status: 'active' as const,
      };

      mockDataSource.query.mockImplementation((sql: string) => {
        if (sql.includes('approved_pricing_rules')) {
          return Promise.resolve([{ value: JSON.stringify([mockRule]) }]);
        }
        if (sql.includes('INSERT INTO audit_logs')) {
          return Promise.resolve([{ id: 'audit-rollback-1' }]);
        }
        return Promise.resolve([]);
      });

      const rollbackRes = await pricingDemandService.rollbackPricingRule(
        'RULE-CHIRON-TEST',
        { reason: 'Customer feedback indicated price resistance' },
        'admin-actor-1',
      );

      expect(rollbackRes.success).toBe(true);
      expect(rollbackRes.rule.status).toBe('rolled_back');
      expect(rollbackRes.rule.rollbackReason).toContain('price resistance');
      expect(mockVehiclesService.updateVehicle).toHaveBeenCalledWith('LUX-CHIRON-01', {
        dailyPrice: 21000,
      });

      // Verify second rollback attempt throws error
      mockDataSource.query.mockImplementation((sql: string) => {
        if (sql.includes('approved_pricing_rules')) {
          return Promise.resolve([{ value: JSON.stringify([rollbackRes.rule]) }]);
        }
        return Promise.resolve([]);
      });

      await expect(
        pricingDemandService.rollbackPricingRule('RULE-CHIRON-TEST', { reason: 'Duplicate' }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
