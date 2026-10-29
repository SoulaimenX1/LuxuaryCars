import { IsISO8601, IsInt, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

// ==========================================================
// REQUÊTES DE DISPONIBILITÉ
// ==========================================================

// GET /vehicles/:vehicleId/availability-calendar?month=
export class CalendarQueryDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'month must use YYYY-MM format',
  })
  month!: string;
}

// POST /availability/check
export class CheckIntervalDto {
  @IsUUID('4')
  vehicleId!: string;

  @IsISO8601()
  pickupAt!: string;

  @IsISO8601()
  returnAt!: string;
}

// POST /availability/alternatives
export class AlternativesQueryDto {
  @IsUUID('4')
  vehicleId!: string;

  @IsISO8601()
  pickupAt!: string;

  @IsISO8601()
  returnAt!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  durationDays?: number;
}
