import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { MfaService } from './mfa.service.js';
import { JwtAuthGuard } from '../guards/jwt-auth.guard.js';
import { RolesGuard } from '../guards/roles.guard.js';
import { AuthService } from '../auth.service.js';
import { AccountStatus, UserRole, type User } from '../../users/entities/user.entity.js';
import * as argon2 from 'argon2';

describe('LUXURYCARS — Comprehensive MFA Readiness Validation', () => {
    let mfaService: MfaService;
    let authService: AuthService;
    let jwtService: JwtService;
    let usersService: any;
    let dataSource: any;

    const mockAdmin: User = {
        id: '22222222-2222-2222-2222-222222222222',
        email: 'admin@luxuar.demo',
        firstName: 'System',
        lastName: 'Admin',
        role: UserRole.ADMIN,
        status: AccountStatus.ACTIVE,
        passwordHash: '',
        phone: null,
        lastLoginAt: null,
        emailVerifiedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
    };

    const mockCustomer: User = {
        id: '33333333-3333-3333-3333-333333333333',
        email: 'customer@luxuar.demo',
        firstName: 'System',
        lastName: 'Admin',
        role: UserRole.CUSTOMER,
        status: AccountStatus.ACTIVE,
        passwordHash: '',
        phone: null,
        lastLoginAt: null,
        emailVerifiedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
    };

    beforeEach(async () => {
        mockAdmin.passwordHash = await argon2.hash('Password123!');
        mockCustomer.passwordHash = await argon2.hash('Password123!');

        jwtService = new JwtService({ secret: 'super-secret-mfa-key' });
        usersService = {
            findById: vi.fn().mockImplementation(async (id: string) => {
                if (id === mockAdmin.id) return mockAdmin;
                if (id === mockCustomer.id) return mockCustomer;
                return null;
            }),
            findByEmailForAuth: vi.fn().mockImplementation(async (email: string) => {
                if (email === mockAdmin.email) return mockAdmin;
                if (email === mockCustomer.email) return mockCustomer;
                return null;
            }),
        };

        dataSource = {
            isInitialized: false,
            query: vi.fn(),
            transaction: vi.fn(),
        };

        const inboxService = {
            safelyLicenseRequired: vi.fn().mockResolvedValue(undefined),
        } as any;

        const configService = {
            get: vi.fn().mockReturnValue(900),
            getOrThrow: vi.fn().mockReturnValue('super-secret-mfa-key'),
        } as any;

        mfaService = new MfaService(jwtService, usersService, dataSource);
        authService = new AuthService(
            usersService,
            jwtService,
            inboxService,
            dataSource,
            undefined,
            configService,
        );
    });

    describe('1. Pre-Auth & Flow: Password -> Pre-Auth -> MFA Session', () => {
        it('should issue pre-auth token on password login for Admin when MFA is enabled', async () => {
            process.env.ENABLE_MANDATORY_ADMIN_MFA = 'true';

            const res: any = await authService.login({
                email: mockAdmin.email,
                password: 'Password123!',
            });

            expect(res.mfaRequired).toBe(true);
            expect(res.preAuthToken).toBeDefined();
            expect(res.accessToken).toBeUndefined(); // No access token granted yet!

            // Verify pre-auth token properties
            const decoded: any = await jwtService.verifyAsync(res.preAuthToken);
            expect(decoded.sub).toBe(mockAdmin.id);
            expect(decoded.scope).toBe('mfa_pending');
            expect(decoded.pre_auth).toBe(true);

            delete process.env.ENABLE_MANDATORY_ADMIN_MFA;
        });

        it('should strictly reject pre-auth token on any normal protected endpoint', async () => {
            const { preAuthToken } = await mfaService.generatePreAuthToken(mockAdmin);
            const guard = new JwtAuthGuard(jwtService, usersService);

            const ctx = {
                switchToHttp: () => ({
                    getRequest: () => ({ headers: { authorization: `Bearer ${preAuthToken}` } }),
                }),
            } as unknown as ExecutionContext;

            await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
            await expect(guard.canActivate(ctx)).rejects.toThrow(/pre-auth tokens cannot access protected endpoints/);
        });

        it('should reject password-only token from Admin endpoints when MFA is enforced', () => {
            process.env.ENABLE_MANDATORY_ADMIN_MFA = 'true';
            const reflector = { getAllAndOverride: vi.fn().mockReturnValue([UserRole.ADMIN]) } as any;
            const rolesGuard = new RolesGuard(reflector);

            const ctx = {
                getHandler: () => {},
                getClass: () => {},
                switchToHttp: () => ({
                    getRequest: () => ({
                        user: { id: mockAdmin.id, role: UserRole.ADMIN, mfaVerified: false },
                    }),
                }),
            } as unknown as ExecutionContext;

            expect(() => rolesGuard.canActivate(ctx)).toThrow(ForbiddenException);
            delete process.env.ENABLE_MANDATORY_ADMIN_MFA;
        });
    });

    describe('2. Direct Passkey Login Assurance & Privileged Access', () => {
        it('should grant full access token with mfa_verified=true on passkey session elevation', async () => {
            const elevated = await mfaService.issueFullTokens(mockAdmin, ['webauthn']);
            expect(elevated.accessToken).toBeDefined();

            const decoded: any = await jwtService.verifyAsync(elevated.accessToken);
            expect(decoded.mfa_verified).toBe(true);
            expect(decoded.amr).toEqual(['webauthn']);

            // Verify it passes RolesGuard & MfaGuard
            process.env.ENABLE_MANDATORY_ADMIN_MFA = 'true';
            const reflector = { getAllAndOverride: vi.fn().mockReturnValue([UserRole.ADMIN]) } as any;
            const rolesGuard = new RolesGuard(reflector);

            const ctx = {
                getHandler: () => {},
                getClass: () => {},
                switchToHttp: () => ({
                    getRequest: () => ({
                        user: { id: mockAdmin.id, role: UserRole.ADMIN, mfaVerified: decoded.mfa_verified },
                    }),
                }),
            } as unknown as ExecutionContext;

            expect(rolesGuard.canActivate(ctx)).toBe(true);
            delete process.env.ENABLE_MANDATORY_ADMIN_MFA;
        });
    });

    describe('3. Recovery Codes: Generation, Verification, Replay & Lockout', () => {
        it('should generate 10 single-use codes and permit elevation once', async () => {
            const codes = await mfaService.generateRecoveryCodes(mockAdmin.id);
            expect(codes).toHaveLength(10);

            const { preAuthToken } = await mfaService.generatePreAuthToken(mockAdmin);
            const elevated = await mfaService.verifyRecoveryCode(preAuthToken, codes[0]);

            const decoded: any = await jwtService.verifyAsync(elevated.accessToken);
            expect(decoded.mfa_verified).toBe(true);
            expect(decoded.amr).toEqual(['pwd', 'recovery_code']);

            // Replay rejection
            const { preAuthToken: preAuthToken2 } = await mfaService.generatePreAuthToken(mockAdmin);
            await expect(mfaService.verifyRecoveryCode(preAuthToken2, codes[0])).rejects.toThrow(UnauthorizedException);
        });

        it('should lockout brute force attacks after 3 invalid attempts', async () => {
            const { preAuthToken } = await mfaService.generatePreAuthToken(mockAdmin);

            for (let i = 0; i < 3; i++) {
                await expect(mfaService.verifyRecoveryCode(preAuthToken, `FAIL-000${i}`)).rejects.toThrow();
            }

            // 4th attempt is locked out with 429
            await expect(mfaService.verifyRecoveryCode(preAuthToken, 'FAIL-0004')).rejects.toThrow(
                /Too many failed MFA attempts/,
            );
        });
    });

    describe('4. Existing Customer Login Unchanged', () => {
        it('should allow customer login directly without MFA required, even if flag is on', async () => {
            process.env.ENABLE_MANDATORY_ADMIN_MFA = 'true';

            const res: any = await authService.login({
                email: mockCustomer.email,
                password: 'Password123!',
            });

            expect(res.mfaRequired).toBeUndefined();
            expect(res.accessToken).toBeDefined();
            expect(res.user.role).toBe(UserRole.CUSTOMER);

            delete process.env.ENABLE_MANDATORY_ADMIN_MFA;
        });
    });
});
