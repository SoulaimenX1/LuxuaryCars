import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export type VehicleHealthStatus =
  | 'HEALTHY'
  | 'MAINTENANCE_APPROACHING'
  | 'MAINTENANCE_OVERDUE'
  | 'ATTENTION_REQUIRED'
  | 'INSUFFICIENT_DATA';

export type DataReadinessLevel = 'HIGH' | 'PARTIAL' | 'INSUFFICIENT';

export type PredictionConfidenceLevel =
  | 'HIGH'
  | 'MEDIUM'
  | 'LOW'
  | 'INSUFFICIENT_DATA';

export type MaintenanceCategory =
  | 'periodic_service'
  | 'brake_system'
  | 'tires_wheels'
  | 'engine_drivetrain'
  | 'body_interior'
  | 'inspection_check'
  | 'other';

export type MaintenanceRecordStatus =
  | 'SCHEDULED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'OVERDUE';

export interface MaintenanceHistoryItemDto {
  id: string;
  source:
    | 'MAINTENANCE_LOG'
    | 'UNAVAILABILITY_WINDOW'
    | 'PREPARATION_ORDER'
    | 'INSPECTION_DAMAGE'
    | 'INCIDENT_REPORT';
  category: string;
  title: string;
  status: string;
  serviceDate: string;
  completedAt: string | null;
  mileageAtServiceKm: number | null;
  costEur: number | null;
  nextServiceDueAt: string | null;
  nextServiceDueKm: number | null;
  notes: string | null;
}

export interface VehicleDataCompletenessDto {
  scorePercent: number;
  readinessLevel: DataReadinessLevel;
  hasVerifiedMileage: boolean;
  hasMaintenanceHistory: boolean;
  hasInspectionCondition: boolean;
  hasNextServiceSchedule: boolean;
  hasCostRecords: boolean;
  missingFields: string[];
}

export interface VehicleMaintenanceExpenditureDto {
  loggedMaintenanceCostEur: number;
  estimatedDamageRepairCostEur: number;
  totalRecordedExpenditureEur: number;
  completedRentalsCount: number;
  collectedRentalRevenueEur: number;
  costToRevenueRatioPercent: number | null;
}

export interface FleetVehicleHealthDto {
  vehicleId: string;
  brandName: string;
  modelName: string;
  categoryName: string;
  manufactureYear: number;
  operationalStatus: string;
  dailyPriceEur: number;
  recordedMileageKm: number | null;
  latestInspectionMileageKm: number | null;
  latestCondition: string | null;
  latestInspectionAt: string | null;
  latestFuelLevelPct: number | null;
  mechanicalWarningsFlagged: boolean;
  lastMaintenanceAt: string | null;
  lastMaintenanceMileageKm: number | null;
  nextMaintenanceDueAt: string | null;
  nextMaintenanceDueKm: number | null;
  daysUntilNextMaintenance: number | null;
  kmUntilNextMaintenance: number | null;
  healthStatus: VehicleHealthStatus;
  statusReason: string;
  outstandingTasksCount: number;
  outstandingTasks: string[];
  damageIncidentsCount: number;
  recurringDamageZones: string[];
  expenditure: VehicleMaintenanceExpenditureDto;
  dataCompleteness: VehicleDataCompletenessDto;
  maintenanceHistory: MaintenanceHistoryItemDto[];
}

export interface PredictiveMaintenanceInsightDto {
  id: string;
  vehicleId: string;
  vehicleLabel: string;
  categoryName: string;
  predictionType:
    | 'MILEAGE_SERVICE_INTERVAL'
    | 'SCHEDULED_SERVICE_WINDOW'
    | 'OVERDUE_MAINTENANCE_ACTION'
    | 'RECURRING_ZONE_DAMAGE'
    | 'ELEVATED_MAINTENANCE_COST'
    | 'POST_RENTAL_INSPECTION_NEEDED'
    | 'DATA_READINESS_GAP';
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  reason: string;
  evidenceUsed: string[];
  confidence: PredictionConfidenceLevel;
  dataQualityIndicator: string;
  recommendedHumanAction: string;
  estimatedWindowLabel: string;
  requiresHumanApprovalForRestriction: true;
}

export interface FleetMaintenanceSummaryDto {
  totalFleetVehicles: number;
  activeVehiclesCount: number;
  inactiveVehiclesCount: number;
  healthyCount: number;
  approachingCount: number;
  overdueCount: number;
  attentionRequiredCount: number;
  insufficientDataCount: number;
  openMaintenanceTasksCount: number;
  totalLoggedMaintenanceCostEur: number;
  totalEstimatedDamageCostEur: number;
  totalCombinedExpenditureEur: number;
  averageDataCompletenessPercent: number;
  predictiveReadyVehiclesCount: number;
}

export interface FleetMaintenanceOverviewResponseDto {
  generatedAt: string;
  serviceIntervalRuleKm: number;
  approachingThresholdKm: number;
  approachingThresholdDays: number;
  summary: FleetMaintenanceSummaryDto;
  vehicles: FleetVehicleHealthDto[];
  predictions: PredictiveMaintenanceInsightDto[];
  methodologyAndLimitations: string[];
}

export class CreateMaintenanceRecordRequestDto {
  @IsUUID()
  vehicleId!: string;

  @IsIn([
    'periodic_service',
    'brake_system',
    'tires_wheels',
    'engine_drivetrain',
    'body_interior',
    'inspection_check',
    'other',
  ])
  category!: MaintenanceCategory;

  @IsString()
  @IsNotEmpty()
  @MaxLength(140)
  title!: string;

  @IsIn(['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE'])
  status!: MaintenanceRecordStatus;

  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  serviceDate!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000000)
  mileageAtServiceKm?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(500000)
  costEur?: number;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  nextServiceDueAt?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000000)
  nextServiceDueKm?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
