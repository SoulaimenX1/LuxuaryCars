import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class ReleaseVehicleDto {
    @IsBoolean()
    cleaningCompleted!: boolean;

    @IsBoolean()
    maintenanceCompleted!: boolean;

    @IsBoolean()
    qualityApproved!: boolean;

    @IsOptional()
    @IsString()
    @MaxLength(1000)
    qualityNotes?: string;
}
