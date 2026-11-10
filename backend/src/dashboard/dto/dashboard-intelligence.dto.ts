import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import type { DashboardSummary } from '../dashboard.service.js';

export type TimeGranularity = 'day' | 'week' | 'month';
export type AnalystLocale = 'fr' | 'en';

export class DashboardIntelligenceQueryDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'from must be a valid YYYY-MM-DD date string',
  })
  from?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'to must be a valid YYYY-MM-DD date string',
  })
  to?: string;

  @IsOptional()
  @IsString()
  @IsIn(['day', 'week', 'month'])
  granularity?: TimeGranularity;
}

export interface PeriodComparisonMetric {
  current: number;
  previous: number;
  deltaAbsolute: number;
  deltaPercent: number | null;
}

export interface FinancialBreakdownDto {
  currency: 'EUR';
  /** Actual verified cash collected (Stripe verified + approved manual counter payments minus refunds) */
  collectedRevenueEur: number;
  verifiedStripeRevenueEur: number;
  verifiedManualRevenueEur: number;
  /** Contracted rental value of confirmed, active_rental, completed, and converted reservations in period */
  contractedRevenueEur: number;
  /** Pipeline rental value of pending and awaiting_payment reservations in period */
  pendingPipelineEur: number;
  /** Total verified refunds issued in period */
  refundedEur: number;
  /** Security deposits currently held on active/confirmed reservations (separate from rental revenue) */
  depositsHeldEur: number;
  /** Security deposits retained after return inspection */
  depositsRetainedEur: number;
  /** Security deposits released/refunded to clients */
  depositsRefundedEur: number;
  /** Average contracted rental value across confirmed/active/completed reservations in period */
  averageRentalValueEur: number | null;
  /** Average rental duration in days across confirmed/active/completed reservations in period */
  averageRentalDurationDays: number | null;
  comparisons: {
    collectedRevenue: PeriodComparisonMetric;
    contractedRevenue: PeriodComparisonMetric;
    reservationsCount: PeriodComparisonMetric;
    confirmedReservationsCount: PeriodComparisonMetric;
  };
}

export interface TimeSeriesPointDto {
  bucket: string;
  label: string;
  collectedRevenueEur: number;
  contractedRevenueEur: number;
  pendingRevenueEur: number;
  reservationsCount: number;
  confirmedCount: number;
  cancelledCount: number;
}

export interface ReservationAnalyticsDto {
  totalInPeriod: number;
  byStatusInPeriod: Record<string, number>;
  confirmedOrCompletedCount: number;
  pendingCount: number;
  awaitingPaymentCount: number;
  cancelledOrExpiredCount: number;
  rejectedCount: number;
  noShowCount: number;
  /** Percentage of total reservations in period reaching confirmed/active/completed/converted */
  conversionRatePercent: number | null;
  /** Percentage of total reservations in period cancelled, unpaid-expired, or no-show */
  cancellationRatePercent: number | null;
}

export interface VehiclePerformanceItemDto {
  vehicleId: string;
  brandName: string;
  modelName: string;
  categoryName: string;
  status: string;
  dailyPriceEur: number;
  totalReservations: number;
  confirmedReservations: number;
  rentedDaysInPeriod: number;
  availableDaysInPeriod: number;
  /** Rented days in period / period length in days (0..100) */
  utilizationRatePercent: number;
  collectedRevenueEur: number;
  contractedRevenueEur: number;
}

export interface CategoryPerformanceItemDto {
  categoryId: string;
  categoryName: string;
  vehicleCount: number;
  reservationsCount: number;
  confirmedCount: number;
  rentedDaysInPeriod: number;
  collectedRevenueEur: number;
  contractedRevenueEur: number;
  shareOfCollectedRevenuePercent: number;
}

export interface AgencyPerformanceItemDto {
  locationId: string;
  code: string;
  name: string;
  city: string;
  assignedVehiclesCount: number;
  reservationsCount: number;
  confirmedCount: number;
  collectedRevenueEur: number;
  contractedRevenueEur: number;
}

export interface UpcomingReservationItemDto {
  reservationNumber: string;
  vehicleLabel: string;
  categoryName: string;
  status: string;
  pickupAt: string;
  returnAt: string;
  rentalDays: number;
  totalAmountEur: number;
  depositAmountEur: number;
  agencyName: string | null;
}

export interface OperationalHighlightDto {
  id: string;
  severity: 'info' | 'warning' | 'positive';
  title: string;
  detail: string;
  metricValue: string;
}

export interface ExecutiveIntelligenceReportDto {
  generatedAt: string;
  period: {
    from: string;
    to: string;
    previousFrom: string;
    previousTo: string;
    daysCount: number;
    granularity: TimeGranularity;
  };
  /** Base all-time system snapshot from existing DashboardService.getSummary() */
  systemSnapshot: DashboardSummary;
  financials: FinancialBreakdownDto;
  reservations: ReservationAnalyticsDto;
  timeSeries: TimeSeriesPointDto[];
  fleetUtilization: {
    activeFleetCount: number;
    maintenanceFleetCount: number;
    overallUtilizationRatePercent: number | null;
    topRevenueVehicles: VehiclePerformanceItemDto[];
    mostRequestedVehicles: VehiclePerformanceItemDto[];
    lowestUtilizationVehicles: VehiclePerformanceItemDto[];
    allVehicles: VehiclePerformanceItemDto[];
  };
  categories: CategoryPerformanceItemDto[];
  agencies: AgencyPerformanceItemDto[];
  upcomingReservations: UpcomingReservationItemDto[];
  operationalHighlights: OperationalHighlightDto[];
}
