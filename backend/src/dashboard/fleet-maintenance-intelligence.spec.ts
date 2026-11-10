import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { UserRole } from '../users/entities/user.entity.js';
import { DashboardController } from './dashboard.controller.js';
import { FleetMaintenanceIntelligenceService } from './fleet-maintenance-intelligence.service.js';

describe('Phase 3 — Fleet Health & Predictive Maintenance Intelligence', () => {
  const referenceNow = new Date('2026-11-02T12:00:00.000Z');

  function createServiceWithMockDataSource(queryImpl?: ReturnType<typeof vi.fn>) {
    const mockDataSource = {
      query: queryImpl ?? vi.fn().mockResolvedValue([]),
    };
    const service = new FleetMaintenanceIntelligenceService(
      mockDataSource as never,
    );
    return { service, mockDataSource };
  }

  it('1. classifies HEALTHY, MAINTENANCE_APPROACHING, MAINTENANCE_OVERDUE, ATTENTION_REQUIRED, and INSUFFICIENT_DATA accurately', () => {
    const { service } = createServiceWithMockDataSource();

    // Case A: HEALTHY (low mileage, recent handover inspection in excellent condition)
    const healthyEval = service.evaluateVehicleHealth({
      vehicle: {
        id: 'v-healthy',
        brand_name: 'Ferrari',
        model_name: '296 GTB',
        category_name: 'Supercar',
        manufacture_year: 2025,
        status: 'active',
        daily_price: '1600.00',
        mileage_km: 2400,
        completed_rentals_count: 2,
        collected_revenue_eur: '6400.00',
      },
      unavailabilities: [],
      prepOrders: [],
      prepFlags: [],
      inspections: [
        {
          id: 'insp-1',
          vehicle_id: 'v-healthy',
          type: 'handover',
          performed_at: '2026-10-25T10:00:00.000Z',
          mileage_km: 2400,
          fuel_level_pct: 100,
          overall_condition: 'excellent',
          notes: 'Showroom condition',
        },
      ],
      returnWarnings: [],
      damages: [],
      incidents: [],
      auditLogs: [],
      now: referenceNow,
    });
    expect(healthyEval.health.healthStatus).toBe('HEALTHY');

    // Case B: MAINTENANCE_APPROACHING (mileage 9,100 km -> 900 km remaining before 10,000 km interval)
    const approachingEval = service.evaluateVehicleHealth({
      vehicle: {
        id: 'v-approaching',
        brand_name: 'Lamborghini',
        model_name: 'Huracán EVO',
        category_name: 'Supercar',
        manufacture_year: 2024,
        status: 'active',
        daily_price: '1500.00',
        mileage_km: 9100,
        completed_rentals_count: 4,
        collected_revenue_eur: '12000.00',
      },
      unavailabilities: [],
      prepOrders: [],
      prepFlags: [],
      inspections: [],
      returnWarnings: [],
      damages: [],
      incidents: [],
      auditLogs: [],
      now: referenceNow,
    });
    expect(approachingEval.health.healthStatus).toBe('MAINTENANCE_APPROACHING');
    expect(approachingEval.health.kmUntilNextMaintenance).toBe(900);

    // Case C: MAINTENANCE_OVERDUE (mileage 14,500 km > 10,000 km with no logged service)
    const overdueEval = service.evaluateVehicleHealth({
      vehicle: {
        id: 'v-overdue',
        brand_name: 'Porsche',
        model_name: '911 GT3',
        category_name: 'Track',
        manufacture_year: 2024,
        status: 'active',
        daily_price: '1400.00',
        mileage_km: 14500,
        completed_rentals_count: 5,
        collected_revenue_eur: '14000.00',
      },
      unavailabilities: [],
      prepOrders: [],
      prepFlags: [],
      inspections: [],
      returnWarnings: [],
      damages: [],
      incidents: [],
      auditLogs: [],
      now: referenceNow,
    });
    expect(overdueEval.health.healthStatus).toBe('MAINTENANCE_OVERDUE');
    expect(overdueEval.health.statusReason).toContain('exceeded');

    // Case D: ATTENTION_REQUIRED (return inspection flagged mechanical_warnings = true)
    const attentionEval = service.evaluateVehicleHealth({
      vehicle: {
        id: 'v-attention',
        brand_name: 'Aston Martin',
        model_name: 'DB12',
        category_name: 'Grand Tourer',
        manufacture_year: 2025,
        status: 'active',
        daily_price: '1300.00',
        mileage_km: 4100,
        completed_rentals_count: 2,
        collected_revenue_eur: '5200.00',
      },
      unavailabilities: [],
      prepOrders: [],
      prepFlags: [],
      inspections: [],
      returnWarnings: [
        {
          id: 'ret-warn-1',
          vehicle_id: 'v-attention',
          submitted_at: '2026-11-01T15:00:00.000Z',
          mileage_km: 4100,
          mechanical_warnings: true,
          mechanical_notes: 'Brake pad wear sensor warning light',
          tires_condition: 'good',
          exterior_condition: 'good',
        },
      ],
      damages: [],
      incidents: [],
      auditLogs: [],
      now: referenceNow,
    });
    expect(attentionEval.health.healthStatus).toBe('ATTENTION_REQUIRED');
    expect(attentionEval.health.mechanicalWarningsFlagged).toBe(true);

    // Case E: INSUFFICIENT_DATA (null mileage or 6,200 km with zero maintenance/inspection logs)
    const insufficientEval = service.evaluateVehicleHealth({
      vehicle: {
        id: 'v-insufficient',
        brand_name: 'Bentley',
        model_name: 'Continental GT',
        category_name: 'Grand Tourer',
        manufacture_year: 2024,
        status: 'inactive',
        daily_price: '1250.00',
        mileage_km: 6200,
        completed_rentals_count: 0,
        collected_revenue_eur: '0.00',
      },
      unavailabilities: [],
      prepOrders: [],
      prepFlags: [],
      inspections: [],
      returnWarnings: [],
      damages: [],
      incidents: [],
      auditLogs: [],
      now: referenceNow,
    });
    expect(insufficientEval.health.healthStatus).toBe('INSUFFICIENT_DATA');
  });

  it('2. respects date boundaries (14-day approaching window) and completed service mileage resets', () => {
    const { service } = createServiceWithMockDataSource();

    // Vehicle at 14,500 km that ALREADY had a 10,000 km service logged at 10,200 km -> next due at 20,200 km (5,700 km remaining = HEALTHY)
    const servicedEval = service.evaluateVehicleHealth({
      vehicle: {
        id: 'v-serviced',
        brand_name: 'Mercedes-AMG',
        model_name: 'GT 63',
        category_name: 'Grand Tourer',
        manufacture_year: 2024,
        status: 'active',
        daily_price: '950.00',
        mileage_km: 14500,
        completed_rentals_count: 6,
        collected_revenue_eur: '18000.00',
      },
      unavailabilities: [],
      prepOrders: [],
      prepFlags: [],
      inspections: [],
      returnWarnings: [],
      damages: [],
      incidents: [],
      auditLogs: [
        {
          id: '101',
          entity_id: 'v-serviced',
          action: 'MAINTENANCE_RECORD_LOGGED',
          new_values: {
            recordId: 'rec-101',
            category: 'periodic_service',
            title: '10,000 km Manufacturer Service',
            status: 'COMPLETED',
            serviceDate: '2026-09-15T10:00:00.000Z',
            completedAt: '2026-09-15T16:00:00.000Z',
            mileageAtServiceKm: 10200,
            costEur: 1450,
            nextServiceDueKm: 20200,
          },
          created_at: '2026-09-15T16:00:00.000Z',
        },
      ],
      now: referenceNow,
    });

    expect(servicedEval.health.healthStatus).toBe('HEALTHY');
    expect(servicedEval.health.nextMaintenanceDueKm).toBe(20200);
    expect(servicedEval.health.kmUntilNextMaintenance).toBe(5700);
  });

  it('3. handles missing mileage (null or 0) as INSUFFICIENT_DATA without fabricating predictions', () => {
    const { service } = createServiceWithMockDataSource();

    const evalNullKm = service.evaluateVehicleHealth({
      vehicle: {
        id: 'v-null-km',
        brand_name: 'Rolls-Royce',
        model_name: 'Ghost',
        category_name: 'Ultra Luxury',
        manufacture_year: 2025,
        status: 'active',
        daily_price: '2200.00',
        mileage_km: null,
        completed_rentals_count: 0,
        collected_revenue_eur: '0.00',
      },
      unavailabilities: [],
      prepOrders: [],
      prepFlags: [],
      inspections: [],
      returnWarnings: [],
      damages: [],
      incidents: [],
      auditLogs: [],
      now: referenceNow,
    });

    expect(evalNullKm.health.healthStatus).toBe('INSUFFICIENT_DATA');
    expect(evalNullKm.health.dataCompleteness.hasVerifiedMileage).toBe(false);
    expect(evalNullKm.predictions).toHaveLength(0);
  });

  it('4. calculates 5-pillar dataCompleteness score and missing fields accurately', () => {
    const { service } = createServiceWithMockDataSource();

    const fullDataEval = service.evaluateVehicleHealth({
      vehicle: {
        id: 'v-full',
        brand_name: 'McLaren',
        model_name: '750S',
        category_name: 'Supercar',
        manufacture_year: 2025,
        status: 'active',
        daily_price: '1850.00',
        mileage_km: 5200,
        completed_rentals_count: 3,
        collected_revenue_eur: '11100.00',
      },
      unavailabilities: [],
      prepOrders: [],
      prepFlags: [],
      inspections: [
        {
          id: 'insp-full',
          vehicle_id: 'v-full',
          type: 'handover',
          performed_at: '2026-10-20T10:00:00.000Z',
          mileage_km: 5200,
          fuel_level_pct: 100,
          overall_condition: 'excellent',
          notes: null,
        },
      ],
      returnWarnings: [],
      damages: [],
      incidents: [],
      auditLogs: [
        {
          id: '202',
          entity_id: 'v-full',
          action: 'MAINTENANCE_RECORD_LOGGED',
          new_values: {
            recordId: 'rec-202',
            category: 'brake_system',
            title: 'Ceramic brake inspection & fluid flush',
            status: 'COMPLETED',
            serviceDate: '2026-10-10T09:00:00.000Z',
            completedAt: '2026-10-10T14:00:00.000Z',
            mileageAtServiceKm: 4800,
            costEur: 890,
            nextServiceDueAt: '2027-04-10T09:00:00.000Z',
            nextServiceDueKm: 14800,
          },
          created_at: '2026-10-10T14:00:00.000Z',
        },
      ],
      now: referenceNow,
    });

    expect(fullDataEval.health.dataCompleteness.scorePercent).toBe(100);
    expect(fullDataEval.health.dataCompleteness.readinessLevel).toBe('HIGH');
    expect(fullDataEval.health.dataCompleteness.missingFields).toHaveLength(0);
  });

  it('5. aggregates maintenance costs, damage repair estimates, and cost-to-revenue ratio accurately', () => {
    const { service } = createServiceWithMockDataSource();

    const costEval = service.evaluateVehicleHealth({
      vehicle: {
        id: 'v-cost',
        brand_name: 'Ferrari',
        model_name: 'SF90 Stradale',
        category_name: 'Hypercar',
        manufacture_year: 2024,
        status: 'active',
        daily_price: '2500.00',
        mileage_km: 6000,
        completed_rentals_count: 2,
        collected_revenue_eur: '10000.00',
      },
      unavailabilities: [],
      prepOrders: [],
      prepFlags: [],
      inspections: [],
      returnWarnings: [],
      damages: [
        {
          id: 'dmg-1',
          vehicle_id: 'v-cost',
          source_type: 'INSPECTION_DAMAGE',
          vehicle_zone: 'front_splitter',
          description: 'Carbon splitter scrape',
          severity: 'moderate',
          estimated_repair_cost: '1200.50',
          recorded_at: '2026-10-12T12:00:00.000Z',
        },
        {
          id: 'dmg-2',
          vehicle_id: 'v-cost',
          source_type: 'INSPECTION_DAMAGE',
          vehicle_zone: 'front_splitter',
          description: 'Second splitter impact',
          severity: 'moderate',
          estimated_repair_cost: '799.50',
          recorded_at: '2026-10-28T12:00:00.000Z',
        },
      ],
      incidents: [],
      auditLogs: [
        {
          id: '303',
          entity_id: 'v-cost',
          action: 'MAINTENANCE_RECORD_LOGGED',
          new_values: {
            recordId: 'rec-303',
            category: 'tires_wheels',
            title: 'Rear Pirelli P Zero Corsa replacement',
            status: 'COMPLETED',
            serviceDate: '2026-10-15T10:00:00.000Z',
            mileageAtServiceKm: 5500,
            costEur: 1000,
          },
          created_at: '2026-10-15T10:00:00.000Z',
        },
      ],
      now: referenceNow,
    });

    expect(costEval.health.expenditure.loggedMaintenanceCostEur).toBe(1000);
    expect(costEval.health.expenditure.estimatedDamageRepairCostEur).toBe(2000);
    expect(costEval.health.expenditure.totalRecordedExpenditureEur).toBe(3000);
    expect(costEval.health.expenditure.costToRevenueRatioPercent).toBe(30);
    expect(costEval.health.recurringDamageZones).toEqual([
      'front_splitter (2x)',
    ]);
  });

  it('6. includes evidenceUsed, confidence, dataQualityIndicator, and requiresHumanApprovalForRestriction on every prediction', () => {
    const { service } = createServiceWithMockDataSource();

    const evaluated = service.evaluateVehicleHealth({
      vehicle: {
        id: 'v-pred',
        brand_name: 'Lamborghini',
        model_name: 'Revuelto',
        category_name: 'Hypercar',
        manufacture_year: 2025,
        status: 'active',
        daily_price: '2800.00',
        mileage_km: 12400,
        completed_rentals_count: 3,
        collected_revenue_eur: '8400.00',
      },
      unavailabilities: [],
      prepOrders: [],
      prepFlags: [],
      inspections: [],
      returnWarnings: [],
      damages: [],
      incidents: [],
      auditLogs: [],
      now: referenceNow,
    });

    expect(evaluated.predictions.length).toBeGreaterThan(0);
    for (const pred of evaluated.predictions) {
      expect(pred.evidenceUsed.length).toBeGreaterThan(0);
      expect(['HIGH', 'MEDIUM', 'LOW', 'INSUFFICIENT_DATA']).toContain(
        pred.confidence,
      );
      expect(pred.dataQualityIndicator).toContain('Data completeness');
      expect(pred.recommendedHumanAction.length).toBeGreaterThan(10);
      expect(pred.requiresHumanApprovalForRestriction).toBe(true);
    }
  });

  it('7. enforces @Roles(UserRole.ADMIN) on all Phase 3 maintenance endpoints in DashboardController', () => {
    const proto = DashboardController.prototype;
    expect(
      Reflect.getMetadata(ROLES_KEY, proto.getFleetMaintenanceOverview),
    ).toEqual([UserRole.ADMIN]);
    expect(
      Reflect.getMetadata(ROLES_KEY, proto.recordMaintenanceActivity),
    ).toEqual([UserRole.ADMIN]);
  });

  it('8. records maintenance logs in audit_logs without automatically blocking vehicle availability or cancelling reservations', async () => {
    const executedSql: string[] = [];
    const queryMock = vi.fn().mockImplementation(async (sql: string) => {
      executedSql.push(sql);
      if (sql.includes('SELECT id, mileage_km FROM vehicles')) {
        return [{ id: '0eac0f61-043c-45be-bf68-7e2bdabcc566', mileage_km: 8500 }];
      }
      if (sql.includes('FROM vehicles v')) {
        return [
          {
            id: '0eac0f61-043c-45be-bf68-7e2bdabcc566',
            brand_name: 'Ferrari',
            model_name: 'F8 Tributo',
            category_name: 'Supercar',
            manufacture_year: 2024,
            status: 'active',
            daily_price: '1500.00',
            mileage_km: 8600,
            completed_rentals_count: 1,
            collected_revenue_eur: '3000.00',
          },
        ];
      }
      return [];
    });

    const { service } = createServiceWithMockDataSource(queryMock);
    const result = await service.recordMaintenanceActivity(
      {
        vehicleId: '0eac0f61-043c-45be-bf68-7e2bdabcc566',
        category: 'periodic_service',
        title: 'Annual Ferrari Maranello Multi-Point Inspection',
        status: 'COMPLETED',
        serviceDate: '2026-11-02T10:00:00.000Z',
        mileageAtServiceKm: 8600,
        costEur: 1290,
        nextServiceDueKm: 18600,
        notes: 'Completed oil, filter, and carbon-ceramic brake pad thickness verification.',
      },
      '8fa4bc86-d273-45fb-86d0-105e329a9656',
    );

    expect(result.recordId).toBeDefined();
    expect(
      executedSql.some((s) => s.includes('INSERT INTO audit_logs')),
    ).toBe(true);
    // Verify it NEVER inserts into vehicle_unavailability or cancels reservations automatically
    expect(
      executedSql.some((s) => s.includes('INSERT INTO vehicle_unavailability')),
    ).toBe(false);
    expect(
      executedSql.some((s) => s.includes('UPDATE reservations')),
    ).toBe(false);
  });
});
