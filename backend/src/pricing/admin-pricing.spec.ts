import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, UnauthorizedException, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { AdminPricingController } from './admin-pricing.controller.js';
import { DynamicPricingService } from './dynamic-pricing.service.js';
import { MfaGuard } from '../auth/guards/mfa.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { UserRole } from '../users/entities/user.entity.js';

describe('Admin Dynamic Pricing Control & Security', () => {
    let mockDataSource: { query: ReturnType<typeof vi.fn> };
    let mockConfigService: { get: ReturnType<typeof vi.fn> };
    let dynamicPricingService: DynamicPricingService;
    let controller: AdminPricingController;
    let mfaGuard: MfaGuard;
    let rolesGuard: RolesGuard;
    let reflector: Reflector;

    beforeEach(() => {
        mockDataSource = {
            query: vi.fn(),
        };
        mockConfigService = {
            get: vi.fn().mockReturnValue(false),
        };

        dynamicPricingService = new DynamicPricingService(
            mockConfigService as unknown as ConfigService,
            mockDataSource as unknown as DataSource,
        );

        controller = new AdminPricingController(dynamicPricingService);
        reflector = new Reflector();
        mfaGuard = new MfaGuard(reflector);
        rolesGuard = new RolesGuard(reflector);
    });

    describe('1. RBAC & Mandatory MFA Guard Enforcement', () => {
        function createMockContext(user?: { role?: string; mfaVerified?: boolean }) {
            return {
                switchToHttp: () => ({
                    getRequest: () => ({ user }),
                }),
                getHandler: () => AdminPricingController.prototype.toggle,
                getClass: () => AdminPricingController,
            } as unknown as ExecutionContext;
        }

        it('rejects unauthenticated requests in MfaGuard', () => {
            const context = createMockContext(undefined);
            expect(() => mfaGuard.canActivate(context)).toThrow(UnauthorizedException);
        });

        it('rejects non-admin roles (e.g. CUSTOMER) in RolesGuard', () => {
            const context = createMockContext({ role: UserRole.CUSTOMER, mfaVerified: true });
            expect(() => rolesGuard.canActivate(context)).toThrow(ForbiddenException);
        });

        it('rejects Admin when MFA assurance is missing (mfaVerified: false)', () => {
            const context = createMockContext({ role: UserRole.ADMIN, mfaVerified: false });
            expect(() => mfaGuard.canActivate(context)).toThrow(ForbiddenException);
        });

        it('permits Admin when MFA is fully verified (mfaVerified: true)', () => {
            const context = createMockContext({ role: UserRole.ADMIN, mfaVerified: true });
            expect(rolesGuard.canActivate(context)).toBe(true);
            expect(mfaGuard.canActivate(context)).toBe(true);
        });
    });

    describe('2. Input Validation & Toggling', () => {
        it('rejects non-boolean toggle payload with BadRequestException', async () => {
            await expect(
                controller.toggle({ enabled: 'true' as any }, { user: { id: 'admin-1' } }),
            ).rejects.toThrow(BadRequestException);

            await expect(
                controller.toggle({ enabled: null as any }, { user: { id: 'admin-1' } }),
            ).rejects.toThrow(BadRequestException);

            await expect(
                controller.toggle({ enabled: 1 as any }, { user: { id: 'admin-1' } }),
            ).rejects.toThrow(BadRequestException);
        });

        it('activates dynamic pricing and updates runtime state immediately', async () => {
            mockDataSource.query.mockResolvedValue([]);

            const result = await controller.toggle(
                { enabled: true },
                { user: { id: 'admin-uuid-1' } },
            );

            expect(result.success).toBe(true);
            expect(result.enabled).toBe(true);
            expect(dynamicPricingService.isEnabled()).toBe(true);
        });

        it('deactivates dynamic pricing and updates runtime state immediately', async () => {
            mockDataSource.query.mockResolvedValue([]);

            // First enable
            await controller.toggle({ enabled: true }, { user: { id: 'admin-uuid-1' } });
            expect(dynamicPricingService.isEnabled()).toBe(true);

            // Then disable
            const result = await controller.toggle(
                { enabled: false },
                { user: { id: 'admin-uuid-1' } },
            );

            expect(result.success).toBe(true);
            expect(result.enabled).toBe(false);
            expect(dynamicPricingService.isEnabled()).toBe(false);
        });
    });

    describe('3. Database Persistence across Restarts', () => {
        it('persists dynamic_pricing_enabled in platform_settings and records audit log', async () => {
            mockDataSource.query.mockResolvedValue([]);

            await dynamicPricingService.setEnabled(true, 'admin-uuid-1');

            const upsertCall = mockDataSource.query.mock.calls.find((call) =>
                String(call[0]).includes('INSERT INTO platform_settings'),
            );
            expect(upsertCall).toBeDefined();
            expect(upsertCall[1]).toContain('true');
            expect(upsertCall[1]).toContain('admin-uuid-1');

            const auditCall = mockDataSource.query.mock.calls.find((call) =>
                String(call[0]).includes('DYNAMIC_PRICING_TOGGLED'),
            );
            expect(auditCall).toBeDefined();
            expect(auditCall[1][0]).toBe('admin-uuid-1');
            const auditPayload = JSON.parse(auditCall[1][1]);
            expect(auditPayload.enabled).toBe(true);
            expect(auditPayload.action).toBe('ACTIVATED');
        });

        it('restores persisted state on startup via syncFromDatabase()', async () => {
            mockDataSource.query
                .mockResolvedValueOnce([]) // ensureSettingsRow
                .mockResolvedValueOnce([{ value: 'true' }]); // select from platform_settings

            const freshInstance = new DynamicPricingService(
                mockConfigService as unknown as ConfigService,
                mockDataSource as unknown as DataSource,
            );

            await freshInstance.syncFromDatabase();
            expect(freshInstance.isEnabled()).toBe(true);
        });

        it('remains disabled on startup if platform_settings stores false', async () => {
            mockDataSource.query
                .mockResolvedValueOnce([]) // ensureSettingsRow
                .mockResolvedValueOnce([{ value: 'false' }]); // select from platform_settings

            const freshInstance = new DynamicPricingService(
                mockConfigService as unknown as ConfigService,
                mockDataSource as unknown as DataSource,
            );

            await freshInstance.syncFromDatabase();
            expect(freshInstance.isEnabled()).toBe(false);
        });
    });

    describe('4. Concurrency Safety', () => {
        it('handles concurrent toggle requests deterministically without race corruption', async () => {
            mockDataSource.query.mockResolvedValue([]);

            const [res1, res2, res3] = await Promise.all([
                dynamicPricingService.setEnabled(true, 'admin-1'),
                dynamicPricingService.setEnabled(false, 'admin-2'),
                dynamicPricingService.setEnabled(true, 'admin-3'),
            ]);

            expect(res1.success).toBe(true);
            expect(res2.success).toBe(true);
            expect(res3.success).toBe(true);
            expect(typeof dynamicPricingService.isEnabled()).toBe('boolean');
        });
    });

    describe('5. Status Endpoint Delivery', () => {
        it('returns real backend state with active rules and audit metadata', async () => {
            mockDataSource.query
                .mockResolvedValueOnce([]) // ensureSettingsRow
                .mockResolvedValueOnce([
                    {
                        value: 'false',
                        updated_at: '2026-11-09T10:00:00Z',
                        updated_by: 'admin-owner-id',
                    },
                ]);

            const status = await controller.getStatus();

            expect(status.enabled).toBe(false);
            expect(status.source).toBe('database');
            expect(status.updatedAt).toBe('2026-11-09T10:00:00.000Z');
            expect(status.updatedBy).toBe('admin-owner-id');
            expect(status.activeRules.seasonalPeak).toBe(true);
            expect(status.activeRules.weekendPrime).toBe(true);
            expect(status.activeRules.categoryTiers).toBe(4);
            expect(status.activeRules.durationPrivilege).toBe(4);
            expect(status.activeRules.demandTelemetryGated).toBe(true);
        });
    });

    describe('6. Consolidated Scoped Pricing Rules Management', () => {
        it('retrieves approved pricing rules list from platform_settings', async () => {
            const mockRule = {
                ruleId: 'RULE-CHIRON-01',
                recommendationId: 'REC-1',
                vehicleId: 'v-1',
                licensePlate: 'LUX-CHIRON-01',
                originalDailyPrice: 20000,
                approvedDailyPrice: 21000,
                variancePercent: 5.0,
                status: 'active' as const,
                appliedAt: new Date().toISOString(),
            };

            mockDataSource.query.mockResolvedValueOnce([{ value: JSON.stringify([mockRule]) }]);

            const rules = await controller.getApprovedRules();
            expect(rules.length).toBe(1);
            expect(rules[0].ruleId).toBe('RULE-CHIRON-01');
            expect(rules[0].status).toBe('active');
        });

        it('applies a scoped pricing rule within ±50% safety guardrail', async () => {
            mockDataSource.query
                .mockResolvedValueOnce([
                    { id: 'v-1', license_plate: 'LUX-CHIRON-01', daily_price: '20000.00', status: 'active' },
                ])
                .mockResolvedValueOnce([]) // UPDATE vehicles
                .mockResolvedValueOnce([]) // getApprovedPricingRules
                .mockResolvedValueOnce([]) // saveApprovedPricingRules
                .mockResolvedValueOnce([{ id: 'audit-apply-1' }]); // audit_logs

            const res = await controller.applyRule(
                {
                    approvedPrice: 22000,
                    licensePlate: 'LUX-CHIRON-01',
                    adminReason: 'Seasonal peak adjustment',
                },
                { user: { id: 'admin-uuid-1' } },
            );

            expect(res.success).toBe(true);
            expect(res.oldDailyPrice).toBe(20000);
            expect(res.newDailyPrice).toBe(22000);
            expect(res.ruleId).toBeDefined();
        });

        it('rejects price shift greater than 50% on manual approval', async () => {
            mockDataSource.query.mockResolvedValueOnce([
                { id: 'v-1', license_plate: 'LUX-CHIRON-01', daily_price: '20000.00', status: 'active' },
            ]);

            await expect(
                controller.applyRule(
                    {
                        approvedPrice: 35000, // 75% increase
                        licensePlate: 'LUX-CHIRON-01',
                    },
                    { user: { id: 'admin-uuid-1' } },
                ),
            ).rejects.toThrow(BadRequestException);
        });

        it('rolls back an active pricing rule and prevents duplicate rollback', async () => {
            const mockRule = {
                ruleId: 'RULE-CHIRON-01',
                recommendationId: 'REC-1',
                vehicleId: 'v-1',
                licensePlate: 'LUX-CHIRON-01',
                originalDailyPrice: 20000,
                approvedDailyPrice: 22000,
                variancePercent: 10.0,
                status: 'active' as const,
                appliedAt: new Date().toISOString(),
            };

            mockDataSource.query
                .mockResolvedValueOnce([{ value: JSON.stringify([mockRule]) }]) // getRules
                .mockResolvedValueOnce([]) // UPDATE vehicles
                .mockResolvedValueOnce([]) // saveRules
                .mockResolvedValueOnce([{ id: 'audit-rollback-1' }]); // audit_logs

            const res = await controller.rollbackRule(
                'RULE-CHIRON-01',
                { reason: 'Customer price sensitivity' },
                { user: { id: 'admin-uuid-1' } },
            );

            expect(res.success).toBe(true);
            expect(res.rule.status).toBe('rolled_back');
            expect(res.rule.rollbackReason).toBe('Customer price sensitivity');

            // Second rollback attempt
            mockDataSource.query.mockResolvedValueOnce([{ value: JSON.stringify([res.rule]) }]);
            await expect(
                controller.rollbackRule('RULE-CHIRON-01', {}, { user: { id: 'admin-uuid-1' } }),
            ).rejects.toThrow(BadRequestException);
        });
    });
});
