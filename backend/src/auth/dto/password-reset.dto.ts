import {
    IsEmail,
    IsNotEmpty,
    IsString,
    MaxLength,
    MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class RequestPasswordResetDto {
    @IsEmail()
    @Transform(({ value }) =>
        typeof value === 'string'
            ? value.trim().toLowerCase()
            : value,
    )
    email!: string;
}

export class ConfirmPasswordResetDto {
    @IsString()
    @IsNotEmpty()
    @MinLength(20)
    @MaxLength(512)
    @Transform(({ value }) =>
        typeof value === 'string' ? value.trim() : value,
    )
    token!: string;

    @IsString()
    @MinLength(12)
    @MaxLength(128)
    newPassword!: string;
}
