import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { DashboardService } from './dashboard.service.js';
import type {
  AgencyPerformanceItemDto,
  CategoryPerformanceItemDto,
  DashboardIntelligenceQueryDto,
  ExecutiveIntelligenceReportDto,
  OperationalHighlightDto,
  PeriodComparisonMetric,
  TimeGranularity,
  TimeSeriesPointDto,
  UpcomingReservationItemDto,
  VehiclePerformanceItemDto,
} from './dto/dashboard-intelligence.dto.js';

interface RawReservationAnalyticsRow {
  id: string;
  reservationNumber: string;
  vehicleId: string;
  status: string;
  pickupAt: Date | string;
  returnAt: Date | string;
  rentalDays: number | string;
  dailyPrice: string;
  totalAmount: string;
  depositAmount: string;
  depositRefundStatus: string | null;
  depositRefundedAmount: string | null;
  depositRetainedAmount: string | null;
  agencyPaymentStatus: string | null;
  isDemoPayment: boolean | null;
  stripePaymentIntentId: string | null;
  createdAt: Date | string;
}

interface RawPaymentAnalyticsRow {
  id: string;
  reservationId: string;
  type: string;
  method: string;
  amount: string;
  paidAt: Date | string;
  reference: string | null;
  provider: string | null;
  isSimulated: boolean | null;
  isDemo: boolean | null;
  reservationStatus: string;
  agencyPaymentStatus: string | null;
  reservationIsDemo: boolean | null;
  stripePaymentIntentId: string | null;
  vehicleId: string;
}

interface RawVehicleFleetRow {
  id: string;
  status: string;
  dailyPrice: string;
  brandName: string;
  modelName: string;
  categoryId: string;
  categoryName: string;
  locationId: string | null;
}

interface RawLocationRow {
  id: string;
  code: string;
  name: string;
  city: string;
}

const CONFIRMED_STATUSES = new Set([
  'confirmed',
  'active_rental',
  'completed',
  'converted',
]);
const PIPELINE_STATUSES = new Set(['pending', 'awaiting_payment']);
const CANCELLED_OR_EXPIRED_STATUSES = new Set([
  'cancelled',
  'cancelled_unpaid',
  'expired',
  'no_show',
]);

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

@Injectable()
export class DashboardIntelligenceService {
  private readonly cache = new Map<
    string,
    { expiresAt: number; data: ExecutiveIntelligenceReportDto }
  >();
  private readonly cacheTtlMs = 15_000;

  constructor(
    private readonly dataSource: DataSource,
    private readonly dashboardService: DashboardService,
    private readonly configService?: ConfigService,
  ) {}

  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Authoritative payment classification matching FinanceService.getFinanceOverview().
   */
  classifyPaymentRecord(p: RawPaymentAnalyticsRow): {
    integrityStatus: 'STRIPE_VERIFIED' | 'MANUAL_VERIFIED' | 'FAILED_REJECTED';
    isDemo: boolean;
    isDuplicate: boolean;
  } {
    const refLower = (p.reference || '').toLowerCase();
    const isStripeMethod =
      p.method === 'card' ||
      p.provider === 'stripe' ||
      refLower.startsWith('pi_') ||
      refLower.startsWith('cs_');

    let isDuplicate = false;
    if (isStripeMethod && p.stripePaymentIntentId) {
      const piId = p.stripePaymentIntentId;
      const isMatch =
        p.reference === piId ||
        p.reference === `${piId}-deposit` ||
        Boolean(p.reference?.startsWith(`${piId}_`));
      isDuplicate = !isMatch;
    }

    const isAgencyMethod =
      p.method === 'manual_agency_demo' ||
      p.provider === 'manual_agency_demo' ||
      p.method === 'cash' ||
      p.method === 'bank_transfer' ||
      p.provider === 'manual_agency' ||
      refLower.startsWith('demo-agency') ||
      refLower.startsWith('manual-agency');

    const isRejected =
      (isAgencyMethod && p.agencyPaymentStatus === 'rejected') ||
      p.reservationStatus === 'cancelled_unpaid' ||
      p.reservationStatus === 'rejected';

    const isDemo =
      Boolean(p.isDemo || p.isSimulated || p.reservationIsDemo) ||
      p.method === 'manual_agency_demo' ||
      p.provider === 'manual_agency_demo' ||
      refLower.startsWith('demo-agency');

    let integrityStatus:
      | 'STRIPE_VERIFIED'
      | 'MANUAL_VERIFIED'
      | 'FAILED_REJECTED';

    if (isRejected || isDuplicate) {
      integrityStatus = 'FAILED_REJECTED';
    } else if (isStripeMethod && CONFIRMED_STATUSES.has(p.reservationStatus)) {
      integrityStatus = 'STRIPE_VERIFIED';
    } else if (
      (p.provider === 'manual_agency' ||
        refLower.startsWith('manual-agency') ||
        p.method === 'cash' ||
        p.method === 'bank_transfer') &&
      p.agencyPaymentStatus === 'approved' &&
      CONFIRMED_STATUSES.has(p.reservationStatus)
    ) {
      integrityStatus = 'MANUAL_VERIFIED';
    } else {
      integrityStatus = 'FAILED_REJECTED';
    }

    return { integrityStatus, isDemo, isDuplicate };
  }

  resolveDateWindow(query: DashboardIntelligenceQueryDto = {}): {
    fromDateStr: string;
    toDateStr: string;
    fromStart: Date;
    toEnd: Date;
    prevFromDateStr: string;
    prevToDateStr: string;
    prevStart: Date;
    prevEnd: Date;
    daysCount: number;
    granularity: TimeGranularity;
  } {
    const now = new Date();
    const todayUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );

    const toDateStr = query.to ?? todayUtc.toISOString().slice(0, 10);
    const defaultFromDate = new Date(todayUtc.getTime() - 29 * 86_400_000);
    const fromDateStr =
      query.from ?? defaultFromDate.toISOString().slice(0, 10);

    const fromStart = new Date(`${fromDateStr}T00:00:00.000Z`);
    const toEnd = new Date(`${toDateStr}T23:59:59.999Z`);

    if (
      Number.isNaN(fromStart.getTime()) ||
      Number.isNaN(toEnd.getTime()) ||
      fromStart.getTime() > toEnd.getTime()
    ) {
      throw new BadRequestException(
        'Invalid date range: "from" must be earlier than or equal to "to".',
      );
    }

    const daysCount = Math.max(
      1,
      Math.round((toEnd.getTime() - fromStart.getTime()) / 86_400_000),
    );
    if (daysCount > 731) {
      throw new BadRequestException(
        'Date range cannot exceed 731 days (2 years).',
      );
    }

    const prevEnd = new Date(fromStart.getTime() - 1);
    const prevStart = new Date(
      fromStart.getTime() - daysCount * 86_400_000,
    );
    const prevFromDateStr = prevStart.toISOString().slice(0, 10);
    const prevToDateStr = prevEnd.toISOString().slice(0, 10);

    const granularity: TimeGranularity =
      query.granularity ??
      (daysCount <= 31 ? 'day' : daysCount <= 120 ? 'week' : 'month');

    return {
      fromDateStr,
      toDateStr,
      fromStart,
      toEnd,
      prevFromDateStr,
      prevToDateStr,
      prevStart,
      prevEnd,
      daysCount,
      granularity,
    };
  }

  async getExecutiveReport(
    query: DashboardIntelligenceQueryDto = {},
  ): Promise<ExecutiveIntelligenceReportDto> {
    const window = this.resolveDateWindow(query);
    const cacheKey = `${window.fromDateStr}:${window.toDateStr}:${window.granularity}`;
    const nowMs = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > nowMs) {
      return cached.data;
    }

    const [
      systemSnapshot,
      reservationsRows,
      paymentsRows,
      fleetRows,
      locationsRows,
    ] = await Promise.all([
      this.dashboardService.getSummary(),
      this.dataSource.query(
        `SELECT
           r.id,
           r.reservation_number AS "reservationNumber",
           r.vehicle_id AS "vehicleId",
           r.status::text AS status,
           r.pickup_at AS "pickupAt",
           r.return_at AS "returnAt",
           r.rental_days AS "rentalDays",
           r.daily_price AS "dailyPrice",
           r.total_amount AS "totalAmount",
           r.deposit_amount AS "depositAmount",
           r.deposit_refund_status AS "depositRefundStatus",
           r.deposit_refunded_amount AS "depositRefundedAmount",
           r.deposit_retained_amount AS "depositRetainedAmount",
           r.agency_payment_status AS "agencyPaymentStatus",
           r.is_demo_payment AS "isDemoPayment",
           r.stripe_payment_intent_id AS "stripePaymentIntentId",
           r.created_at AS "createdAt"
         FROM reservations r
         WHERE r.created_at >= $1::timestamptz
            OR r.return_at >= $1::timestamptz
            OR r.pickup_at >= $1::timestamptz
         ORDER BY r.pickup_at ASC`,
        [window.prevStart.toISOString()],
      ) as Promise<RawReservationAnalyticsRow[]>,
      this.dataSource.query(
        `SELECT
           p.id,
           p.reservation_id AS "reservationId",
           p.type,
           p.method,
           p.amount,
           p.paid_at AS "paidAt",
           p.reference,
           p.provider,
           p.is_simulated AS "isSimulated",
           p.is_demo AS "isDemo",
           r.status::text AS "reservationStatus",
           r.agency_payment_status AS "agencyPaymentStatus",
           r.is_demo_payment AS "reservationIsDemo",
           r.stripe_payment_intent_id AS "stripePaymentIntentId",
           r.vehicle_id AS "vehicleId"
         FROM payments p
         JOIN reservations r ON r.id = p.reservation_id
         WHERE p.paid_at >= $1::timestamptz
           AND p.paid_at <= $2::timestamptz
         ORDER BY p.paid_at ASC`,
        [window.prevStart.toISOString(), window.toEnd.toISOString()],
      ) as Promise<RawPaymentAnalyticsRow[]>,
      this.dataSource.query(
        `SELECT
           v.id,
           v.status::text AS status,
           v.daily_price AS "dailyPrice",
           b.name AS "brandName",
           vm.name AS "modelName",
           c.id AS "categoryId",
           c.name AS "categoryName",
           COALESCE(v.home_location_id, vrl.location_id) AS "locationId"
         FROM vehicles v
         JOIN vehicle_models vm ON vm.id = v.model_id
         JOIN brands b ON b.id = vm.brand_id
         JOIN categories c ON c.id = vm.category_id
         LEFT JOIN vehicle_rental_locations vrl ON vrl.vehicle_id = v.id
         ORDER BY b.name ASC, vm.name ASC`,
      ) as Promise<RawVehicleFleetRow[]>,
      this.dataSource.query(
        `SELECT id, code, name, city
         FROM rental_locations
         WHERE enabled = TRUE 
           AND category = 'showroom'
           AND code NOT LIKE 'DEMO-%'
         ORDER BY city ASC, name ASC`,
      ) as Promise<RawLocationRow[]>,
    ]);

    const defaultAgencyCode =
      this.configService?.get<string>('DEFAULT_RENTAL_AGENCY_CODE') ??
      'BUD-SHOWROOM';
    const defaultLocation =
      locationsRows.find((loc) => loc.code === defaultAgencyCode) ??
      locationsRows[0] ??
      null;

    // -------------------------------------------------------------------------
    // 1. FINANCIAL & PAYMENT CLASSIFICATION (Current vs Previous Period)
    // -------------------------------------------------------------------------
    let currStripeEur = 0;
    let currManualEur = 0;
    let currRefundEur = 0;
    let prevCollectedGrossEur = 0;
    let prevRefundEur = 0;

    const vehicleCollectedRevenueMap = new Map<string, number>();
    const paymentTimeSeriesEvents: Array<{
      date: Date;
      collectedDeltaEur: number;
    }> = [];

    for (const p of paymentsRows) {
      const paidAt = new Date(p.paidAt);
      const amount = Number(p.amount) || 0;
      const { integrityStatus, isDemo, isDuplicate } =
        this.classifyPaymentRecord(p);

      const inCurrent =
        paidAt >= window.fromStart && paidAt <= window.toEnd;
      const inPrev =
        paidAt >= window.prevStart && paidAt <= window.prevEnd;

      const isVerifiedRevenue =
        !isDemo &&
        !isDuplicate &&
        (integrityStatus === 'STRIPE_VERIFIED' ||
          integrityStatus === 'MANUAL_VERIFIED') &&
        (p.type === 'rental_payment' || p.type === 'charge_payment');

      const isVerifiedRefund = !isDuplicate && p.type === 'refund';

      if (inCurrent) {
        if (isVerifiedRevenue) {
          if (integrityStatus === 'STRIPE_VERIFIED') {
            currStripeEur += amount;
          } else {
            currManualEur += amount;
          }
          vehicleCollectedRevenueMap.set(
            p.vehicleId,
            (vehicleCollectedRevenueMap.get(p.vehicleId) ?? 0) + amount,
          );
          paymentTimeSeriesEvents.push({
            date: paidAt,
            collectedDeltaEur: amount,
          });
        } else if (isVerifiedRefund) {
          currRefundEur += amount;
          vehicleCollectedRevenueMap.set(
            p.vehicleId,
            Math.max(
              0,
              (vehicleCollectedRevenueMap.get(p.vehicleId) ?? 0) - amount,
            ),
          );
          paymentTimeSeriesEvents.push({
            date: paidAt,
            collectedDeltaEur: -amount,
          });
        }
      } else if (inPrev) {
        if (isVerifiedRevenue) {
          prevCollectedGrossEur += amount;
        } else if (isVerifiedRefund) {
          prevRefundEur += amount;
        }
      }
    }

    const collectedRevenueEur = round2(
      Math.max(0, currStripeEur + currManualEur - currRefundEur),
    );
    const verifiedStripeRevenueEur = round2(
      Math.max(0, currStripeEur - currRefundEur),
    );
    const verifiedManualRevenueEur = round2(currManualEur);
    const prevCollectedRevenueEur = round2(
      Math.max(0, prevCollectedGrossEur - prevRefundEur),
    );

    // -------------------------------------------------------------------------
    // 2. RESERVATION CLASSIFICATION, CONTRACTED / PIPELINE / DEPOSITS
    // -------------------------------------------------------------------------
    let currContractedEur = 0;
    let prevContractedEur = 0;
    let currPendingPipelineEur = 0;
    let depositsHeldEur = 0;
    let depositsRetainedEur = 0;
    let depositsRefundedEur = 0;

    let currTotalReservations = 0;
    let prevTotalReservations = 0;
    let currConfirmedCount = 0;
    let prevConfirmedCount = 0;
    let currPendingCount = 0;
    let currAwaitingPaymentCount = 0;
    let currCancelledOrExpiredCount = 0;
    let currRejectedCount = 0;
    let currNoShowCount = 0;
    let currConfirmedDaysSum = 0;

    const byStatusInPeriod: Record<string, number> = {};
    const vehicleTotalResMap = new Map<string, number>();
    const vehicleConfirmedResMap = new Map<string, number>();
    const vehicleContractedEurMap = new Map<string, number>();
    const vehicleRentedDaysMap = new Map<string, number>();

    for (const r of reservationsRows) {
      const createdAt = new Date(r.createdAt);
      const pickupAt = new Date(r.pickupAt);
      const returnAt = new Date(r.returnAt);
      const totalAmount = Number(r.totalAmount) || 0;
      const depositAmount = Number(r.depositAmount) || 0;
      const rentalDays = Math.max(1, Number(r.rentalDays) || 1);

      // A reservation belongs to the selected period if its pickup, return, or creation falls within [fromStart, toEnd]
      const overlapsCurrentWindow =
        (pickupAt <= window.toEnd && returnAt >= window.fromStart) ||
        (createdAt >= window.fromStart && createdAt <= window.toEnd);

      const overlapsPrevWindow =
        (pickupAt <= window.prevEnd && returnAt >= window.prevStart) ||
        (createdAt >= window.prevStart && createdAt <= window.prevEnd);

      if (overlapsCurrentWindow) {
        currTotalReservations += 1;
        byStatusInPeriod[r.status] = (byStatusInPeriod[r.status] ?? 0) + 1;
        vehicleTotalResMap.set(
          r.vehicleId,
          (vehicleTotalResMap.get(r.vehicleId) ?? 0) + 1,
        );

        if (CONFIRMED_STATUSES.has(r.status) && !r.isDemoPayment) {
          currConfirmedCount += 1;
          currContractedEur += totalAmount;
          currConfirmedDaysSum += rentalDays;
          vehicleConfirmedResMap.set(
            r.vehicleId,
            (vehicleConfirmedResMap.get(r.vehicleId) ?? 0) + 1,
          );
          vehicleContractedEurMap.set(
            r.vehicleId,
            (vehicleContractedEurMap.get(r.vehicleId) ?? 0) + totalAmount,
          );

          // Calculate exact overlapping rented days inside [fromStart, toEnd]
          const overlapStart = Math.max(
            pickupAt.getTime(),
            window.fromStart.getTime(),
          );
          const overlapEnd = Math.min(
            returnAt.getTime(),
            window.toEnd.getTime(),
          );
          if (overlapEnd > overlapStart) {
            const overlapDays = Math.max(
              1,
              Math.ceil((overlapEnd - overlapStart) / 86_400_000),
            );
            vehicleRentedDaysMap.set(
              r.vehicleId,
              Math.min(
                window.daysCount,
                (vehicleRentedDaysMap.get(r.vehicleId) ?? 0) + overlapDays,
              ),
            );
          }

          // Deposit accounting
          const retained = Number(r.depositRetainedAmount ?? 0);
          const refunded = Number(r.depositRefundedAmount ?? 0);
          if (retained > 0) {
            depositsRetainedEur += retained;
          }
          if (refunded > 0) {
            depositsRefundedEur += refunded;
          }
          if (
            (r.status === 'confirmed' ||
              r.status === 'active_rental' ||
              r.status === 'converted') &&
            r.depositRefundStatus !== 'refunded'
          ) {
            depositsHeldEur += Math.max(0, depositAmount - refunded - retained);
          }
        } else if (PIPELINE_STATUSES.has(r.status)) {
          currPendingPipelineEur += totalAmount;
          if (r.status === 'pending') currPendingCount += 1;
          if (r.status === 'awaiting_payment') currAwaitingPaymentCount += 1;
        } else if (CANCELLED_OR_EXPIRED_STATUSES.has(r.status)) {
          currCancelledOrExpiredCount += 1;
          if (r.status === 'no_show') currNoShowCount += 1;
        } else if (r.status === 'rejected') {
          currRejectedCount += 1;
        }
      } else if (overlapsPrevWindow) {
        prevTotalReservations += 1;
        if (CONFIRMED_STATUSES.has(r.status) && !r.isDemoPayment) {
          prevConfirmedCount += 1;
          prevContractedEur += totalAmount;
        }
      }
    }

    const averageRentalValueEur =
      currConfirmedCount > 0
        ? round2(currContractedEur / currConfirmedCount)
        : null;
    const averageRentalDurationDays =
      currConfirmedCount > 0
        ? round2(currConfirmedDaysSum / currConfirmedCount)
        : null;

    const conversionRatePercent =
      currTotalReservations > 0
        ? round2((currConfirmedCount / currTotalReservations) * 100)
        : null;
    const cancellationRatePercent =
      currTotalReservations > 0
        ? round2((currCancelledOrExpiredCount / currTotalReservations) * 100)
        : null;

    // -------------------------------------------------------------------------
    // 3. TIME SERIES BUCKETS (DAY / WEEK / MONTH)
    // -------------------------------------------------------------------------
    const timeSeries = this.buildTimeSeries({
      fromStart: window.fromStart,
      toEnd: window.toEnd,
      granularity: window.granularity,
      reservationsRows,
      paymentTimeSeriesEvents,
    });

    // -------------------------------------------------------------------------
    // 4. FLEET UTILIZATION, CATEGORY & AGENCY PERFORMANCE
    // -------------------------------------------------------------------------
    const vehicleMap = new Map<string, RawVehicleFleetRow>();
    const allVehicles: VehiclePerformanceItemDto[] = [];
    let activeFleetCount = 0;
    let maintenanceFleetCount = 0;
    let totalActiveRentedDays = 0;

    for (const v of fleetRows) {
      vehicleMap.set(v.id, v);
      if (v.status === 'active') activeFleetCount += 1;
      if (v.status === 'maintenance') maintenanceFleetCount += 1;

      const rentedDays = Math.min(
        window.daysCount,
        vehicleRentedDaysMap.get(v.id) ?? 0,
      );
      if (v.status === 'active') {
        totalActiveRentedDays += rentedDays;
      }

      const utilizationRatePercent = round2(
        Math.min(100, (rentedDays / window.daysCount) * 100),
      );

      allVehicles.push({
        vehicleId: v.id,
        brandName: v.brandName,
        modelName: v.modelName,
        categoryName: v.categoryName,
        status: v.status,
        dailyPriceEur: round2(Number(v.dailyPrice) || 0),
        totalReservations: vehicleTotalResMap.get(v.id) ?? 0,
        confirmedReservations: vehicleConfirmedResMap.get(v.id) ?? 0,
        rentedDaysInPeriod: rentedDays,
        availableDaysInPeriod: Math.max(0, window.daysCount - rentedDays),
        utilizationRatePercent,
        collectedRevenueEur: round2(vehicleCollectedRevenueMap.get(v.id) ?? 0),
        contractedRevenueEur: round2(vehicleContractedEurMap.get(v.id) ?? 0),
      });
    }

    const overallUtilizationRatePercent =
      activeFleetCount > 0
        ? round2(
            Math.min(
              100,
              (totalActiveRentedDays / (activeFleetCount * window.daysCount)) *
                100,
            ),
          )
        : null;

    const topRevenueVehicles = [...allVehicles]
      .sort(
        (a, b) =>
          b.collectedRevenueEur - a.collectedRevenueEur ||
          b.contractedRevenueEur - a.contractedRevenueEur ||
          b.confirmedReservations - a.confirmedReservations,
      )
      .slice(0, 5);

    const mostRequestedVehicles = [...allVehicles]
      .sort(
        (a, b) =>
          b.totalReservations - a.totalReservations ||
          b.confirmedReservations - a.confirmedReservations,
      )
      .slice(0, 5);

    const lowestUtilizationVehicles = allVehicles
      .filter((v) => v.status === 'active')
      .sort(
        (a, b) =>
          a.utilizationRatePercent - b.utilizationRatePercent ||
          a.totalReservations - b.totalReservations,
      )
      .slice(0, 5);

    // Category aggregation
    const categoryBuckets = new Map<string, CategoryPerformanceItemDto>();
    for (const v of fleetRows) {
      const perf = allVehicles.find((item) => item.vehicleId === v.id)!;
      const existing = categoryBuckets.get(v.categoryId) ?? {
        categoryId: v.categoryId,
        categoryName: v.categoryName,
        vehicleCount: 0,
        reservationsCount: 0,
        confirmedCount: 0,
        rentedDaysInPeriod: 0,
        collectedRevenueEur: 0,
        contractedRevenueEur: 0,
        shareOfCollectedRevenuePercent: 0,
      };
      existing.vehicleCount += 1;
      existing.reservationsCount += perf.totalReservations;
      existing.confirmedCount += perf.confirmedReservations;
      existing.rentedDaysInPeriod += perf.rentedDaysInPeriod;
      existing.collectedRevenueEur = round2(
        existing.collectedRevenueEur + perf.collectedRevenueEur,
      );
      existing.contractedRevenueEur = round2(
        existing.contractedRevenueEur + perf.contractedRevenueEur,
      );
      categoryBuckets.set(v.categoryId, existing);
    }

    const categories = Array.from(categoryBuckets.values())
      .map((cat) => ({
        ...cat,
        shareOfCollectedRevenuePercent:
          collectedRevenueEur > 0
            ? round2((cat.collectedRevenueEur / collectedRevenueEur) * 100)
            : cat.contractedRevenueEur > 0 && currContractedEur > 0
              ? round2((cat.contractedRevenueEur / currContractedEur) * 100)
              : 0,
      }))
      .sort(
        (a, b) =>
          b.collectedRevenueEur - a.collectedRevenueEur ||
          b.contractedRevenueEur - a.contractedRevenueEur ||
          b.reservationsCount - a.reservationsCount,
      );

    // Agency performance aggregation
    const agencyBuckets = new Map<string, AgencyPerformanceItemDto>();
    for (const loc of locationsRows) {
      agencyBuckets.set(loc.id, {
        locationId: loc.id,
        code: loc.code,
        name: loc.name,
        city: loc.city,
        assignedVehiclesCount: 0,
        reservationsCount: 0,
        confirmedCount: 0,
        collectedRevenueEur: 0,
        contractedRevenueEur: 0,
      });
    }

    for (const v of fleetRows) {
      const targetLocId =
        (v.locationId && agencyBuckets.has(v.locationId)
          ? v.locationId
          : defaultLocation?.id) ?? null;
      if (!targetLocId || !agencyBuckets.has(targetLocId)) continue;
      const bucket = agencyBuckets.get(targetLocId)!;
      const perf = allVehicles.find((item) => item.vehicleId === v.id)!;
      bucket.assignedVehiclesCount += 1;
      bucket.reservationsCount += perf.totalReservations;
      bucket.confirmedCount += perf.confirmedReservations;
      bucket.collectedRevenueEur = round2(
        bucket.collectedRevenueEur + perf.collectedRevenueEur,
      );
      bucket.contractedRevenueEur = round2(
        bucket.contractedRevenueEur + perf.contractedRevenueEur,
      );
    }

    const agencies = Array.from(agencyBuckets.values()).sort(
      (a, b) =>
        b.collectedRevenueEur - a.collectedRevenueEur ||
        b.contractedRevenueEur - a.contractedRevenueEur ||
        b.assignedVehiclesCount - a.assignedVehiclesCount,
    );

    // -------------------------------------------------------------------------
    // 5. UPCOMING RESERVATIONS (Sanitized: zero customer PII)
    // -------------------------------------------------------------------------
    const nowIso = new Date();
    const upcomingReservations: UpcomingReservationItemDto[] = reservationsRows
      .filter((r) => {
        const pickup = new Date(r.pickupAt);
        return (
          pickup >= nowIso &&
          (r.status === 'confirmed' ||
            r.status === 'awaiting_payment' ||
            r.status === 'pending')
        );
      })
      .slice(0, 8)
      .map((r) => {
        const v = vehicleMap.get(r.vehicleId);
        const locId =
          (v?.locationId && agencyBuckets.has(v.locationId)
            ? v.locationId
            : defaultLocation?.id) ?? null;
        const agency = locId ? agencyBuckets.get(locId) : null;
        return {
          reservationNumber: r.reservationNumber,
          vehicleLabel: v
            ? `${v.brandName} ${v.modelName}`.trim()
            : 'Fleet Vehicle',
          categoryName: v?.categoryName ?? 'Luxury',
          status: r.status,
          pickupAt: new Date(r.pickupAt).toISOString(),
          returnAt: new Date(r.returnAt).toISOString(),
          rentalDays: Math.max(1, Number(r.rentalDays) || 1),
          totalAmountEur: round2(Number(r.totalAmount) || 0),
          depositAmountEur: round2(Number(r.depositAmount) || 0),
          agencyName: agency ? `${agency.name} (${agency.city})` : null,
        };
      });

    // -------------------------------------------------------------------------
    // 6. OPERATIONAL HIGHLIGHTS / ANOMALIES
    // -------------------------------------------------------------------------
    const operationalHighlights = this.buildOperationalHighlights({
      collectedRevenueEur,
      currPendingPipelineEur: round2(currPendingPipelineEur),
      currPendingCount,
      currAwaitingPaymentCount,
      maintenanceFleetCount,
      lowestUtilizationVehicles,
      topRevenueVehicles,
    });

    const report: ExecutiveIntelligenceReportDto = {
      generatedAt: new Date().toISOString(),
      period: {
        from: window.fromDateStr,
        to: window.toDateStr,
        previousFrom: window.prevFromDateStr,
        previousTo: window.prevToDateStr,
        daysCount: window.daysCount,
        granularity: window.granularity,
      },
      systemSnapshot,
      financials: {
        currency: 'EUR',
        collectedRevenueEur,
        verifiedStripeRevenueEur,
        verifiedManualRevenueEur,
        contractedRevenueEur: round2(currContractedEur),
        pendingPipelineEur: round2(currPendingPipelineEur),
        refundedEur: round2(currRefundEur),
        depositsHeldEur: round2(depositsHeldEur),
        depositsRetainedEur: round2(depositsRetainedEur),
        depositsRefundedEur: round2(depositsRefundedEur),
        averageRentalValueEur,
        averageRentalDurationDays,
        comparisons: {
          collectedRevenue: this.buildComparison(
            collectedRevenueEur,
            prevCollectedRevenueEur,
          ),
          contractedRevenue: this.buildComparison(
            round2(currContractedEur),
            round2(prevContractedEur),
          ),
          reservationsCount: this.buildComparison(
            currTotalReservations,
            prevTotalReservations,
          ),
          confirmedReservationsCount: this.buildComparison(
            currConfirmedCount,
            prevConfirmedCount,
          ),
        },
      },
      reservations: {
        totalInPeriod: currTotalReservations,
        byStatusInPeriod,
        confirmedOrCompletedCount: currConfirmedCount,
        pendingCount: currPendingCount,
        awaitingPaymentCount: currAwaitingPaymentCount,
        cancelledOrExpiredCount: currCancelledOrExpiredCount,
        rejectedCount: currRejectedCount,
        noShowCount: currNoShowCount,
        conversionRatePercent,
        cancellationRatePercent,
      },
      timeSeries,
      fleetUtilization: {
        activeFleetCount,
        maintenanceFleetCount,
        overallUtilizationRatePercent,
        topRevenueVehicles,
        mostRequestedVehicles,
        lowestUtilizationVehicles,
        allVehicles,
      },
      categories,
      agencies,
      upcomingReservations,
      operationalHighlights,
    };

    this.cache.set(cacheKey, {
      expiresAt: nowMs + this.cacheTtlMs,
      data: report,
    });

    return report;
  }

  private buildComparison(
    current: number,
    previous: number,
  ): PeriodComparisonMetric {
    const deltaAbsolute = round2(current - previous);
    const deltaPercent =
      previous > 0 ? round2(((current - previous) / previous) * 100) : null;
    return {
      current,
      previous,
      deltaAbsolute,
      deltaPercent,
    };
  }

  private buildTimeSeries(params: {
    fromStart: Date;
    toEnd: Date;
    granularity: TimeGranularity;
    reservationsRows: RawReservationAnalyticsRow[];
    paymentTimeSeriesEvents: Array<{ date: Date; collectedDeltaEur: number }>;
  }): TimeSeriesPointDto[] {
    const {
      fromStart,
      toEnd,
      granularity,
      reservationsRows,
      paymentTimeSeriesEvents,
    } = params;

    const bucketsMap = new Map<string, TimeSeriesPointDto>();

    const getBucketKeyAndLabel = (
      date: Date,
    ): { key: string; label: string } => {
      const y = date.getUTCFullYear();
      const m = String(date.getUTCMonth() + 1).padStart(2, '0');
      const d = String(date.getUTCDate()).padStart(2, '0');

      if (granularity === 'month') {
        const key = `${y}-${m}`;
        const label = date.toLocaleDateString('en-GB', {
          month: 'short',
          year: 'numeric',
          timeZone: 'UTC',
        });
        return { key, label };
      }

      if (granularity === 'week') {
        const dayOfWeek = date.getUTCDay();
        const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
        const monday = new Date(
          Date.UTC(y, date.getUTCMonth(), date.getUTCDate() + mondayOffset),
        );
        const wy = monday.getUTCFullYear();
        const wm = String(monday.getUTCMonth() + 1).padStart(2, '0');
        const wd = String(monday.getUTCDate()).padStart(2, '0');
        const key = `${wy}-${wm}-${wd}`;
        const label = `Wk ${wd}/${wm}`;
        return { key, label };
      }

      const key = `${y}-${m}-${d}`;
      const label = `${d}/${m}`;
      return { key, label };
    };

    // Pre-seed buckets across [fromStart, toEnd]
    const cursor = new Date(fromStart.getTime());
    while (cursor <= toEnd) {
      const { key, label } = getBucketKeyAndLabel(cursor);
      if (!bucketsMap.has(key)) {
        bucketsMap.set(key, {
          bucket: key,
          label,
          collectedRevenueEur: 0,
          contractedRevenueEur: 0,
          pendingRevenueEur: 0,
          reservationsCount: 0,
          confirmedCount: 0,
          cancelledCount: 0,
        });
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    for (const ev of paymentTimeSeriesEvents) {
      const { key, label } = getBucketKeyAndLabel(ev.date);
      const bucket = bucketsMap.get(key) ?? {
        bucket: key,
        label,
        collectedRevenueEur: 0,
        contractedRevenueEur: 0,
        pendingRevenueEur: 0,
        reservationsCount: 0,
        confirmedCount: 0,
        cancelledCount: 0,
      };
      bucket.collectedRevenueEur = round2(
        Math.max(0, bucket.collectedRevenueEur + ev.collectedDeltaEur),
      );
      bucketsMap.set(key, bucket);
    }

    for (const r of reservationsRows) {
      const refDate = new Date(r.pickupAt ?? r.createdAt);
      if (refDate < fromStart || refDate > toEnd) continue;

      const { key, label } = getBucketKeyAndLabel(refDate);
      const bucket = bucketsMap.get(key) ?? {
        bucket: key,
        label,
        collectedRevenueEur: 0,
        contractedRevenueEur: 0,
        pendingRevenueEur: 0,
        reservationsCount: 0,
        confirmedCount: 0,
        cancelledCount: 0,
      };

      bucket.reservationsCount += 1;
      const amount = Number(r.totalAmount) || 0;
      if (CONFIRMED_STATUSES.has(r.status) && !r.isDemoPayment) {
        bucket.confirmedCount += 1;
        bucket.contractedRevenueEur = round2(
          bucket.contractedRevenueEur + amount,
        );
      } else if (PIPELINE_STATUSES.has(r.status)) {
        bucket.pendingRevenueEur = round2(bucket.pendingRevenueEur + amount);
      } else if (CANCELLED_OR_EXPIRED_STATUSES.has(r.status)) {
        bucket.cancelledCount += 1;
      }
      bucketsMap.set(key, bucket);
    }

    return Array.from(bucketsMap.values()).sort((a, b) =>
      a.bucket.localeCompare(b.bucket),
    );
  }

  private buildOperationalHighlights(params: {
    collectedRevenueEur: number;
    currPendingPipelineEur: number;
    currPendingCount: number;
    currAwaitingPaymentCount: number;
    maintenanceFleetCount: number;
    lowestUtilizationVehicles: VehiclePerformanceItemDto[];
    topRevenueVehicles: VehiclePerformanceItemDto[];
  }): OperationalHighlightDto[] {
    const highlights: OperationalHighlightDto[] = [];

    if (params.currPendingCount > 0 || params.currAwaitingPaymentCount > 0) {
      highlights.push({
        id: 'pipeline-attention',
        severity: 'warning',
        title: 'Pending & Awaiting-Payment Pipeline',
        detail: `${params.currPendingCount} reservation(s) await admin approval and ${params.currAwaitingPaymentCount} await client payment within the 24h window.`,
        metricValue: `€${params.currPendingPipelineEur.toLocaleString('en-US')}`,
      });
    }

    if (params.maintenanceFleetCount > 0) {
      highlights.push({
        id: 'maintenance-fleet',
        severity: 'warning',
        title: 'Fleet Units in Maintenance',
        detail: `${params.maintenanceFleetCount} vehicle(s) are currently marked under maintenance and excluded from active booking supply.`,
        metricValue: `${params.maintenanceFleetCount} unit(s)`,
      });
    }

    const topVehicle = params.topRevenueVehicles[0];
    if (
      topVehicle &&
      (topVehicle.collectedRevenueEur > 0 ||
        topVehicle.contractedRevenueEur > 0)
    ) {
      const val =
        topVehicle.collectedRevenueEur > 0
          ? topVehicle.collectedRevenueEur
          : topVehicle.contractedRevenueEur;
      highlights.push({
        id: 'top-performer',
        severity: 'positive',
        title: `Leading Vehicle: ${topVehicle.brandName} ${topVehicle.modelName}`,
        detail: `Generated the highest revenue contribution in the selected period across ${topVehicle.confirmedReservations} confirmed booking(s).`,
        metricValue: `€${val.toLocaleString('en-US')}`,
      });
    }

    const underutilized = params.lowestUtilizationVehicles.filter(
      (v) => v.utilizationRatePercent === 0,
    );
    if (underutilized.length > 0) {
      const sample = underutilized
        .slice(0, 2)
        .map((v) => `${v.brandName} ${v.modelName}`)
        .join(', ');
      highlights.push({
        id: 'idle-fleet',
        severity: 'info',
        title: 'Underutilized Active Fleet Opportunity',
        detail: `${underutilized.length} active vehicle(s) recorded 0% utilization in this window (including ${sample}). Consider featured placement or targeted promotions.`,
        metricValue: `${underutilized.length} idle active`,
      });
    }

    return highlights;
  }
}
