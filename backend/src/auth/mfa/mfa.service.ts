import {
    BadRequestException,
    HttpException,
    HttpStatus,
    Injectable,
    Logger,
    UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { User } from '../../users/entities/user.entity.js';
import { UsersService } from '../../users/users.service.js';
import {
    formatMfaUserAgent,
    generateMfaRefreshToken,
    hashAuthToken,
    normalizeInetAddress,
    type AuthRequestMetadata,
} from '../auth.service.js';

interface RateLimitEntry {
    count: number;
    lockedUntil: number;
}

interface InMemoryRecoveryCode {
    codeHash: string;
    used: boolean;
    createdAt: Date;
}

@Injectable()
export class MfaService {
    private readonly logger = new Logger(MfaService.name);

    // In-memory rate limiter: max 3 failed attempts per 5 minutes per user/identifier
    private readonly failedAttempts = new Map<string, RateLimitEntry>();

    // Resilient fallback storage for recovery codes when migration 032 is not yet applied to database
    private readonly inMemoryRecoveryCodes = new Map<string, InMemoryRecoveryCode[]>();

    constructor(
        private readonly jwtService: JwtService,
        private readonly usersService: UsersService,
        private readonly dataSource: DataSource,
    ) {}

    /**
     * Issue restricted 5-minute pre-auth token (scope: 'mfa_pending')
     */
    async generatePreAuthToken(user: User): Promise<{
        preAuthToken: string;
        expiresIn: number;
        user: Pick<User, 'id' | 'email' | 'firstName' | 'lastName' | 'role'>;
    }> {
        const expiresIn = 300; // 5 minutes strict TTL
        const preAuthToken = await this.jwtService.signAsync(
            {
                sub: user.id,
                role: user.role,
                scope: 'mfa_pending',
                pre_auth: true,
                mfa_verified: false,
                amr: ['pwd'],
            },
            { expiresIn },
        );

        return {
            preAuthToken,
            expiresIn,
            user: {
                id: user.id,
                email: user.email,
                firstName: user.firstName,
                lastName: user.lastName,
                role: user.role,
            },
        };
    }

    /**
     * Validate pre-auth token and return authenticating user
     */
    async validatePreAuthToken(preAuthToken: string): Promise<User> {
        if (!preAuthToken) {
            throw new UnauthorizedException('Missing pre-authentication token');
        }

        let payload: any;
        try {
            payload = await this.jwtService.verifyAsync(preAuthToken);
        } catch {
            throw new UnauthorizedException('Invalid or expired pre-auth token');
        }

        if (
            !payload ||
            payload.scope !== 'mfa_pending' ||
            payload.pre_auth !== true
        ) {
            throw new UnauthorizedException('Invalid pre-authentication session');
        }

        const user = await this.usersService.findById(payload.sub);
        if (!user) {
            throw new UnauthorizedException('User not found');
        }

        return user;
    }

    /**
     * Rate limit verification: max 3 attempts per 5 minutes
     */
    private checkRateLimit(key: string): void {
        const entry = this.failedAttempts.get(key);
        const now = Date.now();

        if (entry) {
            if (entry.lockedUntil > now) {
                const remainingSeconds = Math.ceil((entry.lockedUntil - now) / 1000);
                throw new HttpException(
                    `Too many failed MFA attempts. Account temporarily locked for ${remainingSeconds} seconds.`,
                    HttpStatus.TOO_MANY_REQUESTS,
                );
            }

            // Lock expired, reset
            if (entry.lockedUntil <= now && entry.count >= 3) {
                this.failedAttempts.delete(key);
            }
        }
    }

    private recordFailedAttempt(key: string): void {
        const now = Date.now();
        const entry = this.failedAttempts.get(key) || { count: 0, lockedUntil: 0 };
        entry.count += 1;

        if (entry.count >= 3) {
            entry.lockedUntil = now + 5 * 60 * 1000; // 5 minutes lockout
            this.logger.warn(`Rate limit triggered for MFA identifier: ${key}`);
        }

        this.failedAttempts.set(key, entry);
    }

    private clearFailedAttempts(key: string): void {
        this.failedAttempts.delete(key);
    }

    /**
     * Generate 10 single-use Argon2-hashed recovery codes
     */
    async generateRecoveryCodes(userId: string): Promise<string[]> {
        const rawCodes: string[] = [];
        const hashes: string[] = [];

        for (let i = 0; i < 10; i++) {
            const part1 = crypto.randomBytes(2).toString('hex').toUpperCase();
            const part2 = crypto.randomBytes(2).toString('hex').toUpperCase();
            const rawCode = `${part1}-${part2}`;
            rawCodes.push(rawCode);
            const hash = await argon2.hash(rawCode);
            hashes.push(hash);
        }

        // Try storing in database if table exists; fallback to memory store
        let dbStored = false;
        if (this.dataSource && this.dataSource.isInitialized) {
            try {
                // Delete previous unused codes for this user
                await this.dataSource.query(
                    `DELETE FROM mfa_recovery_codes WHERE user_id = $1::uuid AND used_at IS NULL`,
                    [userId],
                );
                for (const h of hashes) {
                    await this.dataSource.query(
                        `INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1::uuid, $2)`,
                        [userId, h],
                    );
                }
                dbStored = true;
            } catch {
                dbStored = false;
            }
        }

        if (!dbStored) {
            this.inMemoryRecoveryCodes.set(
                userId,
                hashes.map((h) => ({ codeHash: h, used: false, createdAt: new Date() })),
            );
        }

        return rawCodes;
    }

    /**
     * Verify single-use recovery code with Argon2 & rate limiting
     */
    async verifyRecoveryCode(
        preAuthToken: string,
        code: string,
        meta?: AuthRequestMetadata,
    ) {
        const user = await this.validatePreAuthToken(preAuthToken);
        const rateLimitKey = `mfa:recovery:${user.id}`;
        this.checkRateLimit(rateLimitKey);

        const normalizedCode = code?.trim().toUpperCase();
        if (!normalizedCode || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(normalizedCode)) {
            this.recordFailedAttempt(rateLimitKey);
            throw new BadRequestException('Invalid recovery code format. Expected XXXX-XXXX');
        }

        // Check database or in-memory fallback
        let matched = false;
        let dbUsed = false;

        if (this.dataSource && this.dataSource.isInitialized) {
            try {
                const rows = await this.dataSource.query(
                    `SELECT id, code_hash FROM mfa_recovery_codes WHERE user_id = $1::uuid AND used_at IS NULL`,
                    [user.id],
                );
                for (const row of rows) {
                    if (await argon2.verify(row.code_hash, normalizedCode)) {
                        await this.dataSource.query(
                            `UPDATE mfa_recovery_codes SET used_at = now() WHERE id = $1::uuid`,
                            [row.id],
                        );
                        matched = true;
                        dbUsed = true;
                        break;
                    }
                }
            } catch {
                dbUsed = false;
            }
        }

        if (!dbUsed) {
            const memoryList = this.inMemoryRecoveryCodes.get(user.id) || [];
            for (const item of memoryList) {
                if (!item.used && (await argon2.verify(item.codeHash, normalizedCode))) {
                    item.used = true;
                    matched = true;
                    break;
                }
            }
        }

        if (!matched) {
            this.recordFailedAttempt(rateLimitKey);
            throw new UnauthorizedException('Invalid or already used recovery code');
        }

        this.clearFailedAttempts(rateLimitKey);

        // Issue fully elevated session
        return this.issueFullTokens(user, ['pwd', 'recovery_code'], meta);
    }

    /**
     * Issue full session tokens with server-controlled assurance claims
     */
    async issueFullTokens(
        user: User,
        amr: string[],
        meta?: AuthRequestMetadata,
    ) {
        const accessToken = await this.jwtService.signAsync({
            sub: user.id,
            role: user.role,
            scope: 'authenticated',
            mfa_verified: true,
            amr,
        });

        const expiresIn = 30 * 24 * 60 * 60; // 30 days default
        const refreshExpiresIn = 30 * 24 * 60 * 60;
        const refreshToken = generateMfaRefreshToken();

        if (this.dataSource && this.dataSource.isInitialized) {
            try {
                const tokenHash = hashAuthToken(refreshToken);
                const ipAddress = normalizeInetAddress(meta?.ipAddress);
                const userAgent = formatMfaUserAgent(meta?.userAgent, amr);

                await this.dataSource.query(
                    `INSERT INTO refresh_tokens
                        (user_id, token_hash, expires_at, ip_address, user_agent)
                     VALUES
                        ($1::uuid, $2, now() + ($3::int * interval '1 second'), $4::inet, $5)`,
                    [user.id, tokenHash, refreshExpiresIn, ipAddress, userAgent],
                );
            } catch (err: any) {
                this.logger.warn(`Could not persist refresh token: ${err?.message}`);
            }
        }

        return {
            accessToken,
            refreshToken,
            expiresIn,
            refreshExpiresIn,
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
}
