import { describe, expect, it, vi } from 'vitest';
import { StripePaymentService } from './stripe-payment.service.js';

describe('StripePaymentService: autoActivateConfirmedRentals (BUG-001 Regression)', () => {
    function createService(queryMock: (sql: string, params?: any[]) => Promise<any>) {
        const fakeConfig = {
            get: vi.fn((key: string) => {
                if (key === 'STRIPE_TEST_MODE') return true;
                if (key === 'STRIPE_SECRET_KEY') return '';
                return null;
            }),
        };

        const manager = {
            query: vi.fn(queryMock),
            getRepository: vi.fn(() => ({
                findOne: vi.fn().mockResolvedValue({ id: 'res-1', reservationNumber: 'RES-2026-000001' }),
            })),
        };

        const fakeDataSource = {
            query: vi.fn(queryMock),
            transaction: vi.fn(async (cb: (m: typeof manager) => Promise<any>) => cb(manager)),
            getRepository: vi.fn(() => ({
                findOne: vi.fn().mockResolvedValue({ id: 'res-1', reservationNumber: 'RES-2026-000001' }),
            })),
        };

        const service = new StripePaymentService(
            fakeDataSource as any,
            fakeConfig as any,
        );
        // Avoid background scanning timers during test
        service.onModuleDestroy();
        return { service, fakeDataSource, manager };
    }

    it('returns activatedCount 0 when no confirmed reservations are eligible', async () => {
        const query = vi.fn(async () => []);
        const { service } = createService(query);

        const result = await service.autoActivateConfirmedRentals();
        expect(result).toEqual({ activatedCount: 0 });
    });

    it('activates eligible confirmed reservation whose pickup time has arrived', async () => {
        const resId = '11111111-2222-3333-4444-555555555555';
        const returnAt = new Date(Date.now() + 86400000);

        const query = vi.fn(async (sql: string) => {
            if (sql.includes('FROM reservations') && sql.includes("status = 'confirmed'")) {
                if (sql.includes('FOR UPDATE SKIP LOCKED') && sql.includes('WHERE id = $1::uuid')) {
                    // Inside transaction re-lock
                    return [{ id: resId }];
                }
                // Initial candidate scan
                return [{
                    id: resId,
                    reservation_number: 'RES-2026-000088',
                    return_at: returnAt,
                    customer_id: 'cust-1',
                }];
            }
            if (sql.includes('FROM users WHERE role =')) {
                return [{ id: 'admin-uuid-1' }];
            }
            if (sql.includes('INSERT INTO rentals')) {
                return [{ id: 'rental-uuid-1' }];
            }
            if (sql.includes("UPDATE reservations") && sql.includes("status = 'active_rental'")) {
                return [];
            }
            return [];
        });

        const { service, manager } = createService(query);
        const result = await service.autoActivateConfirmedRentals();

        expect(result).toEqual({ activatedCount: 1 });
        expect(manager.query).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO rentals'),
            expect.arrayContaining([resId, returnAt, 'admin-uuid-1']),
        );
        expect(manager.query).toHaveBeenCalledWith(
            expect.stringContaining("status = 'active_rental'"),
            expect.arrayContaining([resId]),
        );
    });

    it('skips activation safely if reservation is locked/cancelled concurrently', async () => {
        const resId = '11111111-2222-3333-4444-555555555555';
        const returnAt = new Date(Date.now() + 86400000);

        const query = vi.fn(async (sql: string) => {
            if (sql.includes('FROM reservations') && !sql.includes('WHERE id = $1::uuid')) {
                // Initial scan found a candidate
                return [{
                    id: resId,
                    reservation_number: 'RES-2026-000088',
                    return_at: returnAt,
                    customer_id: 'cust-1',
                }];
            }
            if (sql.includes('WHERE id = $1::uuid')) {
                // By the time the transaction runs, another worker activated or cancelled it
                return [];
            }
            return [];
        });

        const { service, manager } = createService(query);
        const result = await service.autoActivateConfirmedRentals();

        expect(result).toEqual({ activatedCount: 0 });
        expect(manager.query).not.toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO rentals'),
            expect.anything(),
        );
    });
});
