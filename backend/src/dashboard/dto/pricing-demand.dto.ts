import {
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class PricingDemandOverviewQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'from must be a valid ISO date string (YYYY-MM-DD)',
  })
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'to must be a valid ISO date string (YYYY-MM-DD)',
  })
  to?: string;
}

export interface DataReadinessAssessmentDto {
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

export interface DemandCategoryBreakdownDto {
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

export interface DemandTimelinePointDto {
  date: string;
  bookingsCreated: number;
  activeRentals: number;
  dailyRevenue: number;
}

export interface UpcomingDemandPressureDto {
  horizonDays: number;
  periodLabel: string;
  confirmedBookings: number;
  pendingRequests: number;
  fleetUtilizationProjectedPercent: number;
  highPressureCategories: string[];
  lowPressureCategories: string[];
}

export interface DemandForecastDto {
  forecastId: string;
  horizonDays: 7 | 14 | 30;
  periodLabel: string;
  predictedBookingVolume: number;
  predictedRange: { min: number; max: number };
  historicalEvidence: string;
  confidenceLevel: 'low' | 'moderate' | 'high';
  dataCompleteness: number;
  mainFactors: string[];
  recommendedHumanAction: string;
}

export interface SmartPricingRecommendationDto {
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
  confidenceLevel: 'low' | 'moderate';
  expectedBusinessImpact: string;
  humanApprovalRequired: boolean;
  status: 'pending_review' | 'applied' | 'dismissed';
  appliedPrice?: number;
}

export class ApplyPricingRecommendationDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(50)
  @Max(50000)
  approvedPrice!: number;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  adminReason?: string;

  @IsOptional()
  @IsString()
  licensePlate?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'startDate must be in YYYY-MM-DD format',
  })
  startDate?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'endDate must be in YYYY-MM-DD format',
  })
  endDate?: string;
}

export class SimulatePricingRecommendationDto {
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(50)
  @Max(50000)
  simulatedDailyPrice?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(90)
  rentalDays?: number;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'startDate must be in YYYY-MM-DD format',
  })
  startDate?: string;

  @IsOptional()
  @IsString()
  licensePlate?: string;
}

export class DismissPricingRecommendationDto {
  @IsOptional()
  @IsString()
  @MaxLength(280)
  reason?: string;
}

export class RollbackPricingRuleDto {
  @IsOptional()
  @IsString()
  @MaxLength(280)
  reason?: string;
}

export interface ScopedPricingRuleDto {
  ruleId: string;
  recommendationId: string;
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

export interface SimulationScenarioDto {
  days: number;
  label: string;
  currentGrossTotal: number;
  simulatedGrossTotal: number;
  difference: number;
  variancePercent: number;
}

export interface SimulationResultDto {
  recommendationId: string;
  vehicleId: string;
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
  scenarios: SimulationScenarioDto[];
  calculatedAt: string;
}

export interface SeasonalityInsightDto {
  currentMonth: string;
  seasonPhase: string;
  seasonalDemandIndex: number;
  industryBenchmarkNotice: string;
  historicalSampleWarning: string;
}

export interface PricingDemandOverviewResponseDto {
  enabled: boolean;
  dataReadiness: DataReadinessAssessmentDto;
  timeline: DemandTimelinePointDto[];
  categories: DemandCategoryBreakdownDto[];
  upcomingPressure: UpcomingDemandPressureDto[];
  forecasts: DemandForecastDto[];
  recommendations: SmartPricingRecommendationDto[];
  seasonality: SeasonalityInsightDto;
  generatedAt: string;
}
