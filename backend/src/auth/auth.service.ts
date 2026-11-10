import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    Optional,
    UnauthorizedException,
    forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import argon2 from 'argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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

export interface OptionalAuthContext {
    userId?: string | null;
    email?: string | null;
    authorizationHeader?: string | null;
}

export function generateOpaqueToken(): string {
    return randomBytes(32).toString('base64url');
}

export function generateMfaRefreshToken(): string {
    return `rt_mfa_${generateOpaqueToken()}`;
}

export function formatMfaUserAgent(
    rawUserAgent: string | null | undefined,
    amr?: string[] | null,
): string | null {
    if (!amr || amr.length === 0) {
        if (!rawUserAgent || typeof rawUserAgent !== 'string') return null;
        const clean = rawUserAgent.replace(/\[mfa:[^\]]*\]/g, '').trim();
        return clean.length > 0 ? clean.slice(0, 500) : null;
    }
    const cleanUa =
        typeof rawUserAgent === 'string' && rawUserAgent.trim().length > 0
            ? rawUserAgent.replace(/\[mfa:[^\]]*\]/g, '').trim()
            : 'client';
    const tag = `[mfa:${amr.join(',')}]`;
    const combined = `${cleanUa} ${tag}`.trim();
    return combined.slice(0, 500);
}

export function extractMfaAmr(
    userAgent: string | null | undefined,
    rawToken?: string | null,
): string[] | null {
    if (typeof rawToken === 'string' && rawToken.startsWith('rt_mfa_')) {
        if (userAgent) {
            const match = userAgent.match(/\[mfa:([^\]]+)\]/);
            if (match && match[1]) {
                const list = match[1]
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
                if (list.length > 0) return list;
            }
        }
        return ['mfa'];
    }

    if (!userAgent || typeof userAgent !== 'string') return null;
    const match = userAgent.match(/\[mfa:([^\]]+)\]/);
    if (!match || !match[1]) return null;
    const list = match[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    return list.length > 0 ? list : null;
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
        const normalizedEmail = dto.email
            .trim()
            .toLowerCase();
        const passwordHash = await argon2.hash(
            dto.password,
        );

        let user;
        try {
            user = await this.usersService.createCustomer({
                firstName: dto.firstName,
                lastName: dto.lastName,
                email: normalizedEmail,
                passwordHash,
                phone: dto.phone,
            });
        } catch (error) {
            if (error instanceof ConflictException) {
                // Safe duplicate-email mitigation: do not leak 409 or existing account metadata.
                // If the existing account is active and unverified, silently send a verification link.
                if (this.dataSource) {
                    try {
                        const existingUser =
                            await this.usersService.findByEmail?.(
                                normalizedEmail,
                            );
                        if (
                            existingUser &&
                            existingUser.status === AccountStatus.ACTIVE &&
                            !existingUser.emailVerifiedAt
                        ) {
                            const issued = await this.issueOneTimeToken(
                                existingUser.id,
                                'email_verification',
                                this.getEmailVerificationExpiresInSeconds(),
                            );
                            await this.emailOutbox?.safelyNotifyEmailVerification({
                                customerId: existingUser.id,
                                recipientEmail: existingUser.email,
                                customerName: `${existingUser.firstName} ${existingUser.lastName}`,
                                token: issued.rawToken,
                                tokenId: issued.tokenId,
                                expiresAt: issued.expiresAt,
                            });
                        } else {
                            hashAuthToken(generateOpaqueToken());
                        }
                    } catch {
                        // Non-blocking
                    }
                } else {
                    hashAuthToken(generateOpaqueToken());
                }

                return {
                    id: randomUUID(),
                    firstName: dto.firstName.trim(),
                    lastName: dto.lastName.trim(),
                    email: normalizedEmail,
                    role: UserRole.CUSTOMER,
                    status: AccountStatus.ACTIVE,
                    createdAt: new Date(),
                };
            }

            throw error;
        }

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

        const isPrivileged = user.role === UserRole.ADMIN || user.role === UserRole.STAFF;
        const isMfaEnforcedGlobal = process.env.ENABLE_MANDATORY_ADMIN_MFA === 'true';

        // Mandatory MFA for privileged roles when enabled via feature flag
        if (isMfaEnforcedGlobal && isPrivileged) {
            const preAuthToken = await this.jwtService.signAsync(
                {
                    sub: user.id,
                    role: user.role,
                    scope: 'mfa_pending',
                    pre_auth: true,
                    mfa_verified: false,
                    amr: ['pwd'],
                },
                { expiresIn: 300 }, // 5 minutes strict TTL
            );

            return {
                mfaRequired: true,
                preAuthToken,
                expiresIn: 300,
                tokenType: 'Bearer',
                user: {
                    id: user.id,
                    email: user.email,
                    firstName: user.firstName,
                    lastName: user.lastName,
                    role: user.role,
                },
            };
        }

        // Generate the short-lived JWT access token with assurance claims
        const accessToken =
            await this.jwtService.signAsync({
                sub: user.id,
                role: user.role,
                scope: 'authenticated',
                mfa_verified: false,
                amr: ['pwd'],
            });

        const expiresIn = this.getAccessExpiresInSeconds();
        const refreshExpiresIn = this.getRefreshExpiresInSeconds();
        const refreshToken = generateOpaqueToken();

        if (this.dataSource) {
            const tokenHash = hashAuthToken(refreshToken);
            const ipAddress = normalizeInetAddress(meta?.ipAddress);
            const userAgent = formatMfaUserAgent(meta?.userAgent, null);

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
                    userAgent: string | null;
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
                            rt.user_agent AS "userAgent",
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

                // Determine whether the session being refreshed was MFA-verified
                const mfaAmr = extractMfaAmr(record.userAgent, dto.refreshToken);
                const isMfaVerified = mfaAmr !== null && mfaAmr.length > 0;

                const newRefreshToken = isMfaVerified
                    ? generateMfaRefreshToken()
                    : generateOpaqueToken();
                const newTokenHash = hashAuthToken(newRefreshToken);

                const nextUserAgent = isMfaVerified
                    ? formatMfaUserAgent(userAgent || record.userAgent, mfaAmr)
                    : formatMfaUserAgent(userAgent, null);

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
                        nextUserAgent,
                    ],
                );

                return {
                    valid: true as const,
                    newRefreshToken,
                    isMfaVerified,
                    mfaAmr: mfaAmr ?? [],
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
            scope: 'authenticated',
            mfa_verified: outcome.isMfaVerified,
            amr: outcome.isMfaVerified
                ? ['refresh', ...outcome.mfaAmr]
                : ['refresh'],
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
        authContext?: OptionalAuthContext,
    ): Promise<{ message: string; alreadyVerified?: boolean }> {
        const startedAt = performance.now();
        const genericResponse = {
            message:
                'If that account exists and is unverified, a verification email has been sent.',
        };

        if (!this.dataSource) {
            hashAuthToken(generateOpaqueToken());
            await this.equalizePublicRequestTiming(startedAt);
            return genericResponse;
        }

        const [user, authUser] = await Promise.all([
            this.usersService.findByEmail(dto.email),
            this.resolveOptionalAuthenticatedUser(authContext),
        ]);

        if (
            !user ||
            user.status !== AccountStatus.ACTIVE
        ) {
            hashAuthToken(generateOpaqueToken());
            await this.equalizePublicRequestTiming(startedAt);
            return genericResponse;
        }

        const isAuthenticatedSelf = Boolean(
            authUser &&
                authUser.id === user.id &&
                authUser.email === user.email.trim().toLowerCase(),
        );

        if (user.emailVerifiedAt) {
            hashAuthToken(generateOpaqueToken());
            await this.equalizePublicRequestTiming(startedAt);
            if (isAuthenticatedSelf) {
                return {
                    message:
                        'This email address has already been verified. You can sign in directly.',
                    alreadyVerified: true,
                };
            }
            return genericResponse;
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

        await this.equalizePublicRequestTiming(startedAt);
        return genericResponse;
    }

    async confirmEmailVerification(
        dto: ConfirmEmailVerificationDto,
        authContext?: OptionalAuthContext,
    ) {
        if (!this.dataSource) {
            throw new BadRequestException(
                'Email verification service unavailable',
            );
        }

        const tokenHash = hashAuthToken(dto.token);
        const authUser =
            await this.resolveOptionalAuthenticatedUser(authContext);

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

            // Only reveal already-verified status without a valid token when the caller
            // is authenticated as that exact account. Never leak status to unauthenticated callers.
            if (
                !record &&
                authUser &&
                (!dto.email ||
                    dto.email.trim().toLowerCase() === authUser.email)
            ) {
                const userRows: {
                    status: AccountStatus;
                    emailVerifiedAt: Date | null;
                }[] = await manager.query(
                    `SELECT status, email_verified_at AS "emailVerifiedAt"
                     FROM users
                     WHERE id = $1::uuid AND email = $2::varchar`,
                    [authUser.id, authUser.email],
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

            // DETECT ALREADY-VERIFIED ACCOUNTS:
            // When an already-verified user re-submits a token (duplicate
            // clicks, email-scanner pre-fetch, page refresh, or expired link on an already-verified account),
            // report success rather than a confusing error. No state is changed.
            if (record.userEmailVerifiedAt) {
                return {
                    verified: true,
                    alreadyVerified: true,
                    emailVerifiedAt: record.userEmailVerifiedAt,
                    message:
                        'Your email address has already been verified. You can sign in directly.',
                };
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
        const startedAt = performance.now();
        const genericResponse = {
            message:
                'If an account with that email exists, password reset instructions have been sent.',
        };

        if (!this.dataSource) {
            hashAuthToken(generateOpaqueToken());
            await this.equalizePublicRequestTiming(startedAt);
            return genericResponse;
        }

        const user = await this.usersService.findByEmail(dto.email);
        if (!user || user.status !== AccountStatus.ACTIVE) {
            hashAuthToken(generateOpaqueToken());
            await this.equalizePublicRequestTiming(startedAt);
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

        await this.equalizePublicRequestTiming(startedAt);
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

    private async resolveOptionalAuthenticatedUser(
        authContext?: OptionalAuthContext,
    ): Promise<{ id: string; email: string } | null> {
        if (!authContext) {
            return null;
        }
        if (authContext.userId && authContext.email) {
            return {
                id: authContext.userId,
                email: authContext.email.trim().toLowerCase(),
            };
        }
        const authorization = authContext.authorizationHeader?.trim();
        if (!authorization) {
            return null;
        }
        const [scheme, token] = authorization.split(' ');
        if (scheme !== 'Bearer' || !token) {
            return null;
        }
        try {
            const payload = await this.jwtService?.verifyAsync<{ sub: string }>(
                token,
            );
            if (!payload?.sub || typeof payload.sub !== 'string') {
                return null;
            }
            const user = await this.usersService?.findById?.(payload.sub);
            if (!user || user.status !== AccountStatus.ACTIVE) {
                return null;
            }
            return {
                id: user.id,
                email: user.email.trim().toLowerCase(),
            };
        } catch {
            return null;
        }
    }

    private async equalizePublicRequestTiming(
        startedAtMs: number,
    ): Promise<void> {
        const minDurationMs = this.getPositiveNumber(
            'AUTH_PUBLIC_MIN_RESPONSE_MS',
            45,
        );
        const jitterMs = randomBytes(1)[0] % 8;
        const targetMs = minDurationMs + jitterMs;
        const elapsedMs = performance.now() - startedAtMs;
        if (elapsedMs < targetMs) {
            await new Promise((resolve) =>
                setTimeout(resolve, Math.ceil(targetMs - elapsedMs)),
            );
        }
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
