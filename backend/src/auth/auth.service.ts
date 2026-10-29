import {
    BadRequestException,
    Inject,
    Injectable,
    Optional,
    UnauthorizedException,
    forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { DataSource } from 'typeorm';

import { UsersService } from '../users/users.service.js';
import {
    AccountStatus,
    UserRole,
} from '../users/entities/user.entity.js';
import { InboxService } from '../notifications/inbox.service.js';
import { EmailOutboxService } from '../notifications/email-outbox.service.js';

import { LoginDto } from './dto/login.dto.js';
import { RegisterDto } from './dto/register.dto.js';
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

export interface AuthRequestMetadata {
    ipAddress?: string | null;
    userAgent?: string | null;
}

export function generateOpaqueToken(): string {
    return randomBytes(32).toString('base64url');
}

export function hashAuthToken(rawToken: string): string {
    return createHash('sha256')
        .update(rawToken.trim())
        .digest('hex');
}

export function normalizeInetAddress(
    rawIp?: string | null,
): string | null {
    if (!rawIp || typeof rawIp !== 'string') return null;
    const first = rawIp.split(',')[0]?.trim() ?? '';
    if (!first) return null;
    if (isIP(first) !== 0) return first;
    const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(first);
    if (ipv4WithPort && isIP(ipv4WithPort[1]) === 4) {
        return ipv4WithPort[1];
    }
    return null;
}

@Injectable()
export class AuthService {
    constructor(
        private readonly usersService: UsersService,
        private readonly jwtService: JwtService,

        // Rappel de permis : un avis est créé à chaque connexion
        // d'un client n'ayant pas encore enregistré son permis.
        @Inject(forwardRef(() => InboxService))
        private readonly inboxService: InboxService,

        @Optional()
        private readonly dataSource?: DataSource,

        @Optional()
        @Inject(forwardRef(() => EmailOutboxService))
        private readonly emailOutbox?: EmailOutboxService,

        @Optional()
        private readonly configService?: ConfigService,
    ) { }

    // ==========================================
    // 1. CUSTOMER REGISTRATION (+ EMAIL VERIFICATION TOKEN)
    // ==========================================

    async register(dto: RegisterDto) {
        const passwordHash = await argon2.hash(
            dto.password,
        );

        const user = await this.usersService.createCustomer({
            firstName: dto.firstName,
            lastName: dto.lastName,
            email: dto.email,
            passwordHash,
            phone: dto.phone,
        });

        if (this.dataSource) {
            try {
                const issued = await this.issueOneTimeToken(
                    user.id,
                    'email_verification',
                    this.getEmailVerificationExpiresInSeconds(),
                );
                await this.emailOutbox?.safelyNotifyEmailVerification({
                    customerId: user.id,
                    recipientEmail: user.email,
                    customerName: `${user.firstName} ${user.lastName}`,
                    token: issued.rawToken,
                    tokenId: issued.tokenId,
                    expiresAt: issued.expiresAt,
                });
            } catch {
                // Non-blocking: registration succeeds even if verification token queueing fails
            }
        }

        return {
            id: user.id,
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            role: user.role,
            status: user.status,
            createdAt: user.createdAt,
        };
    }

    // ==========================================
    // 2. USER LOGIN (SHORT-LIVED JWT + REFRESH TOKEN)
    // ==========================================

    async login(
        dto: LoginDto,
        meta?: AuthRequestMetadata,
    ) {
        const user =
            await this.usersService.findByEmailForAuth(
                dto.email,
            );

        // Check that the account exists and has a password
        if (!user || !user.passwordHash) {
            throw new UnauthorizedException(
                'Invalid email or password',
            );
        }

        // Verify the password using Argon2
        const passwordIsValid = await argon2.verify(
            user.passwordHash,
            dto.password,
        );

        if (!passwordIsValid) {
            throw new UnauthorizedException(
                'Invalid email or password',
            );
        }

        // Only active accounts can log in
        if (user.status !== AccountStatus.ACTIVE) {
            throw new UnauthorizedException(
                'Invalid email or password',
            );
        }

        // Generate the short-lived JWT access token
        const accessToken =
            await this.jwtService.signAsync({
                sub: user.id,
                role: user.role,
            });

        const expiresIn = this.getAccessExpiresInSeconds();
        const refreshExpiresIn = this.getRefreshExpiresInSeconds();
        const refreshToken = generateOpaqueToken();

        if (this.dataSource) {
            const tokenHash = hashAuthToken(refreshToken);
            const ipAddress = normalizeInetAddress(meta?.ipAddress);
            const userAgent =
                typeof meta?.userAgent === 'string' &&
                meta.userAgent.trim().length > 0
                    ? meta.userAgent.trim().slice(0, 500)
                    : null;

            await this.dataSource.query(
                `INSERT INTO refresh_tokens
                    (user_id, token_hash, expires_at, ip_address, user_agent)
                 VALUES
                    ($1::uuid, $2, now() + ($3::int * interval '1 second'), $4::inet, $5)`,
                [
                    user.id,
                    tokenHash,
                    refreshExpiresIn,
                    ipAddress,
                    userAgent,
                ],
            );
            await this.dataSource.query(
                `UPDATE users SET last_login_at = now() WHERE id = $1::uuid`,
                [user.id],
            );
        }

        // Un client sans permis enregistré reçoit un avis
        // « Driving licence required » à chaque connexion.
        // L'échec de la notification ne doit jamais bloquer
        // la connexion.
        if (user.role === UserRole.CUSTOMER) {
            await this.inboxService.safelyLicenseRequired(user.id);
        }

        return {
            accessToken,
            refreshToken,
            tokenType: 'Bearer',
            expiresIn,
            refreshExpiresIn,

            user: {
                id: user.id,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                role: user.role,
            },
        };
    }

    // ==========================================
    // 3. REFRESH-TOKEN ROTATION (+ REUSE DETECTION)
    // ==========================================

    async refreshTokens(
        dto: RefreshTokenDto,
        meta?: AuthRequestMetadata,
    ) {
        if (!this.dataSource) {
            throw new UnauthorizedException(
                'Refresh token storage unavailable',
            );
        }

        const incomingHash = hashAuthToken(dto.refreshToken);
        const expiresIn = this.getAccessExpiresInSeconds();
        const refreshExpiresIn = this.getRefreshExpiresInSeconds();
        const ipAddress = normalizeInetAddress(meta?.ipAddress);
        const userAgent =
            typeof meta?.userAgent === 'string' &&
            meta.userAgent.trim().length > 0
                ? meta.userAgent.trim().slice(0, 500)
                : null;

        const outcome = await this.dataSource.transaction(
            async (manager) => {
                const rows: {
                    tokenId: string;
                    userId: string;
                    expiresAt: Date;
                    revokedAt: Date | null;
                    firstName: string;
                    lastName: string;
                    email: string;
                    role: UserRole;
                    status: AccountStatus;
                }[] = await manager.query(
                    `SELECT rt.id AS "tokenId",
                            rt.user_id AS "userId",
                            rt.expires_at AS "expiresAt",
                            rt.revoked_at AS "revokedAt",
                            u.first_name AS "firstName",
                            u.last_name AS "lastName",
                            u.email,
                            u.role,
                            u.status
                     FROM refresh_tokens rt
                     JOIN users u ON u.id = rt.user_id
                     WHERE rt.token_hash = $1
                     FOR UPDATE OF rt`,
                    [incomingHash],
                );

                const record = rows[0];
                if (!record) {
                    return { valid: false as const };
                }

                // Reuse detection: if an already-revoked refresh token is presented again,
                // revoke ALL active refresh tokens for that user to mitigate token theft.
                if (record.revokedAt !== null) {
                    await manager.query(
                        `UPDATE refresh_tokens
                         SET revoked_at = now()
                         WHERE user_id = $1::uuid
                           AND revoked_at IS NULL`,
                        [record.userId],
                    );
                    return { valid: false as const, reused: true as const };
                }

                if (
                    new Date(record.expiresAt) <= new Date() ||
                    record.status !== AccountStatus.ACTIVE
                ) {
                    await manager.query(
                        `UPDATE refresh_tokens
                         SET revoked_at = COALESCE(revoked_at, now())
                         WHERE id = $1::uuid`,
                        [record.tokenId],
                    );
                    return { valid: false as const };
                }

                // Rotate: revoke current token and issue a fresh token in the same transaction
                await manager.query(
                    `UPDATE refresh_tokens
                     SET revoked_at = now()
                     WHERE id = $1::uuid`,
                    [record.tokenId],
                );

                const newRefreshToken = generateOpaqueToken();
                const newTokenHash = hashAuthToken(newRefreshToken);

                await manager.query(
                    `INSERT INTO refresh_tokens
                        (user_id, token_hash, expires_at, ip_address, user_agent)
                     VALUES
                        ($1::uuid, $2, now() + ($3::int * interval '1 second'), $4::inet, $5)`,
                    [
                        record.userId,
                        newTokenHash,
                        refreshExpiresIn,
                        ipAddress,
                        userAgent,
                    ],
                );

                return {
                    valid: true as const,
                    newRefreshToken,
                    user: {
                        id: record.userId,
                        firstName: record.firstName,
                        lastName: record.lastName,
                        email: record.email,
                        role: record.role,
                    },
                };
            },
        );

        if (!outcome.valid) {
            throw new UnauthorizedException(
                'Invalid or expired refresh token',
            );
        }

        const accessToken = await this.jwtService.signAsync({
            sub: outcome.user.id,
            role: outcome.user.role,
        });

        return {
            accessToken,
            refreshToken: outcome.newRefreshToken,
            tokenType: 'Bearer',
            expiresIn,
            refreshExpiresIn,
            user: outcome.user,
        };
    }

    // ==========================================
    // 4. LOGOUT / REFRESH TOKEN REVOCATION
    // ==========================================

    async logout(dto?: LogoutDto) {
        if (dto?.refreshToken && this.dataSource) {
            const tokenHash = hashAuthToken(dto.refreshToken);
            await this.dataSource.query(
                `UPDATE refresh_tokens
                 SET revoked_at = now()
                 WHERE token_hash = $1
                   AND revoked_at IS NULL`,
                [tokenHash],
            );
        }
        return {
            message: 'Logged out successfully.',
        };
    }

    // ==========================================
    // 5. EMAIL VERIFICATION (REQUEST & CONFIRM)
    // ==========================================

    async requestEmailVerification(
        dto: RequestEmailVerificationDto,
    ): Promise<{ message: string; alreadyVerified?: boolean }> {
        const genericResponse = {
            message:
                'If that account exists and is unverified, a verification email has been sent.',
        };

        if (!this.dataSource) {
            return genericResponse;
        }

        const user = await this.usersService.findByEmail(dto.email);
        if (
            !user ||
            user.status !== AccountStatus.ACTIVE
        ) {
            return genericResponse;
        }

        if (user.emailVerifiedAt) {
            return {
                message:
                    'This email address has already been verified. You can sign in directly.',
                alreadyVerified: true,
            };
        }

        const issued = await this.issueOneTimeToken(
            user.id,
            'email_verification',
            this.getEmailVerificationExpiresInSeconds(),
        );

        await this.emailOutbox?.safelyNotifyEmailVerification({
            customerId: user.id,
            recipientEmail: user.email,
            customerName: `${user.firstName} ${user.lastName}`,
            token: issued.rawToken,
            tokenId: issued.tokenId,
            expiresAt: issued.expiresAt,
        });

        return genericResponse;
    }

    async confirmEmailVerification(
        dto: ConfirmEmailVerificationDto,
    ) {
        if (!this.dataSource) {
            throw new BadRequestException(
                'Email verification service unavailable',
            );
        }

        const tokenHash = hashAuthToken(dto.token);

        return this.dataSource.transaction(async (manager) => {
            const rows: {
                tokenId: string;
                userId: string;
                expiresAt: Date;
                usedAt: Date | null;
                createdAt?: Date;
                status: AccountStatus;
                userEmailVerifiedAt?: Date | null;
                dbNow?: Date;
            }[] = await manager.query(
                `SELECT ott.id AS "tokenId",
                        ott.user_id AS "userId",
                        ott.expires_at AS "expiresAt",
                        ott.used_at AS "usedAt",
                        ott.created_at AS "createdAt",
                        u.status,
                        u.email_verified_at AS "userEmailVerifiedAt",
                        now() AS "dbNow"
                 FROM one_time_tokens ott
                 JOIN users u ON u.id = ott.user_id
                 WHERE ott.token_hash = $1
                   AND ott.type = 'email_verification'
                 FOR UPDATE OF ott, u`,
                [tokenHash],
            );

            const record = rows[0];

            // If token was not found, but email was provided, check if that account is already verified
            if (!record && dto.email) {
                const userRows: {
                    status: AccountStatus;
                    emailVerifiedAt: Date | null;
                }[] = await manager.query(
                    `SELECT status, email_verified_at AS "emailVerifiedAt"
                     FROM users
                     WHERE email = $1::varchar`,
                    [dto.email.trim().toLowerCase()],
                );
                if (
                    userRows[0]?.status === AccountStatus.ACTIVE &&
                    userRows[0]?.emailVerifiedAt
                ) {
                    return {
                        verified: true,
                        alreadyVerified: true,
                        emailVerifiedAt: userRows[0].emailVerifiedAt,
                        message:
                            'Your email address has already been verified. You can sign in directly.',
                    };
                }
            }

            if (!record || record.status !== AccountStatus.ACTIVE) {
                throw new BadRequestException(
                    'Invalid or expired verification token',
                );
            }

            // STRICT EXPIRY: a verification token is valid for at most
            // EMAIL_VERIFICATION_TTL (5 minutes) after issuance. Expiry is
            // evaluated against the database clock, which is authoritative.
            const dbNow = record.dbNow ? new Date(record.dbNow) : new Date();
            const expiresAt = new Date(record.expiresAt);
            if (dbNow >= expiresAt) {
                throw new BadRequestException(
                    'Invalid or expired verification token',
                );
            }

            // DETECT ALREADY-VERIFIED ACCOUNTS:
            // When an already-verified user re-submits a still-valid token (duplicate
            // clicks, email-scanner pre-fetch, page refresh), report success rather
            // than a confusing error. No state is changed.
            if (record.userEmailVerifiedAt) {
                return {
                    verified: true,
                    alreadyVerified: true,
                    emailVerifiedAt: record.userEmailVerifiedAt,
                    message:
                        'Your email address has already been verified. You can sign in directly.',
                };
            }

            // SINGLE USE: a token that was already consumed (or superseded by a
            // newer issuance) can never verify an account.
            if (record.usedAt !== null) {
                throw new BadRequestException(
                    'Invalid or expired verification token',
                );
            }

            await manager.query(
                `UPDATE one_time_tokens
                 SET used_at = now()
                 WHERE user_id = $1::uuid
                   AND type = 'email_verification'
                   AND used_at IS NULL`,
                [record.userId],
            );

            const updated: { emailVerifiedAt: Date }[] =
                await manager.query(
                    `UPDATE users
                     SET email_verified_at = COALESCE(email_verified_at, now()),
                         updated_at = now()
                     WHERE id = $1::uuid
                     RETURNING email_verified_at AS "emailVerifiedAt"`,
                    [record.userId],
                );

            return {
                verified: true,
                emailVerifiedAt: updated[0]?.emailVerifiedAt ?? new Date(),
            };
        });
    }

    // ==========================================
    // 6. PASSWORD RESET (REQUEST & CONFIRM)
    // ==========================================

    async requestPasswordReset(
        dto: RequestPasswordResetDto,
    ) {
        const genericResponse = {
            message:
                'If an account with that email exists, password reset instructions have been sent.',
        };

        if (!this.dataSource) {
            return genericResponse;
        }

        const user = await this.usersService.findByEmail(dto.email);
        if (!user || user.status !== AccountStatus.ACTIVE) {
            return genericResponse;
        }

        const issued = await this.issueOneTimeToken(
            user.id,
            'password_reset',
            this.getPasswordResetExpiresInSeconds(),
        );

        await this.emailOutbox?.safelyNotifyPasswordReset({
            customerId: user.id,
            recipientEmail: user.email,
            customerName: `${user.firstName} ${user.lastName}`,
            token: issued.rawToken,
            tokenId: issued.tokenId,
            expiresAt: issued.expiresAt,
        });

        return genericResponse;
    }

    async confirmPasswordReset(
        dto: ConfirmPasswordResetDto,
    ) {
        if (!this.dataSource) {
            throw new BadRequestException(
                'Password reset service unavailable',
            );
        }

        const tokenHash = hashAuthToken(dto.token);
        const newPasswordHash = await argon2.hash(dto.newPassword);

        return this.dataSource.transaction(async (manager) => {
            const rows: {
                tokenId: string;
                userId: string;
                expiresAt: Date;
                usedAt: Date | null;
                status: AccountStatus;
            }[] = await manager.query(
                `SELECT ott.id AS "tokenId",
                        ott.user_id AS "userId",
                        ott.expires_at AS "expiresAt",
                        ott.used_at AS "usedAt",
                        u.status
                 FROM one_time_tokens ott
                 JOIN users u ON u.id = ott.user_id
                 WHERE ott.token_hash = $1
                   AND ott.type = 'password_reset'
                 FOR UPDATE OF ott, u`,
                [tokenHash],
            );

            const record = rows[0];
            if (
                !record ||
                record.usedAt !== null ||
                new Date(record.expiresAt) <= new Date() ||
                record.status !== AccountStatus.ACTIVE
            ) {
                throw new BadRequestException(
                    'Invalid or expired password reset token',
                );
            }

            await manager.query(
                `UPDATE users
                 SET password_hash = $2,
                     updated_at = now()
                 WHERE id = $1::uuid`,
                [record.userId, newPasswordHash],
            );

            // Consume all active password_reset tokens for this user
            await manager.query(
                `UPDATE one_time_tokens
                 SET used_at = now()
                 WHERE user_id = $1::uuid
                   AND type = 'password_reset'
                   AND used_at IS NULL`,
                [record.userId],
            );

            // Revoke all active refresh tokens so existing sessions must re-authenticate
            await manager.query(
                `UPDATE refresh_tokens
                 SET revoked_at = now()
                 WHERE user_id = $1::uuid
                   AND revoked_at IS NULL`,
                [record.userId],
            );

            return {
                reset: true,
                message: 'Password has been reset successfully.',
            };
        });
    }

    // ==========================================
    // INTERNAL TOKEN & CONFIG HELPERS
    // ==========================================

    private async issueOneTimeToken(
        userId: string,
        type: 'password_reset' | 'email_verification',
        ttlSeconds: number,
    ): Promise<{
        tokenId: string;
        rawToken: string;
        expiresAt: Date;
    }> {
        const rawToken = generateOpaqueToken();
        const tokenHash = hashAuthToken(rawToken);
        // Email verification links live for at least 5 minutes (300 seconds)
        const effectiveTtl =
            type === 'email_verification'
                ? Math.max(ttlSeconds, 300)
                : ttlSeconds;

        return this.dataSource!.transaction(async (manager) => {
            if (type === 'email_verification') {
                // Email verification: ensure tokens remain valid for at least 5 minutes from issuance.
                // Invalidate only prior tokens older than 5 minutes or already expired
                await manager.query(
                    `UPDATE one_time_tokens
                     SET used_at = now()
                     WHERE user_id = $1::uuid
                       AND type = 'email_verification'
                       AND used_at IS NULL
                       AND (created_at < now() - interval '5 minutes' OR expires_at <= now())`,
                    [userId],
                );
            } else {
                await manager.query(
                    `UPDATE one_time_tokens
                     SET used_at = now()
                     WHERE user_id = $1::uuid
                       AND type = $2::token_type
                       AND used_at IS NULL`,
                    [userId, type],
                );
            }

            const inserted: { id: string; expiresAt: Date }[] =
                await manager.query(
                    `INSERT INTO one_time_tokens
                        (user_id, type, token_hash, expires_at)
                     VALUES
                        ($1::uuid, $2::token_type, $3, now() + ($4::int * interval '1 second'))
                     RETURNING id, expires_at AS "expiresAt"`,
                    [userId, type, tokenHash, effectiveTtl],
                );

            return {
                tokenId: inserted[0].id,
                rawToken,
                expiresAt: inserted[0].expiresAt,
            };
        });
    }

    private getAccessExpiresInSeconds(): number {
        return this.getPositiveNumber(
            'JWT_ACCESS_EXPIRES_IN_SECONDS',
            900,
        );
    }

    private getRefreshExpiresInSeconds(): number {
        return this.getPositiveNumber(
            'JWT_REFRESH_EXPIRES_IN_SECONDS',
            30 * 24 * 60 * 60,
        );
    }

    private getPasswordResetExpiresInSeconds(): number {
        return this.getPositiveNumber(
            'PASSWORD_RESET_EXPIRES_IN_SECONDS',
            3600,
        );
    }

    private getEmailVerificationExpiresInSeconds(): number {
        // Hard maximum of 5 minutes (300 seconds) from issuance.
        const ttl = this.getPositiveNumber(
            'EMAIL_VERIFICATION_EXPIRES_IN_SECONDS',
            300,
        );
        return Math.min(ttl, 300);
    }

    private getPositiveNumber(
        key: string,
        fallback: number,
    ): number {
        const raw =
            this.configService?.get<number | string>(key) ??
            process.env[key];
        const parsed = Number(raw);
        return Number.isFinite(parsed) && parsed > 0
            ? Math.floor(parsed)
            : fallback;
    }
}
