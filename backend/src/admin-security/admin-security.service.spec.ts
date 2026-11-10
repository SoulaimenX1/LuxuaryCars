import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DataSource } from 'typeorm';
import {
    AdminSecurityService,
    sanitizeAuditValues,
} from './admin-security.service.js';

describe('AdminSecurityService', () => {
    let service: AdminSecurityService;
    let mockDataSource: { query: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        mockDataSource = {
            query: vi.fn(),
        };
        service = new AdminSecurityService(mockDataSource as unknown as DataSource);
    });

    describe('sanitizeAuditValues', () => {
        it('redacts sensitive fields like passwords, tokens, hashes and credit cards', () => {
            const raw = {
                user: 'admin',
                password: 'supersecretpassword123',
                passwordHash: '$2b$12$somehashvaluehere',
                api_secret: 'sec_abcdef123456',
                accessToken: 'eyJhbGciOi...',
                bearer_header: 'Bearer eyJhbGciOi...',
                card_number: '4242424242424242',
                nested: {
                    cvv: '123',
                    regularKey: 'safeValue',
                },
            };

            const sanitized = sanitizeAuditValues(raw) as any;

            expect(sanitized.user).toBe('admin');
            expect(sanitized.password).toBe('[REDACTED_CONFIDENTIAL]');
            expect(sanitized.passwordHash).toBe('[REDACTED_CONFIDENTIAL]');
            expect(sanitized.api_secret).toBe('[REDACTED_CONFIDENTIAL]');
            expect(sanitized.accessToken).toBe('[REDACTED_CONFIDENTIAL]');
            expect(sanitized.card_number).toBe('[REDACTED_CONFIDENTIAL]');
            expect(sanitized.nested.cvv).toBe('[REDACTED_CONFIDENTIAL]');
            expect(sanitized.nested.regularKey).toBe('safeValue');
        });

        it('redacts direct bearer token values in strings', () => {
            const raw = {
                authHeader: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
                note: 'User authenticated successfully',
            };

            const sanitized = sanitizeAuditValues(raw) as any;
            expect(sanitized.authHeader).toBe('[REDACTED_BEARER_TOKEN]');
            expect(sanitized.note).toBe('User authenticated successfully');
        });

        it('preserves null, numbers and booleans', () => {
            expect(sanitizeAuditValues(null)).toBeNull();
            expect(sanitizeAuditValues(123)).toBe(123);
            expect(sanitizeAuditValues(true)).toBe(true);
        });
    });

    describe('getSecurityOverview', () => {
        it('returns count metrics from audit_logs table', async () => {
            mockDataSource.query.mockResolvedValueOnce([
                {
                    total: 142,
                    today: 18,
                    critical: 45,
                    unique_actors: 4,
                },
            ]);

            const overview = await service.getSecurityOverview();

            expect(overview.totalAuditLogs).toBe(142);
            expect(overview.todayAuditLogs).toBe(18);
            expect(overview.criticalAuditLogs).toBe(45);
            expect(overview.uniqueActorsCount).toBe(4);
            expect(overview.rbacEnforcement).toContain('Strict RBAC');
        });
    });

    describe('getAuditLogs', () => {
        it('queries logs with filter conditions and sanitizes outputs', async () => {
            mockDataSource.query
                .mockResolvedValueOnce([{ count: 1 }]) // Count query
                .mockResolvedValueOnce([
                    {
                        id: '99',
                        actorId: '11111111-1111-1111-1111-111111111111',
                        actorName: 'Admin LUXUAR',
                        actorEmail: 'admin@luxuar.com',
                        actorRole: 'admin',
                        action: 'RESERVATION_CONFIRMED',
                        entityType: 'reservation',
                        entityId: '22222222-2222-2222-2222-222222222222',
                        oldValues: null,
                        newValues: {
                            reservationNumber: 'RES-2026-000001',
                            token: 'sensitive-token',
                        },
                        ipAddress: '127.0.0.1',
                        createdAt: new Date().toISOString(),
                    },
                ]); // Data query

            const result = await service.getAuditLogs({
                action: 'RESERVATION_CONFIRMED',
                limit: 10,
                offset: 0,
            });

            expect(result.total).toBe(1);
            expect(result.logs.length).toBe(1);
            expect(result.logs[0].action).toBe('RESERVATION_CONFIRMED');
            expect(result.logs[0].actorEmail).toBe('admin@luxuar.com');
            expect(result.logs[0].newValues?.token).toBe('[REDACTED_CONFIDENTIAL]');
            expect(result.logs[0].newValues?.reservationNumber).toBe('RES-2026-000001');
        });
    });
});
