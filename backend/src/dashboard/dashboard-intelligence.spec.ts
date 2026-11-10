import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { UserRole } from '../users/entities/user.entity.js';
import { DashboardService } from './dashboard.service.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardIntelligenceService } from './dashboard-intelligence.service.js';

const MOCK_FLEET = [
  {
    id: 'v-amg-one',
    status: 'active',
    dailyPrice: '2800.00',
    brandName: 'Mercedes-AMG',
    modelName: 'AMG ONE',
    categoryId: 'cat-hyper',
    categoryName: 'Hypercar',
    locationId: 'loc-bud',
  },
  {
    id: 'v-urus',
    status: 'active',
    dailyPrice: '1150.00',
    brandName: 'Lamborghini',
    modelName: 'Urus SE',
    categoryId: 'cat-suv',
    categoryName: 'Luxury SUV',
    locationId: 'loc-bud',
  },
  {
    id: 'v-gt3',
    status: 'maintenance',
    dailyPrice: '1400.00',
    brandName: 'Porsche',
    modelName: '911 GT3 RS',
    categoryId: 'cat-sport',
    categoryName: 'Track Coupe',
    locationId: 'loc-bud',
  },
];

const MOCK_LOCATIONS = [
  {
    id: 'loc-bud',
    code: 'BUD-SHOWROOM',
    name: 'LUXUAR Budapest Showroom',
    city: 'Budapest',
  },
];

const MOCK_RESERVATIONS = [
  // 1. Confirmed reservation in current period (3 days @ 2800 = 8400, deposit 15000)
  {
    id: 'res-confirmed-1',
    reservationNumber: 'RES-2026-000101',
    vehicleId: 'v-amg-one',
    status: 'confirmed',
    pickupAt: '2026-10-10T10:00:00.000Z',
    returnAt: '2026-10-13T10:00:00.000Z',
    rentalDays: 3,
    dailyPrice: '2800.00',
    totalAmount: '8400.00',
    depositAmount: '15000.00',
    depositRefundStatus: 'none',
    depositRefundedAmount: '0.00',
    depositRetainedAmount: '0.00',
    agencyPaymentStatus: 'none',
    isDemoPayment: false,
    stripePaymentIntentId: 'pi_verified_101',
    createdAt: '2026-10-08T10:00:00.000Z',
  },
  // 2. Completed reservation with manual approved payment (2 days @ 1150 = 2300)
  {
    id: 'res-completed-2',
    reservationNumber: 'RES-2026-000102',
    vehicleId: 'v-urus',
    status: 'completed',
    pickupAt: '2026-10-15T10:00:00.000Z',
    returnAt: '2026-10-17T10:00:00.000Z',
    rentalDays: 2,
    dailyPrice: '1150.00',
    totalAmount: '2300.00',
    depositAmount: '6000.00',
    depositRefundStatus: 'partially_retained',
    depositRefundedAmount: '5000.00',
    depositRetainedAmount: '1000.00',
    agencyPaymentStatus: 'approved',
    isDemoPayment: false,
    stripePaymentIntentId: null,
    createdAt: '2026-10-14T10:00:00.000Z',
  },
  // 3. Pending reservation in pipeline (4 days @ 1150 = 4600)
  {
    id: 'res-pending-3',
    reservationNumber: 'RES-2026-000103',
    vehicleId: 'v-urus',
    status: 'pending',
    pickupAt: '2026-10-22T10:00:00.000Z',
    returnAt: '2026-10-26T10:00:00.000Z',
    rentalDays: 4,
    dailyPrice: '1150.00',
    totalAmount: '4600.00',
    depositAmount: '6000.00',
    depositRefundStatus: 'none',
    depositRefundedAmount: '0.00',
    depositRetainedAmount: '0.00',
    agencyPaymentStatus: 'none',
    isDemoPayment: false,
    stripePaymentIntentId: null,
    createdAt: '2026-10-20T10:00:00.000Z',
  },
  // 4. Cancelled unpaid reservation (must NOT count in revenue or conversion)
  {
    id: 'res-cancelled-4',
    reservationNumber: 'RES-2026-000104',
    vehicleId: 'v-amg-one',
    status: 'cancelled_unpaid',
    pickupAt: '2026-10-25T10:00:00.000Z',
    returnAt: '2026-10-27T10:00:00.000Z',
    rentalDays: 2,
    dailyPrice: '2800.00',
    totalAmount: '5600.00',
    depositAmount: '15000.00',
    depositRefundStatus: 'none',
    depositRefundedAmount: '0.00',
    depositRetainedAmount: '0.00',
    agencyPaymentStatus: 'none',
    isDemoPayment: false,
    stripePaymentIntentId: null,
    createdAt: '2026-10-21T10:00:00.000Z',
  },
  // 5. Previous period confirmed reservation (2026-09-12 to 2026-09-14: 2 days @ 2800 = 5600)
  {
    id: 'res-prev-5',
    reservationNumber: 'RES-2026-000090',
    vehicleId: 'v-amg-one',
    status: 'completed',
    pickupAt: '2026-09-12T10:00:00.000Z',
    returnAt: '2026-09-14T10:00:00.000Z',
    rentalDays: 2,
    dailyPrice: '2800.00',
    totalAmount: '5600.00',
    depositAmount: '15000.00',
    depositRefundStatus: 'refunded',
    depositRefundedAmount: '15000.00',
    depositRetainedAmount: '0.00',
    agencyPaymentStatus: 'none',
    isDemoPayment: false,
    stripePaymentIntentId: 'pi_prev_90',
    createdAt: '2026-09-10T10:00:00.000Z',
  },
];

const MOCK_PAYMENTS = [
  // Valid Stripe payment for res-confirmed-1 (8400 EUR)
  {
    id: 'pay-1',
    reservationId: 'res-confirmed-1',
    type: 'rental_payment',
    method: 'card',
    amount: '8400.00',
    paidAt: '2026-10-09T12:00:00.000Z',
    reference: 'pi_verified_101',
    provider: 'stripe',
    isSimulated: false,
    isDemo: false,
    reservationStatus: 'confirmed',
    agencyPaymentStatus: 'none',
    reservationIsDemo: false,
    stripePaymentIntentId: 'pi_verified_101',
    vehicleId: 'v-amg-one',
  },
  // Superseded duplicate Stripe session on res-confirmed-1 (MUST BE EXCLUDED)
  {
    id: 'pay-dup-1',
    reservationId: 'res-confirmed-1',
    type: 'rental_payment',
    method: 'card',
    amount: '8400.00',
    paidAt: '2026-10-09T11:55:00.000Z',
    reference: 'pi_old_duplicate_999',
    provider: 'stripe',
    isSimulated: false,
    isDemo: false,
    reservationStatus: 'confirmed',
    agencyPaymentStatus: 'none',
    reservationIsDemo: false,
    stripePaymentIntentId: 'pi_verified_101',
    vehicleId: 'v-amg-one',
  },
  // Valid approved manual payment for res-completed-2 (2300 EUR)
  {
    id: 'pay-2',
    reservationId: 'res-completed-2',
    type: 'rental_payment',
    method: 'cash',
    amount: '2300.00',
    paidAt: '2026-10-15T09:00:00.000Z',
    reference: 'MANUAL-AGENCY-102',
    provider: 'manual_agency',
    isSimulated: false,
    isDemo: false,
    reservationStatus: 'completed',
    agencyPaymentStatus: 'approved',
    reservationIsDemo: false,
    stripePaymentIntentId: null,
    vehicleId: 'v-urus',
  },
  // Partial refund of 300 EUR on res-completed-2 (MUST BE SUBTRACTED)
  {
    id: 'pay-refund-2',
    reservationId: 'res-completed-2',
    type: 'refund',
    method: 'card',
    amount: '300.00',
    paidAt: '2026-10-18T12:00:00.000Z',
    reference: 're_refund_102',
    provider: 'stripe',
    isSimulated: false,
    isDemo: false,
    reservationStatus: 'completed',
    agencyPaymentStatus: 'approved',
    reservationIsDemo: false,
    stripePaymentIntentId: null,
    vehicleId: 'v-urus',
  },
  // Demo / simulated payment (MUST BE EXCLUDED from collected revenue)
  {
    id: 'pay-demo-99',
    reservationId: 'res-confirmed-1',
    type: 'rental_payment',
    method: 'manual_agency_demo',
    amount: '9999.00',
    paidAt: '2026-10-11T12:00:00.000Z',
    reference: 'DEMO-AGENCY-99',
    provider: 'manual_agency_demo',
    isSimulated: true,
    isDemo: true,
    reservationStatus: 'confirmed',
    agencyPaymentStatus: 'none',
    reservationIsDemo: true,
    stripePaymentIntentId: null,
    vehicleId: 'v-amg-one',
  },
  // Previous period verified payment (5600 EUR)
  {
    id: 'pay-prev-90',
    reservationId: 'res-prev-5',
    type: 'rental_payment',
    method: 'card',
    amount: '5600.00',
    paidAt: '2026-09-11T12:00:00.000Z',
    reference: 'pi_prev_90',
    provider: 'stripe',
    isSimulated: false,
    isDemo: false,
    reservationStatus: 'completed',
    agencyPaymentStatus: 'none',
    reservationIsDemo: false,
    stripePaymentIntentId: 'pi_prev_90',
    vehicleId: 'v-amg-one',
  },
];

describe('Phase 2: Business Intelligence & Reporting', () => {
  let dataSourceMock: { query: ReturnType<typeof vi.fn> };
  let dashboardService: DashboardService;
  let intelligenceService: DashboardIntelligenceService;
  let controller: DashboardController;

  beforeEach(() => {
    dataSourceMock = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM vehicles') && sql.includes('GROUP BY status')) {
          return [
            { status: 'active', total: 2 },
            { status: 'maintenance', total: 1 },
          ];
        }
        if (
          sql.includes('FROM reservations') &&
          sql.includes('GROUP BY status')
        ) {
          return [
            { status: 'confirmed', total: 1 },
            { status: 'completed', total: 2 },
            { status: 'pending', total: 1 },
            { status: 'cancelled_unpaid', total: 1 },
          ];
        }
        if (sql.includes('FROM customer_profiles')) {
          return [{ total: 14 }];
        }
        if (sql.includes('FROM reservations r')) {
          return MOCK_RESERVATIONS;
        }
        if (sql.includes('FROM payments p')) {
          return MOCK_PAYMENTS;
        }
        if (sql.includes('FROM vehicles v')) {
          return MOCK_FLEET;
        }
        if (sql.includes('FROM rental_locations')) {
          return MOCK_LOCATIONS;
        }
        return [];
      }),
    };

    dashboardService = new DashboardService(dataSourceMock as never);
    intelligenceService = new DashboardIntelligenceService(
      dataSourceMock as never,
      dashboardService,
    );
    controller = new DashboardController(
      dashboardService,
      intelligenceService,
      undefined as never,
      undefined as never,
      undefined as never,
    );
  });

  it('1. preserves existing DashboardService.getSummary() and GET /dashboard/admin without regression', async () => {
    const summary = await controller.getAdminDashboard();
    expect(summary).toEqual({
      vehicles: {
        total: 3,
        byStatus: { active: 2, maintenance: 1 },
      },
      reservations: {
        total: 5,
        byStatus: {
          confirmed: 1,
          completed: 2,
          pending: 1,
          cancelled_unpaid: 1,
        },
      },
      customers: { total: 14 },
    });
  });

  it('2. accurately classifies collected revenue, contracted revenue, pipeline, refunds, and deposits while excluding duplicates and demos', async () => {
    const report = await intelligenceService.getExecutiveReport({
      from: '2026-10-01',
      to: '2026-10-30',
      granularity: 'day',
    });

    // Verified Stripe (8400) + Verified Manual (2300) - Refund (300) = 10400 EUR
    // Duplicate Stripe (8400) and Demo (9999) are strictly excluded!
    expect(report.financials.collectedRevenueEur).toBe(10400);
    expect(report.financials.verifiedStripeRevenueEur).toBe(8100);
    expect(report.financials.verifiedManualRevenueEur).toBe(2300);
    expect(report.financials.refundedEur).toBe(300);

    // Contracted revenue: res-confirmed-1 (8400) + res-completed-2 (2300) = 10700 EUR
    expect(report.financials.contractedRevenueEur).toBe(10700);

    // Pending pipeline: res-pending-3 (4600 EUR)
    expect(report.financials.pendingPipelineEur).toBe(4600);

    // Security deposits held separately: res-confirmed-1 has 15000 held; res-completed-2 has 1000 retained & 5000 refunded
    expect(report.financials.depositsHeldEur).toBe(15000);
    expect(report.financials.depositsRetainedEur).toBe(1000);
    expect(report.financials.depositsRefundedEur).toBe(5000);

    // Average rental value: 10700 / 2 confirmed/completed bookings = 5350 EUR
    expect(report.financials.averageRentalValueEur).toBe(5350);
    expect(report.financials.averageRentalDurationDays).toBe(2.5);

    // Period-over-period comparison against previous 30-day window (5600 EUR collected)
    expect(report.financials.comparisons.collectedRevenue.previous).toBe(5600);
    expect(report.financials.comparisons.collectedRevenue.deltaAbsolute).toBe(
      4800,
    );
    expect(report.financials.comparisons.collectedRevenue.deltaPercent).toBe(
      85.71,
    );
  });

  it('3. validates date-range boundaries and rejects invalid or excessive ranges', () => {
    expect(() =>
      intelligenceService.resolveDateWindow({
        from: '2026-10-30',
        to: '2026-10-01',
      }),
    ).toThrowError(BadRequestException);

    expect(() =>
      intelligenceService.resolveDateWindow({
        from: '2023-01-01',
        to: '2026-10-30',
      }),
    ).toThrowError(BadRequestException);
  });

  it('4. calculates reservation funnel conversion and cancellation rates accurately', async () => {
    const report = await intelligenceService.getExecutiveReport({
      from: '2026-10-01',
      to: '2026-10-30',
    });

    // 4 reservations in October: 1 confirmed, 1 completed, 1 pending, 1 cancelled_unpaid
    expect(report.reservations.totalInPeriod).toBe(4);
    expect(report.reservations.confirmedOrCompletedCount).toBe(2);
    expect(report.reservations.pendingCount).toBe(1);
    expect(report.reservations.cancelledOrExpiredCount).toBe(1);
    expect(report.reservations.conversionRatePercent).toBe(50);
    expect(report.reservations.cancellationRatePercent).toBe(25);
  });

  it('5. computes vehicle utilization rate, category rankings, and agency performance', async () => {
    const report = await intelligenceService.getExecutiveReport({
      from: '2026-10-01',
      to: '2026-10-30',
    });

    // 30-day window; 2 active vehicles (AMG ONE: 3 days -> 10%, Urus SE: 2 days -> 6.67%)
    // Overall active fleet utilization: (3 + 2) / (2 * 30) = 5 / 60 = 8.33%
    expect(report.fleetUtilization.activeFleetCount).toBe(2);
    expect(report.fleetUtilization.maintenanceFleetCount).toBe(1);
    expect(report.fleetUtilization.overallUtilizationRatePercent).toBe(8.33);

    const amgPerf = report.fleetUtilization.allVehicles.find(
      (v) => v.vehicleId === 'v-amg-one',
    )!;
    expect(amgPerf.rentedDaysInPeriod).toBe(3);
    expect(amgPerf.utilizationRatePercent).toBe(10);
    expect(amgPerf.collectedRevenueEur).toBe(8400);

    // Top category should be Hypercar (8400 EUR collected)
    expect(report.categories[0].categoryName).toBe('Hypercar');
    expect(report.categories[0].collectedRevenueEur).toBe(8400);

    // Agency performance for Budapest showroom
    expect(report.agencies).toHaveLength(1);
    expect(report.agencies[0].collectedRevenueEur).toBe(10400);
  });

  it('6. handles empty / missing data gracefully without NaN or fabricated metrics', async () => {
    dataSourceMock.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM customer_profiles')) return [{ total: 0 }];
      return [];
    });
    intelligenceService.clearCache();

    const emptyReport = await intelligenceService.getExecutiveReport({
      from: '2026-10-01',
      to: '2026-10-30',
    });

    expect(emptyReport.financials.collectedRevenueEur).toBe(0);
    expect(emptyReport.financials.averageRentalValueEur).toBeNull();
    expect(emptyReport.financials.averageRentalDurationDays).toBeNull();
    expect(emptyReport.reservations.conversionRatePercent).toBeNull();
    expect(
      emptyReport.fleetUtilization.overallUtilizationRatePercent,
    ).toBeNull();
  });

  it('7. enforces ADMIN role authorization metadata on DashboardController endpoints', () => {
    const adminRoles = Reflect.getMetadata(
      ROLES_KEY,
      DashboardController.prototype.getAdminDashboard,
    );
    const intelRoles = Reflect.getMetadata(
      ROLES_KEY,
      DashboardController.prototype.getAdminIntelligence,
    );

    expect(adminRoles).toEqual([UserRole.ADMIN]);
    expect(intelRoles).toEqual([UserRole.ADMIN]);
  });
});
