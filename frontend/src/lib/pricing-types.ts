/**
 * Centralized Domain Types for Dynamic Pricing & Predictive Analytics
 * Eliminates duplicate interface definitions across admin interfaces.
 */

export interface PricingStatusResponse {
  enabled: boolean;
  source: 'database' | 'environment_fallback';
  updatedAt?: string;
  updatedBy?: string | null;
  activeRules: {
    seasonalPeak: boolean;
    weekendPrime: boolean;
    categoryTiers: number;
    durationPrivilege: number;
    demandTelemetryGated: boolean;
  };
}

export interface ScopedPricingRule {
  ruleId: string;
  recommendationId?: string;
  vehicleId: string;
  licensePlate: string;
  brand: string;
  model: string;
  category: string;
  imageUrl?: string;
  originalDailyPrice: number;
  approvedDailyPrice: number;
  variancePercent: number;
  startDate?: string;
  endDate?: string;
  adminReason: string;
  approvedBy?: string;
  appliedAt: string;
  status: 'active' | 'rolled_back' | 'expired';
  rolledBackAt?: string;
  rolledBackBy?: string;
  rollbackReason?: string;
}

export interface DataReadiness {
  status: 'sparse' | 'moderate' | 'sufficient';
  dataCompletenessPercentage: number;
  historicalBookingsCount: number;
  historicalDaysObserved: number;
  availableFleetCount: number;
  activeLocationsCount: number;
  hasSearchLogs: boolean;
  hasMultiYearHistory: boolean;
  missingDataFactors: string[];
  readinessNotes: string;
}

export interface Forecast {
  forecastId: string;
  horizonDays: 7 | 14 | 30;
  periodLabel: string;
  predictedBookingVolume: number;
  predictedRange: { min: number; max: number };
  historicalEvidence: string;
  confidenceLevel: 'low' | 'moderate' | 'high';
  recommendedHumanAction: string;
}

export interface CategoryBreakdown {
  categoryId: string;
  categoryName: string;
  fleetCount: number;
  bookingsCount: number;
  demandSharePercent: number;
  avgDailyPrice: number;
  confirmedRevenue: number;
  utilizationScore: number;
  occupancyPercent?: number;
  turnoverRatio?: number;
}

export interface Recommendation {
  recommendationId: string;
  vehicleId: string;
  licensePlate: string;
  brand: string;
  model: string;
  category: string;
  imageUrl?: string;
  currentDailyPrice: number;
  suggestedPriceMin: number;
  suggestedPriceMax: number;
  suggestedAdjustmentPercent: number;
  adjustmentType: 'increase' | 'decrease' | 'maintain';
  evidence: string;
  confidenceLevel: 'low' | 'moderate' | 'high';
  expectedBusinessImpact: string;
  humanApprovalRequired: boolean;
  status: 'pending_review' | 'applied' | 'dismissed';
  appliedPrice?: number;
}

export interface SeasonalityInsight {
  currentMonth: string;
  seasonPhase: string;
  seasonalDemandIndex: number;
  industryBenchmarkNotice: string;
  historicalSampleWarning: string;
}

export interface AnalyticsData {
  enabled: boolean;
  dataReadiness: DataReadiness;
  forecasts: Forecast[];
  categories: CategoryBreakdown[];
  recommendations: Recommendation[];
  seasonality: SeasonalityInsight;
  generatedAt: string;
}

export interface SimulationResult {
  recommendationId: string;
  licensePlate: string;
  brand: string;
  model: string;
  category: string;
  currentDailyPrice: number;
  simulatedDailyPrice: number;
  variancePercent: number;
  rentalDays: number;
  currentGrossTotal: number;
  simulatedGrossTotal: number;
  varianceTotal: number;
  dynamicPricingActive: boolean;
  breakdown: {
    baseDailyRate: number;
    effectiveDailyRate: number;
    durationDiscountAmount: number;
    taxesAmount: number;
    adjustments: Array<{ code: string; label: string; percentage: number; amount: number }>;
  };
  scenarios: Array<{
    days: number;
    label: string;
    currentGrossTotal: number;
    simulatedGrossTotal: number;
    difference: number;
    variancePercent: number;
  }>;
}
