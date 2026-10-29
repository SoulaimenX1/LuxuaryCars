import {
    BadRequestException,
    ConflictException,
    UnauthorizedException,
} from '@nestjs/common';

import { JwtService } from '@nestjs/jwt';

import argon2 from 'argon2';
import type { DataSource } from 'typeorm';

import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';

import {
    UsersService,
} from '../users/users.service.js';

import {
    InboxService,
} from '../notifications/inbox.service.js';

import type {
    EmailOutboxService,
} from '../notifications/email-outbox.service.js';

import type {
    CreateCustomerInput,
} from '../users/users.service.js';

// Stub du service de notifications : une connexion ne doit
// jamais échouer si le rappel de permis est indisponible.
function inboxStub() {
    return {
        safelyLicenseRequired: vi
            .fn()
            .mockResolvedValue(undefined),
    } as unknown as InboxService;
}

import {
    AccountStatus,
    User,
    UserRole,
} from '../users/entities/user.entity.js';

import {
    AuthService,
    hashAuthToken,
    normalizeInetAddress,
} from './auth.service.js';

describe('AuthService', () => {
    const registerDto = {
        firstName: 'Test',
        lastName: 'Customer',
        email: 'test@example.com',
        password: 'TestPassword2026!',
    };

    // ==========================================
    // TEST 1: SECURE CUSTOMER REGISTRATION
    // ==========================================

    it('should register a customer securely', async () => {
        const createCustomer = vi.fn(
            async (input: CreateCustomerInput): Promise<User> => {
                return {
                    id: '550e8400-e29b-41d4-a716-446655440000',
                    ...input,
                    role: UserRole.CUSTOMER,
                    status: AccountStatus.ACTIVE,
                    createdAt: new Date('2026-10-02T08:00:00Z'),
                } as User;
            },
        );

        const service = new AuthService(
            {
                createCustomer,
            } as unknown as UsersService,
            {
                signAsync: vi.fn(),
            } as unknown as JwtService,
            inboxStub(),
        );

        const result = await service.register(registerDto);

        // Verify that the customer was created
        expect(createCustomer).toHaveBeenCalledOnce();

        // Verify that the password was hashed
        const [input] = createCustomer.mock.calls[0];

        expect(input.passwordHash).not.toBe(
            registerDto.password,
        );

        expect(
            await argon2.verify(
                input.passwordHash,
                registerDto.password,
            ),
        ).toBe(true);

        // Verify that sensitive data is not returned
        expect(result.email).toBe(registerDto.email);

        expect(result.role).toBe(
            UserRole.CUSTOMER,
        );

        expect(result).not.toHaveProperty(
            'password',
        );

        expect(result).not.toHaveProperty(
            'passwordHash',
        );
    });

    // ==========================================
    // TEST 2: DUPLICATE EMAIL
    // ==========================================

    it('should propagate duplicate-email errors', async () => {
        const createCustomer = vi.fn(
            async (): Promise<User> => {
                throw new ConflictException(
                    'An account with this email already exists',
                );
            },
        );

        const service = new AuthService(
            {
                createCustomer,
            } as unknown as UsersService,
            {
                signAsync: vi.fn(),
            } as unknown as JwtService,
            inboxStub(),
        );

        await expect(
            service.register(registerDto),
        ).rejects.toBeInstanceOf(
            ConflictException,
        );
    });

    // ==========================================
    // TEST 3: SUCCESSFUL LOGIN
    // ==========================================

    it('should log in with valid credentials', async () => {
        const passwordHash = await argon2.hash(
            'TestPassword2026!',
        );

        const user = {
            id: '550e8400-e29b-41d4-a716-446655440000',
            firstName: 'Test',
            lastName: 'Customer',
            email: 'test@example.com',
            passwordHash,
            role: UserRole.CUSTOMER,
            status: AccountStatus.ACTIVE,
        } as User;

        const findByEmailForAuth = vi.fn()
            .mockResolvedValue(user);

        const signAsync = vi.fn()
            .mockResolvedValue('test-access-token');

        const service = new AuthService(
            {
                findByEmailForAuth,
            } as unknown as UsersService,
            {
                signAsync,
            } as unknown as JwtService,
            inboxStub(),
        );

        const result = await service.login({
            email: 'test@example.com',
            password: 'TestPassword2026!',
        });

        // Verify JWT & refresh token generation
        expect(result.accessToken).toBe(
            'test-access-token',
        );
        expect(typeof result.refreshToken).toBe('string');
        expect(result.refreshToken.length).toBeGreaterThanOrEqual(32);
        expect(result.expiresIn).toBe(900);

        expect(result.tokenType).toBe(
            'Bearer',
        );

        // Verify user role
        expect(result.user.role).toBe(
            UserRole.CUSTOMER,
        );

        // Verify JWT payload
        expect(signAsync).toHaveBeenCalledWith({
            sub: user.id,
            role: UserRole.CUSTOMER,
        });

        // Verify that sensitive data is not returned
        expect(result).not.toHaveProperty(
            'password',
        );

        expect(result).not.toHaveProperty(
            'passwordHash',
        );
    });

    // ==========================================
    // TEST 4: INCORRECT PASSWORD
    // ==========================================

    it('should reject an incorrect password', async () => {
        const passwordHash = await argon2.hash(
            'CorrectPassword2026!',
        );

        const user = {
            id: '550e8400-e29b-41d4-a716-446655440000',
            email: 'test@example.com',
            passwordHash,
            role: UserRole.CUSTOMER,
            status: AccountStatus.ACTIVE,
        } as User;

        const signAsync = vi.fn();

        const service = new AuthService(
            {
                findByEmailForAuth: vi.fn()
                    .mockResolvedValue(user),
            } as unknown as UsersService,
            {
                signAsync,
            } as unknown as JwtService,
            inboxStub(),
        );

        await expect(
            service.login({
                email: 'test@example.com',
                password: 'WrongPassword123!',
            }),
        ).rejects.toBeInstanceOf(
            UnauthorizedException,
        );

        // JWT must not be generated
        expect(signAsync).not.toHaveBeenCalled();
    });

    // ==========================================
    // TEST 5: UNKNOWN EMAIL
    // ==========================================

    it('should reject an unknown email', async () => {
        const signAsync = vi.fn();

        const service = new AuthService(
            {
                findByEmailForAuth: vi.fn()
                    .mockResolvedValue(null),
            } as unknown as UsersService,
            {
                signAsync,
            } as unknown as JwtService,
            inboxStub(),
        );

        await expect(
            service.login({
                email: 'unknown@example.com',
                password: 'TestPassword2026!',
            }),
        ).rejects.toBeInstanceOf(
            UnauthorizedException,
        );

        // JWT must not be generated
        expect(signAsync).not.toHaveBeenCalled();
    });

    // ==========================================
    // TEST 6: SUSPENDED ACCOUNT
    // ==========================================

    it('should reject a suspended account', async () => {
        const passwordHash = await argon2.hash(
            'TestPassword2026!',
        );

        const user = {
            id: '550e8400-e29b-41d4-a716-446655440000',
            email: 'test@example.com',
            passwordHash,
            role: UserRole.CUSTOMER,
            status: AccountStatus.SUSPENDED,
        } as User;

        const signAsync = vi.fn();

        const service = new AuthService(
            {
                findByEmailForAuth: vi.fn()
                    .mockResolvedValue(user),
            } as unknown as UsersService,
            {
                signAsync,
            } as unknown as JwtService,
            inboxStub(),
        );

        await expect(
            service.login({
                email: 'test@example.com',
                password: 'TestPassword2026!',
            }),
        ).rejects.toBeInstanceOf(
            UnauthorizedException,
        );

        // JWT must not be generated
        expect(signAsync).not.toHaveBeenCalled();
    });

    // ==========================================
    // TEST 7: LICENCE REMINDER ON LOGIN
    // ==========================================

    it('should request a licence reminder when a customer logs in', async () => {
        const passwordHash = await argon2.hash(
            'TestPassword2026!',
        );

        const user = {
            id: '550e8400-e29b-41d4-a716-446655440000',
            email: 'test@example.com',
            passwordHash,
            role: UserRole.CUSTOMER,
            status: AccountStatus.ACTIVE,
        } as User;

        const safelyLicenseRequired = vi
            .fn()
            .mockResolvedValue(undefined);

        const service = new AuthService(
            {
                findByEmailForAuth: vi
                    .fn()
                    .mockResolvedValue(user),
            } as unknown as UsersService,
            {
                signAsync: vi
                    .fn()
                    .mockResolvedValue('test-access-token'),
            } as unknown as JwtService,
            {
                safelyLicenseRequired,
            } as unknown as InboxService,
        );

        await service.login({
            email: 'test@example.com',
            password: 'TestPassword2026!',
        });

        expect(safelyLicenseRequired).toHaveBeenCalledOnce();
        expect(safelyLicenseRequired).toHaveBeenCalledWith(
            user.id,
        );
    });

    it('should not request a licence reminder for an administrator', async () => {
        const passwordHash = await argon2.hash(
            'AdminPass123!',
        );

        const admin = {
            id: '660e8400-e29b-41d4-a716-446655440001',
            email: 'admin@luxury.test',
            passwordHash,
            role: UserRole.ADMIN,
            status: AccountStatus.ACTIVE,
        } as User;

        const safelyLicenseRequired = vi
            .fn()
            .mockResolvedValue(undefined);

        const service = new AuthService(
            {
                findByEmailForAuth: vi
                    .fn()
                    .mockResolvedValue(admin),
            } as unknown as UsersService,
            {
                signAsync: vi
                    .fn()
                    .mockResolvedValue('test-access-token'),
            } as unknown as JwtService,
            {
                safelyLicenseRequired,
            } as unknown as InboxService,
        );

        await service.login({
            email: 'admin@luxury.test',
            password: 'AdminPass123!',
        });

        expect(safelyLicenseRequired).not.toHaveBeenCalled();
    });

    // ==========================================
    // TEST 8: REFRESH TOKEN ROTATION & REUSE DETECTION
    // ==========================================

    it('rotates refresh tokens and revokes all user sessions on token reuse', async () => {
        expect(normalizeInetAddress('192.168.1.10:54321')).toBe('192.168.1.10');
        expect(normalizeInetAddress('::1')).toBe('::1');
        expect(normalizeInetAddress('not-an-ip')).toBeNull();

        const rawRefresh = 'initial-refresh-token-value-that-is-long-enough';
        const hashedRefresh = hashAuthToken(rawRefresh);
        let revokedAt: Date | null = null;
        let revokedAllForUser = false;

        const query = vi.fn(async (sql: string, params: unknown[] = []) => {
            if (sql.includes('FROM refresh_tokens rt')) {
                if (params[0] === hashedRefresh) {
                    return [
                        {
                            tokenId: 'rt-1',
                            userId: 'user-1',
                            expiresAt: new Date(Date.now() + 86_400_000),
                            revokedAt,
                            firstName: 'Ada',
                            lastName: 'Lovelace',
                            email: 'ada@luxuar.hu',
                            role: UserRole.CUSTOMER,
                            status: AccountStatus.ACTIVE,
                        },
                    ];
                }
                return [];
            }
            if (
                sql.includes('UPDATE refresh_tokens') &&
                sql.includes('WHERE id = $1::uuid')
            ) {
                revokedAt = new Date();
                return [];
            }
            if (
                sql.includes('UPDATE refresh_tokens') &&
                sql.includes('WHERE user_id = $1::uuid')
            ) {
                revokedAllForUser = true;
                return [];
            }
            return [];
        });

        const dataSource = {
            query,
            transaction: vi.fn(async (cb: (m: { query: typeof query }) => unknown) =>
                cb({ query }),
            ),
        } as unknown as DataSource;

        const service = new AuthService(
            {} as unknown as UsersService,
            {
                signAsync: vi.fn().mockResolvedValue('rotated-access-token'),
            } as unknown as JwtService,
            inboxStub(),
            dataSource,
        );

        const rotated = await service.refreshTokens({
            refreshToken: rawRefresh,
        });
        expect(rotated.accessToken).toBe('rotated-access-token');
        expect(rotated.refreshToken).not.toBe(rawRefresh);
        expect(revokedAt).not.toBeNull();

        // Presenting the already-rotated token a second time triggers reuse detection
        await expect(
            service.refreshTokens({ refreshToken: rawRefresh }),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        expect(revokedAllForUser).toBe(true);
    });

    // ==========================================
    // TEST 9: EMAIL VERIFICATION & PASSWORD RESET
    // ==========================================

    it('issues and confirms one-time tokens for email verification and password reset', async () => {
        const storedTokens: {
            id: string;
            userId: string;
            type: string;
            tokenHash: string;
            expiresAt: Date;
            usedAt: Date | null;
        }[] = [];
        let updatedPasswordHash: string | null = null;
        let revokedRefreshTokens = false;
        let verifiedEmailAt: Date | null = null;

        const query = vi.fn(async (sql: string, params: unknown[] = []) => {
            if (sql.includes('INSERT INTO one_time_tokens')) {
                const entry = {
                    id: `ott-${storedTokens.length + 1}`,
                    userId: String(params[0]),
                    type: String(params[1]),
                    tokenHash: String(params[2]),
                    expiresAt: new Date(Date.now() + 3600_000),
                    usedAt: null,
                };
                storedTokens.push(entry);
                return [{ id: entry.id, expiresAt: entry.expiresAt }];
            }
            if (sql.includes('FROM one_time_tokens ott')) {
                const match = storedTokens.find(
                    (t) => t.tokenHash === params[0],
                );
                if (!match) return [];
                return [
                    {
                        tokenId: match.id,
                        userId: match.userId,
                        expiresAt: match.expiresAt,
                        usedAt: match.usedAt,
                        status: AccountStatus.ACTIVE,
                        userEmailVerifiedAt: verifiedEmailAt,
                    },
                ];
            }
            if (sql.includes('UPDATE one_time_tokens')) {
                for (const t of storedTokens) {
                    if (t.userId === params[0]) t.usedAt = new Date();
                }
                return [];
            }
            if (sql.includes('SET email_verified_at')) {
                verifiedEmailAt = new Date();
                return [{ emailVerifiedAt: verifiedEmailAt }];
            }
            if (sql.includes('SET password_hash = $2')) {
                updatedPasswordHash = String(params[1]);
                return [];
            }
            if (sql.includes('UPDATE refresh_tokens')) {
                revokedRefreshTokens = true;
                return [];
            }
            return [];
        });

        const dataSource = {
            query,
            transaction: vi.fn(async (cb: (m: { query: typeof query }) => unknown) =>
                cb({ query }),
            ),
        } as unknown as DataSource;

        let capturedVerificationToken = '';
        let capturedResetToken = '';
        const emailOutbox = {
            safelyNotifyEmailVerification: vi.fn(
                async (payload: { token: string }) => {
                    capturedVerificationToken = payload.token;
                },
            ),
            safelyNotifyPasswordReset: vi.fn(
                async (payload: { token: string }) => {
                    capturedResetToken = payload.token;
                },
            ),
        } as unknown as EmailOutboxService;

        const user = {
            id: 'user-1',
            firstName: 'Ada',
            lastName: 'Lovelace',
            email: 'ada@luxuar.hu',
            role: UserRole.CUSTOMER,
            status: AccountStatus.ACTIVE,
            emailVerifiedAt: null,
        } as User;

        const service = new AuthService(
            {
                findByEmail: vi.fn().mockImplementation(async () =>
                    Object.assign({}, user, {
                        emailVerifiedAt: verifiedEmailAt,
                    }),
                ),
            } as unknown as UsersService,
            { signAsync: vi.fn() } as unknown as JwtService,
            inboxStub(),
            dataSource,
            emailOutbox,
        );

        await service.requestEmailVerification({ email: 'ada@luxuar.hu' });
        expect(capturedVerificationToken.length).toBeGreaterThanOrEqual(32);

        const verifyOut = await service.confirmEmailVerification({
            token: capturedVerificationToken,
        });
        expect(verifyOut.verified).toBe(true);
        expect(verifiedEmailAt).not.toBeNull();

        // When the account is already verified, submitting the token again detects already-verified account and shows success
        const secondVerify = await service.confirmEmailVerification({
            token: capturedVerificationToken,
        });
        expect(secondVerify.verified).toBe(true);
        expect(secondVerify.alreadyVerified).toBe(true);

        // Invalid token for unverified account must fail
        await expect(
            service.confirmEmailVerification({
                token: 'unrecognized-invalid-token-value-1234567890',
            }),
        ).rejects.toBeInstanceOf(BadRequestException);

        // Request and confirm password reset
        await service.requestPasswordReset({ email: 'ada@luxuar.hu' });
        expect(capturedResetToken.length).toBeGreaterThanOrEqual(32);

        const resetOut = await service.confirmPasswordReset({
            token: capturedResetToken,
            newPassword: 'BrandNewSecurePassword2026!',
        });
        expect(resetOut.reset).toBe(true);
        expect(revokedRefreshTokens).toBe(true);
        expect(
            await argon2.verify(
                updatedPasswordHash!,
                'BrandNewSecurePassword2026!',
            ),
        ).toBe(true);
    });

    // ==========================================
    // TEST 10: EMAIL VERIFICATION RESEND & MINIMUM 5-MIN VALIDITY
    // ==========================================

    it('preserves email verification validity for at least 5 minutes on resend', async () => {
        const storedTokens: {
            id: string;
            userId: string;
            type: string;
            tokenHash: string;
            expiresAt: Date;
            createdAt: Date;
            usedAt: Date | null;
        }[] = [];
        let verifiedEmailAt: Date | null = null;
        const capturedTokens: string[] = [];

        const query = vi.fn(async (sql: string, params: unknown[] = []) => {
            if (sql.includes('INSERT INTO one_time_tokens')) {
                const ttl = Number(params[3]);
                expect(ttl).toBeGreaterThanOrEqual(300); // Must be at least 5 minutes
                const entry = {
                    id: `ott-${storedTokens.length + 1}`,
                    userId: String(params[0]),
                    type: String(params[1]),
                    tokenHash: String(params[2]),
                    expiresAt: new Date(Date.now() + ttl * 1000),
                    createdAt: new Date(),
                    usedAt: null,
                };
                storedTokens.push(entry);
                return [{ id: entry.id, expiresAt: entry.expiresAt }];
            }
            if (sql.includes('FROM one_time_tokens ott')) {
                const match = storedTokens.find(
                    (t) => t.tokenHash === params[0],
                );
                if (!match) return [];
                return [
                    {
                        tokenId: match.id,
                        userId: match.userId,
                        expiresAt: match.expiresAt,
                        createdAt: match.createdAt,
                        usedAt: match.usedAt,
                        status: AccountStatus.ACTIVE,
                        userEmailVerifiedAt: verifiedEmailAt,
                        dbNow: new Date(),
                    },
                ];
            }
            if (sql.includes('UPDATE one_time_tokens')) {
                // When confirming, mark all unused tokens as used
                if (!sql.includes("interval '5 minutes'")) {
                    for (const t of storedTokens) {
                        if (t.userId === params[0]) t.usedAt = new Date();
                    }
                } else {
                    // On resend, only invalidate tokens older than 5 minutes
                    const fiveMinutesAgo = Date.now() - 300 * 1000;
                    for (const t of storedTokens) {
                        if (
                            t.userId === params[0] &&
                            t.type === 'email_verification' &&
                            t.usedAt === null &&
                            (t.createdAt.getTime() < fiveMinutesAgo || t.expiresAt.getTime() <= Date.now())
                        ) {
                            t.usedAt = new Date();
                        }
                    }
                }
                return [];
            }
            if (sql.includes('SET email_verified_at')) {
                verifiedEmailAt = new Date();
                return [{ emailVerifiedAt: verifiedEmailAt }];
            }
            return [];
        });

        const dataSource = {
            query,
            transaction: vi.fn(async (cb: (m: { query: typeof query }) => unknown) =>
                cb({ query }),
            ),
        } as unknown as DataSource;

        const emailOutbox = {
            safelyNotifyEmailVerification: vi.fn(
                async (payload: { token: string }) => {
                    capturedTokens.push(payload.token);
                },
            ),
        } as unknown as EmailOutboxService;

        const user = {
            id: 'user-2',
            firstName: 'Charles',
            lastName: 'Babbage',
            email: 'charles@luxuar.hu',
            role: UserRole.CUSTOMER,
            status: AccountStatus.ACTIVE,
            emailVerifiedAt: null,
        } as User;

        const configService = {
            get: vi.fn((key: string) => {
                if (key === 'EMAIL_VERIFICATION_EXPIRES_IN_SECONDS') return 60; // Deliberately configure low (1 min)
                return undefined;
            }),
        };

        const service = new AuthService(
            {
                findByEmail: vi.fn().mockImplementation(async () =>
                    Object.assign({}, user, {
                        emailVerifiedAt: verifiedEmailAt,
                    }),
                ),
            } as unknown as UsersService,
            { signAsync: vi.fn() } as unknown as JwtService,
            inboxStub(),
            dataSource,
            emailOutbox,
            configService as any,
        );

        // 1. Initial verification request
        await service.requestEmailVerification({ email: 'charles@luxuar.hu' });
        expect(capturedTokens).toHaveLength(1);
        const firstToken = capturedTokens[0];

        // 2. Resend 30 seconds later: first token must NOT be invalidated
        await service.requestEmailVerification({ email: 'charles@luxuar.hu' });
        expect(capturedTokens).toHaveLength(2);
        const secondToken = capturedTokens[1];

        // Verify that the first token is still active (usedAt is null)
        expect(storedTokens[0].usedAt).toBeNull();
        expect(storedTokens[1].usedAt).toBeNull();

        // 3. Confirm with the FIRST token: must succeed within its 5-minute validity window!
        const result = await service.confirmEmailVerification({ token: firstToken });
        expect(result.verified).toBe(true);
        expect(verifiedEmailAt).not.toBeNull();

        // 4. Once confirmed, all tokens for the user are now consumed
        expect(storedTokens[0].usedAt).not.toBeNull();
        expect(storedTokens[1].usedAt).not.toBeNull();

        // 5. Subsequent attempts to verify this account detect already-verified account and show success instead of expired error
        const duplicateConfirm1 = await service.confirmEmailVerification({ token: firstToken });
        expect(duplicateConfirm1.verified).toBe(true);
        expect(duplicateConfirm1.alreadyVerified).toBe(true);

        const duplicateConfirm2 = await service.confirmEmailVerification({ token: secondToken });
        expect(duplicateConfirm2.verified).toBe(true);
        expect(duplicateConfirm2.alreadyVerified).toBe(true);

        // 6. Resend request for an already-verified account informs the user and does not dispatch another email
        const resendAfterVerified = await service.requestEmailVerification({ email: 'charles@luxuar.hu' });
        expect(resendAfterVerified.alreadyVerified).toBe(true);
        expect(capturedTokens).toHaveLength(2); // no new email sent!
    });
});
