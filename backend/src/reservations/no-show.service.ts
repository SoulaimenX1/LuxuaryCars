import {
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DataSource} from 'typeorm';
import {InboxService} from '../notifications/inbox.service.js';
import {noShowDeadlineExpression} from './no-show-deadline.js';

interface ExpiredReservation {
    id: string;
    customerId: string;
    reservationNumber: string;
    noShowAt: Date;
}

@Injectable()
export class NoShowService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(NoShowService.name);
    private readonly gracePeriodMinutes: number;
    private readonly scanIntervalMs: number;
    private timer: ReturnType<typeof setInterval> | undefined;
    private activeScan: Promise<number> | undefined;

    constructor(
        private readonly dataSource: DataSource,
        private readonly config: ConfigService,
        private readonly inbox: InboxService,
    ) {
        const configuredGrace = Number(
            this.config?.get<number>('NO_SHOW_GRACE_PERIOD_MINUTES', 120),
        );
        this.gracePeriodMinutes =
            Number.isFinite(configuredGrace) && configuredGrace > 0
                ? configuredGrace
                : 120;

        const configuredInterval = Number(
            this.config?.get<number>('NO_SHOW_SCAN_INTERVAL_MS', 60_000),
        );
        this.scanIntervalMs =
            Number.isFinite(configuredInterval) && configuredInterval >= 1_000
                ? configuredInterval
                : 60_000;
    }

    async scanExpiredReservations(): Promise<number> {
        return this.runScan();
    }

    onModuleInit(): void {
        this.startScheduler();
    }

    private async runScan(): Promise<number> {
        try {
            const expired = await this.dataSource.transaction(async (manager) => {
                const deadline = noShowDeadlineExpression('$1');
                const candidates: {
                    id: string;
                    customerId: string;
                    reservationNumber: string;
                }[] = await manager.query(`
                    SELECT r.id,
                           r.customer_id AS "customerId",
                           r.reservation_number AS "reservationNumber"
                    FROM reservations r
                    LEFT JOIN vehicles v ON v.id = r.vehicle_id
                    LEFT JOIN reservation_preferences p ON p.reservation_id = r.id
                    LEFT JOIN reservation_checkin_credentials c ON c.reservation_id = r.id
                    LEFT JOIN reservation_service_points sp
                      ON sp.reservation_id = r.id AND sp.direction = 'pickup'
                    LEFT JOIN rental_locations loc ON loc.id = COALESCE(
                        p.pickup_location_id,
                        c.agency_id,
                        sp.location_id,
                        v.home_location_id,
                        (
                            SELECT vrl.location_id
                            FROM vehicle_rental_locations vrl
                            WHERE vrl.vehicle_id = r.vehicle_id
                            LIMIT 1
                        ),
                        (
                            SELECT fallback.id
                            FROM rental_locations fallback
                            WHERE fallback.enabled = true
                              AND fallback.category = 'showroom'
                              AND fallback.can_pickup = true
                              AND fallback.can_dropoff = true
                            ORDER BY CASE WHEN fallback.code = 'BUD-SHOWROOM' THEN 0 ELSE 1 END,
                                     fallback.code
                            LIMIT 1
                        )
                    )
                    WHERE r.status = 'confirmed'
                      AND ${deadline} <= now()
                    ORDER BY ${deadline}, r.id
                    LIMIT 100
                    FOR UPDATE OF r SKIP LOCKED
                `, [this.gracePeriodMinutes]);

                const marked: ExpiredReservation[] = [];
                for (const reservation of candidates) {
                    const reason = 'Vehicle handover was not recorded before the collection deadline.';
                    const updateResult = await manager.query(`
                        UPDATE reservations r
                        SET status = 'no_show',
                            no_show_at = now(),
                            no_show_reason = $2,
                            updated_at = now()
                        WHERE r.id = $1::uuid
                          AND r.status = 'confirmed'
                          AND NOT EXISTS (
                              SELECT 1 FROM rentals l
                              WHERE l.reservation_id = r.id
                          )
                          AND NOT EXISTS (
                              SELECT 1 FROM inspections i
                              JOIN rentals l ON l.id = i.rental_id
                              WHERE l.reservation_id = r.id
                                AND i.type = 'handover'
                          )
                        RETURNING r.id, r.no_show_at AS "noShowAt"
                    `, [reservation.id, reason]);
                    const rows: { id: string; noShowAt: Date }[] = Array.isArray(
                        updateResult?.[0],
                    )
                        ? updateResult[0]
                        : updateResult;
                    if (!rows?.length) continue;
                    const noShowAt = rows[0].noShowAt ?? new Date();
                    await manager.query(`
                        UPDATE reservation_checkin_credentials
                        SET revoked_at = COALESCE(revoked_at, now())
                        WHERE reservation_id = $1::uuid
                    `, [reservation.id]);

                    await manager.query(`
                        INSERT INTO audit_logs
                            (actor_id, action, entity_type, entity_id, old_values, new_values)
                        SELECT NULL,
                               'RESERVATION_NO_SHOW',
                               'reservation',
                               $1::uuid,
                               jsonb_build_object('status', 'confirmed'),
                               jsonb_build_object(
                                   'status', 'no_show',
                                   'noShowAt', $2::timestamptz,
                                   'reason', $3::text
                               )
                        WHERE NOT EXISTS (
                            SELECT 1 FROM audit_logs a
                            WHERE a.entity_type = 'reservation'
                              AND a.entity_id = $1::uuid
                              AND a.action = 'RESERVATION_NO_SHOW'
                        )
                    `, [reservation.id, noShowAt, reason]);
                    await manager.query(`
                        INSERT INTO user_notifications
                            (recipient_id, category, priority, title, message,
                             action_url, event_key, entity_type, entity_id)
                        SELECT u.id,
                               'reservations',
                               'warning',
                               'Reservation expired — no-show',
                               $2::text,
                               '/account/reservations',
                               $3::varchar,
                               'reservation',
                               $4::uuid
                        FROM users u
                        WHERE u.id = $1::uuid
                          AND u.status = 'active'
                          AND (
                              SELECT booking_updates
                              FROM notification_preferences
                              WHERE user_id = u.id
                          ) IS DISTINCT FROM false
                        ON CONFLICT (recipient_id, event_key) DO NOTHING
                    `, [
                        reservation.customerId,
                        `Reservation ${reservation.reservationNumber} expired because vehicle handover was not recorded by the collection deadline.`,
                        `reservation:${reservation.id}:no_show:customer`,
                        reservation.id,
                    ]);
                    marked.push({...reservation, noShowAt});
                }
                return marked;
            });

            for (const reservation of expired) {
                await this.inbox.safelyReservationNoShow(
                    reservation.customerId,
                    reservation.id,
                );
            }
            return expired.length;
        } catch (error) {
            this.logger.error('No-show scan failed', error);
            throw error;
        }
    }

    startScheduler(intervalMs = this.scanIntervalMs): void {
        if (this.timer) return;
        void this.runScheduledTick();
        this.timer = setInterval(() => {
            void this.runScheduledTick();
        }, intervalMs);
        this.timer.unref?.();
    }

    async stopScheduler(): Promise<void> {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        await this.activeScan?.catch(() => undefined);
    }

    private async runScheduledTick(): Promise<void> {
        if (this.activeScan) return;
        await this.scanExpiredReservations().catch(() => undefined);
    }

    async onModuleDestroy(): Promise<void> {
        await this.stopScheduler();
    }
}
