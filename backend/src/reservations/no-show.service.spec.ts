import {afterEach, describe, expect, it, vi} from 'vitest';
import type {ConfigService} from '@nestjs/config';
import type {DataSource} from 'typeorm';
import type {InboxService} from '../notifications/inbox.service.js';
import {noShowDeadlineExpression} from './no-show-deadline.js';
import {NoShowService} from './no-show.service.js';

describe('NoShowService', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    function createService(
        candidateRows: unknown[] = [],
        options: {
            configValues?: Record<string, unknown>;
            typeormTupleFormat?: boolean;
            onlyFirstUpdateSucceeds?: boolean;
        } = {},
    ) {
        const updatedIds = new Set<string>();
        const manager = {
            query: vi.fn(async (sql: string) => {
                if (sql.includes('SELECT r.id')) {
                    if (options.onlyFirstUpdateSucceeds && updatedIds.size > 0) {
                        return [];
                    }
                    return candidateRows;
                }
                if (sql.includes('UPDATE reservations')) {
                    const rows = candidateRows
                        .filter((row) => {
                            const id = (row as {id: string}).id;
                            if (options.onlyFirstUpdateSucceeds && updatedIds.has(id)) {
                                return false;
                            }
                            updatedIds.add(id);
                            return true;
                        })
                        .map((row) => ({
                            id: (row as {id: string}).id,
                            noShowAt: new Date('2026-10-24T12:00:00.000Z'),
                        }));
                    return options.typeormTupleFormat ? [rows, rows.length] : rows;
                }
                return [];
            }),
        };
        const dataSource = {
            transaction: vi.fn(async (callback: (txManager: typeof manager) => Promise<unknown>) =>
                callback(manager)),
        };
        const config = {
            get: vi.fn((key: string, fallback?: unknown) => {
                if (options.configValues && key in options.configValues) {
                    return options.configValues[key];
                }
                return fallback ?? 120;
            }),
        };
        const inbox = {safelyReservationNoShow: vi.fn().mockResolvedValue(undefined)};
        const service = new NoShowService(
            dataSource as unknown as DataSource,
            config as unknown as ConfigService,
            inbox as unknown as InboxService,
        );
        return {service, manager, dataSource, config, inbox};
    }

    it('expires only locked confirmed reservations without handover and records one event', async () => {
        const reservation = {
            id: 'reservation-1',
            customerId: 'customer-1',
            reservationNumber: 'RES-2026-000001',
        };
        const {service, manager, inbox} = createService([reservation]);

        await expect(service.scanExpiredReservations()).resolves.toBe(1);

        expect(manager.query.mock.calls[0][0]).toContain("FOR UPDATE OF r SKIP LOCKED");
        expect(manager.query.mock.calls[1][0]).toContain("r.status = 'confirmed'");
        expect(manager.query.mock.calls[1][0]).toContain('FROM rentals l');
        expect(manager.query.mock.calls[1][0]).toContain("i.type = 'handover'");
        expect(manager.query.mock.calls[2][0]).toContain('UPDATE reservation_checkin_credentials');
        expect(manager.query.mock.calls[3][0]).toContain("'RESERVATION_NO_SHOW'");
        expect(manager.query.mock.calls[4][0]).toContain('user_notifications');
        expect(inbox.safelyReservationNoShow).toHaveBeenCalledWith(
            reservation.customerId,
            reservation.id,
        );
    });

    it('does not create duplicate notifications when a later scan finds no expired rows', async () => {
        const {service, inbox, manager} = createService();

        await expect(service.scanExpiredReservations()).resolves.toBe(0);

        expect(manager.query).toHaveBeenCalledTimes(1);
        expect(inbox.safelyReservationNoShow).not.toHaveBeenCalled();
    });

    it('handles TypeORM [rows, count] tuple responses and skips side effects when UPDATE affects 0 rows', async () => {
        const reservation = {
            id: 'reservation-tuple-1',
            customerId: 'customer-tuple-1',
            reservationNumber: 'RES-2026-000002',
        };
        const {service, manager, inbox} = createService([reservation], {
            typeormTupleFormat: true,
            onlyFirstUpdateSucceeds: true,
        });

        const [firstCount, secondCount] = await Promise.all([
            service.scanExpiredReservations(),
            service.scanExpiredReservations(),
        ]);

        expect(firstCount).toBe(1);
        expect(secondCount).toBe(0);
        expect(inbox.safelyReservationNoShow).toHaveBeenCalledTimes(1);

        const auditInsertCall = manager.query.mock.calls.find((call) =>
            String(call[0]).includes("'RESERVATION_NO_SHOW'"),
        );
        expect(auditInsertCall).toBeDefined();
        expect((auditInsertCall as any)?.[1]?.[1]).toBeInstanceOf(Date);
    });

    it('builds a timezone-aware SQL deadline expression capped at agency local closing time', () => {
        const expr = noShowDeadlineExpression('$2');
        expect(expr).toContain("COALESCE(NULLIF(loc.timezone, ''), 'Europe/Budapest')");
        expect(expr).toContain('r.pickup_at AT TIME ZONE');
        expect(expr).toContain('loc.closes_at');
        expect(expr).toContain('LEAST(');
    });

    it('automatically schedules recurring background scans and stops cleanly on destroy', async () => {
        vi.useFakeTimers();
        const reservation = {
            id: 'reservation-sched-1',
            customerId: 'customer-sched-1',
            reservationNumber: 'RES-2026-000003',
        };
        const {service, dataSource, inbox} = createService([reservation], {
            configValues: {
                NODE_ENV: 'development',
                NO_SHOW_GRACE_PERIOD_MINUTES: 90,
                NO_SHOW_SCAN_INTERVAL_MS: 5_000,
            },
            typeormTupleFormat: true,
            onlyFirstUpdateSucceeds: true,
        });

        service.onModuleInit();
        await vi.advanceTimersByTimeAsync(0);
        expect(dataSource.transaction).toHaveBeenCalledTimes(1);
        expect(inbox.safelyReservationNoShow).toHaveBeenCalledTimes(1);

        // Calling startScheduler again is idempotent (no duplicate interval).
        service.startScheduler(5_000);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(dataSource.transaction).toHaveBeenCalledTimes(2);
        expect(inbox.safelyReservationNoShow).toHaveBeenCalledTimes(1);

        await service.onModuleDestroy();
        await vi.advanceTimersByTimeAsync(15_000);
        expect(dataSource.transaction).toHaveBeenCalledTimes(2);
    });
});
