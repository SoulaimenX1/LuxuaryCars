import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Post,
    Req,
    UseGuards,
} from '@nestjs/common';

import {
    UserRole,
} from '../users/entities/user.entity.js';

import {
    AuthService,
} from './auth.service.js';

import {
    LoginDto,
} from './dto/login.dto.js';

import {
    RegisterDto,
} from './dto/register.dto.js';

import {
    LogoutDto,
    RefreshTokenDto,
} from './dto/refresh-token.dto.js';

import {
    ConfirmPasswordResetDto,
    RequestPasswordResetDto,
} from './dto/password-reset.dto.js';

import {
    ConfirmEmailVerificationDto,
    RequestEmailVerificationDto,
} from './dto/email-verification.dto.js';

import {
    Roles,
} from './decorators/roles.decorator.js';

import {
    JwtAuthGuard,
} from './guards/jwt-auth.guard.js';

import type {
    AuthenticatedUser,
} from './guards/jwt-auth.guard.js';

import {
    RolesGuard,
} from './guards/roles.guard.js';

import {
    AuthRateLimitGuard,
} from './rate-limit/auth-rate-limit.guard.js';

import {
    AuthRateLimit,
} from './rate-limit/auth-rate-limit.options.js';

interface RequestWithClientMeta {
    ip?: string;
    socket?: { remoteAddress?: string };
    headers?: {
        'user-agent'?: string;
        'x-forwarded-for'?: string;
    };
}

@Controller('auth')
export class AuthController {
    constructor(
        private readonly authService: AuthService,
    ) { }

    // ==========================================
    // 1. PUBLIC: CUSTOMER REGISTRATION
    // ==========================================

    @Post('register')
    @UseGuards(AuthRateLimitGuard)
    @AuthRateLimit('register')
    register(@Body() dto: RegisterDto) {
        return this.authService.register(dto);
    }

    // ==========================================
    // 2. PUBLIC: USER LOGIN
    // ==========================================

    @Post('login')
    @HttpCode(HttpStatus.OK)
    @UseGuards(AuthRateLimitGuard)
    @AuthRateLimit('login')
    login(
        @Body() dto: LoginDto,
        @Req() req?: RequestWithClientMeta,
    ) {
        return this.authService.login(
            dto,
            this.extractClientMeta(req),
        );
    }

    // ==========================================
    // 3. PUBLIC: REFRESH TOKEN ROTATION
    // ==========================================

    @Post('refresh')
    @HttpCode(HttpStatus.OK)
    refresh(
        @Body() dto: RefreshTokenDto,
        @Req() req?: RequestWithClientMeta,
    ) {
        return this.authService.refreshTokens(
            dto,
            this.extractClientMeta(req),
        );
    }

    // ==========================================
    // 4. PUBLIC: LOGOUT / REVOKE REFRESH TOKEN
    // ==========================================

    @Post('logout')
    @HttpCode(HttpStatus.OK)
    logout(@Body() dto?: LogoutDto) {
        return this.authService.logout(dto);
    }

    // ==========================================
    // 5. PUBLIC: EMAIL VERIFICATION
    // ==========================================

    @Post('verify-email/request')
    @HttpCode(HttpStatus.OK)
    @UseGuards(AuthRateLimitGuard)
    @AuthRateLimit('register')
    requestEmailVerification(
        @Body() dto: RequestEmailVerificationDto,
    ) {
        return this.authService.requestEmailVerification(dto);
    }

    @Post('verify-email/confirm')
    @HttpCode(HttpStatus.OK)
    @UseGuards(AuthRateLimitGuard)
    @AuthRateLimit('login')
    confirmEmailVerification(
        @Body() dto: ConfirmEmailVerificationDto,
    ) {
        return this.authService.confirmEmailVerification(dto);
    }

    // ==========================================
    // 6. PUBLIC: PASSWORD RESET
    // ==========================================

    @Post('password-reset/request')
    @HttpCode(HttpStatus.OK)
    @UseGuards(AuthRateLimitGuard)
    @AuthRateLimit('login')
    requestPasswordReset(
        @Body() dto: RequestPasswordResetDto,
    ) {
        return this.authService.requestPasswordReset(dto);
    }

    @Post('password-reset/confirm')
    @HttpCode(HttpStatus.OK)
    @UseGuards(AuthRateLimitGuard)
    @AuthRateLimit('login')
    confirmPasswordReset(
        @Body() dto: ConfirmPasswordResetDto,
    ) {
        return this.authService.confirmPasswordReset(dto);
    }

    // ==========================================
    // 7. PRIVATE: AUTHENTICATED USER PROFILE
    // ==========================================

    @Get('me')
    @UseGuards(JwtAuthGuard)
    me(
        @Req()
        request: { user: AuthenticatedUser },
    ) {
        return request.user;
    }

    // ==========================================
    // 8. PRIVATE: ADMIN ACCESS CHECK
    // ==========================================

    @Get('admin-check')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    adminCheck() {
        return {
            message: 'Admin access granted',
        };
    }

    private extractClientMeta(req?: RequestWithClientMeta) {
        if (!req) return undefined;
        const ipAddress =
            req.ip ??
            req.headers?.['x-forwarded-for'] ??
            req.socket?.remoteAddress ??
            null;
        const userAgent = req.headers?.['user-agent'] ?? null;
        return { ipAddress, userAgent };
    }
}
