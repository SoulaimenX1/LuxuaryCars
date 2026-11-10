import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    Req,
    UseGuards,
} from '@nestjs/common';
import {
    JwtAuthGuard,
    type AuthenticatedUser,
} from '../guards/jwt-auth.guard.js';
import { resolveSafeClientIp } from '../rate-limit/auth-rate-limit.guard.js';
import {
    AuthenticateOptionsDto,
    VerifyAuthenticationDto,
    VerifyRegistrationDto,
} from './dto/passkeys.dto.js';
import { PasskeysService } from './passkeys.service.js';

interface RequestWithMeta {
    ip?: string;
    socket?: { remoteAddress?: string };
    headers?: {
        authorization?: string;
        'user-agent'?: string;
        'x-forwarded-for'?: string | string[];
        'x-real-ip'?: string | string[];
    };
    user?: AuthenticatedUser;
}

@Controller('auth/passkeys')
export class PasskeysController {
    constructor(private readonly passkeysService: PasskeysService) {}

    // ==========================================
    // 1. REGISTRATION (AUTHENTICATED)
    // ==========================================

    @Post('register/options')
    @UseGuards(JwtAuthGuard)
    @HttpCode(HttpStatus.OK)
    generateRegistrationOptions(
        @Req() req: { user: AuthenticatedUser },
    ) {
        return this.passkeysService.generateRegistrationOptions(req.user);
    }

    @Post('register/verify')
    @UseGuards(JwtAuthGuard)
    @HttpCode(HttpStatus.OK)
    verifyRegistration(
        @Req() req: { user: AuthenticatedUser },
        @Body() dto: VerifyRegistrationDto,
    ) {
        return this.passkeysService.verifyRegistration(req.user, dto);
    }

    // ==========================================
    // 2. AUTHENTICATION (PUBLIC)
    // ==========================================

    @Post('authenticate/options')
    @HttpCode(HttpStatus.OK)
    generateAuthenticationOptions(
        @Body() dto: AuthenticateOptionsDto,
    ) {
        return this.passkeysService.generateAuthenticationOptions(dto);
    }

    @Post('authenticate/verify')
    @HttpCode(HttpStatus.OK)
    verifyAuthentication(
        @Body() dto: VerifyAuthenticationDto,
        @Req() req?: RequestWithMeta,
    ) {
        const ipAddress = resolveSafeClientIp(req);
        const userAgent = req?.headers?.['user-agent'];
        return this.passkeysService.verifyAuthentication(dto, {
            ipAddress,
            userAgent,
        });
    }

    // ==========================================
    // 3. CREDENTIAL MANAGEMENT (AUTHENTICATED)
    // ==========================================

    @Get()
    @UseGuards(JwtAuthGuard)
    listCredentials(
        @Req() req: { user: AuthenticatedUser },
    ) {
        return this.passkeysService.listUserCredentials(req.user.id);
    }

    @Delete(':id')
    @UseGuards(JwtAuthGuard)
    deleteCredential(
        @Req() req: { user: AuthenticatedUser },
        @Param('id') credentialId: string,
    ) {
        return this.passkeysService.deleteUserCredential(
            credentialId,
            req.user.id,
        );
    }
}
