import {
    Body,
    Controller,
    Get,
    Headers,
    HttpCode,
    HttpStatus,
    Ip,
    Post,
    Req,
    UnauthorizedException,
    UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { UserRole } from '../../users/entities/user.entity.js';
import { Roles } from '../decorators/roles.decorator.js';
import { JwtAuthGuard, type AuthenticatedUser } from '../guards/jwt-auth.guard.js';
import { RolesGuard } from '../guards/roles.guard.js';
import { PasskeysService } from '../passkeys/passkeys.service.js';
import { MfaService } from './mfa.service.js';

interface VerifyRecoveryDto {
    preAuthToken?: string;
    code: string;
}

interface VerifyPasskeyMfaDto {
    preAuthToken?: string;
    response: any;
}

@Controller('auth/mfa')
export class MfaController {
    constructor(
        private readonly mfaService: MfaService,
        private readonly passkeysService: PasskeysService,
    ) {}

    /**
     * Complete MFA challenge via single-use Argon2 recovery code
     */
    @Post('verify-recovery')
    @HttpCode(HttpStatus.OK)
    async verifyRecovery(
        @Body() dto: VerifyRecoveryDto,
        @Headers('authorization') authHeader: string | undefined,
        @Headers('user-agent') userAgent: string | undefined,
        @Ip() ipAddress: string,
    ) {
        const token = dto.preAuthToken || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null);
        if (!token) {
            throw new UnauthorizedException('Missing pre-authentication token');
        }

        return this.mfaService.verifyRecoveryCode(token, dto.code, {
            ipAddress,
            userAgent,
        });
    }

    /**
     * Complete MFA challenge via WebAuthn biometric passkey
     */
    @Post('verify-passkey')
    @HttpCode(HttpStatus.OK)
    async verifyPasskey(
        @Body() dto: VerifyPasskeyMfaDto,
        @Headers('authorization') authHeader: string | undefined,
        @Headers('user-agent') userAgent: string | undefined,
        @Ip() ipAddress: string,
    ) {
        const token = dto.preAuthToken || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null);
        if (!token) {
            throw new UnauthorizedException('Missing pre-authentication token');
        }

        const user = await this.mfaService.validatePreAuthToken(token);

        // Verify WebAuthn response with user verification
        await this.passkeysService.verifyAuthentication(
            { response: dto.response },
            { ipAddress, userAgent },
        );

        return this.mfaService.issueFullTokens(user, ['pwd', 'webauthn'], {
            ipAddress,
            userAgent,
        });
    }

    /**
     * Generate 10 new recovery codes for the authenticated user
     */
    @Post('recovery-codes/generate')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN, UserRole.STAFF)
    @HttpCode(HttpStatus.OK)
    async generateRecoveryCodes(@Req() req: Request & { user: AuthenticatedUser }) {
        const codes = await this.mfaService.generateRecoveryCodes(req.user.id);
        return {
            recoveryCodes: codes,
            count: codes.length,
            message: 'Save these recovery codes in a secure offline location. Each can only be used once.',
        };
    }

    /**
     * Check MFA policy status
     */
    @Get('status')
    @UseGuards(JwtAuthGuard)
    async getMfaStatus(@Req() req: Request & { user: AuthenticatedUser }) {
        const isMfaEnforcedGlobal = process.env.ENABLE_MANDATORY_ADMIN_MFA === 'true';
        const isPrivileged = req.user.role === UserRole.ADMIN || req.user.role === UserRole.STAFF;

        return {
            enforcement: isMfaEnforcedGlobal ? 'enforced' : 'disabled',
            user: {
                id: req.user.id,
                role: req.user.role,
                mfaVerified: req.user.mfaVerified ?? false,
                amr: req.user.amr ?? [],
            },
            mfaRequiredForUser: isMfaEnforcedGlobal && isPrivileged,
        };
    }
}
