import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DataSource } from 'typeorm';
import { SettingsService } from './settings.service.js';
import { BadRequestException } from '@nestjs/common';

describe('SettingsService', () => {
    let service: SettingsService;
    let mockDataSource: { query: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        mockDataSource = {
            query: vi.fn(),
        };
        service = new SettingsService(mockDataSource as unknown as DataSource);
    });

    describe('getSettings', () => {
        it('returns parsed settings with fallback defaults', async () => {
            // First call in ensureSchema: CREATE TABLE
            mockDataSource.query
                .mockResolvedValueOnce([]) // CREATE TABLE
                .mockResolvedValueOnce([{ count: 12 }]) // count
                .mockResolvedValueOnce([
                    { key: 'payment_hold_window_hours', value: '48', updated_at: '2026-11-01T12:00:00Z', updated_by: null },
                    { key: 'vat_rate_percentage', value: '21', updated_at: '2026-11-01T12:00:00Z', updated_by: null },
                    { key: 'supercar_min_age', value: '26', updated_at: '2026-11-01T12:00:00Z', updated_by: null },
                    { key: 'support_email', value: 'atelier@luxuar.com', updated_at: '2026-11-01T12:00:00Z', updated_by: null },
                ]);

            const settings = await service.getSettings();

            expect(settings.paymentHoldWindowHours).toBe(48);
            expect(settings.vatRatePercentage).toBe(21);
            expect(settings.supercarMinAge).toBe(26);
            expect(settings.supportEmail).toBe('atelier@luxuar.com');
            // Check default fallback for unpopulated keys
            expect(settings.hypercarMinAge).toBe(28);
            expect(settings.baseCurrency).toBe('EUR');
        });
    });

    describe('updateSettings validation', () => {
        beforeEach(() => {
            // Mock ensureSchema table check
            mockDataSource.query
                .mockResolvedValueOnce([]) // CREATE TABLE
                .mockResolvedValueOnce([{ count: 12 }]); // count
        });

        it('throws BadRequestException for invalid VAT rate', async () => {
            await expect(
                service.updateSettings({ vatRatePercentage: 85 }),
            ).rejects.toThrow(BadRequestException);
        });

        it('throws BadRequestException for invalid opening time format', async () => {
            await expect(
                service.updateSettings({ showroomOpensAt: '25:99' }),
            ).rejects.toThrow(BadRequestException);
        });

        it('throws BadRequestException for invalid email address', async () => {
            await expect(
                service.updateSettings({ supportEmail: 'not-an-email' }),
            ).rejects.toThrow(BadRequestException);
        });

        it('updates valid settings and logs to audit_logs', async () => {
            // 1. ensureSchema (already mocked)
            // 2. oldSettings fetch
            mockDataSource.query.mockResolvedValueOnce([
                { key: 'vat_rate_percentage', value: '20', updated_at: '2026-11-01T00:00:00Z', updated_by: null },
            ]);
            // 3. update query
            mockDataSource.query.mockResolvedValueOnce([]);
            // 4. newSettings fetch
            mockDataSource.query.mockResolvedValueOnce([
                { key: 'vat_rate_percentage', value: '19', updated_at: '2026-11-04T00:00:00Z', updated_by: '11111111-1111-1111-1111-111111111111' },
            ]);
            // 5. audit_logs insert
            mockDataSource.query.mockResolvedValueOnce([]);

            const result = await service.updateSettings(
                { vatRatePercentage: 19 },
                '11111111-1111-1111-1111-111111111111',
            );

            expect(result.vatRatePercentage).toBe(19);

            // Verify audit_logs insert was executed
            const auditCall = mockDataSource.query.mock.calls.find((call) =>
                typeof call[0] === 'string' && call[0].includes('INSERT INTO audit_logs'),
            );
            expect(auditCall).toBeDefined();
            const auditParams = (auditCall?.[1] ?? []) as unknown[];
            expect(auditParams[0]).toBe('11111111-1111-1111-1111-111111111111');
            expect(auditParams[1]).toContain('20'); // old vat
            expect(auditParams[2]).toContain('19'); // new vat
        });
    });
});
