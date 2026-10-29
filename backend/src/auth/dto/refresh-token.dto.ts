import {
    IsNotEmpty,
    IsOptional,
    IsString,
    MaxLength,
    MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class RefreshTokenDto {
    @IsString()
    @IsNotEmpty()
    @MinLength(20)
    @MaxLength(512)
    @Transform(({ value }) =>
        typeof value === 'string' ? value.trim() : value,
    )
    refreshToken!: string;
}

export class LogoutDto {
    @IsOptional()
    @IsString()
    @MaxLength(512)
    @Transform(({ value }) =>
        typeof value === 'string' ? value.trim() : value,
    )
    refreshToken?: string;
}
