import {
  IsBoolean, IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min,
} from 'class-validator';
import {VehicleCondition} from './vehicle-condition.js';

export class StartRentalDto {
  @IsString()
  @Matches(/^RES-\d{4}-\d{6}$/)
  reservationNumber!: string;

  @IsString()
  @Matches(/^\d{8}$/)
  code!: string;

  @IsBoolean()
  identityVerified!: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999999999)
  mileageKm?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  fuelLevelPct?: number;

  @IsOptional()
  @IsEnum(VehicleCondition)
  overallCondition?: VehicleCondition;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
