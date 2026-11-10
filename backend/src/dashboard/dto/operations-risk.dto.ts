import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export type RiskLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export type RiskCategory =
  | 'payment_deadline'
  | 'payment_inconsistency'
  | 'return_monitoring'
  | 'availability_conflict'
  | 'fleet_readiness'
  | 'record_inconsistency'
  | 'unusual_pattern';

export class OperationsRiskQueryDto {
  @IsOptional()
  @IsIn(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'ALL'])
  severity?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsBoolean()
  includeResolved?: boolean;
}

export interface OperationsRiskAlertDto {
  id: string;
  category: RiskCategory;
  severity: RiskLevel;
  title: string;
  entityReference: string;
  entityType: 'reservation' | 'rental' | 'vehicle' | 'operational_record';
  entityId: string;
  explanation: string;
  dbEvidence: string;
  relevantDate: string | null;
  recommendedAction: string;
  confidence: 'verified_database' | 'caution_sparse_telemetry';
  completenessScore: number;
  isResolved: boolean;
  resolutionNote?: string | null;
  flaggedForReview: boolean;
  flagReason?: string | null;
  financialExposure?: number | null;
}

export interface OperationsPaymentSummaryDto {
  pendingCount: number;
  awaitingPaymentCount: number;
  deadlineExceededCount: number;
  deadlineApproachingCount: number;
  discrepanciesCount: number;
  totalAtRiskAmount: number;
}

export interface OperationsReturnSummaryDto {
  activeRentalsCount: number;
  overdueReturnsCount: number;
  returnsDue24hCount: number;
  returnsScheduledToday: number;
}

export interface OperationsFleetConflictSummaryDto {
  bookingOverlapCount: number;
  maintenanceConflictCount: number;
  unreadyVehiclesCount: number;
  readinessTelemetryStatus:
    | 'insufficient_preparation_telemetry'
    | 'sufficient_telemetry';
  readinessNotice: string;
}

export interface OperationsRiskOverviewResponseDto {
  activeAlertsCount: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  resolvedAlertsCount: number;
  alerts: OperationsRiskAlertDto[];
  paymentSummary: OperationsPaymentSummaryDto;
  returnSummary: OperationsReturnSummaryDto;
  fleetConflictSummary: OperationsFleetConflictSummaryDto;
  singleShowroomCode: string;
  singleShowroomName: string;
  generatedAt: string;
}

// ==========================================
// HUMAN-IN-THE-LOOP ACTION DTOS
// ==========================================

export class SendReminderActionDto {
  @IsString()
  @IsNotEmpty()
  alertId!: string;

  @IsOptional()
  @IsString()
  reservationNumber?: string;

  @IsOptional()
  @IsString()
  contractNumber?: string;

  @IsIn(['payment', 'return', 'general'])
  reminderType!: 'payment' | 'return' | 'general';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  customNote?: string;

  @IsBoolean()
  confirmed!: boolean;
}

export class FlagReviewActionDto {
  @IsString()
  @IsNotEmpty()
  alertId!: string;

  @IsString()
  @IsNotEmpty()
  reference!: string;

  @IsString()
  @MaxLength(500)
  reason!: string;

  @IsBoolean()
  confirmed!: boolean;
}

export class ResolveRiskActionDto {
  @IsString()
  @IsNotEmpty()
  alertId!: string;

  @IsString()
  @IsNotEmpty()
  reference!: string;

  @IsString()
  @MaxLength(500)
  resolutionNote!: string;

  @IsBoolean()
  confirmed!: boolean;
}

export class CancelExpiredActionDto {
  @IsString()
  @IsNotEmpty()
  reservationNumber!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsBoolean()
  confirmed!: boolean;
}
