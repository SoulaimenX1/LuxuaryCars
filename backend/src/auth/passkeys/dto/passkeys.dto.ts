import {
    IsNotEmpty,
    IsObject,
    IsOptional,
    IsString,
} from 'class-validator';

export class AuthenticateOptionsDto {
    @IsOptional()
    @IsString()
    email?: string;
}

export class VerifyRegistrationDto {
    @IsNotEmpty()
    @IsObject()
    response!: Record<string, unknown>;

    @IsOptional()
    @IsString()
    challenge?: string;

    @IsOptional()
    @IsString()
    deviceName?: string;
}

export class VerifyAuthenticationDto {
    @IsNotEmpty()
    @IsObject()
    response!: Record<string, unknown>;

    @IsOptional()
    @IsString()
    challenge?: string;

    @IsOptional()
    @IsString()
    email?: string;
}
