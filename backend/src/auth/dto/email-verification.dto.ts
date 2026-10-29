import {
    IsEmail,
    IsNotEmpty,
    IsOptional,
    IsString,
    MaxLength,
    MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class RequestEmailVerificationDto {
    @IsEmail()
    @Transform(({ value }) =>
        typeof value === 'string'
            ? value.trim().toLowerCase()
            : value,
    )
    email!: string;
}

export class ConfirmEmailVerificationDto {
    @IsString()
    @IsNotEmpty()
    @MinLength(20)
    @MaxLength(512)
    @Transform(({ value }) =>
        typeof value === 'string' ? value.trim() : value,
    )
    token!: string;

    @IsOptional()
    @IsEmail()
    @Transform(({ value }) =>
        typeof value === 'string' ? value.trim().toLowerCase() : value,
    )
    email?: string;
}
