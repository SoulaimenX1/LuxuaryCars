import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { MfaService } from './mfa.service.js';
import { MfaGuard } from '../guards/mfa.guard.js';
import { JwtAuthGuard } from '../guards/jwt-auth.guard.js';
import { RolesGuard } from '../guards/roles.guard.js';
import { AccountStatus, UserRole, type User } from '../../users/entities/user.entity.js';

describe('MFA & Assurance Foundation Unit Tests', () => {
    let mfaService: MfaService;
    let jwtService: JwtService;
    let usersService: any;
    let dataSource: any;

    const mockAdminUser: User = {
        id: '11111111-1111-1111-1111-111111111111',
        email: 'admin@luxuar.demo',
        firstName: 'System',
        lastName: 'Admin',
        role: UserRole.ADMIN,
        status: AccountStatus.ACTIVE,
        passwordHash: 'hash',
        phone: null,
        lastLoginAt: null,
        emailVerifiedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
    };

    beforeEach(() => {
        jwtService = new JwtService({ secret: 'test-secret' });
        usersService = {
            findById: vi.fn().mockImplementation(async (id: string) => {
                if (id === mockAdminUser.id) return mockAdminUser;
                return null;
            }),
        };
        dataSource = {
            isInitialized: false,
            query: vi.fn(),
        };

        mfaService = new MfaService(jwtService, usersService, dataSource);
    });

    describe('1. Pre-Auth Tokens & Claims', () => {
        it('should issue a 5-minute restricted pre-auth token with mfa_pending scope', async () => {
            const { preAuthToken, expiresIn } = await mfaService.generatePreAuthToken(mockAdminUser);
            expect(expiresIn).toBe(300);

            const decoded: any = await jwtService.verifyAsync(preAuthToken);
            expect(decoded.sub).toBe(mockAdminUser.id);
            expect(decoded.scope).toBe('mfa_pending');
            expect(decoded.pre_auth).toBe(true);
            expect(decoded.mfa_verified).toBe(false);
            expect(decoded.amr).toEqual(['pwd']);
        });

        it('should reject pre-auth tokens in JwtAuthGuard on normal protected endpoints', async () => {
            const { preAuthToken } = await mfaService.generatePreAuthToken(mockAdminUser);
            const guard = new JwtAuthGuard(jwtService, usersService);

            const mockContext = {
                switchToHttp: () => ({
                    getRequest: () => ({
                        headers: { authorization: `Bearer ${preAuthToken}` },
                    }),
                }),
            } as unknown as ExecutionContext;

            await expect(guard.canActivate(mockContext)).rejects.toThrow(UnauthorizedException);
            await expect(guard.canActivate(mockContext)).rejects.toThrow(/pre-auth tokens cannot access protected endpoints/);
        });
    });

    describe('2. Privileged Access & MfaGuard', () => {
        it('should permit access when MFA enforcement is disabled (feature flag false)', () => {
            delete process.env.ENABLE_MANDATORY_ADMIN_MFA;
            const reflector = { getAllAndOverride: vi.fn().mockReturnValue(false) } as any;
            const guard = new MfaGuard(reflector);

            const mockContext = {
                getHandler: () => {},
                getClass: () => {},
                switchToHttp: () => ({
                    getRequest: () => ({
                        user: { id: mockAdminUser.id, role: UserRole.ADMIN, mfaVerified: false },
                    }),
                }),
            } as unknown as ExecutionContext;

            expect(guard.canActivate(mockContext)).toBe(true);
        });

        it('should reject password-only admin when mandatory MFA is active', () => {
            process.env.ENABLE_MANDATORY_ADMIN_MFA = 'true';
            const reflector = { getAllAndOverride: vi.fn().mockReturnValue(false) } as any;
            const guard = new MfaGuard(reflector);

            const mockContext = {
                getHandler: () => {},
                getClass: () => {},
                switchToHttp: () => ({
                    getRequest: () => ({
                        user: { id: mockAdminUser.id, role: UserRole.ADMIN, mfaVerified: false },
                    }),
                }),
            } as unknown as ExecutionContext;

            expect(() => guard.canActivate(mockContext)).toThrow(ForbiddenException);
        });

        it('should allow access to admin with verified MFA', () => {
            process.env.ENABLE_MANDATORY_ADMIN_MFA = 'true';
            const reflector = { getAllAndOverride: vi.fn().mockReturnValue(false) } as any;
            const guard = new MfaGuard(reflector);

            const mockContext = {
                getHandler: () => {},
                getClass: () => {},
                switchToHttp: () => ({
                    getRequest: () => ({
                        user: { id: mockAdminUser.id, role: UserRole.ADMIN, mfaVerified: true },
                    }),
                }),
            } as unknown as ExecutionContext;

            expect(guard.canActivate(mockContext)).toBe(true);
            delete process.env.ENABLE_MANDATORY_ADMIN_MFA;
        });

        it('should enforce MFA check in RolesGuard for Admin when flag is active', () => {
            process.env.ENABLE_MANDATORY_ADMIN_MFA = 'true';
            const reflector = { getAllAndOverride: vi.fn().mockReturnValue([UserRole.ADMIN]) } as any;
            const rolesGuard = new RolesGuard(reflector);

            const mockContext = {
                getHandler: () => {},
                getClass: () => {},
                switchToHttp: () => ({
                    getRequest: () => ({
                        user: { id: mockAdminUser.id, role: UserRole.ADMIN, mfaVerified: false },
                    }),
                }),
            } as unknown as ExecutionContext;

            expect(() => rolesGuard.canActivate(mockContext)).toThrow(ForbiddenException);
            delete process.env.ENABLE_MANDATORY_ADMIN_MFA;
        });
    });

    describe('3. Single-Use Recovery Codes & Rate Limiting', () => {
        it('should generate 10 formatted recovery codes', async () => {
            const codes = await mfaService.generateRecoveryCodes(mockAdminUser.id);
            expect(codes).toHaveLength(10);
            for (const c of codes) {
                expect(c).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
            }
        });

        it('should verify a valid recovery code and mark it as used', async () => {
            const codes = await mfaService.generateRecoveryCodes(mockAdminUser.id);
            const { preAuthToken } = await mfaService.generatePreAuthToken(mockAdminUser);

            const result = await mfaService.verifyRecoveryCode(preAuthToken, codes[0]);
            expect(result.accessToken).toBeDefined();

            const decoded: any = await jwtService.verifyAsync(result.accessToken);
            expect(decoded.mfa_verified).toBe(true);
            expect(decoded.amr).toEqual(['pwd', 'recovery_code']);

            // Replay protection: same code cannot be used twice
            const { preAuthToken: preAuthToken2 } = await mfaService.generatePreAuthToken(mockAdminUser);
            await expect(mfaService.verifyRecoveryCode(preAuthToken2, codes[0])).rejects.toThrow(UnauthorizedException);
        });

        it('should rate limit and lock out after 3 failed attempts', async () => {
            const { preAuthToken } = await mfaService.generatePreAuthToken(mockAdminUser);

            // Attempt 1: fail
            await expect(mfaService.verifyRecoveryCode(preAuthToken, '0000-0000')).rejects.toThrow(UnauthorizedException);
            // Attempt 2: fail
            await expect(mfaService.verifyRecoveryCode(preAuthToken, '0000-0001')).rejects.toThrow(UnauthorizedException);
            // Attempt 3: fail & lock
            await expect(mfaService.verifyRecoveryCode(preAuthToken, '0000-0002')).rejects.toThrow(UnauthorizedException);

            // Attempt 4: locked out with 429
            await expect(mfaService.verifyRecoveryCode(preAuthToken, '0000-0003')).rejects.toThrow(/Too many failed MFA attempts/);
        });
    });
});
